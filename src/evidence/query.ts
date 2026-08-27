import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { FoundationLedgerEventSchema, type FoundationLedgerEvent, type RequestRecord } from "../domain/events.js";
import { ID_PATTERNS } from "../domain/ids.js";
import { parse } from "../domain/schema.js";
import { LedgerReducerCorruptionError, reduceLedgerEvents } from "../domain/reducer.js";
import type { TaskRecord } from "../domain/records.js";
import type { CalculationRecord, ClaimRecord, EvidenceRecord, ResearchRecord, SourceRecord, VerificationRecord } from "../domain/research-records.js";
import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import {
  EvidenceAdmissionError,
  type BoundedValidatedEvidenceSnapshot, type CanonicalEvidenceSet, type EvidenceSnapshotDiagnostics, type EvidenceSnapshotOptions,
} from "./admission.js";
import { EvidenceSnapshotBuildFailureInternal, buildBoundedValidatedEvidenceSnapshotInternal, getValidatedSnapshotIndexes, type SnapshotRecordKey, type SnapshotRecordKind, type ValidatedSnapshotIndexes } from "./validated-snapshot-internal.js";

export type EvidenceQueryErrorCode =
  | "query.invalid-options" | "query.invalid-input" | "query.invalid-evidence-set" | "query.identity-invalid"
  | "query.lineage-invalid" | "query.reference-invalid" | "query.limit-invalid" | "query.record-too-large"
  | "query.input-too-large" | "query.result-too-large" | "query.closure-too-large" | "query.filter-too-large"
  | "query.unresolved-ref" | "query.metadata-required" | "query.metadata-invalid" | "query.metadata-too-large"
  | "query.cursor-invalid" | "query.cursor-mismatch";
export class EvidenceQueryError extends Error {
  readonly code: EvidenceQueryErrorCode;
  constructor(code: EvidenceQueryErrorCode) { super(`Evidence query rejected (${code})`); this.name = "EvidenceQueryError"; this.code = code; }
}
export interface EvidenceIndexInput { readonly snapshot: BoundedValidatedEvidenceSnapshot; readonly ledgerEvents?: readonly FoundationLedgerEvent[] }
export interface EvidenceQuery {
  readonly sourceRefs?: readonly { sourceId: string; revision: number }[]; readonly claimRefs?: readonly { claimId: string; revision: number }[];
  readonly evidenceRefs?: readonly { evidenceId: string; revision: number }[]; readonly verificationRefs?: readonly { verificationId: string; revision: number }[];
  readonly taskIds?: readonly string[]; readonly roles?: readonly string[]; readonly attemptIds?: readonly string[];
  readonly stances?: readonly EvidenceRecord["stance"][]; readonly qualities?: readonly EvidenceRecord["quality"][];
  readonly lineageIds?: readonly string[]; readonly accessLevels?: readonly SourceRecord["accessLevel"][];
  readonly verificationStatuses?: readonly EvidenceRecord["verificationStatus"][]; readonly minimumConfidence?: number;
  readonly limit: number; readonly maxSelectedBytes: number; readonly cursor?: string | null;
}
export interface EvidenceSelection {
  readonly sources: readonly SourceRecord[]; readonly claims: readonly ClaimRecord[]; readonly evidence: readonly EvidenceRecord[];
  readonly verifications: readonly VerificationRecord[]; readonly requests: readonly RequestRecord[]; readonly calculations: readonly CalculationRecord[];
  readonly selectedRecordBundleSha256: string; readonly truncated: boolean; readonly nextCursor: string | null;
}
export interface EvidenceIndex { readonly recordCount: number; readonly canonicalBytes: number; query(input: EvidenceQuery): EvidenceSelection }
export interface EvidenceQueryDiagnostics {
  indexVisits: number;
  candidateVisits: number;
  closureVisits: number;
  normalizedQueryCanonicalizations: number;
}
export interface EvidenceIndexOptions {
  readonly maxLedgerEvents?: number; readonly maxTaskRevisions?: number; readonly maxStableTasks?: number; readonly maxAttempts?: number;
  readonly maxMetadataCanonicalBytes?: number; readonly maxFilterValues?: number; readonly maxFilterBytes?: number; readonly maxPageLimit?: number;
  readonly maxPrimaryPageRecords?: number; readonly maxPrimaryPageBytes?: number; readonly maxCursorBytes?: number; readonly maxClosureEdges?: number;
  readonly maxSelectedBytes?: number; readonly maxTotalSelectedRecords?: number;
  readonly maxSelectedPerKind?: Readonly<{ sources: number; claims: number; evidence: number; verifications: number; requests: number; calculations: number }>;
}

type PrimaryKind = "sources" | "claims" | "evidence" | "verifications";
type AnyRecord = ResearchRecord | RequestRecord;
type Role = "literature-searcher" | "primary-source-reader" | "methodology-reviewer" | "data-verifier" | "adversarial-verifier" | "coordinator";
interface NormalizedOptions extends Required<Omit<EvidenceIndexOptions, "maxSelectedPerKind">> { readonly maxSelectedPerKind: Readonly<Record<SnapshotRecordKind, number>> }
interface Metadata { readonly supplied: boolean; readonly attemptTask: ReadonlyMap<string, string>; readonly taskRole: ReadonlyMap<string, Role>; readonly hash: string }
interface Primary { readonly kind: PrimaryKind; readonly key: SnapshotRecordKey; readonly record: SourceRecord | ClaimRecord | EvidenceRecord | VerificationRecord; readonly canonical: string; readonly owners: readonly string[] }
interface ReversePrimaryIndex { readonly byKey: ReadonlyMap<string, Primary>; readonly fields: Readonly<Record<string, ReadonlyMap<string, ReadonlySet<string>>>> }
interface NormalizedQuery {
  readonly sourceRefs?: readonly SnapshotRecordKey[]; readonly claimRefs?: readonly SnapshotRecordKey[]; readonly evidenceRefs?: readonly SnapshotRecordKey[]; readonly verificationRefs?: readonly SnapshotRecordKey[];
  readonly taskIds?: readonly string[]; readonly roles?: readonly Role[]; readonly attemptIds?: readonly string[];
  readonly stances?: readonly EvidenceRecord["stance"][]; readonly qualities?: readonly EvidenceRecord["quality"][]; readonly lineageIds?: readonly string[];
  readonly accessLevels?: readonly SourceRecord["accessLevel"][]; readonly verificationStatuses?: readonly EvidenceRecord["verificationStatus"][];
  readonly minimumConfidence?: number; readonly limit: number; readonly maxSelectedBytes: number; readonly cursor: string | null; readonly directSupplied: boolean;
  readonly canonical: string; readonly canonicalBytes: number; readonly hash: string;
}
interface CursorPayload { readonly version: 1; readonly snapshotHash: string; readonly queryHash: string; readonly position: readonly [number, string, number]; readonly checksum: string }

