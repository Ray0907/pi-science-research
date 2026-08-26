import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { type RequestRecord } from "../domain/events.js";
import {
  CalculationRecordSchema,
  type CalculationRecord,
  type ClaimRecord,
  type EvidenceRecord,
  type ResearchRecord,
  type SourceRecord,
  type VerificationRecord,
} from "../domain/research-records.js";
import { parse } from "../domain/schema.js";
import {
  buildLineageGraphFromValidatedSourcesForEvidenceSnapshotInternal,
  getLineageDependencyComponentCountInternal, LineageError, type LineageGraph,
} from "./lineage.js";
import {
  SourceIdentityError,
  buildRequestProvenanceIndexForEvidenceSnapshotInternal,
  getValidatedSourceRecordsInternal,
  isEvidenceSnapshotDuplicateRequestError,
  validateSourceCanonicalUrlProvenanceFromSnapshotInternal,
  validateSourceIdentityOptionsForEvidenceSnapshotInternal,
  validatedProvenanceRecordsForSnapshot,
  type RequestProvenanceDiagnostics,
  type RequestProvenanceIndex,
} from "../scholarly/source-identity.js";
import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import {
  EvidenceAdmissionError,
  prepareProspectiveEvidenceCanonicalInternal,
  validatePreparedEvidenceSemanticsInternal,
  type PreparedProspectiveEvidenceSemanticsInternal,
  type BoundedValidatedEvidenceSnapshot,
  type CanonicalEvidenceSet,
  type EvidenceSetLimits,
  type EvidenceSnapshotDiagnostics,
  type EvidenceSnapshotOptions,
} from "./admission.js";

export type SnapshotRecordKind = "sources" | "claims" | "evidence" | "verifications" | "requests" | "calculations";
export interface SnapshotRecordKey { readonly kind: SnapshotRecordKind; readonly id: string; readonly revision: number | null }
export interface ValidatedSnapshotIndexes {
  readonly snapshotSha256: string;
  readonly optionsSha256: string;
  readonly policySha256: string;
  readonly requestProvenanceIndex: RequestProvenanceIndex;
  readonly lineageGraph: LineageGraph;
  readonly getExactRecord: (key: SnapshotRecordKey) => ResearchRecord | RequestRecord | undefined;
  readonly getLatestRevision: (kind: "sources" | "claims" | "evidence" | "verifications", id: string) => number | undefined;
  readonly getOutgoingReferences: (key: SnapshotRecordKey) => readonly SnapshotRecordKey[];
  readonly getCanonicalRecordString: (key: SnapshotRecordKey) => string | undefined;
}

interface NormalizedLimits {
  readonly maxPerKind: Readonly<Record<SnapshotRecordKind, number>>;
  readonly maxTotalRecords: number;
  readonly maxReferences: number;
  readonly maxLineageComponents: number;
  readonly maxCanonicalScalarBytes: number;
  readonly maxSourceRecordCanonicalBytes: number;
  readonly maxRequestRecordCanonicalBytes: number;
  readonly maxClaimRecordCanonicalBytes: number;
  readonly maxEvidenceRecordCanonicalBytes: number;
  readonly maxVerificationRecordCanonicalBytes: number;
  readonly maxCalculationRecordCanonicalBytes: number;
  readonly maxCanonicalEvidenceSetBytes: number;
}
interface NormalizedOptions {
  readonly limits: NormalizedLimits;
  readonly sourceUrlPolicy: EvidenceSnapshotOptions["sourceUrlPolicy"];
  readonly view: NonNullable<EvidenceSnapshotOptions["view"]>;
  readonly policySha256: string;
  readonly optionsSha256: string;
}
interface Prepared<T> { readonly record: T; readonly json: string; readonly bytes: number; readonly prospective?: PreparedProspectiveEvidenceSemanticsInternal }
interface InternalSnapshotState {
  readonly open: true;
  readonly snapshotSha256: string;
  readonly optionsSha256: string;
  readonly policySha256: string;
  readonly indexes: ValidatedSnapshotIndexes;
}
const snapshotState = new WeakMap<object, InternalSnapshotState>();

const DEFAULT_PER = { sources: 50_000, claims: 50_000, evidence: 100_000, verifications: 25_000, requests: 100_000, calculations: 25_000 } as const;
const HARD_PER = { sources: 200_000, claims: 200_000, evidence: 500_000, verifications: 100_000, requests: 500_000, calculations: 100_000 } as const;
const LIMIT_DEFAULTS = {
  maxTotalRecords: 300_000, maxReferences: 500_000, maxLineageComponents: 100_000,
  maxCanonicalScalarBytes: 4_096, maxSourceRecordCanonicalBytes: 262_144, maxRequestRecordCanonicalBytes: 262_144,
  maxClaimRecordCanonicalBytes: 524_288, maxEvidenceRecordCanonicalBytes: 524_288,
  maxVerificationRecordCanonicalBytes: 524_288, maxCalculationRecordCanonicalBytes: 524_288,
  maxCanonicalEvidenceSetBytes: 33_554_432,
} as const;
const LIMIT_HARDS = {
  maxTotalRecords: 1_000_000, maxReferences: 2_000_000, maxLineageComponents: 500_000,
  maxCanonicalScalarBytes: 16_384, maxSourceRecordCanonicalBytes: 1_048_576, maxRequestRecordCanonicalBytes: 1_048_576,
  maxClaimRecordCanonicalBytes: 1_048_576, maxEvidenceRecordCanonicalBytes: 1_048_576,
  maxVerificationRecordCanonicalBytes: 1_048_576, maxCalculationRecordCanonicalBytes: 1_048_576,
  maxCanonicalEvidenceSetBytes: 134_217_728,
} as const;
const LIMIT_KEYS = ["maxPerKind", ...Object.keys(LIMIT_DEFAULTS)];
const OPTION_KEYS = ["limits", "sourceUrlPolicy", "view"];
const KIND_ORDER: SnapshotRecordKind[] = ["calculations", "claims", "evidence", "requests", "sources", "verifications"];

