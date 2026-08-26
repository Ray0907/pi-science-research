import { describe, expect, test } from "vitest";

import * as rootExports from "../../src/index.js";
import { canonicalJson } from "../../src/crypto/canonical-json.js";
import type { RequestRecord } from "../../src/domain/events.js";
import type { ClaimRecord, EvidenceRecord, SourceRecord } from "../../src/domain/research-records.js";
import {
  EvidenceAdmissionError,
  buildBoundedValidatedEvidenceSnapshot,
  type CanonicalEvidenceSet,
  type EvidenceSnapshotDiagnostics,
} from "../../src/evidence/admission.js";
import { getValidatedSnapshotIndexes } from "../../src/evidence/validated-snapshot-internal.js";

const AT = "2026-08-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const ATTEMPT = "attempt-0000000000000001";
function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    schemaVersion: 1, sourceId: "src-internal.000001", revision: 1,
    identifiers: { doi: "10.1234/internal", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/internal",
    title: "Internal", authors: [], containerTitle: null, publisher: null, volume: null, issue: null, pages: null,
    published: { date: null, precision: "unknown" }, publicationType: "journal-article", peerReviewStatus: "unknown",
    accessLevel: "full-text", retrievedAt: AT, retrievalRequestIds: [], metadataProvenance: [],
    lineage: { studyId: "study-internal", cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] }, ...overrides,
  };
}
function claim(): ClaimRecord { return {
  schemaVersion: 1, claimId: "claim-0000000000000001", revision: 1, statement: "Internal claim", kind: "externally-verifiable-fact",
  materiality: "load-bearing", scopeQualifiers: { population: null, intervention: null, comparator: null, outcome: null, timeRange: null },
  evidenceRule: { minimumLineages: 1, independentVerificationAllowed: false, primarySourceRequired: false, fullTextRequired: false },
  status: "supported", confidence: 1, evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }], conflictClaimIds: [], createdByAttemptId: ATTEMPT,
}; }
function evidence(): EvidenceRecord { return {
  schemaVersion: 1, evidenceId: "ev-0000000000000001", revision: 1, claimRef: { claimId: claim().claimId, revision: 1 },
  evidenceType: "retrieved", sourceRef: { sourceId: source().sourceId, revision: 1 }, calculationId: null, stance: "supporting",
  quotes: ["quote"], locators: [{ type: "page", value: "1" }], extractedValues: [], method: null,
  quality: "primary-peer-reviewed", confidence: 1, recordedByAttemptId: ATTEMPT, verificationStatus: "verified", conflictsWith: [],
}; }
function records(overrides: Partial<CanonicalEvidenceSet> = {}): CanonicalEvidenceSet {
  return { sources: [source()], claims: [claim()], evidence: [evidence()], verifications: [], requests: [], calculations: [], ...overrides };
}
function diagnostics(): EvidenceSnapshotDiagnostics { return {
  canonicalRecordVisits: 0, referenceVisits: 0, revisionIndexInsertions: 0, sourceIdentityVisits: 0,
  lineageVisits: 0, requestRecordsIndexed: 0, requestUrlVisits: 0, metadataStepVisits: 0,
}; }
function code(action: () => unknown): string | undefined {
  try { action(); } catch (error) { expect(error).toBeInstanceOf(EvidenceAdmissionError); return (error as EvidenceAdmissionError).code; }
  return undefined;
}

