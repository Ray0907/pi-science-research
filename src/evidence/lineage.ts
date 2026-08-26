import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { ID_PATTERNS } from "../domain/ids.js";
import { type SourceRecord } from "../domain/research-records.js";
import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import {
  ScholarlyIdentifierError,
  prepareProspectiveSourceIdentityFields,
} from "../scholarly/identifiers.js";

export type LineageErrorCode =
  | "lineage.invalid-options"
  | "lineage.invalid-input"
  | "lineage.too-many-sources"
  | "lineage.too-many-edges"
  | "lineage.record-too-large"
  | "lineage.input-too-large"
  | "lineage.duplicate-revision"
  | "lineage.revision-gap"
  | "lineage.unresolved-ref"
  | "lineage.self-edge"
  | "lineage.duplicate-edge"
  | "lineage.asymmetric-relation"
  | "lineage.invalid-direction"
  | "lineage.traversal-too-deep"
  | "lineage.cycle";

export class LineageError extends Error {
  readonly code: LineageErrorCode;
  constructor(code: LineageErrorCode) {
    super(`Source lineage rejected (${code})`);
    this.name = "LineageError";
    this.code = code;
  }
}

export type IndependenceDecision = Readonly<{
  status: "independent" | "dependent" | "unknown";
  reasons: readonly (
    | "same-source"
    | "same-study"
    | "shared-cohort"
    | "shared-dataset"
    | "version-relation"
    | "correction-relation"
    | "reanalysis-relation"
    | "report-relation"
    | "dependency-component"
    | "unknown-lineage"
  )[];
}>;

export interface LineageGraph {
  readonly sourceRefs: readonly { sourceId: string; revision: number }[];
  readonly revisionCount: number;
  readonly stableSourceCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface LineageOptions {
  readonly maxRevisions?: number;
  readonly maxStableSources?: number;
  readonly maxGraphNodes?: number;
  readonly maxEdges?: number;
  readonly maxTraversalDepth?: number;
  readonly maxSourceRecordCanonicalBytes?: number;
  readonly maxAggregateCanonicalBytes?: number;
}

const LIMITS = Object.freeze({
  maxRevisions: [100_000, 500_000],
  maxStableSources: [50_000, 200_000],
  maxGraphNodes: [100_000, 500_000],
  maxEdges: [250_000, 1_000_000],
  maxTraversalDepth: [50_000, 250_000],
  maxSourceRecordCanonicalBytes: [262_144, 1_048_576],
  maxAggregateCanonicalBytes: [16_777_216, 67_108_864],
} as const);
const OPTION_KEYS = Object.freeze(Object.keys(LIMITS));
const DIRECTED_RELATIONS = new Set<RelationType>(["version-of", "correction-of", "reanalysis-of", "reports"]);
const SYMMETRIC_RELATIONS = new Set<RelationType>(["shares-cohort", "shares-dataset"]);
const graphState = new WeakMap<object, GraphState>();

type RelationType = SourceRecord["lineage"]["relationTypes"][number];
type SourceRef = Readonly<{ sourceId: string; revision: number }>;

interface NormalizedOptions {
  readonly maxRevisions: number;
  readonly maxStableSources: number;
  readonly maxGraphNodes: number;
  readonly maxEdges: number;
  readonly maxTraversalDepth: number;
  readonly maxSourceRecordCanonicalBytes: number;
  readonly maxAggregateCanonicalBytes: number;
}
interface PreparedSource {
  readonly record: SourceRecord;
  readonly json: string;
  readonly bytes: number;
}
interface StableEdge {
  readonly from: string;
  readonly target: string;
  readonly relation: RelationType;
}
interface GraphState {
  readonly recordsByRef: ReadonlyMap<string, SourceRecord>;
  readonly componentBySourceId: ReadonlyMap<string, number>;
  readonly relationsByPair: ReadonlyMap<string, ReadonlySet<RelationType>>;
}

export function buildLineageGraph(sources: readonly SourceRecord[], options?: LineageOptions): LineageGraph {
  const normalized = normalizeOptions(options);
  const inputs = safeArray(sources, normalized.maxRevisions, "lineage.too-many-sources");
  const prepared: PreparedSource[] = [];
  for (const input of inputs) prepared.push(prepareRawSource(input, normalized));
  assertAggregateBytes(prepared, normalized);
  return buildPreparedGraph(prepared, normalized);
}

/** Package-internal snapshot seam; deliberately excluded from the package root. */
export function buildLineageGraphFromValidatedSources(
  sources: readonly SourceRecord[],
  sourceCanonicalJson: readonly string[],
  options?: LineageOptions,
): LineageGraph {
  const normalized = normalizeOptions(options);
  const sourceInputs = safeArray(sources, normalized.maxRevisions, "lineage.too-many-sources");
  const jsonInputs = safeArray(sourceCanonicalJson, normalized.maxRevisions, "lineage.too-many-sources");
  if (sourceInputs.length !== jsonInputs.length || !Object.isFrozen(sources) || !Object.isFrozen(sourceCanonicalJson))
    fail("lineage.invalid-input");
  const prepared: PreparedSource[] = [];
  for (let index = 0; index < sourceInputs.length; index += 1) {
    const record = sourceInputs[index];
    const json = jsonInputs[index];
    if (!isDeepFrozenSource(record) || typeof json !== "string") fail("lineage.invalid-input");
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > normalized.maxSourceRecordCanonicalBytes) fail("lineage.record-too-large");
    prepared.push(Object.freeze({ record, json, bytes }) as PreparedSource);
  }
  assertAggregateBytes(prepared, normalized);
  return buildPreparedGraph(prepared, normalized);
}