export function buildBoundedValidatedEvidenceSnapshotInternal(
  records: CanonicalEvidenceSet,
  options?: EvidenceSnapshotOptions,
  diagnostics?: EvidenceSnapshotDiagnostics,
): BoundedValidatedEvidenceSnapshot {
  let normalized = normalizeOptions(options);
  validateDiagnostics(diagnostics);
  const arrays = snapshotSetArrays(records, normalized.limits);
  const totalRecords = sumCounts(Object.values(arrays).map((value) => value.length), "evidence.too-many-records");
  if (totalRecords > normalized.limits.maxTotalRecords) fail("evidence.too-many-records");

  let claims = prepareEvidenceKind(arrays.claims, "claim", normalized.limits.maxClaimRecordCanonicalBytes, diagnostics) as Prepared<ClaimRecord>[];
  let evidence = prepareEvidenceKind(arrays.evidence, "evidence", normalized.limits.maxEvidenceRecordCanonicalBytes, diagnostics) as Prepared<EvidenceRecord>[];
  let verifications = prepareEvidenceKind(arrays.verifications, "verification", normalized.limits.maxVerificationRecordCanonicalBytes, diagnostics) as Prepared<VerificationRecord>[];
  let calculations = prepareKind(arrays.calculations, CalculationRecordSchema, normalized.limits.maxCalculationRecordCanonicalBytes, diagnostics) as Prepared<CalculationRecord>[];
  let canonicalBytes: number | undefined;
  let preflightReferenceCount: number | undefined;

  const provenanceDiagnostics: RequestProvenanceDiagnostics = {
    sourceVisits: 0, requestVisits: 0, requestUrlVisits: 0, metadataStepVisits: 0, witnessInsertions: 0,
  };
  let requestProvenanceIndex: RequestProvenanceIndex;
  try {
    requestProvenanceIndex = buildRequestProvenanceIndexForEvidenceSnapshotInternal(
      arrays.sources as readonly SourceRecord[], arrays.requests as readonly RequestRecord[],
      {
        maxSources: normalized.limits.maxPerKind.sources,
        maxRequests: normalized.limits.maxPerKind.requests,
        maxProvenanceSteps: normalized.limits.maxReferences,
        maxCanonicalScalarBytes: normalized.limits.maxCanonicalScalarBytes,
        maxSourceRecordCanonicalBytes: normalized.limits.maxSourceRecordCanonicalBytes,
        maxRequestRecordCanonicalBytes: normalized.limits.maxRequestRecordCanonicalBytes,
        maxAggregateCanonicalBytes: Math.min(normalized.limits.maxCanonicalEvidenceSetBytes, 67_108_864),
        ...(normalized.sourceUrlPolicy === undefined ? {} : { sourceUrlPolicy: normalized.sourceUrlPolicy }),
      },
      provenanceDiagnostics,
      (prepared) => {
        const preflightRecords: Record<SnapshotRecordKind, readonly Prepared<unknown>[]> = {
          sources: prepared.sources.map((record, index) => Object.freeze({ record, json: prepared.sourceCanonicalJson[index]!, bytes: Buffer.byteLength(prepared.sourceCanonicalJson[index]!, "utf8") })),
          requests: prepared.requests.map((record, index) => Object.freeze({ record, json: prepared.requestCanonicalJson[index]!, bytes: Buffer.byteLength(prepared.requestCanonicalJson[index]!, "utf8") })),
          claims, evidence, verifications, calculations,
        };
        canonicalBytes = measureCanonicalSet(preflightRecords, normalized.limits.maxCanonicalEvidenceSetBytes);
        preflightReferenceCount = preflightReferences(preflightRecords, normalized.limits.maxReferences);
        preflightLineageComponents(prepared.sources, normalized.limits.maxLineageComponents);
      },
    );
  } catch (error) {
    if (error instanceof EvidenceAdmissionError) throw error;
    if (isEvidenceSnapshotDuplicateRequestError(error)) fail("evidence.duplicate-request");
    return translateSourceError(error);
  }
  bump(diagnostics, "requestRecordsIndexed", provenanceDiagnostics.requestVisits);
  bump(diagnostics, "requestUrlVisits", provenanceDiagnostics.requestUrlVisits);
  bump(diagnostics, "metadataStepVisits", provenanceDiagnostics.metadataStepVisits);
  normalized = Object.freeze({
    ...normalized,
    policySha256: requestProvenanceIndex.policySha256,
    optionsSha256: sha256Hex(canonicalJson({
      limits: normalized.limits, view: normalized.view, policySha256: requestProvenanceIndex.policySha256,
    })),
  });
  const task2Records = validatedProvenanceRecordsForSnapshot(requestProvenanceIndex);
  const task2Internal = getValidatedSourceRecordsInternal(task2Records.sources, task2Records.sourceCanonicalJson);
  bump(diagnostics, "canonicalRecordVisits", task2Records.sources.length + task2Records.requests.length);

  if (canonicalBytes === undefined || preflightReferenceCount === undefined) fail("evidence.invalid-input");
  const preparedByKind: Record<SnapshotRecordKind, readonly Prepared<unknown>[]> = {
    sources: task2Records.sources.map((record, index) => Object.freeze({ record, json: task2Records.sourceCanonicalJson[index]!, bytes: Buffer.byteLength(task2Records.sourceCanonicalJson[index]!, "utf8") })),
    requests: task2Records.requests.map((record, index) => Object.freeze({ record, json: task2Records.requestCanonicalJson[index]!, bytes: Buffer.byteLength(task2Records.requestCanonicalJson[index]!, "utf8") })),
    claims, evidence, verifications, calculations,
  };
  claims = orderPrepared("claims", claims); evidence = orderPrepared("evidence", evidence);
  verifications = orderPrepared("verifications", verifications); calculations = orderPrepared("calculations", calculations);
  preparedByKind.claims = claims; preparedByKind.evidence = evidence;
  preparedByKind.verifications = verifications; preparedByKind.calculations = calculations;
  const canonicalSetString = assembleCanonicalSet(preparedByKind);
  for (const item of [...claims, ...evidence, ...verifications]) {
    if (!item.prospective) fail("evidence.invalid-input");
    validatePreparedEvidenceSemanticsInternal(item.prospective);
  }

  const orderedRecords = Object.freeze({
    sources: task2Records.sources,
    claims: Object.freeze(claims.map(({ record }) => record)),
    evidence: Object.freeze(evidence.map(({ record }) => record)),
    verifications: Object.freeze(verifications.map(({ record }) => record)),
    requests: task2Records.requests,
    calculations: Object.freeze(calculations.map(({ record }) => record)),
  }) as CanonicalEvidenceSet;

  auditSourceIdentities(orderedRecords.sources, diagnostics);
  for (const source of orderedRecords.sources) {
    try { validateSourceCanonicalUrlProvenanceFromSnapshotInternal(source, requestProvenanceIndex); }
    catch (error) { return translateSourceError(error); }
  }
  let lineageGraph: LineageGraph;
  try {
    lineageGraph = buildLineageGraphFromValidatedSourcesForEvidenceSnapshotInternal(task2Records.sources, task2Records.sourceCanonicalJson, {
      maxRevisions: Math.min(normalized.limits.maxPerKind.sources, 500_000),
      maxStableSources: Math.min(normalized.limits.maxPerKind.sources, 200_000),
      maxGraphNodes: Math.min(normalized.limits.maxPerKind.sources * 2, 500_000),
      maxEdges: normalized.limits.maxReferences,
      maxTraversalDepth: 250_000,
      maxSourceRecordCanonicalBytes: normalized.limits.maxSourceRecordCanonicalBytes,
      maxAggregateCanonicalBytes: Math.min(normalized.limits.maxCanonicalEvidenceSetBytes, 67_108_864),
    });
  } catch (error) { return translateLineageError(error); }
  bump(diagnostics, "lineageVisits", orderedRecords.sources.length);
  if (getLineageDependencyComponentCountInternal(lineageGraph) > normalized.limits.maxLineageComponents) fail("evidence.too-many-records");

  const indexes = buildIndexes(orderedRecords, preparedByKind, requestProvenanceIndex, lineageGraph, normalized, diagnostics);
  if (indexes.referenceCount !== preflightReferenceCount) fail("evidence.invalid-input");
  const snapshotSha256 = sha256Hex(canonicalSetString);
  const snapshot = Object.freeze({
    records: orderedRecords,
    recordCount: totalRecords,
    referenceCount: indexes.referenceCount,
    canonicalBytes,
    snapshotSha256,
    optionsSha256: normalized.optionsSha256,
    policySha256: normalized.policySha256,
    view: normalized.view,
    requestProvenanceIndex,
  }) as BoundedValidatedEvidenceSnapshot;
  const publicIndexes = makePublicIndexes(indexes, snapshotSha256, normalized, requestProvenanceIndex, lineageGraph);
  snapshotState.set(snapshot, Object.freeze({
    open: true, snapshotSha256, optionsSha256: normalized.optionsSha256, policySha256: normalized.policySha256, indexes: publicIndexes,
  }));
  return snapshot;
}

