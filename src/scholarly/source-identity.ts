import { isIP } from "node:net";
import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { RequestRecordSchema, type RequestRecord } from "../domain/events.js";
import { SourceRecordSchema, type SourceRecord } from "../domain/research-records.js";
import { parse } from "../domain/schema.js";
import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import {
  ScholarlyIdentifierError,
  canonicalDoiUrl,
  canonicalPmcidUrl,
  canonicalPmidUrl,
  normalizeCanonicalUrl,
  prepareProspectiveSourceIdentityFields,
  validatePreparedSourceIdentityFieldsInternal,
  type ScholarlyIdentifierKind,
  type SourceUrlPolicyContext,
} from "./identifiers.js";

export type SourceIdentityErrorCode =
  | "source.invalid-options"
  | "source.invalid-input"
  | "source.too-many-records"
  | "source.too-many-provenance-steps"
  | "source.record-too-large"
  | "source.input-too-large"
  | "source.duplicate-revision"
  | "source.revision-gap"
  | "source.invalid-provenance"
  | "source.invalid-lineage"
  | "source.url-policy-invalid"
  | "source.url-unattributed"
  | "source.url-request-mismatch"
  | "source.url-metadata-mismatch"
  | "source.provenance-index-mismatch";

export class SourceIdentityError extends Error {
  readonly code: SourceIdentityErrorCode;
  constructor(code: SourceIdentityErrorCode) {
    super(`Source identity rejected (${code})`);
    this.name = "SourceIdentityError";
    this.code = code;
  }
}

export type SourceIdentityKey = `doi:${string}` | `pmid:${string}` | `pmcid:${string}` | `url:${string}`;

