import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import type { RequestRecord } from "../domain/events.js";
import {
  ClaimRecordSchema,
  EvidenceRecordSchema,
  VerificationRecordSchema,
  type CalculationRecord,
  type ClaimRecord,
  type EvidenceRecord,
  type ResearchRecord,
  type SourceRecord,
  type VerificationRecord,
} from "../domain/research-records.js";
import { parse } from "../domain/schema.js";
import type { SourceUrlPolicyContext } from "../scholarly/identifiers.js";
import type { RequestProvenanceIndex } from "../scholarly/source-identity.js";
import { compareSourceIndependence } from "./lineage.js";
import {
  buildBoundedValidatedEvidenceSnapshotInternal,
  getValidatedSnapshotIndexes,
  type SnapshotRecordKey,
} from "./validated-snapshot-internal.js";

export type EvidenceAdmissionErrorCode =
  | "evidence.invalid-options"
  | "evidence.invalid-input"
  | "evidence.snapshot-invalid"
  | "evidence.too-many-records"
  | "evidence.too-many-references"
  | "evidence.record-too-large"
  | "evidence.input-too-large"
  | "evidence.duplicate-revision"
  | "evidence.revision-gap"
  | "evidence.unresolved-ref"
  | "evidence.duplicate-request"
  | "evidence.stale-latest-ref"
  | "evidence.duplicate-source-identity"
  | "evidence.ambiguous-source-identity"
  | "evidence.source-url-policy-invalid"
  | "evidence.source-url-unattributed"
  | "evidence.source-url-request-mismatch"
  | "evidence.source-url-metadata-mismatch"
  | "evidence.asymmetric-conflict"
  | "evidence.invalid-prospective-record";
export class EvidenceAdmissionError extends Error {
  readonly code: EvidenceAdmissionErrorCode;
  constructor(code: EvidenceAdmissionErrorCode) {
    super(`Evidence admission rejected (${code})`);
    this.name = "EvidenceAdmissionError";
    this.code = code;
  }
}

export interface CanonicalEvidenceSet {
  readonly sources: readonly SourceRecord[];
  readonly claims: readonly ClaimRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly verifications: readonly VerificationRecord[];
  readonly requests: readonly RequestRecord[];
  readonly calculations: readonly CalculationRecord[];
}
export interface EvidenceSetLimits {
  readonly maxPerKind?: Readonly<{ sources: number; claims: number; evidence: number; verifications: number; requests: number; calculations: number }>;
  readonly maxTotalRecords?: number;
  readonly maxReferences?: number;
  readonly maxLineageComponents?: number;
  readonly maxCanonicalScalarBytes?: number;
  readonly maxSourceRecordCanonicalBytes?: number;
  readonly maxRequestRecordCanonicalBytes?: number;
  readonly maxClaimRecordCanonicalBytes?: number;
  readonly maxEvidenceRecordCanonicalBytes?: number;
  readonly maxVerificationRecordCanonicalBytes?: number;
  readonly maxCalculationRecordCanonicalBytes?: number;
  readonly maxCanonicalEvidenceSetBytes?: number;
}
export interface EvidenceSnapshotView {
  readonly stableIdRevisionSelection: "latest-in-snapshot";
  readonly verificationRevisionSelection: "latest-applicable-per-target";
}
export interface EvidenceSnapshotOptions { readonly limits?: EvidenceSetLimits; readonly sourceUrlPolicy?: SourceUrlPolicyContext; readonly view?: EvidenceSnapshotView }
export interface EvidenceSnapshotDiagnostics {
  canonicalRecordVisits: number; referenceVisits: number; revisionIndexInsertions: number; sourceIdentityVisits: number;
  lineageVisits: number; requestRecordsIndexed: number; requestUrlVisits: number; metadataStepVisits: number;
}
export interface BoundedValidatedEvidenceSnapshot {
  readonly records: CanonicalEvidenceSet;
  readonly recordCount: number;
  readonly referenceCount: number;
  readonly canonicalBytes: number;
  readonly snapshotSha256: string;
  readonly optionsSha256: string;
  readonly policySha256: string;
  readonly view: EvidenceSnapshotView;
  readonly requestProvenanceIndex: RequestProvenanceIndex;
}
export interface EvidenceGateDecision {
  readonly claimRef: { claimId: string; revision: number };
  readonly passes: boolean;
  readonly supportingEvidenceRefs: readonly { evidenceId: string; revision: number }[];
  readonly contradictingEvidenceRefs: readonly { evidenceId: string; revision: number }[];
  readonly retrievedComponentCount: number;
  readonly derivedComponentCount: number;
  readonly resolvedLineageCount: number;
  readonly independentVerificationCredit: 0 | 1;
  readonly effectiveIndependentCount: number;
  readonly blockers: readonly (
    | "claim.unsupported" | "claim.invalid-derived-evidence" | "claim.primary-source-required" | "claim.full-text-required"
    | "claim.unresolved-lineage" | "claim.unresolved-conflict" | "claim.independent-verification-required" | "claim.insufficient-lineages"
  )[];
}

