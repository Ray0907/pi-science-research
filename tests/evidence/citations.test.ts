import { describe, expect, test } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import type { RequestRecord } from "../../src/domain/events.js";
import { canonicalDoiUrl, canonicalPmcidUrl, canonicalPmidUrl } from "../../src/scholarly/identifiers.js";
import type { ClaimRecord, EvidenceRecord, SourceRecord } from "../../src/domain/research-records.js";
import {
  buildBoundedValidatedEvidenceSnapshot, type BoundedValidatedEvidenceSnapshot, type CanonicalEvidenceSet,
  type EvidenceSnapshotDiagnostics, type EvidenceSnapshotOptions,
} from "../../src/evidence/admission.js";
import {
  CitationError, assignCitationMappings, assignCitationMappingsFromRecords,
  type CitationBinding, type CitationOptions,
} from "../../src/evidence/citations.js";

const AT = "2026-08-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const ATTEMPT = "attempt-0000000000000001";
function source(id = "src-citation.000001", overrides: Partial<SourceRecord> = {}): SourceRecord { const doi = `10.1234/${id}`; return {
  schemaVersion: 1, sourceId: id, revision: 1, identifiers: { doi, pmid: null, pmcid: null }, canonicalUrl: canonicalDoiUrl(doi),
  title: `Title ${id}`, authors: [], containerTitle: null, publisher: null, volume: null, issue: null, pages: null,
  published: { date: null, precision: "unknown" }, publicationType: "journal-article", peerReviewStatus: "unknown", accessLevel: "full-text",
  retrievedAt: AT, retrievalRequestIds: [], metadataProvenance: [], lineage: { studyId: `study-${id}`, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] }, ...overrides,
}; }
function claim(id = "claim-0000000000000001", overrides: Partial<ClaimRecord> = {}): ClaimRecord { return {
  schemaVersion: 1, claimId: id, revision: 1, statement: id, kind: "externally-verifiable-fact", materiality: "load-bearing",
  scopeQualifiers: { population: null, intervention: null, comparator: null, outcome: null, timeRange: null },
  evidenceRule: { minimumLineages: 1, independentVerificationAllowed: false, primarySourceRequired: false, fullTextRequired: false },
  status: "supported", confidence: 0.8, evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }], conflictClaimIds: [], createdByAttemptId: ATTEMPT, ...overrides,
}; }
function evidence(id = "ev-0000000000000001", overrides: Partial<EvidenceRecord> = {}): EvidenceRecord { return {
  schemaVersion: 1, evidenceId: id, revision: 1, claimRef: { claimId: "claim-0000000000000001", revision: 1 },
  sourceRef: { sourceId: "src-citation.000001", revision: 1 }, calculationId: null, stance: "supporting", evidenceType: "retrieved", quality: "primary-peer-reviewed", verificationStatus: "verified",
  quotes: ["quote"], locators: [{ type: "page", value: "1" }], extractedValues: [], method: null, confidence: 0.9, conflictsWith: [], recordedByAttemptId: ATTEMPT, ...overrides,
}; }
function request(id = "request-0000000000000001", sourceId = "src-citation.000001", overrides: Partial<RequestRecord> = {}): RequestRecord { return {
  schemaVersion: 1, requestId: id, attemptId: ATTEMPT, executionEpoch: 0, logicalRequestId: `logical-${id}`, physicalAttemptOrdinal: 1,
  retryOfRequestId: null, replayPolicy: "safe-read", provider: "openalex", operation: "fetch",
  normalizedInput: { query: null, identifier: null, url: "https://api.example.org/a", parameters: [] }, accessPolicySha256: HASH,
  startedAt: AT, endedAt: AT, status: "success", httpStatus: 200, requestedUrl: "https://api.example.org/a", finalUrl: "https://api.example.org/a",
  redirectUrls: [], responseSha256: null, responseFile: null, encodedBytes: 0, decodedBytes: 0, resultSourceIds: [sourceId], errorClass: null, ...overrides,
}; }
function records(overrides: Partial<CanonicalEvidenceSet> = {}): CanonicalEvidenceSet { return { sources: [source()], claims: [claim()], evidence: [evidence()], verifications: [], requests: [], calculations: [], ...overrides }; }
function snapshot(value = records(), options?: EvidenceSnapshotOptions, diagnostics?: EvidenceSnapshotDiagnostics): BoundedValidatedEvidenceSnapshot { return buildBoundedValidatedEvidenceSnapshot(value, options, diagnostics); }
function sourceRef(value = source()) { return { sourceId: value.sourceId, revision: value.revision }; }
function claimRef(value = claim()) { return { claimId: value.claimId, revision: value.revision }; }
function evidenceRef(value = evidence()) { return { evidenceId: value.evidenceId, revision: value.revision }; }
function binding(overrides: Partial<CitationBinding> = {}): CitationBinding { return { sourceRef: sourceRef(), claimRefs: [claimRef()], evidenceRefs: [evidenceRef()], ...overrides }; }
function diagnostics(): EvidenceSnapshotDiagnostics { return { canonicalRecordVisits: 0, referenceVisits: 0, revisionIndexInsertions: 0, sourceIdentityVisits: 0, lineageVisits: 0, requestRecordsIndexed: 0, requestUrlVisits: 0, metadataStepVisits: 0 }; }
function errorCode(action: () => unknown): string | undefined { try { action(); } catch (error) { expect(error).toBeInstanceOf(CitationError); expect((error as Error).message).toMatch(/^Citation mapping rejected \(citation\.[a-z-]+\)$/u); expect((error as Error).message).not.toMatch(/SECRET|doi\.org|quote|logical-/u); return (error as CitationError).code; } return undefined; }