export interface SourceMergeConflict {
  readonly code: "source.ambiguous-identity" | "source.metadata-conflict" | "source.identifier-conflict" | "source.lineage-conflict";
  readonly field: string;
  readonly sourceIds: readonly string[];
  readonly canonicalValueHashes: readonly string[];
}
export interface SourceMergeResult {
  readonly sources: readonly SourceRecord[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly conflicts: readonly SourceMergeConflict[];
  readonly changedSourceRefs: readonly { sourceId: string; revision: number }[];
}
export type SourceUrlProvenance = Readonly<
  | { kind: "identifier-resolver"; identifierKind: ScholarlyIdentifierKind }
  | { kind: "transport-url"; requestId: string; matchedField: "finalUrl" | "requestedUrl" | "redirectUrls" }
  | { kind: "provider-metadata"; requestId: string; provider: RequestRecord["provider"] }
>;
export interface RequestProvenanceIndex {
  readonly sourceCount: number;
  readonly requestCount: number;
  readonly witnessCount: number;
  readonly optionsSha256: string;
  readonly policySha256: string;
}
export interface RequestProvenanceDiagnostics {
  sourceVisits: number;
  requestVisits: number;
  requestUrlVisits: number;
  metadataStepVisits: number;
  witnessInsertions: number;
}
export interface SourceIdentityOptions {
  readonly maxSources?: number;
  readonly maxRequests?: number;
  readonly maxProvenanceSteps?: number;
  readonly maxCanonicalScalarBytes?: number;
  readonly maxSourceRecordCanonicalBytes?: number;
  readonly maxRequestRecordCanonicalBytes?: number;
  readonly maxAggregateCanonicalBytes?: number;
  readonly sourceUrlPolicy?: SourceUrlPolicyContext;
}

const LIMITS = Object.freeze({
  maxSources: [10_000, 100_000], maxRequests: [100_000, 500_000], maxProvenanceSteps: [100_000, 1_000_000],
  maxCanonicalScalarBytes: [4_096, 16_384], maxSourceRecordCanonicalBytes: [262_144, 1_048_576],
  maxRequestRecordCanonicalBytes: [262_144, 1_048_576], maxAggregateCanonicalBytes: [16_777_216, 67_108_864],
} as const);
const OPTION_KEYS = Object.freeze([...Object.keys(LIMITS), "sourceUrlPolicy"]);
const PROVENANCE_FIELDS = new Set([
  "canonicalUrl", "title", "authors", "containerTitle", "publisher", "volume", "issue", "pages", "published",
  "publicationType", "peerReviewStatus", "accessLevel", "published.date", "identifiers.doi", "identifiers.pmid", "identifiers.pmcid",
  "lineage.studyId", "lineage.cohortIds", "lineage.datasetIds",
]);
const ACCESS_ORDER = ["metadata-only", "abstract-only", "partial-text", "full-text"] as const;
const indexState = new WeakMap<object, ProvenanceState>();
const validatedSourceRecordsState = new WeakMap<readonly SourceRecord[], ProvenanceState>();
const snapshotSourceProvenanceState = new WeakMap<object, Readonly<{ index: RequestProvenanceIndex; provenance: SourceProvenance }>>();
const evidenceSnapshotDuplicateRequestErrors = new WeakSet<object>();
const evidenceSnapshotSemanticErrors = new WeakSet<object>();
/** @internal Read-only package lookup; never exported from the package root. */
export interface ValidatedSourceRecordsInternal {
  readonly sources: readonly SourceRecord[];
  readonly requests: readonly RequestRecord[];
  readonly sourceCanonicalJson: readonly string[];
  readonly requestCanonicalJson: readonly string[];
  readonly maxSourceRecordCanonicalBytes: number;
  readonly maxAggregateCanonicalBytes: number;
  readonly optionsSha256: string;
  readonly policySha256: string;
}
/** @internal Prepared Task 2 source snapshot for dependent validators. */
export interface PreparedProspectiveSourceSemantics {
  readonly record: SourceRecord;
  readonly canonicalJson: string;
  readonly canonicalBytes: number;
}

interface NormalizedOptions {
  readonly maxSources: number; readonly maxRequests: number; readonly maxProvenanceSteps: number;
  readonly maxCanonicalScalarBytes: number; readonly maxSourceRecordCanonicalBytes: number;
  readonly maxRequestRecordCanonicalBytes: number; readonly maxAggregateCanonicalBytes: number;
  readonly sourceUrlPolicy: SourceUrlPolicyContext | undefined;
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly policySha256: string;
  readonly optionsSha256: string;
  readonly allowHttp: boolean;
  readonly approvedHttpHosts: readonly string[];
  readonly accessPolicySha256: string | null;
}
interface ValidatedSource { readonly record: SourceRecord; readonly json: string; readonly bytes: number; readonly hash: string }
interface ValidatedRequest { readonly record: RequestRecord; readonly json: string; readonly bytes: number }
interface IndexedRequest extends ValidatedRequest { readonly urls: readonly RequestUrl[]; readonly resultSourceIds: ReadonlySet<string> }
interface RequestUrl { readonly field: "finalUrl" | "requestedUrl" | "redirectUrls"; readonly url: string; readonly redirectIndex: number }
interface Witness { readonly value: SourceUrlProvenance; readonly key: string }
interface SourceProvenance { readonly witnesses: readonly Witness[]; readonly failure: SourceIdentityErrorCode }
interface ProvenanceState {
  readonly sources: readonly SourceRecord[]; readonly requests: readonly RequestRecord[];
  readonly sourceCanonicalJson: readonly string[]; readonly requestCanonicalJson: readonly string[];
  readonly sourceByHash: ReadonlyMap<string, SourceProvenance>;
  readonly maxSourceRecordCanonicalBytes: number;
  readonly maxCanonicalScalarBytes: number;
  readonly sourceUrlPolicy: SourceUrlPolicyContext | undefined;
  readonly maxAggregateCanonicalBytes: number;
  readonly optionsSha256: string;
  readonly policySha256: string;
}

export function validateProspectiveSourceSemantics(source: SourceRecord, options?: SourceIdentityOptions): SourceRecord {
  return prepareProspectiveSourceSemanticsInternal(source, options).record;
}

/** @internal Validates Task 2 semantics while retaining Task 1 canonical bytes. */
export function prepareProspectiveSourceSemanticsInternal(
  source: SourceRecord, options?: SourceIdentityOptions, consumer?: "lineage",
): PreparedProspectiveSourceSemantics {
  const prepared = prepareProspectiveSourceCanonicalInternal(source, options);
  return validatePreparedSourceSemanticsInternal(prepared, consumer);
}

/** @internal Canonicalizes once so aggregate bounds can precede semantic array reads. */
export function prepareProspectiveSourceCanonicalInternal(
  source: SourceRecord, options?: SourceIdentityOptions,
): PreparedProspectiveSourceSemantics {
  const normalized = normalizeOptions(options);
  const validated = validateSource(source, normalized);
  return Object.freeze({
    record: validated.record, canonicalJson: validated.json, canonicalBytes: validated.bytes,
  });
}

/** @internal Applies Task 2 source semantics to an already prepared source. */
export function validatePreparedSourceSemanticsInternal(
  prepared: PreparedProspectiveSourceSemantics, consumer?: "lineage",
): PreparedProspectiveSourceSemantics {
  validateSourceSemantics(prepared.record, consumer === "lineage");
  return prepared;
}

export function sourceIdentityKeys(source: SourceRecord, options?: SourceIdentityOptions): readonly SourceIdentityKey[] {
  const normalized = normalizeOptions(options);
  const record = validateSource(source, normalized).record;
  validateSourceSemantics(record);
  const keys: SourceIdentityKey[] = [];
  if (record.identifiers.doi !== null) keys.push(`doi:${record.identifiers.doi}`);
  if (record.identifiers.pmid !== null) keys.push(`pmid:${record.identifiers.pmid}`);
  if (record.identifiers.pmcid !== null) keys.push(`pmcid:${record.identifiers.pmcid}`);
  keys.push(`url:${record.canonicalUrl}`);
  return Object.freeze(keys);
}

/** Package-internal option-only validation for Task 4 before any record access. */
export function validateSourceIdentityOptionsForEvidenceSnapshotInternal(options: SourceIdentityOptions): void {
  normalizeOptions(options, 200_000, 2_000_000);
}

export function buildRequestProvenanceIndex(
  sources: readonly SourceRecord[], requests: readonly RequestRecord[], options?: SourceIdentityOptions,
  diagnostics?: RequestProvenanceDiagnostics,
): RequestProvenanceIndex {
  return buildRequestProvenanceIndexInternal(sources, requests, options, diagnostics, "sources");
}

export interface PreparedProvenanceRecordsForEvidenceSnapshotInternal {
  readonly sources: readonly SourceRecord[];
  readonly requests: readonly RequestRecord[];
  readonly sourceCanonicalJson: readonly string[];
  readonly requestCanonicalJson: readonly string[];
}
/**
 * Package-internal Task 4 seam. The callback runs after bounded canonical preparation and before
 * semantic validation or index allocation; callback failure publishes no provenance state.
 */
export function buildRequestProvenanceIndexForEvidenceSnapshotInternal(
  sources: readonly SourceRecord[], requests: readonly RequestRecord[], options: SourceIdentityOptions,
  diagnostics?: RequestProvenanceDiagnostics,
  beforeSemantic?: (prepared: PreparedProvenanceRecordsForEvidenceSnapshotInternal) => void,
): RequestProvenanceIndex {
  return buildRequestProvenanceIndexInternal(sources, requests, options, diagnostics, "sources", 200_000, 2_000_000, beforeSemantic);
}

function buildRequestProvenanceIndexInternal(
  sources: readonly SourceRecord[], requests: readonly RequestRecord[], options: SourceIdentityOptions | undefined,
  diagnostics: RequestProvenanceDiagnostics | undefined, aggregateShape: "source" | "sources",
  maxSourcesHard = 100_000,
  maxProvenanceStepsHard = 1_000_000,
  beforeSemantic?: (prepared: PreparedProvenanceRecordsForEvidenceSnapshotInternal) => void,
): RequestProvenanceIndex {
  const normalized = normalizeOptions(options, maxSourcesHard, maxProvenanceStepsHard);
  validateDiagnostics(diagnostics);
  const sourceInputs = safeArray(sources, normalized.maxSources, "source.too-many-records");
  const requestInputs = safeArray(requests, normalized.maxRequests, "source.too-many-records");
  const validatedSources: ValidatedSource[] = [];
  let cumulativeRecordBytes = 0;
  for (const source of sourceInputs) {
    bumpDiagnostics(diagnostics, "sourceVisits");
    const validated = beforeSemantic
      ? validateSourceStructureForEvidenceSnapshot(source as SourceRecord, normalized)
      : validateSource(source as SourceRecord, normalized);
    cumulativeRecordBytes = accumulateRecordBytes(cumulativeRecordBytes, validated.bytes, normalized);
    validatedSources.push(validated);
  }
  const validatedRequests: ValidatedRequest[] = [];
  for (const request of requestInputs) {
    bumpDiagnostics(diagnostics, "requestVisits");
    const validated = validateRequest(request, normalized);
    cumulativeRecordBytes = accumulateRecordBytes(cumulativeRecordBytes, validated.bytes, normalized);
    validatedRequests.push(validated);
  }
  if (aggregateShape === "source") {
    if (validatedSources.length !== 1) fail("source.invalid-input");
    assertSingleSourceAggregate(validatedSources[0]!, validatedRequests, normalized);
  } else assertAggregateWrapper(["requests", "sources"], [validatedRequests, validatedSources], normalized);
  if (beforeSemantic) beforeSemantic(Object.freeze({
    sources: Object.freeze(validatedSources.map(({ record }) => record)),
    requests: Object.freeze(validatedRequests.map(({ record }) => record)),
    sourceCanonicalJson: Object.freeze(validatedSources.map(({ json }) => json)),
    requestCanonicalJson: Object.freeze(validatedRequests.map(({ json }) => json)),
  }));
  let steps = 0;
  for (const { record } of validatedSources) {
    steps = checkedAdd(steps, record.retrievalRequestIds.length);
    steps = checkedAdd(steps, record.metadataProvenance.length);
  }
  for (const { record } of validatedRequests) {
    steps = checkedAdd(steps, record.resultSourceIds.length);
    steps = checkedAdd(steps, (record.requestedUrl === null ? 0 : 1) + (record.finalUrl === null ? 0 : 1) + record.redirectUrls.length);
  }
  if (steps > normalized.maxProvenanceSteps) fail("source.too-many-provenance-steps");
  if (beforeSemantic) for (const { record } of validatedSources) {
    try { validatePreparedSourceIdentityFieldsInternal(record, normalized.sourceUrlPolicy, normalized.maxCanonicalScalarBytes); }
    catch (error) { if (error instanceof ScholarlyIdentifierError) translateIdentifierErrorForEvidenceSnapshot(error); return fail("source.invalid-input"); }
  }
  for (const { record } of validatedSources) validateSourceSemantics(record);
  const sourceChains = revisionChains(validatedSources, true);
  const orderedSources = [...sourceChains.values()].flat();
  const orderedRequests = sortByCodeUnitKey(validatedRequests, ({ record }) => record.requestId);
  const indexedRequests = orderedRequests.map((request) => indexRequestUrls(request, normalized, diagnostics));

  const requestsById = new Map<string, IndexedRequest>();
  for (const request of indexedRequests) {
    if (requestsById.has(request.record.requestId)) {
      if (beforeSemantic) failEvidenceSnapshotDuplicateRequest();
      fail("source.invalid-input");
    }
    requestsById.set(request.record.requestId, request);
  }
  const sourceByHash = new Map<string, SourceProvenance>();
  let witnessCount = 0;
  for (const source of orderedSources) {
    const provenance = provenanceForSource(source.record, requestsById, normalized, diagnostics);
    witnessCount = checkedAdd(witnessCount, provenance.witnesses.length);
    sourceByHash.set(source.hash, provenance);
  }
  const state: ProvenanceState = Object.freeze({
    sources: Object.freeze(orderedSources.map(({ record }) => record)),
    requests: Object.freeze(indexedRequests.map(({ record }) => record)),
    sourceCanonicalJson: Object.freeze(orderedSources.map(({ json }) => json)),
    requestCanonicalJson: Object.freeze(orderedRequests.map(({ json }) => json)),
    sourceByHash,
    maxSourceRecordCanonicalBytes: normalized.maxSourceRecordCanonicalBytes,
    maxCanonicalScalarBytes: normalized.maxCanonicalScalarBytes,
    sourceUrlPolicy: normalized.allowHttp ? Object.freeze({
      allowHttp: true,
      approvedHttpHosts: normalized.approvedHttpHosts,
      accessPolicySha256: normalized.accessPolicySha256!,
      maxApprovedHttpHosts: normalized.approvedHttpHosts.length,
    }) : undefined,
    maxAggregateCanonicalBytes: normalized.maxAggregateCanonicalBytes,
    optionsSha256: normalized.optionsSha256,
    policySha256: normalized.policySha256,
  });
  const view = Object.freeze({
    sourceCount: validatedSources.length, requestCount: validatedRequests.length, witnessCount,
    optionsSha256: normalized.optionsSha256, policySha256: normalized.policySha256,
  });
  indexState.set(view, state);
  validatedSourceRecordsState.set(state.sources, state);
  for (const source of orderedSources) {
    const provenance = sourceByHash.get(source.hash)!;
    snapshotSourceProvenanceState.set(source.record, Object.freeze({ index: view, provenance }));
  }
  return view;
}

export function validatedProvenanceRecordsForSnapshot(index: RequestProvenanceIndex): Readonly<{
  sources: readonly SourceRecord[];
  requests: readonly RequestRecord[];
  sourceCanonicalJson: readonly string[];
  requestCanonicalJson: readonly string[];
}> {
  const state = indexState.get(index as object);
  if (!state) fail("source.provenance-index-mismatch");
  return Object.freeze({
    sources: state.sources,
    requests: state.requests,
    sourceCanonicalJson: state.sourceCanonicalJson,
    requestCanonicalJson: state.requestCanonicalJson,
  });
}

/** @internal Brand-checks the exact aligned arrays issued by Task 2. */
export function getValidatedSourceRecordsInternal(
  sources: readonly SourceRecord[], sourceCanonicalJson: readonly string[],
): ValidatedSourceRecordsInternal {
  const state = validatedSourceRecordsState.get(sources);
  if (!state || state.sourceCanonicalJson !== sourceCanonicalJson) fail("source.provenance-index-mismatch");
  return Object.freeze({
    sources: state.sources,
    requests: state.requests,
    sourceCanonicalJson: state.sourceCanonicalJson,
    requestCanonicalJson: state.requestCanonicalJson,
    maxSourceRecordCanonicalBytes: state.maxSourceRecordCanonicalBytes,
    maxAggregateCanonicalBytes: state.maxAggregateCanonicalBytes,
    optionsSha256: state.optionsSha256,
    policySha256: state.policySha256,
  });
}

/** Package-internal closed translation guards for Task 4 snapshot construction. */
export function isEvidenceSnapshotDuplicateRequestError(error: unknown): boolean {
  return typeof error === "object" && error !== null && evidenceSnapshotDuplicateRequestErrors.has(error);
}
export function isEvidenceSnapshotSourceSemanticError(error: unknown): boolean {
  return typeof error === "object" && error !== null && evidenceSnapshotSemanticErrors.has(error);
}

/** Package-internal cached lookup for exact Task 2-issued source objects. */
export function validateSourceCanonicalUrlProvenanceFromSnapshotInternal(source: SourceRecord, index: RequestProvenanceIndex): SourceUrlProvenance {
  if (!indexState.has(index as object)) fail("source.provenance-index-mismatch");
  const issued = snapshotSourceProvenanceState.get(source as object);
  if (!issued || issued.index !== index) fail("source.provenance-index-mismatch");
  const provenance = issued.provenance;
  if (provenance.witnesses.length === 0) fail(provenance.failure ?? "source.provenance-index-mismatch");
  return provenance.witnesses[0]!.value;
}

export function validateSourceCanonicalUrlProvenance(source: SourceRecord, index: RequestProvenanceIndex): SourceUrlProvenance {
  const state = indexState.get(index as object);
  if (!state) fail("source.provenance-index-mismatch");
  if (utilTypes.isProxy(source)) fail("source.invalid-input");
  let prepared: ReturnType<typeof prepareProspectiveSourceIdentityFields>;
  try {
    prepared = prepareProspectiveSourceIdentityFields(source, state.sourceUrlPolicy, {
      maxCanonicalScalarBytes: state.maxCanonicalScalarBytes,
      maxSourceRecordCanonicalBytes: state.maxSourceRecordCanonicalBytes,
    });
  } catch { return fail("source.provenance-index-mismatch"); }
  return selectProvenance(state, sha256Hex(prepared.canonicalJson));
}

export function validateSourceCanonicalUrlProvenanceOnce(
  source: SourceRecord, requests: readonly RequestRecord[], options?: SourceIdentityOptions,
  diagnostics?: RequestProvenanceDiagnostics,
): SourceUrlProvenance {
  const index = buildRequestProvenanceIndexInternal([source], requests, options, diagnostics, "source");
  const state = indexState.get(index as object);
  if (!state || state.sourceCanonicalJson.length !== 1) fail("source.provenance-index-mismatch");
  return selectProvenance(state, sha256Hex(state.sourceCanonicalJson[0]!));
}

function selectProvenance(state: ProvenanceState, sourceHash: string): SourceUrlProvenance {
  const provenance = state.sourceByHash.get(sourceHash);
  if (!provenance || provenance.witnesses.length === 0) fail(provenance?.failure ?? "source.provenance-index-mismatch");
  return deepFreeze(JSON.parse(canonicalJson(provenance.witnesses[0]!.value)) as SourceUrlProvenance);
}

export function mergeSourceRecords(
  existing: readonly SourceRecord[], incoming: readonly SourceRecord[], options?: SourceIdentityOptions,
): SourceMergeResult {
  const normalized = normalizeOptions(options);
  const existingInputs = safeArray(existing, normalized.maxSources, "source.too-many-records");
  const incomingInputs = safeArray(incoming, normalized.maxSources, "source.too-many-records");
  if (checkedAdd(existingInputs.length, incomingInputs.length) > normalized.maxSources) fail("source.too-many-records");
  const existingRecords: ValidatedSource[] = [];
  const incomingRecords: ValidatedSource[] = [];
  let cumulativeRecordBytes = 0;
  for (const record of existingInputs) {
    const validated = validateSource(record as SourceRecord, normalized);
    cumulativeRecordBytes = accumulateRecordBytes(cumulativeRecordBytes, validated.bytes, normalized);
    existingRecords.push(validated);
  }
  for (const record of incomingInputs) {
    const validated = validateSource(record as SourceRecord, normalized);
    cumulativeRecordBytes = accumulateRecordBytes(cumulativeRecordBytes, validated.bytes, normalized);
    incomingRecords.push(validated);
  }
  assertAggregateWrapper(["existing", "incoming"], [existingRecords, incomingRecords], normalized);
  for (const { record } of [...existingRecords, ...incomingRecords]) validateSourceSemantics(record);
  return mergeValidated(existingRecords, incomingRecords);
}

function validateSourceStructureForEvidenceSnapshot(source: SourceRecord, options: NormalizedOptions): ValidatedSource {
  if (utilTypes.isProxy(source)) fail("source.invalid-input");
  let json: string;
  try {
    assertBoundedStructure(source, {
      maxDepth: 64, maxNodes: 100_000, maxKeys: 100_000, maxArrayLength: 100_000,
      maxStringBytes: options.maxSourceRecordCanonicalBytes, maxScalarBytes: options.maxSourceRecordCanonicalBytes,
    });
    json = canonicalJson(source);
  } catch (error) {
    if (error instanceof StructuralLimitError && error.reason === "limit") fail("source.record-too-large");
    return fail("source.invalid-input");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > options.maxSourceRecordCanonicalBytes) fail("source.record-too-large");
  const parsed = parse(SourceRecordSchema, JSON.parse(json));
  if (!parsed.success) fail("source.invalid-input");
  const record = deepFreeze(parsed.value);
  return Object.freeze({ record, json, bytes, hash: sha256Hex(json) });
}

function validateSource(source: SourceRecord, options: NormalizedOptions): ValidatedSource {
  if (utilTypes.isProxy(source)) fail("source.invalid-input");
  try {
    assertBoundedStructure(source, {
      maxDepth: 64, maxNodes: 100_000, maxKeys: 100_000, maxArrayLength: 100_000,
      maxStringBytes: options.maxSourceRecordCanonicalBytes, maxScalarBytes: options.maxSourceRecordCanonicalBytes,
    });
  } catch (error) {
    if (error instanceof StructuralLimitError && error.reason === "limit") fail("source.record-too-large");
    return fail("source.invalid-input");
  }
  let prepared: ReturnType<typeof prepareProspectiveSourceIdentityFields>;
  try {
    prepared = prepareProspectiveSourceIdentityFields(source, options.sourceUrlPolicy, {
      maxCanonicalScalarBytes: options.maxCanonicalScalarBytes,
      maxSourceRecordCanonicalBytes: options.maxSourceRecordCanonicalBytes,
    });
  } catch (error) {
    if (error instanceof ScholarlyIdentifierError) return translateIdentifierError(error);
    return fail("source.invalid-input");
  }
  const { record, canonicalJson: json, canonicalBytes: bytes } = prepared;
  if (bytes > options.maxSourceRecordCanonicalBytes) fail("source.record-too-large");
  assertAggregateBytes(bytes, options);
  const stepCount = checkedAdd(record.retrievalRequestIds.length, record.metadataProvenance.length);
  if (stepCount > options.maxProvenanceSteps) fail("source.too-many-provenance-steps");
  return Object.freeze({ record, json, bytes, hash: sha256Hex(json) });
}

function validateSourceSemantics(record: SourceRecord, deferRelationDuplicates = false): void {
  if (record.lineage.relatedSourceIds.length !== record.lineage.relationTypes.length) fail("source.invalid-lineage");
  assertUnique(record.retrievalRequestIds, "source.invalid-provenance");
  const retrieval = new Set(record.retrievalRequestIds);
  const provenanceKeys = record.metadataProvenance.map((step) => `${step.field}\0${step.provider}\0${step.requestId}`);
  assertUnique(provenanceKeys, "source.invalid-provenance");
  for (const step of record.metadataProvenance) {
    if (!PROVENANCE_FIELDS.has(step.field) || !retrieval.has(step.requestId)) fail("source.invalid-provenance");
  }
  assertUnique(record.authors.map((value) => [value.family, value.given, value.literal, value.orcid]
    .map((part) => part === null ? "N" : `S${part.length}:${part}`).join("\0")), "source.invalid-provenance");
  assertUnique(record.lineage.cohortIds, "source.invalid-lineage");
  assertUnique(record.lineage.datasetIds, "source.invalid-lineage");
  if (!deferRelationDuplicates) {
    const relationPairs = record.lineage.relatedSourceIds.map((id, index) => `${id}\0${record.lineage.relationTypes[index]}`);
    assertUnique(relationPairs, "source.invalid-lineage");
  }
}

function validateRequest(input: unknown, options: NormalizedOptions): ValidatedRequest {
  if (utilTypes.isProxy(input)) fail("source.invalid-input");
  let json: string;
  try {
    assertBoundedStructure(input, {
      maxDepth: 64, maxNodes: 1_000_000, maxKeys: 1_000_000, maxArrayLength: 1_000_000,
      maxStringBytes: options.maxRequestRecordCanonicalBytes, maxScalarBytes: options.maxRequestRecordCanonicalBytes,
    });
    json = canonicalJson(input);
  } catch (error) {
    if (error instanceof StructuralLimitError && error.reason === "limit") fail("source.record-too-large");
    return fail("source.invalid-input");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > options.maxRequestRecordCanonicalBytes) fail("source.record-too-large");
  const parsed = parse(RequestRecordSchema, JSON.parse(json));
  if (!parsed.success) fail("source.invalid-input");
  const record = deepFreeze(parsed.value);
  return Object.freeze({ record, json, bytes });
}

function indexRequestUrls(
  request: ValidatedRequest, options: NormalizedOptions, diagnostics?: RequestProvenanceDiagnostics,
): IndexedRequest {
  const urls: RequestUrl[] = [];
  const add = (field: RequestUrl["field"], value: string | null, redirectIndex = -1) => {
    if (value === null) return;
    bumpDiagnostics(diagnostics, "requestUrlVisits");
    try {
      const url = normalizeCanonicalUrl(value, { allowHttp: options.allowHttp, maxCanonicalScalarBytes: options.maxCanonicalScalarBytes });
      if (url.startsWith("http:") && !options.approvedHttpHosts.includes(new URL(url).hostname)) return;
      urls.push(Object.freeze({ field, url, redirectIndex }));
    } catch { /* malformed request URLs are non-witnesses */ }
  };
  add("requestedUrl", request.record.requestedUrl);
  add("finalUrl", request.record.finalUrl);
  request.record.redirectUrls.forEach((url, index) => add("redirectUrls", url, index));
  return Object.freeze({ ...request, urls: Object.freeze(urls), resultSourceIds: new Set(request.record.resultSourceIds) });
}

function provenanceForSource(
  source: SourceRecord, requestsById: ReadonlyMap<string, IndexedRequest>, options: NormalizedOptions,
  diagnostics?: RequestProvenanceDiagnostics,
): SourceProvenance {
  const witnesses: Witness[] = [];
  const addWitness = (value: SourceUrlProvenance, key: string) => {
    bumpDiagnostics(diagnostics, "witnessInsertions");
    witnesses.push(Object.freeze({ value: deepFreeze(value), key }));
  };
  const resolvers: Array<[ScholarlyIdentifierKind, string | null, (value: string, options?: { maxCanonicalScalarBytes?: number }) => string]> = [
    ["doi", source.identifiers.doi, canonicalDoiUrl], ["pmid", source.identifiers.pmid, canonicalPmidUrl],
    ["pmcid", source.identifiers.pmcid, canonicalPmcidUrl],
  ];
  for (const [kind, identifier, derive] of resolvers) {
    if (identifier === null) continue;
    let resolverUrl: string;
    try { resolverUrl = derive(identifier, { maxCanonicalScalarBytes: options.maxCanonicalScalarBytes }); }
    catch (error) {
      if (error instanceof ScholarlyIdentifierError) return translateIdentifierError(error);
      return fail("source.invalid-input");
    }
    if (resolverUrl === source.canonicalUrl)
      addWitness(Object.freeze({ kind: "identifier-resolver", identifierKind: kind }), `0\0${kind}`);
  }
  const retrievalRequestIds = new Set(source.retrievalRequestIds);
  const metadataByRequest = new Map<string, Array<SourceRecord["metadataProvenance"][number]>>();
  for (const step of source.metadataProvenance) {
    bumpDiagnostics(diagnostics, "metadataStepVisits");
    if (step.field !== "canonicalUrl") continue;
    const steps = metadataByRequest.get(step.requestId) ?? [];
    steps.push(step);
    metadataByRequest.set(step.requestId, steps);
  }
  const candidateIds = new Set([...retrievalRequestIds, ...metadataByRequest.keys()]);
  let requestMismatch = false;
  let metadataMismatch = false;
  for (const requestId of candidateIds) {
    const indexed = requestsById.get(requestId);
    if (!indexed) { requestMismatch = true; continue; }
    const request = indexed.record;
    const statusEligible = request.status === "success" || request.status === "partial";
    const linked = retrievalRequestIds.has(requestId) && indexed.resultSourceIds.has(source.sourceId);
    const httpEligible = !source.canonicalUrl.startsWith("http:") || request.accessPolicySha256 === options.accessPolicySha256;
    if (!statusEligible || !linked || !httpEligible) { requestMismatch = true; continue; }
    for (const item of indexed.urls) {
      if (item.url !== source.canonicalUrl) continue;
      const rank = item.field === "finalUrl" ? "0" : item.field === "requestedUrl" ? "1" : "2";
      addWitness(
        Object.freeze({ kind: "transport-url", requestId, matchedField: item.field }),
        `1\0${requestId}\0${rank}\0${item.url}\0${String(item.redirectIndex).padStart(10, "0")}`,
      );
    }
    const requestMetadata = metadataByRequest.get(requestId) ?? [];
    const matchingMetadata = requestMetadata.filter((step) => step.provider === request.provider);
    if (requestMetadata.some((step) => step.provider !== request.provider)) metadataMismatch = true;
    if (requestMetadata.length === 1 && matchingMetadata.length === 1) {
      addWitness(
        Object.freeze({ kind: "provider-metadata", requestId, provider: request.provider }),
        `2\0${requestId}\0${request.provider}\0canonicalUrl\0${request.provider}\0${requestId}`,
      );
    } else if (requestMetadata.length > 0) metadataMismatch = true;
  }
  const sorted = radixSortWitnesses(witnesses);
  const deduplicated: Witness[] = [];
  const seen = new Set<string>();
  for (const witness of sorted) {
    const identity = canonicalJson(witness.value);
    if (!seen.has(identity)) { seen.add(identity); deduplicated.push(witness); }
  }
  return Object.freeze({
    witnesses: Object.freeze(deduplicated),
    failure: requestMismatch ? "source.url-request-mismatch" : metadataMismatch ? "source.url-metadata-mismatch" : "source.url-unattributed",
  });
}

function mergeValidated(existing: readonly ValidatedSource[], incoming: readonly ValidatedSource[]): SourceMergeResult {
  const existingById = revisionChains(existing, true);
  const incomingById = revisionChains(incoming, false);
  for (const [id, records] of incomingById) {
    const prior = existingById.get(id);
    if (prior) {
      if (records.length !== 1 || records[0]!.record.revision !== prior.at(-1)!.record.revision + 1) fail("source.revision-gap");
      assertStableIdentifierHistory(prior, records[0]!.record);
    } else if (records.length !== 1 || records[0]!.record.revision !== 1) fail("source.revision-gap");
  }
  const nodes: MergeNode[] = [];
  for (const [id, records] of existingById) {
    const update = incomingById.get(id)?.[0];
    const authoritativeIdentifiers = effectiveIdentifiers(records);
    nodes.push({
      id,
      current: update ?? records.at(-1)!,
      authoritativeIdentifiers,
      identityIdentifiers: identityIdentifiersForExisting(authoritativeIdentifiers, update?.record),
      identityUrl: records.at(-1)!.record.canonicalUrl,
      existing: true,
      incoming: update !== undefined,
    });
  }
  for (const [id, records] of incomingById) if (!existingById.has(id)) {
    const authoritativeIdentifiers = effectiveIdentifiers(records);
    nodes.push({
      id,
      current: records[0]!,
      authoritativeIdentifiers,
      identityIdentifiers: authoritativeIdentifiers,
      identityUrl: records[0]!.record.canonicalUrl,
      existing: false,
      incoming: true,
    });
  }
  const orderedNodes = sortByCodeUnitKey(nodes, ({ id }) => id);
  nodes.splice(0, nodes.length, ...orderedNodes);
  const union = new UnionFind(nodes.length);
  const strong = new Map<string, number>();
  const urls = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    for (const key of strongKeys(node.identityIdentifiers)) {
      const prior = strong.get(key);
      if (prior === undefined) strong.set(key, index); else union.join(prior, index);
    }
    const list = urls.get(node.identityUrl) ?? [];
    list.push(index); urls.set(node.identityUrl, list);
  });
  const conflicts: SourceMergeConflict[] = [];
  const ambiguous = new Set<number>();
  for (const [url, indexes] of urls) {
    if (indexes.length < 2) continue;
    const hasStrongConflict = (["doi", "pmid", "pmcid"] as const).some((field) => {
      const values = new Set(indexes.map((index) => nodes[index]!.identityIdentifiers[field]).filter((value) => value !== null));
      return values.size > 1;
    });
    if (hasStrongConflict) {
      indexes.forEach((index) => ambiguous.add(index));
      conflicts.push(conflict("source.ambiguous-identity", "canonicalUrl", indexes.map((index) => nodes[index]!.current.record), [url]));
    } else for (let index = 1; index < indexes.length; index += 1) union.join(indexes[0]!, indexes[index]!);
  }
  const components = new Map<number, number[]>();
  nodes.forEach((_, index) => { const root = union.find(index); const list = components.get(root) ?? []; list.push(index); components.set(root, list); });
  for (const indexes of components.values()) {
    const existingIds = new Set(indexes.filter((index) => nodes[index]!.existing).map((index) => nodes[index]!.id));
    if (existingIds.size > 1) {
      indexes.forEach((index) => ambiguous.add(index));
      conflicts.push(conflict("source.ambiguous-identity", "identity", indexes.map((index) => nodes[index]!.current.record), [...existingIds]));
    }
  }

  const output = existing.map(({ record }) => record);
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  const changed: Array<{ sourceId: string; revision: number }> = [];
  for (const indexes of components.values()) {
    if (indexes.some((index) => ambiguous.has(index))) {
      if (!indexes.some((index) => nodes[index]!.existing)) {
        for (const index of indexes) { output.push(nodes[index]!.current.record); changed.push(ref(nodes[index]!.current.record)); }
      }
      continue;
    }
    const componentNodes = indexes.map((index) => nodes[index]!);
    const existingNode = componentNodes.find(({ existing }) => existing);
    const retainedId = existingNode?.id ?? componentNodes[0]!.id;
    const baseValidated = existingNode
      ? existingById.get(retainedId)!.at(-1)!
      : componentNodes.find(({ id }) => id === retainedId)!.current;
    const base = baseValidated.record;
    const candidates = sortByCodeUnitKey(componentNodes.map(({ current }) => current),
      ({ record, json }) => `${record.sourceId}\0${json}`).map(({ record }) => record);
    const retainedEffectiveIdentifiers = componentNodes.find(({ id }) => id === retainedId)!.authoritativeIdentifiers;
    const merged = mergeGroup(
      baseValidated, candidates, retainedId, conflicts,
      componentNodes.some(({ incoming }) => incoming) ? retainedEffectiveIdentifiers : undefined,
    );
    for (const node of componentNodes) if (node.id !== retainedId) aliases[node.id] = retainedId;
    if (existingNode) {
      if (!sameSemantic(baseValidated, merged)) {
        const revision = base.revision + 1;
        const updated = deepFreeze({ ...merged, sourceId: retainedId, revision }) as SourceRecord;
        output.push(updated); changed.push(ref(updated));
      }
    } else {
      const created = deepFreeze({ ...merged, sourceId: retainedId, revision: 1 }) as SourceRecord;
      output.push(created); changed.push(ref(created));
    }
  }
  const orderedOutput = [...output].sort(compareSourceRefs);
  const orderedConflicts = sortByCodeUnitKey(conflicts, (value) => `${value.code}\0${value.field}\0${canonicalJson(value)}`);
  const orderedChanged = [...changed].sort(compareSourceRefs);
  const canonicalAliases = Object.fromEntries(sortByCodeUnitKey(Object.entries(aliases), ([sourceId]) => sourceId));
  return deepFreeze({ sources: orderedOutput, aliases: canonicalAliases, conflicts: orderedConflicts, changedSourceRefs: orderedChanged });
}

