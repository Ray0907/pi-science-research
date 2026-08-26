import { describe, expect, test } from "vitest";

import type { RequestRecord } from "../../src/domain/events.js";
import type {
  CalculationRecord, ClaimRecord, EvidenceRecord, SourceRecord, VerificationRecord,
} from "../../src/domain/research-records.js";
import {
  EvidenceAdmissionError,
  buildBoundedValidatedEvidenceSnapshot,
  evaluateEvidenceRule,
  evaluateEvidenceRuleFromRecords,
  validateCanonicalEvidenceSet,
  validateProspectiveEvidenceSemantics,
  type CanonicalEvidenceSet,
  type EvidenceAdmissionErrorCode,
} from "../../src/evidence/admission.js";

const AT = "2026-08-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const ATTEMPT_A = "attempt-0000000000000001";
const ATTEMPT_B = "attempt-0000000000000002";

function source(id = "src-admission.0001", overrides: Partial<SourceRecord> = {}): SourceRecord {
  const doi = `10.1234/${id.slice(4)}`;
  return {
    schemaVersion: 1, sourceId: id, revision: 1,
    identifiers: { doi, pmid: null, pmcid: null }, canonicalUrl: `https://doi.org/${doi}`,
    title: `Title ${id}`, authors: [{ family: "Doe", given: "J", literal: null, orcid: null }],
    containerTitle: null, publisher: null, volume: null, issue: null, pages: null,
    published: { date: "2026-01-01", precision: "day" }, publicationType: "journal-article",
    peerReviewStatus: "yes", accessLevel: "full-text", retrievedAt: AT,
    retrievalRequestIds: [], metadataProvenance: [],
    lineage: { studyId: `study-${id}`, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] },
    ...overrides,
  };
}
function claim(id = "claim-0000000000000001", overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    schemaVersion: 1, claimId: id, revision: 1, statement: `Claim ${id}`,
    kind: "externally-verifiable-fact", materiality: "load-bearing",
    scopeQualifiers: { population: null, intervention: null, comparator: null, outcome: null, timeRange: null },
    evidenceRule: { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: false, fullTextRequired: false },
    status: "supported", confidence: 0.8, evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }],
    conflictClaimIds: [], createdByAttemptId: ATTEMPT_A,
    ...overrides,
  };
}
function evidence(id = "ev-0000000000000001", overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schemaVersion: 1, evidenceId: id, revision: 1,
    claimRef: { claimId: "claim-0000000000000001", revision: 1 }, evidenceType: "retrieved",
    sourceRef: { sourceId: "src-admission.0001", revision: 1 }, calculationId: null,
    stance: "supporting", quotes: ["quoted result"], locators: [{ type: "page", value: "1" }], extractedValues: [], method: null,
    quality: "primary-peer-reviewed", confidence: 0.8, recordedByAttemptId: ATTEMPT_A,
    verificationStatus: "verified", conflictsWith: [], ...overrides,
  };
}
function verification(id = "verify-0000000000000001", overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    schemaVersion: 1, verificationId: id, revision: 1, attemptId: ATTEMPT_B, method: "independent-source",
    checkedClaims: [{ claimId: "claim-0000000000000001", revision: 1 }],
    checkedEvidence: [{ evidenceId: "ev-0000000000000001", revision: 1 }],
    requestIds: [], calculationIds: [], result: "accepted", corrections: [], independentEvidenceIds: [], notes: "ok", ...overrides,
  };
}
function calculation(id = "calc-0000000000000001", overrides: Partial<CalculationRecord> = {}): CalculationRecord {
  const file = (relativePath: string) => ({ relativePath, mediaType: "application/json", decodedBytes: 0, sha256: HASH });
  return {
    schemaVersion: 1, calculationId: id, attemptId: ATTEMPT_A, sandboxPolicySha256: HASH,
    runtime: "node", command: "calculate", environment: [], inputs: [file("input.json")], sourceFiles: [], outputs: [file("output.json")],
    networkEnabled: false, startedAt: AT, endedAt: AT, exitCode: 0, status: "success", ...overrides,
  };
}
function request(id: string, sourceId: string, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    schemaVersion: 1, requestId: id, attemptId: ATTEMPT_A, executionEpoch: 0,
    logicalRequestId: `logical-${id}`, physicalAttemptOrdinal: 1, retryOfRequestId: null, replayPolicy: "safe-read",
    provider: "openalex", operation: "fetch", normalizedInput: { query: null, identifier: null, url: "https://api.example/a", parameters: [] },
    accessPolicySha256: HASH, startedAt: AT, endedAt: AT, status: "success", httpStatus: 200,
    requestedUrl: "https://api.example/a", finalUrl: `https://example.org/${sourceId}`, redirectUrls: [],
    responseSha256: null, responseFile: null, encodedBytes: 0, decodedBytes: 0,
    resultSourceIds: [sourceId], errorClass: null, ...overrides,
  };
}
function set(overrides: Partial<CanonicalEvidenceSet> = {}): CanonicalEvidenceSet {
  return {
    sources: [source()], claims: [claim()], evidence: [evidence()], verifications: [], requests: [], calculations: [], ...overrides,
  };
}
function errorCode(action: () => unknown): EvidenceAdmissionErrorCode | undefined {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(EvidenceAdmissionError);
    expect((error as Error).message).toBe(`Evidence admission rejected (${(error as EvidenceAdmissionError).code})`);
    expect((error as Error).message).not.toMatch(/Title|quoted|example\.org|SECRET/u);
    return (error as EvidenceAdmissionError).code;
  }
  return undefined;
}
function evaluate(records: CanonicalEvidenceSet, ref = { claimId: "claim-0000000000000001", revision: 1 }) {
  return evaluateEvidenceRuleFromRecords(records, ref);
}