export function compareSourceIndependence(
  graph: LineageGraph,
  left: SourceRef,
  right: SourceRef,
): IndependenceDecision {
  const state = graphState.get(graph as object);
  if (!state) fail("lineage.invalid-input");
  const leftRef = validateRef(left);
  const rightRef = validateRef(right);
  const leftRecord = state.recordsByRef.get(refKey(leftRef));
  const rightRecord = state.recordsByRef.get(refKey(rightRef));
  if (!leftRecord || !rightRecord) fail("lineage.unresolved-ref");

  const reasons: IndependenceDecision["reasons"][number][] = [];
  const sameSource = leftRecord.sourceId === rightRecord.sourceId;
  if (sameSource) reasons.push("same-source");
  const leftStudy = resolvedStudy(leftRecord.lineage.studyId);
  const rightStudy = resolvedStudy(rightRecord.lineage.studyId);
  if (leftStudy !== null && rightStudy !== null && leftStudy === rightStudy) reasons.push("same-study");
  if (sharesNonEmpty(leftRecord.lineage.cohortIds, rightRecord.lineage.cohortIds)) reasons.push("shared-cohort");
  if (sharesNonEmpty(leftRecord.lineage.datasetIds, rightRecord.lineage.datasetIds)) reasons.push("shared-dataset");

  const pairRelations = new Set<RelationType>([
    ...(state.relationsByPair.get(pairKey(leftRecord.sourceId, rightRecord.sourceId)) ?? []),
    ...(state.relationsByPair.get(pairKey(rightRecord.sourceId, leftRecord.sourceId)) ?? []),
  ]);
  if (pairRelations.has("version-of")) reasons.push("version-relation");
  if (pairRelations.has("correction-of")) reasons.push("correction-relation");
  if (pairRelations.has("reanalysis-of")) reasons.push("reanalysis-relation");
  if (pairRelations.has("reports")) reasons.push("report-relation");
  const sameComponent = !sameSource
    && state.componentBySourceId.get(leftRecord.sourceId) === state.componentBySourceId.get(rightRecord.sourceId);
  if (sameComponent) reasons.push("dependency-component");

  if (reasons.length > 0) return freezeDecision("dependent", reasons);
  if (leftStudy === null || rightStudy === null) return freezeDecision("unknown", ["unknown-lineage"]);
  return freezeDecision("independent", []);
}

function prepareRawSource(input: unknown, options: NormalizedOptions): PreparedSource {
  if (utilTypes.isProxy(input)) fail("lineage.invalid-input");
  try {
    assertBoundedStructure(input, {
      maxDepth: 64,
      maxNodes: 100_000,
      maxKeys: 100_000,
      maxArrayLength: 100_000,
      maxStringBytes: options.maxSourceRecordCanonicalBytes,
      maxScalarBytes: options.maxSourceRecordCanonicalBytes,
    });
  } catch (error) {
    if (error instanceof StructuralLimitError && error.reason === "limit") fail("lineage.record-too-large");
    return fail("lineage.invalid-input");
  }
  try {
    const prepared = prepareProspectiveSourceIdentityFields(input as SourceRecord, undefined, {
      maxSourceRecordCanonicalBytes: options.maxSourceRecordCanonicalBytes,
    });
    if (prepared.canonicalBytes > options.maxSourceRecordCanonicalBytes) fail("lineage.record-too-large");
    return Object.freeze({ record: prepared.record, json: prepared.canonicalJson, bytes: prepared.canonicalBytes });
  } catch (error) {
    if (error instanceof LineageError) throw error;
    if (error instanceof ScholarlyIdentifierError && error.code === "identifier.record-too-large") fail("lineage.record-too-large");
    return fail("lineage.invalid-input");
  }
}