interface MergeNode {
  readonly id: string;
  readonly current: ValidatedSource;
  readonly authoritativeIdentifiers: SourceRecord["identifiers"];
  readonly identityIdentifiers: SourceRecord["identifiers"];
  readonly identityUrl: string;
  readonly existing: boolean;
  readonly incoming: boolean;
}

function revisionChains(records: readonly ValidatedSource[], existing: boolean): Map<string, ValidatedSource[]> {
  const indexed = new Map<string, Map<number, ValidatedSource>>();
  for (const record of records) {
    const revisions = indexed.get(record.record.sourceId) ?? new Map<number, ValidatedSource>();
    if (revisions.has(record.record.revision)) fail("source.duplicate-revision");
    revisions.set(record.record.revision, record);
    indexed.set(record.record.sourceId, revisions);
  }
  const orderedIds = sortByCodeUnitKey([...indexed.keys()], (value) => value);
  const groups = new Map<string, ValidatedSource[]>();
  for (const sourceId of orderedIds) {
    const revisions = indexed.get(sourceId)!;
    if (!existing) {
      groups.set(sourceId, [...revisions.values()].sort((left, right) => left.record.revision - right.record.revision));
      continue;
    }
    const list: ValidatedSource[] = [];
    const stableIdentifiers: Partial<Record<"doi" | "pmid" | "pmcid", string>> = {};
    for (let revision = 1; revision <= revisions.size; revision += 1) {
      const validated = revisions.get(revision);
      if (!validated) fail("source.revision-gap");
      list.push(validated);
      for (const field of ["doi", "pmid", "pmcid"] as const) {
        const value = validated.record.identifiers[field];
        if (value === null) continue;
        if (stableIdentifiers[field] === undefined) stableIdentifiers[field] = value;
        else if (stableIdentifiers[field] !== value) fail("source.invalid-input");
      }
    }
    groups.set(sourceId, list);
  }
  return groups;
}