function derived(method: string | null, calc: string | null, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return evidence("ev-0000000000000002", {
    evidenceType: "derived", sourceRef: null, calculationId: calc, method,
    quotes: [], locators: [], extractedValues: [{ value: "42", numericValue: 42, unit: "1", context: "derived output" }],
    ...overrides,
  });
}

describe("evidence admission", () => {
  test("evaluates an exact historical claim closure without rebinding exact revisions", () => {
    const c1 = claim();
    const c2 = { ...c1, revision: 2, status: "disputed" as const };
    const result = evaluate({ ...set(), claims: [c2, c1] });
    expect(result.passes).toBe(true);
    expect(result.claimRef).toEqual({ claimId: c1.claimId, revision: 1 });
  });
  test("keeps historical evidence eligible after a later evidence revision exists", () => {
    const e1 = evidence(); const e2 = { ...e1, revision: 2, verificationStatus: "rejected" as const };
    const c1 = claim(); const c2 = { ...c1, revision: 2, evidenceRefs: [{ evidenceId: e2.evidenceId, revision: 2 }] };
    const result = evaluate({ ...set(), claims: [c1, c2], evidence: [e2, e1] });
    expect(result.supportingEvidenceRefs).toEqual([{ evidenceId: e1.evidenceId, revision: 1 }]);
  });
  test("keeps retained historical exact refs valid while new latest refs must be current", () => {
    const e1 = evidence(); const e2 = { ...e1, revision: 2, claimRef: { claimId: claim().claimId, revision: 2 } };
    const c1 = claim(); const c2 = { ...c1, revision: 2, evidenceRefs: [...c1.evidenceRefs, { evidenceId: e1.evidenceId, revision: 2 }] };
    expect(evaluate({ ...set(), claims: [c1, c2], evidence: [e1, e2] }, refFor(c2)).passes).toBe(true);
    const f1 = { ...e1, evidenceId: "ev-0000000000000003", claimRef: { claimId: c1.claimId, revision: 2 } };
    const f2 = { ...f1, revision: 2 };
    const stale = { ...c2, evidenceRefs: [...c1.evidenceRefs, refForEvidence(f1)] };
    expect(errorCode(() => evaluate({ ...set(), claims: [c1, stale], evidence: [e1, e2, f1, f2] }, refFor(stale)))).toBe("evidence.stale-latest-ref");
  });
  test("rejects verification credit that checked the wrong claim or evidence revision", () => {
    const independent = evidence("ev-0000000000000002", { sourceRef: { sourceId: "src-admission.0002", revision: 1 }, recordedByAttemptId: ATTEMPT_B });
    const c2 = { ...claim(), revision: 2 };
    const v = verification(undefined, { checkedClaims: [{ claimId: c2.claimId, revision: 2 }], checkedEvidence: [refForEvidence(independent)], independentEvidenceIds: [independent.evidenceId] });
    const result = evaluate({ ...set(), sources: [source(), source("src-admission.0002")], claims: [claim(), c2], evidence: [evidence(), independent], verifications: [v] });
    expect(result.independentVerificationCredit).toBe(0);
  });
  test("selects latest applicable verification without unrelated-revision invalidation", () => {
    const v1 = verification(); const v2 = { ...v1, revision: 2, checkedClaims: [{ claimId: claim().claimId, revision: 2 }] };
    const snapshot = buildBoundedValidatedEvidenceSnapshot({ ...set(), claims: [claim(), { ...claim(), revision: 2 }], verifications: [v2, v1] });
    expect(evaluateEvidenceRule(snapshot, refFor(claim()))).toBeDefined();
  });
  test("traverses latest exact conflict and lineage closure with visited bounds", () => {
    const e1 = evidence(); const e2 = evidence("ev-0000000000000002", { stance: "contradicting", conflictsWith: [e1.evidenceId] });
    const linked = { ...e1, conflictsWith: [e2.evidenceId] };
    const c = { ...claim(), evidenceRefs: [refForEvidence(linked), refForEvidence(e2)] };
    expect(evaluate({ ...set(), claims: [c], evidence: [linked, e2] }).contradictingEvidenceRefs).toHaveLength(1);
  });
  test("requires immutable claim identity fields across revisions", () => {
    const c1 = claim(); const c2 = { ...c1, revision: 2, statement: "Changed" };
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), claims: [c1, c2] }))).toBe("evidence.invalid-prospective-record");
  });
  test("counts dependent evidence as one lineage and unknown evidence as zero", () => {
    const s1 = source(); const s2 = source("src-admission.0002", { lineage: { ...s1.lineage, studyId: s1.lineage.studyId } });
    const e1 = evidence(); const e2 = evidence("ev-0000000000000002", { sourceRef: refForSource(s2) });
    const c = { ...claim(), evidenceRefs: [refForEvidence(e1), refForEvidence(e2)] };
    expect(evaluate({ ...set(), sources: [s1, s2], claims: [c], evidence: [e1, e2] }).retrievedComponentCount).toBe(1);
    const unknown = source("src-admission.0003", { lineage: { ...s1.lineage, studyId: null } });
    const e3 = evidence("ev-0000000000000003", { sourceRef: refForSource(unknown) });
    expect(evaluate({ ...set(), sources: [unknown], evidence: [e3], claims: [{ ...claim(), evidenceRefs: [refForEvidence(e3)] }] }).retrievedComponentCount).toBe(0);
  });
  test("enforces primary source and full text evidence rules", () => {
    const c = claim(undefined, { evidenceRule: { minimumLineages: 1, independentVerificationAllowed: false, primarySourceRequired: true, fullTextRequired: true } });
    const s = source(undefined, { accessLevel: "abstract-only" });
    const e = evidence(undefined, { quality: "official" });
    expect(evaluate({ ...set(), sources: [s], claims: [c], evidence: [e] }).blockers).toEqual(expect.arrayContaining(["claim.primary-source-required", "claim.full-text-required"]));
  });
  test("accepts method-based derivation with identifiable source or extracted input context without calculation", () => {
    const d = derived("deterministic method", null, { sourceRef: refForSource(source()) });
    const c = claim(undefined, { kind: "derived-result", evidenceRefs: [refForEvidence(d)] });
    expect(evaluate({ ...set(), claims: [c], evidence: [d] }).derivedComponentCount).toBe(1);
  });
  test("accepts calculation derivation with input or source file declared output and result context", () => {
    const calc = calculation(); const d = derived(null, calc.calculationId);
    const c = claim(undefined, { kind: "derived-result", evidenceRefs: [refForEvidence(d)] });
    expect(evaluate({ ...set(), claims: [c], evidence: [d], calculations: [calc] }).derivedComponentCount).toBe(1);
  });
  test("accepts valid zero-byte calculation files and current V1 exit semantics", () => {
    expect(evaluateDerivedCalculation(calculation()).passes).toBe(true);
  });
  test("rejects bare method failed calculation missing input output and result context paths", () => {
    const bad = derived("method", null, { extractedValues: [], quotes: [] });
    const c = claim(undefined, { kind: "derived-result", evidenceRefs: [refForEvidence(bad)] });
    expect(evaluate({ ...set(), claims: [c], evidence: [bad] }).blockers).toContain("claim.invalid-derived-evidence");
  });
  test("requires derived extracted values or located quotes to link reproducible result context", () => {
    const bad = derived("method", null, { sourceRef: refForSource(source()), extractedValues: [], quotes: ["result"], locators: [] });
    const c = claim(undefined, { kind: "derived-result", evidenceRefs: [refForEvidence(bad)] });
    expect(evaluate({ ...set(), claims: [c], evidence: [bad] }).derivedComponentCount).toBe(0);
  });
  test("keeps contradictions disputed without majority inference", () => {
    const contradiction = evidence("ev-0000000000000002", { stance: "contradicting" });
    const c = { ...claim(), evidenceRefs: [refForEvidence(evidence()), refForEvidence(contradiction)] };
    expect(evaluate({ ...set(), claims: [c], evidence: [evidence(), contradiction] }).blockers).toContain("claim.unresolved-conflict");
  });
  test("resolves conflict only through snapshot-selected applicable verification and reconciled statuses", () => {
    const contradiction = evidence("ev-0000000000000002", { stance: "contradicting", verificationStatus: "rejected" });
    const c = { ...claim(), evidenceRefs: [refForEvidence(evidence()), refForEvidence(contradiction)] };
    const v = verification(undefined, { checkedEvidence: c.evidenceRefs, corrections: [{ claimId: c.claimId, description: "resolved" }] });
    expect(evaluate({ ...set(), claims: [c], evidence: [evidence(), contradiction], verifications: [v] }).blockers).not.toContain("claim.unresolved-conflict");
  });
  test("requires snapshot-selected accepted exact-revision verification for conflict and independent credit", () => {
    const v1 = verification(); const v2 = { ...v1, revision: 2, result: "incomplete" as const };
    expect(evaluate({ ...set(), verifications: [v1, v2] }).independentVerificationCredit).toBe(0);
  });
  test("credits at most one verifier-owned checked independent evidence component", () => {
    const s2 = source("src-admission.0002");
    const extra = evidence("ev-0000000000000002", { sourceRef: refForSource(s2), recordedByAttemptId: ATTEMPT_B });
    const v = verification(undefined, { checkedEvidence: [refForEvidence(extra)], independentEvidenceIds: [extra.evidenceId] });
    expect(evaluate({ ...set(), sources: [source(), s2], evidence: [evidence(), extra], verifications: [v] }).independentVerificationCredit).toBeLessThanOrEqual(1);
  });
  test("reports retrieved derived base verification and effective counts exactly", () => {
    const d = derived("method", null, { sourceRef: refForSource(source()) });
    const c = claim(undefined, { evidenceRefs: [refForEvidence(evidence()), refForEvidence(d)] });
    const result = evaluate({ ...set(), claims: [c], evidence: [evidence(), d] });
    expect(result).toEqual(expect.objectContaining({ retrievedComponentCount: 1, derivedComponentCount: 1, resolvedLineageCount: 2, effectiveIndependentCount: 2 }));
  });
  test("counts retrieved and derived components once under minimumLineages", () => {
    const calc = calculation(); const d1 = derived(null, calc.calculationId); const d2 = { ...d1, evidenceId: "ev-0000000000000003" };
    const c = claim(undefined, { evidenceRefs: [refForEvidence(d1), refForEvidence(d2)] });
    expect(evaluate({ ...set(), claims: [c], evidence: [d1, d2], calculations: [calc] }).derivedComponentCount).toBe(1);
  });
  test("never double counts verification evidence already in a base component", () => {
    const v = verification(undefined, { independentEvidenceIds: [evidence().evidenceId] });
    expect(evaluate({ ...set(), verifications: [v] }).independentVerificationCredit).toBe(0);
  });
  test("orders every blocker branch by the closed total order", () => {
    const c = claim(undefined, { kind: "derived-result", status: "disputed", evidenceRefs: [], evidenceRule: { minimumLineages: 2, independentVerificationAllowed: false, primarySourceRequired: true, fullTextRequired: true } });
    expect(evaluate({ ...set(), claims: [c], evidence: [] }).blockers).toEqual([
      "claim.unsupported", "claim.invalid-derived-evidence", "claim.primary-source-required", "claim.insufficient-lineages",
    ]);
  });
  test("distinguishes independent verification required from insufficient lineages", () => {
    const c = claim(undefined, { evidenceRule: { ...claim().evidenceRule, minimumLineages: 2, independentVerificationAllowed: true } });
    expect(evaluate({ ...set(), claims: [c] }).blockers).toContain("claim.independent-verification-required");
    const noVerification = { ...c, evidenceRule: { ...c.evidenceRule, independentVerificationAllowed: false } };
    expect(evaluate({ ...set(), claims: [noVerification] }).blockers).toContain("claim.insufficient-lineages");
  });
  test("rejects same-attempt unchecked wrong-claim stale and unresolved verification evidence", () => {
    const v = verification(undefined, { attemptId: ATTEMPT_A, checkedClaims: [], independentEvidenceIds: ["ev-9999999999999999"] });
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), verifications: [v] }))).toBe("evidence.unresolved-ref");
  });
  test("gives recomputation and rederivation zero credit without canonical input provenance", () => {
    for (const method of ["recomputation", "rederivation"] as const) {
      expect(evaluate({ ...set(), verifications: [verification(undefined, { method })] }).independentVerificationCredit).toBe(0);
    }
  });
  test("validates quotation locators numeric units and contexts", () => {
    const badQuote = evidence(undefined, { quotes: [""], locators: [{ type: "page", value: "" }] });
    expect(errorCode(() => validateProspectiveEvidenceSemantics(badQuote))).toBe("evidence.invalid-prospective-record");
    const badValue = evidence(undefined, { extractedValues: [{ value: "1", numericValue: 1, unit: null, context: "" }] });
    expect(errorCode(() => validateProspectiveEvidenceSemantics(badValue))).toBe("evidence.invalid-prospective-record");
  });
  test("separately bounds every evidence kind total refs components and per-claim evidence", () => {
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot(set(), { limits: { maxPerKind: { sources: 1, claims: 1, evidence: 1, verifications: 1, requests: 1, calculations: 1 }, maxTotalRecords: 1, maxLineageComponents: 1 } }))).toBe("evidence.too-many-records");
    expect(errorCode(() => evaluateEvidenceRule(buildBoundedValidatedEvidenceSnapshot(set()), refFor(claim()), { maxEvidencePerClaim: 0 }))).toBe("evidence.invalid-options");
  });
  test("rejects invalid evidence limits with evidence.invalid-options", () => {
    for (const options of [{ limits: { maxTotalRecords: 0 } }, { limits: { unknown: 1 } }, { unknown: 1 }, new Proxy({}, {})])
      expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot(set(), options as never))).toBe("evidence.invalid-options");
  });
  test("resolves canonical requests and bounds requests records references and per-claim evidence", () => {
    const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/article", retrievalRequestIds: ["request-0000000000000001"] });
    const r = request("request-0000000000000001", s.sourceId, { finalUrl: s.canonicalUrl });
    expect(buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s], requests: [r] }).requestProvenanceIndex.requestCount).toBe(1);
  });
  test("rejects duplicate canonical URLs without strong conflicts during reopen audit", () => {
    const a = source(); const b = source("src-admission.0002", { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: a.canonicalUrl });
    const first = { ...a, identifiers: { doi: null, pmid: null, pmcid: null } };
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [first, b] }))).toBe("evidence.duplicate-source-identity");
  });
  test("rejects same canonical URL with conflicting strong identifiers as ambiguity", () => {
    const a = source(); const b = source("src-admission.0002", { identifiers: { doi: "10.1234/conflict", pmid: null, pmcid: null }, canonicalUrl: a.canonicalUrl });
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [a, b] }))).toBe("evidence.ambiguous-source-identity");
  });
  test("requires source canonical URL transport metadata or allowlisted resolver provenance", () => {
    const bad = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/unattributed" });
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [bad] }))).toBe("evidence.source-url-unattributed");
  });
  test("accepts provider article URL and rejects wrong request provider or terminal provenance", () => {
    const id = "request-0000000000000001";
    const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://article.example/a", retrievalRequestIds: [id], metadataProvenance: [{ field: "canonicalUrl", provider: "openalex", requestId: id }] });
    const r = request(id, s.sourceId, { finalUrl: "https://api.example/result" });
    expect(buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s], requests: [r] })).toBeDefined();
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s], requests: [{ ...r, provider: "crossref" }] }))).toBe("evidence.source-url-metadata-mismatch");
  });
  test("evaluator defaults direct HTTP source validation to evidence.source-url-policy-invalid", () => {
    const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://trusted.example/a" });
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s] }))).toBe("evidence.source-url-policy-invalid");
  });
  test("evaluator admits direct HTTP source only with exact approved host and access policy hash", () => {
    const id = "request-0000000000000001";
    const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://trusted.example/a", retrievalRequestIds: [id] });
    const r = request(id, s.sourceId, { finalUrl: s.canonicalUrl });
    const sourceUrlPolicy = { allowHttp: true, approvedHttpHosts: ["trusted.example"], accessPolicySha256: HASH } as const;
    expect(buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s], requests: [r] }, { sourceUrlPolicy })).toBeDefined();
  });
  test("evaluator rejects wrong approved host as policy-invalid and wrong request policy hash as request-mismatch", () => {
    const id = "request-0000000000000001"; const s = source(undefined, { identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://trusted.example/a", retrievalRequestIds: [id] });
    const r = request(id, s.sourceId, { finalUrl: s.canonicalUrl });
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s], requests: [r] }, { sourceUrlPolicy: { allowHttp: true, approvedHttpHosts: ["other.example"], accessPolicySha256: HASH } }))).toBe("evidence.source-url-policy-invalid");
    expect(errorCode(() => buildBoundedValidatedEvidenceSnapshot({ ...set(), sources: [s], requests: [{ ...r, accessPolicySha256: "b".repeat(64) }] }, { sourceUrlPolicy: { allowHttp: true, approvedHttpHosts: ["trusted.example"], accessPolicySha256: HASH } }))).toBe("evidence.source-url-request-mismatch");
  });
  test("prospective evidence semantics reject invalid text with exact error codes", () => {
    const legacy = evidence(undefined, { quotes: [""] });
    expect(errorCode(() => validateProspectiveEvidenceSemantics(legacy))).toBe("evidence.invalid-prospective-record");
    expect(validateCanonicalEvidenceSet(set()).evidence).toHaveLength(1);
  });
  test("builds transitive evidence and claim conflict closure instead of direct-only admission", () => {
    const a = evidence(undefined, { conflictsWith: ["ev-0000000000000002"] });
    const b = evidence("ev-0000000000000002", { stance: "neutral", conflictsWith: [a.evidenceId, "ev-0000000000000003"] });
    const c = evidence("ev-0000000000000003", { stance: "contradicting", conflictsWith: [b.evidenceId] });
    const target = claim(undefined, { evidenceRefs: [refForEvidence(a)] });
    expect(evaluate({ ...set(), claims: [target], evidence: [a, b, c] }).blockers).toContain("claim.unresolved-conflict");

    const otherEvidence = evidence("ev-0000000000000004", { claimRef: { claimId: "claim-0000000000000002", revision: 1 }, stance: "contradicting" });
    const first = claim(undefined, { conflictClaimIds: ["claim-0000000000000002"] });
    const second = claim("claim-0000000000000002", { evidenceRefs: [refForEvidence(otherEvidence)], conflictClaimIds: [first.claimId] });
    expect(evaluate({ ...set(), claims: [first, second], evidence: [evidence(), otherEvidence] }).contradictingEvidenceRefs).toContainEqual(refForEvidence(otherEvidence));
  });
  test("bounds cyclic conflict closure before expansion", () => {
    const a = evidence(undefined, { conflictsWith: ["ev-0000000000000002"] });
    const b = evidence("ev-0000000000000002", { conflictsWith: [a.evidenceId] });
    const target = claim(undefined, { evidenceRefs: [refForEvidence(a)] });
    const snapshot = buildBoundedValidatedEvidenceSnapshot({ ...set(), claims: [target], evidence: [a, b] });
    expect(errorCode(() => evaluateEvidenceRule(snapshot, refFor(target), { maxEvidencePerClaim: 1 }))).toBe("evidence.too-many-records");
  });
  test("requires current verified resolved independent evidence distinct from every base component", () => {
    const unknown = source("src-admission.0002", { lineage: { studyId: null, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] } });
    const independent = evidence("ev-0000000000000002", { sourceRef: refForSource(unknown), recordedByAttemptId: ATTEMPT_B, verificationStatus: "verified" });
    const v = verification(undefined, { checkedEvidence: [refForEvidence(independent)], independentEvidenceIds: [independent.evidenceId] });
    expect(evaluate({ ...set(), sources: [source(), unknown], evidence: [evidence(), independent], verifications: [v] }).independentVerificationCredit).toBe(0);
    const resolved = source("src-admission.0003");
    const unverified = { ...independent, evidenceId: "ev-0000000000000003", sourceRef: refForSource(resolved), verificationStatus: "unverified" as const };
    const v2 = verification(undefined, { checkedEvidence: [refForEvidence(unverified)], independentEvidenceIds: [unverified.evidenceId] });
    expect(evaluate({ ...set(), sources: [source(), resolved], evidence: [evidence(), unverified], verifications: [v2] }).independentVerificationCredit).toBe(0);
    const current = { ...independent, sourceRef: refForSource(resolved) }; const later = { ...current, revision: 2 };
    const stale = verification(undefined, { checkedEvidence: [refForEvidence(current)], independentEvidenceIds: [current.evidenceId] });
    expect(evaluate({ ...set(), sources: [source(), resolved], evidence: [evidence(), current, later], verifications: [stale] }).independentVerificationCredit).toBe(0);
  });
  test("requires a distinct conflict verifier and complete reconciled correction", () => {
    const contradiction = evidence("ev-0000000000000002", { stance: "contradicting", verificationStatus: "rejected" });
    const target = claim(undefined, { evidenceRefs: [refForEvidence(evidence()), refForEvidence(contradiction)] });
    const sameAttempt = verification(undefined, { attemptId: ATTEMPT_A, checkedEvidence: target.evidenceRefs, corrections: [{ claimId: target.claimId, description: "resolved" }] });
    expect(evaluate({ ...set(), claims: [target], evidence: [evidence(), contradiction], verifications: [sameAttempt] }).blockers).toContain("claim.unresolved-conflict");
  });
  test("assigns deterministic lineage keys across study cohort dataset components and input permutations", () => {
    const s1 = source();
    const s2 = source("src-admission.0002", { lineage: { studyId: "study-two", cohortIds: s1.lineage.cohortIds, datasetIds: ["dataset-shared"], relatedSourceIds: [], relationTypes: [] } });
    const s3 = source("src-admission.0003", { lineage: { studyId: "study-three", cohortIds: [], datasetIds: ["dataset-shared"], relatedSourceIds: [], relationTypes: [] } });
    const items = [evidence(), evidence("ev-0000000000000002", { sourceRef: refForSource(s2) }), evidence("ev-0000000000000003", { sourceRef: refForSource(s3) })];
    const target = claim(undefined, { evidenceRefs: items.map(refForEvidence) });
    const forward = evaluate({ ...set(), sources: [s1, s2, s3], claims: [target], evidence: items });
    const reversed = evaluate({ ...set(), sources: [s3, s2, s1], claims: [target], evidence: [...items].reverse() });
    expect(forward.retrievedComponentCount).toBe(2);
    expect(reversed).toEqual(forward);
  });
  test("requires latest evidence revisions for refs introduced by latest revision-one claim", () => {
    const e1 = evidence(); const e2 = { ...e1, revision: 2 };
    expect(errorCode(() => evaluate({ ...set(), evidence: [e1, e2] }))).toBe("evidence.stale-latest-ref");
  });
  test("rejects unsafe calculation descriptors from derived credit", () => {
    const unsafe = calculation(undefined, { inputs: [{ relativePath: "input.json", mediaType: "application/json", decodedBytes: Number.MAX_SAFE_INTEGER + 1, sha256: HASH }] });
    const result = evaluateDerivedCalculation(unsafe);
    expect(result.derivedComponentCount).toBe(0);
    expect(result.blockers).toContain("claim.invalid-derived-evidence");
    const fallback = derived("documented method", unsafe.calculationId, { sourceRef: refForSource(source()) });
    const target = claim(undefined, { kind: "derived-result", evidenceRefs: [refForEvidence(fallback)] });
    expect(evaluate({ ...set(), claims: [target], evidence: [fallback], calculations: [unsafe] }).derivedComponentCount).toBe(1);
  });
  test("validates the complete prospective limits object before touching the record", () => {
    const hard = {
      maxTotalRecords: 1_000_000, maxReferences: 2_000_000, maxLineageComponents: 500_000,
      maxCanonicalScalarBytes: 16_384, maxSourceRecordCanonicalBytes: 1_048_576, maxRequestRecordCanonicalBytes: 1_048_576,
      maxClaimRecordCanonicalBytes: 1_048_576, maxEvidenceRecordCanonicalBytes: 1_048_576,
      maxVerificationRecordCanonicalBytes: 1_048_576, maxCalculationRecordCanonicalBytes: 1_048_576,
      maxCanonicalEvidenceSetBytes: 134_217_728,
    } as const;
    const everyInvalid = [
      { maxPerKind: { sources: 1, claims: 1, evidence: 1, verifications: 1, requests: 1, calculations: 0 } },
      ...Object.entries(hard).map(([key, maximum]) => ({ [key]: maximum + 1 })),
      { maxTotalRecords: Number.MAX_SAFE_INTEGER + 1 }, { maxReferences: 0 }, { maxLineageComponents: -1 },
      { maxCanonicalScalarBytes: 0 }, { maxSourceRecordCanonicalBytes: 0 }, { maxRequestRecordCanonicalBytes: 0 },
      { maxClaimRecordCanonicalBytes: 0 }, { maxEvidenceRecordCanonicalBytes: 0 }, { maxVerificationRecordCanonicalBytes: 0 },
      { maxCalculationRecordCanonicalBytes: 0 }, { maxCanonicalEvidenceSetBytes: 0 },
      { maxTotalRecords: 10, maxLineageComponents: 11 },
      { maxCanonicalScalarBytes: 100, maxSourceRecordCanonicalBytes: 99 },
      { maxEvidenceRecordCanonicalBytes: 2_000, maxCanonicalEvidenceSetBytes: 1_999 },
      { unknown: 1 },
    ];
    const trapped = new Proxy({}, { get() { throw new Error("SECRET-RECORD"); }, ownKeys() { throw new Error("SECRET-RECORD"); } });
    for (const limits of everyInvalid)
      expect(errorCode(() => validateProspectiveEvidenceSemantics(trapped as never, limits as never))).toBe("evidence.invalid-options");
  });
});

function refFor(value: ClaimRecord) { return { claimId: value.claimId, revision: value.revision }; }
function refForEvidence(value: EvidenceRecord) { return { evidenceId: value.evidenceId, revision: value.revision }; }
function refForSource(value: SourceRecord) { return { sourceId: value.sourceId, revision: value.revision }; }
function evaluateDerivedCalculation(calc: CalculationRecord) {
  const d = derived(null, calc.calculationId); const c = claim(undefined, { kind: "derived-result", evidenceRefs: [refForEvidence(d)] });
  return evaluate({ ...set(), claims: [c], evidence: [d], calculations: [calc] });
}