const DEFAULT_PER = { sources: 1_000, claims: 1_000, evidence: 2_000, verifications: 500, requests: 1_000, calculations: 500 } as const;
const HARD_PER = { sources: 10_000, claims: 10_000, evidence: 20_000, verifications: 5_000, requests: 10_000, calculations: 5_000 } as const;
const DEFAULTS = { maxLedgerEvents: 500_000, maxTaskRevisions: 100_000, maxStableTasks: 10_000, maxAttempts: 100_000, maxMetadataCanonicalBytes: 16_777_216, maxFilterValues: 10_000, maxFilterBytes: 1_048_576, maxPageLimit: 1_000, maxPrimaryPageRecords: 1_000, maxPrimaryPageBytes: 4_194_304, maxCursorBytes: 4_096, maxClosureEdges: 500_000, maxSelectedBytes: 8_388_608, maxTotalSelectedRecords: 5_000 } as const;
const HARDS = { maxLedgerEvents: 2_000_000, maxTaskRevisions: 500_000, maxStableTasks: 100_000, maxAttempts: 500_000, maxMetadataCanonicalBytes: 67_108_864, maxFilterValues: 100_000, maxFilterBytes: 8_388_608, maxPageLimit: 10_000, maxPrimaryPageRecords: 10_000, maxPrimaryPageBytes: 33_554_432, maxCursorBytes: 65_536, maxClosureEdges: 2_000_000, maxSelectedBytes: 67_108_864, maxTotalSelectedRecords: 50_000 } as const;
const OPTION_KEYS = [...Object.keys(DEFAULTS), "maxSelectedPerKind"];
const QUERY_KEYS = ["sourceRefs", "claimRefs", "evidenceRefs", "verificationRefs", "taskIds", "roles", "attemptIds", "stances", "qualities", "lineageIds", "accessLevels", "verificationStatuses", "minimumConfidence", "limit", "maxSelectedBytes", "cursor"];
const ROLES: readonly Role[] = ["literature-searcher", "primary-source-reader", "methodology-reviewer", "data-verifier", "adversarial-verifier", "coordinator"];
const STANCES = ["supporting", "contradicting", "neutral"] as const;
const QUALITIES = ["primary-peer-reviewed", "primary-unreviewed", "official", "secondary", "unknown"] as const;
const ACCESS = ["metadata-only", "abstract-only", "partial-text", "full-text"] as const;
const STATUSES = ["unverified", "verified", "rejected", "disputed"] as const;
const KINDS: readonly SnapshotRecordKind[] = ["sources", "claims", "evidence", "verifications", "requests", "calculations"];
const RANK: Readonly<Record<PrimaryKind, number>> = { sources: 0, claims: 1, evidence: 2, verifications: 3 };

export function buildEvidenceIndex(input: EvidenceIndexInput, options?: EvidenceIndexOptions): EvidenceIndex {
  return buildEvidenceIndexInternal(input, options);
}
/** Package-internal test seam; intentionally absent from the package root. */
export function buildEvidenceIndexWithDiagnosticsInternal(input: EvidenceIndexInput, options: EvidenceIndexOptions | undefined, diagnostics: EvidenceQueryDiagnostics): EvidenceIndex {
  validateQueryDiagnostics(diagnostics);
  return buildEvidenceIndexInternal(input, options, diagnostics);
}
function buildEvidenceIndexInternal(input: EvidenceIndexInput, options?: EvidenceIndexOptions, diagnostics?: EvidenceQueryDiagnostics): EvidenceIndex {
  const normalizedOptions = normalizeOptions(options);
  const validatedInput = validateIndexInput(input);
  let indexes: ValidatedSnapshotIndexes;
  try { indexes = getValidatedSnapshotIndexes(validatedInput.snapshot); }
  catch (error) { if (error instanceof EvidenceAdmissionError && error.code === "evidence.snapshot-invalid") fail("query.invalid-input"); return fail("query.invalid-input"); }
  const metadata = buildMetadata(validatedInput.snapshot, validatedInput.ledgerEvents, normalizedOptions);
  const ownersByKey = buildOwnerIndex(validatedInput.snapshot, diagnostics);
  const snapshotHash = sha256Hex(canonicalJson({ snapshotSha256: indexes.snapshotSha256, optionsSha256: indexes.optionsSha256, policySha256: indexes.policySha256, metadataSha256: metadata.hash }));
  const latestEvidence: Primary[] = [];
  for (const record of validatedInput.snapshot.records.evidence) { bumpQuery(diagnostics, "indexVisits"); if (indexes.getLatestRevision("evidence", record.evidenceId) === record.revision)
    latestEvidence.push(primaryFor("evidence", record, indexes, ownersByKey)); }
  latestEvidence.sort(comparePrimary);
  const reverse = buildReversePrimaryIndex(latestEvidence, indexes, metadata, diagnostics);
  const api = Object.freeze({
    recordCount: validatedInput.snapshot.recordCount,
    canonicalBytes: validatedInput.snapshot.canonicalBytes,
    query(value: EvidenceQuery): EvidenceSelection {
      const normalized = normalizeQuery(value, normalizedOptions, diagnostics);
      const position = normalized.cursor === null ? null : decodeCursor(normalized.cursor, normalizedOptions, snapshotHash, normalized.hash);
      if (((normalized.taskIds?.length ?? 0) > 0 || (normalized.roles?.length ?? 0) > 0) && !metadata.supplied) fail("query.metadata-required");
      let candidates = normalized.directSupplied ? directCandidates(normalized, indexes, ownersByKey) : indexedEvidenceCandidates(normalized, latestEvidence, reverse);
      candidates = candidates.filter((item) => { bumpQuery(diagnostics, "candidateVisits"); return matches(item, normalized, metadata, indexes); }).sort(comparePrimary);
      if (position !== null) candidates = candidates.filter((item) => compareTuple(tupleFor(item), position) > 0);
      const primaryPage = candidates.slice(0, normalized.limit);
      preflightPrimaryPage(primaryPage, normalizedOptions);
      const closure = createClosure(indexes, normalizedOptions, Math.min(normalized.maxSelectedBytes, normalizedOptions.maxSelectedBytes), diagnostics);
      let accepted = 0; let closureStopped = false;
      for (const item of primaryPage) {
        if (!closure.tryAdd(item.key)) { if (accepted === 0) fail("query.closure-too-large"); closureStopped = true; break; }
        accepted += 1;
      }
      const successfulPrimaries = primaryPage.slice(0, accepted);
      const more = closureStopped || candidates.length > successfulPrimaries.length;
      const nextCursor = more && successfulPrimaries.length > 0 ? encodeCursor(snapshotHash, normalized.hash, tupleFor(successfulPrimaries.at(-1)!), normalizedOptions.maxCursorBytes) : null;
      return closure.selection(more, nextCursor);
    },
  });
  return api;
}

