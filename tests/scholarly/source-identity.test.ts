import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../src/crypto/canonical-json.js";
import type { RequestRecord } from "../../src/domain/events.js";
import type { SourceRecord } from "../../src/domain/research-records.js";
import {
  SourceIdentityError,
  buildRequestProvenanceIndex,
  mergeSourceRecords,
  sourceIdentityKeys,
  validateProspectiveSourceSemantics,
  validateSourceCanonicalUrlProvenance,
  validateSourceCanonicalUrlProvenanceOnce,
  validatedProvenanceRecordsForSnapshot,
  type RequestProvenanceDiagnostics,
  type RequestProvenanceIndex,
  type SourceIdentityOptions,
} from "../../src/scholarly/source-identity.js";

const AT = "2026-08-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const REQUEST_A = "request-0000000000000001";
const REQUEST_B = "request-0000000000000002";

function src(id: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
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

function req(id: string, sourceId: string, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    schemaVersion: 1,
    requestId: id,
    attemptId: "attempt-0000000000000001",
    executionEpoch: 0,
    logicalRequestId: `logical-${id}`,
    physicalAttemptOrdinal: 1,
    retryOfRequestId: null,
    replayPolicy: "safe-read",
    provider: "openalex",
    operation: "fetch",
    normalizedInput: { query: null, identifier: null, url: `https://api.example.org/${id}`, parameters: [] },
    accessPolicySha256: HASH,
    startedAt: AT,
    endedAt: AT,
    status: "success",
    httpStatus: 200,
    requestedUrl: `https://api.example.org/${id}`,
    finalUrl: `https://example.org/${sourceId}`,
    redirectUrls: [],
    responseSha256: null,
    responseFile: null,
    encodedBytes: 0,
    decodedBytes: 0,
    resultSourceIds: [sourceId],
    errorClass: null,
    ...overrides,
  };
}

function options(overrides: SourceIdentityOptions = {}): SourceIdentityOptions {
  return { ...overrides };
}

function diagnostics(): RequestProvenanceDiagnostics {
  return { sourceVisits: 0, requestVisits: 0, requestUrlVisits: 0, metadataStepVisits: 0, witnessInsertions: 0 };
}

function errorCode(action: () => unknown): string | undefined {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(SourceIdentityError);
    expect((error as Error).message).not.toMatch(/example\.org|Title|logical-|secret/i);
    return (error as SourceIdentityError).code;
  }
  return undefined;
}

function canonicalResult(value: unknown): string { return canonicalJson(value); }

const DOI = "10.1234/shared";
const PMID = "123456";