function mergeGroup(
  base: ValidatedSource, candidates: readonly SourceRecord[], retainedId: string, conflicts: SourceMergeConflict[],
  retainedIdentifiers?: SourceRecord["identifiers"],
): SourceRecord {
  const merged = JSON.parse(base.json) as SourceRecord;
  merged.sourceId = retainedId;
  if (retainedIdentifiers) merged.identifiers = { ...retainedIdentifiers };
  const authors = canonicalAccumulator(merged.authors);
  const retrievalRequestIds = new Set(merged.retrievalRequestIds);
  const metadataProvenance = canonicalAccumulator(merged.metadataProvenance);
  const cohortIds = new Set(merged.lineage.cohortIds);
  const datasetIds = new Set(merged.lineage.datasetIds);
  const relations = canonicalAccumulator(
    merged.lineage.relatedSourceIds.map((id, index) => ({ id, type: merged.lineage.relationTypes[index]! })),
  );
  const scalarFields = ["canonicalUrl", "title", "containerTitle", "publisher", "volume", "issue", "pages", "publicationType"] as const;
  for (const candidate of candidates) {
    for (const field of ["doi", "pmid", "pmcid"] as const) {
      const current = merged.identifiers[field]; const next = candidate.identifiers[field];
      if (current === null && next !== null && hasProvenance(candidate, `identifiers.${field}`)) merged.identifiers[field] = next;
      else if (current !== null && next !== null && current !== next)
        conflicts.push(conflict("source.identifier-conflict", `identifiers.${field}`, [merged, candidate], [current, next]));
    }
    for (const field of scalarFields) {
      const current = merged[field] as string | null; const next = candidate[field] as string | null;
      if (current === null && next !== null && hasProvenance(candidate, field)) (merged as unknown as Record<string, unknown>)[field] = next;
      else if (current !== null && next !== null && canonicalJson(current) !== canonicalJson(next))
        conflicts.push(conflict("source.metadata-conflict", field, [merged, candidate], [current, next]));
    }
    if (merged.published.date === null && candidate.published.date !== null) {
      if (hasProvenance(candidate, "published") || hasProvenance(candidate, "published.date"))
        merged.published = JSON.parse(canonicalJson(candidate.published)) as SourceRecord["published"];
    } else if (merged.published.date !== null && candidate.published.date !== null
      && canonicalJson(merged.published) !== canonicalJson(candidate.published)) {
      conflicts.push(conflict("source.metadata-conflict", "published", [merged, candidate], [merged.published, candidate.published]));
    }
    if (merged.lineage.studyId === null && candidate.lineage.studyId !== null && hasProvenance(candidate, "lineage.studyId"))
      merged.lineage.studyId = candidate.lineage.studyId;
    else if (merged.lineage.studyId !== null && candidate.lineage.studyId !== null && merged.lineage.studyId !== candidate.lineage.studyId)
      conflicts.push(conflict("source.lineage-conflict", "lineage.studyId", [merged, candidate], [merged.lineage.studyId, candidate.lineage.studyId]));
    addCanonical(authors, candidate.authors);
    for (const requestId of candidate.retrievalRequestIds) retrievalRequestIds.add(requestId);
    addCanonical(metadataProvenance, candidate.metadataProvenance);
    for (const cohortId of candidate.lineage.cohortIds) cohortIds.add(cohortId);
    for (const datasetId of candidate.lineage.datasetIds) datasetIds.add(datasetId);
    addCanonical(relations, candidate.lineage.relatedSourceIds.map((id, index) => ({ id, type: candidate.lineage.relationTypes[index]! })));
    if (candidate.retrievedAt > merged.retrievedAt) merged.retrievedAt = candidate.retrievedAt;
    if (ACCESS_ORDER.indexOf(candidate.accessLevel) > ACCESS_ORDER.indexOf(merged.accessLevel)) merged.accessLevel = candidate.accessLevel;
    if (merged.peerReviewStatus === "unknown" && candidate.peerReviewStatus !== "unknown") merged.peerReviewStatus = candidate.peerReviewStatus;
    else if (merged.peerReviewStatus !== "unknown" && candidate.peerReviewStatus !== "unknown" && merged.peerReviewStatus !== candidate.peerReviewStatus)
      conflicts.push(conflict("source.metadata-conflict", "peerReviewStatus", [merged, candidate], [merged.peerReviewStatus, candidate.peerReviewStatus]));
  }
  merged.authors = sortedCanonicalValues(authors);
  merged.retrievalRequestIds = sortByCodeUnitKey([...retrievalRequestIds], (value) => value);
  merged.metadataProvenance = sortedCanonicalValues(metadataProvenance);
  merged.lineage.cohortIds = sortByCodeUnitKey([...cohortIds], (value) => value);
  merged.lineage.datasetIds = sortByCodeUnitKey([...datasetIds], (value) => value);
  const sortedRelations = sortedCanonicalValues(relations);
  merged.lineage.relatedSourceIds = sortedRelations.map(({ id }) => id);
  merged.lineage.relationTypes = sortedRelations.map(({ type }) => type);
  return merged;
}

