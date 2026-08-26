import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { parseResearchRecord, type SourceRecord } from "../../src/domain/research-records.js";
import { ScholarlyIdentifierError, validateProspectiveSourceIdentityFields } from "../../src/scholarly/identifiers.js";

const AT = "2026-08-25T12:00:00.000Z";
const HASH = "a".repeat(64);
const ATTEMPT = "attempt-0000000000000001";

export function sourceRecord() {
  return { schemaVersion: 1, sourceId: "src-openalex.w1", revision: 1,
    identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/1", title: "Title",
    authors: [{ family: "Doe", given: "J", literal: null, orcid: null }], containerTitle: null, publisher: null,
    volume: null, issue: null, pages: null, published: { date: "2026-01-01", precision: "day" }, publicationType: "journal-article",
    peerReviewStatus: "yes", accessLevel: "full-text", retrievedAt: AT, retrievalRequestIds: ["request-0000000000000001"],
    metadataProvenance: [{ field: "title", provider: "openalex", requestId: "request-0000000000000001" }],
    lineage: { studyId: null, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] } } as const;
}
export function claimRecord() {
  return { schemaVersion: 1, claimId: "claim-0000000000000001", revision: 1, statement: "Claim", kind: "externally-verifiable-fact",
    materiality: "load-bearing", scopeQualifiers: { population: null, intervention: null, comparator: null, outcome: null, timeRange: null },
    evidenceRule: { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: false, fullTextRequired: false },
    status: "supported", confidence: 0.8, evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }],
    conflictClaimIds: [], createdByAttemptId: ATTEMPT } as const;
}
export function evidenceRecord() {
  return { schemaVersion: 1, evidenceId: "ev-0000000000000001", revision: 1,
    claimRef: { claimId: "claim-0000000000000001", revision: 1 }, evidenceType: "retrieved", sourceRef: { sourceId: "src-openalex.w1", revision: 1 },
    calculationId: null, stance: "supporting", quotes: ["quote"], locators: [{ type: "page", value: "1" }], extractedValues: [], method: null,
    quality: "primary-peer-reviewed", confidence: 0.8, recordedByAttemptId: ATTEMPT, verificationStatus: "verified", conflictsWith: [] } as const;
}
export function verificationRecord() {
  return { schemaVersion: 1, verificationId: "verify-0000000000000001", revision: 1, attemptId: ATTEMPT, method: "independent-source",
    checkedClaims: [{ claimId: "claim-0000000000000001", revision: 1 }], checkedEvidence: [{ evidenceId: "ev-0000000000000001", revision: 1 }],
    requestIds: ["request-0000000000000001"], calculationIds: ["calc-0000000000000001"], result: "accepted", corrections: [],
    independentEvidenceIds: ["ev-0000000000000001"], notes: "ok" } as const;
}
export function calculationRecord() {
  return { schemaVersion: 1, calculationId: "calc-0000000000000001", attemptId: ATTEMPT, sandboxPolicySha256: HASH, runtime: "node", command: "calc",
    environment: [], inputs: [], sourceFiles: [], outputs: [], networkEnabled: false, startedAt: AT, endedAt: AT, exitCode: 0, status: "success" } as const;
}

describe("closed research record schemas", () => {
  test.each([
    ["sources", sourceRecord()], ["claims", claimRecord()], ["evidence", evidenceRecord()],
    ["verifications", verificationRecord()], ["calculations", calculationRecord()],
  ] as const)("accepts exact %s records and rejects extras", (kind, value) => {
    expect(parseResearchRecord(kind, value).success).toBe(true);
    expect(parseResearchRecord(kind, { ...value, unexpected: true }).success).toBe(false);
  });

  test("enforces retrieved and derived evidence requirements", () => {
    expect(parseResearchRecord("evidence", { ...evidenceRecord(), sourceRef: null }).success).toBe(false);
    expect(parseResearchRecord("evidence", { ...evidenceRecord(), quotes: [], extractedValues: [] }).success).toBe(false);
    expect(parseResearchRecord("evidence", { ...evidenceRecord(), evidenceType: "derived", sourceRef: null, quotes: [], calculationId: null, method: null }).success).toBe(false);
    expect(parseResearchRecord("evidence", { ...evidenceRecord(), evidenceType: "derived", sourceRef: null, quotes: [], calculationId: "calc-0000000000000001", method: null }).success).toBe(true);
  });

  test("preserves pre-increment V1 SourceRecord parser compatibility", () => {
    const legacy = {
      ...sourceRecord(),
      identifiers: { doi: "DOI:10.1234/Legacy", pmid: "000123", pmcid: "pmc000456" },
      canonicalUrl: "https://EXAMPLE.org:443/a/../paper",
    };
    const before = canonicalJson(legacy);
    const parsed = parseResearchRecord("sources", legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && canonicalJson(parsed.value)).toBe(before);
    try {
      validateProspectiveSourceIdentityFields(legacy as unknown as SourceRecord);
      throw new Error("expected prospective validation to reject legacy source");
    } catch (error) {
      expect(error).toBeInstanceOf(ScholarlyIdentifierError);
      expect((error as ScholarlyIdentifierError).code).toBe("identifier.invalid-doi");
    }
  });

  test("enforces confidence, exact refs and calculation status", () => {
    expect(parseResearchRecord("claims", { ...claimRecord(), confidence: 1.1 }).success).toBe(false);
    expect(parseResearchRecord("claims", { ...claimRecord(), evidenceRefs: [{ evidenceId: "bad", revision: 1 }] }).success).toBe(false);
    expect(parseResearchRecord("calculations", { ...calculationRecord(), exitCode: 1 }).success).toBe(false);
    expect(parseResearchRecord("calculations", { ...calculationRecord(), status: "failed", exitCode: 2 }).success).toBe(true);
    expect(parseResearchRecord("calculations", { ...calculationRecord(), status: "cancelled", exitCode: 0 }).success).toBe(false);
    expect(parseResearchRecord("calculations", { ...calculationRecord(), status: "cancelled", exitCode: null }).success).toBe(true);
  });
});
