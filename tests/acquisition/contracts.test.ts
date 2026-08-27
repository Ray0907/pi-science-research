import { describe, expect, test, vi } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import {
  AcquisitionContractError,
  acquisitionSinkBeforeDispatchInternal,
  acquisitionSinkSettledInternal,
  acquisitionTraceSettlementInternal,
  assertNormalizedAcquisitionOptionsInternal,
  assertProviderRequestPartitionInternal,
  assertProviderRequestPartitionOwnedByInternal,
  closeProviderPartitionPlanOwnerInternal,
  createAcademicCandidate,
  createAcademicDocument,
  createAcquisitionProvenanceSinkInternal,
  createAcquisitionTrace,
  createBlockedTraceSettlementInternal,
  createProviderPartitionKey,
  createProviderPartitionPlanOwnerInternal,
  createProviderRequestPartitionFixtureInternal,
  lookupProviderRequestPartitionInternal,
  lookupProviderRequestPartitionOwnerInternal,
  normalizeAcquisitionOptions,
  registerProviderRequestPartitionInternal,
  validateAcademicAcquisitionResult,
  type AcademicAcquisitionResult,
  type AcademicCandidate,
  type AcademicCandidateGroup,
  type AcquisitionTrace,
  type ProviderPartitionRegistryOptionsInternal,
  type TransportSettlement,
} from "../../src/acquisition/contracts.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AT = "2026-08-27T12:00:00.000Z";
const LATER = "2026-08-27T12:01:00.000Z";
const URL = "https://api.crossref.org/works?query=SECRET";
const PARTITION_LIMITS: ProviderPartitionRegistryOptionsInternal = {
  maxPartitions: 12,
  maxCanonicalUrlBytes: 4_096,
  maxStructureDepth: 16,
  maxStructureNodes: 10_000,
  maxStructureKeys: 10_000,
  maxStringCanonicalBytes: 262_144,
  maxScalarCanonicalBytes: 1_048_576,
};

