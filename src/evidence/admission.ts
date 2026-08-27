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
import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import { encodeNonNegativeSafeIntegerInternal, stableSortByCodeUnitKeyInternal } from "../scholarly/code-unit-order-internal.js";
import type { SourceUrlPolicyContext } from "../scholarly/identifiers.js";
import type { RequestProvenanceIndex } from "../scholarly/source-identity.js";
import { getLineageRelationComponentKeyInternal, LineageError } from "./lineage.js";
import {
  buildBoundedValidatedEvidenceSnapshotInternal, EvidenceSnapshotBuildFailureInternal,
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
  try { return buildBoundedValidatedEvidenceSnapshotInternal(records, options, diagnostics); }
  catch (error) { if (error instanceof EvidenceSnapshotBuildFailureInternal) fail("evidence.invalid-input"); throw error; }
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

export interface PreparedProspectiveEvidenceSemanticsInternal {
  readonly record: ClaimRecord | EvidenceRecord | VerificationRecord;
  readonly canonicalJson: string;
  readonly canonicalBytes: number;
}
const preparedEvidenceState = new WeakSet<object>();

/** Package-internal one-pass preparation seam; deliberately excluded from the package root. */
export function prepareProspectiveEvidenceCanonicalInternal(
  input: unknown, maximum: number, expected?: "claim" | "evidence" | "verification",
): PreparedProspectiveEvidenceSemanticsInternal {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_048_576) fail("evidence.invalid-options");
  if (utilTypes.isProxy(input)) fail("evidence.invalid-input");
  let json: string;
  try {
    assertBoundedStructure(input, {
      maxDepth: 64, maxNodes: 1_000_000, maxKeys: 1_000_000, maxArrayLength: 1_000_000,
      maxStringBytes: maximum, maxScalarBytes: maximum,
    });
    json = canonicalJson(input);
  } catch (error) {
    if (error instanceof StructuralLimitError && error.reason === "limit") fail("evidence.record-too-large");
    return fail("evidence.invalid-input");
  }
  const canonicalBytes = Buffer.byteLength(json, "utf8");
  if (canonicalBytes > maximum) fail("evidence.record-too-large");
  const snapshot = JSON.parse(json);
  const choices = expected === "claim" ? [ClaimRecordSchema] : expected === "evidence" ? [EvidenceRecordSchema]
    : expected === "verification" ? [VerificationRecordSchema] : [ClaimRecordSchema, EvidenceRecordSchema, VerificationRecordSchema];
  let parsed: ReturnType<typeof parse> | undefined;
  for (const schema of choices) { const result = parse(schema, snapshot); if (result.success) { parsed = result; break; } }
  if (!parsed?.success) fail(expected === undefined ? "evidence.invalid-prospective-record" : "evidence.invalid-input");
  const prepared = Object.freeze({ record: deepFreeze(parsed.value), canonicalJson: json, canonicalBytes }) as PreparedProspectiveEvidenceSemanticsInternal;
  preparedEvidenceState.add(prepared);
  return prepared;
}

/** Package-internal semantic seam consuming only an authentic prepared record. */
export function validatePreparedEvidenceSemanticsInternal(
  prepared: PreparedProspectiveEvidenceSemanticsInternal,
): ClaimRecord | EvidenceRecord | VerificationRecord {
  if (!preparedEvidenceState.has(prepared as object)) fail("evidence.invalid-input");
  const value = prepared.record;
  if ("evidenceId" in value && (value.quotes.some((quote) => asciiTrim(quote).length === 0)
    || value.locators.some((locator) => asciiTrim(locator.value).length === 0)
    || value.extractedValues.some((item) => item.numericValue !== null && asciiTrim(item.context).length === 0)))
    fail("evidence.invalid-prospective-record");
  return value;
}