function buildPreparedGraph(prepared: readonly PreparedSource[], options: NormalizedOptions): LineageGraph {
  const revisionsBySource = new Map<string, Map<number, PreparedSource>>();
  for (const item of prepared) {
    const revisions = revisionsBySource.get(item.record.sourceId) ?? new Map<number, PreparedSource>();
    if (revisions.has(item.record.revision)) fail("lineage.duplicate-revision");
    revisions.set(item.record.revision, item);
    revisionsBySource.set(item.record.sourceId, revisions);
  }
  if (revisionsBySource.size > options.maxStableSources) fail("lineage.too-many-sources");
  const nodeCount = checkedAdd(prepared.length, revisionsBySource.size, "lineage.too-many-sources");
  if (nodeCount > options.maxGraphNodes) fail("lineage.too-many-sources");

  const sourceIds = radixSortByUtf8Key([...revisionsBySource.keys()], (value) => value);
  const ordered: PreparedSource[] = [];
  const latestBySource = new Map<string, PreparedSource>();
  for (const sourceId of sourceIds) {
    const revisions = revisionsBySource.get(sourceId)!;
    for (let revision = 1; revision <= revisions.size; revision += 1) {
      const item = revisions.get(revision);
      if (!item) fail("lineage.revision-gap");
      ordered.push(item);
    }
    latestBySource.set(sourceId, ordered.at(-1)!);
  }

  let edgeCount = 0;
  for (const { record } of ordered) {
    if (record.lineage.relatedSourceIds.length !== record.lineage.relationTypes.length) fail("lineage.invalid-input");
    edgeCount = checkedAdd(edgeCount, record.lineage.relatedSourceIds.length, "lineage.too-many-edges");
    if (edgeCount > options.maxEdges) fail("lineage.too-many-edges");
  }
  const stableEdges = new Map<string, StableEdge>();
  const latestSymmetricEdges = new Set<string>();
  const latestDuplicateKeys = new Map<string, Set<string>>();
  for (const { record } of ordered) {
    const { relatedSourceIds, relationTypes } = record.lineage;
    const latest = latestBySource.get(record.sourceId)!;
    const activeKeys = latestDuplicateKeys.get(record.sourceId) ?? new Set<string>();
    for (let index = 0; index < relatedSourceIds.length; index += 1) {
      const target = relatedSourceIds[index]!;
      const relation = relationTypes[index]!;
      if (target === record.sourceId) fail("lineage.self-edge");
      if (!revisionsBySource.has(target)) fail("lineage.unresolved-ref");
      const activeKey = `${relation}\0${target}`;
      if (record.revision === latest.record.revision) {
        if (activeKeys.has(activeKey)) fail("lineage.duplicate-edge");
        activeKeys.add(activeKey);
      }
      const stableKey = edgeKey(record.sourceId, relation, target);
      if (!stableEdges.has(stableKey)) stableEdges.set(stableKey, Object.freeze({ from: record.sourceId, target, relation }));
      if (record.revision === latest.record.revision && SYMMETRIC_RELATIONS.has(relation)) latestSymmetricEdges.add(stableKey);
    }
    latestDuplicateKeys.set(record.sourceId, activeKeys);
  }

  const directedEdges: StableEdge[] = [];
  const directedPairs = new Set<string>();
  const relationsByPair = new Map<string, Set<RelationType>>();
  for (const edge of stableEdges.values()) {
    const relations = relationsByPair.get(pairKey(edge.from, edge.target)) ?? new Set<RelationType>();
    relations.add(edge.relation);
    relationsByPair.set(pairKey(edge.from, edge.target), relations);
    if (DIRECTED_RELATIONS.has(edge.relation)) {
      directedEdges.push(edge);
      directedPairs.add(pairKey(edge.from, edge.target));
    }
  }
  for (const edge of directedEdges)
    if (directedPairs.has(pairKey(edge.target, edge.from))) fail("lineage.invalid-direction");
  for (const edge of stableEdges.values()) if (SYMMETRIC_RELATIONS.has(edge.relation)) {
    if (!latestSymmetricEdges.has(edgeKey(edge.target, edge.relation, edge.from))) fail("lineage.asymmetric-relation");
  }

  validateDirectedDag(sourceIds, directedEdges, options.maxTraversalDepth);
  const sourceIndex = new Map(sourceIds.map((sourceId, index) => [sourceId, index] as const));
  const union = new UnionFind(sourceIds.length);
  for (const edge of stableEdges.values()) union.join(sourceIndex.get(edge.from)!, sourceIndex.get(edge.target)!);
  const componentBySourceId = new Map<string, number>();
  sourceIds.forEach((sourceId, index) => componentBySourceId.set(sourceId, union.find(index)));

  const recordsByRef = new Map<string, SourceRecord>();
  const sourceRefs: SourceRef[] = [];
  for (const { record } of ordered) {
    recordsByRef.set(refKey(record), record);
    sourceRefs.push(Object.freeze({ sourceId: record.sourceId, revision: record.revision }));
  }
  const state: GraphState = Object.freeze({ recordsByRef, componentBySourceId, relationsByPair });
  const graph = Object.freeze({
    sourceRefs: Object.freeze(sourceRefs),
    revisionCount: prepared.length,
    stableSourceCount: sourceIds.length,
    nodeCount,
    edgeCount,
  });
  graphState.set(graph, state);
  return graph;
}