export function buildEvidenceIndexFromRecords(
  records: CanonicalEvidenceSet, ledgerEvents: readonly FoundationLedgerEvent[] | undefined,
  snapshotOptions?: EvidenceSnapshotOptions, indexOptions?: EvidenceIndexOptions, diagnostics?: EvidenceSnapshotDiagnostics,
): EvidenceIndex {
  normalizeOptions(indexOptions);
  let snapshot: BoundedValidatedEvidenceSnapshot;
  try { snapshot = buildBoundedValidatedEvidenceSnapshotInternal(records, snapshotOptions, diagnostics); }
  catch (error) { return mapSnapshotBuildFailure(error); }
  return buildEvidenceIndex({ snapshot, ...(ledgerEvents === undefined ? {} : { ledgerEvents }) }, indexOptions);
}

function validateIndexInput(input: unknown): { readonly snapshot: BoundedValidatedEvidenceSnapshot; readonly ledgerEvents?: readonly FoundationLedgerEvent[] } {
  if (utilTypes.isProxy(input) || !isPlain(input)) fail("query.invalid-input");
  const keys = Reflect.ownKeys(input); if (keys.some((key) => key !== "snapshot" && key !== "ledgerEvents") || !keys.includes("snapshot")) fail("query.invalid-input");
  const snapshot = dataValue(input, "snapshot", "query.invalid-input"); const ledger = optionalDataValue(input, "ledgerEvents", "query.invalid-input");
  return Object.freeze({ snapshot: snapshot as BoundedValidatedEvidenceSnapshot, ...(ledger.present ? { ledgerEvents: ledger.value as readonly FoundationLedgerEvent[] } : {}) });
}
function normalizeOptions(input?: EvidenceIndexOptions): NormalizedOptions {
  if (input === undefined) return makeOptions({});
  if (utilTypes.isProxy(input) || !isPlain(input)) fail("query.invalid-options");
  const keys = Reflect.ownKeys(input); if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key))) fail("query.invalid-options");
  const raw: Record<string, unknown> = {};
  for (const key of keys as string[]) raw[key] = dataValue(input, key, "query.invalid-options");
  return makeOptions(raw);
}
function makeOptions(raw: Record<string, unknown>): NormalizedOptions {
  const values: Record<string, number> = {};
  const pagination = new Set(["maxPageLimit", "maxPrimaryPageRecords", "maxPrimaryPageBytes", "maxCursorBytes", "maxSelectedBytes", "maxTotalSelectedRecords"]);
  for (const key of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
    const value = raw[key] ?? DEFAULTS[key];
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HARDS[key]) fail(pagination.has(key) ? "query.limit-invalid" : "query.invalid-options");
    values[key] = value as number;
  }
  const rawPer = raw.maxSelectedPerKind ?? DEFAULT_PER;
  if (utilTypes.isProxy(rawPer) || !isPlain(rawPer)) fail("query.limit-invalid");
  const perKeys = Reflect.ownKeys(rawPer); if (perKeys.some((key) => typeof key !== "string" || !KINDS.includes(key as SnapshotRecordKind))) fail("query.invalid-options");
  if (perKeys.length !== KINDS.length || KINDS.some((kind) => !perKeys.includes(kind))) fail("query.limit-invalid");
  const per = {} as Record<SnapshotRecordKind, number>;
  for (const kind of KINDS) { const value = dataValue(rawPer, kind, "query.limit-invalid"); if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HARD_PER[kind] || (value as number) > values.maxTotalSelectedRecords!) fail("query.limit-invalid"); per[kind] = value as number; }
  return Object.freeze({ ...values, maxSelectedPerKind: Object.freeze(per) }) as unknown as NormalizedOptions;
}