function conflict(code: SourceMergeConflict["code"], field: string, records: readonly SourceRecord[], values: readonly unknown[]): SourceMergeConflict {
  return deepFreeze({
    code, field,
    sourceIds: sortByCodeUnitKey([...new Set(records.map(({ sourceId }) => sourceId))], (value) => value),
    canonicalValueHashes: sortByCodeUnitKey([...new Set(values.map((value) => sha256Hex(canonicalJson(value))))], (value) => value),
  });
}
function hasProvenance(record: SourceRecord, field: string): boolean {
  const retrieval = new Set(record.retrievalRequestIds);
  return record.metadataProvenance.some((step) => step.field === field && retrieval.has(step.requestId));
}
function sameSemantic(base: ValidatedSource, candidate: SourceRecord): boolean {
  return base.json === canonicalJson({
    ...candidate, sourceId: base.record.sourceId, revision: base.record.revision,
  });
}
function assertStableIdentifierHistory(history: readonly ValidatedSource[], next: SourceRecord): void {
  for (const field of ["doi", "pmid", "pmcid"] as const) {
    const stable = history.map(({ record }) => record.identifiers[field]).find((value) => value !== null);
    if (stable !== undefined && stable !== null && next.identifiers[field] !== null && next.identifiers[field] !== stable)
      fail("source.invalid-input");
  }
}
function effectiveIdentifiers(records: readonly ValidatedSource[]): SourceRecord["identifiers"] {
  const output: { doi: string | null; pmid: string | null; pmcid: string | null } = { doi: null, pmid: null, pmcid: null };
  for (const { record } of records) for (const field of ["doi", "pmid", "pmcid"] as const)
    if (output[field] === null && record.identifiers[field] !== null) output[field] = record.identifiers[field];
  return Object.freeze(output);
}
function identityIdentifiersForExisting(
  authoritative: SourceRecord["identifiers"], update: SourceRecord | undefined,
): SourceRecord["identifiers"] {
  if (!update) return authoritative;
  const output = { ...authoritative };
  for (const field of ["doi", "pmid", "pmcid"] as const) {
    if (output[field] === null && update.identifiers[field] !== null && hasProvenance(update, `identifiers.${field}`))
      output[field] = update.identifiers[field];
  }
  return Object.freeze(output);
}
function strongKeys(identifiers: SourceRecord["identifiers"]): string[] {
  const keys: string[] = [];
  if (identifiers.doi !== null) keys.push(`doi:${identifiers.doi}`);
  if (identifiers.pmid !== null) keys.push(`pmid:${identifiers.pmid}`);
  if (identifiers.pmcid !== null) keys.push(`pmcid:${identifiers.pmcid}`);
  return keys;
}
function normalizeOptions(input?: SourceIdentityOptions, maxSourcesHard = 100_000, maxProvenanceStepsHard = 1_000_000): NormalizedOptions {
  if (input === undefined) return finishOptions({}, undefined, maxSourcesHard, maxProvenanceStepsHard);
  if (utilTypes.isProxy(input)) fail("source.invalid-options");
  let snapshot: Record<string, unknown>;
  let originalPolicy: SourceUrlPolicyContext | undefined;
  try {
    assertBoundedStructure(input, { maxDepth: 6, maxNodes: 1_000, maxKeys: 1_000, maxArrayLength: 300, maxStringBytes: 1_024, maxScalarBytes: 300_000 });
    const descriptor = Object.getOwnPropertyDescriptor(input, "sourceUrlPolicy");
    originalPolicy = descriptor?.value as SourceUrlPolicyContext | undefined;
    snapshot = JSON.parse(canonicalJson(input)) as Record<string, unknown>;
  } catch { return fail("source.invalid-options"); }
  if (!isPlain(snapshot) || Object.keys(snapshot).some((key) => !OPTION_KEYS.includes(key))) fail("source.invalid-options");
  return finishOptions(snapshot, originalPolicy, maxSourcesHard, maxProvenanceStepsHard);
}
function finishOptions(
  snapshot: Record<string, unknown>, originalPolicy: SourceUrlPolicyContext | undefined,
  maxSourcesHard = 100_000, maxProvenanceStepsHard = 1_000_000,
): NormalizedOptions {
  const values: Record<string, number> = {};
  for (const [key, [fallback, configuredHard]] of Object.entries(LIMITS)) {
    const hard = key === "maxSources" ? maxSourcesHard : key === "maxProvenanceSteps" ? maxProvenanceStepsHard : configuredHard;
    const value = snapshot[key] ?? fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > hard) fail("source.invalid-options");
    values[key] = value as number;
  }
  if (values.maxCanonicalScalarBytes! > values.maxSourceRecordCanonicalBytes!
    || values.maxCanonicalScalarBytes! > values.maxRequestRecordCanonicalBytes!
    || values.maxSourceRecordCanonicalBytes! > values.maxAggregateCanonicalBytes!
    || values.maxRequestRecordCanonicalBytes! > values.maxAggregateCanonicalBytes!) fail("source.invalid-options");
  assertSafeOptionProduct(values.maxSources!, values.maxSourceRecordCanonicalBytes!);
  assertSafeOptionProduct(values.maxRequests!, values.maxRequestRecordCanonicalBytes!);
  assertSafeOptionProduct(values.maxProvenanceSteps!, values.maxCanonicalScalarBytes!);
  const policySnapshot = (snapshot.sourceUrlPolicy ?? {}) as Record<string, unknown>;
  if (!isPlain(policySnapshot)) fail("source.invalid-options");
  const policyKeys = ["allowHttp", "approvedHttpHosts", "accessPolicySha256", "maxApprovedHttpHosts"];
  if (Object.keys(policySnapshot).some((key) => !policyKeys.includes(key))) fail("source.invalid-options");
  const policy = validatePolicyOptions(policySnapshot);
  const normalizedPolicyForHash = policy.allowHttp
    ? { allowHttp: true, approvedHttpHosts: policy.approvedHttpHosts, accessPolicySha256: policy.accessPolicySha256, maxApprovedHttpHosts: policy.maxApprovedHttpHosts }
    : { allowHttp: false };
  const policySha256 = sha256Hex(canonicalJson(normalizedPolicyForHash));
  const normalizedForHash = { ...values, policySha256 };
  return Object.freeze({
    ...values,
    sourceUrlPolicy: originalPolicy,
    policySnapshot: deepFreeze(policySnapshot), policySha256,
    optionsSha256: sha256Hex(canonicalJson(normalizedForHash)),
    allowHttp: policy.allowHttp, approvedHttpHosts: policy.approvedHttpHosts, accessPolicySha256: policy.accessPolicySha256,
  }) as unknown as NormalizedOptions;
}