function errorCode(action: () => unknown): string | undefined {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(AcquisitionContractError);
    expect((error as Error).message).toMatch(/^Acquisition contract rejected \(acquisition-contract\.[a-z-]+\)$/u);
    expect((error as Error).message).not.toMatch(/SECRET|crossref|10\.1234|api\./u);
    return (error as AcquisitionContractError).code;
  }
  return undefined;
}
async function asyncErrorCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); }
  catch (error) {
    expect(error).toBeInstanceOf(AcquisitionContractError);
    return (error as AcquisitionContractError).code;
  }
  return undefined;
}
function partitionPreimage(overrides: Record<string, unknown> = {}) {
  return {
    provider: "crossref", operation: "search", endpointClass: "works-search", target: "crossref",
    normalizedInput: { kind: "query", query: "cancer", limit: 10 }, requestedUrl: URL,
    ...overrides,
  } as const;
}
function partitionSnapshot(overrides: Record<string, unknown> = {}) {
  const preimage = partitionPreimage(overrides);
  const key = createProviderPartitionKey(preimage as Parameters<typeof createProviderPartitionKey>[0]);
  const { requestedUrl, ...fields } = preimage;
  return {
    ...fields,
    ...key,
    normalizedInputSha256: sha256Hex(canonicalJson(preimage.normalizedInput)),
    url: requestedUrl,
  };
}
function settlement(overrides: Partial<TransportSettlement> = {}): TransportSettlement {
  const key = createProviderPartitionKey(partitionPreimage());
  return {
    schemaVersion: 1, ...key, provider: "crossref", operation: "search", endpointClass: "works-search",
    normalizedOrigin: "https://api.crossref.org", requestedUrl: URL, finalUrl: "https://api.crossref.org/works?page=2",
    redirectWitnesses: [{ ordinal: 1, status: 302, fromUrl: URL, fromOrigin: "https://api.crossref.org", toUrl: "https://api.crossref.org/works?page=2", toOrigin: "https://api.crossref.org" }],
    httpStatus: 200, encodedBytes: 12, decodedBytes: 12, responsePayloadSha256: HASH_A,
    responseHeaders: { contentType: "application/json", retryAfter: null, etag: null, lastModified: null },
    responseHeadersSha256: HASH_B, connectedPeer: { address: "93.184.216.34", family: 4 },
    startedAt: AT, settledAt: LATER, outcome: "success", failureCode: null, payloadUtf8: "{}", ...overrides,
  } as TransportSettlement;
}
function trace(overrides: Record<string, unknown> = {}): AcquisitionTrace {
  const projected = acquisitionTraceSettlementInternal(settlement(), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 });
  const key = createProviderPartitionKey(partitionPreimage());
  return createAcquisitionTrace({
    provider: "crossref", operation: "search", endpointClass: "works-search", ...key,
    accessLevel: "metadata-only", settlement: projected, warnings: [], ...overrides,
  } as never);
}
function candidate(overrides: Record<string, unknown> = {}): AcademicCandidate {
  const t = trace();
  return createAcademicCandidate({
    provider: "crossref", endpointClass: "works-search", providerRecordId: "10.1234/example", providerOrdinal: null,
    partitionKeySha256: t.partitionKeySha256, responsePayloadSha256: HASH_A, traceKey: t.traceKey,
    identifiers: { doi: "10.1234/example", pmid: null, pmcid: null }, canonicalUrl: "https://doi.org/10.1234/example",
    title: null, authors: [], containerTitle: null, publisher: null, published: { date: null, precision: "unknown" },
    publicationType: "journal-article", accessLevel: "metadata-only", abstractText: null, ...overrides,
  } as never);
}
function document(c = candidate(), t = trace()) {
  return createAcademicDocument({
    pmcid: "PMC123", candidateKey: c.candidateKey, partitionKeySha256: t.partitionKeySha256,
    responsePayloadSha256: HASH_A, provider: "pmc", traceKey: t.traceKey, accessLevel: "full-text",
    sections: [{ sectionType: "results", text: "value" }],
  } as never);
}
function group(c: AcademicCandidate, overrides: Partial<AcademicCandidateGroup> = {}): AcademicCandidateGroup {
  const identityKind = overrides.identityKind ?? "doi";
  const identityValueSha256 = overrides.identityValueSha256 ?? sha256Hex(canonicalJson(c.identifiers.doi));
  const candidateKeys = overrides.candidateKeys ?? [c.candidateKey];
  const status = overrides.status ?? "compatible";
  const groupKey = `candidate-group-v1-${sha256Hex(canonicalJson({ schemaVersion: 1, identityKind, identityValueSha256, sortedCandidateKeys: [...candidateKeys].sort(), status }))}` as const;
  return { groupKey, identityKind, identityValueSha256, status, candidateKeys };
}
function result(overrides: Partial<AcademicAcquisitionResult> = {}): AcademicAcquisitionResult {
  const t = trace(); const c = candidate();
  return {
    schemaVersion: 1, provenanceStatus: "uncommitted", status: "complete", normalizedQueries: ["cancer"],
    partitions: { requested: 1, dispatched: 1, succeeded: 1, failed: 0, blocked: 0 },
    candidates: [c], candidateGroups: [group(c)], documents: [], traces: [t], failures: [], optionsSha256: HASH_A,
    ...overrides,
  };
}

