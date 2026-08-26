import { describe, expect, test } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import type { FoundationLedgerEvent, RequestRecord } from "../../src/domain/events.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import type { CalculationRecord, ClaimRecord, EvidenceRecord, SourceRecord, VerificationRecord } from "../../src/domain/research-records.js";
import { EvidenceAdmissionError, buildBoundedValidatedEvidenceSnapshot, type CanonicalEvidenceSet, type EvidenceSnapshotDiagnostics } from "../../src/evidence/admission.js";
import {
  EvidenceQueryError, buildEvidenceIndex, buildEvidenceIndexFromRecords, buildEvidenceIndexWithDiagnosticsInternal,
  type EvidenceIndexOptions, type EvidenceQuery, type EvidenceQueryDiagnostics,
} from "../../src/evidence/query.js";

const AT = "2026-08-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RUN = "run-0000000000000001";
const TASK = "task-0000000000000001";
const ATTEMPT_A = "attempt-0000000000000001";
const ATTEMPT_B = "attempt-0000000000000002";
function source(id = "src-query.00000001", overrides: Partial<SourceRecord> = {}): SourceRecord { return {
  schemaVersion: 1, sourceId: id, revision: 1, identifiers: { doi: `10.1234/${id}`, pmid: null, pmcid: null }, canonicalUrl: `https://doi.org/10.1234/${id}`,
  title: id, authors: [], containerTitle: null, publisher: null, volume: null, issue: null, pages: null,
  published: { date: null, precision: "unknown" }, publicationType: "journal-article", peerReviewStatus: "unknown", accessLevel: "full-text",
  retrievedAt: AT, retrievalRequestIds: [], metadataProvenance: [], lineage: { studyId: `study-${id}`, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] }, ...overrides,
}; }
function claim(id = "claim-0000000000000001", overrides: Partial<ClaimRecord> = {}): ClaimRecord { return {
  schemaVersion: 1, claimId: id, revision: 1, statement: id, kind: "externally-verifiable-fact", materiality: "load-bearing",
  scopeQualifiers: { population: null, intervention: null, comparator: null, outcome: null, timeRange: null },
  evidenceRule: { minimumLineages: 1, independentVerificationAllowed: false, primarySourceRequired: false, fullTextRequired: false },
  status: "supported", confidence: 0.8, evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }], conflictClaimIds: [], createdByAttemptId: ATTEMPT_A, ...overrides,
}; }
function evidence(id = "ev-0000000000000001", overrides: Partial<EvidenceRecord> = {}): EvidenceRecord { return {
  schemaVersion: 1, evidenceId: id, revision: 1, claimRef: { claimId: "claim-0000000000000001", revision: 1 }, evidenceType: "retrieved",
  sourceRef: { sourceId: "src-query.00000001", revision: 1 }, calculationId: null, stance: "supporting", quotes: ["quote"],
  locators: [{ type: "page", value: "1" }], extractedValues: [], method: null, quality: "primary-peer-reviewed", confidence: 0.9,
  recordedByAttemptId: ATTEMPT_A, verificationStatus: "verified", conflictsWith: [], ...overrides,
}; }
function verification(id = "verify-0000000000000001", overrides: Partial<VerificationRecord> = {}): VerificationRecord { return {
  schemaVersion: 1, verificationId: id, revision: 1, attemptId: ATTEMPT_B, method: "independent-source",
  checkedClaims: [{ claimId: "claim-0000000000000001", revision: 1 }], checkedEvidence: [{ evidenceId: "ev-0000000000000001", revision: 1 }],
  requestIds: [], calculationIds: [], result: "accepted", corrections: [], independentEvidenceIds: [], notes: "ok", ...overrides,
}; }
function request(id = "request-0000000000000001", sourceId = source().sourceId, overrides: Partial<RequestRecord> = {}): RequestRecord { return {
  schemaVersion: 1, requestId: id, attemptId: ATTEMPT_A, executionEpoch: 0, logicalRequestId: `logical-${id}`, physicalAttemptOrdinal: 1,
  retryOfRequestId: null, replayPolicy: "safe-read", provider: "openalex", operation: "fetch",
  normalizedInput: { query: null, identifier: null, url: source().canonicalUrl, parameters: [] }, accessPolicySha256: HASH,
  startedAt: AT, endedAt: AT, status: "success", httpStatus: 200, requestedUrl: source().canonicalUrl, finalUrl: source().canonicalUrl,
  redirectUrls: [], responseSha256: null, responseFile: null, encodedBytes: 0, decodedBytes: 0, resultSourceIds: [sourceId], errorClass: null, ...overrides,
}; }
function calculation(id = "calc-0000000000000001"): CalculationRecord { const file = (path: string) => ({ relativePath: path, mediaType: "application/json", decodedBytes: 0, sha256: HASH }); return {
  schemaVersion: 1, calculationId: id, attemptId: ATTEMPT_A, sandboxPolicySha256: HASH, runtime: "node", command: "calc", environment: [],
  inputs: [file("input.json")], sourceFiles: [], outputs: [file("output.json")], networkEnabled: false, startedAt: AT, endedAt: AT, exitCode: 0, status: "success",
}; }
function records(overrides: Partial<CanonicalEvidenceSet> = {}): CanonicalEvidenceSet { return {
  sources: [source()], claims: [claim()], evidence: [evidence()], verifications: [], requests: [], calculations: [], ...overrides,
}; }
function connectedRecords(): CanonicalEvidenceSet {
  const s = source(undefined, { retrievalRequestIds: ["request-0000000000000001"] });
  const r = request(undefined, s.sourceId, { normalizedInput: { query: null, identifier: null, url: s.canonicalUrl, parameters: [] }, requestedUrl: s.canonicalUrl, finalUrl: s.canonicalUrl });
  const calc = calculation();
  const e = evidence(undefined, { sourceRef: { sourceId: s.sourceId, revision: 1 }, calculationId: calc.calculationId });
  const c = claim(undefined, { evidenceRefs: [{ evidenceId: e.evidenceId, revision: 1 }] });
  const v = verification(undefined, { checkedClaims: [{ claimId: c.claimId, revision: 1 }], checkedEvidence: [{ evidenceId: e.evidenceId, revision: 1 }], requestIds: [r.requestId], calculationIds: [calc.calculationId], independentEvidenceIds: [e.evidenceId] });
  return { sources: [s], claims: [c], evidence: [e], verifications: [v], requests: [r], calculations: [calc] };
}
function snapshot(value = records(), diagnostics?: EvidenceSnapshotDiagnostics) { return buildBoundedValidatedEvidenceSnapshot(value, undefined, diagnostics); }
function index(value = records(), options?: EvidenceIndexOptions) { return buildEvidenceIndex({ snapshot: snapshot(value) }, options); }
function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery { return { limit: 100, maxSelectedBytes: 1_000_000, ...overrides }; }
function errorCode(action: () => unknown): string | undefined { try { action(); } catch (error) {
  expect(error).toBeInstanceOf(EvidenceQueryError); expect((error as Error).message).toMatch(/^Evidence query rejected \(query\.[a-z-]+\)$/u);
  expect((error as Error).message).not.toMatch(/quote|doi\.org|SECRET|logical-/u); return (error as EvidenceQueryError).code;
} return undefined; }
function diagnostics(): EvidenceSnapshotDiagnostics { return { canonicalRecordVisits: 0, referenceVisits: 0, revisionIndexInsertions: 0, sourceIdentityVisits: 0, lineageVisits: 0, requestRecordsIndexed: 0, requestUrlVisits: 0, metadataStepVisits: 0 }; }
function queryDiagnostics(): EvidenceQueryDiagnostics { return { indexVisits: 0, candidateVisits: 0, closureVisits: 0, normalizedQueryCanonicalizations: 0 }; }
function runSnapshot(): RunSnapshot { return { schemaVersion: 1, runId: RUN, revision: 1, question: "q", language: "en", depth: "standard", reproducible: false, allowCalculations: false, calculationPolicySha256: null, state: "created", checkpointStage: null, executionEpoch: 0, outputRoot: "research/run", roleModels: { coordinator: "p/m", researcher: "p/m", verifier: "p/m" }, roleThinking: { coordinator: "medium", researcher: "medium", verifier: "medium" }, budget: { activeTimeLimitMs: 600_000, activeTimeUsedMs: 0, finalizationReserveMs: 120_000, maxSources: 10, admittedSources: 0, maxWaves: 1, waveOrdinal: 0 }, taskRefs: [], attemptRefs: [], acceptedVerificationRef: null, currentRevisionId: null, blocker: null, createdAt: AT, updatedAt: AT, completedAt: null }; }
function taskRecord(): TaskRecord { return { schemaVersion: 1, taskId: TASK, revision: 1, description: "task", evidenceRule: claim().evidenceRule, role: "literature-searcher", state: "running", attemptIds: [ATTEMPT_A], blocker: null, resolution: null }; }
function attemptRecord(): AttemptRecord { return { schemaVersion: 1, attemptId: ATTEMPT_A, revision: 1, runId: RUN, taskId: TASK, executionEpoch: 0, logicalOperationId: "operation", attemptOrdinal: 1, retryOfAttemptId: null, attemptKind: "research", replayPolicy: "safe-read", state: "intent-recorded", providerModel: "p/m", thinkingLevel: "medium", promptTemplateSha256: HASH, renderedPromptSha256: HASH, logicalInputSha256: HASH, attemptEnvelopeSha256: HASH_B, toolAllowlist: [], deadlineAt: AT, capabilityId: "cap", resultSha256: null, billingStatus: "unknown", reportedUsage: null, error: null, createdAt: AT, updatedAt: AT }; }
function ledger(): FoundationLedgerEvent[] { const raw: Array<[FoundationLedgerEvent["type"], unknown]> = [
  ["run_created", { run: runSnapshot() }], ["identity_reserved", { kind: "attempt", id: ATTEMPT_A, origin: "parent-generated" }],
  ["task_upserted", { task: taskRecord() }], ["dispatch_intent", { attempt: attemptRecord() }],
]; return raw.map(([type, payload], index) => ({ schemaVersion: 1, seq: index + 1, occurredAt: AT, eventId: `event-${index + 1}`, type, payload, prevSha256: index === 0 ? "0".repeat(64) : HASH, entrySha256: HASH } as FoundationLedgerEvent)); }