export function buildBoundedValidatedEvidenceSnapshot(
  records: CanonicalEvidenceSet, options?: EvidenceSnapshotOptions, diagnostics?: EvidenceSnapshotDiagnostics,
): BoundedValidatedEvidenceSnapshot {
  return buildBoundedValidatedEvidenceSnapshotInternal(records, options, diagnostics);
}
export function validateCanonicalEvidenceSet(records: CanonicalEvidenceSet, options?: EvidenceSnapshotOptions): CanonicalEvidenceSet {
  return buildBoundedValidatedEvidenceSnapshot(records, options).records;
}
export function evaluateEvidenceRuleFromRecords(
  records: CanonicalEvidenceSet,
  claimRef: Readonly<{ claimId: string; revision: number }>,
  options?: Readonly<{ snapshot?: EvidenceSnapshotOptions; maxEvidencePerClaim?: number }>,
  diagnostics?: EvidenceSnapshotDiagnostics,
): EvidenceGateDecision {
  let snapshotOptions: EvidenceSnapshotOptions | undefined;
  let maxEvidencePerClaim: number | undefined;
  if (options !== undefined) {
    if (utilTypes.isProxy(options) || !isPlain(options)
      || Reflect.ownKeys(options).some((key) => key !== "snapshot" && key !== "maxEvidencePerClaim")) fail("evidence.invalid-options");
    const snapshotDescriptor = Object.getOwnPropertyDescriptor(options, "snapshot");
    const maximumDescriptor = Object.getOwnPropertyDescriptor(options, "maxEvidencePerClaim");
    if ((snapshotDescriptor && (!("value" in snapshotDescriptor) || !snapshotDescriptor.enumerable))
      || (maximumDescriptor && (!("value" in maximumDescriptor) || !maximumDescriptor.enumerable))) fail("evidence.invalid-options");
    snapshotOptions = snapshotDescriptor?.value as EvidenceSnapshotOptions | undefined;
    maxEvidencePerClaim = maximumDescriptor?.value as number | undefined;
  }
  const snapshot = buildBoundedValidatedEvidenceSnapshot(records, snapshotOptions, diagnostics);
  return evaluateEvidenceRule(snapshot, claimRef, maxEvidencePerClaim === undefined ? undefined : { maxEvidencePerClaim });
}

export function validateProspectiveEvidenceSemantics(
  record: ClaimRecord | EvidenceRecord | VerificationRecord,
  limits?: EvidenceSetLimits,
): ClaimRecord | EvidenceRecord | VerificationRecord {
  const prospectiveLimits = validateProspectiveLimits(limits);
  if (utilTypes.isProxy(record)) fail("evidence.invalid-input");
  let json: string;
  try { json = canonicalJson(record); } catch { return fail("evidence.invalid-input"); }
  const snapshot = JSON.parse(json);
  const bytes = Buffer.byteLength(json, "utf8");
  let parsed: ReturnType<typeof parse> | undefined;
  for (const schema of [ClaimRecordSchema, EvidenceRecordSchema, VerificationRecordSchema]) {
    const result = parse(schema, snapshot); if (result.success) { parsed = result; break; }
  }
  if (!parsed?.success) fail("evidence.invalid-prospective-record");
  const value = parsed.value as ClaimRecord | EvidenceRecord | VerificationRecord;
  const maximum = "claimId" in value ? prospectiveLimits.claim
    : "evidenceId" in value ? prospectiveLimits.evidence : prospectiveLimits.verification;
  if (bytes > maximum) fail("evidence.record-too-large");
  if ("evidenceId" in value) {
    if (value.quotes.some((quote) => asciiTrim(quote).length === 0)
      || value.locators.some((locator) => asciiTrim(locator.value).length === 0)
      || value.extractedValues.some((item) => item.numericValue !== null && asciiTrim(item.context).length === 0))
      fail("evidence.invalid-prospective-record");
  }
  return deepFreeze(value);
}