function assertSafeOptionProduct(left: number, right: number): void {
  if (!Number.isSafeInteger(left * right)) fail("source.invalid-options");
}

function validatePolicyOptions(policy: Record<string, unknown>): {
  allowHttp: boolean; approvedHttpHosts: readonly string[]; accessPolicySha256: string | null; maxApprovedHttpHosts: number;
} {
  const allowHttp = policy.allowHttp ?? false;
  if (typeof allowHttp !== "boolean") fail("source.invalid-options");
  const hasFields = policy.approvedHttpHosts !== undefined || policy.accessPolicySha256 !== undefined || policy.maxApprovedHttpHosts !== undefined;
  if (!allowHttp) {
    if (hasFields) fail("source.invalid-options");
    return { allowHttp: false, approvedHttpHosts: Object.freeze([]), accessPolicySha256: null, maxApprovedHttpHosts: 64 };
  }
  const maxHosts = policy.maxApprovedHttpHosts ?? 64;
  if (!Number.isSafeInteger(maxHosts) || (maxHosts as number) < 1 || (maxHosts as number) > 256) fail("source.invalid-options");
  if (!Array.isArray(policy.approvedHttpHosts) || policy.approvedHttpHosts.length === 0
    || policy.approvedHttpHosts.length > (maxHosts as number)) fail("source.invalid-options");
  if (typeof policy.accessPolicySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(policy.accessPolicySha256)) fail("source.invalid-options");
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const host of policy.approvedHttpHosts) {
    if (typeof host !== "string" || Buffer.byteLength(host, "utf8") > 253 || host !== host.toLowerCase()
      || /[^a-z0-9.-]/u.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")
      || isIP(host) !== 0 || seen.has(host)) fail("source.invalid-options");
    try { if (new URL(`http://${host}/`).hostname !== host) fail("source.invalid-options"); }
    catch (error) { if (error instanceof SourceIdentityError) throw error; return fail("source.invalid-options"); }
    seen.add(host); hosts.push(host);
  }
  const orderedHosts = sortByCodeUnitKey(hosts, (host) => host);
  return {
    allowHttp: true, approvedHttpHosts: Object.freeze(orderedHosts), accessPolicySha256: policy.accessPolicySha256,
    maxApprovedHttpHosts: maxHosts as number,
  };
}

