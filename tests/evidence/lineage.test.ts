import { describe, expect, test } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import type { SourceRecord } from "../../src/domain/research-records.js";
import {
  LineageError,
  buildLineageGraph,
  buildLineageGraphFromValidatedSources,
  compareSourceIndependence,
  getLineageDependencyComponentCountInternal,
  getLineageDependencyComponentKey,
  getLineageRelationComponentKeyInternal,
  type LineageErrorCode,
} from "../../src/evidence/lineage.js";
import {
  buildRequestProvenanceIndex,
  validatedProvenanceRecordsForSnapshot,
} from "../../src/scholarly/source-identity.js";

const AT = "2026-08-25T12:00:00.000Z";

type Relation = SourceRecord["lineage"]["relationTypes"][number];

function source(id: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    schemaVersion: 1,
    sourceId: id,
    revision: 1,
    identifiers: { doi: null, pmid: null, pmcid: null },
    canonicalUrl: `https://example.org/${id}`,
    title: `Title ${id}`,
    authors: [{ family: "Doe", given: "J", literal: null, orcid: null }],
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    published: { date: "2026-01-01", precision: "day" },
    publicationType: "journal-article",
    peerReviewStatus: "unknown",
    accessLevel: "metadata-only",
    retrievedAt: AT,
    retrievalRequestIds: [],
    metadataProvenance: [],
    lineage: { studyId: null, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] },
    ...overrides,
  };
}

function withLineage(
  record: SourceRecord,
  lineage: Partial<SourceRecord["lineage"]>,
  revision = record.revision,
): SourceRecord {
  return { ...record, revision, lineage: { ...record.lineage, ...lineage } };
}

function edge(record: SourceRecord, target: SourceRecord, relation: Relation, revision = record.revision): SourceRecord {
  return withLineage(record, { relatedSourceIds: [target.sourceId], relationTypes: [relation] }, revision);
}

function ref(record: SourceRecord, revision = record.revision): { sourceId: string; revision: number } {
  return { sourceId: record.sourceId, revision };
}

function code(action: () => unknown): LineageErrorCode | undefined {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(LineageError);
    expect((error as Error).message).toBe(`Source lineage rejected (${(error as LineageError).code})`);
    expect((error as Error).message).not.toMatch(/example\.org|Title|SECRET|study-/u);
    return (error as LineageError).code;
  }
  return undefined;
}

function decision(graph: ReturnType<typeof buildLineageGraph>, left: SourceRecord, right: SourceRecord, leftRevision = left.revision, rightRevision = right.revision) {
  return compareSourceIndependence(graph, ref(left, leftRevision), ref(right, rightRevision));
}
function withoutComparisonSort<T>(action: () => T): T {
  const original = Array.prototype.sort;
  Array.prototype.sort = function (this: unknown[], compareFn?: (left: unknown, right: unknown) => number): unknown[] { if (compareFn !== undefined) throw new Error("comparison sort invoked"); return original.call(this); } as typeof Array.prototype.sort;
  try { return action(); } finally { Array.prototype.sort = original; }
}

