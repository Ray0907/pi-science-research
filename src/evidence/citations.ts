import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { ID_PATTERNS } from "../domain/ids.js";
import { parse } from "../domain/schema.js";
import {
  CitationMapRecordSchema, type CitationMapRecord, type ClaimRecord, type EvidenceRecord, type SourceRecord,
} from "../domain/research-records.js";
import {
  EvidenceAdmissionError, buildBoundedValidatedEvidenceSnapshot, type BoundedValidatedEvidenceSnapshot,
  type CanonicalEvidenceSet, type EvidenceSnapshotDiagnostics, type EvidenceSnapshotOptions,
} from "./admission.js";
import {
  SourceIdentityError, validateSourceCanonicalUrlProvenanceFromSnapshotInternal,
} from "../scholarly/source-identity.js";
import { getValidatedSnapshotIndexes, type ValidatedSnapshotIndexes } from "./validated-snapshot-internal.js";

export type CitationErrorCode =
  | "citation.invalid-options"
  | "citation.invalid-input"
  | "citation.evidence-set-too-large"
  | "citation.invalid-evidence-set"
  | "citation.too-many-bindings"
  | "citation.too-many-citations"
  | "citation.too-many-links"
  | "citation.unresolved-ref"
  | "citation.ambiguous-source-revision"
  | "citation.duplicate-link"
  | "citation.cross-source-evidence"
  | "citation.claim-mismatch"
  | "citation.noncanonical-source"
  | "citation.source-url-unattributed"
  | "citation.source-url-request-mismatch"
  | "citation.source-url-metadata-mismatch";
export class CitationError extends Error {
  readonly code: CitationErrorCode;
  constructor(code: CitationErrorCode) { super(`Citation mapping rejected (${code})`); this.name = "CitationError"; this.code = code; }
}

export interface CitationBinding {
  readonly sourceRef: { sourceId: string; revision: number };
  readonly claimRefs: readonly { claimId: string; revision: number }[];
  readonly evidenceRefs: readonly { evidenceId: string; revision: number }[];
}
export interface BibliographyMetadataProjection {
  readonly citationNumber: number;
  readonly sourceRef: { sourceId: string; revision: number };
  readonly authors: readonly Readonly<{ family: string | null; given: string | null; literal: string | null; orcid: string | null }>[];
  readonly title: string;
  readonly containerTitle: string | null;
  readonly publisher: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly published: Readonly<{ date: string | null; precision: string }>;
  readonly identifiers: Readonly<{ doi: string | null; pmid: string | null; pmcid: string | null }>;
  readonly canonicalUrl: string;
  readonly retrievedAt: string;
}
export interface CitationOptions { readonly maxCitations?: number; readonly maxBindings?: number; readonly maxLinks?: number }

interface NormalizedOptions { readonly maxCitations: number; readonly maxBindings: number; readonly maxLinks: number }
type SourceRef = Readonly<{ sourceId: string; revision: number }>;
type ClaimRef = Readonly<{ claimId: string; revision: number }>;
type EvidenceRef = Readonly<{ evidenceId: string; revision: number }>;
interface PreparedBinding { readonly sourceRef: SourceRef; readonly claimRefs: readonly ClaimRef[]; readonly evidenceRefs: readonly EvidenceRef[] }
interface SourceAccumulator { readonly sourceRef: SourceRef; readonly claimRefs: Map<string, ClaimRef>; readonly evidenceRefs: Map<string, EvidenceRef> }

const DEFAULTS: NormalizedOptions = Object.freeze({ maxCitations: 10_000, maxBindings: 20_000, maxLinks: 100_000 });
const HARDS: NormalizedOptions = Object.freeze({ maxCitations: 100_000, maxBindings: 200_000, maxLinks: 1_000_000 });
const OPTION_KEYS = Object.freeze(["maxCitations", "maxBindings", "maxLinks"]);

export function assignCitationMappings(
  snapshot: BoundedValidatedEvidenceSnapshot,
  orderedSourceRefs: readonly { sourceId: string; revision: number }[],
  bindings: readonly CitationBinding[],
  options?: CitationOptions,
): Readonly<{ citations: readonly CitationMapRecord[]; bibliography: readonly BibliographyMetadataProjection[] }> {
  const normalized = normalizeOptions(options);
  const prepared = prepareInputs(orderedSourceRefs, bindings, normalized);
  let indexes: ValidatedSnapshotIndexes;
  try { indexes = getValidatedSnapshotIndexes(snapshot); }
  catch (error) { if (error instanceof EvidenceAdmissionError && error.code === "evidence.snapshot-invalid") fail("citation.invalid-input"); return fail("citation.invalid-input"); }
  return assignPrepared(indexes, prepared.ordered, prepared.bindings);
}

