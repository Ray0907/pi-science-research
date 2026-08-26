import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../src/crypto/canonical-json.js";
import type { SourceRecord } from "../../src/domain/research-records.js";
import {
  ScholarlyIdentifierError,
  canonicalDoiUrl,
  canonicalPmcidUrl,
  canonicalPmidUrl,
  normalizeCanonicalUrl,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  validateProspectiveSourceIdentityFields,
} from "../../src/scholarly/identifiers.js";

const REQUEST = "request-0000000000000001";
const HASH = "a".repeat(64);

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    schemaVersion: 1,
    sourceId: "src-openalex.w1",
    revision: 1,
    identifiers: { doi: "10.1234/example", pmid: "123", pmcid: "PMC456" },
    canonicalUrl: "https://doi.org/10.1234/example",
    title: "Title",
    authors: [{ family: "Doe", given: "J", literal: null, orcid: null }],
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    published: { date: "2026-01-01", precision: "day" },
    publicationType: "journal-article",
    peerReviewStatus: "yes",
    accessLevel: "full-text",
    retrievedAt: "2026-08-25T12:00:00.000Z",
    retrievalRequestIds: [REQUEST],
    metadataProvenance: [{ field: "title", provider: "openalex", requestId: REQUEST }],
    lineage: { studyId: null, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] },
    ...overrides,
  };
}

function code(action: () => unknown): string | undefined {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(ScholarlyIdentifierError);
    expect((error as Error).message).not.toMatch(/example\.org|secret|Title/);
    return (error as ScholarlyIdentifierError).code;
  }
  return undefined;
}