function validateDirectedDag(sourceIds: readonly string[], edges: readonly StableEdge[], maxDepth: number): void {
  const index = new Map(sourceIds.map((sourceId, position) => [sourceId, position] as const));
  const adjacency: number[][] = Array.from({ length: sourceIds.length }, () => []);
  const indegree = new Uint32Array(sourceIds.length);
  for (const edge of edges) {
    const from = index.get(edge.from)!;
    const target = index.get(edge.target)!;
    adjacency[from]!.push(target);
    indegree[target] = indegree[target]! + 1;
  }
  const queue: number[] = [];
  for (let node = 0; node < sourceIds.length; node += 1) if (indegree[node] === 0) queue.push(node);
  const longest = new Uint32Array(sourceIds.length);
  let visited = 0;
  let observedDepth = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]!;
    visited += 1;
    observedDepth = Math.max(observedDepth, longest[node]!);
    for (const target of adjacency[node]!) {
      longest[target] = Math.max(longest[target]!, longest[node]! + 1);
      indegree[target] = indegree[target]! - 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  if (visited !== sourceIds.length) fail("lineage.cycle");
  if (observedDepth > maxDepth) fail("lineage.traversal-too-deep");
}

function normalizeOptions(input?: LineageOptions): NormalizedOptions {
  if (input === undefined) return finishOptions({});
  if (utilTypes.isProxy(input)) fail("lineage.invalid-options");
  let snapshot: Record<string, unknown>;
  try {
    assertBoundedStructure(input, {
      maxDepth: 2, maxNodes: 100, maxKeys: 100, maxArrayLength: 0, maxStringBytes: 128, maxScalarBytes: 4_096,
    });
    snapshot = JSON.parse(canonicalJson(input)) as Record<string, unknown>;
  } catch { return fail("lineage.invalid-options"); }
  if (!isPlain(snapshot) || Object.keys(snapshot).some((key) => !OPTION_KEYS.includes(key))) fail("lineage.invalid-options");
  return finishOptions(snapshot);
}

function finishOptions(snapshot: Record<string, unknown>): NormalizedOptions {
  const values: Record<string, number> = {};
  for (const [key, [fallback, hard]] of Object.entries(LIMITS)) {
    const value = snapshot[key] ?? fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > hard) fail("lineage.invalid-options");
    values[key] = value as number;
  }
  const feasibleNodes = values.maxRevisions! + values.maxStableSources!;
  if (!Number.isSafeInteger(feasibleNodes)
    || values.maxSourceRecordCanonicalBytes! > values.maxAggregateCanonicalBytes!) fail("lineage.invalid-options");
  return Object.freeze(values) as unknown as NormalizedOptions;
}

function safeArray(input: unknown, max: number, countCode: LineageErrorCode): readonly unknown[] {
  if (utilTypes.isProxy(input)) fail("lineage.invalid-input");
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail("lineage.invalid-input");
  if (input.length > max) fail(countCode);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))))
    fail("lineage.invalid-input");
  const output: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("lineage.invalid-input");
    output.push(descriptor.value);
  }
  return output;
}