function buildMetadata(snapshot: BoundedValidatedEvidenceSnapshot, input: readonly FoundationLedgerEvent[] | undefined, options: NormalizedOptions): Metadata {
  if (input === undefined) return Object.freeze({ supplied: false, attemptTask: new Map(), taskRole: new Map(), hash: sha256Hex(canonicalJson(null)) });
  const events = safeArray(input, options.maxLedgerEvents, "query.metadata-too-large", "query.metadata-invalid");
  let bytes = 2; const prepared: FoundationLedgerEvent[] = [];
  for (const event of events) {
    let json: string; try { assertBoundedStructure(event, { maxDepth: 64, maxNodes: 1_000_000, maxKeys: 1_000_000, maxArrayLength: 1_000_000, maxStringBytes: options.maxMetadataCanonicalBytes, maxScalarBytes: options.maxMetadataCanonicalBytes }); json = canonicalJson(event); }
    catch (error) { if (error instanceof StructuralLimitError && error.reason === "limit") fail("query.metadata-too-large"); return fail("query.metadata-invalid"); }
    bytes = add(bytes, Buffer.byteLength(json, "utf8") + (prepared.length === 0 ? 0 : 1), "query.metadata-too-large"); if (bytes > options.maxMetadataCanonicalBytes) fail("query.metadata-too-large");
    const parsed = parse(FoundationLedgerEventSchema, JSON.parse(json)); if (!parsed.success) fail("query.metadata-invalid");
    prepared.push(deepFreeze(parsed.value));
  }
  let taskRevisionCount = 0; const preflightTaskIds = new Set<string>(); const preflightAttemptIds = new Set<string>();
  for (const event of prepared) {
    if (event.type === "task_upserted") { taskRevisionCount = add(taskRevisionCount, 1, "query.metadata-too-large"); if (taskRevisionCount > options.maxTaskRevisions) fail("query.metadata-too-large"); if (!preflightTaskIds.has(event.payload.task.taskId) && preflightTaskIds.size >= options.maxStableTasks) fail("query.metadata-too-large"); preflightTaskIds.add(event.payload.task.taskId); }
    if (event.type === "dispatch_intent") { if (!preflightAttemptIds.has(event.payload.attempt.attemptId) && preflightAttemptIds.size >= options.maxAttempts) fail("query.metadata-too-large"); preflightAttemptIds.add(event.payload.attempt.attemptId); }
  }
  try { reduceLedgerEvents(Object.freeze(prepared)); } catch (error) { if (error instanceof LedgerReducerCorruptionError) fail("query.metadata-invalid"); return fail("query.metadata-invalid"); }
  const attemptTask = new Map<string, string>(); const taskRevisions = new Map<string, Map<number, TaskRecord>>();
  for (const event of prepared) {
    if (event.type === "dispatch_intent") { const { attemptId, taskId } = event.payload.attempt; const prior = attemptTask.get(attemptId); if (prior !== undefined && prior !== taskId) fail("query.metadata-invalid"); attemptTask.set(attemptId, taskId); }
    if (event.type === "task_upserted") { const task = event.payload.task; const revisions = taskRevisions.get(task.taskId) ?? new Map<number, TaskRecord>(); if (revisions.has(task.revision)) fail("query.metadata-invalid"); revisions.set(task.revision, task); taskRevisions.set(task.taskId, revisions); }
  }
  const taskRole = new Map<string, Role>();
  for (const [taskId, revisions] of taskRevisions) { for (let revision = 1; revision <= revisions.size; revision += 1) if (!revisions.has(revision)) fail("query.metadata-invalid"); taskRole.set(taskId, revisions.get(revisions.size)!.role as Role); }
  const producerAttempts = new Set<string>();
  for (const claim of snapshot.records.claims) producerAttempts.add(claim.createdByAttemptId);
  for (const item of snapshot.records.evidence) producerAttempts.add(item.recordedByAttemptId);
  for (const item of snapshot.records.verifications) producerAttempts.add(item.attemptId);
  for (const item of snapshot.records.requests) producerAttempts.add(item.attemptId);
  for (const item of snapshot.records.calculations) producerAttempts.add(item.attemptId);
  for (const id of producerAttempts) if (!attemptTask.has(id) || !taskRole.has(attemptTask.get(id)!)) fail("query.metadata-invalid");
  const canonical = { attempts: [...attemptTask].sort(pairSort), tasks: [...taskRole].sort(pairSort) };
  return Object.freeze({ supplied: true, attemptTask, taskRole, hash: sha256Hex(canonicalJson(canonical)) });
}