function bumpDiagnostics(
  diagnostics: RequestProvenanceDiagnostics | undefined, key: keyof RequestProvenanceDiagnostics, amount = 1,
): void {
  if (!diagnostics) return;
  diagnostics[key] = checkedAdd(diagnostics[key], amount);
}

function validateDiagnostics(diagnostics: RequestProvenanceDiagnostics | undefined): void {
  if (diagnostics === undefined) return;
  if (utilTypes.isProxy(diagnostics) || !isPlain(diagnostics)) fail("source.invalid-input");
  const keys = ["sourceVisits", "requestVisits", "requestUrlVisits", "metadataStepVisits", "witnessInsertions"];
  if (Reflect.ownKeys(diagnostics).length !== keys.length) fail("source.invalid-input");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(diagnostics, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.writable !== true
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) fail("source.invalid-input");
  }
}

function safeArray(input: unknown, max: number, countCode: SourceIdentityErrorCode): readonly unknown[] {
  if (utilTypes.isProxy(input)) fail("source.invalid-input");
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail("source.invalid-input");
  if (input.length > max) fail(countCode);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)))) fail("source.invalid-input");
  const output: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("source.invalid-input");
    output.push(descriptor.value);
  }
  return output;
}
function accumulateRecordBytes(total: number, bytes: number, options: NormalizedOptions): number {
  const next = checkedAdd(total, bytes);
  if (next > options.maxAggregateCanonicalBytes) fail("source.input-too-large");
  return next;
}
function assertAggregateBytes(bytes: number, options: NormalizedOptions): void {
  if (bytes > options.maxAggregateCanonicalBytes) fail("source.input-too-large");
}
function assertSingleSourceAggregate(
  source: { json: string; bytes: number }, requests: readonly { json: string; bytes: number }[], options: NormalizedOptions,
): void {
  let bytes = 2;
  bytes = checkedAdd(bytes, Buffer.byteLength(canonicalJson("requests"), "utf8"));
  bytes = checkedAdd(bytes, 2);
  for (let index = 0; index < requests.length; index += 1) {
    if (index > 0) bytes = checkedAdd(bytes, 1);
    bytes = checkedAdd(bytes, requests[index]!.bytes);
    if (bytes > options.maxAggregateCanonicalBytes) fail("source.input-too-large");
  }
  bytes = checkedAdd(bytes, 2);
  bytes = checkedAdd(bytes, Buffer.byteLength(canonicalJson("source"), "utf8"));
  bytes = checkedAdd(bytes, 1);
  bytes = checkedAdd(bytes, source.bytes);
  if (bytes > options.maxAggregateCanonicalBytes) fail("source.input-too-large");
  const encoded = `{"requests":[${requests.map(({ json }) => json).join(",")}],"source":${source.json}}`;
  if (Buffer.byteLength(encoded, "utf8") !== bytes) fail("source.input-too-large");
}
function assertAggregateWrapper(
  keys: readonly string[], collections: readonly (readonly { json: string; bytes: number }[])[], options: NormalizedOptions,
): void {
  let bytes = 2;
  for (let group = 0; group < keys.length; group += 1) {
    if (group > 0) bytes = checkedAdd(bytes, 1);
    bytes = checkedAdd(bytes, Buffer.byteLength(canonicalJson(keys[group]!), "utf8"));
    bytes = checkedAdd(bytes, 2);
    const records = collections[group]!;
    for (let index = 0; index < records.length; index += 1) {
      if (index > 0) bytes = checkedAdd(bytes, 1);
      bytes = checkedAdd(bytes, records[index]!.bytes);
      if (bytes > options.maxAggregateCanonicalBytes) fail("source.input-too-large");
    }
    bytes = checkedAdd(bytes, 1);
  }
  if (bytes > options.maxAggregateCanonicalBytes) fail("source.input-too-large");
  const encoded = `{${keys.map((key, index) => `${canonicalJson(key)}:[${collections[index]!.map(({ json }) => json).join(",")}]`).join(",")}}`;
  if (Buffer.byteLength(encoded, "utf8") !== bytes) fail("source.input-too-large");
}
function assertUnique(values: readonly string[], code: SourceIdentityErrorCode): void {
  if (new Set(values).size !== values.length) fail(code);
}
function canonicalAccumulator<T>(values: readonly T[]): Map<string, T> {
  const output = new Map<string, T>();
  addCanonical(output, values);
  return output;
}
function addCanonical<T>(target: Map<string, T>, values: readonly T[]): void {
  for (const value of values) {
    const encoded = canonicalJson(value);
    if (!target.has(encoded)) target.set(encoded, value);
  }
}
function sortedCanonicalValues<T>(values: ReadonlyMap<string, T>): T[] {
  return sortByCodeUnitKey([...values.keys()], (encoded) => encoded).map((encoded) => JSON.parse(encoded) as T);
}
function radixSortWitnesses(values: readonly Witness[]): Witness[] {
  return sortByCodeUnitKey(values, ({ key }) => key);
}
function sortByCodeUnitKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => { const leftKey = key(left); const rightKey = key(right); return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0; });
}
function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(value)) fail("source.input-too-large");
  return value;
}
function ref(record: SourceRecord): { sourceId: string; revision: number } { return Object.freeze({ sourceId: record.sourceId, revision: record.revision }); }
function compareSourceRefs(left: Readonly<{ sourceId: string; revision: number }>, right: Readonly<{ sourceId: string; revision: number }>): number { return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : left.revision - right.revision; }
function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function translateIdentifierErrorForEvidenceSnapshot(error: ScholarlyIdentifierError): never {
  if (error.code === "identifier.invalid-options" || error.code === "url.http-context-invalid") fail("source.invalid-options");
  if (error.code === "identifier.record-too-large") fail("source.record-too-large");
  if (error.code.startsWith("url.")) fail("source.url-policy-invalid");
  const translated = new SourceIdentityError("source.invalid-input"); evidenceSnapshotSemanticErrors.add(translated); throw translated;
}
function translateIdentifierError(error: ScholarlyIdentifierError): never {
  if (error.code === "identifier.invalid-options" || error.code === "url.http-context-invalid") fail("source.invalid-options");
  if (error.code === "identifier.record-too-large") fail("source.record-too-large");
  if (error.code.startsWith("url.")) fail("source.url-policy-invalid");
  return fail("source.invalid-input");
}
function failEvidenceSnapshotDuplicateRequest(): never {
  const error = new SourceIdentityError("source.invalid-input"); evidenceSnapshotDuplicateRequestErrors.add(error); throw error;
}
function fail(code: SourceIdentityErrorCode): never { throw new SourceIdentityError(code); }

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(value: number): number { let root = value; while (this.parent[root] !== root) root = this.parent[root]!; while (this.parent[value] !== value) { const next = this.parent[value]!; this.parent[value] = root; value = next; } return root; }
  join(left: number, right: number): void { const a = this.find(left); const b = this.find(right); if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b); }
}