export function assignCitationMappingsFromRecords(
  records: CanonicalEvidenceSet,
  orderedSourceRefs: readonly { sourceId: string; revision: number }[],
  bindings: readonly CitationBinding[],
  snapshotOptions?: EvidenceSnapshotOptions,
  citationOptions?: CitationOptions,
  diagnostics?: EvidenceSnapshotDiagnostics,
): Readonly<{ citations: readonly CitationMapRecord[]; bibliography: readonly BibliographyMetadataProjection[] }> {
  normalizeOptions(citationOptions);
  let snapshot: BoundedValidatedEvidenceSnapshot;
  try { snapshot = buildBoundedValidatedEvidenceSnapshot(records, snapshotOptions, diagnostics); }
  catch (error) { return mapAdmission(error); }
  return assignCitationMappings(snapshot, orderedSourceRefs, bindings, citationOptions);
}

function normalizeOptions(input?: CitationOptions): NormalizedOptions {
  if (input === undefined) return DEFAULTS;
  if (utilTypes.isProxy(input) || !isPlain(input)) fail("citation.invalid-options");
  const keys = Reflect.ownKeys(input); if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key))) fail("citation.invalid-options");
  const output = {} as Record<keyof NormalizedOptions, number>;
  for (const key of OPTION_KEYS as readonly (keyof NormalizedOptions)[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key); const value = descriptor === undefined ? DEFAULTS[key] : dataDescriptorValue(descriptor, "citation.invalid-options");
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HARDS[key]) fail("citation.invalid-options"); output[key] = value as number;
  }
  return Object.freeze(output);
}

function prepareInputs(orderedInput: unknown, bindingsInput: unknown, options: NormalizedOptions): Readonly<{ ordered: readonly SourceRef[]; bindings: readonly PreparedBinding[] }> {
  const orderedView = inspectArray(orderedInput, options.maxCitations, "citation.too-many-citations");
  const bindingView = inspectArray(bindingsInput, options.maxBindings, "citation.too-many-bindings");
  let links = 0;
  for (let index = 0; index < bindingView.length; index += 1) {
    const value = arrayValue(bindingView, index); validateBindingShape(value);
    const input = value as Record<string, unknown>; const claims = inspectArray(dataValue(input, "claimRefs"), options.maxLinks, "citation.too-many-links"); const evidence = inspectArray(dataValue(input, "evidenceRefs"), options.maxLinks, "citation.too-many-links");
    links = checkedAdd(links, checkedAdd(claims.length, evidence.length, "citation.too-many-links"), "citation.too-many-links"); if (links > options.maxLinks) fail("citation.too-many-links");
  }
  const orderedValues = snapshotArray(orderedView); const rawBindings: Array<Readonly<{ sourceRef: unknown; claimRefs: readonly unknown[]; evidenceRefs: readonly unknown[] }>> = [];
  for (const value of snapshotArray(bindingView)) {
    const input = value as Record<string, unknown>; const claims = snapshotArray(inspectArray(dataValue(input, "claimRefs"), options.maxLinks, "citation.too-many-links")); const evidence = snapshotArray(inspectArray(dataValue(input, "evidenceRefs"), options.maxLinks, "citation.too-many-links"));
    rawBindings.push(Object.freeze({ sourceRef: dataValue(input, "sourceRef"), claimRefs: claims, evidenceRefs: evidence }));
  }
  preflightRefShapes(orderedValues, "sourceId");
  for (const item of rawBindings) { preflightRefShapes([item.sourceRef], "sourceId"); preflightRefShapes(item.claimRefs, "claimId"); preflightRefShapes(item.evidenceRefs, "evidenceId"); }
  const ordered = orderedValues.map((value) => prepareRef(value, "sourceId", ID_PATTERNS.source) as SourceRef);
  const preparedBindings = rawBindings.map((item) => Object.freeze({
    sourceRef: prepareRef(item.sourceRef, "sourceId", ID_PATTERNS.source) as SourceRef,
    claimRefs: Object.freeze(item.claimRefs.map((value) => prepareRef(value, "claimId", ID_PATTERNS.claim) as ClaimRef)),
    evidenceRefs: Object.freeze(item.evidenceRefs.map((value) => prepareRef(value, "evidenceId", ID_PATTERNS.evidence) as EvidenceRef)),
  }));
  accountCanonicalInput(ordered, preparedBindings, options);
  const stableRevisions = new Map<string, number>();
  for (const ref of [...ordered, ...preparedBindings.map(({ sourceRef }) => sourceRef)]) { const prior = stableRevisions.get(ref.sourceId); if (prior !== undefined && prior !== ref.revision) fail("citation.ambiguous-source-revision"); stableRevisions.set(ref.sourceId, ref.revision); }
  return Object.freeze({ ordered: Object.freeze(ordered), bindings: Object.freeze(preparedBindings) });
}