const names = [
  "assigns contiguous numbers by explicit first appearance",
  "deduplicates one source while retaining sorted claim and evidence links",
  "resolves historical refs and rejects ambiguous cross-source and unresolved bindings",
  "accepts supporting contradicting and neutral evidence with exact claim and source refs",
  "rejects only mismatched citation claim source or revision refs",
  "retains disconfirmation evidence in citation mappings",
  "does not require unrelated unbound factual records before report finalization",
  "requires cited canonical URL provenance from linked transport metadata or resolvers",
  "accepts provider-returned article URL only with exact request and provider provenance",
  "rejects arbitrary and unapproved HTTP citation URLs with exact codes",
  "projects complete available metadata without inventing fields",
  "preserves null metadata Unicode authors and canonical identifiers",
  "consumes internal snapshot lookup views without rebuilding indexes",
  "keeps snapshot diagnostics unchanged across repeated citation access",
  "consumes one bounded validated snapshot without recanonicalizing or rebuilding provenance",
  "rejects forged or hash-mismatched snapshot with citation.invalid-input",
  "one-shot citation wrapper builds exactly one full six-kind snapshot",
  "bounds citations bindings links refs and canonical bytes before allocation",
  "binds citation results to snapshot option and policy hashes",
  "rejects invalid citation options with citation.invalid-options",
  "bounds citations and links and returns deeply frozen output",
  "reports exact closed CitationError codes",
] as const;