// These tests intentionally name every approved Task 1 behavior.
describe("immutable acquisition contracts", () => {
  test("normalizes every acquisition option default hard maximum and canonical hash exactly once", () => {
    const value = normalizeAcquisitionOptions(undefined);
    expect(value.transport).toMatchObject({ maxDnsAddresses: 16, maxRedirects: 5, maxEncodedBytes: 8_388_608, maxDecodedBodyBytes: 16_777_216, connectTimeoutMs: 10_000, requestDeadlineMs: 60_000 });
    expect(value.providers).toMatchObject({ maxProviderRecords: 100, maxJoinedPmids: 100, maxPartitions: 12, maxAggregateDrafts: 200 });
    expect(value).toMatchObject({ maxQueries: 4, maxPartitions: 12, maxConcurrency: 4, maxPerOriginConcurrency: 2, maxCleanupDiagnostics: 323, maxResultsPerQuery: 25, maxVisibleBytes: 24_576, maxVisibleLines: 500 });
    expect(value.optionsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalizeAcquisitionOptions({ maxPartitions: 64, maxCleanupDiagnostics: 323 }).maxPartitions).toBe(64);
    expect(errorCode(() => normalizeAcquisitionOptions({ maxPartitions: 65, maxCleanupDiagnostics: 328 }))).toBe("acquisition-contract.invalid-options");
  });

  test("rejects unknown getter setter proxy mutation alias and malformed nested options before capability access", () => {
    let reads = 0; const getter = Object.defineProperty({}, "maxQueries", { enumerable: true, get() { reads += 1; return 1; } });
    expect(errorCode(() => normalizeAcquisitionOptions(getter))).toBe("acquisition-contract.invalid-options"); expect(reads).toBe(0);
    expect(errorCode(() => normalizeAcquisitionOptions(new Proxy({}, {})))).toBe("acquisition-contract.invalid-options");
    expect(errorCode(() => normalizeAcquisitionOptions({ surprise: 1 }))).toBe("acquisition-contract.invalid-options");
    const shared = {}; expect(errorCode(() => normalizeAcquisitionOptions({ transport: shared, providers: shared }))).toBe("acquisition-contract.invalid-options");
    const cyclic: Record<string, unknown> = {}; cyclic.transport = cyclic; expect(errorCode(() => normalizeAcquisitionOptions(cyclic))).toBe("acquisition-contract.invalid-options");
  });

  test("enforces all option consistency including provider records joined pmids concurrency deadlines aliases visible and cleanup capacity", () => {
    const invalid = [
      { maxConcurrency: 2, maxPerOriginConcurrency: 3 },
      { transport: { connectTimeoutMs: 20_000, requestDeadlineMs: 10_000 } },
      { maxVisibleBytes: 49_153 }, { maxVisibleLines: 2_001 },
      { maxResultsPerQuery: 50, providers: { maxProviderRecords: 49 } },
      { maxResultsPerQuery: 50, providers: { maxJoinedPmids: 49 } },
      { maxPartitions: 13, maxCleanupDiagnostics: 67 },
      { maxPartitions: 13, providers: { maxPartitions: 12 } },
      { maxAggregateCandidates: 201, providers: { maxAggregateDrafts: 200 } },
      { providers: { maxProviderRecords: 101, maxConditionalIdentifiers: 100 } },
      { providers: { maxProviderRecordCanonicalBytes: 262_145, maxConditionalFactCanonicalBytes: 262_144 } },
    ];
    for (const value of invalid) expect(errorCode(() => normalizeAcquisitionOptions(value))).toBe("acquisition-contract.invalid-options");
  });

  test("deep-freezes one branded normalized view and rejects forged clone changed hash nested identity and cross-module values", () => {
    const value = normalizeAcquisitionOptions(undefined); expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.transport)).toBe(true);
    assertNormalizedAcquisitionOptionsInternal(value);
    expect(errorCode(() => assertNormalizedAcquisitionOptionsInternal({ ...value }))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => assertNormalizedAcquisitionOptionsInternal({ ...value, transport: { ...value.transport } }))).toBe("acquisition-contract.invalid-capability");
  });

  test("keeps normalized transport planner fields and options hash stable after raw option mutation with O1 repeated assertions", () => {
    const raw = { maxQueries: 3, transport: { maxDnsAddresses: 4 } }; const value = normalizeAcquisitionOptions(raw);
    raw.maxQueries = 2; raw.transport.maxDnsAddresses = 5;
    expect(value.maxQueries).toBe(3); expect(value.transport.maxDnsAddresses).toBe(4);
    const hash = value.optionsSha256; for (let index = 0; index < 10_000; index += 1) assertNormalizedAcquisitionOptionsInternal(value); expect(value.optionsSha256).toBe(hash);
  });

  test("hashes exact collision-free partition candidate trace document and group preimages", () => {
    const a = createProviderPartitionKey(partitionPreimage()); const b = createProviderPartitionKey(partitionPreimage({ endpointClass: "works-fetch" }));
    expect(a.partitionKey).toBe(`partition-v1-${a.partitionKeySha256}`); expect(a.partitionKey).not.toBe(b.partitionKey);
    const c = candidate(); const changed = candidate({ responsePayloadSha256: HASH_B }); expect(c.candidateKey).not.toBe(changed.candidateKey);
    const t = trace(); const d = document(c, t); expect(d.documentKey).toMatch(/^document-v1-[a-f0-9]{64}$/u);
    expect(group(c).groupKey).toMatch(/^candidate-group-v1-[a-f0-9]{64}$/u);
  });

  test("registers opaque bounded partitions under exact plan-owner identity and returns frozen lookup snapshots", () => {
    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_A}`, options: PARTITION_LIMITS });
    const item = registerProviderRequestPartitionInternal(owner, partitionSnapshot());
    expect(Object.keys(item)).toEqual(["capabilityKind"]); assertProviderRequestPartitionInternal(item); assertProviderRequestPartitionOwnedByInternal(item, owner);
    const looked = lookupProviderRequestPartitionInternal(item); expect(looked.url).toBe(URL); expect(Object.isFrozen(looked)).toBe(true); expect(lookupProviderRequestPartitionInternal(item)).not.toBe(looked);
    expect(lookupProviderRequestPartitionOwnerInternal(item)).toBe(owner);
  });

  test("rejects forged foreign closed-owner duplicate and key-mismatched partition registrations", () => {
    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_A}`, options: PARTITION_LIMITS });
    const foreign = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_B}`, options: PARTITION_LIMITS });
    const item = registerProviderRequestPartitionInternal(owner, partitionSnapshot());
    expect(errorCode(() => assertProviderRequestPartitionInternal({ capabilityKind: "provider-request-partition" }))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => assertProviderRequestPartitionOwnedByInternal(item, foreign))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, partitionSnapshot()))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => registerProviderRequestPartitionInternal(foreign, { ...partitionSnapshot(), partitionKeySha256: HASH_A }))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => registerProviderRequestPartitionInternal(foreign, { ...partitionSnapshot(), requestedUrl: URL }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => registerProviderRequestPartitionInternal(foreign, { ...partitionSnapshot({ provider: "pubmed" }), partitionKey: createProviderPartitionKey(partitionPreimage({ provider: "pubmed" }) as never).partitionKey, partitionKeySha256: createProviderPartitionKey(partitionPreimage({ provider: "pubmed" }) as never).partitionKeySha256 }))).toBe("acquisition-contract.invalid-input");
    closeProviderPartitionPlanOwnerInternal(owner); closeProviderPartitionPlanOwnerInternal(owner);
    expect(errorCode(() => lookupProviderRequestPartitionInternal(item))).toBe("acquisition-contract.invalid-capability");
  });

  test("keeps timestamp out of trace key while every deterministic settlement fact changes it", () => {
    const a = trace(); const b = trace({ settlement: { ...a.settlement, retrievedAt: AT } }); expect(a.traceKey).toBe(b.traceKey);
    expect(trace({ accessLevel: "abstract-only" }).traceKey).not.toBe(a.traceKey);
    expect(trace({ settlement: { ...a.settlement, decodedBytes: a.settlement.decodedBytes + 1 } }).traceKey).not.toBe(a.traceKey);
  });

  test("projects requested final redirect URLs with query redaction hashes bounds status access and retrieval time", () => {
    const projected = acquisitionTraceSettlementInternal(settlement(), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 });
    expect(projected.requestedUrl.canonicalUrl).toBe("https://api.crossref.org/works?redacted");
    expect(projected.finalUrl?.canonicalUrl).toBe("https://api.crossref.org/works?redacted");
    expect(projected.redirects).toHaveLength(1); expect(projected.code).toBe("success"); expect(projected.retrievedAt).toBe(LATER);
    expect(projected.requestedUrl.canonicalUrlSha256).toBe(sha256Hex(canonicalJson({ schemaVersion: 1, url: URL })));
    const limits = Object.defineProperty({ maxRedirects: 5 }, "maxCanonicalUrlBytes", { enumerable: true, get() { throw new Error("getter"); } });
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement(), limits as never))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ responseHeaders: { contentType: 42 as never, retryAfter: null, etag: null, lastModified: null } }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-input");
  });

  test("requires provider ordinal only when a stable provider record ID is absent", () => {
    expect(errorCode(() => candidate({ providerRecordId: "id", providerOrdinal: 1 }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => candidate({ providerRecordId: null, providerOrdinal: null }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => candidate({ identifiers: { doi: "DOI:10.1234/EXAMPLE", pmid: null, pmcid: null } }))).toBe("acquisition-contract.invalid-input");
    expect(candidate({ providerRecordId: null, providerOrdinal: 0 }).providerOrdinal).toBe(0);
  });

  test("keeps provider-result candidates and null metadata without invention", () => {
    const value = candidate(); expect(value.title).toBeNull(); expect(value.publisher).toBeNull(); expect(value.authors).toEqual([]); expect(value.provenanceStatus).toBe("uncommitted");
  });

  test("groups compatible strong IDs then URL fallback while retaining ambiguity", () => {
    const c = candidate(); const compatible = group(c); const ambiguous = group(c, { status: "ambiguous" });
    expect(validateAcademicAcquisitionResult(result({ candidateGroups: [compatible] })).candidateGroups[0]?.status).toBe("compatible");
    expect(validateAcademicAcquisitionResult(result({ candidateGroups: [ambiguous] })).candidateGroups[0]?.status).toBe("ambiguous");
  });

  test("constructors require PMCID candidate partition and payload hashes plus every claimed field", () => {
    expect(document().pmcid).toBe("PMC123");
    expect(errorCode(() => document(candidate(), trace({ partitionKeySha256: HASH_B })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => createAcademicDocument({ ...document(), documentKey: undefined } as never))).toBeDefined();
  });

  test("public constructors force uncommitted and reject any provenanceStatus input property", () => {
    expect(candidate().provenanceStatus).toBe("uncommitted"); expect(trace().provenanceStatus).toBe("uncommitted"); expect(document().provenanceStatus).toBe("uncommitted");
    const { candidateKey: _candidateKey, schemaVersion: _schemaVersion, provenanceStatus: _status, ...input } = candidate();
    expect(errorCode(() => createAcademicCandidate({ ...input, provenanceStatus: "staged" } as never))).toBe("acquisition-contract.invalid-provenance");
  });

  test("rejects hostile plain nested staged and mixed objects in public validator", () => {
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...result(), provenanceStatus: "staged" }))).toBe("acquisition-contract.invalid-provenance");
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...result(), candidates: [{ ...candidate(), provenanceStatus: "staged" }] }))).toBe("acquisition-contract.invalid-provenance");
    expect(errorCode(() => validateAcademicAcquisitionResult(new Proxy(result(), {})))).toBe("acquisition-contract.invalid-input");
  });

  test("exposes opaque sink type without a public factory or staged constructor", async () => {
    const beforeDispatch = vi.fn(async () => ({ correlationKey: "opaque" })); const settled = vi.fn(async () => undefined);
    const sink = createAcquisitionProvenanceSinkInternal({ beforeDispatch, settled });
    expect(Object.keys(sink)).toEqual(["capabilityKind"]);
    const signal = new AbortController().signal;
    const handle = await acquisitionSinkBeforeDispatchInternal(sink, { partitionKey: `partition-v1-${HASH_A}`, partitionKeySha256: HASH_A, provider: "crossref", operation: "search", endpointClass: "works-search", normalizedInputSha256: HASH_B, requestedUrl: URL }, signal);
    await acquisitionSinkSettledInternal(sink, handle, settlement(), signal);
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(settled).toHaveBeenCalledOnce();
  });

  test("brands ordinary capabilities without canonicalizing functions or AbortSignals", async () => {
    expect(errorCode(() => createAcquisitionProvenanceSinkInternal({ get beforeDispatch() { throw new Error("must not run"); }, settled: async () => undefined } as never))).toBe("acquisition-contract.invalid-capability");
    const sink = createAcquisitionProvenanceSinkInternal({ beforeDispatch: async () => ({ correlationKey: "x" }), settled: async () => undefined });
    expect(await asyncErrorCode(() => acquisitionSinkBeforeDispatchInternal(sink, { partitionKey: `partition-v1-${HASH_A}`, partitionKeySha256: HASH_A, provider: "crossref", operation: "search", endpointClass: "x", normalizedInputSha256: HASH_B, requestedUrl: URL }, { aborted: false } as AbortSignal))).toBe("acquisition-contract.invalid-capability");
  });

  test("rejects RequestRecord attempt run and canonical source fields", () => {
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...result(), requestId: "request-1" }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcademicCandidate({ ...(candidate() as unknown as Record<string, unknown>), candidateKey: undefined, attemptId: "attempt-1" } as never))).toBe("acquisition-contract.invalid-input");
  });

  test("snapshots proxy accessor sparse cyclic and excess-key data inputs", () => {
    const sparse = result(); const queries = Array(2) as string[]; queries[0] = "x";
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...sparse, normalizedQueries: queries }))).toBe("acquisition-contract.invalid-input");
    const cyclic = result() as unknown as Record<string, unknown>; cyclic.self = cyclic;
    expect(errorCode(() => validateAcademicAcquisitionResult(cyclic))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcquisitionTrace({ ...(trace() as unknown as Record<string, unknown>), traceKey: undefined, excess: true } as never))).toBe("acquisition-contract.invalid-input");
  });

  test("returns fresh deeply frozen contracts and internal transport settlements without aliases", () => {
    const input = result(); const output = validateAcademicAcquisitionResult(input); expect(output).not.toBe(input); expect(Object.isFrozen(output)).toBe(true); expect(Object.isFrozen(output.candidates[0]?.identifiers)).toBe(true);
    expect(() => (output.normalizedQueries as string[]).push("mutate")).toThrow(); expect(validateAcademicAcquisitionResult(input)).not.toBe(output);
  });

  test("projects bounded requested final redirect URLs without query values auth body peer DNS or raw headers", () => {
    const projected = acquisitionTraceSettlementInternal(settlement(), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 });
    expect(canonicalJson(projected)).not.toMatch(/SECRET|payloadUtf8|connectedPeer|contentType|93\.184/u);
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement(), { maxCanonicalUrlBytes: 10, maxRedirects: 5 }))).toBe("acquisition-contract.result-too-large");
  });

  test("keeps retrieval timestamps out of trace keys while deterministic URL hashes and access change keys", () => {
    const a = trace(); const b = trace({ settlement: { ...a.settlement, retrievedAt: "2030-01-01T00:00:00.000Z" } });
    expect(a.traceKey).toBe(b.traceKey); expect(trace({ settlement: { ...a.settlement, requestedUrl: { ...a.settlement.requestedUrl, canonicalUrlSha256: HASH_B } } }).traceKey).not.toBe(a.traceKey);
    const { schemaVersion: _schemaVersion, traceKey: _traceKey, provenanceStatus: _status, ...input } = a;
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...a.settlement, outcome: "blocked", code: "success" } } as never))).toBe("acquisition-contract.invalid-input");
  });

  test("tracks requested dispatched succeeded failed and blocked partition counts independent of candidates", () => {
    expect(validateAcademicAcquisitionResult(result({ candidates: [], candidateGroups: [], partitions: { requested: 1, dispatched: 1, succeeded: 1, failed: 0, blocked: 0 } })).candidates).toEqual([]);
    expect(validateAcademicAcquisitionResult(result({ normalizedQueries: [], partitions: { requested: 0, dispatched: 0, succeeded: 0, failed: 0, blocked: 0 }, candidates: [], candidateGroups: [], traces: [] })).status).toBe("complete");
    const partial = result({ status: "partial", candidates: [], candidateGroups: [], partitions: { requested: 2, dispatched: 1, succeeded: 1, failed: 1, blocked: 1 }, failures: [{ provider: "openalex", operation: "search", partitionKey: `partition-v1-${HASH_B}`, partitionKeySha256: HASH_B, code: "sink.failed", retryable: false }] });
    expect(validateAcademicAcquisitionResult(partial).status).toBe("partial");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ partitions: { requested: 2, dispatched: 1, succeeded: 1, failed: 0, blocked: 0 } })))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ traces: [trace(), trace()] })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [candidate(), candidate()] })))).toBe("acquisition-contract.invalid-key");
  });

  test("reports exact redacted AcquisitionContractError codes", () => {
    expect(errorCode(() => normalizeAcquisitionOptions({ maxQueries: 0 }))).toBe("acquisition-contract.invalid-options");
    expect(errorCode(() => createProviderPartitionKey({ ...partitionPreimage(), requestedUrl: "https://user:SECRET@api.crossref.org/" }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createBlockedTraceSettlementInternal({ requestedUrl: URL, retrievedAt: "bad", limits: { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 } }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ outcome: "failure", failureCode: "transport.unknown" as never, payloadUtf8: null }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-input");
  });

  test("creates adapter fixtures through the same bounded partition registry", () => {
    const item = createProviderRequestPartitionFixtureInternal({ partition: partitionSnapshot(), options: PARTITION_LIMITS });
    assertProviderRequestPartitionInternal(item); expect(lookupProviderRequestPartitionInternal(item).partitionKeySha256).toMatch(/^[a-f0-9]{64}$/u);
    let reads = 0; const hostile = Object.defineProperty({ options: PARTITION_LIMITS }, "partition", { enumerable: true, get() { reads += 1; return partitionSnapshot(); } });
    expect(errorCode(() => createProviderRequestPartitionFixtureInternal(hostile as never))).toBe("acquisition-contract.invalid-capability"); expect(reads).toBe(0);
  });
});