interface ArrayView { readonly length: number; readonly input: unknown[] }
function inspectArray(input: unknown, maximum: number, countCode: CitationErrorCode): ArrayView {
  if (utilTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail("citation.invalid-input");
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value; if (!Number.isSafeInteger(length) || length < 0) fail("citation.invalid-input"); if (length > maximum) fail(countCode);
  const keys = Reflect.ownKeys(input); if (keys.length !== length + 1 || !keys.includes("length")) fail("citation.invalid-input");
  for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("citation.invalid-input"); }
  return Object.freeze({ length, input });
}
function arrayValue(view: ArrayView, index: number): unknown { return Object.getOwnPropertyDescriptor(view.input, String(index))!.value; }
function snapshotArray(view: ArrayView): readonly unknown[] { const values: unknown[] = []; for (let index = 0; index < view.length; index += 1) values.push(arrayValue(view, index)); return Object.freeze(values); }
function validateBindingShape(value: unknown): void {
  if (utilTypes.isProxy(value) || !isPlain(value)) fail("citation.invalid-input"); const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !keys.includes("sourceRef") || !keys.includes("claimRefs") || !keys.includes("evidenceRefs")) fail("citation.invalid-input");
  dataValue(value, "sourceRef"); dataValue(value, "claimRefs"); dataValue(value, "evidenceRefs");
}
function preflightRefShapes(values: readonly unknown[], idField: "sourceId" | "claimId" | "evidenceId"): void {
  for (const value of values) {
    if (utilTypes.isProxy(value) || !isPlain(value)) fail("citation.invalid-input"); const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes(idField) || !keys.includes("revision")) fail("citation.invalid-input");
  }
}
function prepareRef(value: unknown, idField: "sourceId" | "claimId" | "evidenceId", pattern: RegExp): SourceRef | ClaimRef | EvidenceRef {
  const input = value as Record<string, unknown>; const id = dataValue(input, idField); const revision = dataValue(input, "revision");
  if (typeof id !== "string" || !pattern.test(id) || !Number.isSafeInteger(revision) || (revision as number) < 1) fail("citation.invalid-input");
  return Object.freeze({ [idField]: id, revision: revision as number }) as unknown as SourceRef | ClaimRef | EvidenceRef;
}
function accountCanonicalInput(ordered: readonly SourceRef[], bindings: readonly PreparedBinding[], options: NormalizedOptions): void {
  let bytes = canonicalBytes({ bindings: [], orderedSourceRefs: [] });
  for (let index = 0; index < ordered.length; index += 1) bytes = checkedAdd(bytes, canonicalBytes(ordered[index]!) + (index === 0 ? 0 : 1), "citation.too-many-links");
  for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex += 1) {
    const item = bindings[bindingIndex]!; bytes = checkedAdd(bytes, canonicalBytes({ claimRefs: [], evidenceRefs: [], sourceRef: item.sourceRef }) + (bindingIndex === 0 ? 0 : 1), "citation.too-many-links");
    for (let index = 0; index < item.claimRefs.length; index += 1) bytes = checkedAdd(bytes, canonicalBytes(item.claimRefs[index]!) + (index === 0 ? 0 : 1), "citation.too-many-links");
    for (let index = 0; index < item.evidenceRefs.length; index += 1) bytes = checkedAdd(bytes, canonicalBytes(item.evidenceRefs[index]!) + (index === 0 ? 0 : 1), "citation.too-many-links");
  }
  const maxSourceRefBytes = canonicalBytes({ sourceId: "src-" + "a".repeat(128), revision: Number.MAX_SAFE_INTEGER });
  const maxLinkRefBytes = Math.max(canonicalBytes({ claimId: "claim-" + "a".repeat(64), revision: Number.MAX_SAFE_INTEGER }), canonicalBytes({ evidenceId: "ev-" + "a".repeat(64), revision: Number.MAX_SAFE_INTEGER }));
  let maximum = canonicalBytes({ bindings: [], orderedSourceRefs: [] });
  maximum = checkedAdd(maximum, checkedMultiply(options.maxCitations, maxSourceRefBytes + 1, "citation.invalid-options"), "citation.invalid-options");
  maximum = checkedAdd(maximum, checkedMultiply(options.maxBindings, canonicalBytes({ claimRefs: [], evidenceRefs: [], sourceRef: { sourceId: "src-" + "a".repeat(128), revision: Number.MAX_SAFE_INTEGER } }) + 1, "citation.invalid-options"), "citation.invalid-options");
  maximum = checkedAdd(maximum, checkedMultiply(options.maxLinks, maxLinkRefBytes + 1, "citation.invalid-options"), "citation.invalid-options");
  if (bytes > maximum) fail("citation.too-many-links");
}
function canonicalBytes(value: unknown): number { return Buffer.byteLength(canonicalJson(value), "utf8"); }