type PreflightReference = Readonly<{ id: string; revision: number }>;
type PreflightFilterValue = string | PreflightReference;
type PreflightFilters = Readonly<Record<string, readonly PreflightFilterValue[]>>;
const REF_FILTERS: Readonly<Record<string, readonly [PrimaryKind, string, RegExp]>> = Object.freeze({
  sourceRefs: ["sources", "sourceId", ID_PATTERNS.source], claimRefs: ["claims", "claimId", ID_PATTERNS.claim],
  evidenceRefs: ["evidence", "evidenceId", ID_PATTERNS.evidence], verificationRefs: ["verifications", "verificationId", ID_PATTERNS.verification],
});
const STRING_FILTERS: Readonly<Record<string, readonly string[] | RegExp | null>> = Object.freeze({
  taskIds: ID_PATTERNS.task, roles: ROLES, attemptIds: ID_PATTERNS.attempt, stances: STANCES, qualities: QUALITIES,
  lineageIds: null, accessLevels: ACCESS, verificationStatuses: STATUSES,
});
const FILTER_FIELDS = Object.freeze([...Object.keys(REF_FILTERS), ...Object.keys(STRING_FILTERS)].sort());
function normalizeQuery(input: unknown, options: NormalizedOptions, diagnostics?: EvidenceQueryDiagnostics): NormalizedQuery {
  if (utilTypes.isProxy(input) || !isPlain(input)) fail("query.invalid-input");
  const keys = Reflect.ownKeys(input); if (keys.some((key) => typeof key !== "string" || !QUERY_KEYS.includes(key)) || !keys.includes("limit") || !keys.includes("maxSelectedBytes")) fail("query.invalid-input");
  const raw: Record<string, unknown> = {}; for (const key of keys as string[]) raw[key] = dataValue(input, key, "query.invalid-input");
  const limit = raw.limit; const maxSelectedBytes = raw.maxSelectedBytes;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > options.maxPageLimit
    || !Number.isSafeInteger(maxSelectedBytes) || (maxSelectedBytes as number) < 1 || (maxSelectedBytes as number) > options.maxSelectedBytes) fail("query.limit-invalid");
  if (raw.cursor !== undefined && raw.cursor !== null && typeof raw.cursor !== "string") fail("query.invalid-input");
  const preflight = preflightFilters(raw, options);
  const output: Record<string, unknown> = { limit, maxSelectedBytes }; let directSupplied = false;
  for (const [field, [kind]] of Object.entries(REF_FILTERS)) if (Object.hasOwn(preflight, field)) { directSupplied = true; output[field] = normalizeRefs(preflight[field]!, kind); }
  for (const field of Object.keys(STRING_FILTERS)) if (Object.hasOwn(preflight, field)) output[field] = normalizeStrings(preflight[field]! as readonly string[]);
  if (Object.hasOwn(raw, "minimumConfidence")) { if (typeof raw.minimumConfidence !== "number" || !Number.isFinite(raw.minimumConfidence) || raw.minimumConfidence < 0 || raw.minimumConfidence > 1) fail("query.invalid-input"); output.minimumConfidence = raw.minimumConfidence; }
  const normalizedNonCursor = Object.freeze(output); bumpQuery(diagnostics, "normalizedQueryCanonicalizations");
  let canonical: string; try { canonical = canonicalJson(normalizedNonCursor); } catch { return fail("query.invalid-input"); }
  const canonicalBytes = Buffer.byteLength(canonical, "utf8"); if (canonicalBytes > options.maxFilterBytes) fail("query.filter-too-large");
  return Object.freeze({ ...normalizedNonCursor, cursor: raw.cursor ?? null, directSupplied, canonical, canonicalBytes, hash: sha256Hex(canonical) }) as unknown as NormalizedQuery;
}
/** Raw filter bytes are the canonical JSON object containing only supplied filter collections, accounted without materializing that string. */
function preflightFilters(raw: Readonly<Record<string, unknown>>, options: NormalizedOptions): PreflightFilters {
  let total = 0;
  for (const field of FILTER_FIELDS) if (Object.hasOwn(raw, field)) {
    const value = raw[field]; if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("query.invalid-input");
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value; if (!Number.isSafeInteger(length) || length < 0) fail("query.invalid-input");
    total = add(total, length, "query.filter-too-large"); if (total > options.maxFilterValues) fail("query.filter-too-large");
    const keys = Reflect.ownKeys(value); if (keys.length !== length + 1 || !keys.includes("length")) fail("query.invalid-input");
  }
  const descriptorSnapshots: Record<string, readonly unknown[]> = {};
  for (const field of FILTER_FIELDS) if (Object.hasOwn(raw, field)) {
    const value = raw[field] as unknown[]; const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number; const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("query.invalid-input");
      const ref = REF_FILTERS[field];
      if (ref !== undefined && !utilTypes.isProxy(descriptor.value) && isPlain(descriptor.value)) { const nestedKeys = Reflect.ownKeys(descriptor.value); if (nestedKeys.length !== 2 || !nestedKeys.includes(ref[1]) || !nestedKeys.includes("revision")) fail("query.invalid-input"); }
      snapshot.push(descriptor.value);
    }
    descriptorSnapshots[field] = Object.freeze(snapshot);
  }
  const output: Record<string, readonly PreflightFilterValue[]> = {};
  for (const field of FILTER_FIELDS) if (Object.hasOwn(descriptorSnapshots, field)) {
    const preparedValues: PreflightFilterValue[] = []; const ref = REF_FILTERS[field];
    for (const value of descriptorSnapshots[field]!) {
      let prepared: PreflightFilterValue;
      if (ref !== undefined) prepared = preflightReference(value, ref[1], ref[2]);
      else { const allowed = STRING_FILTERS[field]; if (typeof value !== "string" || (allowed instanceof RegExp ? !allowed.test(value) : allowed !== null && !allowed.includes(value))) fail("query.invalid-input"); prepared = value; }
      preparedValues.push(prepared);
    }
    output[field] = Object.freeze(preparedValues);
  }
  let rawBytes = 2; let fieldCount = 0;
  for (const field of FILTER_FIELDS) if (Object.hasOwn(output, field)) {
    rawBytes = boundedFilterBytes(rawBytes, (fieldCount === 0 ? 0 : 1) + canonicalStringBytes(field) + 3, options.maxFilterBytes); fieldCount += 1;
    const ref = REF_FILTERS[field]; let valueCount = 0;
    for (const value of output[field]!) { rawBytes = boundedFilterBytes(rawBytes, (valueCount === 0 ? 0 : 1) + preflightValueBytes(value, ref?.[1], options.maxFilterBytes), options.maxFilterBytes); valueCount += 1; }
  }
  return Object.freeze(output);
}
function preflightReference(value: unknown, idField: string, pattern: RegExp): PreflightReference {
  if (utilTypes.isProxy(value) || !isPlain(value)) fail("query.reference-invalid"); const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes(idField) || !keys.includes("revision")) fail("query.invalid-input");
  const id = dataValue(value, idField, "query.reference-invalid"); const revision = dataValue(value, "revision", "query.reference-invalid");
  if (typeof id !== "string" || !pattern.test(id) || !Number.isSafeInteger(revision) || (revision as number) < 1) fail("query.reference-invalid");
  return Object.freeze({ id, revision: revision as number });
}
function preflightValueBytes(value: PreflightFilterValue, idField: string | undefined, maximum: number): number {
  if (typeof value === "string") return canonicalStringBytes(value, maximum);
  return 5 + canonicalStringBytes(idField!, maximum) + canonicalStringBytes(value.id, maximum) + canonicalStringBytes("revision", maximum) + String(value.revision).length;
}
function canonicalStringBytes(value: string, maximum = Number.MAX_SAFE_INTEGER): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes = add(bytes, 2, "query.filter-too-large");
    else if (code <= 0x1f) bytes = add(bytes, 6, "query.filter-too-large");
    else if (code <= 0x7f) bytes = add(bytes, 1, "query.filter-too-large");
    else if (code <= 0x7ff) bytes = add(bytes, 2, "query.filter-too-large");
    else if (code >= 0xd800 && code <= 0xdbff) { const low = value.charCodeAt(index + 1); if (!(low >= 0xdc00 && low <= 0xdfff)) fail("query.invalid-input"); bytes = add(bytes, 4, "query.filter-too-large"); index += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) fail("query.invalid-input");
    else bytes = add(bytes, 3, "query.filter-too-large");
    if (bytes > maximum) fail("query.filter-too-large");
  }
  return bytes;
}
function boundedFilterBytes(current: number, amount: number, maximum: number): number { const next = add(current, amount, "query.filter-too-large"); if (next > maximum) fail("query.filter-too-large"); return next; }
function normalizeRefs(values: readonly PreflightFilterValue[], kind: PrimaryKind): readonly SnapshotRecordKey[] {
  const unique = new Map<string, SnapshotRecordKey>();
  for (const item of values as readonly PreflightReference[]) unique.set(`${item.id}\0${item.revision}`, Object.freeze({ kind, id: item.id, revision: item.revision }));
  return Object.freeze([...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : (a.revision as number) - (b.revision as number)));
}
function normalizeStrings(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort()); }