export function getValidatedSnapshotIndexes(snapshot: BoundedValidatedEvidenceSnapshot): ValidatedSnapshotIndexes {
  if (utilTypes.isProxy(snapshot) || !Object.isFrozen(snapshot)) fail("evidence.snapshot-invalid");
  const state = snapshotState.get(snapshot as object);
  if (!state || !state.open) fail("evidence.snapshot-invalid");
  if (snapshot.snapshotSha256 !== state.snapshotSha256
    || snapshot.optionsSha256 !== state.optionsSha256
    || snapshot.policySha256 !== state.policySha256) fail("evidence.snapshot-invalid");
  return state.indexes;
}

interface BuiltIndexes {
  exact: Map<string, ResearchRecord | RequestRecord>;
  latest: Map<string, number>;
  outgoing: Map<string, readonly SnapshotRecordKey[]>;
  canonical: Map<string, string>;
  referenceCount: number;
}
function buildIndexes(
  records: CanonicalEvidenceSet,
  preparedByKind: Record<SnapshotRecordKind, readonly Prepared<unknown>[]>,
  requestIndex: RequestProvenanceIndex,
  lineageGraph: LineageGraph,
  options: NormalizedOptions,
  diagnostics?: EvidenceSnapshotDiagnostics,
): BuiltIndexes {
  const exact = new Map<string, ResearchRecord | RequestRecord>();
  const latest = new Map<string, number>();
  const canonical = new Map<string, string>();
  const outgoing = new Map<string, readonly SnapshotRecordKey[]>();
  const revisionKinds = ["sources", "claims", "evidence", "verifications"] as const;
  for (const kind of revisionKinds) {
    const groups = new Map<string, Map<number, ResearchRecord>>();
    for (const item of preparedByKind[kind]) {
      const record = item.record as ResearchRecord;
      const id = stableId(kind, record);
      const revision = (record as { revision: number }).revision;
      const revisions = groups.get(id) ?? new Map<number, ResearchRecord>();
      if (revisions.has(revision)) fail("evidence.duplicate-revision");
      revisions.set(revision, record); groups.set(id, revisions);
      exact.set(recordKey({ kind, id, revision }), record); canonical.set(recordKey({ kind, id, revision }), item.json);
      bump(diagnostics, "revisionIndexInsertions");
    }
    for (const [id, revisions] of groups) {
      for (let revision = 1; revision <= revisions.size; revision += 1) if (!revisions.has(revision)) fail("evidence.revision-gap");
      latest.set(latestKey(kind, id), revisions.size);
      if (kind === "claims") validateClaimIdentity([...revisions.values()] as ClaimRecord[]);
    }
  }
  for (const kind of ["requests", "calculations"] as const) for (const item of preparedByKind[kind]) {
    const record = item.record as RequestRecord | CalculationRecord;
    const id = kind === "requests" ? (record as RequestRecord).requestId : (record as CalculationRecord).calculationId;
    const key = recordKey({ kind, id, revision: null });
    if (exact.has(key)) fail(kind === "requests" ? "evidence.duplicate-request" : "evidence.invalid-input");
    exact.set(key, record); canonical.set(key, item.json); bump(diagnostics, "revisionIndexInsertions");
  }
  let referenceCount = 0;
  for (const kind of Object.keys(records) as SnapshotRecordKind[]) for (const record of records[kind] as readonly any[]) {
    const key = keyForRecord(kind, record);
    const refs = referencesFor(kind, record, latest);
    referenceCount = checkedAdd(referenceCount, refs.length, "evidence.too-many-references");
    if (referenceCount > options.limits.maxReferences) fail("evidence.too-many-references");
    for (const ref of refs) if (!exact.has(recordKey(ref))) fail("evidence.unresolved-ref");
    outgoing.set(recordKey(key), Object.freeze(refs));
    bump(diagnostics, "referenceVisits", refs.length);
  }
  validateSymmetricConflicts(records, latest);
  return { exact, latest, outgoing, canonical, referenceCount };
}
function makePublicIndexes(
  built: BuiltIndexes, snapshotSha256: string, options: NormalizedOptions,
  requestProvenanceIndex: RequestProvenanceIndex, lineageGraph: LineageGraph,
): ValidatedSnapshotIndexes {
  const getExactRecord = (key: SnapshotRecordKey) => built.exact.get(recordKey(validateKey(key)));
  const getLatestRevision = (kind: "sources" | "claims" | "evidence" | "verifications", id: string) => built.latest.get(latestKey(kind, id));
  const getOutgoingReferences = (key: SnapshotRecordKey) => built.outgoing.get(recordKey(validateKey(key))) ?? Object.freeze([]);
  const getCanonicalRecordString = (key: SnapshotRecordKey) => built.canonical.get(recordKey(validateKey(key)));
  return Object.freeze({
    snapshotSha256, optionsSha256: options.optionsSha256, policySha256: options.policySha256,
    requestProvenanceIndex, lineageGraph, getExactRecord, getLatestRevision, getOutgoingReferences, getCanonicalRecordString,
  });
}