describe("source identity and provenance", () => {
  test("deduplicates transitive strong identifier matches independent of input order", () => {
    const a = src("src-source.a0000001", { identifiers: { doi: DOI, pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/shared", title: "A" });
    const b = src("src-source.b0000001", { identifiers: { doi: DOI, pmid: PMID, pmcid: null }, canonicalUrl: "https://example.org/b", title: "B" });
    const c = src("src-source.c0000001", { identifiers: { doi: null, pmid: PMID, pmcid: null }, canonicalUrl: "https://example.org/c", title: "C" });
    const forward = mergeSourceRecords([], [c, a, b]);
    const reverse = mergeSourceRecords([], [b, a, c]);
    expect(forward.aliases).toEqual({ "src-source.b0000001": "src-source.a0000001", "src-source.c0000001": "src-source.a0000001" });
    expect(canonicalResult(forward)).toBe(canonicalResult(reverse));
    expect(forward.sources.filter((record) => record.revision === 1)).toHaveLength(1);
  });

  test("merges matching canonical URLs only when strong identifiers do not conflict", () => {
    const left = src("src-urlmatch.00000001", { canonicalUrl: "https://example.org/same", title: "A" });
    const right = src("src-urlmatch.00000002", { canonicalUrl: "https://example.org/same", title: "B" });
    const merged = mergeSourceRecords([], [right, left]);
    expect(merged.aliases).toEqual({ "src-urlmatch.00000002": "src-urlmatch.00000001" });
    expect(merged.conflicts.some(({ code }) => code === "source.metadata-conflict")).toBe(true);
  });

  test("marks matching canonical URLs with conflicting strong identifiers ambiguous", () => {
    const left = src("src-ambigurl.0000001", { identifiers: { doi: "10.1234/a", pmid: null, pmcid: null }, canonicalUrl: "https://example.org/same" });
    const right = src("src-ambigurl.0000002", { identifiers: { doi: "10.1234/b", pmid: null, pmcid: null }, canonicalUrl: "https://example.org/same" });
    const result = mergeSourceRecords([], [left, right]);
    expect(result.aliases).toEqual({});
    expect(result.conflicts).toContainEqual(expect.objectContaining({ code: "source.ambiguous-identity", field: "canonicalUrl" }));
    expect(result.sources).toHaveLength(2);
  });

  test("quarantines ambiguous identity bridges instead of collapsing sources", () => {
    const a = src("src-bridge.a0000001", { identifiers: { doi: DOI, pmid: null, pmcid: null } });
    const b = src("src-bridge.b0000001", { identifiers: { doi: null, pmid: PMID, pmcid: null } });
    const bridge = src("src-bridge.c0000001", { identifiers: { doi: DOI, pmid: PMID, pmcid: null } });
    const result = mergeSourceRecords([a, b], [bridge]);
    expect(result.aliases).toEqual({});
    expect(result.conflicts.some(({ code }) => code === "source.ambiguous-identity")).toBe(true);
    expect(result.sources.map(({ sourceId }) => sourceId)).toEqual([a.sourceId, b.sourceId]);
  });

  test("fills only null metadata with matching retrieval provenance", () => {
    const base = src("src-fillmeta.0000001", { identifiers: { doi: DOI, pmid: null, pmcid: null }, title: "Stable", publisher: null });
    const incoming = src("src-fillnew.00000001", {
      identifiers: { doi: DOI, pmid: null, pmcid: null }, title: "Changed", publisher: "Publisher",
      retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "publisher", provider: "openalex", requestId: REQUEST_A }],
    });
    const filled = mergeSourceRecords([base], [incoming]);
    const latest = filled.sources.at(-1)!;
    expect(latest.publisher).toBe("Publisher");
    expect(latest.title).toBe("Stable");
    const unproven = mergeSourceRecords([base], [{ ...incoming, sourceId: "src-fillnew.00000002", metadataProvenance: [] }]);
    expect(unproven.sources.at(-1)!.publisher).toBeNull();

    const undated = src("src-published.000001", {
      identifiers: { doi: "10.1234/published", pmid: null, pmcid: null },
      published: { date: null, precision: "unknown" },
    });
    const dated = src("src-published.000002", {
      identifiers: undated.identifiers,
      published: { date: "2025-04-03", precision: "day" },
      retrievalRequestIds: [REQUEST_A],
      metadataProvenance: [{ field: "published.date", provider: "openalex", requestId: REQUEST_A }],
    });
    expect(mergeSourceRecords([undated], [dated]).sources.at(-1)!.published).toEqual({ date: "2025-04-03", precision: "day" });
    expect(mergeSourceRecords([undated], [{ ...dated, sourceId: "src-published.000003", metadataProvenance: [] }]).sources.at(-1)!.published)
      .toEqual({ date: null, precision: "unknown" });
    const established = { ...undated, published: { date: "2024-01", precision: "month" as const } };
    const conflict = mergeSourceRecords([established], [{ ...dated, sourceId: "src-published.000004" }]);
    expect(conflict.sources.at(-1)!.published).toEqual(established.published);
    expect(conflict.conflicts).toContainEqual(expect.objectContaining({ code: "source.metadata-conflict", field: "published" }));
  });

  test("discloses scalar and lineage conflicts without inventing metadata", () => {
    const base = src("src-conflict.0000001", { identifiers: { doi: DOI, pmid: null, pmcid: null }, title: "Existing", lineage: { studyId: "study-a", cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] } });
    const candidate = src("src-conflict.0000002", { identifiers: { doi: DOI, pmid: null, pmcid: null }, title: "Incoming", lineage: { studyId: "study-b", cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] } });
    const result = mergeSourceRecords([base], [{ ...candidate, accessLevel: "full-text", peerReviewStatus: "yes" }]);
    expect(result.conflicts.map(({ code }) => code)).toEqual(expect.arrayContaining(["source.metadata-conflict", "source.lineage-conflict"]));
    expect(result.sources.at(-1)!.title).toBe("Existing");
    expect(result.sources.at(-1)!.lineage.studyId).toBe("study-a");
    expect(result.sources.at(-1)!.accessLevel).toBe("full-text");
    expect(result.sources.at(-1)!.peerReviewStatus).toBe("yes");
    const peerConflict = mergeSourceRecords(result.sources, [{ ...candidate, sourceId: "src-conflict.0000003", peerReviewStatus: "no" }]);
    expect(peerConflict.conflicts).toContainEqual(expect.objectContaining({ code: "source.metadata-conflict", field: "peerReviewStatus" }));
    expect(JSON.stringify(result.conflicts)).not.toContain("Incoming");
  });

  test("retains immutable IDs and emits exactly one contiguous revision", () => {
    const base = src("src-revision.0000001", { identifiers: { doi: DOI, pmid: null, pmcid: null }, publisher: null });
    const update = { ...base, revision: 2, publisher: "P", retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "publisher", provider: "openalex", requestId: REQUEST_A }] };
    const result = mergeSourceRecords([base], [update]);
    expect(result.sources.map(({ sourceId, revision }) => [sourceId, revision])).toEqual([[base.sourceId, 1], [base.sourceId, 2]]);
    expect(result.changedSourceRefs).toEqual([{ sourceId: base.sourceId, revision: 2 }]);
    expect(errorCode(() => mergeSourceRecords([base], [{ ...update, revision: 3 }]))).toBe("source.revision-gap");
    expect(errorCode(() => mergeSourceRecords([base], [{ ...update, identifiers: { doi: "10.1234/changed", pmid: null, pmcid: null } }]))).toBe("source.invalid-input");
    const historicalA = { ...base, revision: 1, identifiers: { doi: "10.1234/a", pmid: null, pmcid: null } };
    const historicalNull = { ...base, revision: 2, identifiers: { doi: null, pmid: null, pmcid: null } };
    const historicalB = { ...base, revision: 3, identifiers: { doi: "10.1234/b", pmid: null, pmcid: null } };
    expect(errorCode(() => mergeSourceRecords([historicalB, historicalA, historicalNull], []))).toBe("source.invalid-input");
    expect(errorCode(() => mergeSourceRecords([historicalNull, historicalA], [historicalB]))).toBe("source.invalid-input");
    const nullFirst = { ...base, revision: 1, identifiers: { doi: null, pmid: null, pmcid: null } };
    const stableA2 = { ...base, revision: 2, identifiers: { doi: "10.1234/a", pmid: null, pmcid: null } };
    const stableA3 = { ...base, revision: 3, identifiers: { doi: "10.1234/a", pmid: null, pmcid: null } };
    expect(mergeSourceRecords([stableA3, nullFirst, stableA2], []).sources.map(({ revision }) => revision)).toEqual([1, 2, 3]);
    expect(mergeSourceRecords([historicalA, historicalNull, { ...historicalB, identifiers: historicalA.identifiers }], []).sources)
      .toHaveLength(3);

    const duplicate = { ...base, sourceId: "src-revision.0000002" };
    const noOp = mergeSourceRecords([base], [duplicate]);
    expect(noOp.aliases).toEqual({ [duplicate.sourceId]: base.sourceId });
    expect(noOp.changedSourceRefs).toEqual([]);
  });

  test("returns aliases and deeply frozen canonical arrays", () => {
    const a = src("src-frozen.00000001", { identifiers: { doi: DOI, pmid: null, pmcid: null } });
    const b = src("src-frozen.00000002", { identifiers: { doi: DOI, pmid: null, pmcid: null } });
    const result = mergeSourceRecords([], [a, b]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
    expect(Object.isFrozen(result.sources[0]!.authors)).toBe(true);
    expect(Object.isFrozen(result.aliases)).toBe(true);
    expect(() => { (result.sources as SourceRecord[]).push(a); }).toThrow();
  });

  test("bounds sources and provenance before grouping", () => {
    const a = src("src-bound.000000001");
    const b = src("src-bound.000000002");
    expect(errorCode(() => mergeSourceRecords([], [a, b], { maxSources: 1 }))).toBe("source.too-many-records");
    const crowded = { ...a, retrievalRequestIds: [REQUEST_A, REQUEST_B] };
    expect(errorCode(() => validateProspectiveSourceSemantics(crowded, { maxSources: 1, maxRequests: 1, maxProvenanceSteps: 1 })))
      .toBe("source.too-many-provenance-steps");
    expect(errorCode(() => buildRequestProvenanceIndex([a], [req(REQUEST_A, a.sourceId), req(REQUEST_B, a.sourceId)], { maxRequests: 1 })))
      .toBe("source.too-many-records");
  });

  test("builds one immutable request provenance index in linear visits", () => {
    const a = src("src-indexed.0000001", { canonicalUrl: "https://example.org/a", retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "canonicalUrl", provider: "openalex", requestId: REQUEST_A }] });
    const b = src("src-indexed.0000002", { canonicalUrl: "https://example.org/b", retrievalRequestIds: [REQUEST_B] });
    const requests = [req(REQUEST_A, a.sourceId, { finalUrl: "https://example.org/a" }), req(REQUEST_B, b.sourceId, { finalUrl: "https://example.org/b", redirectUrls: ["https://redirect.example.org/b"] })];
    const visits = diagnostics();
    const index = buildRequestProvenanceIndex([a, b], requests, undefined, visits);
    expect(visits).toEqual({ sourceVisits: 2, requestVisits: 2, requestUrlVisits: 5, metadataStepVisits: 1, witnessInsertions: 3 });
    const before = { ...visits };
    expect(validateSourceCanonicalUrlProvenance(a, index)).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "finalUrl" });
    expect(validateSourceCanonicalUrlProvenance(b, index)).toEqual({ kind: "transport-url", requestId: REQUEST_B, matchedField: "finalUrl" });
    expect(visits).toEqual(before);
    expect(Object.keys(index).sort()).toEqual(["optionsSha256", "policySha256", "requestCount", "sourceCount", "witnessCount"]);
    expect(Object.isFrozen(index)).toBe(true);
    expect(JSON.stringify(index)).not.toMatch(/example\.org|logical-|query/i);
    const internal = validatedProvenanceRecordsForSnapshot(index);
    expect(Object.isFrozen(internal.sources)).toBe(true);
    expect(internal.sourceCanonicalJson).toHaveLength(2);

    const manySources = Array.from({ length: 200 }, (_, index) => {
      const requestId = `request-${String(index + 100).padStart(16, "0")}`;
      return src(`src-many.${String(index).padStart(8, "0")}`, {
        canonicalUrl: `https://many.example/${index}`,
        retrievalRequestIds: [requestId],
        metadataProvenance: [{ field: "canonicalUrl", provider: "openalex", requestId }],
      });
    });
    const manyRequests = manySources.map((source, index) => req(source.retrievalRequestIds[0]!, source.sourceId, {
      finalUrl: source.canonicalUrl,
      requestedUrl: `https://api.example.org/many/${index}`,
    }));
    const manyVisits = diagnostics();
    const manyIndex = buildRequestProvenanceIndex(manySources, manyRequests, undefined, manyVisits);
    expect(manyVisits).toEqual({
      sourceVisits: 200, requestVisits: 200, requestUrlVisits: 400,
      metadataStepVisits: 200, witnessInsertions: 400,
    });
    const manyBefore = { ...manyVisits };
    expect(validateSourceCanonicalUrlProvenance(manySources[0]!, manyIndex)).toEqual({
      kind: "transport-url", requestId: manyRequests[0]!.requestId, matchedField: "finalUrl",
    });
    expect(validateSourceCanonicalUrlProvenance(manySources.at(-1)!, manyIndex)).toEqual({
      kind: "transport-url", requestId: manyRequests.at(-1)!.requestId, matchedField: "finalUrl",
    });
    expect(manyVisits).toEqual(manyBefore);
  });

  test("attributes canonical URL to a linked result transport URL", () => {
    const source = src("src-transport.000001", { canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [REQUEST_A] });
    const request = req(REQUEST_A, source.sourceId, { requestedUrl: "https://start.example.org/a", finalUrl: "https://article.example.org/a" });
    expect(validateSourceCanonicalUrlProvenanceOnce(source, [request])).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "finalUrl" });
    expect(validateSourceCanonicalUrlProvenanceOnce({ ...source, canonicalUrl: "https://start.example.org/a" }, [request])).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "requestedUrl" });
  });

  test("attributes provider-returned article URL to exact request and provider metadata provenance", () => {
    const source = src("src-provider.0000001", { canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "canonicalUrl", provider: "openalex", requestId: REQUEST_A }] });
    const request = req(REQUEST_A, source.sourceId, { requestedUrl: "https://api.example.org/search", finalUrl: "https://api.example.org/result" });
    expect(validateSourceCanonicalUrlProvenanceOnce(source, [request])).toEqual({ kind: "provider-metadata", requestId: REQUEST_A, provider: "openalex" });
  });

  test("rejects wrong provider request and terminal provider metadata provenance", () => {
    const source = src("src-providerbad.0001", { canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "canonicalUrl", provider: "crossref", requestId: REQUEST_A }] });
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(source, [req(REQUEST_A, source.sourceId)]))).toBe("source.url-metadata-mismatch");
    const terminal = req(REQUEST_A, source.sourceId, { provider: "crossref", status: "terminal-error", httpStatus: 400, errorClass: "bad" });
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(source, [terminal]))).toBe("source.url-request-mismatch");
  });

  test("attributes canonical URL only to allowlisted identifier resolvers", () => {
    const doi = src("src-resolver.0000001", { identifiers: { doi: DOI, pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/shared" });
    expect(validateSourceCanonicalUrlProvenanceOnce(doi, [])).toEqual({ kind: "identifier-resolver", identifierKind: "doi" });
    const arbitrary = { ...doi, canonicalUrl: "https://publisher.example.org/paper" };
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(arbitrary, []))).toBe("source.url-unattributed");
    for (const identifiers of [
      { doi: "10.1234/a", pmid: null, pmcid: null },
      { doi: null, pmid: "123", pmcid: null },
      { doi: null, pmid: null, pmcid: "PMC123" },
    ]) {
      const shortUrl = src("src-resolverlow.0001", { identifiers, canonicalUrl: "https://x.co/a" });
      expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(shortUrl, [], { maxCanonicalScalarBytes: 20 })))
        .toBe("source.invalid-input");
    }
  });

  test("chooses one canonical provenance witness independent of request redirect and metadata order", () => {
    const metadata = [
      { field: "canonicalUrl", provider: "openalex", requestId: REQUEST_B },
      { field: "title", provider: "openalex", requestId: REQUEST_A },
      { field: "authors", provider: "openalex", requestId: REQUEST_B },
    ];
    const source = src("src-ordering.0000001", {
      canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [REQUEST_B, REQUEST_A], metadataProvenance: metadata,
    });
    const a = req(REQUEST_A, source.sourceId, { finalUrl: null, requestedUrl: "https://article.example.org/a", redirectUrls: ["https://article.example.org/a"] });
    const b = req(REQUEST_B, source.sourceId, { finalUrl: "https://article.example.org/a", requestedUrl: "https://article.example.org/a", redirectUrls: ["https://z.example.org", "https://article.example.org/a"] });
    const requestPermutations = [
      [b, a], [a, b], [{ ...a, redirectUrls: [...a.redirectUrls].reverse() }, b],
      [b, { ...a, redirectUrls: ["https://article.example.org/a", "https://article.example.org/a"] }],
      [{ ...b, redirectUrls: [...b.redirectUrls].reverse() }, a],
      [{ ...a, redirectUrls: [] }, { ...b, redirectUrls: [...b.redirectUrls].reverse() }],
    ];
    const metadataPermutations = [
      metadata, [metadata[0]!, metadata[2]!, metadata[1]!], [metadata[1]!, metadata[0]!, metadata[2]!],
      [metadata[1]!, metadata[2]!, metadata[0]!], [metadata[2]!, metadata[0]!, metadata[1]!], [...metadata].reverse(),
    ];
    const selectedWitnesses: string[] = [];
    for (let index = 0; index < requestPermutations.length; index += 1) {
      const witness = validateSourceCanonicalUrlProvenanceOnce(
        { ...source, metadataProvenance: metadataPermutations[index]! }, requestPermutations[index]!,
      );
      expect(witness).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "requestedUrl" });
      selectedWitnesses.push(canonicalJson(witness));
    }
    expect(new Set(selectedWitnesses).size).toBe(1);
    const redirectOnly = src("src-redirect.0000001", {
      canonicalUrl: "https://redirect.example.org/article", retrievalRequestIds: [REQUEST_A],
    });
    expect(validateSourceCanonicalUrlProvenanceOnce(redirectOnly, [req(REQUEST_A, redirectOnly.sourceId, {
      requestedUrl: "https://start.example.org/article", finalUrl: "https://final.example.org/article",
      redirectUrls: ["https://redirect.example.org/article"],
    })])).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "redirectUrls" });
  });

  test("chooses resolver then transport then provider metadata route deterministically", () => {
    const resolver = src("src-rank.000000001", { identifiers: { doi: DOI, pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/shared", retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "canonicalUrl", provider: "openalex", requestId: REQUEST_A }] });
    expect(validateSourceCanonicalUrlProvenanceOnce(resolver, [req(REQUEST_A, resolver.sourceId, { finalUrl: resolver.canonicalUrl })])).toEqual({ kind: "identifier-resolver", identifierKind: "doi" });
    const transport = { ...resolver, identifiers: { doi: null, pmid: null, pmcid: null } };
    expect(validateSourceCanonicalUrlProvenanceOnce(transport, [req(REQUEST_A, transport.sourceId, { finalUrl: transport.canonicalUrl })])).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "finalUrl" });
  });

  test("orders URL failures as unsafe invalid-status-or-link provider then missing independent of input order", () => {
    const unsafe = src("src-failure.0000001", { canonicalUrl: "http://blocked.example.org/a", retrievalRequestIds: [REQUEST_A] });
    const unsafeRequests = [req(REQUEST_A, unsafe.sourceId, { status: "terminal-error" }), req(REQUEST_B, unsafe.sourceId)];
    for (const requests of [unsafeRequests, [...unsafeRequests].reverse()])
      expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(unsafe, requests))).toBe("source.url-policy-invalid");

    const source = src("src-failure.0000002", {
      canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [REQUEST_B, REQUEST_A],
      metadataProvenance: [{ field: "canonicalUrl", provider: "crossref", requestId: REQUEST_B }],
    });
    const invalid = req(REQUEST_A, source.sourceId, { status: "terminal-error", httpStatus: 400, errorClass: "terminal", finalUrl: "https://other.example.org/a" });
    const wrongProvider = req(REQUEST_B, source.sourceId, { provider: "openalex", finalUrl: "https://other.example.org/b" });
    const failurePermutations = [
      [invalid, wrongProvider], [wrongProvider, invalid],
      [{ ...invalid, redirectUrls: ["https://x.example/a"] }, wrongProvider],
      [wrongProvider, { ...invalid, redirectUrls: ["https://y.example/a", "https://x.example/a"] }],
      [{ ...wrongProvider, redirectUrls: [] }, invalid],
      [{ ...invalid, redirectUrls: [] }, { ...wrongProvider, redirectUrls: ["https://z.example/a"] }],
    ];
    for (const requests of failurePermutations)
      expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(source, requests))).toBe("source.url-request-mismatch");

    const provider = { ...source, retrievalRequestIds: [REQUEST_B], metadataProvenance: source.metadataProvenance };
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(provider, [wrongProvider]))).toBe("source.url-metadata-mismatch");
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce({ ...source, retrievalRequestIds: [], metadataProvenance: [] }, [])))
      .toBe("source.url-unattributed");
  });

  test("rejects unlinked mismatched and arbitrary canonical URL provenance", () => {
    const source = src("src-unlinked.0000001", { canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [REQUEST_A] });
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(source, [req(REQUEST_A, "src-other.000000001")]))).toBe("source.url-request-mismatch");
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce({ ...source, retrievalRequestIds: [] }, [req(REQUEST_A, source.sourceId)]))).toBe("source.url-unattributed");
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(source, [req(REQUEST_A, source.sourceId, { finalUrl: "https://other.example.org" })]))).toBe("source.url-unattributed");
  });

  test("prospective source semantics reject malformed provenance and parallel lineage arrays", () => {
    const base = src("src-semantics.000001", { retrievalRequestIds: [REQUEST_A], metadataProvenance: [{ field: "title", provider: "openalex", requestId: REQUEST_A }] });
    expect(validateProspectiveSourceSemantics(base)).toEqual(base);
    expect(errorCode(() => validateProspectiveSourceSemantics({ ...base, retrievalRequestIds: [REQUEST_A, REQUEST_A] }))).toBe("source.invalid-provenance");
    expect(errorCode(() => validateProspectiveSourceSemantics({ ...base, metadataProvenance: [{ field: "unknown", provider: "openalex", requestId: REQUEST_A }] }))).toBe("source.invalid-provenance");
    expect(errorCode(() => validateProspectiveSourceSemantics({ ...base, lineage: { ...base.lineage, relatedSourceIds: ["src-related.0000001"] } }))).toBe("source.invalid-lineage");
  });

  test("bounds canonical source request and aggregate bytes before grouping", () => {
    const source = src("src-bytes.000000001", { title: "\"".repeat(300) });
    const bytes = Buffer.byteLength(canonicalJson(source));
    expect(validateProspectiveSourceSemantics(source, { maxCanonicalScalarBytes: 128, maxSourceRecordCanonicalBytes: bytes })).toEqual(source);
    expect(errorCode(() => validateProspectiveSourceSemantics(source, {
      maxCanonicalScalarBytes: 128, maxSourceRecordCanonicalBytes: bytes - 1,
    }))).toBe("source.record-too-large");
    const request = req(REQUEST_A, source.sourceId, { normalizedInput: { query: "q".repeat(300), identifier: null, url: null, parameters: [] } });
    const requestBytes = Buffer.byteLength(canonicalJson(request));
    expect(buildRequestProvenanceIndex([source], [request], {
      maxCanonicalScalarBytes: 128, maxRequestRecordCanonicalBytes: requestBytes,
    })).toBeDefined();
    expect(errorCode(() => buildRequestProvenanceIndex([source], [request], {
      maxCanonicalScalarBytes: 128, maxRequestRecordCanonicalBytes: requestBytes - 1,
    }))).toBe("source.record-too-large");
    const aggregateBytes = Buffer.byteLength(canonicalJson({ existing: [], incoming: [source] }));
    expect(errorCode(() => mergeSourceRecords([], [source], {
      maxCanonicalScalarBytes: 128,
      maxSourceRecordCanonicalBytes: bytes,
      maxRequestRecordCanonicalBytes: 128,
      maxAggregateCanonicalBytes: aggregateBytes - 1,
    }))).toBe("source.input-too-large");

    const exactSource = src("src-wrapper.0000001", { canonicalUrl: "https://article.example/a", retrievalRequestIds: [REQUEST_A] });
    const exactRequest = req(REQUEST_A, exactSource.sourceId, { finalUrl: exactSource.canonicalUrl });
    const sourceBytes = Buffer.byteLength(canonicalJson(exactSource));
    const exactRequestBytes = Buffer.byteLength(canonicalJson(exactRequest));
    const singleWrapperBytes = Buffer.byteLength(canonicalJson({ source: exactSource, requests: [exactRequest] }));
    const multiWrapperBytes = Buffer.byteLength(canonicalJson({ sources: [exactSource], requests: [exactRequest] }));
    expect(multiWrapperBytes).toBeGreaterThan(singleWrapperBytes);
    const wrapperOptions = {
      maxCanonicalScalarBytes: 128,
      maxSourceRecordCanonicalBytes: sourceBytes,
      maxRequestRecordCanonicalBytes: exactRequestBytes,
      maxAggregateCanonicalBytes: singleWrapperBytes,
    };
    expect(validateSourceCanonicalUrlProvenanceOnce(exactSource, [exactRequest], wrapperOptions)).toEqual({
      kind: "transport-url", requestId: REQUEST_A, matchedField: "finalUrl",
    });
    expect(errorCode(() => buildRequestProvenanceIndex([exactSource], [exactRequest], wrapperOptions))).toBe("source.input-too-large");
  });

  test("rejects oversized title metadata request query and nested strings", () => {
    const source = src("src-oversized.00001", { title: "x".repeat(2_000), metadataProvenance: [{ field: "title", provider: "p".repeat(2_000), requestId: REQUEST_A }], retrievalRequestIds: [REQUEST_A] });
    expect(errorCode(() => validateProspectiveSourceSemantics(source, {
      maxCanonicalScalarBytes: 128, maxSourceRecordCanonicalBytes: 1_000,
    }))).toBe("source.record-too-large");
    const request = req(REQUEST_A, source.sourceId, { normalizedInput: { query: "q".repeat(2_000), identifier: null, url: null, parameters: [{ name: "n", value: "v".repeat(2_000) }] } });
    expect(errorCode(() => buildRequestProvenanceIndex([src("src-request.0000001")], [request], {
      maxCanonicalScalarBytes: 128, maxRequestRecordCanonicalBytes: 1_000,
    }))).toBe("source.record-too-large");
  });

  test("rejects source policy and option hash mismatch against provenance index", () => {
    const source = src("src-policy.00000001", { canonicalUrl: "http://trusted.example.org/a", retrievalRequestIds: [REQUEST_A] });
    const policy = { allowHttp: true, approvedHttpHosts: ["trusted.example.org"], accessPolicySha256: HASH } as const;
    const request = req(REQUEST_A, source.sourceId, { requestedUrl: source.canonicalUrl, finalUrl: source.canonicalUrl });
    const index = buildRequestProvenanceIndex([source], [request], { sourceUrlPolicy: policy });
    expect(validateSourceCanonicalUrlProvenance(source, index)).toEqual({ kind: "transport-url", requestId: REQUEST_A, matchedField: "finalUrl" });
    const reversedPolicy = { ...policy, approvedHttpHosts: ["unused.example.org", "trusted.example.org"] };
    const forwardPolicy = { ...policy, approvedHttpHosts: ["trusted.example.org", "unused.example.org"] };
    const forwardIndex = buildRequestProvenanceIndex([source], [request], { sourceUrlPolicy: forwardPolicy, maxSources: 10 });
    const reversedIndex = buildRequestProvenanceIndex([source], [request], { sourceUrlPolicy: reversedPolicy, maxSources: 10 });
    expect(forwardIndex.policySha256).toBe(reversedIndex.policySha256);
    expect(forwardIndex.optionsSha256).toBe(reversedIndex.optionsSha256);
    expect(buildRequestProvenanceIndex([source], [request], { sourceUrlPolicy: policy, maxSources: 11 }).optionsSha256)
      .not.toBe(index.optionsSha256);
    expect(errorCode(() => validateSourceCanonicalUrlProvenanceOnce(source, [{ ...request, accessPolicySha256: "b".repeat(64) }], { sourceUrlPolicy: policy })))
      .toBe("source.url-request-mismatch");
    expect(errorCode(() => validateSourceCanonicalUrlProvenance({ ...source, title: "changed" }, index))).toBe("source.provenance-index-mismatch");
    expect(errorCode(() => validateSourceCanonicalUrlProvenance(source, Object.freeze({ ...index, optionsSha256: "b".repeat(64) })))).toBe("source.provenance-index-mismatch");
  });

  test("rejects invalid merge key and byte limits with source.invalid-options", () => {
    const source = src("src-options.0000001");
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const invalid of [
      { maxCanonicalScalarBytes: 1_001, maxSourceRecordCanonicalBytes: 1_000 },
      { maxCanonicalScalarBytes: 1_001, maxRequestRecordCanonicalBytes: 1_000 },
      { maxSourceRecordCanonicalBytes: 2_001, maxAggregateCanonicalBytes: 2_000 },
      { maxRequestRecordCanonicalBytes: 2_001, maxAggregateCanonicalBytes: 2_000 },
      { maxSources: 2, maxRequests: 1, maxProvenanceSteps: 1 },
      { maxSources: 1, maxRequests: 2, maxProvenanceSteps: 1 },
      { maxSources: 0 }, { maxSources: 100_001 }, { maxRequests: 500_001 }, { maxProvenanceSteps: 1_000_001 },
      { maxCanonicalScalarBytes: 16_385 }, { maxSourceRecordCanonicalBytes: 1_048_577 },
      { maxRequestRecordCanonicalBytes: 1_048_577 }, { maxAggregateCanonicalBytes: 67_108_865 }, { unknown: 1 },
      new Proxy({}, {}), { get maxSources() { return 1; } }, cyclic, { sourceUrlPolicy: new Proxy({}, {}) },
    ]) expect(errorCode(() => sourceIdentityKeys(source, invalid as never))).toBe("source.invalid-options");
    let inputRead = false;
    const unreadableSource = new Proxy(source, { get() { inputRead = true; throw new Error("input read"); } });
    expect(errorCode(() => sourceIdentityKeys(unreadableSource, {
      maxCanonicalScalarBytes: 2_000, maxSourceRecordCanonicalBytes: 1_000,
    }))).toBe("source.invalid-options");
    expect(inputRead).toBe(false);
    expect(errorCode(() => sourceIdentityKeys(unreadableSource, {
      get maxCanonicalScalarBytes() { return 4_096; },
    }))).toBe("source.invalid-options");
    expect(inputRead).toBe(false);
  });

  test("reports exact closed SourceIdentityError codes", () => {
    expect(sourceIdentityKeys(src("src-keys.000000001", { identifiers: { doi: DOI, pmid: PMID, pmcid: "PMC123" }, canonicalUrl: "https://example.org/key" })))
      .toEqual([`doi:${DOI}`, `pmid:${PMID}`, "pmcid:PMC123", "url:https://example.org/key"]);
    expect(errorCode(() => mergeSourceRecords([src("src-duplicate.00001"), src("src-duplicate.00001")], [])))
      .toBe("source.duplicate-revision");
    const forged = Object.freeze({ sourceCount: 0, requestCount: 0, witnessCount: 0, optionsSha256: HASH, policySha256: HASH }) as RequestProvenanceIndex;
    expect(errorCode(() => validateSourceCanonicalUrlProvenance(src("src-forged.0000001"), forged))).toBe("source.provenance-index-mismatch");
    expect(errorCode(() => validatedProvenanceRecordsForSnapshot(forged))).toBe("source.provenance-index-mismatch");
    expect(errorCode(() => validateProspectiveSourceSemantics(1 as never))).toBe("source.invalid-input");
  });
});