function assertAggregateBytes(prepared: readonly PreparedSource[], options: NormalizedOptions): void {
  let bytes = 2;
  for (let index = 0; index < prepared.length; index += 1) {
    if (index > 0) bytes = checkedAdd(bytes, 1, "lineage.input-too-large");
    bytes = checkedAdd(bytes, prepared[index]!.bytes, "lineage.input-too-large");
    if (bytes > options.maxAggregateCanonicalBytes) fail("lineage.input-too-large");
  }
  if (bytes > options.maxAggregateCanonicalBytes) fail("lineage.input-too-large");
}

function validateRef(input: unknown): SourceRef {
  if (utilTypes.isProxy(input) || !isPlain(input)) fail("lineage.invalid-input");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes("sourceId") || !keys.includes("revision")) fail("lineage.invalid-input");
  const sourceIdDescriptor = Object.getOwnPropertyDescriptor(input, "sourceId");
  const revisionDescriptor = Object.getOwnPropertyDescriptor(input, "revision");
  if (!sourceIdDescriptor || !revisionDescriptor || !("value" in sourceIdDescriptor) || !("value" in revisionDescriptor)
    || !sourceIdDescriptor.enumerable || !revisionDescriptor.enumerable
    || typeof sourceIdDescriptor.value !== "string" || !ID_PATTERNS.source.test(sourceIdDescriptor.value)
    || !Number.isSafeInteger(revisionDescriptor.value) || revisionDescriptor.value < 1) fail("lineage.invalid-input");
  return Object.freeze({ sourceId: sourceIdDescriptor.value, revision: revisionDescriptor.value });
}

function isDeepFrozenSource(input: unknown): input is SourceRecord {
  const stack: unknown[] = [input];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object") continue;
    if (utilTypes.isProxy(value) || seen.has(value) || !Object.isFrozen(value)) return false;
    seen.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return false;
      if (array && key === "length") continue;
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      stack.push(descriptor.value);
    }
  }
  return true;
}

function sharesNonEmpty(left: readonly string[], right: readonly string[]): boolean {
  const rightValues = new Set(right.filter((value) => value.length > 0));
  return left.some((value) => value.length > 0 && rightValues.has(value));
}
function resolvedStudy(value: string | null): string | null { return value !== null && value.length > 0 ? value : null; }
function refKey(ref: SourceRef): string { return `${ref.sourceId}\0${ref.revision}`; }
function pairKey(from: string, target: string): string { return `${from}\0${target}`; }
function edgeKey(from: string, relation: RelationType, target: string): string { return `${from}\0${relation}\0${target}`; }
function freezeDecision(status: IndependenceDecision["status"], reasons: IndependenceDecision["reasons"]): IndependenceDecision {
  return Object.freeze({ status, reasons: Object.freeze([...reasons]) });
}
function checkedAdd(left: number, right: number, code: LineageErrorCode): number {
  const value = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(value)) fail(code);
  return value;
}
function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function radixSortByUtf8Key<T>(values: readonly T[], key: (value: T) => string): T[] {
  const encoded = values.map((value) => ({ value, bytes: Buffer.from(key(value), "utf8") }));
  type Item = (typeof encoded)[number];
  type Frame = { readonly items: Item[]; readonly offset: number } | { readonly emit: Item[] };
  const stack: Frame[] = [{ items: encoded, offset: 0 }];
  const output: Item[] = [];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ("emit" in frame) { output.push(...frame.emit); continue; }
    if (frame.items.length < 2) { output.push(...frame.items); continue; }
    const buckets: Item[][] = Array.from({ length: 257 }, () => []);
    for (const item of frame.items)
      buckets[frame.offset >= item.bytes.length ? 0 : item.bytes[frame.offset]! + 1]!.push(item);
    for (let index = buckets.length - 1; index >= 1; index -= 1)
      if (buckets[index]!.length > 0) stack.push({ items: buckets[index]!, offset: frame.offset + 1 });
    if (buckets[0]!.length > 0) stack.push({ emit: buckets[0]! });
  }
  return output.map(({ value }) => value);
}
function fail(code: LineageErrorCode): never { throw new LineageError(code); }

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[value] !== value) {
      const next = this.parent[value]!;
      this.parent[value] = root;
      value = next;
    }
    return root;
  }
  join(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b);
  }
}