describe("scholarly identifiers", () => {
  test("normalizes DOI forms without accepting Unicode confusables", () => {
    expect(normalizeDoi("  DOI:10.1234/AbC  ")).toBe("10.1234/abc");
    expect(normalizeDoi("https://dx.doi.org/10.1234/A%2Fb")).toBe("10.1234/a/b");
    expect(normalizeDoi("10.123456789/a")).toBe("10.123456789/a");
    for (const value of [
      "10.123/a", "10.1234567890/a", "ＤＯＩ:10.1234/a", "10．1234/a", "10.1234／a",
      "10.1234/Α", "10.1234/а", "10.1234/é", "10.1234/é",
    ]) expect(code(() => normalizeDoi(value))).toBe("identifier.invalid-doi");
  });

  test("rejects malformed DOI resolver URLs and ambiguous punctuation", () => {
    for (const value of [
      "https://doi.org/10.1234", "https://doi.org/10.1234/a?x=1", "https://doi.org/10.1234/a#x", "https://doi.org/10.1234/a/../b",
      "https://user@doi.org/10.1234/a", "https://doi.org/10.1234%2Fa", "https://doi.org/10.1234/%ZZ",
      "10.1234/a%ZZ", "10.1234/a?query", "10.1234/a#fragment", "10.1234/a\n", "10.1234/a b",
    ]) expect(code(() => normalizeDoi(value))).toBe("identifier.invalid-doi");
    expect(normalizeDoi("10.1234/a.")).toBe("10.1234/a.");
  });

  test("normalizes PMID and PMCID decimal forms", () => {
    expect(normalizePmid(" PMID:000123 ")).toBe("123");
    expect(normalizePmcid(" pmcid:pmc000456 ")).toBe("PMC456");
    expect(normalizePmcid("PMC1")).toBe("PMC1");
    expect(normalizePmid("999999999999")).toBe("999999999999");
    for (const value of ["0", "１２３", "1234567890123"]) expect(code(() => normalizePmid(value))).toBe("identifier.invalid-pmid");
    for (const value of ["PMC0", "PMC１２", "PM123"]) expect(code(() => normalizePmcid(value))).toBe("identifier.invalid-pmcid");
  });

  test("rejects Unicode digits, bidi controls, boxed strings and oversized identifiers", () => {
    expect(code(() => normalizePmid(new String("123")))).toBe("identifier.invalid-type");
    expect(code(() => normalizeDoi("10.1234/a\0b"))).toBe("identifier.invalid-doi");
    expect(code(() => normalizeDoi("10.1234/a\u2066b"))).toBe("identifier.invalid-doi");
    expect(code(() => normalizeDoi("10.1234/\ud800"))).toBe("identifier.invalid-type");
    expect(code(() => normalizeDoi("10.1234/" + "a".repeat(513)))).toBe("identifier.invalid-doi");
    expect(code(() => normalizeDoi("a".repeat(4096), { maxCanonicalScalarBytes: 32 }))).toBe("identifier.too-long");
  });

  test("canonicalizes safe URLs without changing query semantics", () => {
    expect(normalizeCanonicalUrl(" HTTPS://Example.COM:443/a/../Path?q=2&q=1&x=%7e "))
      .toBe("https://example.com/Path?q=2&q=1&x=%7e");
    expect(normalizeCanonicalUrl("http://Example.COM:80/a", { allowHttp: true })).toBe("http://example.com/a");
    expect(normalizeCanonicalUrl("https://example.com/é")).toBe("https://example.com/%C3%A9");
    expect(normalizeCanonicalUrl("https://example.com/%2F")).toBe("https://example.com/%2F");
    expect(normalizeCanonicalUrl("https://example.com/?")).toBe("https://example.com/?");
    expect(normalizeCanonicalUrl("https://[2001:db8::1]:443/a")).toBe("https://[2001:db8::1]/a");
    expect(normalizeCanonicalUrl("https://example.com/a")).toBe(normalizeCanonicalUrl(normalizeCanonicalUrl("https://example.com/a")));
  });

  test("rejects credentials, fragments, forbidden schemes and raw Unicode hosts", () => {
    expect(code(() => normalizeCanonicalUrl("https://u:p@example.com/a"))).toBe("url.credentials-forbidden");
    expect(code(() => normalizeCanonicalUrl("https://@example.org/"))).toBe("url.credentials-forbidden");
    expect(code(() => normalizeCanonicalUrl("https://example.com/a#x"))).toBe("url.fragment-forbidden");
    expect(code(() => normalizeCanonicalUrl("https://example.org/#"))).toBe("url.fragment-forbidden");
    expect(code(() => normalizeCanonicalUrl("ftp://example.com/a"))).toBe("url.unsupported-scheme");
    expect(code(() => normalizeCanonicalUrl("mailto:reader@example.com"))).toBe("url.unsupported-scheme");
    expect(code(() => normalizeCanonicalUrl("http://example.com/a"))).toBe("url.unsupported-scheme");
    for (const malformed of [
      "https:/example.org/", "https:example.org/", "https:///example.org/", "https:\\example.org/",
      "https:\\\\example.org/", "https:/éxample.org/", "https://éxample.org/a", "https://example.org/%ZZ",
      "https://example.org:/", "https://%65xample.org/", "https://[2001:db8::1/",
    ]) expect(code(() => normalizeCanonicalUrl(malformed))).toBe("url.invalid");
    expect(code(() => normalizeCanonicalUrl("https://example.org/a b"))).toBe("url.invalid");
    expect(code(() => normalizeCanonicalUrl("https://example.org/\ud800"))).toBe("identifier.invalid-type");
    expect(code(() => normalizeCanonicalUrl("not a url"))).toBe("url.invalid");
  });

  test("prospective source validation requires canonical identifiers and URLs", () => {
    const input = source();
    const result = validateProspectiveSourceIdentityFields(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identifiers)).toBe(true);
    expect(Object.isFrozen(result.authors)).toBe(true);
    input.identifiers.doi = null;
    expect(result.identifiers.doi).toBe("10.1234/example");
    expect(code(() => validateProspectiveSourceIdentityFields(source({ identifiers: { doi: "DOI:10.1234/EXAMPLE", pmid: "123", pmcid: "PMC456" } }))))
      .toBe("identifier.invalid-doi");
    expect(code(() => validateProspectiveSourceIdentityFields(source({ canonicalUrl: "https://EXAMPLE.org/" })))).toBe("url.invalid");
  });

  test("defaults prospective source HTTP policy to deny", () => {
    const input = source({ identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://example.org/a" });
    expect(code(() => validateProspectiveSourceIdentityFields(input))).toBe("url.unsupported-scheme");
    expect(code(() => validateProspectiveSourceIdentityFields(input, { allowHttp: false, approvedHttpHosts: ["example.org"] })))
      .toBe("url.http-context-invalid");
  });

  test("allows HTTP only for exact approved trusted hosts without rewriting schemes", () => {
    const input = source({ identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "http://example.org/a" });
    const policy = { allowHttp: true, approvedHttpHosts: ["example.org"], accessPolicySha256: HASH } as const;
    expect(validateProspectiveSourceIdentityFields(input, policy).canonicalUrl).toBe("http://example.org/a");
    expect(code(() => validateProspectiveSourceIdentityFields(input, { ...policy, approvedHttpHosts: ["other.org"] })))
      .toBe("url.http-host-not-approved");
    for (const approvedHttpHosts of [["*.example.org"], ["Example.org"], ["127.0.0.1"], ["example.org", "example.org"]])
      expect(code(() => validateProspectiveSourceIdentityFields(input, { ...policy, approvedHttpHosts }))).toBe("url.http-context-invalid");
    expect(code(() => validateProspectiveSourceIdentityFields(input, { allowHttp: true, approvedHttpHosts: ["example.org"] })))
      .toBe("url.http-context-invalid");
    expect(code(() => validateProspectiveSourceIdentityFields(input, { ...policy, accessPolicySha256: "bad" }))).toBe("url.http-context-invalid");
    expect(code(() => validateProspectiveSourceIdentityFields(input, { ...policy, approvedHttpHosts: ["x".repeat(254)] })))
      .toBe("identifier.invalid-options");
  });

  test("derives only allowlisted DOI PMID and PMCID resolver URLs", () => {
    const cases = [
      [canonicalDoiUrl, "10.1234/A/B", "https://doi.org/10.1234/a%2Fb"],
      [canonicalPmidUrl, "PMID:00012", "https://pubmed.ncbi.nlm.nih.gov/12/"],
      [canonicalPmcidUrl, "pmcid:pmc00012", "https://pmc.ncbi.nlm.nih.gov/articles/PMC12/"],
    ] as const;
    for (const [derive, input, expected] of cases) {
      const exactBytes = Buffer.byteLength(canonicalJson(expected));
      expect(derive(input, { maxCanonicalScalarBytes: exactBytes })).toBe(expected);
      expect(code(() => derive(input, { maxCanonicalScalarBytes: exactBytes - 1 }))).toBe("identifier.too-long");
    }
    const multibyte = "10.1234/é";
    const inputBytes = Buffer.byteLength(canonicalJson(multibyte));
    expect(code(() => canonicalDoiUrl(multibyte, { maxCanonicalScalarBytes: inputBytes }))).toBe("identifier.invalid-doi");
    expect(code(() => canonicalDoiUrl(multibyte, { maxCanonicalScalarBytes: inputBytes - 1 }))).toBe("identifier.too-long");
  });

  test("rejects canonical scalar bytes before identifier and URL parsing", () => {
    const doi = "10.1234/exact";
    const exactDoiBytes = Buffer.byteLength(canonicalJson(doi));
    expect(normalizeDoi(doi, { maxCanonicalScalarBytes: exactDoiBytes })).toBe(doi);
    expect(code(() => normalizeDoi(doi, { maxCanonicalScalarBytes: exactDoiBytes - 1 }))).toBe("identifier.too-long");
    const multibyteUrl = "https://example.org/é";
    const exactUrlBytes = Buffer.byteLength(canonicalJson(multibyteUrl));
    expect(normalizeCanonicalUrl(multibyteUrl, { maxCanonicalScalarBytes: exactUrlBytes })).toBe("https://example.org/%C3%A9");
    expect(code(() => normalizeCanonicalUrl(multibyteUrl, { maxCanonicalScalarBytes: exactUrlBytes - 1 }))).toBe("url.too-long");
    const oversized = "https://" + "x".repeat(100);
    expect(code(() => normalizeCanonicalUrl(oversized, { maxCanonicalScalarBytes: 20 }))).toBe("url.too-long");
    expect(code(() => normalizeDoi("10.1234/" + "x".repeat(100), { maxCanonicalScalarBytes: 20 }))).toBe("identifier.too-long");
  });

  test("counts quotes escapes and nested URL query text through canonicalJson bytes", () => {
    expect(Buffer.byteLength(canonicalJson("\"".repeat(10)))).toBeGreaterThan(Buffer.byteLength("\"".repeat(10)));
    expect(code(() => normalizeCanonicalUrl("https://example.org/?q=" + "\"".repeat(10), { maxCanonicalScalarBytes: 32 }))).toBe("url.too-long");
  });

  test("rejects an oversized prospective source record before nested identity reads", () => {
    const exact = source({ title: "nested".repeat(1_000), authors: [{ family: "Family".repeat(100), given: "Given", literal: null, orcid: null }] });
    const exactBytes = Buffer.byteLength(canonicalJson(exact));
    expect(validateProspectiveSourceIdentityFields(exact, undefined, { maxSourceRecordCanonicalBytes: exactBytes })).toEqual(exact);
    expect(code(() => validateProspectiveSourceIdentityFields(exact, undefined, { maxSourceRecordCanonicalBytes: exactBytes - 1 })))
      .toBe("identifier.record-too-large");
    let touched = false;
    const unsafe = { ...source(), title: "x".repeat(300), get identifiers() { touched = true; return source().identifiers; } };
    expect(code(() => validateProspectiveSourceIdentityFields(unsafe as SourceRecord, undefined, { maxSourceRecordCanonicalBytes: 256 })))
      .toBe("identifier.record-too-large");
    expect(touched).toBe(false);
    expect(code(() => validateProspectiveSourceIdentityFields(source({ title: "\"".repeat(300) }), undefined, { maxSourceRecordCanonicalBytes: 512 })))
      .toBe("identifier.record-too-large");
    expect(code(() => validateProspectiveSourceIdentityFields(new Proxy(source(), {}) as SourceRecord)))
      .toBe("identifier.record-too-large");
    const cyclic = source() as SourceRecord & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(code(() => validateProspectiveSourceIdentityFields(cyclic))).toBe("identifier.record-too-large");
  });

  test("rejects unknown and above-hard scalar options with identifier.invalid-options", () => {
    expect(code(() => normalizeDoi("10.1234/a", { extra: 1 } as never))).toBe("identifier.invalid-options");
    expect(code(() => normalizeDoi("10.1234/a", new Proxy({}, {}) as never))).toBe("identifier.invalid-options");
    expect(code(() => normalizeDoi("10.1234/a", { get maxCanonicalScalarBytes() { return 4_096; } }))).toBe("identifier.invalid-options");
    const sparse: unknown[] = []; sparse.length = 1;
    expect(code(() => validateProspectiveSourceIdentityFields(source(), { allowHttp: true, approvedHttpHosts: sparse as string[], accessPolicySha256: HASH })))
      .toBe("identifier.invalid-options");
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(code(() => normalizeDoi("10.1234/a", cyclic as never))).toBe("identifier.invalid-options");
    expect(code(() => normalizeDoi("10.1234/a", { maxCanonicalScalarBytes: 16_385 }))).toBe("identifier.invalid-options");
    expect(code(() => validateProspectiveSourceIdentityFields(source(), undefined, { maxSourceRecordCanonicalBytes: 1_048_577 })))
      .toBe("identifier.invalid-options");
    expect(code(() => validateProspectiveSourceIdentityFields(source(), { allowHttp: true, approvedHttpHosts: [], accessPolicySha256: HASH })))
      .toBe("url.http-context-invalid");
  });

  test("reports exact closed ScholarlyIdentifierError codes", () => {
    const cases: Array<[() => unknown, string]> = [
      [() => normalizeDoi(1), "identifier.invalid-type"], [() => normalizeDoi("bad"), "identifier.invalid-doi"],
      [() => normalizePmid("x"), "identifier.invalid-pmid"], [() => normalizePmcid("x"), "identifier.invalid-pmcid"],
      [() => normalizeCanonicalUrl(1), "identifier.invalid-type"], [() => normalizeCanonicalUrl("https://example.org/%ZZ"), "url.invalid"],
    ];
    for (const [action, expected] of cases) expect(code(action)).toBe(expected);
  });
});