describe("citation mappings", () => {
  test(names[0], () => {
    const a = source(); const b = source("src-citation.000002"); const set = records({ sources: [a, b] });
    const result = assignCitationMappings(snapshot(set), [sourceRef(b), sourceRef(a), sourceRef(b)], []);
    expect(result.citations.map((item) => [item.citationNumber, item.sourceRef.sourceId])).toEqual([[1, b.sourceId], [2, a.sourceId]]); expect(assignCitationMappings(snapshot(set), [], [])).toEqual({ citations: [], bibliography: [] });
  });
  test(names[1], () => {
    const e2 = evidence("ev-0000000000000002"); const c2 = claim("claim-0000000000000002", { evidenceRefs: [{ evidenceId: e2.evidenceId, revision: 1 }] });
    const set = records({ claims: [claim(), c2], evidence: [evidence(), { ...e2, claimRef: claimRef(c2) }] });
    const result = assignCitationMappings(snapshot(set), [sourceRef(), sourceRef()], [binding({ claimRefs: [claimRef(c2)] , evidenceRefs: [evidenceRef({ ...e2, claimRef: claimRef(c2) })] }), binding()]);
    expect(result.citations[0]!.claimRefs.map((item) => item.claimId)).toEqual([claim().claimId, c2.claimId]); expect(result.citations).toHaveLength(1);
    const reversed = assignCitationMappings(snapshot(set), [sourceRef()], [binding(), binding({ claimRefs: [claimRef(c2)], evidenceRefs: [evidenceRef({ ...e2, claimRef: claimRef(c2) })] })]); expect(canonicalJson(result)).toBe(canonicalJson(reversed));
  });
  test(names[2], () => {
    const first = source(); const second = { ...first, revision: 2, title: "revision two" }; const set = records({ sources: [first, second] });
    expect(assignCitationMappings(snapshot(set), [sourceRef(first)], []).bibliography[0]!.title).toBe(first.title);
    const evidenceTwo = { ...evidence(), revision: 2, claimRef: { claimId: claim().claimId, revision: 2 }, sourceRef: { sourceId: first.sourceId, revision: 2 } }; const claimTwo = { ...claim(), revision: 2, evidenceRefs: [{ evidenceId: evidenceTwo.evidenceId, revision: 2 }] };
    const historicalSet = records({ sources: [first, second], claims: [claim(), claimTwo], evidence: [evidence(), evidenceTwo] }); const historical = assignCitationMappings(snapshot(historicalSet), [sourceRef(first)], [binding()]); expect(historical.citations[0]!.evidenceRefs[0]!.revision).toBe(1);
    expect(errorCode(() => assignCitationMappings(snapshot(set), [sourceRef(first), sourceRef(second)], []))).toBe("citation.ambiguous-source-revision");
    expect(errorCode(() => assignCitationMappings(snapshot(), [{ sourceId: "src-citation.missing", revision: 1 }], []))).toBe("citation.unresolved-ref");
  });
  test(names[3], () => {
    for (const stance of ["supporting", "contradicting", "neutral"] as const) { const e = evidence(undefined, { stance }); const result = assignCitationMappings(snapshot(records({ evidence: [e] })), [sourceRef()], [binding({ evidenceRefs: [evidenceRef(e)] })]); expect(result.citations[0]!.evidenceRefs).toHaveLength(1); }
  });
  test(names[4], () => {
    const otherSource = source("src-citation.000002"); const otherClaim = claim("claim-0000000000000002", { evidenceRefs: [] }); const set = records({ sources: [source(), otherSource], claims: [claim(), otherClaim] });
    expect(errorCode(() => assignCitationMappings(snapshot(set), [sourceRef()], [binding({ claimRefs: [claimRef(otherClaim)], evidenceRefs: [] })]))).toBeUndefined();
    expect(errorCode(() => assignCitationMappings(snapshot(set), [sourceRef()], [binding({ claimRefs: [claimRef(otherClaim)], evidenceRefs: [evidenceRef()] })]))).toBe("citation.claim-mismatch");
    expect(errorCode(() => assignCitationMappings(snapshot(set), [sourceRef(otherSource)], [binding({ sourceRef: sourceRef(otherSource) })]))).toBe("citation.cross-source-evidence");
  });
  test(names[5], () => { const e = evidence(undefined, { stance: "contradicting", verificationStatus: "rejected" }); expect(assignCitationMappings(snapshot(records({ evidence: [e] })), [sourceRef()], [binding()]).citations[0]!.evidenceRefs).toHaveLength(1); });
  test(names[6], () => {
    const extraSource = source("src-citation.000002"); const extraClaim = claim("claim-0000000000000002", { evidenceRefs: [] });
    const result = assignCitationMappings(snapshot(records({ sources: [source(), extraSource], claims: [claim(), extraClaim] })), [sourceRef()], [binding()]); expect(result.citations).toHaveLength(1);
  });
  test(names[7], () => {
    const transport = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [request().requestId] });
    const req = request(undefined, transport.sourceId, { finalUrl: transport.canonicalUrl }); const set = records({ sources: [transport], evidence: [evidence(undefined, { sourceRef: sourceRef(transport) })], requests: [req] });
    expect(assignCitationMappings(snapshot(set), [sourceRef(transport)], [binding({ sourceRef: sourceRef(transport) })]).citations).toHaveLength(1);
    for (const [canonicalUrl, requestOverrides] of [["https://start.example.org/a", { requestedUrl: "https://start.example.org/a", finalUrl: "https://final.example.org/a" }], ["https://redirect.example.org/a", { requestedUrl: "https://start.example.org/a", finalUrl: "https://final.example.org/a", redirectUrls: ["https://redirect.example.org/a"] }]] as Array<[string, Partial<RequestRecord>]>) { const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl, retrievalRequestIds: [request().requestId] }); const r = request(undefined, s.sourceId, requestOverrides); const value = records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })], requests: [r] }); expect(assignCitationMappings(snapshot(value), [sourceRef(s)], []).citations).toHaveLength(1); }
    for (const [identifiers, canonicalUrl] of [[{ doi: "10.1234/a", pmid: null, pmcid: null }, canonicalDoiUrl("10.1234/a")], [{ doi: null, pmid: "123", pmcid: null }, canonicalPmidUrl("123")], [{ doi: null, pmid: null, pmcid: "PMC123" }, canonicalPmcidUrl("PMC123")]] as const) {
      const s = source(undefined, { identifiers, canonicalUrl }); const value = records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })] }); expect(assignCitationMappings(snapshot(value), [sourceRef(s)], [binding({ sourceRef: sourceRef(s) })]).citations).toHaveLength(1);
    }
  });
  test(names[8], () => {
    const req = request(); const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://article.example.org/a", retrievalRequestIds: [req.requestId], metadataProvenance: [{ field: "canonicalUrl", provider: req.provider, requestId: req.requestId }] });
    const value = records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })], requests: [request(undefined, s.sourceId)] }); expect(assignCitationMappings(snapshot(value), [sourceRef(s)], [binding({ sourceRef: sourceRef(s) })]).citations).toHaveLength(1);
    const wrong = { ...s, metadataProvenance: [{ field: "canonicalUrl", provider: "crossref", requestId: req.requestId }] }; expect(errorCode(() => assignCitationMappingsFromRecords(records({ sources: [wrong], evidence: [evidence(undefined, { sourceRef: sourceRef(wrong) })], requests: [request(undefined, wrong.sourceId)] }), [sourceRef(wrong)], []))).toBe("citation.source-url-metadata-mismatch");
    const terminal = request(undefined, s.sourceId, { status: "terminal-error", httpStatus: 400, errorClass: "bad" }); expect(errorCode(() => assignCitationMappingsFromRecords(records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })], requests: [terminal] }), [sourceRef(s)], []))).toBe("citation.source-url-request-mismatch");
    const unlinked = request(undefined, s.sourceId, { resultSourceIds: [] }); expect(errorCode(() => assignCitationMappingsFromRecords(records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })], requests: [unlinked] }), [sourceRef(s)], []))).toBe("citation.source-url-request-mismatch");
  });
  test(names[9], () => {
    const arbitrary = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://publisher.example.org/a" });
    expect(errorCode(() => assignCitationMappingsFromRecords(records({ sources: [arbitrary], evidence: [evidence(undefined, { sourceRef: sourceRef(arbitrary) })] }), [sourceRef(arbitrary)], []))).toBe("citation.source-url-unattributed");
    const http = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://blocked.example.org/a" });
    expect(errorCode(() => assignCitationMappingsFromRecords(records({ sources: [http], evidence: [evidence(undefined, { sourceRef: sourceRef(http) })] }), [sourceRef(http)], []))).toBe("citation.noncanonical-source");
    const approved = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://trusted.example.org/a", retrievalRequestIds: [request().requestId] }); const approvedRequest = request(undefined, approved.sourceId, { finalUrl: approved.canonicalUrl, accessPolicySha256: HASH });
    const approvedSnapshot = snapshot(records({ sources: [approved], evidence: [evidence(undefined, { sourceRef: sourceRef(approved) })], requests: [approvedRequest] }), { sourceUrlPolicy: { allowHttp: true, approvedHttpHosts: ["trusted.example.org"], accessPolicySha256: HASH } }); expect(assignCitationMappings(approvedSnapshot, [sourceRef(approved)], []).citations).toHaveLength(1);
  });
  test(names[10], () => {
    const s = source(undefined, { authors: [{ family: "Doe", given: "A", literal: null, orcid: "0000-0000-0000-0001" }], containerTitle: "Journal", publisher: "Publisher", volume: "1", issue: "2", pages: "3-4", published: { date: "2025-01-02", precision: "day" } });
    const metadata = assignCitationMappings(snapshot(records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })] })), [sourceRef(s)], []).bibliography[0]!;
    expect(metadata).toMatchObject({ title: s.title, containerTitle: "Journal", publisher: "Publisher", volume: "1", issue: "2", pages: "3-4", canonicalUrl: s.canonicalUrl, retrievedAt: AT }); expect(Object.keys(metadata)).not.toContain("publicationType");
  });
  test(names[11], () => {
    const s = source(undefined, { authors: [{ family: null, given: null, literal: "研究者 🧪", orcid: null }], title: "Unicode Δ", identifiers: { doi: null, pmid: "123", pmcid: null }, canonicalUrl: canonicalPmidUrl("123") });
    const metadata = assignCitationMappings(snapshot(records({ sources: [s], evidence: [evidence(undefined, { sourceRef: sourceRef(s) })] })), [sourceRef(s)], []).bibliography[0]!;
    expect(metadata.authors[0]!.literal).toBe("研究者 🧪"); expect(metadata.containerTitle).toBeNull(); expect(metadata.published.date).toBeNull(); expect(metadata.identifiers).toEqual(s.identifiers);
  });
  test(names[12], () => { const s = snapshot(); expect(assignCitationMappings(s, [sourceRef()], [binding()]).citations).toHaveLength(1); });
  test(names[13], () => { const d = diagnostics(); const s = snapshot(records(), undefined, d); const before = { ...d }; assignCitationMappings(s, [sourceRef()], [binding()]); assignCitationMappings(s, [sourceRef()], [binding()]); expect(d).toEqual(before); });
  test(names[14], () => { const s = snapshot(); const a = assignCitationMappings(s, [sourceRef()], [binding()]); const b = assignCitationMappings(s, [sourceRef()], [binding()]); expect(canonicalJson(a)).toBe(canonicalJson(b)); });
  test(names[15], () => { const s = snapshot(); expect(errorCode(() => assignCitationMappings(Object.freeze({ ...s }) as never, [sourceRef()], []))).toBe("citation.invalid-input"); });
  test(names[16], () => { const d = diagnostics(); const result = assignCitationMappingsFromRecords(records(), [sourceRef()], [binding()], undefined, undefined, d); expect(result.citations).toHaveLength(1); expect(d.canonicalRecordVisits).toBe(3); });
  test(names[17], () => {
    expect(errorCode(() => assignCitationMappings(snapshot(), [sourceRef(), sourceRef()], [], { maxCitations: 1 }))).toBe("citation.too-many-citations");
    expect(errorCode(() => assignCitationMappings(snapshot(), [sourceRef()], [binding(), binding()], { maxBindings: 1 }))).toBe("citation.too-many-bindings");
    expect(errorCode(() => assignCitationMappings(snapshot(), [sourceRef()], [binding()], { maxLinks: 1 }))).toBe("citation.too-many-links");
    expect(errorCode(() => assignCitationMappingsFromRecords(records({ sources: [source(undefined, { title: "x".repeat(2_000) })] }), [], [], { limits: { maxCanonicalScalarBytes: 1_000, maxSourceRecordCanonicalBytes: 1_000 } }))).toBe("citation.evidence-set-too-large");
    const sparse = new Array(1); expect(errorCode(() => assignCitationMappings(snapshot(), sparse as never, []))).toBe("citation.invalid-input");
    const accessor: unknown[] = []; Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("SECRET"); } }); expect(errorCode(() => assignCitationMappings(snapshot(), accessor as never, []))).toBe("citation.invalid-input");
    expect(errorCode(() => assignCitationMappings(snapshot(), [{ ...sourceRef(), extra: true } as never], []))).toBe("citation.invalid-input");
    const hostileBinding: Record<string, unknown> = { sourceRef: sourceRef(), evidenceRefs: [] }; Object.defineProperty(hostileBinding, "claimRefs", { enumerable: true, get() { throw new Error("SECRET"); } }); expect(errorCode(() => assignCitationMappings(snapshot(), [sourceRef()], [hostileBinding as never]))).toBe("citation.invalid-input");
    const cyclic: Record<string, unknown> = { sourceRef: null, claimRefs: [], evidenceRefs: [] }; cyclic.sourceRef = cyclic; expect(errorCode(() => assignCitationMappings(snapshot(), [sourceRef()], [cyclic as never]))).toBe("citation.invalid-input");
  });
  test(names[18], () => {
    const one = snapshot(); const changedSource = source(undefined, { title: "snapshot two" }); const two = snapshot(records({ sources: [changedSource] }), { limits: { maxReferences: 10 }, sourceUrlPolicy: { allowHttp: true, approvedHttpHosts: ["trusted.example.org"], accessPolicySha256: HASH } });
    expect(one.optionsSha256).not.toBe(two.optionsSha256); expect(one.policySha256).not.toBe(two.policySha256);
    expect(assignCitationMappings(one, [sourceRef()], []).bibliography[0]!.title).toBe(source().title); expect(assignCitationMappings(two, [sourceRef(changedSource)], []).bibliography[0]!.title).toBe("snapshot two");
  });
  test(names[19], () => {
    for (const options of [{ maxCitations: 0 }, { maxBindings: Number.MAX_SAFE_INTEGER }, { maxLinks: -1 }, { secret: 1 }] as CitationOptions[]) expect(errorCode(() => assignCitationMappings(new Proxy({}, { ownKeys() { throw new Error("SECRET"); } }) as never, [], [], options))).toBe("citation.invalid-options");
  });
  test(names[20], () => {
    const inputRef = sourceRef(); const inputBinding = binding(); const result = assignCitationMappings(snapshot(), [inputRef, inputRef], [inputBinding], { maxCitations: 2, maxBindings: 2, maxLinks: 3 });
    (inputRef as { sourceId: string }).sourceId = "src-citation.changed"; (inputBinding.claimRefs as Array<{ claimId: string; revision: number }>).length = 0;
    expect(result.citations).toHaveLength(1); expect(result.citations[0]!.sourceRef.sourceId).toBe(source().sourceId); expect(result.citations[0]!.claimRefs).toHaveLength(1); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.citations[0]!.sourceRef)).toBe(true); expect(() => ((result.citations[0] as { citationNumber: number }).citationNumber = 9)).toThrow();
  });
  test(names[21], () => {
    const other = source("src-citation.000002"); const lineageA = source("src-citation.lineagea", { lineage: { ...source().lineage, studyId: "study-a", relatedSourceIds: ["src-citation.lineageb"], relationTypes: ["version-of"] } }); const lineageB = source("src-citation.lineageb", { lineage: { ...source().lineage, studyId: "study-b", relatedSourceIds: [lineageA.sourceId], relationTypes: ["version-of"] } });
    const cases: Array<[() => unknown, string]> = [
      [() => assignCitationMappings(snapshot(), [{ sourceId: "bad", revision: 1 }], []), "citation.invalid-input"],
      [() => assignCitationMappings(snapshot(), [{ sourceId: "src-citation.missing", revision: 1 }], []), "citation.unresolved-ref"],
      [() => assignCitationMappings(snapshot(records({ sources: [source(), other] })), [sourceRef(other)], [binding({ sourceRef: sourceRef(other) })]), "citation.cross-source-evidence"],
      [() => assignCitationMappings(snapshot(records({ sources: [source(), other] })), [sourceRef(), sourceRef(other)], [binding(), binding({ sourceRef: sourceRef(other) })]), "citation.duplicate-link"],
      [() => assignCitationMappings(snapshot(), [sourceRef()], [binding(), binding({ sourceRef: { ...sourceRef(), revision: 2 } })]), "citation.ambiguous-source-revision"],
      [() => assignCitationMappingsFromRecords(records({ claims: [claim(), { ...claim() }] }), [], []), "citation.invalid-evidence-set"],
      [() => assignCitationMappingsFromRecords(records({ sources: [source(undefined, { lineage: { ...source().lineage, cohortIds: ["duplicate", "duplicate"] } })] }), [], []), "citation.noncanonical-source"],
      [() => assignCitationMappingsFromRecords(records({ sources: [source(undefined, { identifiers: { doi: "not-a-doi", pmid: null, pmcid: null } })] }), [], []), "citation.noncanonical-source"],
      [() => assignCitationMappingsFromRecords(records({ sources: [lineageA, lineageB], evidence: [evidence(undefined, { sourceRef: sourceRef(lineageA) })] }), [], []), "citation.invalid-evidence-set"],
    ]; for (const [action, code] of cases) expect(errorCode(action)).toBe(code);
  });
});