export function evaluateEvidenceRule(
  snapshot: BoundedValidatedEvidenceSnapshot,
  claimRef: Readonly<{ claimId: string; revision: number }>,
  options?: Readonly<{ maxEvidencePerClaim?: number }>,
): EvidenceGateDecision {
  const maxEvidence = validateEvaluationOptions(options);
  const evaluatedRef = validateClaimRef(claimRef);
  const indexes = getValidatedSnapshotIndexes(snapshot);
  const target = indexes.getExactRecord({ kind: "claims", id: evaluatedRef.claimId, revision: evaluatedRef.revision }) as ClaimRecord | undefined;
  if (!target) fail("evidence.unresolved-ref");
  if (target.evidenceRefs.length > maxEvidence) fail("evidence.too-many-records");
  enforceCurrentReferences(target, indexes);

  const qualifying: QualifiedEvidence[] = [];
  const contradictions: EvidenceRecord[] = [];
  let otherwiseUnknown = false;
  for (const ref of target.evidenceRefs) {
    const evidenceId = String(ref.evidenceId); const evidenceRevision = Number(ref.revision);
    const record = indexes.getExactRecord({ kind: "evidence", id: evidenceId, revision: evidenceRevision }) as EvidenceRecord | undefined;
    if (!record) fail("evidence.unresolved-ref");
    if (record.claimRef.claimId !== target.claimId || record.claimRef.revision !== target.revision) continue;
    if (record.stance === "contradicting") { contradictions.push(record); continue; }
    if (record.stance !== "supporting" || !["unverified", "verified"].includes(record.verificationStatus)) continue;
    const qualified = qualifyEvidence(record, indexes, target);
    if (qualified) { qualifying.push(qualified); if (qualified.unknownLineage) otherwiseUnknown = true; }
  }

  const retrieved = qualifying.filter((item) => item.kind === "retrieved");
  assignRetrievedComponents(retrieved, indexes);
  const baseKeys = new Set<string>();
  for (const item of qualifying) if (item.key !== null) baseKeys.add(item.key);
  const retrievedKeys = new Set(retrieved.flatMap((item) => item.key ? [item.key] : []));
  const derivedKeys = new Set(qualifying.filter((item) => item.kind === "derived").flatMap((item) => item.key ? [item.key] : []));
  const retrievedComponentCount = retrievedKeys.size;
  const derivedComponentCount = derivedKeys.size;
  const resolvedLineageCount = checkedAdd(retrievedComponentCount, derivedComponentCount);
  const selectedVerifications = selectApplicableVerifications(snapshot.records.verifications, target);
  const independentVerificationCredit = target.evidenceRule.independentVerificationAllowed
    ? independentCredit(selectedVerifications, target, indexes, qualifying, baseKeys)
    : 0;
  const effectiveIndependentCount = checkedAdd(resolvedLineageCount, independentVerificationCredit) as number;
  const effectiveMinimum = Math.max(target.kind === "externally-verifiable-fact" ? 1 : 0, target.evidenceRule.minimumLineages);
  const qualifyingRecords = qualifying.length;
  const blockers: EvidenceGateDecision["blockers"][number][] = [];
  if (["rejected", "disputed", "unresolved"].includes(target.status) || qualifyingRecords === 0) blockers.push("claim.unsupported");
  if (target.kind === "derived-result" && derivedComponentCount === 0) blockers.push("claim.invalid-derived-evidence");
  if (target.evidenceRule.primarySourceRequired && !retrieved.some(({ evidence }) => ["primary-peer-reviewed", "primary-unreviewed"].includes(evidence.quality))) blockers.push("claim.primary-source-required");
  if (target.evidenceRule.fullTextRequired && retrieved.some(({ source }) => source?.accessLevel !== "full-text")) blockers.push("claim.full-text-required");
  if (otherwiseUnknown && resolvedLineageCount < effectiveMinimum) blockers.push("claim.unresolved-lineage");
  if (contradictions.length > 0 && !conflictsResolved(selectedVerifications, target, qualifying, contradictions)) blockers.push("claim.unresolved-conflict");
  const independentRequired = resolvedLineageCount < effectiveMinimum && target.evidenceRule.independentVerificationAllowed && independentVerificationCredit === 0;
  if (independentRequired) blockers.push("claim.independent-verification-required");
  if (effectiveIndependentCount < effectiveMinimum && !independentRequired) blockers.push("claim.insufficient-lineages");

  const supportingEvidenceRefs = Object.freeze(qualifying.map(({ evidence }) => ({ evidenceId: evidence.evidenceId, revision: evidence.revision })).sort(refCompare));
  const contradictingEvidenceRefs = Object.freeze(contradictions.map(({ evidenceId, revision }) => ({ evidenceId, revision })).sort(refCompare));
  return deepFreeze({
    claimRef: { claimId: String(target.claimId), revision: Number(target.revision) }, passes: blockers.length === 0,
    supportingEvidenceRefs, contradictingEvidenceRefs, retrievedComponentCount, derivedComponentCount, resolvedLineageCount,
    independentVerificationCredit, effectiveIndependentCount, blockers,
  });
}