function directCandidates(query: NormalizedQuery, indexes: ValidatedSnapshotIndexes, ownersByKey: ReadonlyMap<string, readonly string[]>): Primary[] {
  const output = new Map<string, Primary>();
  for (const field of ["sourceRefs", "claimRefs", "evidenceRefs", "verificationRefs"] as const) for (const key of query[field] ?? []) {
    const record = indexes.getExactRecord(key); if (!record) fail("query.unresolved-ref"); const item = primaryFor(key.kind as PrimaryKind, record as Primary["record"], indexes, ownersByKey); output.set(encodedKey(key), item);
  }
  return [...output.values()];
}
function buildOwnerIndex(snapshot: BoundedValidatedEvidenceSnapshot, diagnostics?: EvidenceQueryDiagnostics): ReadonlyMap<string, readonly string[]> {
  const output = new Map<string, readonly string[]>(); const requests = new Map<string, RequestRecord>();
  for (const request of snapshot.records.requests) { bumpQuery(diagnostics, "indexVisits"); requests.set(request.requestId, request); }
  for (const record of snapshot.records.sources) { bumpQuery(diagnostics, "indexVisits"); output.set(encodedKey({ kind: "sources", id: record.sourceId, revision: record.revision }), Object.freeze([...new Set(record.retrievalRequestIds.flatMap((id) => requests.get(id)?.attemptId ?? []))].sort())); }
  for (const record of snapshot.records.claims) { bumpQuery(diagnostics, "indexVisits"); output.set(encodedKey({ kind: "claims", id: record.claimId, revision: record.revision }), Object.freeze([record.createdByAttemptId])); }
  for (const record of snapshot.records.evidence) { bumpQuery(diagnostics, "indexVisits"); output.set(encodedKey({ kind: "evidence", id: record.evidenceId, revision: record.revision }), Object.freeze([record.recordedByAttemptId])); }
  for (const record of snapshot.records.verifications) { bumpQuery(diagnostics, "indexVisits"); output.set(encodedKey({ kind: "verifications", id: record.verificationId, revision: record.revision }), Object.freeze([record.attemptId])); }
  return output;
}
function buildReversePrimaryIndex(values: readonly Primary[], indexes: ValidatedSnapshotIndexes, metadata: Metadata, diagnostics?: EvidenceQueryDiagnostics): ReversePrimaryIndex {
  const byKey = new Map<string, Primary>(); const fields: Record<string, Map<string, Set<string>>> = {};
  const addValue = (field: string, value: string, key: string): void => { const index = fields[field] ?? new Map<string, Set<string>>(); fields[field] = index; const keys = index.get(value) ?? new Set<string>(); keys.add(key); index.set(value, keys); };
  for (const item of values) {
    bumpQuery(diagnostics, "indexVisits");
    const key = encodedKey(item.key); byKey.set(key, item); const evidence = item.record as EvidenceRecord;
    addValue("stances", evidence.stance, key); addValue("qualities", evidence.quality, key); addValue("verificationStatuses", evidence.verificationStatus, key);
    for (const attemptId of item.owners) { addValue("attemptIds", attemptId, key); const taskId = metadata.attemptTask.get(attemptId); if (taskId !== undefined) { addValue("taskIds", taskId, key); const role = metadata.taskRole.get(taskId); if (role !== undefined) addValue("roles", role, key); } }
    if (evidence.sourceRef !== null) {
      const source = indexes.getExactRecord({ kind: "sources", id: String(evidence.sourceRef.sourceId), revision: Number(evidence.sourceRef.revision) }) as SourceRecord | undefined;
      if (source) { addValue("accessLevels", source.accessLevel, key); if (source.lineage.studyId !== null) addValue("lineageIds", source.lineage.studyId, key); for (const id of source.lineage.cohortIds) addValue("lineageIds", id, key); for (const id of source.lineage.datasetIds) addValue("lineageIds", id, key); }
    }
  }
  return Object.freeze({ byKey, fields });
}
function indexedEvidenceCandidates(query: NormalizedQuery, universe: readonly Primary[], reverse: ReversePrimaryIndex): Primary[] {
  const classes = ["taskIds", "roles", "attemptIds", "stances", "qualities", "lineageIds", "accessLevels", "verificationStatuses"] as const;
  let smallest: Set<string> | undefined;
  for (const field of classes) if (query[field] !== undefined) {
    const union = new Set<string>(); for (const value of query[field]!) for (const key of reverse.fields[field]?.get(value) ?? []) union.add(key);
    if (smallest === undefined || union.size < smallest.size) smallest = union;
  }
  return smallest === undefined ? [...universe] : [...smallest].map((key) => reverse.byKey.get(key)!).filter(Boolean);
}
function primaryFor(kind: PrimaryKind, record: Primary["record"], indexes: ValidatedSnapshotIndexes, ownersByKey: ReadonlyMap<string, readonly string[]>): Primary {
  const id = stableId(kind, record); const revision = record.revision; const key = Object.freeze({ kind, id, revision });
  const canonical = indexes.getCanonicalRecordString(key); if (canonical === undefined) fail("query.unresolved-ref");
  return Object.freeze({ kind, key, record, canonical, owners: ownersByKey.get(encodedKey(key)) ?? Object.freeze([]) });
}
function matches(item: Primary, query: NormalizedQuery, metadata: Metadata, indexes: ValidatedSnapshotIndexes): boolean {
  const evidence = item.kind === "evidence" ? item.record as EvidenceRecord : null; const source = item.kind === "sources" ? item.record as SourceRecord
    : evidence?.sourceRef ? (indexes.getExactRecord({ kind: "sources", id: String(evidence.sourceRef.sourceId), revision: Number(evidence.sourceRef.revision) }) as SourceRecord | undefined) ?? null : null;
  if (query.stances !== undefined && (evidence === null || !query.stances.includes(evidence.stance))) return false;
  if (query.qualities !== undefined && (evidence === null || !query.qualities.includes(evidence.quality))) return false;
  if (query.verificationStatuses !== undefined && (evidence === null || !query.verificationStatuses.includes(evidence.verificationStatus))) return false;
  if (query.minimumConfidence !== undefined && !((item.kind === "claims" || item.kind === "evidence") && (item.record as ClaimRecord | EvidenceRecord).confidence >= query.minimumConfidence)) return false;
  if (query.accessLevels !== undefined && (source === null || !query.accessLevels.includes(source.accessLevel))) return false;
  if (query.lineageIds !== undefined && (source === null || !query.lineageIds.some((id) => source.lineage.studyId === id || source.lineage.cohortIds.includes(id) || source.lineage.datasetIds.includes(id)))) return false;
  if (query.attemptIds !== undefined && !item.owners.some((id) => query.attemptIds!.includes(id))) return false;
  if (query.taskIds?.length === 0 || query.roles?.length === 0) return false;
  if ((query.taskIds?.length ?? 0) > 0 || (query.roles?.length ?? 0) > 0) {
    if (!metadata.supplied || item.owners.length === 0) fail("query.metadata-required");
    const tasks = item.owners.map((id) => metadata.attemptTask.get(id)).filter((id): id is string => id !== undefined);
    if (tasks.length === 0) fail("query.metadata-required");
    if (query.taskIds !== undefined && !tasks.some((id) => query.taskIds!.includes(id))) return false;
    if (query.roles !== undefined && !tasks.some((id) => query.roles!.includes(metadata.taskRole.get(id)!))) return false;
  }
  return true;
}