function assignPrepared(indexes: ValidatedSnapshotIndexes, orderedInput: readonly SourceRef[], bindings: readonly PreparedBinding[]) {
  const ordered: SourceRef[] = []; const orderedKeys = new Set<string>(); const sourceRecords = new Map<string, SourceRecord>();
  for (const ref of orderedInput) {
    const key = exactKey(ref.sourceId, ref.revision); if (orderedKeys.has(key)) continue;
    const record = indexes.getExactRecord({ kind: "sources", id: ref.sourceId, revision: ref.revision }); if (!record) fail("citation.unresolved-ref");
    const source = record as SourceRecord; validateCitedSource(source, indexes); orderedKeys.add(key); ordered.push(ref); sourceRecords.set(key, source);
  }
  const accumulators = new Map<string, SourceAccumulator>(); const evidenceOwners = new Map<string, string>();
  for (const item of bindings) {
    const sourceKey = exactKey(item.sourceRef.sourceId, item.sourceRef.revision);
    const source = indexes.getExactRecord({ kind: "sources", id: item.sourceRef.sourceId, revision: item.sourceRef.revision }); if (!source) fail("citation.unresolved-ref");
    if (!orderedKeys.has(sourceKey)) fail("citation.unresolved-ref");
    const accumulator = accumulators.get(sourceKey) ?? { sourceRef: item.sourceRef, claimRefs: new Map<string, ClaimRef>(), evidenceRefs: new Map<string, EvidenceRef>() };
    for (const ref of item.claimRefs) { if (!indexes.getExactRecord({ kind: "claims", id: ref.claimId, revision: ref.revision })) fail("citation.unresolved-ref"); accumulator.claimRefs.set(exactKey(ref.claimId, ref.revision), ref); }
    for (const ref of item.evidenceRefs) {
      if (!indexes.getExactRecord({ kind: "evidence", id: ref.evidenceId, revision: ref.revision })) fail("citation.unresolved-ref");
      const evidenceKey = exactKey(ref.evidenceId, ref.revision); const owner = evidenceOwners.get(evidenceKey); if (owner !== undefined && owner !== sourceKey) fail("citation.duplicate-link"); evidenceOwners.set(evidenceKey, sourceKey); accumulator.evidenceRefs.set(evidenceKey, ref);
    }
    accumulators.set(sourceKey, accumulator);
  }
  for (const [sourceKey, accumulator] of accumulators) for (const ref of accumulator.evidenceRefs.values()) {
    const evidence = indexes.getExactRecord({ kind: "evidence", id: ref.evidenceId, revision: ref.revision }) as EvidenceRecord;
    if (evidence.sourceRef === null || exactKey(String(evidence.sourceRef.sourceId), Number(evidence.sourceRef.revision)) !== sourceKey) fail("citation.cross-source-evidence");
    if (!accumulator.claimRefs.has(exactKey(String(evidence.claimRef.claimId), Number(evidence.claimRef.revision)))) fail("citation.claim-mismatch");
  }
  const citations: CitationMapRecord[] = []; const bibliography: BibliographyMetadataProjection[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const ref = ordered[index]!; const key = exactKey(ref.sourceId, ref.revision); const accumulator = accumulators.get(key);
    const claimRefs = [...(accumulator?.claimRefs.values() ?? [])].sort(compareClaimRefs); const evidenceRefs = [...(accumulator?.evidenceRefs.values() ?? [])].sort(compareEvidenceRefs);
    const candidate = { schemaVersion: 1 as const, citationNumber: index + 1, sourceRef: ref, claimRefs, evidenceRefs };
    const parsed = parse(CitationMapRecordSchema, candidate); if (!parsed.success) fail("citation.invalid-input"); citations.push(deepFreeze(parsed.value));
    bibliography.push(projectSource(sourceRecords.get(key)!, index + 1, ref));
  }
  return deepFreeze({ citations, bibliography });
}