interface QualifiedEvidence {
  readonly evidence: EvidenceRecord;
  readonly kind: "retrieved" | "derived";
  readonly source: SourceRecord | null;
  key: string | null;
  readonly unknownLineage: boolean;
}
function qualifyEvidence(record: EvidenceRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>, target: ClaimRecord): QualifiedEvidence | null {
  if (record.evidenceType === "retrieved") {
    if (!record.sourceRef || (record.quotes.length === 0 && record.extractedValues.length === 0) || !validValues(record)) return null;
    const source = indexes.getExactRecord({
      kind: "sources", id: String(record.sourceRef.sourceId), revision: Number(record.sourceRef.revision),
    }) as SourceRecord | undefined;
    if (!source) fail("evidence.unresolved-ref");
    if (record.quotes.length > 0 && source.accessLevel !== "metadata-only"
      && !record.locators.some((locator) => locator.type !== "unknown" && asciiTrim(locator.value).length > 0)) return null;
    return { evidence: record, kind: "retrieved", source, key: null, unknownLineage: !source.lineage.studyId || asciiTrim(source.lineage.studyId).length === 0 };
  }
  const resultContext = record.extractedValues.some((item) => asciiTrim(item.value).length > 0 && asciiTrim(item.context).length > 0)
    || (record.quotes.some((quote) => asciiTrim(quote).length > 0) && record.locators.some((locator) => locator.type !== "unknown" && asciiTrim(locator.value).length > 0));
  if (!resultContext || !validValues(record)) return null;
  const methodValid = record.method !== null && asciiTrim(record.method).length > 0
    && (record.sourceRef !== null || record.extractedValues.some((item) => asciiTrim(item.context).length > 0));
  let calculationValid = false;
  if (record.calculationId !== null) {
    const calculation = indexes.getExactRecord({ kind: "calculations", id: record.calculationId, revision: null }) as CalculationRecord | undefined;
    if (!calculation) fail("evidence.unresolved-ref");
    calculationValid = validCalculation(calculation, record);
  }
  if (!methodValid && !calculationValid) return null;
  return { evidence: record, kind: "derived", source: null,
    key: calculationValid ? `derived-calculation:${record.calculationId}` : `derived-method:${record.evidenceId}`, unknownLineage: false };
}
function validValues(record: EvidenceRecord): boolean {
  return record.extractedValues.every((item) => item.numericValue === null
    || (asciiTrim(item.context).length > 0 && item.unit !== null && asciiTrim(item.unit).length > 0));
}
function validCalculation(calculation: CalculationRecord, record: EvidenceRecord): boolean {
  if (calculation.attemptId !== record.recordedByAttemptId || calculation.status !== "success" || calculation.exitCode !== 0
    || calculation.inputs.length + calculation.sourceFiles.length === 0 || calculation.outputs.length === 0) return false;
  const paths = new Set<string>();
  for (const file of [...calculation.inputs, ...calculation.sourceFiles, ...calculation.outputs]) {
    if (paths.has(file.relativePath)) return false; paths.add(file.relativePath);
  }
  return true;
}
function assignRetrievedComponents(items: QualifiedEvidence[], indexes: ReturnType<typeof getValidatedSnapshotIndexes>): void {
  const representatives: QualifiedEvidence[] = [];
  for (const item of items) {
    if (item.unknownLineage || !item.source) continue;
    let match: QualifiedEvidence | undefined;
    for (const candidate of representatives) {
      const result = compareSourceIndependence(indexes.lineageGraph,
        { sourceId: item.source.sourceId, revision: item.source.revision },
        { sourceId: candidate.source!.sourceId, revision: candidate.source!.revision });
      if (result.status === "dependent") { match = candidate; break; }
    }
    if (!match) { item.key = `retrieved-lineage:${item.source.sourceId}`; representatives.push(item); }
    else item.key = match.key;
  }
}
function selectApplicableVerifications(records: readonly VerificationRecord[], target: ClaimRecord): VerificationRecord[] {
  const selected = new Map<string, VerificationRecord>();
  for (const record of records) if (record.checkedClaims.some((ref) => ref.claimId === target.claimId && ref.revision === target.revision)) {
    const prior = selected.get(record.verificationId); if (!prior || prior.revision < record.revision) selected.set(record.verificationId, record);
  }
  return [...selected.values()].sort((a, b) => a.verificationId < b.verificationId ? -1 : a.verificationId > b.verificationId ? 1 : a.revision - b.revision);
}
function independentCredit(
  verifications: VerificationRecord[], target: ClaimRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>,
  base: QualifiedEvidence[], baseKeys: Set<string>,
): 0 | 1 {
  const baseAttempts = new Set([target.createdByAttemptId, ...base.map(({ evidence }) => evidence.recordedByAttemptId)]);
  const candidates: Array<{ verificationId: string; revision: number; key: string }> = [];
  for (const verification of verifications) {
    if (verification.result !== "accepted" || !["independent-source", "mixed"].includes(verification.method) || baseAttempts.has(verification.attemptId)) continue;
    for (const id of verification.independentEvidenceIds) {
      const checked = verification.checkedEvidence.filter((ref) => ref.evidenceId === id); if (checked.length !== 1) continue;
      const record = indexes.getExactRecord({ kind: "evidence", id: String(id), revision: Number(checked[0]!.revision) }) as EvidenceRecord | undefined;
      if (!record || record.recordedByAttemptId !== verification.attemptId || record.claimRef.claimId !== target.claimId || record.claimRef.revision !== target.revision || record.stance !== "supporting") continue;
      const qualified = qualifyEvidence(record, indexes, target); if (!qualified) continue;
      if (qualified.kind === "retrieved") {
        const dependentBase = base.find((item) => item.kind === "retrieved" && item.source && qualified.source
          && compareSourceIndependence(indexes.lineageGraph,
            { sourceId: qualified.source.sourceId, revision: qualified.source.revision },
            { sourceId: item.source.sourceId, revision: item.source.revision }).status !== "independent");
        qualified.key = dependentBase?.key ?? (qualified.source ? `retrieved-lineage:${qualified.source.sourceId}` : null);
      }
      if (qualified.key && !baseKeys.has(qualified.key)) candidates.push({ verificationId: verification.verificationId, revision: verification.revision, key: qualified.key });
    }
  }
  candidates.sort((a, b) => a.verificationId < b.verificationId ? -1 : a.verificationId > b.verificationId ? 1 : a.revision - b.revision || (a.key < b.key ? -1 : 1));
  return candidates.length > 0 ? 1 : 0;
}
function conflictsResolved(verifications: VerificationRecord[], target: ClaimRecord, supporting: QualifiedEvidence[], contradictions: EvidenceRecord[]): boolean {
  if (target.status !== "supported") return false;
  const used = [...supporting.map(({ evidence }) => evidence), ...contradictions];
  return verifications.some((verification) => verification.result === "accepted"
    && verification.corrections.some((correction) => correction.claimId === target.claimId)
    && used.every((record) => verification.checkedEvidence.some((ref) => ref.evidenceId === record.evidenceId && ref.revision === record.revision))
    && contradictions.every((record) => record.verificationStatus === "rejected"));
}
function enforceCurrentReferences(target: ClaimRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>): void {
  const latestClaim = indexes.getLatestRevision("claims", target.claimId);
  if (latestClaim !== target.revision || target.revision === 1) return;
  const prior = indexes.getExactRecord({ kind: "claims", id: target.claimId, revision: target.revision - 1 }) as ClaimRecord | undefined;
  const retained = new Set((prior?.evidenceRefs ?? []).map((ref) => `${ref.evidenceId}\0${ref.revision}`));
  for (const ref of target.evidenceRefs) if (!retained.has(`${ref.evidenceId}\0${ref.revision}`)
    && indexes.getLatestRevision("evidence", String(ref.evidenceId)) !== Number(ref.revision)) fail("evidence.stale-latest-ref");
}
function validateProspectiveLimits(input?: EvidenceSetLimits): { claim: number; evidence: number; verification: number } {
  if (input === undefined) return { claim: 524_288, evidence: 524_288, verification: 524_288 };
  if (utilTypes.isProxy(input) || !isPlain(input)) fail("evidence.invalid-options");
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(canonicalJson(input)); } catch { return fail("evidence.invalid-options"); }
  const allowed = new Set([
    "maxPerKind", "maxTotalRecords", "maxReferences", "maxLineageComponents", "maxCanonicalScalarBytes",
    "maxSourceRecordCanonicalBytes", "maxRequestRecordCanonicalBytes", "maxClaimRecordCanonicalBytes",
    "maxEvidenceRecordCanonicalBytes", "maxVerificationRecordCanonicalBytes", "maxCalculationRecordCanonicalBytes",
    "maxCanonicalEvidenceSetBytes",
  ]);
  if (Object.keys(snapshot).some((key) => !allowed.has(key))) fail("evidence.invalid-options");
  const read = (key: "maxClaimRecordCanonicalBytes" | "maxEvidenceRecordCanonicalBytes" | "maxVerificationRecordCanonicalBytes") => {
    const candidate = snapshot[key]; const value = candidate === undefined ? 524_288 : candidate;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_048_576) fail("evidence.invalid-options"); return value;
  };
  return { claim: read("maxClaimRecordCanonicalBytes"), evidence: read("maxEvidenceRecordCanonicalBytes"), verification: read("maxVerificationRecordCanonicalBytes") };
}
function validateClaimRef(input: unknown): { claimId: string; revision: number } {
  if (utilTypes.isProxy(input) || !isPlain(input) || Reflect.ownKeys(input).length !== 2) fail("evidence.invalid-input");
  const id = Object.getOwnPropertyDescriptor(input, "claimId");
  const revision = Object.getOwnPropertyDescriptor(input, "revision");
  if (!id || !revision || !("value" in id) || !("value" in revision) || !id.enumerable || !revision.enumerable
    || typeof id.value !== "string" || !/^claim-[a-z0-9]{16,64}$/u.test(id.value)
    || !Number.isSafeInteger(revision.value) || revision.value < 1) fail("evidence.invalid-input");
  return Object.freeze({ claimId: id.value, revision: revision.value });
}
function validateEvaluationOptions(options?: Readonly<{ maxEvidencePerClaim?: number }>): number {
  if (options === undefined) return 10_000;
  if (utilTypes.isProxy(options) || !isPlain(options) || Reflect.ownKeys(options).some((key) => key !== "maxEvidencePerClaim")) fail("evidence.invalid-options");
  const descriptor = Object.getOwnPropertyDescriptor(options, "maxEvidencePerClaim");
  if (descriptor && (!("value" in descriptor) || !descriptor.enumerable)) fail("evidence.invalid-options");
  const value = descriptor?.value ?? 10_000; if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) fail("evidence.invalid-options"); return value;
}
function refCompare(left: { evidenceId: string; revision: number }, right: { evidenceId: string; revision: number }): number { return left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : left.revision - right.revision; }
function checkedAdd(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result)) fail("evidence.input-too-large"); return result; }
function asciiTrim(value: string): string { return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, ""); }
function isPlain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as any)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(code: EvidenceAdmissionErrorCode): never { throw new EvidenceAdmissionError(code); }