function orderPrepared<T>(kind: SnapshotRecordKind, values: readonly Prepared<T>[]): Prepared<T>[] {
  return radixSortByUtf8Key(values, ({ record }) => {
    const id = stableId(kind, record);
    const revision = (record as { revision?: number }).revision;
    return `${id}\0${revision === undefined ? "" : String(revision).padStart(16, "0")}`;
  });
}
function prepareEvidenceKind(
  inputs: readonly unknown[], expected: "claim" | "evidence" | "verification", maxBytes: number,
  diagnostics?: EvidenceSnapshotDiagnostics,
): Prepared<unknown>[] {
  const output: Prepared<unknown>[] = [];
  for (const input of inputs) {
    const prospective = prepareProspectiveEvidenceCanonicalInternal(input, maxBytes, expected);
    output.push(Object.freeze({
      record: prospective.record, json: prospective.canonicalJson, bytes: prospective.canonicalBytes, prospective,
    }));
    bump(diagnostics, "canonicalRecordVisits");
  }
  return output;
}
function prepareKind(inputs: readonly unknown[], schema: any, maxBytes: number, diagnostics?: EvidenceSnapshotDiagnostics): Prepared<unknown>[] {
  const output: Prepared<unknown>[] = [];
  for (const input of inputs) {
    if (utilTypes.isProxy(input)) fail("evidence.invalid-input");
    let json: string;
    try {
      assertBoundedStructure(input, { maxDepth: 64, maxNodes: 1_000_000, maxKeys: 1_000_000, maxArrayLength: 1_000_000, maxStringBytes: maxBytes, maxScalarBytes: maxBytes });
      json = canonicalJson(input);
    } catch (error) {
      if (error instanceof StructuralLimitError && error.reason === "limit") fail("evidence.record-too-large");
      return fail("evidence.invalid-input");
    }
    const bytes = Buffer.byteLength(json, "utf8"); if (bytes > maxBytes) fail("evidence.record-too-large");
    const parsed = parse(schema, JSON.parse(json)); if (!parsed.success) fail("evidence.invalid-input");
    output.push(Object.freeze({ record: deepFreeze(parsed.value), json, bytes })); bump(diagnostics, "canonicalRecordVisits");
  }
  return output;
}
function snapshotSetArrays(records: unknown, limits: NormalizedLimits): Record<SnapshotRecordKind, readonly unknown[]> {
  if (utilTypes.isProxy(records) || !isPlain(records)) fail("evidence.invalid-input");
  const keys = Reflect.ownKeys(records); const expected = ["sources", "claims", "evidence", "verifications", "requests", "calculations"];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) fail("evidence.invalid-input");
  const output = {} as Record<SnapshotRecordKind, readonly unknown[]>;
  for (const kind of expected as SnapshotRecordKind[]) {
    const descriptor = Object.getOwnPropertyDescriptor(records, kind);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("evidence.invalid-input");
    output[kind] = safeArray(descriptor.value, limits.maxPerKind[kind]);
  }
  return output;
}
function safeArray(value: unknown, max: number): readonly unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("evidence.invalid-input");
  if (value.length > max) fail("evidence.too-many-records");
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("evidence.invalid-input"); output.push(descriptor.value);
  }
  return output;
}
function normalizeOptions(input?: EvidenceSnapshotOptions): NormalizedOptions {
  let snapshot: any = {};
  let originalPolicy: EvidenceSnapshotOptions["sourceUrlPolicy"];
  if (input !== undefined) {
    if (utilTypes.isProxy(input)) fail("evidence.invalid-options");
    try { assertBoundedStructure(input, { maxDepth: 8, maxNodes: 2_000, maxKeys: 2_000, maxArrayLength: 300, maxStringBytes: 1_024, maxScalarBytes: 100_000 }); snapshot = JSON.parse(canonicalJson(input)); originalPolicy = Object.getOwnPropertyDescriptor(input, "sourceUrlPolicy")?.value; }
    catch { return fail("evidence.invalid-options"); }
  }
  if (!isPlain(snapshot) || Object.keys(snapshot).some((key) => !OPTION_KEYS.includes(key))) fail("evidence.invalid-options");
  const rawLimits = snapshot.limits ?? {}; if (!isPlain(rawLimits) || Object.keys(rawLimits).some((key) => !LIMIT_KEYS.includes(key))) fail("evidence.invalid-options");
  const rawPer = rawLimits.maxPerKind ?? {}; if (!isPlain(rawPer) || Object.keys(rawPer).some((key) => !(key in DEFAULT_PER))
    || (rawLimits.maxPerKind !== undefined && Object.keys(rawPer).length !== Object.keys(DEFAULT_PER).length)) fail("evidence.invalid-options");
  const per: Record<SnapshotRecordKind, number> = {} as any;
  for (const kind of Object.keys(DEFAULT_PER) as SnapshotRecordKind[]) per[kind] = limit(rawPer[kind], DEFAULT_PER[kind], HARD_PER[kind]);
  const values: any = { maxPerKind: Object.freeze(per) };
  for (const key of Object.keys(LIMIT_DEFAULTS) as Array<keyof typeof LIMIT_DEFAULTS>) values[key] = limit(rawLimits[key], LIMIT_DEFAULTS[key], LIMIT_HARDS[key]);
  if (Object.values(per).some((value) => value > values.maxTotalRecords)
    || values.maxLineageComponents > values.maxTotalRecords
    || values.maxCanonicalScalarBytes > values.maxSourceRecordCanonicalBytes
    || values.maxCanonicalScalarBytes > values.maxRequestRecordCanonicalBytes
    || values.maxSourceRecordCanonicalBytes > values.maxCanonicalEvidenceSetBytes || values.maxRequestRecordCanonicalBytes > values.maxCanonicalEvidenceSetBytes
    || values.maxClaimRecordCanonicalBytes > values.maxCanonicalEvidenceSetBytes || values.maxEvidenceRecordCanonicalBytes > values.maxCanonicalEvidenceSetBytes
    || values.maxVerificationRecordCanonicalBytes > values.maxCanonicalEvidenceSetBytes || values.maxCalculationRecordCanonicalBytes > values.maxCanonicalEvidenceSetBytes)
    fail("evidence.invalid-options");
  const view = snapshot.view ?? { stableIdRevisionSelection: "latest-in-snapshot", verificationRevisionSelection: "latest-applicable-per-target" };
  if (!isPlain(view) || Object.keys(view).length !== 2 || view.stableIdRevisionSelection !== "latest-in-snapshot" || view.verificationRevisionSelection !== "latest-applicable-per-target") fail("evidence.invalid-options");
  const policyForHash = snapshot.sourceUrlPolicy ?? null; const policySha256 = sha256Hex(canonicalJson(policyForHash));
  const frozenLimits = deepFreeze(values) as NormalizedLimits;
  const frozenView = deepFreeze(view) as EvidenceSnapshotOptions["view"] & NonNullable<EvidenceSnapshotOptions["view"]>;
  try {
    validateSourceIdentityOptionsForEvidenceSnapshotInternal({
      maxSources: frozenLimits.maxPerKind.sources, maxRequests: frozenLimits.maxPerKind.requests,
      maxProvenanceSteps: frozenLimits.maxReferences,
      maxCanonicalScalarBytes: frozenLimits.maxCanonicalScalarBytes,
      maxSourceRecordCanonicalBytes: frozenLimits.maxSourceRecordCanonicalBytes,
      maxRequestRecordCanonicalBytes: frozenLimits.maxRequestRecordCanonicalBytes,
      maxAggregateCanonicalBytes: Math.min(frozenLimits.maxCanonicalEvidenceSetBytes, 67_108_864),
      ...(originalPolicy === undefined ? {} : { sourceUrlPolicy: originalPolicy }),
    });
  } catch (error) { return translateSourceError(error); }
  return Object.freeze({ limits: frozenLimits, sourceUrlPolicy: originalPolicy, view: frozenView, policySha256,
    optionsSha256: sha256Hex(canonicalJson({ limits: frozenLimits, view: frozenView, policySha256 })) });
}
function limit(value: unknown, fallback: number, hard: number): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > hard) fail("evidence.invalid-options"); return result as number; }
function preflightReferences(prepared: Record<SnapshotRecordKind, readonly Prepared<unknown>[]>, maximum: number): number {
  let count = 0;
  const add = (amount: number): void => { count = checkedAdd(count, amount, "evidence.too-many-references"); if (count > maximum) fail("evidence.too-many-references"); };
  for (const { record } of prepared.sources as readonly Prepared<SourceRecord>[]) add(
    record.lineage.relatedSourceIds.length + record.retrievalRequestIds.length + record.metadataProvenance.length,
  );
  for (const { record } of prepared.claims as readonly Prepared<ClaimRecord>[]) add(record.evidenceRefs.length + record.conflictClaimIds.length);
  for (const { record } of prepared.evidence as readonly Prepared<EvidenceRecord>[]) add(
    1 + (record.sourceRef === null ? 0 : 1) + (record.calculationId === null ? 0 : 1) + record.conflictsWith.length,
  );
  for (const { record } of prepared.verifications as readonly Prepared<VerificationRecord>[]) add(
    record.checkedClaims.length + record.checkedEvidence.length + record.requestIds.length + record.calculationIds.length
      + record.corrections.length + record.independentEvidenceIds.length,
  );
  for (const { record } of prepared.requests as readonly Prepared<RequestRecord>[]) add(record.resultSourceIds.length);
  return count;
}
function preflightLineageComponents(sources: readonly SourceRecord[], maximum: number): void {
  const ids = radixSortByUtf8Key([...new Set(sources.map(({ sourceId }) => sourceId))], (value) => value);
  const indexById = new Map(ids.map((id, index) => [id, index] as const));
  const parent = ids.map((_, index) => index);
  const find = (value: number): number => { let root = value; while (parent[root] !== root) root = parent[root]!; while (parent[value] !== value) { const next = parent[value]!; parent[value] = root; value = next; } return root; };
  const join = (left: number, right: number): void => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  const latestById = new Map<string, SourceRecord>();
  for (const source of sources) {
    const index = indexById.get(source.sourceId)!;
    for (const target of source.lineage.relatedSourceIds) { const targetIndex = indexById.get(target); if (targetIndex !== undefined) join(index, targetIndex); }
    const prior = latestById.get(source.sourceId); if (!prior || prior.revision < source.revision) latestById.set(source.sourceId, source);
  }
  const metadataOwner = new Map<string, number>();
  for (const source of latestById.values()) {
    const index = indexById.get(source.sourceId)!;
    const tokens = [
      ...(source.lineage.studyId === null || source.lineage.studyId.length === 0 ? [] : [`study:${source.lineage.studyId}`]),
      ...source.lineage.cohortIds.filter((id) => id.length > 0).map((id) => `cohort:${id}`),
      ...source.lineage.datasetIds.filter((id) => id.length > 0).map((id) => `dataset:${id}`),
    ];
    for (const token of tokens) { const owner = metadataOwner.get(token); if (owner === undefined) metadataOwner.set(token, index); else join(owner, index); }
  }
  const roots = new Set<number>();
  for (let index = 0; index < ids.length; index += 1) { roots.add(find(index)); if (roots.size > maximum) fail("evidence.too-many-records"); }
}
function measureCanonicalSet(prepared: Record<SnapshotRecordKind, readonly Prepared<unknown>[]>, maximum: number): number {
  let bytes = 2; // outer braces
  for (let kindIndex = 0; kindIndex < KIND_ORDER.length; kindIndex += 1) {
    const kind = KIND_ORDER[kindIndex]!;
    bytes = checkedAdd(bytes, Buffer.byteLength(canonicalJson(kind), "utf8") + 3, "evidence.input-too-large"); // key, colon, brackets
    if (kindIndex > 0) bytes = checkedAdd(bytes, 1, "evidence.input-too-large");
    const values = prepared[kind];
    for (let index = 0; index < values.length; index += 1) {
      bytes = checkedAdd(bytes, values[index]!.bytes, "evidence.input-too-large");
      if (index > 0) bytes = checkedAdd(bytes, 1, "evidence.input-too-large");
      if (bytes > maximum) fail("evidence.input-too-large");
    }
  }
  if (bytes > maximum) fail("evidence.input-too-large");
  return bytes;
}
function assembleCanonicalSet(prepared: Record<SnapshotRecordKind, readonly Prepared<unknown>[]>): string {
  return `{${KIND_ORDER.map((kind) => `${canonicalJson(kind)}:[${prepared[kind].map(({ json }) => json).join(",")}]`).join(",")}}`;
}
function auditSourceIdentities(sources: readonly SourceRecord[], diagnostics?: EvidenceSnapshotDiagnostics): void {
  const sourceIds = radixSortByUtf8Key([...new Set(sources.map(({ sourceId }) => sourceId))], (value) => value);
  const indexById = new Map(sourceIds.map((id, index) => [id, index] as const));
  const parent = sourceIds.map((_, index) => index);
  const find = (value: number): number => { let root = value; while (parent[root] !== root) root = parent[root]!; while (parent[value] !== value) { const next = parent[value]!; parent[value] = root; value = next; } return root; };
  const join = (left: number, right: number): void => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  const owner = new Map<string, number>(); const keyMembers = new Map<string, Set<string>>();
  for (const source of sources) {
    bump(diagnostics, "sourceIdentityVisits");
    const index = indexById.get(source.sourceId)!; const keys = [`url:${source.canonicalUrl}`];
    for (const field of ["doi", "pmid", "pmcid"] as const) if (source.identifiers[field] !== null) keys.push(`${field}:${source.identifiers[field]}`);
    for (const key of keys) {
      const members = keyMembers.get(key) ?? new Set<string>(); members.add(source.sourceId); keyMembers.set(key, members);
      const prior = owner.get(key); if (prior === undefined) owner.set(key, index); else join(prior, index);
    }
  }
  const idsByRoot = new Map<number, Set<string>>();
  const identifiersByRoot = new Map<number, Record<"doi" | "pmid" | "pmcid", Set<string>>>();
  for (const source of sources) {
    const root = find(indexById.get(source.sourceId)!);
    const ids = idsByRoot.get(root) ?? new Set<string>(); ids.add(source.sourceId); idsByRoot.set(root, ids);
    const values = identifiersByRoot.get(root) ?? { doi: new Set<string>(), pmid: new Set<string>(), pmcid: new Set<string>() };
    for (const field of ["doi", "pmid", "pmcid"] as const) if (source.identifiers[field] !== null) values[field].add(source.identifiers[field]);
    identifiersByRoot.set(root, values);
  }
  const rootsWithCommonKey = new Set<number>();
  for (const members of keyMembers.values()) if (members.size > 1) {
    const first = members.values().next().value as string; const root = find(indexById.get(first)!);
    if (members.size === idsByRoot.get(root)!.size) rootsWithCommonKey.add(root);
  }
  for (const [root, ids] of idsByRoot) if (ids.size > 1) {
    const values = identifiersByRoot.get(root)!;
    if (values.doi.size > 1 || values.pmid.size > 1 || values.pmcid.size > 1 || !rootsWithCommonKey.has(root))
      fail("evidence.ambiguous-source-identity");
    fail("evidence.duplicate-source-identity");
  }
}
function validateClaimIdentity(records: ClaimRecord[]): void {
  const base = records[0]!;
  for (const record of records.slice(1)) if (record.statement !== base.statement || record.kind !== base.kind
    || record.materiality !== base.materiality || record.createdByAttemptId !== base.createdByAttemptId
    || record.scopeQualifiers.population !== base.scopeQualifiers.population
    || record.scopeQualifiers.intervention !== base.scopeQualifiers.intervention
    || record.scopeQualifiers.comparator !== base.scopeQualifiers.comparator
    || record.scopeQualifiers.outcome !== base.scopeQualifiers.outcome
    || record.scopeQualifiers.timeRange !== base.scopeQualifiers.timeRange
    || record.evidenceRule.minimumLineages !== base.evidenceRule.minimumLineages
    || record.evidenceRule.independentVerificationAllowed !== base.evidenceRule.independentVerificationAllowed
    || record.evidenceRule.primarySourceRequired !== base.evidenceRule.primarySourceRequired
    || record.evidenceRule.fullTextRequired !== base.evidenceRule.fullTextRequired) fail("evidence.invalid-prospective-record");
}
function referencesFor(kind: SnapshotRecordKind, record: any, latest: Map<string, number>): SnapshotRecordKey[] {
  const refs: SnapshotRecordKey[] = [];
  const latestRef = (targetKind: "sources" | "claims" | "evidence" | "verifications", id: string) => ({ kind: targetKind, id, revision: latest.get(latestKey(targetKind, id)) ?? -1 });
  if (kind === "sources") { for (const id of record.lineage.relatedSourceIds) refs.push(latestRef("sources", id)); for (const id of record.retrievalRequestIds) refs.push({ kind: "requests", id, revision: null }); for (const step of record.metadataProvenance) refs.push({ kind: "requests", id: step.requestId, revision: null }); }
  if (kind === "claims") { for (const ref of record.evidenceRefs) refs.push({ kind: "evidence", id: ref.evidenceId, revision: ref.revision }); for (const id of record.conflictClaimIds) refs.push(latestRef("claims", id)); }
  if (kind === "evidence") { refs.push({ kind: "claims", id: record.claimRef.claimId, revision: record.claimRef.revision }); if (record.sourceRef) refs.push({ kind: "sources", id: record.sourceRef.sourceId, revision: record.sourceRef.revision }); if (record.calculationId) refs.push({ kind: "calculations", id: record.calculationId, revision: null }); for (const id of record.conflictsWith) refs.push(latestRef("evidence", id)); }
  if (kind === "verifications") { for (const ref of record.checkedClaims) refs.push({ kind: "claims", id: ref.claimId, revision: ref.revision }); for (const ref of record.checkedEvidence) refs.push({ kind: "evidence", id: ref.evidenceId, revision: ref.revision }); for (const id of record.requestIds) refs.push({ kind: "requests", id, revision: null }); for (const id of record.calculationIds) refs.push({ kind: "calculations", id, revision: null }); for (const c of record.corrections) refs.push(latestRef("claims", c.claimId)); for (const id of record.independentEvidenceIds) refs.push(latestRef("evidence", id)); }
  if (kind === "requests") for (const id of record.resultSourceIds) refs.push(latestRef("sources", id));
  return refs;
}
function validateSymmetricConflicts(records: CanonicalEvidenceSet, latest: Map<string, number>): void {
  const latestClaims = new Map(records.claims.filter((r) => latest.get(latestKey("claims", r.claimId)) === r.revision).map((r) => [r.claimId, r]));
  for (const record of latestClaims.values()) for (const id of record.conflictClaimIds) if (!latestClaims.get(id)?.conflictClaimIds.includes(record.claimId)) fail("evidence.asymmetric-conflict");
  const latestEvidence = new Map(records.evidence.filter((r) => latest.get(latestKey("evidence", r.evidenceId)) === r.revision).map((r) => [r.evidenceId, r]));
  for (const record of latestEvidence.values()) for (const id of record.conflictsWith) if (!latestEvidence.get(id)?.conflictsWith.includes(record.evidenceId)) fail("evidence.asymmetric-conflict");
}
function keyForRecord(kind: SnapshotRecordKind, record: any): SnapshotRecordKey { const id = stableId(kind, record); return { kind, id, revision: ["sources", "claims", "evidence", "verifications"].includes(kind) ? record.revision : null }; }
function stableId(kind: SnapshotRecordKind, record: any): string { return kind === "sources" ? record.sourceId : kind === "claims" ? record.claimId : kind === "evidence" ? record.evidenceId : kind === "verifications" ? record.verificationId : kind === "requests" ? record.requestId : record.calculationId; }
function recordKey(key: SnapshotRecordKey): string { return `${key.kind}\0${key.id}\0${key.revision ?? 0}`; }
function latestKey(kind: string, id: string): string { return `${kind}\0${id}`; }
function validateKey(key: SnapshotRecordKey): SnapshotRecordKey { if (utilTypes.isProxy(key) || !isPlain(key) || !["sources", "claims", "evidence", "verifications", "requests", "calculations"].includes(key.kind) || typeof key.id !== "string" || !(key.revision === null || Number.isSafeInteger(key.revision))) fail("evidence.invalid-input"); return key; }
function validateDiagnostics(value?: EvidenceSnapshotDiagnostics): void {
  if (value === undefined) return;
  const keys = ["canonicalRecordVisits", "referenceVisits", "revisionIndexInsertions", "sourceIdentityVisits", "lineageVisits", "requestRecordsIndexed", "requestUrlVisits", "metadataStepVisits"];
  if (utilTypes.isProxy(value) || !isPlain(value) || Reflect.ownKeys(value).length !== keys.length) fail("evidence.invalid-input");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.writable !== true
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) fail("evidence.invalid-input");
  }
}
function bump(value: EvidenceSnapshotDiagnostics | undefined, key: keyof EvidenceSnapshotDiagnostics, amount = 1) { if (value) value[key] = checkedAdd(value[key], amount, "evidence.input-too-large"); }
function translateSourceError(error: unknown): never { if (error instanceof SourceIdentityError) { const map: Partial<Record<string, any>> = { "source.record-too-large": "evidence.record-too-large", "source.input-too-large": "evidence.input-too-large", "source.duplicate-revision": "evidence.duplicate-revision", "source.revision-gap": "evidence.revision-gap", "source.url-policy-invalid": "evidence.source-url-policy-invalid", "source.url-unattributed": "evidence.source-url-unattributed", "source.url-request-mismatch": "evidence.source-url-request-mismatch", "source.url-metadata-mismatch": "evidence.source-url-metadata-mismatch" }; fail(map[error.code] ?? (error.code === "source.invalid-options" ? "evidence.invalid-options" : "evidence.invalid-input")); } return fail("evidence.invalid-input"); }
function translateLineageError(error: unknown): never { if (error instanceof LineageError) { if (error.code === "lineage.record-too-large") fail("evidence.record-too-large"); if (error.code === "lineage.input-too-large" || error.code === "lineage.too-many-edges" || error.code === "lineage.too-many-sources") fail("evidence.input-too-large"); if (error.code === "lineage.duplicate-revision") fail("evidence.duplicate-revision"); if (error.code === "lineage.revision-gap") fail("evidence.revision-gap"); if (error.code === "lineage.unresolved-ref") fail("evidence.unresolved-ref"); if (error.code === "lineage.invalid-options") fail("evidence.invalid-options"); } return fail("evidence.invalid-input"); }
function sumCounts(values: number[], code: any): number { let total = 0; for (const value of values) total = checkedAdd(total, value, code); return total; }
function checkedAdd(left: number, right: number, code: any): number { const result = left + right; if (!Number.isSafeInteger(result)) fail(code); return result; }
function isPlain(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as any)) deepFreeze(child); Object.freeze(value); } return value; }
function radixSortByUtf8Key<T>(values: readonly T[], key: (value: T) => string): T[] {
  const encoded = values.map((value) => ({ value, bytes: Buffer.from(key(value), "utf8") }));
  type Item = (typeof encoded)[number]; type Frame = { items: Item[]; offset: number } | { emit: Item[] };
  const stack: Frame[] = [{ items: encoded, offset: 0 }]; const output: Item[] = [];
  while (stack.length > 0) {
    const frame = stack.pop()!; if ("emit" in frame) { output.push(...frame.emit); continue; }
    if (frame.items.length < 2) { output.push(...frame.items); continue; }
    const buckets: Item[][] = Array.from({ length: 257 }, () => []);
    for (const item of frame.items) buckets[frame.offset >= item.bytes.length ? 0 : item.bytes[frame.offset]! + 1]!.push(item);
    for (let index = 256; index >= 1; index -= 1) if (buckets[index]!.length) stack.push({ items: buckets[index]!, offset: frame.offset + 1 });
    if (buckets[0]!.length) stack.push({ emit: buckets[0]! });
  }
  return output.map(({ value }) => value);
}
function fail(code: any): never { throw new EvidenceAdmissionError(code); }