function preflightPrimaryPage(values: readonly Primary[], options: NormalizedOptions): void {
  if (values.length > options.maxPrimaryPageRecords) fail("query.result-too-large");
  let bytes = 2; for (let index = 0; index < values.length; index += 1) { bytes = add(bytes, Buffer.byteLength(values[index]!.canonical, "utf8") + (index === 0 ? 0 : 1), "query.result-too-large"); if (bytes > options.maxPrimaryPageBytes) fail("query.result-too-large"); }
}
function createClosure(indexes: ValidatedSnapshotIndexes, options: NormalizedOptions, byteMaximum: number, diagnostics?: EvidenceQueryDiagnostics) {
  const selected = new Map<string, { key: SnapshotRecordKey; record: AnyRecord; canonical: string }>();
  const counts: Record<SnapshotRecordKind, number> = { sources: 0, claims: 0, evidence: 0, verifications: 0, requests: 0, calculations: 0 };
  let bytes = Buffer.byteLength(selectionCanonical([]), "utf8"); let edges = 0;
  if (bytes > byteMaximum) fail("query.closure-too-large");
  const rollback = (added: string[], oldBytes: number, oldEdges: number): void => { for (const encoded of added) { const item = selected.get(encoded)!; counts[item.key.kind] -= 1; selected.delete(encoded); } bytes = oldBytes; edges = oldEdges; };
  const tryAdd = (seed: SnapshotRecordKey): boolean => {
    const oldBytes = bytes; const oldEdges = edges; const added: string[] = []; const queue = [seed];
    try {
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
        const key = queue[queueIndex]!; const encoded = encodedKey(key); if (selected.has(encoded)) continue;
        bumpQuery(diagnostics, "closureVisits");
        const record = indexes.getExactRecord(key); const canonical = indexes.getCanonicalRecordString(key); if (!record || canonical === undefined) fail("query.unresolved-ref");
        const refs = indexes.getOutgoingReferences(key); const nextEdges = add(edges, refs.length, "query.closure-too-large");
        const nextKind = add(counts[key.kind], 1, "query.closure-too-large"); const nextTotal = add(selected.size, 1, "query.closure-too-large");
        const recordBytes = Buffer.byteLength(canonical, "utf8"); const nextBytes = add(bytes, recordBytes + (counts[key.kind] === 0 ? 0 : 1), "query.closure-too-large");
        if (nextEdges > options.maxClosureEdges || nextKind > options.maxSelectedPerKind[key.kind] || nextTotal > options.maxTotalSelectedRecords || nextBytes > byteMaximum) fail("query.closure-too-large");
        edges = nextEdges; counts[key.kind] = nextKind; bytes = nextBytes; selected.set(encoded, { key, record, canonical }); added.push(encoded);
        for (const ref of refs) if (!selected.has(encodedKey(ref))) queue.push(ref);
      }
      const wrapper = selectionCanonical([...selected.values()]); if (Buffer.byteLength(wrapper, "utf8") !== bytes) fail("query.invalid-input");
      return true;
    } catch (error) { rollback(added, oldBytes, oldEdges); if (error instanceof EvidenceQueryError && error.code === "query.closure-too-large") return false; throw error; }
  };
  const selection = (truncated: boolean, nextCursor: string | null): EvidenceSelection => {
    const ordered = orderSelected([...selected.values()]); const canonical = selectionCanonical(ordered);
    const clone = <T>(value: { canonical: string }): T => deepFreeze(JSON.parse(value.canonical)) as T;
    return deepFreeze({
      sources: ordered.sources.map(clone<SourceRecord>), claims: ordered.claims.map(clone<ClaimRecord>), evidence: ordered.evidence.map(clone<EvidenceRecord>),
      verifications: ordered.verifications.map(clone<VerificationRecord>), requests: ordered.requests.map(clone<RequestRecord>), calculations: ordered.calculations.map(clone<CalculationRecord>),
      selectedRecordBundleSha256: sha256Hex(canonical), truncated, nextCursor,
    });
  };
  return Object.freeze({ tryAdd, selection });
}
function orderSelected(values: Array<{ key: SnapshotRecordKey; record: AnyRecord; canonical: string }>): Record<SnapshotRecordKind, Array<{ key: SnapshotRecordKey; record: AnyRecord; canonical: string }>> {
  const output = { sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] } as Record<SnapshotRecordKind, Array<{ key: SnapshotRecordKey; record: AnyRecord; canonical: string }>>;
  for (const value of values) output[value.key.kind].push(value);
  for (const kind of KINDS) output[kind].sort((a, b) => a.key.id < b.key.id ? -1 : a.key.id > b.key.id ? 1 : (a.key.revision ?? 0) - (b.key.revision ?? 0));
  return output;
}
function selectionCanonical(values: Array<{ key: SnapshotRecordKey; record: AnyRecord; canonical: string }> | Record<SnapshotRecordKind, Array<{ key: SnapshotRecordKey; record: AnyRecord; canonical: string }>>): string {
  const ordered = Array.isArray(values) ? orderSelected(values) : values;
  return `{${["calculations", "claims", "evidence", "requests", "sources", "verifications"].map((kind) => `${canonicalJson(kind)}:[${ordered[kind as SnapshotRecordKind].map(({ canonical }) => canonical).join(",")}]`).join(",")}}`;
}