const names = {
  allKinds: ["sources", "claims", "evidence", "verifications", "requests", "calculations"] as const,
};

describe("bounded evidence queries", () => {
  test("consumes internal snapshot lookup views without rebuilding indexes", () => { const s = snapshot(); expect(buildEvidenceIndex({ snapshot: s }).recordCount).toBe(s.recordCount); });
  test("keeps snapshot diagnostics unchanged across repeated query index access", () => { const d = diagnostics(); const s = snapshot(records(), d); const before = { ...d }; const i = buildEvidenceIndex({ snapshot: s }); i.query(query()); i.query(query()); expect(d).toEqual(before); });
  test("consumes one bounded validated snapshot without recanonicalizing records", () => { const i = index(); expect(i.query(query()).selectedRecordBundleSha256).toBe(i.query(query()).selectedRecordBundleSha256); });
  test("normalizes duplicate filter values and ANDs every filter class", () => { const i = index(); const a = i.query(query({ stances: ["supporting", "supporting"], qualities: ["primary-peer-reviewed"], verificationStatuses: ["verified"], accessLevels: ["full-text"], lineageIds: [source().lineage.studyId!], minimumConfidence: 0.9 })); expect(a.evidence).toHaveLength(1); expect(a.selectedRecordBundleSha256).toBe(i.query(query({ stances: ["supporting"], qualities: ["primary-peer-reviewed"], verificationStatuses: ["verified"], accessLevels: ["full-text"], lineageIds: [source().lineage.studyId!], minimumConfidence: 0.9 })).selectedRecordBundleSha256); expect(i.query(query({ taskIds: [] })).evidence).toHaveLength(0); });
  test("seeds direct heterogeneous refs then intersects remaining filters", () => { const i = index(); const result = i.query(query({ sourceRefs: [{ sourceId: source().sourceId, revision: 1 }], evidenceRefs: [{ evidenceId: evidence().evidenceId, revision: 1 }], stances: ["supporting"] })); expect(result.evidence).toHaveLength(1); });
  test("orders heterogeneous primary records by kind ID and revision before pagination", () => {
    const refs = { sourceRefs: [{ sourceId: source().sourceId, revision: 1 }], claimRefs: [{ claimId: claim().claimId, revision: 1 }], evidenceRefs: [{ evidenceId: evidence().evidenceId, revision: 1 }] };
    const first = index().query(query({ ...refs, limit: 1 })); expect(first.nextCursor).not.toBeNull(); expect(first.sources).toHaveLength(1);
    const per = { sources: 2, claims: 2, evidence: 2, verifications: 2, requests: 2, calculations: 2 };
    const bounded = index(undefined, { maxSelectedPerKind: per, maxTotalSelectedRecords: 2 }).query(query({ ...refs, limit: 3 }));
    expect(bounded.truncated).toBe(true); expect(bounded.sources).toHaveLength(1); expect(bounded.claims).toHaveLength(0);
  });
  test("selects exact refs and closes source claim evidence verification request and calculation references", () => {
    const i = index(connectedRecords()); const result = i.query(query({ verificationRefs: [{ verificationId: verification().verificationId, revision: 1 }] })); for (const kind of names.allKinds) expect(result[kind]).toHaveLength(1);
    const target1 = source("src-query.target01"); const target2 = { ...target1, revision: 2, title: "latest" }; const direct = source("src-query.direct01", { lineage: { ...source().lineage, studyId: "study-direct", relatedSourceIds: [target1.sourceId], relationTypes: ["version-of"] } });
    const set = records({ sources: [direct, target1, target2], evidence: [evidence(undefined, { sourceRef: { sourceId: direct.sourceId, revision: 1 } })] }); const exactIndex = index(set);
    expect(exactIndex.query(query({ sourceRefs: [{ sourceId: target1.sourceId, revision: 1 }] })).sources.map(({ revision }) => revision)).toEqual([1]);
    expect(exactIndex.query(query({ sourceRefs: [{ sourceId: direct.sourceId, revision: 1 }] })).sources.find(({ sourceId }) => sourceId === target1.sourceId)?.revision).toBe(2);
  });
  test("includes full canonical requests and calculations in deterministic order and bundle hash", () => {
    const base = connectedRecords(); const r2 = request("request-0000000000000002", base.sources[0]!.sourceId, { resultSourceIds: [] }); const c2 = calculation("calc-0000000000000002");
    const v = { ...base.verifications[0]!, requestIds: [r2.requestId, base.requests[0]!.requestId], calculationIds: [c2.calculationId, base.calculations[0]!.calculationId] };
    const forward = { ...base, verifications: [v], requests: [r2, base.requests[0]!], calculations: [c2, base.calculations[0]!] };
    const reverse = { ...forward, requests: [...forward.requests].reverse(), calculations: [...forward.calculations].reverse() };
    const a = index(forward).query(query({ verificationRefs: [{ verificationId: v.verificationId, revision: 1 }] })); const b = index(reverse).query(query({ verificationRefs: [{ verificationId: v.verificationId, revision: 1 }] }));
    expect(a.requests.map(({ requestId }) => requestId)).toEqual([base.requests[0]!.requestId, r2.requestId]); expect(a.calculations.map(({ calculationId }) => calculationId)).toEqual([base.calculations[0]!.calculationId, c2.calculationId]);
    expect(a.requests[0]!.normalizedInput).toBeDefined(); expect(a.calculations[0]!.outputs).toHaveLength(1); expect(a.selectedRecordBundleSha256).toBe(b.selectedRecordBundleSha256);
  });
  test("closes request result sources to a bounded fixed point without dangling refs", () => { const set = connectedRecords(); const i = index(set); const result = i.query(query({ sourceRefs: [{ sourceId: set.sources[0]!.sourceId, revision: 1 }] })); expect(result.requests).toHaveLength(1); expect(result.sources).toHaveLength(1); });
  test("closes direct source and claim lineage evidence and conflict edges", () => {
    const s2 = source("src-query.00000002"); const s1 = source(undefined, { lineage: { ...source().lineage, relatedSourceIds: [s2.sourceId], relationTypes: ["version-of"] } });
    const e1 = evidence(); const e2 = evidence("ev-0000000000000002", { claimRef: { claimId: "claim-0000000000000002", revision: 1 }, sourceRef: { sourceId: s2.sourceId, revision: 1 } });
    const c1 = claim(undefined, { conflictClaimIds: ["claim-0000000000000002"] }); const c2 = claim("claim-0000000000000002", { evidenceRefs: [{ evidenceId: e2.evidenceId, revision: 1 }], conflictClaimIds: [c1.claimId] });
    const set = records({ sources: [s1, s2], claims: [c1, c2], evidence: [e1, e2] }); const result = index(set).query(query({ claimRefs: [{ claimId: c1.claimId, revision: 1 }] }));
    expect([result.sources.length, result.claims.length, result.evidence.length]).toEqual([2, 2, 2]);
  });
  test("closes evidence claim source calculation and conflict edges", () => {
    const set = connectedRecords(); const first = { ...set.evidence[0]!, conflictsWith: ["ev-0000000000000002"] }; const second = evidence("ev-0000000000000002", { stance: "contradicting", conflictsWith: [first.evidenceId] });
    const withConflict = { ...set, evidence: [first, second] }; const result = index(withConflict).query(query({ evidenceRefs: [{ evidenceId: first.evidenceId, revision: 1 }] }));
    expect([result.claims.length, result.sources.length, result.calculations.length, result.evidence.length]).toEqual([1, 1, 1, 2]);
  });
  test("closes verification corrections independent evidence requests and calculations", () => { const set = connectedRecords(); const corrected = { ...set.verifications[0]!, corrections: [{ claimId: set.claims[0]!.claimId, description: "checked" }] }; const result = index({ ...set, verifications: [corrected] }).query(query({ verificationRefs: [{ verificationId: corrected.verificationId, revision: 1 }] })); expect([result.claims.length, result.evidence.length, result.requests.length, result.calculations.length]).toEqual([1, 1, 1, 1]); });
  test("terminates cyclic closure with visited keys and pre-expansion bounds", () => { expect(index(connectedRecords()).query(query()).sources).toHaveLength(1); expect(errorCode(() => index(connectedRecords(), { maxClosureEdges: 1 }).query(query()))).toBe("query.closure-too-large"); });
  test("combines task role attempt stance quality access and confidence filters from canonical metadata", () => { const i = buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: ledger() }); const result = i.query(query({ taskIds: [TASK], roles: ["literature-searcher"], attemptIds: [ATTEMPT_A], stances: ["supporting"], qualities: ["primary-peer-reviewed"], accessLevels: ["full-text"], minimumConfidence: 0.9 })); expect(result.evidence).toHaveLength(1); });
  test("indexes evidence and direct-record owners without closure broadening matches", () => {
    const s = source(undefined, { retrievalRequestIds: [request().requestId] }); const r = request(undefined, s.sourceId); const set = records({ sources: [s], requests: [r] });
    const i = buildEvidenceIndex({ snapshot: snapshot(set), ledgerEvents: ledger() });
    expect(i.query(query({ claimRefs: [{ claimId: claim().claimId, revision: 1 }], attemptIds: [ATTEMPT_A] })).claims).toHaveLength(1);
    expect(i.query(query({ sourceRefs: [{ sourceId: s.sourceId, revision: 1 }], taskIds: [TASK] })).sources).toHaveLength(1);
  });
  test("rejects task and role filters without ledger metadata using query.metadata-required", () => { expect(errorCode(() => index().query(query({ taskIds: [TASK] })))).toBe("query.metadata-required"); });
  test("bounds canonical ledger task and attempt metadata before indexing", () => {
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: ledger() }, { maxLedgerEvents: 1 }))).toBe("query.metadata-too-large");
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: ledger() }, { maxMetadataCanonicalBytes: 1 }))).toBe("query.metadata-too-large");
    const taskOverflow = ledger(); taskOverflow.push({ ...taskOverflow[2]!, seq: 5, eventId: "event-5", payload: { task: { ...taskRecord(), revision: 2 } } } as FoundationLedgerEvent);
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: taskOverflow }, { maxTaskRevisions: 1 }))).toBe("query.metadata-too-large");
    const attemptOverflow = ledger(); attemptOverflow.push({ ...attemptOverflow[3]!, seq: 5, eventId: "event-5", payload: { attempt: { ...attemptRecord(), attemptId: ATTEMPT_B } } } as FoundationLedgerEvent);
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: attemptOverflow }, { maxAttempts: 1 }))).toBe("query.metadata-too-large");
    const stableOverflow = ledger(); stableOverflow.push({ ...stableOverflow[2]!, seq: 5, eventId: "event-5", payload: { task: { ...taskRecord(), taskId: "task-0000000000000002" } } } as FoundationLedgerEvent);
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: stableOverflow }, { maxStableTasks: 1 }))).toBe("query.metadata-too-large");
  });
  test("filters exact lineage IDs without substring matches", () => { const i = index(); expect(i.query(query({ lineageIds: ["study-src-query"] })).evidence).toHaveLength(0); expect(i.query(query({ lineageIds: [source().lineage.studyId!] })).evidence).toHaveLength(1); });
  test("accepts schema-valid lineage IDs beyond 4096 code units subject only to filter bytes", () => {
    const lineageId = "lineage-" + "x".repeat(5_000); const s = source(undefined, { lineage: { ...source().lineage, studyId: lineageId } });
    const i = index(records({ sources: [s], evidence: [evidence(undefined, { sourceRef: { sourceId: s.sourceId, revision: 1 } })] }), { maxFilterBytes: 20_000 });
    expect(i.query(query({ lineageIds: [lineageId] })).evidence).toHaveLength(1);
  });
  test("preflights raw filter bytes before deduplication and canonicalizes normalized query once", () => {
    const d = queryDiagnostics(); const i = buildEvidenceIndexWithDiagnosticsInternal({ snapshot: snapshot() }, { maxFilterBytes: 200 }, d);
    const repeated = "x".repeat(80); expect(errorCode(() => i.query(query({ lineageIds: [repeated, repeated, repeated] })))).toBe("query.filter-too-large");
    const accessor: string[] = []; Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("SECRET-FILTER"); } });
    expect(errorCode(() => i.query(query({ lineageIds: accessor })))).toBe("query.invalid-input");
    expect(errorCode(() => i.query(query({ lineageIds: new Proxy(["id"], { ownKeys() { throw new Error("SECRET-FILTER"); } }) })))).toBe("query.invalid-input");
    expect(errorCode(() => i.query(query({ lineageIds: [new String("id") as never] })))).toBe("query.invalid-input");
    i.query(query({ stances: ["supporting", "supporting"] })); expect(d.normalizedQueryCanonicalizations).toBe(1);
  });
  test("orders selections deterministically and hashes the closed bundle", () => {
    const s1 = source(); const s2 = source("src-query.00000002"); const e1 = evidence(); const e2 = evidence("ev-0000000000000002", { sourceRef: { sourceId: s2.sourceId, revision: 1 } });
    const c = claim(undefined, { evidenceRefs: [{ evidenceId: e1.evidenceId, revision: 1 }, { evidenceId: e2.evidenceId, revision: 1 }] });
    const a = index(records({ sources: [s1, s2], claims: [c], evidence: [e1, e2] })).query(query());
    const b = index(records({ sources: [s2, s1], claims: [c], evidence: [e2, e1] })).query(query());
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
  test("treats absent and null cursor as the identical first page", () => { const i = index(); expect(canonicalJson(i.query(query()))).toBe(canonicalJson(i.query(query({ cursor: null })))); });
  test("paginates with cursors bound to every normalized non-cursor field", () => { const e2 = evidence("ev-0000000000000002"); const c = claim(undefined, { evidenceRefs: [claim().evidenceRefs[0]!, { evidenceId: e2.evidenceId, revision: 1 }] }); const i = index(records({ claims: [c], evidence: [evidence(), e2] })); const first = i.query(query({ limit: 1 })); expect(first.nextCursor).not.toBeNull(); expect(i.query(query({ limit: 1, cursor: first.nextCursor })).evidence.some((item) => item.evidenceId === e2.evidenceId)).toBe(true); expect(errorCode(() => i.query(query({ limit: 2, cursor: first.nextCursor })))).toBe("query.cursor-mismatch"); const normalizedCursor = i.query(query({ limit: 1, stances: ["supporting", "supporting"] })).nextCursor!; expect(errorCode(() => i.query(query({ limit: 1, stances: ["supporting"], cursor: normalizedCursor })))).toBeUndefined(); const flipped = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith("A") ? "B" : "A"}`; expect(errorCode(() => i.query(query({ limit: 1, cursor: flipped })))).toBe("query.cursor-invalid"); });
  test("returns query.cursor-invalid for malformed version integrity and oversized cursor encodings", () => {
    const i = index(undefined, { maxCursorBytes: 16 });
    const body = { version: 2, snapshotHash: "a".repeat(64), queryHash: "b".repeat(64), position: [2, evidence().evidenceId, 1] };
    const versionCursor = Buffer.from(canonicalJson({ ...body, checksum: sha256Hex(canonicalJson(body)) }), "utf8").toString("base64url");
    for (const cursor of ["!", "e30", "a".repeat(17)]) expect(errorCode(() => i.query(query({ cursor })))).toBe("query.cursor-invalid");
    expect(errorCode(() => index().query(query({ cursor: versionCursor })))).toBe("query.cursor-invalid");
  });
  test("returns query.cursor-mismatch for normalized query metadata policy and snapshot changes", () => { const e2 = evidence("ev-0000000000000002"); const c = claim(undefined, { evidenceRefs: [claim().evidenceRefs[0]!, { evidenceId: e2.evidenceId, revision: 1 }] }); const a = index(records({ claims: [c], evidence: [evidence(), e2] })); const cursor = a.query(query({ limit: 1 })).nextCursor!; const b = index(records({ claims: [c], evidence: [evidence(), e2] })); expect(errorCode(() => b.query(query({ limit: 1, cursor })))).toBeUndefined(); const changed = index(records({ claims: [c], evidence: [evidence(), e2], verifications: [verification()] })); expect(errorCode(() => changed.query(query({ limit: 1, cursor })))).toBe("query.cursor-mismatch"); const withMetadata = buildEvidenceIndex({ snapshot: snapshot(records({ claims: [c], evidence: [evidence(), e2] })), ledgerEvents: ledger() }); expect(errorCode(() => withMetadata.query(query({ limit: 1, cursor })))).toBe("query.cursor-mismatch"); const policyBound = buildEvidenceIndex({ snapshot: buildBoundedValidatedEvidenceSnapshot(records({ claims: [c], evidence: [evidence(), e2] }), { sourceUrlPolicy: { allowHttp: true, approvedHttpHosts: ["example.org"], accessPolicySha256: HASH } }) }); expect(errorCode(() => policyBound.query(query({ limit: 1, cursor })))).toBe("query.cursor-mismatch"); });
  test("returns query.limit-invalid only for malformed caller and pagination limits", () => { expect(errorCode(() => index().query(query({ limit: 0 })))).toBe("query.limit-invalid"); expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot() }, { maxPageLimit: 0 }))).toBe("query.limit-invalid"); });
  test("returns query.record-too-large only for one oversized canonical input record", () => { const huge = source(undefined, { title: "x".repeat(2_000) }); expect(errorCode(() => buildEvidenceIndexFromRecords(records({ sources: [huge] }), undefined, { limits: { maxCanonicalScalarBytes: 1_000, maxSourceRecordCanonicalBytes: 1_000 } }))).toBe("query.record-too-large"); });
  test("returns query.input-too-large for aggregate indexed count bytes and references", () => {
    expect(errorCode(() => buildEvidenceIndexFromRecords(records(), undefined, { limits: { maxPerKind: { sources: 1, claims: 1, evidence: 1, verifications: 1, requests: 1, calculations: 1 }, maxTotalRecords: 1, maxLineageComponents: 1 } }))).toBe("query.input-too-large");
    expect(errorCode(() => buildEvidenceIndexFromRecords(records(), undefined, { limits: { maxReferences: 2 } }))).toBe("query.input-too-large");
    const baseline = snapshot().canonicalBytes; const perRecord = baseline - 1;
    expect(errorCode(() => buildEvidenceIndexFromRecords(records(), undefined, { limits: { maxCanonicalScalarBytes: 128, maxSourceRecordCanonicalBytes: perRecord, maxRequestRecordCanonicalBytes: perRecord, maxClaimRecordCanonicalBytes: perRecord, maxEvidenceRecordCanonicalBytes: perRecord, maxVerificationRecordCanonicalBytes: perRecord, maxCalculationRecordCanonicalBytes: perRecord, maxCanonicalEvidenceSetBytes: perRecord } }))).toBe("query.input-too-large");
  });
  test("returns query.result-too-large for primary page count or bytes before closure", () => {
    expect(errorCode(() => index(undefined, { maxPrimaryPageBytes: 1 }).query(query()))).toBe("query.result-too-large");
    const e2 = evidence("ev-0000000000000002"); const c = claim(undefined, { evidenceRefs: [claim().evidenceRefs[0]!, { evidenceId: e2.evidenceId, revision: 1 }] });
    expect(errorCode(() => index(records({ claims: [c], evidence: [evidence(), e2] }), { maxPageLimit: 2, maxPrimaryPageRecords: 1 }).query(query({ limit: 2 })))).toBe("query.result-too-large");
  });
  test("returns query.closure-too-large for every transitive per-kind total ref and byte overflow", () => {
    const per = { sources: 1, claims: 1, evidence: 1, verifications: 1, requests: 1, calculations: 1 };
    expect(errorCode(() => index(undefined, { maxSelectedPerKind: per, maxTotalSelectedRecords: 1 }).query(query()))).toBe("query.closure-too-large");
    const e2 = evidence("ev-0000000000000002"); const c = claim(undefined, { evidenceRefs: [claim().evidenceRefs[0]!, { evidenceId: e2.evidenceId, revision: 1 }] });
    expect(errorCode(() => index(records({ claims: [c], evidence: [evidence(), e2] }), { maxSelectedPerKind: per, maxTotalSelectedRecords: 6 }).query(query()))).toBe("query.closure-too-large");
    expect(errorCode(() => index(connectedRecords(), { maxClosureEdges: 1 }).query(query()))).toBe("query.closure-too-large");
    expect(errorCode(() => index().query(query({ maxSelectedBytes: 1 })))).toBe("query.closure-too-large");
  });
  test("returns query.metadata-required only when requested ownership metadata is absent", () => {
    expect(errorCode(() => index().query(query({ roles: ["literature-searcher"] })))).toBe("query.metadata-required");
    const withMetadata = buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: ledger() });
    expect(errorCode(() => withMetadata.query(query({ sourceRefs: [{ sourceId: source().sourceId, revision: 1 }], taskIds: [TASK] })))).toBe("query.metadata-required");
  });
  test("returns query.metadata-invalid for malformed duplicate and inconsistent ledger ownership", () => {
    const bad = ledger(); bad[3] = { ...bad[3]!, seq: 8 }; expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: bad }))).toBe("query.metadata-invalid");
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(records({ verifications: [verification()] })), ledgerEvents: ledger() }))).toBe("query.metadata-invalid");
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot(), ledgerEvents: new Proxy([], { ownKeys() { throw new Error("SECRET-METADATA"); } }) }))).toBe("query.metadata-invalid");
  });
  test("enforces filter page cursor closure byte and record hard maxima", () => { expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot() }, { maxFilterValues: 100_001 }))).toBe("query.invalid-options"); expect(errorCode(() => index(undefined, { maxFilterValues: 1 }).query(query({ stances: ["supporting", "neutral"] })))).toBe("query.filter-too-large"); });
  test("rejects forged or hash-mismatched snapshot with query.invalid-input", () => { const s = snapshot(); expect(errorCode(() => buildEvidenceIndex({ snapshot: Object.freeze({ ...s }) }))).toBe("query.invalid-input"); });
  test("maps unknown keys inside EvidenceQuery only to query.invalid-input", () => {
    const i = index();
    expect(errorCode(() => i.query({ ...query(), secret: "SECRET" } as never))).toBe("query.invalid-input");
    expect(errorCode(() => i.query(new Proxy({}, { ownKeys() { throw new Error("SECRET-PROXY"); }, get() { throw new Error("SECRET-PROXY"); } }) as never))).toBe("query.invalid-input");
    const accessor: Record<string, unknown> = { maxSelectedBytes: 1_000 };
    Object.defineProperty(accessor, "limit", { enumerable: true, get() { throw new Error("SECRET-ACCESSOR"); } });
    expect(errorCode(() => i.query(accessor as never))).toBe("query.invalid-input");
    const excessRef = { evidenceId: evidence().evidenceId, revision: 1, extra: true };
    expect(errorCode(() => i.query(query({ evidenceRefs: [excessRef as never] })))).toBe("query.invalid-input");
    const sparse = new Array(1) as EvidenceRecord["stance"][];
    expect(errorCode(() => i.query(query({ stances: sparse })))).toBe("query.invalid-input");
  });
  test("maps unknown keys inside index and snapshot options only to query.invalid-options", () => {
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot() }, { secret: 1 } as never))).toBe("query.invalid-options");
    expect(errorCode(() => buildEvidenceIndexFromRecords(records(), undefined, { secret: 1 } as never))).toBe("query.invalid-options");
    const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, "maxLedgerEvents", { enumerable: true, get() { throw new Error("SECRET-OPTION"); } });
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot() }, accessor))).toBe("query.invalid-options");
    expect(errorCode(() => buildEvidenceIndex({ snapshot: snapshot() }, { maxSelectedPerKind: { sources: 1, claims: 1, evidence: 1, verifications: 1, requests: 1, calculations: 1, secret: 1 } } as never))).toBe("query.invalid-options");
  });
  test("rejects unknown and non-pagination build options with query.invalid-options before allocation", () => { const hostile = new Proxy({}, { ownKeys() { throw new Error("SECRET"); } }); expect(errorCode(() => buildEvidenceIndex({ snapshot: hostile as never }, { maxLedgerEvents: 0 }))).toBe("query.invalid-options"); });
  test("maps every admission identity lineage reference and bound branch to one closed code without message leakage", () => {
    const a = source("src-query.lineagea", { lineage: { ...source().lineage, relatedSourceIds: ["src-query.lineageb"], relationTypes: ["version-of"] } });
    const b = source("src-query.lineageb", { identifiers: { doi: "10.1234/lineage-b", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/lineage-b", lineage: { ...source().lineage, studyId: "study-b", relatedSourceIds: [a.sourceId], relationTypes: ["version-of"] } });
    const cases: Array<[() => unknown, string]> = [
      [() => index().query(query({ evidenceRefs: [{ evidenceId: "ev-9999999999999999", revision: 1 }] })), "query.unresolved-ref"],
      [() => index().query(query({ evidenceRefs: [{ evidenceId: "bad", revision: 1 }] as never })), "query.reference-invalid"],
      [() => buildEvidenceIndexFromRecords(records({ sources: [source(), { ...source(), sourceId: "src-query.00000002" }] }), undefined), "query.identity-invalid"],
      [() => buildEvidenceIndexFromRecords(records({ sources: [source(undefined, { lineage: { ...source().lineage, cohortIds: ["duplicate", "duplicate"] } })] }), undefined), "query.identity-invalid"],
      [() => buildEvidenceIndexFromRecords(records({ claims: [claim(), { ...claim() }] }), undefined), "query.invalid-evidence-set"],
      [() => buildEvidenceIndexFromRecords(records({ sources: [a, b], evidence: [evidence(undefined, { sourceRef: { sourceId: a.sourceId, revision: 1 } })] }), undefined), "query.lineage-invalid"],
    ]; for (const [action, expected] of cases) expect(errorCode(action)).toBe(expected);
  });
  test("enforces per-kind total record byte and reference bounds without partial closure", () => { const i = index(connectedRecords(), { maxSelectedPerKind: { sources: 1, claims: 1, evidence: 1, verifications: 1, requests: 1, calculations: 1 }, maxTotalSelectedRecords: 6 }); expect(i.query(query()).sources).toHaveLength(1); });
  test("returns immutable snapshots with no cross-query aliasing", () => { const i = index(); const a = i.query(query()); const b = i.query(query()); expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.evidence)).toBe(true); expect(a.evidence[0]).not.toBe(b.evidence[0]); expect(() => ((a.evidence[0] as { confidence: number }).confidence = 0)).toThrow(); });
  test("uses indexes rather than full corpus scans for selective queries", () => {
    const corpus = (count: number): CanonicalEvidenceSet => { const claims = Array.from({ length: count }, (_, n) => claim(`claim-${String(n + 1).padStart(16, "0")}`, { evidenceRefs: [{ evidenceId: `ev-${String(n + 1).padStart(16, "0")}`, revision: 1 }] })); const evidenceValues = claims.map((item, n) => evidence(`ev-${String(n + 1).padStart(16, "0")}`, { claimRef: { claimId: item.claimId, revision: 1 } })); return records({ claims, evidence: evidenceValues }); };
    const run = (count: number) => { const d = queryDiagnostics(); const set = corpus(count); const i = buildEvidenceIndexWithDiagnosticsInternal({ snapshot: snapshot(set) }, undefined, d); i.query(query({ evidenceRefs: [{ evidenceId: set.evidence[0]!.evidenceId, revision: 1 }] })); return d; };
    const n = run(8); const twice = run(16); expect(twice.indexVisits).toBeGreaterThan(n.indexVisits); expect(twice.candidateVisits).toBe(n.candidateVisits); expect(twice.closureVisits).toBe(n.closureVisits); expect(n.candidateVisits).toBe(1); expect(n.closureVisits).toBeLessThanOrEqual(3); expect([n.normalizedQueryCanonicalizations, twice.normalizedQueryCanonicalizations]).toEqual([1, 1]);
  });
});