function validateCitedSource(source: SourceRecord, indexes: ValidatedSnapshotIndexes): void {
  try { validateSourceCanonicalUrlProvenanceFromSnapshotInternal(source, indexes.requestProvenanceIndex); }
  catch (error) {
    if (error instanceof SourceIdentityError) {
      if (error.code === "source.url-policy-invalid" || error.code === "source.invalid-input" || error.code === "source.semantic-invalid") fail("citation.noncanonical-source");
      if (error.code === "source.url-unattributed") fail("citation.source-url-unattributed");
      if (error.code === "source.url-request-mismatch") fail("citation.source-url-request-mismatch");
      if (error.code === "source.url-metadata-mismatch") fail("citation.source-url-metadata-mismatch");
    }
    return fail("citation.invalid-evidence-set");
  }
}
function projectSource(source: SourceRecord, citationNumber: number, ref: SourceRef): BibliographyMetadataProjection {
  return deepFreeze({
    citationNumber, sourceRef: { ...ref }, authors: source.authors.map((author) => ({ family: author.family, given: author.given, literal: author.literal, orcid: author.orcid })),
    title: source.title, containerTitle: source.containerTitle, publisher: source.publisher, volume: source.volume, issue: source.issue, pages: source.pages,
    published: { date: source.published.date, precision: source.published.precision }, identifiers: { doi: source.identifiers.doi, pmid: source.identifiers.pmid, pmcid: source.identifiers.pmcid },
    canonicalUrl: source.canonicalUrl, retrievedAt: source.retrievedAt,
  });
}

function mapAdmission(error: unknown): never {
  if (!(error instanceof EvidenceAdmissionError)) return fail("citation.invalid-evidence-set");
  switch (error.code) {
    case "evidence.invalid-options": return fail("citation.invalid-options");
    case "evidence.too-many-records": case "evidence.too-many-references": case "evidence.record-too-large": case "evidence.input-too-large": return fail("citation.evidence-set-too-large");
    case "evidence.unresolved-ref": return fail("citation.unresolved-ref");
    case "evidence.source-url-policy-invalid": case "evidence.source-semantic-invalid": return fail("citation.noncanonical-source");
    case "evidence.source-url-unattributed": return fail("citation.source-url-unattributed");
    case "evidence.source-url-request-mismatch": return fail("citation.source-url-request-mismatch");
    case "evidence.source-url-metadata-mismatch": return fail("citation.source-url-metadata-mismatch");
    case "evidence.invalid-input": case "evidence.snapshot-invalid": case "evidence.duplicate-revision": case "evidence.revision-gap": case "evidence.duplicate-request":
    case "evidence.stale-latest-ref": case "evidence.duplicate-source-identity": case "evidence.ambiguous-source-identity": case "evidence.lineage-invalid":
    case "evidence.asymmetric-conflict": case "evidence.invalid-prospective-record": return fail("citation.invalid-evidence-set");
  }
}
function compareClaimRefs(a: ClaimRef, b: ClaimRef): number { return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : a.revision - b.revision; }
function compareEvidenceRefs(a: EvidenceRef, b: EvidenceRef): number { return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : a.revision - b.revision; }
function exactKey(id: string, revision: number): string { return `${id}\0${revision}`; }
function checkedAdd(a: number, b: number, code: CitationErrorCode): number { const result = a + b; if (!Number.isSafeInteger(result)) fail(code); return result; }
function checkedMultiply(a: number, b: number, code: CitationErrorCode): number { const result = a * b; if (!Number.isSafeInteger(result)) fail(code); return result; }
function dataValue(input: object, key: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("citation.invalid-input"); return descriptor.value; }
function dataDescriptorValue(descriptor: PropertyDescriptor, code: CitationErrorCode): unknown { if (!descriptor.enumerable || !("value" in descriptor)) fail(code); return descriptor.value; }
function isPlain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(code: CitationErrorCode): never { throw new CitationError(code); }