describe("source lineage", () => {
  test("builds shuffled and reversed 10k revisions and lineage edges without comparison sort", () => { const revisionBase = source("src-radix.revisions"); const revisions = Array.from({ length: 10_000 }, (_, index) => ({ ...revisionBase, revision: index + 1 })); const limits = { maxRevisions: 10_000, maxStableSources: 10_000, maxGraphNodes: 20_000, maxEdges: 10_000, maxSourceRecordCanonicalBytes: 1_048_576, maxAggregateCanonicalBytes: 67_108_864 }; const revisionGraph = withoutComparisonSort(() => buildLineageGraph([...revisions].reverse(), limits)); expect(revisionGraph.revisionCount).toBe(10_000); expect(revisionGraph.sourceRefs.at(-1)).toEqual({ sourceId: revisionBase.sourceId, revision: 10_000 }); const sources = Array.from({ length: 10_000 }, (_, index) => source(`src-radix.${String(index).padStart(8, "0")}`)); const targetIds = sources.slice(1).map(({ sourceId }) => sourceId); sources[0] = withLineage(sources[0]!, { relatedSourceIds: [...targetIds].reverse(), relationTypes: targetIds.map(() => "reports") }); const shuffled = sources.map((_value, index) => sources[(index * 7919) % sources.length]!); const first = withoutComparisonSort(() => buildLineageGraph(shuffled, limits)); const secondSources = [...sources]; secondSources[0] = withLineage(secondSources[0]!, { relatedSourceIds: targetIds, relationTypes: targetIds.map(() => "reports") }); const second = withoutComparisonSort(() => buildLineageGraph([...secondSources].reverse(), limits)); expect(first.edgeCount).toBe(9_999); expect(first.revisionCount).toBe(10_000); expect(canonicalJson(first)).toBe(canonicalJson(second)); expect(first.nodeCount).toBe(second.nodeCount); expect(getLineageRelationComponentKeyInternal(first, ref(sources[0]!))).toBe(getLineageRelationComponentKeyInternal(second, ref(secondSources[0]!))); });
  test("classifies shared studies cohorts datasets and weak dependency components as dependent", () => {
    const studyA = withLineage(source("src-study.a0000001"), { studyId: "study-shared" });
    const studyB = withLineage(source("src-study.b0000001"), { studyId: "study-shared" });
    const cohortA = withLineage(source("src-cohort.a000001"), { studyId: "study-a", cohortIds: ["cohort-shared"] });
    const cohortB = withLineage(source("src-cohort.b000001"), { studyId: "study-b", cohortIds: ["cohort-shared"] });
    const dataA = withLineage(source("src-data.a00000001"), { studyId: "study-c", datasetIds: ["dataset-shared"] });
    const dataB = withLineage(source("src-data.b00000001"), { studyId: "study-d", datasetIds: ["dataset-shared"] });
    const parent = withLineage(source("src-parent.00000001"), { studyId: "study-parent" });
    const child = edge(withLineage(source("src-child.000000001"), { studyId: "study-child" }), parent, "version-of");
    const graph = buildLineageGraph([dataB, studyA, cohortB, parent, child, studyB, cohortA, dataA]);
    expect(decision(graph, studyA, studyB)).toEqual({ status: "dependent", reasons: ["same-study"] });
    expect(decision(graph, cohortA, cohortB)).toEqual({ status: "dependent", reasons: ["shared-cohort"] });
    expect(decision(graph, dataA, dataB)).toEqual({ status: "dependent", reasons: ["shared-dataset"] });
    expect(decision(graph, child, parent)).toEqual({
      status: "dependent", reasons: ["version-relation", "dependency-component"],
    });
  });

  test("treats common-parent forks as dependent without a directed path", () => {
    const parent = withLineage(source("src-fork.parent0001"), { studyId: "study-parent" });
    const left = edge(withLineage(source("src-fork.left000001"), { studyId: "study-left" }), parent, "version-of");
    const right = edge(withLineage(source("src-fork.right00001"), { studyId: "study-right" }), parent, "reports");
    const graph = buildLineageGraph([right, parent, left]);
    expect(decision(graph, left, right)).toEqual({ status: "dependent", reasons: ["dependency-component"] });
  });

  test("keeps disconnected resolved dependency components independent", () => {
    const leftParent = withLineage(source("src-disleft.parent1"), { studyId: "study-left-parent" });
    const left = edge(withLineage(source("src-disleft.child01"), { studyId: "study-left" }), leftParent, "correction-of");
    const rightParent = withLineage(source("src-disright.parent"), { studyId: "study-right-parent" });
    const right = edge(withLineage(source("src-disright.child1"), { studyId: "study-right" }), rightParent, "reanalysis-of");
    const graph = buildLineageGraph([right, leftParent, rightParent, left]);
    expect(decision(graph, left, right)).toEqual({ status: "independent", reasons: [] });
  });

  test("does not infer independence from URLs publishers agents or requests", () => {
    const left = source("src-origin.left0001", {
      canonicalUrl: "https://one.example/a", publisher: "One", retrievalRequestIds: ["request-0000000000000001"],
    });
    const right = source("src-origin.right001", {
      canonicalUrl: "https://two.example/b", publisher: "Two", retrievalRequestIds: ["request-0000000000000002"],
    });
    const graph = buildLineageGraph([left, right]);
    expect(decision(graph, left, right)).toEqual({ status: "unknown", reasons: ["unknown-lineage"] });
  });

  test("keeps incomplete lineage unknown", () => {
    const known = withLineage(source("src-unknown.known001"), { studyId: "study-known", cohortIds: ["cohort-a"] });
    const missing = withLineage(source("src-unknown.none0001"), { studyId: null, cohortIds: ["cohort-b"] });
    const empty = withLineage(source("src-unknown.empty001"), { studyId: "" });
    const graph = buildLineageGraph([known, empty, missing]);
    expect(decision(graph, known, missing)).toEqual({ status: "unknown", reasons: ["unknown-lineage"] });
    expect(decision(graph, known, empty)).toEqual({ status: "unknown", reasons: ["unknown-lineage"] });
  });

  test("accepts distinct resolved lineages as independent", () => {
    const left = withLineage(source("src-independent.a001"), {
      studyId: "study-a", cohortIds: ["cohort-a"], datasetIds: ["dataset-a"],
    });
    const right = withLineage(source("src-independent.b001"), {
      studyId: "study-b", cohortIds: ["cohort-b"], datasetIds: ["dataset-b"],
    });
    const graph = buildLineageGraph([right, left]);
    expect(decision(graph, left, right)).toEqual({ status: "independent", reasons: [] });
    expect(Object.isFrozen(compareSourceIndependence(graph, ref(left), ref(right)))).toBe(true);
  });

  test("validates canonical direction for version correction reanalysis and reports edges", () => {
    const relations = ["version-of", "correction-of", "reanalysis-of", "reports"] as const;
    const records: SourceRecord[] = [];
    const pairs: Array<[SourceRecord, SourceRecord, (typeof relations)[number]]> = [];
    relations.forEach((relation, index) => {
      const target = withLineage(source(`src-direction.target${index}`), { studyId: `study-target-${index}` });
      const from = edge(withLineage(source(`src-direction.from00${index}`), { studyId: `study-from-${index}` }), target, relation);
      records.push(from, target); pairs.push([from, target, relation]);
    });
    const graph = buildLineageGraph(records.reverse());
    const expected = {
      "version-of": "version-relation", "correction-of": "correction-relation",
      "reanalysis-of": "reanalysis-relation", reports: "report-relation",
    } as const;
    for (const [from, target, relation] of pairs) expect(decision(graph, from, target)).toEqual({
      status: "dependent", reasons: [expected[relation], "dependency-component"],
    });

    const preprint = withLineage(source("src-mixed.preprint01"), { studyId: "study-preprint" });
    const article = edge(withLineage(source("src-mixed.article001"), { studyId: "study-article" }), preprint, "version-of");
    const correction = edge(withLineage(source("src-mixed.correct001"), { studyId: "study-correction" }), article, "correction-of");
    const publicationChain = buildLineageGraph([correction, article, preprint]);
    expect(publicationChain.edgeCount).toBe(2);
    expect(decision(publicationChain, article, preprint)).toEqual({
      status: "dependent", reasons: ["version-relation", "dependency-component"],
    });
    expect(decision(publicationChain, correction, article)).toEqual({
      status: "dependent", reasons: ["correction-relation", "dependency-component"],
    });
    expect(decision(publicationChain, preprint, correction)).toEqual({
      status: "dependent", reasons: ["dependency-component"],
    });

    const original = withLineage(source("src-mixed.original01"), { studyId: "study-original" });
    const reanalysis = edge(withLineage(source("src-mixed.reanalyse1"), { studyId: "study-reanalysis" }), original, "reanalysis-of");
    const report = edge(withLineage(source("src-mixed.report0001"), { studyId: "study-report" }), reanalysis, "reports");
    const analysisChain = buildLineageGraph([reanalysis, report, original]);
    expect(analysisChain.edgeCount).toBe(2);
    expect(decision(analysisChain, report, reanalysis)).toEqual({
      status: "dependent", reasons: ["report-relation", "dependency-component"],
    });
    expect(decision(analysisChain, reanalysis, original)).toEqual({
      status: "dependent", reasons: ["reanalysis-relation", "dependency-component"],
    });
    expect(decision(analysisChain, report, original)).toEqual({
      status: "dependent", reasons: ["dependency-component"],
    });
  });

  test("rejects directed cycles reversals self edges missing nodes and asymmetric sharing", () => {
    const a = source("src-invalid.a000001");
    const b = source("src-invalid.b000001");
    const c = source("src-invalid.c000001");
    expect(code(() => buildLineageGraph([edge(a, a, "version-of")]))).toBe("lineage.self-edge");
    expect(code(() => buildLineageGraph([edge(a, source("src-missing.0000001"), "reports")])))
      .toBe("lineage.unresolved-ref");
    expect(code(() => buildLineageGraph([edge(a, b, "version-of"), edge(b, a, "correction-of")])))
      .toBe("lineage.invalid-direction");
    expect(code(() => buildLineageGraph([
      edge(a, b, "version-of"), edge(b, c, "reports"), edge(c, a, "reanalysis-of"),
    ]))).toBe("lineage.cycle");
    const preprint = source("src-reverse.preprint1");
    const article = edge(source("src-reverse.article01"), preprint, "version-of");
    expect(code(() => buildLineageGraph([article, edge(preprint, article, "correction-of")])))
      .toBe("lineage.invalid-direction");
    const original = source("src-reverse.original1");
    const reanalysis = edge(source("src-reverse.reanalyse"), original, "reanalysis-of");
    const report = edge(source("src-reverse.report001"), reanalysis, "reports");
    expect(code(() => buildLineageGraph([report, reanalysis, edge(original, reanalysis, "reports")])))
      .toBe("lineage.invalid-direction");
    expect(code(() => buildLineageGraph([edge(a, b, "shares-cohort"), b]))).toBe("lineage.asymmetric-relation");
    const symmetric = buildLineageGraph([
      withLineage(a, {
        relatedSourceIds: [b.sourceId, b.sourceId], relationTypes: ["shares-cohort", "shares-dataset"],
      }),
      withLineage(b, {
        relatedSourceIds: [a.sourceId, a.sourceId], relationTypes: ["shares-cohort", "shares-dataset"],
      }),
    ]);
    expect(decision(symmetric, a, b)).toEqual({ status: "dependent", reasons: ["dependency-component"] });
  });

  test("rejects latest duplicate edges while retaining historical repeats once", () => {
    const target = withLineage(source("src-history.target01"), { studyId: "study-target" });
    const base = edge(withLineage(source("src-history.source01"), { studyId: "study-source" }), target, "version-of");
    const repeated = { ...base, revision: 2 };
    const graph = buildLineageGraph([repeated, target, base]);
    expect(graph.edgeCount).toBe(2);
    expect(decision(graph, repeated, target, 1)).toEqual({
      status: "dependent", reasons: ["version-relation", "dependency-component"],
    });
    const erased = withLineage(base, { relatedSourceIds: [], relationTypes: [] }, 2);
    const correction = edge(withLineage(source("src-history.correct01"), { studyId: "study-correction" }), target, "correction-of");
    const retained = buildLineageGraph([correction, target, erased, base]);
    expect(decision(retained, erased, target, 2)).toEqual({
      status: "dependent", reasons: ["version-relation", "dependency-component"],
    });
    expect(decision(retained, erased, correction, 2)).toEqual({
      status: "dependent", reasons: ["dependency-component"],
    });
    const duplicateLatest = withLineage(repeated, {
      relatedSourceIds: [target.sourceId, target.sourceId], relationTypes: ["version-of", "version-of"],
    });
    expect(code(() => buildLineageGraph([base, duplicateLatest, target]))).toBe("lineage.duplicate-edge");
  });

  test("resolves exact historical revisions without rebinding to latest", () => {
    const a1 = withLineage(source("src-exact.a0000001"), { studyId: "study-old" });
    const a2 = withLineage(a1, { studyId: "study-new" }, 2);
    const b = withLineage(source("src-exact.b0000001"), { studyId: "study-old" });
    expect(code(() => buildLineageGraph([a1, a1]))).toBe("lineage.duplicate-revision");
    expect(code(() => buildLineageGraph([a2]))).toBe("lineage.revision-gap");
    expect(code(() => buildLineageGraph([withLineage(a1, {
      relatedSourceIds: [b.sourceId], relationTypes: [],
    }), b]))).toBe("lineage.invalid-input");
    const graph = buildLineageGraph([a2, b, a1]);
    expect(compareSourceIndependence(graph, ref(a1, 1), ref(b))).toEqual({ status: "dependent", reasons: ["same-study"] });
    expect(compareSourceIndependence(graph, ref(a1, 2), ref(b))).toEqual({ status: "independent", reasons: [] });
    expect(graph.sourceRefs).toEqual([ref(a1, 1), ref(a1, 2), ref(b)]);
  });

  test("rejects nonexistent refs with exact LineageError codes", () => {
    const a = withLineage(source("src-ref.a000000001"), { studyId: "study-a" });
    const b = withLineage(source("src-ref.b000000001"), { studyId: "study-b" });
    const graph = buildLineageGraph([a, b]);
    expect(code(() => compareSourceIndependence(graph, ref(a, 2), ref(b)))).toBe("lineage.unresolved-ref");
    expect(code(() => compareSourceIndependence(graph, { sourceId: "src-ref.missing001", revision: 1 }, ref(b))))
      .toBe("lineage.unresolved-ref");
    expect(code(() => compareSourceIndependence(graph, { sourceId: "invalid", revision: 1 }, ref(b))))
      .toBe("lineage.invalid-input");
    expect(code(() => compareSourceIndependence(graph, { sourceId: a.sourceId, revision: 0 }, ref(b))))
      .toBe("lineage.invalid-input");
    let traps = 0;
    const hostileRef = new Proxy(ref(a), {
      get() { traps += 1; throw new Error("SECRET"); }, ownKeys() { traps += 1; throw new Error("SECRET"); },
      getPrototypeOf() { traps += 1; throw new Error("SECRET"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("SECRET"); },
    });
    expect(code(() => compareSourceIndependence(graph, hostileRef, ref(b)))).toBe("lineage.invalid-input");
    expect(traps).toBe(0);
    expect(code(() => compareSourceIndependence({ ...graph } as never, ref(a), ref(b)))).toBe("lineage.invalid-input");
  });

  test("separately bounds revisions stable sources nodes edges and traversal depth", () => {
    const a = source("src-limit.a0000001");
    const b = source("src-limit.b0000001");
    const c = source("src-limit.c0000001");
    expect(code(() => buildLineageGraph([a, b], { maxRevisions: 1 }))).toBe("lineage.too-many-sources");
    expect(code(() => buildLineageGraph([a, b], { maxStableSources: 1 }))).toBe("lineage.too-many-sources");
    expect(code(() => buildLineageGraph([a], { maxGraphNodes: 1, maxTraversalDepth: 1 }))).toBe("lineage.too-many-sources");
    expect(code(() => buildLineageGraph([
      withLineage(a, { relatedSourceIds: [b.sourceId, c.sourceId], relationTypes: ["version-of", "reports"] }), b, c,
    ], { maxEdges: 1 }))).toBe("lineage.too-many-edges");
    expect(code(() => buildLineageGraph([
      edge(a, b, "version-of"), edge(b, c, "version-of"), c,
    ], { maxTraversalDepth: 1 }))).toBe("lineage.traversal-too-deep");
  });

  test("bounds canonical source and aggregate graph bytes before maps and edges", () => {
    const a = source("src-bytes.000000001", { title: "\"".repeat(200) });
    const recordBytes = Buffer.byteLength(canonicalJson(a), "utf8");
    const aggregateBytes = Buffer.byteLength(canonicalJson([a]), "utf8");
    expect(buildLineageGraph([a], {
      maxSourceRecordCanonicalBytes: recordBytes, maxAggregateCanonicalBytes: aggregateBytes,
    }).revisionCount).toBe(1);
    expect(code(() => buildLineageGraph([a], {
      maxSourceRecordCanonicalBytes: recordBytes - 1, maxAggregateCanonicalBytes: aggregateBytes,
    }))).toBe("lineage.record-too-large");
    expect(code(() => buildLineageGraph([a], {
      maxSourceRecordCanonicalBytes: recordBytes, maxAggregateCanonicalBytes: aggregateBytes - 1,
    }))).toBe("lineage.input-too-large");

    const provenance = buildRequestProvenanceIndex([a], []);
    const validated = validatedProvenanceRecordsForSnapshot(provenance);
    expect(buildLineageGraphFromValidatedSources(validated.sources, validated.sourceCanonicalJson, {
      maxSourceRecordCanonicalBytes: recordBytes, maxAggregateCanonicalBytes: aggregateBytes,
    }).revisionCount).toBe(1);
    const otherProvenance = validatedProvenanceRecordsForSnapshot(buildRequestProvenanceIndex([
      source("src-swapped.0000001"),
    ], []));
    for (const [sources, sourceCanonicalJson] of [
      [Object.freeze([...validated.sources]), validated.sourceCanonicalJson],
      [validated.sources, Object.freeze([...validated.sourceCanonicalJson])],
      [validated.sources, otherProvenance.sourceCanonicalJson],
      [Object.freeze([a]), Object.freeze([canonicalJson(a)])],
    ] as const) expect(code(() => buildLineageGraphFromValidatedSources(sources, sourceCanonicalJson)))
      .toBe("lineage.invalid-input");
  });

  test("rejects oversized lineage metadata and nested strings under the count cap", () => {
    const oversized = withLineage(source("src-oversized.00001"), {
      studyId: "s".repeat(2_000), cohortIds: ["c".repeat(2_000)], datasetIds: ["d".repeat(2_000)],
    });
    expect(code(() => buildLineageGraph([oversized], { maxSourceRecordCanonicalBytes: 1_000 })))
      .toBe("lineage.record-too-large");
    const semanticBase = withLineage(source("src-semantic.000001"), { studyId: "study-semantic" });
    expect(code(() => buildLineageGraph([withLineage(semanticBase, { cohortIds: ["same", "same"] })])))
      .toBe("lineage.invalid-input");
    expect(code(() => buildLineageGraph([withLineage(semanticBase, { datasetIds: ["same", "same"] })])))
      .toBe("lineage.invalid-input");
    expect(code(() => buildLineageGraph([{ ...semanticBase, retrievalRequestIds: [
      "request-0000000000000001", "request-0000000000000001",
    ] }]))).toBe("lineage.invalid-input");
    expect(code(() => buildLineageGraph([{ ...semanticBase,
      retrievalRequestIds: ["request-0000000000000001"],
      metadataProvenance: [{ field: "unknown-field", provider: "openalex", requestId: "request-0000000000000001" }],
    }]))).toBe("lineage.invalid-input");
  });

  test("rejects invalid graph and byte limits with lineage.invalid-options", () => {
    const a = source("src-options.0000001");
    const invalid = [
      { maxRevisions: 0 }, { maxRevisions: 500_001 }, { maxStableSources: 200_001 },
      { maxGraphNodes: 500_001 }, { maxEdges: 1_000_001 }, { maxTraversalDepth: 250_001 },
      { maxSourceRecordCanonicalBytes: 1_048_577 }, { maxAggregateCanonicalBytes: 67_108_865 },
      { maxSourceRecordCanonicalBytes: 2_001, maxAggregateCanonicalBytes: 2_000 },
      { unknown: 1 }, { get maxEdges() { return 1; } }, new Proxy({}, {}),
    ];
    for (const options of invalid) expect(code(() => buildLineageGraph([a], options as never))).toBe("lineage.invalid-options");
    let traps = 0;
    const hostile = new Proxy({} as SourceRecord[], {
      get() { traps += 1; throw new Error("SECRET"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("SECRET"); },
      ownKeys() { traps += 1; throw new Error("SECRET"); },
      getPrototypeOf() { traps += 1; throw new Error("SECRET"); },
    });
    expect(code(() => buildLineageGraph(hostile))).toBe("lineage.invalid-input");
    expect(traps).toBe(0);
    const hostileRecord = new Proxy(a, {
      get() { traps += 1; throw new Error("SECRET"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("SECRET"); },
      ownKeys() { traps += 1; throw new Error("SECRET"); },
      getPrototypeOf() { traps += 1; throw new Error("SECRET"); },
    });
    expect(code(() => buildLineageGraph([hostileRecord]))).toBe("lineage.invalid-input");
    expect(traps).toBe(0);
    const hostileOptions = new Proxy({}, {
      get() { traps += 1; throw new Error("SECRET"); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error("SECRET"); },
      ownKeys() { traps += 1; throw new Error("SECRET"); },
      getPrototypeOf() { traps += 1; throw new Error("SECRET"); },
    });
    expect(code(() => buildLineageGraph([a], hostileOptions))).toBe("lineage.invalid-options");
    expect(traps).toBe(0);
    let touched = false;
    const accessor = { ...a, get lineage() { touched = true; return a.lineage; } };
    expect(code(() => buildLineageGraph([accessor]))).toBe("lineage.invalid-input");
    expect(touched).toBe(false);
  });

  test("returns complete stable relation-component minima for exact refs", () => {
    const smaller = withLineage(source("src-component.aaa001"), { studyId: "study-smaller" });
    const selected = edge(withLineage(source("src-component.zzz001"), { studyId: "study-selected" }), smaller, "version-of");
    const graph = buildLineageGraph([selected, smaller]);
    expect(getLineageRelationComponentKeyInternal(graph, { sourceId: selected.sourceId, revision: 1 })).toBe(smaller.sourceId);
    expect(getLineageRelationComponentKeyInternal(graph, { sourceId: smaller.sourceId, revision: 1 })).toBe(smaller.sourceId);
  });

  test("exposes authentic deterministic exact-ref dependency component keys", () => {
    const a = withLineage(source("src-component.a0001"), { studyId: "study-a", datasetIds: ["dataset-shared"] });
    const b = withLineage(source("src-component.b0001"), { studyId: "study-b", datasetIds: ["dataset-shared"] });
    const unknown = withLineage(source("src-component.z0001"), { studyId: null });
    for (const values of [[a, b, unknown], [unknown, b, a]]) {
      const graph = buildLineageGraph(values);
      expect(Object.keys(graph).sort()).toEqual(["edgeCount", "nodeCount", "revisionCount", "sourceRefs", "stableSourceCount"]);
      expect(getLineageDependencyComponentCountInternal(graph)).toBe(2);
      expect(getLineageDependencyComponentKey(graph, { sourceId: a.sourceId, revision: 1 })).toBe(`retrieved-lineage:${a.sourceId}`);
      expect(getLineageDependencyComponentKey(graph, { sourceId: b.sourceId, revision: 1 })).toBe(`retrieved-lineage:${a.sourceId}`);
      expect(getLineageDependencyComponentKey(graph, { sourceId: unknown.sourceId, revision: 1 })).toBeNull();
    }
  });

  test("handles bounded deep graphs iteratively and returns immutable decisions", () => {
    const count = 10_000;
    const records: SourceRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      const current = withLineage(source(`src-deep.${String(index).padStart(8, "0")}`), { studyId: `study-${index}` });
      records.push(index === 0 ? current : edge(current, records[index - 1]!, "version-of"));
    }
    const graph = buildLineageGraph([...records].reverse(), {
      maxRevisions: 11_000, maxStableSources: 11_000, maxGraphNodes: 22_000,
      maxEdges: 11_000, maxTraversalDepth: 10_000,
    });
    expect(graph).toEqual(expect.objectContaining({ revisionCount: count, stableSourceCount: count, nodeCount: count * 2, edgeCount: count - 1 }));
    expect(decision(graph, records[0]!, records.at(-1)!)).toEqual({ status: "dependent", reasons: ["dependency-component"] });
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.sourceRefs)).toBe(true);
    expect(() => (graph.sourceRefs as Array<{ sourceId: string; revision: number }>).push(ref(records[0]!))).toThrow();
    const selected = compareSourceIndependence(graph, ref(records[0]!), ref(records.at(-1)!));
    expect(Object.isFrozen(selected.reasons)).toBe(true);
    const mutableLeft = withLineage(source("src-mutation.left001"), { studyId: "study-before" });
    const mutableRight = withLineage(source("src-mutation.right01"), { studyId: "study-before" });
    const mutationGraph = buildLineageGraph([mutableLeft, mutableRight]);
    mutableLeft.lineage.studyId = "study-after";
    expect(decision(mutationGraph, mutableLeft, mutableRight)).toEqual({ status: "dependent", reasons: ["same-study"] });
  });
});