function encodeCursor(snapshotHash: string, queryHash: string, position: readonly [number, string, number], maximum: number): string {
  const body = { version: 1 as const, snapshotHash, queryHash, position }; const checksum = sha256Hex(canonicalJson(body));
  const encoded = Buffer.from(canonicalJson({ ...body, checksum }), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > maximum) fail("query.cursor-invalid");
  return encoded;
}
function decodeCursor(value: unknown, options: NormalizedOptions, snapshotHash: string, queryHash: string): readonly [number, string, number] {
  if (typeof value !== "string") fail("query.cursor-invalid");
  if (value.length > options.maxCursorBytes) fail("query.cursor-invalid");
  if (Buffer.byteLength(value, "utf8") > options.maxCursorBytes) fail("query.cursor-invalid");
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail("query.cursor-invalid");
  let text: string; try { const bytes = Buffer.from(value, "base64url"); if (bytes.length > options.maxCursorBytes || bytes.toString("base64url") !== value) fail("query.cursor-invalid"); text = bytes.toString("utf8"); } catch { return fail("query.cursor-invalid"); }
  let parsed: unknown; try { parsed = JSON.parse(text); if (canonicalJson(parsed) !== text) fail("query.cursor-invalid"); } catch { return fail("query.cursor-invalid"); }
  if (!isPlain(parsed) || Reflect.ownKeys(parsed).length !== 5 || !["version", "snapshotHash", "queryHash", "position", "checksum"].every((key) => Reflect.ownKeys(parsed).includes(key))) fail("query.cursor-invalid");
  const payload = parsed as Record<string, unknown>; if (payload.version !== 1 || typeof payload.snapshotHash !== "string" || typeof payload.queryHash !== "string" || typeof payload.checksum !== "string"
    || !Array.isArray(payload.position) || payload.position.length !== 3 || !Number.isInteger(payload.position[0]) || (payload.position[0] as number) < 0 || (payload.position[0] as number) > 3
    || typeof payload.position[1] !== "string" || !Number.isSafeInteger(payload.position[2]) || (payload.position[2] as number) < 1) fail("query.cursor-invalid");
  const rank = payload.position[0] as number; const id = payload.position[1] as string;
  const pattern = rank === 0 ? ID_PATTERNS.source : rank === 1 ? ID_PATTERNS.claim : rank === 2 ? ID_PATTERNS.evidence : ID_PATTERNS.verification;
  if (!pattern.test(id)) fail("query.cursor-invalid");
  const body = { version: 1, snapshotHash: payload.snapshotHash, queryHash: payload.queryHash, position: payload.position };
  if (!/^[a-f0-9]{64}$/u.test(payload.checksum) || sha256Hex(canonicalJson(body)) !== payload.checksum) fail("query.cursor-invalid");
  if (payload.snapshotHash !== snapshotHash || payload.queryHash !== queryHash) fail("query.cursor-mismatch");
  return Object.freeze([payload.position[0], payload.position[1], payload.position[2]]) as readonly [number, string, number];
}

function comparePrimary(a: Primary, b: Primary): number { return compareTuple(tupleFor(a), tupleFor(b)); }
function tupleFor(value: Primary): readonly [number, string, number] { return Object.freeze([RANK[value.kind], value.key.id, value.key.revision ?? 0]); }
function compareTuple(a: readonly [number, string, number], b: readonly [number, string, number]): number { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2]); }
function stableId(kind: SnapshotRecordKind, record: AnyRecord): string { return kind === "sources" ? (record as SourceRecord).sourceId : kind === "claims" ? (record as ClaimRecord).claimId : kind === "evidence" ? (record as EvidenceRecord).evidenceId : kind === "verifications" ? (record as VerificationRecord).verificationId : kind === "requests" ? (record as RequestRecord).requestId : (record as CalculationRecord).calculationId; }
function encodedKey(key: SnapshotRecordKey): string { return `${key.kind}\0${key.id}\0${key.revision ?? 0}`; }
function safeArray(input: unknown, maximum: number, countCode: EvidenceQueryErrorCode, shapeCode = countCode): readonly unknown[] { if (utilTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(shapeCode); const length = Object.getOwnPropertyDescriptor(input, "length")?.value; if (!Number.isSafeInteger(length) || length < 0) fail(shapeCode); if (length > maximum) fail(countCode); const keys = Reflect.ownKeys(input); if (keys.length !== length + 1 || !keys.includes("length")) fail(shapeCode); const output: unknown[] = []; for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(shapeCode); output.push(descriptor.value); } return Object.freeze(output); }
function dataValue(input: object, key: string, code: EvidenceQueryErrorCode): unknown { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(code); return descriptor.value; }
function optionalDataValue(input: object, key: string, code: EvidenceQueryErrorCode): { present: boolean; value?: unknown } { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor) return { present: false }; if (!descriptor.enumerable || !("value" in descriptor)) fail(code); return { present: true, value: descriptor.value }; }
function pairSort(a: readonly [string, unknown], b: readonly [string, unknown]): number { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }
function validateQueryDiagnostics(value: unknown): asserts value is EvidenceQueryDiagnostics {
  const keys = ["indexVisits", "candidateVisits", "closureVisits", "normalizedQueryCanonicalizations"];
  if (utilTypes.isProxy(value) || !isPlain(value)) fail("query.invalid-options"); const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) fail("query.invalid-options");
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.writable) fail("query.invalid-options"); const current = descriptor.value; if (!Number.isSafeInteger(current) || current < 0) fail("query.invalid-options"); }
}
function bumpQuery(value: EvidenceQueryDiagnostics | undefined, key: keyof EvidenceQueryDiagnostics): void { if (value) value[key] = add(value[key], 1, "query.input-too-large"); }
function add(a: number, b: number, code: EvidenceQueryErrorCode): number { const value = a + b; if (!Number.isSafeInteger(value)) fail(code); return value; }
function isPlain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }
function mapSnapshotBuildFailure(error: unknown): never {
  if (error instanceof EvidenceSnapshotBuildFailureInternal) fail(error.code === "snapshot.source-identity-invalid" ? "query.identity-invalid" : "query.lineage-invalid");
  if (!(error instanceof EvidenceAdmissionError)) fail("query.invalid-evidence-set");
  if (error.code === "evidence.invalid-options") fail("query.invalid-options");
  if (error.code === "evidence.record-too-large") fail("query.record-too-large");
  if (["evidence.input-too-large", "evidence.too-many-records", "evidence.too-many-references"].includes(error.code)) fail("query.input-too-large");
  if (error.code === "evidence.unresolved-ref") fail("query.unresolved-ref");
  if (["evidence.duplicate-source-identity", "evidence.ambiguous-source-identity", "evidence.source-url-policy-invalid", "evidence.source-url-unattributed", "evidence.source-url-request-mismatch", "evidence.source-url-metadata-mismatch"].includes(error.code)) fail("query.identity-invalid");
  if (error.code === "evidence.snapshot-invalid") fail("query.invalid-input");
  fail("query.invalid-evidence-set");
}
function fail(code: EvidenceQueryErrorCode): never { throw new EvidenceQueryError(code); }