export function validateProspectiveEvidenceSemantics(
  record: ClaimRecord | EvidenceRecord | VerificationRecord,
  limits?: EvidenceSetLimits,
): ClaimRecord | EvidenceRecord | VerificationRecord {
  const prospectiveLimits = validateProspectiveLimits(limits);
  const prepared = prepareProspectiveEvidenceCanonicalInternal(record, prospectiveLimits.maximum);
  const maximum = "claimId" in prepared.record ? prospectiveLimits.claim
    : "evidenceId" in prepared.record ? prospectiveLimits.evidence : prospectiveLimits.verification;
  if (prepared.canonicalBytes > maximum) fail("evidence.record-too-large");
  return validatePreparedEvidenceSemanticsInternal(prepared);
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
  const targetEvidenceRefs = uniqueEvidenceRefs(target.evidenceRefs);
  if (targetEvidenceRefs.length > maxEvidence) fail("evidence.too-many-records");
  enforceCurrentReferences(target, indexes);

  const qualifying: QualifiedEvidence[] = [];
  const conflictClosure = buildConflictClosure(target, indexes, maxEvidence);
  const contradictions = conflictClosure.evidence;
  let otherwiseUnknown = false;
  for (const ref of targetEvidenceRefs) {
    const evidenceId = String(ref.evidenceId); const evidenceRevision = Number(ref.revision);
    const record = indexes.getExactRecord({ kind: "evidence", id: evidenceId, revision: evidenceRevision }) as EvidenceRecord | undefined;
    if (!record) fail("evidence.unresolved-ref");
    if (record.claimRef.claimId !== target.claimId || record.claimRef.revision !== target.revision) continue;
    if (record.stance === "contradicting") continue;
    if (record.stance !== "supporting" || !["unverified", "verified"].includes(record.verificationStatus)) continue;
    const qualified = qualifyEvidence(record, indexes, target);
    if (qualified) { qualifying.push(qualified); if (qualified.unknownLineage) otherwiseUnknown = true; }
  }

  const retrieved = qualifying.filter((item) => item.kind === "retrieved");
  const retrievedContext = assignEvaluationLocalComponents(retrieved, indexes);
  const baseKeys = new Set<string>();
  for (const item of qualifying) if (item.key !== null) baseKeys.add(item.key);
  const retrievedKeys = new Set(retrieved.flatMap((item) => item.key ? [item.key] : []));
  const derivedKeys = new Set(qualifying.filter((item) => item.kind === "derived").flatMap((item) => item.key ? [item.key] : []));
  const retrievedComponentCount = retrievedKeys.size;
  const derivedComponentCount = derivedKeys.size;
  const resolvedLineageCount = checkedAdd(retrievedComponentCount, derivedComponentCount);
  const selectedVerifications = selectApplicableVerifications(snapshot.records.verifications, target);
  const independentVerificationCredit = target.evidenceRule.independentVerificationAllowed
    ? independentCredit(selectedVerifications, target, indexes, qualifying, baseKeys, retrievedContext)
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
  if ((contradictions.length > 0 || conflictClosure.claims.length > 0)
    && !conflictsResolved(selectedVerifications, target, qualifying, contradictions)) blockers.push("claim.unresolved-conflict");
  const independentRequired = resolvedLineageCount < effectiveMinimum && target.evidenceRule.independentVerificationAllowed && independentVerificationCredit === 0;
  if (independentRequired) blockers.push("claim.independent-verification-required");
  if (effectiveIndependentCount < effectiveMinimum && !independentRequired) blockers.push("claim.insufficient-lineages");

  const supportingEvidenceRefs = Object.freeze(stableSortByCodeUnitKeyInternal(qualifying.map(({ evidence }) => ({ evidenceId: evidence.evidenceId, revision: evidence.revision })), evidenceRefOrderKey));
  const contradictingEvidenceRefs = Object.freeze(stableSortByCodeUnitKeyInternal(contradictions.map(({ evidenceId, revision }) => ({ evidenceId, revision })), evidenceRefOrderKey));
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
    const unknownLineage = !source.lineage.studyId || asciiTrim(source.lineage.studyId).length === 0;
    return { evidence: record, kind: "retrieved", source, key: null, unknownLineage };
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
    if (!Number.isSafeInteger(file.decodedBytes) || file.decodedBytes < 0
      || !/^[a-f0-9]{64}$/u.test(file.sha256) || paths.has(file.relativePath)) return false;
    paths.add(file.relativePath);
  }
  return true;
}
interface RetrievedComponentContext { readonly relationKeys: ReadonlySet<string>; readonly metadataTokens: ReadonlySet<string> }
function sourceMetadataTokens(source: SourceRecord): string[] {
  return [
    `study:${source.lineage.studyId!}`,
    ...source.lineage.cohortIds.filter((id) => id.length > 0).map((id) => `cohort:${id}`),
    ...source.lineage.datasetIds.filter((id) => id.length > 0).map((id) => `dataset:${id}`),
  ];
}
function relationComponentKey(source: SourceRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>): string {
  try { return getLineageRelationComponentKeyInternal(indexes.lineageGraph, { sourceId: source.sourceId, revision: source.revision }); }
  catch (error) { if (error instanceof LineageError) fail("evidence.invalid-input"); return fail("evidence.invalid-input"); }
}
function assignEvaluationLocalComponents(
  items: QualifiedEvidence[], indexes: ReturnType<typeof getValidatedSnapshotIndexes>,
): RetrievedComponentContext {
  const selected = items.filter((item) => item.kind === "retrieved" && !item.unknownLineage && item.source !== null);
  const parent = selected.map((_, index) => index);
  const find = (value: number): number => { let root = value; while (parent[root] !== root) root = parent[root]!; while (parent[value] !== value) { const next = parent[value]!; parent[value] = root; value = next; } return root; };
  const join = (left: number, right: number): void => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  const relationOwner = new Map<string, number>(); const metadataOwner = new Map<string, number>();
  const relationMinimumByIndex: string[] = [];
  selected.forEach((item, index) => {
    const source = item.source!; const relation = relationComponentKey(source, indexes); relationMinimumByIndex[index] = relation;
    const relationPrior = relationOwner.get(relation); if (relationPrior === undefined) relationOwner.set(relation, index); else join(relationPrior, index);
    for (const token of sourceMetadataTokens(source)) { const prior = metadataOwner.get(token); if (prior === undefined) metadataOwner.set(token, index); else join(prior, index); }
  });
  const smallest = new Map<number, string>();
  selected.forEach((_item, index) => { const root = find(index); const id = relationMinimumByIndex[index]!; const prior = smallest.get(root); if (prior === undefined || id < prior) smallest.set(root, id); });
  selected.forEach((item, index) => { item.key = `retrieved-lineage:${smallest.get(find(index))!}`; });
  return Object.freeze({ relationKeys: new Set(relationOwner.keys()), metadataTokens: new Set(metadataOwner.keys()) });
}
interface ConflictClosure { readonly evidence: EvidenceRecord[]; readonly claims: ClaimRecord[] }
function buildConflictClosure(
  target: ClaimRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>, maximum: number,
): ConflictClosure {
  const queue: Array<{ key: SnapshotRecordKey; conflictMask: number }> = [];
  const state = new Map<string, number>(); const expanded = new Set<string>();
  const contradictions = new Map<string, EvidenceRecord>(); const conflictingClaims = new Map<string, ClaimRecord>();
  const directEvidence = new Set(uniqueEvidenceRefs(target.evidenceRefs).map((ref) => `${ref.evidenceId}\0${ref.revision}`));
  let edgeCount = 0;
  const enqueue = (key: SnapshotRecordKey, conflictMask: number): void => {
    const encoded = `${key.kind}\0${key.id}\0${key.revision ?? 0}`; const exists = state.has(encoded); const prior = state.get(encoded) ?? 0;
    const combined = prior | conflictMask; if (exists && combined === prior) return;
    if (!exists && state.size >= maximum) fail("evidence.too-many-records");
    state.set(encoded, combined); queue.push({ key, conflictMask: combined });
  };
  for (const ref of uniqueEvidenceRefs(target.evidenceRefs)) enqueue({ kind: "evidence", id: ref.evidenceId, revision: ref.revision }, 0);
  for (const id of target.conflictClaimIds) {
    const revision = indexes.getLatestRevision("claims", String(id)); if (revision === undefined) fail("evidence.unresolved-ref");
    enqueue({ kind: "claims", id: String(id), revision }, 2);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { key, conflictMask } = queue[cursor]!; const encoded = `${key.kind}\0${key.id}\0${key.revision ?? 0}`;
    const record = indexes.getExactRecord(key) as ClaimRecord | EvidenceRecord | undefined;
    if (!record) fail("evidence.unresolved-ref");
    if (key.kind === "claims") {
      const claim = record as ClaimRecord;
      if (conflictMask !== 0 && claim.claimId !== target.claimId) conflictingClaims.set(`${claim.claimId}\0${claim.revision}`, claim);
      if (expanded.has(encoded)) continue; expanded.add(encoded);
      edgeCount = checkedAdd(edgeCount, claim.evidenceRefs.length + claim.conflictClaimIds.length);
      if (edgeCount > maximum) fail("evidence.too-many-references");
      for (const ref of uniqueEvidenceRefs(claim.evidenceRefs)) enqueue({ kind: "evidence", id: ref.evidenceId, revision: ref.revision }, conflictMask === 0 ? 0 : 2);
      for (const id of claim.conflictClaimIds) {
        if (id === target.claimId) continue;
        const revision = indexes.getLatestRevision("claims", String(id)); if (revision === undefined) fail("evidence.unresolved-ref");
        enqueue({ kind: "claims", id: String(id), revision }, 2);
      }
    } else {
      const evidence = record as EvidenceRecord; const exact = `${evidence.evidenceId}\0${evidence.revision}`;
      const relativeConflict = (conflictMask & 1) !== 0 || ((conflictMask & 2) !== 0 && evidence.stance === "supporting");
      if (evidence.stance === "contradicting" || (relativeConflict && !directEvidence.has(exact))) contradictions.set(exact, evidence);
      if (expanded.has(encoded)) continue; expanded.add(encoded);
      edgeCount = checkedAdd(edgeCount, evidence.conflictsWith.length);
      if (edgeCount > maximum) fail("evidence.too-many-references");
      for (const id of evidence.conflictsWith) {
        const revision = indexes.getLatestRevision("evidence", String(id)); if (revision === undefined) fail("evidence.unresolved-ref");
        enqueue({ kind: "evidence", id: String(id), revision }, 1);
      }
    }
  }
  return {
    evidence: stableSortByCodeUnitKeyInternal([...contradictions.values()], evidenceRefOrderKey),
    claims: stableSortByCodeUnitKeyInternal([...conflictingClaims.values()], claimRefOrderKey),
  };
}
function selectApplicableVerifications(records: readonly VerificationRecord[], target: ClaimRecord): VerificationRecord[] {
  const selected = new Map<string, VerificationRecord>();
  for (const record of records) if (record.checkedClaims.some((ref) => ref.claimId === target.claimId && ref.revision === target.revision)) {
    const prior = selected.get(record.verificationId); if (!prior || prior.revision < record.revision) selected.set(record.verificationId, record);
  }
  return stableSortByCodeUnitKeyInternal([...selected.values()], verificationRefOrderKey);
}
function independentCredit(
  verifications: VerificationRecord[], target: ClaimRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>,
  base: QualifiedEvidence[], baseKeys: Set<string>, retrievedContext: RetrievedComponentContext,
): 0 | 1 {
  const baseAttempts = new Set([target.createdByAttemptId, ...base.map(({ evidence }) => evidence.recordedByAttemptId)]);
  const candidates: Array<{ verificationId: string; revision: number; key: string }> = [];
  for (const verification of verifications) {
    if (verification.result !== "accepted" || !["independent-source", "mixed"].includes(verification.method) || baseAttempts.has(verification.attemptId)) continue;
    for (const id of verification.independentEvidenceIds) {
      const checked = verification.checkedEvidence.filter((ref) => ref.evidenceId === id); if (checked.length !== 1) continue;
      const record = indexes.getExactRecord({ kind: "evidence", id: String(id), revision: Number(checked[0]!.revision) }) as EvidenceRecord | undefined;
      if (!record || record.recordedByAttemptId !== verification.attemptId || record.claimRef.claimId !== target.claimId
        || record.claimRef.revision !== target.revision || record.stance !== "supporting"
        || !["unverified", "verified"].includes(record.verificationStatus)) continue;
      const qualified = qualifyEvidence(record, indexes, target); if (!qualified) continue;
      if (qualified.kind === "retrieved") {
        if (qualified.unknownLineage || !qualified.source) continue;
        const relation = relationComponentKey(qualified.source, indexes);
        const tokens = sourceMetadataTokens(qualified.source);
        if (retrievedContext.relationKeys.has(relation) || tokens.some((token) => retrievedContext.metadataTokens.has(token))) continue;
        qualified.key = `retrieved-lineage:${relation}`;
      }
      if (qualified.key && !baseKeys.has(qualified.key)) candidates.push({ verificationId: verification.verificationId, revision: verification.revision, key: qualified.key });
    }
  }
  const orderedCandidates = stableSortByCodeUnitKeyInternal(candidates, (candidate) => `${verificationRefOrderKey(candidate)}\0${candidate.key}`);
  return orderedCandidates.length > 0 ? 1 : 0;
}
function conflictsResolved(
  verifications: VerificationRecord[], target: ClaimRecord, supporting: QualifiedEvidence[], contradictions: EvidenceRecord[],
): boolean {
  if (target.status !== "supported") return false;
  const supportingRecords = supporting.map(({ evidence }) => evidence);
  const used = [...supportingRecords, ...contradictions];
  const forbiddenAttempts = new Set([target.createdByAttemptId, ...supportingRecords.map((evidence) => evidence.recordedByAttemptId)]);
  return verifications.some((verification) => verification.result === "accepted" && !forbiddenAttempts.has(verification.attemptId)
    && verification.corrections.some((correction) => correction.claimId === target.claimId && asciiTrim(correction.description).length > 0)
    && used.every((record) => verification.checkedEvidence.some((ref) => ref.evidenceId === record.evidenceId && ref.revision === record.revision))
    && contradictions.every((record) => record.verificationStatus === "rejected"));
}
function enforceCurrentReferences(target: ClaimRecord, indexes: ReturnType<typeof getValidatedSnapshotIndexes>): void {
  const latestClaim = indexes.getLatestRevision("claims", target.claimId);
  if (latestClaim !== target.revision) return;
  const prior = target.revision === 1 ? undefined
    : indexes.getExactRecord({ kind: "claims", id: target.claimId, revision: target.revision - 1 }) as ClaimRecord | undefined;
  const retained = new Set((prior?.evidenceRefs ?? []).map((ref) => `${ref.evidenceId}\0${ref.revision}`));
  for (const ref of target.evidenceRefs) if (!retained.has(`${ref.evidenceId}\0${ref.revision}`)
    && indexes.getLatestRevision("evidence", String(ref.evidenceId)) !== Number(ref.revision)) fail("evidence.stale-latest-ref");
}
function validateProspectiveLimits(input?: EvidenceSetLimits): { claim: number; evidence: number; verification: number; maximum: number } {
  const defaults = {
    maxTotalRecords: 300_000, maxReferences: 500_000, maxLineageComponents: 100_000,
    maxCanonicalScalarBytes: 4_096, maxSourceRecordCanonicalBytes: 262_144, maxRequestRecordCanonicalBytes: 262_144,
    maxClaimRecordCanonicalBytes: 524_288, maxEvidenceRecordCanonicalBytes: 524_288,
    maxVerificationRecordCanonicalBytes: 524_288, maxCalculationRecordCanonicalBytes: 524_288,
    maxCanonicalEvidenceSetBytes: 33_554_432,
  } as const;
  const hards = {
    maxTotalRecords: 1_000_000, maxReferences: 2_000_000, maxLineageComponents: 500_000,
    maxCanonicalScalarBytes: 16_384, maxSourceRecordCanonicalBytes: 1_048_576, maxRequestRecordCanonicalBytes: 1_048_576,
    maxClaimRecordCanonicalBytes: 1_048_576, maxEvidenceRecordCanonicalBytes: 1_048_576,
    maxVerificationRecordCanonicalBytes: 1_048_576, maxCalculationRecordCanonicalBytes: 1_048_576,
    maxCanonicalEvidenceSetBytes: 134_217_728,
  } as const;
  const perDefaults = { sources: 50_000, claims: 50_000, evidence: 100_000, verifications: 25_000, requests: 100_000, calculations: 25_000 } as const;
  const perHards = { sources: 200_000, claims: 200_000, evidence: 500_000, verifications: 100_000, requests: 500_000, calculations: 100_000 } as const;
  let snapshot: Record<string, unknown> = {};
  if (input !== undefined) {
    if (utilTypes.isProxy(input) || !isPlain(input)) fail("evidence.invalid-options");
    try {
      assertBoundedStructure(input, { maxDepth: 4, maxNodes: 100, maxKeys: 100, maxArrayLength: 0, maxStringBytes: 128, maxScalarBytes: 1_000_000 });
      snapshot = JSON.parse(canonicalJson(input));
    } catch { return fail("evidence.invalid-options"); }
  }
  const allowed = new Set(["maxPerKind", ...Object.keys(defaults)]);
  if (!isPlain(snapshot) || Object.keys(snapshot).some((key) => !allowed.has(key))) fail("evidence.invalid-options");
  const values: Record<string, number> = {};
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const candidate = snapshot[key] ?? defaults[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1 || candidate > hards[key]) fail("evidence.invalid-options");
    values[key] = candidate;
  }
  const rawPer = snapshot.maxPerKind ?? {};
  if (!isPlain(rawPer) || (snapshot.maxPerKind !== undefined && Reflect.ownKeys(rawPer).length !== 6)
    || Object.keys(rawPer).some((key) => !(key in perDefaults))) fail("evidence.invalid-options");
  for (const key of Object.keys(perDefaults) as Array<keyof typeof perDefaults>) {
    const candidate = rawPer[key] ?? perDefaults[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1 || candidate > perHards[key]
      || candidate > values.maxTotalRecords!) fail("evidence.invalid-options");
  }
  if (values.maxLineageComponents! > values.maxTotalRecords!
    || values.maxCanonicalScalarBytes! > values.maxSourceRecordCanonicalBytes!
    || values.maxCanonicalScalarBytes! > values.maxRequestRecordCanonicalBytes!
    || ["maxSourceRecordCanonicalBytes", "maxRequestRecordCanonicalBytes", "maxClaimRecordCanonicalBytes", "maxEvidenceRecordCanonicalBytes", "maxVerificationRecordCanonicalBytes", "maxCalculationRecordCanonicalBytes"]
      .some((key) => values[key]! > values.maxCanonicalEvidenceSetBytes!)) fail("evidence.invalid-options");
  return {
    claim: values.maxClaimRecordCanonicalBytes!, evidence: values.maxEvidenceRecordCanonicalBytes!,
    verification: values.maxVerificationRecordCanonicalBytes!,
    maximum: Math.max(values.maxClaimRecordCanonicalBytes!, values.maxEvidenceRecordCanonicalBytes!, values.maxVerificationRecordCanonicalBytes!),
  };
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
function uniqueEvidenceRefs(refs: readonly any[]): Array<{ evidenceId: string; revision: number }> {
  const unique = new Map<string, { evidenceId: string; revision: number }>();
  for (const ref of refs) { const value = { evidenceId: String(ref.evidenceId), revision: Number(ref.revision) }; unique.set(`${value.evidenceId}\0${value.revision}`, value); }
  return stableSortByCodeUnitKeyInternal([...unique.values()], evidenceRefOrderKey);
}
function evidenceRefOrderKey(value: Readonly<{ evidenceId: string; revision: number }>): string { return `${value.evidenceId}\0${encodeNonNegativeSafeIntegerInternal(value.revision)}`; }
function claimRefOrderKey(value: Readonly<{ claimId: string; revision: number }>): string { return `${value.claimId}\0${encodeNonNegativeSafeIntegerInternal(value.revision)}`; }
function verificationRefOrderKey(value: Readonly<{ verificationId: string; revision: number }>): string { return `${value.verificationId}\0${encodeNonNegativeSafeIntegerInternal(value.revision)}`; }
function checkedAdd(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result)) fail("evidence.input-too-large"); return result; }
function asciiTrim(value: string): string { return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, ""); }
function isPlain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as any)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(code: EvidenceAdmissionErrorCode): never { throw new EvidenceAdmissionError(code); }