describe("validated evidence snapshot internals", () => {
  test("builds one immutable bounded validated evidence snapshot in linear visits", () => {
    const visits = diagnostics(); const snapshot = buildBoundedValidatedEvidenceSnapshot(records(), undefined, visits);
    expect(visits.canonicalRecordVisits).toBe(3);
    expect(visits.revisionIndexInsertions).toBe(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records.sources)).toBe(true);
    expect(snapshot.canonicalBytes).toBe(Buffer.byteLength(canonicalJson(snapshot.records), "utf8"));
  });
  test("binds snapshot option policy and view hashes without leaking indexes", () => {
    const snapshot = buildBoundedValidatedEvidenceSnapshot(records());
    expect(snapshot.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.optionsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.policySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(snapshot)).not.toMatch(/canonicalRecordString|outgoingReferences|lineageGraph/u);
  });
  test("returns authentic immutable validated snapshot indexes without Map escape", () => {
    const snapshot = buildBoundedValidatedEvidenceSnapshot(records());
    const indexes = getValidatedSnapshotIndexes(snapshot);
    expect(Object.isFrozen(indexes)).toBe(true);
    expect(indexes.getExactRecord({ kind: "claims", id: claim().claimId, revision: 1 })).toEqual(claim());
    expect(indexes.getCanonicalRecordString({ kind: "claims", id: claim().claimId, revision: 1 })).toContain("Internal claim");
    expect(Object.values(indexes).some((value) => value instanceof Map || value instanceof Set)).toBe(false);
    for (const name of [
      "getValidatedSnapshotIndexes", "buildBoundedValidatedEvidenceSnapshotInternal",
      "prepareProspectiveEvidenceCanonicalInternal", "validatePreparedEvidenceSemanticsInternal",
      "getLineageDependencyComponentKey", "getLineageRelationComponentKeyInternal",
      "getLineageDependencyComponentCountInternal", "buildLineageGraphFromValidatedSourcesForEvidenceSnapshotInternal",
      "buildRequestProvenanceIndexForEvidenceSnapshotInternal", "isEvidenceSnapshotDuplicateRequestError",
      "validateSourceCanonicalUrlProvenanceFromSnapshotInternal", "validateSourceIdentityOptionsForEvidenceSnapshotInternal",
      "validatePreparedSourceIdentityFieldsInternal",
    ]) expect(name in rootExports).toBe(false);
  });
  test("rejects structurally identical forged snapshot with evidence.snapshot-invalid", () => {
    const snapshot = buildBoundedValidatedEvidenceSnapshot(records());
    expect(code(() => getValidatedSnapshotIndexes(Object.freeze({ ...snapshot })))).toBe("evidence.snapshot-invalid");
  });
  test("rejects altered snapshot policy and hashes with evidence.snapshot-invalid", () => {
    const snapshot = buildBoundedValidatedEvidenceSnapshot(records());
    for (const field of ["snapshotSha256", "optionsSha256", "policySha256"] as const)
      expect(code(() => getValidatedSnapshotIndexes(Object.freeze({ ...snapshot, [field]: "b".repeat(64) })))).toBe("evidence.snapshot-invalid");
  });
  test("keeps diagnostics unchanged across repeated internal index access", () => {
    const visits = diagnostics(); const snapshot = buildBoundedValidatedEvidenceSnapshot(records(), undefined, visits); const before = { ...visits };
    getValidatedSnapshotIndexes(snapshot); getValidatedSnapshotIndexes(snapshot);
    expect(visits).toEqual(before);
  });
  test("rejects forged and hash-mismatched evidence snapshots", () => {
    expect(code(() => getValidatedSnapshotIndexes(Object.freeze({}) as never))).toBe("evidence.snapshot-invalid");
    const proxy = new Proxy({}, { get() { throw new Error("SECRET"); } });
    expect(code(() => getValidatedSnapshotIndexes(proxy as never))).toBe("evidence.snapshot-invalid");
  });
  test("reuses one request provenance index across many source audits", () => {
    const id = "request-0000000000000001";
    const s = source({ identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/article", retrievalRequestIds: [id] });
    const request: RequestRecord = {
      schemaVersion: 1, requestId: id, attemptId: ATTEMPT, executionEpoch: 0, logicalRequestId: "logical-0000000000000001",
      physicalAttemptOrdinal: 1, retryOfRequestId: null, replayPolicy: "safe-read", provider: "openalex", operation: "fetch",
      normalizedInput: { query: null, identifier: null, url: s.canonicalUrl, parameters: [] }, accessPolicySha256: HASH,
      startedAt: AT, endedAt: AT, status: "success", httpStatus: 200, requestedUrl: s.canonicalUrl, finalUrl: s.canonicalUrl,
      redirectUrls: [], responseSha256: null, responseFile: null, encodedBytes: 0, decodedBytes: 0, resultSourceIds: [s.sourceId], errorClass: null,
    };
    const visits = diagnostics();
    const snapshot = buildBoundedValidatedEvidenceSnapshot(records({ sources: [s], requests: [request] }), undefined, visits);
    expect(getValidatedSnapshotIndexes(snapshot).requestProvenanceIndex).toBe(snapshot.requestProvenanceIndex);
    expect(visits.canonicalRecordVisits).toBe(snapshot.recordCount);
    expect(visits.requestRecordsIndexed).toBe(1);
  });
  test("bounds every canonical record kind and aggregate set bytes before indexes", () => {
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records(), { limits: { maxClaimRecordCanonicalBytes: 10 } }))).toBe("evidence.record-too-large");
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records(), { limits: {
      maxCanonicalScalarBytes: 128,
      maxSourceRecordCanonicalBytes: 1_000, maxRequestRecordCanonicalBytes: 1_000,
      maxClaimRecordCanonicalBytes: 1_000, maxEvidenceRecordCanonicalBytes: 1_000,
      maxVerificationRecordCanonicalBytes: 1_000, maxCalculationRecordCanonicalBytes: 1_000,
      maxCanonicalEvidenceSetBytes: 1_000,
    } }))).toBe("evidence.input-too-large");
  });
  test("rejects oversized quotes metadata request queries calculation strings and nested values", () => {
    const huge = evidence(); huge.quotes = ["x".repeat(2_000)];
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ evidence: [huge] }), { limits: { maxEvidenceRecordCanonicalBytes: 1_000 } }))).toBe("evidence.record-too-large");
  });
  test("reports exact duplicate and gap codes from source and request histories", () => {
    const first = source();
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [first, { ...first }] })))).toBe("evidence.duplicate-revision");
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [{ ...first, revision: 2 }] })))).toBe("evidence.revision-gap");
    const id = "request-0000000000000001";
    const request: RequestRecord = {
      schemaVersion: 1, requestId: id, attemptId: ATTEMPT, executionEpoch: 0, logicalRequestId: "logical-0000000000000001",
      physicalAttemptOrdinal: 1, retryOfRequestId: null, replayPolicy: "safe-read", provider: "openalex", operation: "fetch",
      normalizedInput: { query: null, identifier: null, url: "https://api.example/a", parameters: [] }, accessPolicySha256: HASH,
      startedAt: AT, endedAt: AT, status: "success", httpStatus: 200, requestedUrl: "https://api.example/a", finalUrl: null,
      redirectUrls: [], responseSha256: null, responseFile: null, encodedBytes: 0, decodedBytes: 0, resultSourceIds: [], errorClass: null,
    };
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ requests: [request, { ...request }] })))).toBe("evidence.duplicate-request");
  });
  test("audits complete strong identity and URL components deterministically", () => {
    const first = source();
    const same = (id: string) => source({ sourceId: id });
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [first, same("src-internal.000002"), same("src-internal.000003")] })))).toBe("evidence.duplicate-source-identity");
    const shared = "https://example.org/shared";
    const a = source({ canonicalUrl: shared });
    const middle = source({ sourceId: "src-internal.000002", identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: shared });
    const conflicting = source({ sourceId: "src-internal.000003", identifiers: { doi: "10.1234/other", pmid: null, pmcid: null }, canonicalUrl: shared });
    for (const values of [[a, middle, conflicting], [middle, conflicting, a], [conflicting, a, middle]])
      expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: values })))).toBe("evidence.ambiguous-source-identity");
    const strongUrlA = source({ sourceId: "src-internal.strongurla", identifiers: { doi: "10.1234/strong-url", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/strong-url" });
    const strongUrlB = source({ sourceId: "src-internal.strongurlb", identifiers: { doi: "10.1234/strong-url", pmid: null, pmcid: null }, canonicalUrl: "https://example.org/shared-bridge" });
    const strongUrlC = source({ sourceId: "src-internal.strongurlc", identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/shared-bridge" });
    for (const values of [[strongUrlA, strongUrlB, strongUrlC], [strongUrlC, strongUrlA, strongUrlB]])
      expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: values })))).toBe("evidence.ambiguous-source-identity");
    const bridgeA = source({ sourceId: "src-internal.bridgea", identifiers: { doi: "10.1234/bridge-a", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/bridge-a" });
    const bridgeB = source({ sourceId: "src-internal.bridgeb", identifiers: { doi: "10.1234/bridge-a", pmid: "123456", pmcid: null }, canonicalUrl: "https://doi.org/10.1234/bridge-a" });
    const bridgeC = source({ sourceId: "src-internal.bridgec", identifiers: { doi: null, pmid: "123456", pmcid: null }, canonicalUrl: "https://pubmed.ncbi.nlm.nih.gov/123456/" });
    for (const values of [
      [bridgeA, bridgeB, bridgeC], [bridgeA, bridgeC, bridgeB], [bridgeB, bridgeA, bridgeC],
      [bridgeB, bridgeC, bridgeA], [bridgeC, bridgeA, bridgeB], [bridgeC, bridgeB, bridgeA],
    ]) expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: values })))).toBe("evidence.ambiguous-source-identity");
    const many = Array.from({ length: 40 }, (_, index) => source({ sourceId: `src-internal.large${String(index).padStart(3, "0")}` }));
    for (const values of [many, [...many].reverse()]) {
      const visits = diagnostics();
      expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: values }), undefined, visits))).toBe("evidence.duplicate-source-identity");
      expect(visits.sourceIdentityVisits).toBe(many.length);
    }
  });
  test("counts latest metadata plus retained relations for lineage component ceilings", () => {
    const a1 = source({ sourceId: "src-internal.historya", identifiers: { doi: "10.1234/history-a", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/history-a", lineage: { ...source().lineage, studyId: "study-a", cohortIds: ["cohort-old"] } });
    const a2 = { ...a1, revision: 2, lineage: { ...a1.lineage, cohortIds: [] } };
    const b1 = source({ sourceId: "src-internal.historyb", identifiers: { doi: "10.1234/history-b", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/history-b", lineage: { ...source().lineage, studyId: "study-b", cohortIds: ["cohort-old"] } });
    const b2 = { ...b1, revision: 2, lineage: { ...b1.lineage, cohortIds: [] } };
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [source(), a1, a2, b1, b2] }), { limits: { maxLineageComponents: 2 } }))).toBe("evidence.too-many-records");
    const emptyA = source({ sourceId: "src-internal.emptya", identifiers: { doi: "10.1234/empty-a", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/empty-a", lineage: { ...source().lineage, studyId: "study-empty-a", cohortIds: [""], datasetIds: [""] } });
    const emptyB = source({ sourceId: "src-internal.emptyb", identifiers: { doi: "10.1234/empty-b", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/empty-b", lineage: { ...source().lineage, studyId: "study-empty-b", cohortIds: [""], datasetIds: [""] } });
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [emptyA, emptyB] }), { limits: { maxLineageComponents: 1 } }))).toBe("evidence.too-many-records");
  });
  test("preflights references and lineage components before full indexes and graphs", () => {
    expect(buildBoundedValidatedEvidenceSnapshot(records(), { limits: { maxReferences: 3 } }).referenceCount).toBe(3);
    const referenceVisits = diagnostics();
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records(), { limits: { maxReferences: 2 } }, referenceVisits))).toBe("evidence.too-many-references");
    expect(referenceVisits.revisionIndexInsertions).toBe(0);
    expect(referenceVisits.lineageVisits).toBe(0);
    const a = source();
    const b = source({ sourceId: "src-internal.000002", identifiers: { doi: "10.1234/preflight-b", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/preflight-b", lineage: { ...a.lineage, studyId: "study-b" } });
    const componentVisits = diagnostics();
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [a, b] }), { limits: { maxLineageComponents: 1 } }, componentVisits))).toBe("evidence.too-many-records");
    expect(componentVisits.revisionIndexInsertions).toBe(0);
    expect(componentVisits.lineageVisits).toBe(0);
  });
  test("validates nested source policy before touching hostile record arrays", () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error("SECRET-RECORDS"); }, get() { throw new Error("SECRET-RECORDS"); } });
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "allowHttp", { enumerable: true, get() { throw new Error("SECRET-POLICY"); } });
    const policies = [
      { allowHttp: true, approvedHttpHosts: ["UPPER.example"], accessPolicySha256: HASH },
      new Proxy({}, { ownKeys() { throw new Error("SECRET-POLICY"); } }), accessor,
    ];
    for (const sourceUrlPolicy of policies)
      expect(code(() => buildBoundedValidatedEvidenceSnapshot(hostile as never, { sourceUrlPolicy: sourceUrlPolicy as never }))).toBe("evidence.invalid-options");
    for (const options of [
      { limits: { maxReferences: 0 } }, { limits: { unknown: 1 } },
      { view: { stableIdRevisionSelection: "wrong", verificationRevisionSelection: "latest-applicable-per-target" } },
      { unknown: true },
    ]) expect(code(() => buildBoundedValidatedEvidenceSnapshot(hostile as never, options as never))).toBe("evidence.invalid-options");
  });
  test("keeps the Task 4 source ceiling independent from the Task 2 public ceiling", () => {
    expect(buildBoundedValidatedEvidenceSnapshot(records(), { limits: { maxPerKind: {
      sources: 100_001, claims: 50_000, evidence: 100_000, verifications: 25_000, requests: 100_000, calculations: 25_000,
    } } })).toBeDefined();
  });
  test("enforces maxLineageComponents on resulting components rather than source count", () => {
    const a = source();
    const b = source({ sourceId: "src-internal.000002", identifiers: { doi: "10.1234/internal-two", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/internal-two", lineage: { ...a.lineage } });
    expect(buildBoundedValidatedEvidenceSnapshot(records({ sources: [a, b] }), { limits: { maxLineageComponents: 1 } })).toBeDefined();
    const independent = { ...b, lineage: { ...b.lineage, studyId: "study-other" } };
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ sources: [a, independent] }), { limits: { maxLineageComponents: 1 } }))).toBe("evidence.too-many-records");
  });
  test("rejects aggregate wrapper overflow before prospective semantic traversal", () => {
    const bad = evidence(); bad.quotes = ["", "x".repeat(500)];
    const baseline = buildBoundedValidatedEvidenceSnapshot(records());
    expect(code(() => buildBoundedValidatedEvidenceSnapshot(records({ evidence: [bad] }), { limits: {
      maxCanonicalScalarBytes: 128,
      maxSourceRecordCanonicalBytes: 1_500, maxRequestRecordCanonicalBytes: 1_500,
      maxClaimRecordCanonicalBytes: 1_500, maxEvidenceRecordCanonicalBytes: 1_500,
      maxVerificationRecordCanonicalBytes: 1_500, maxCalculationRecordCanonicalBytes: 1_500,
      maxCanonicalEvidenceSetBytes: baseline.canonicalBytes - 1,
    } }))).toBe("evidence.input-too-large");
  });
});
