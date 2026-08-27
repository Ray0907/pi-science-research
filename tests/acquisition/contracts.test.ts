import { describe, expect, test, vi } from "vitest";

const canonicalCounter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/crypto/canonical-json.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/crypto/canonical-json.js")>();
  return { ...actual, canonicalJson(value: unknown) { canonicalCounter.calls += 1; return actual.canonicalJson(value); } };
});

import * as contractsModule from "../../src/acquisition/contracts.js";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import {
  AcquisitionContractError,
  acquisitionTraceSettlementInternal,
  assertNormalizedAcquisitionOptionsInternal,
  assertProviderRequestPartitionInternal,
  assertProviderRequestPartitionOwnedByInternal,
  closeProviderPartitionPlanOwnerInternal,
  createAcademicCandidate,
  createAcademicDocument,
  createAcquisitionTrace,
  createBlockedTraceSettlementInternal,
  createProviderPartitionKey,
  createProviderPartitionPlanOwnerInternal,
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
function providerTrace(input: Readonly<{
  provider: "crossref" | "openalex" | "pubmed" | "pmc";
  operation: "search" | "fetch";
  endpointClass: string;
  target: "crossref" | "openalex" | "ncbi";
  normalizedInput: Parameters<typeof createProviderPartitionKey>[0]["normalizedInput"];
  url: string;
  accessLevel: "metadata-only" | "abstract-only" | "partial-text" | "full-text" | null;
  payloadSha256?: string;
}>): AcquisitionTrace {
  const key = createProviderPartitionKey({ provider: input.provider, operation: input.operation, endpointClass: input.endpointClass, target: input.target, normalizedInput: input.normalizedInput, requestedUrl: input.url });
  const transport: TransportSettlement = {
    schemaVersion: 1, ...key, provider: input.provider, operation: input.operation, endpointClass: input.endpointClass,
    normalizedOrigin: new globalThis.URL(input.url).origin, requestedUrl: input.url, finalUrl: input.url, redirectWitnesses: [], httpStatus: 200,
    encodedBytes: 2, decodedBytes: 2, responsePayloadSha256: input.payloadSha256 ?? HASH_A,
    responseHeaders: { contentType: "application/json", retryAfter: null, etag: null, lastModified: null }, responseHeadersSha256: HASH_B,
    connectedPeer: { address: "93.184.216.34", family: 4 }, startedAt: AT, settledAt: LATER,
    outcome: "success", failureCode: null, payloadUtf8: "{}",
  };
  return createAcquisitionTrace({ provider: input.provider, operation: input.operation, endpointClass: input.endpointClass, ...key, accessLevel: input.accessLevel,
    settlement: acquisitionTraceSettlementInternal(transport, { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }), warnings: [] });
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
function group(value: AcademicCandidate | readonly AcademicCandidate[], overrides: Partial<AcademicCandidateGroup> = {}): AcademicCandidateGroup {
  const candidates = Array.isArray(value) ? value : [value as AcademicCandidate];
  const first = candidates[0]!;
  const identityKind = overrides.identityKind ?? "doi";
  const identityValueSha256 = overrides.identityValueSha256 ?? sha256Hex(canonicalJson(first.identifiers.doi));
  const candidateKeys = overrides.candidateKeys ?? candidates.map(({ candidateKey }) => candidateKey).sort();
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
    canonicalCounter.calls = 0;
    const value = normalizeAcquisitionOptions(undefined);
    expect(canonicalCounter.calls).toBe(1);
    expect(value.transport).toEqual({
      maxDnsAddresses: 16, maxRedirects: 5, maxHeaders: 64, maxHeaderCanonicalBytes: 65_536,
      maxOutboundHeaders: 8, maxOutboundHeaderValueCanonicalBytes: 4_096, maxCanonicalUrlBytes: 4_096,
      maxEncodedBytes: 8_388_608, maxDecodedBodyBytes: 16_777_216, maxDecompressionRatio: 100, maxEncodingLayers: 2,
      connectTimeoutMs: 10_000, requestDeadlineMs: 60_000, maxStructureDepth: 64, maxStructureNodes: 250_000,
      maxStructureKeys: 250_000, maxStringCanonicalBytes: 1_048_576, maxScalarCanonicalBytes: 16_777_216,
    });
    expect(value.providers).toEqual({
      maxProviderRecords: 100, maxProviderRecordCanonicalBytes: 262_144, maxAuthors: 256, maxPartitions: 12,
      maxAggregateDrafts: 200, maxConditionalFacts: 12, maxConditionalIdentifiers: 100,
      maxConditionalFactCanonicalBytes: 262_144, maxAggregateConditionalFactsCanonicalBytes: 16_777_216,
      maxExecutionCanonicalBytes: 16_777_216, maxStructureDepth: 64, maxStructureNodes: 250_000,
      maxStructureKeys: 250_000, maxObjectWireBytes: 8_388_608, maxStringCanonicalBytes: 1_048_576,
      maxScalarCanonicalBytes: 16_777_216, maxJoinedPmids: 100, maxPassages: 10_000, maxSections: 5_000,
      maxDocumentCanonicalBytes: 16_777_216,
    });
    expect(value).toMatchObject({ maxQueries: 4, maxCanonicalQueryBytes: 1_024, maxTotalQueryBytes: 4_096,
      maxPartitions: 12, maxConcurrency: 4, maxPerOriginConcurrency: 2, maxCleanupDiagnostics: 323,
      maxResultsPerQuery: 25, maxAggregateCandidates: 200, maxAggregateResultCanonicalBytes: 16_777_216,
      maxVisibleBytes: 24_576, maxVisibleLines: 500, sinkSettlementTimeoutMs: 10_000, shutdownGraceMs: 5_000,
      maxStructureDepth: 16, maxStructureNodes: 10_000, maxStructureKeys: 10_000,
      maxStringCanonicalBytes: 262_144, maxScalarCanonicalBytes: 1_048_576 });
    expect(value.optionsSha256).toMatch(/^[a-f0-9]{64}$/u);
    canonicalCounter.calls = 0;
    expect(normalizeAcquisitionOptions({ maxQueries: 4 }).maxQueries).toBe(4);
    expect(canonicalCounter.calls).toBe(4); // key, scalar, raw snapshot, normalized hash
    expect(normalizeAcquisitionOptions({ maxPartitions: 64, maxCleanupDiagnostics: 323 }).maxPartitions).toBe(64);
    expect(errorCode(() => normalizeAcquisitionOptions({ maxPartitions: 65, maxCleanupDiagnostics: 328 }))).toBe("acquisition-contract.invalid-options");
  });

  test("accepts every exact hard option boundary and rejects every above-hard value", () => {
    const topHard: Record<string, number> = {
      maxQueries: 16, maxCanonicalQueryBytes: 4_096, maxTotalQueryBytes: 32_768, maxPartitions: 64,
      maxConcurrency: 16, maxPerOriginConcurrency: 8, maxCleanupDiagnostics: 323, maxResultsPerQuery: 100,
      maxAggregateCandidates: 1_000, maxAggregateResultCanonicalBytes: 67_108_864, maxVisibleBytes: 49_152,
      maxVisibleLines: 2_000, sinkSettlementTimeoutMs: 30_000, shutdownGraceMs: 30_000,
      maxStructureDepth: 64, maxStructureNodes: 100_000, maxStructureKeys: 100_000,
      maxStringCanonicalBytes: 1_048_576, maxScalarCanonicalBytes: 8_388_608,
    };
    for (const [key, hard] of Object.entries(topHard)) {
      const exact: Record<string, unknown> = { [key]: hard };
      if (key === "maxPerOriginConcurrency") exact.maxConcurrency = hard;
      const normalized = normalizeAcquisitionOptions(exact) as unknown as Record<string, unknown>;
      expect(normalized[key]).toBe(hard);
      expect(errorCode(() => normalizeAcquisitionOptions({ ...exact, [key]: hard + 1 }))).toBe("acquisition-contract.invalid-options");
    }
    const transportHard: Record<string, number> = {
      maxDnsAddresses: 64, maxRedirects: 5, maxHeaders: 256, maxHeaderCanonicalBytes: 262_144,
      maxOutboundHeaders: 16, maxOutboundHeaderValueCanonicalBytes: 16_384, maxCanonicalUrlBytes: 16_384,
      maxEncodedBytes: 33_554_432, maxDecodedBodyBytes: 67_108_864, maxDecompressionRatio: 1_000,
      maxEncodingLayers: 4, connectTimeoutMs: 30_000, requestDeadlineMs: 300_000,
      maxStructureDepth: 128, maxStructureNodes: 1_000_000, maxStructureKeys: 1_000_000,
      maxStringCanonicalBytes: 4_194_304, maxScalarCanonicalBytes: 67_108_864,
    };
    for (const [key, hard] of Object.entries(transportHard)) {
      const transport: Record<string, number> = { [key]: hard };
      if (key === "connectTimeoutMs") transport.requestDeadlineMs = hard;
      expect((normalizeAcquisitionOptions({ transport }).transport as unknown as Record<string, unknown>)[key]).toBe(hard);
      expect(errorCode(() => normalizeAcquisitionOptions({ transport: { ...transport, [key]: hard + 1 } }))).toBe("acquisition-contract.invalid-options");
    }
    const providerHard: Record<string, number> = {
      maxProviderRecords: 1_000, maxProviderRecordCanonicalBytes: 1_048_576, maxAuthors: 1_024,
      maxPartitions: 64, maxAggregateDrafts: 1_000, maxConditionalFacts: 64, maxConditionalIdentifiers: 1_000,
      maxConditionalFactCanonicalBytes: 1_048_576, maxAggregateConditionalFactsCanonicalBytes: 67_108_864,
      maxExecutionCanonicalBytes: 67_108_864, maxStructureDepth: 128, maxStructureNodes: 1_000_000,
      maxStructureKeys: 1_000_000, maxObjectWireBytes: 33_554_432, maxStringCanonicalBytes: 4_194_304,
      maxScalarCanonicalBytes: 67_108_864, maxJoinedPmids: 1_000, maxPassages: 50_000,
      maxSections: 20_000, maxDocumentCanonicalBytes: 67_108_864,
    };
    const providerInput = (key: string, value: number): Record<string, unknown> => {
      const providers: Record<string, number> = { [key]: value }; const outer: Record<string, unknown> = { providers };
      if (key === "maxProviderRecords" || key === "maxConditionalIdentifiers") { providers.maxProviderRecords = value; providers.maxConditionalIdentifiers = value; }
      if (key === "maxProviderRecordCanonicalBytes" || key === "maxConditionalFactCanonicalBytes") { providers.maxProviderRecordCanonicalBytes = value; providers.maxConditionalFactCanonicalBytes = value; }
      if (key === "maxPartitions" || key === "maxConditionalFacts") { outer.maxPartitions = value; providers.maxPartitions = value; providers.maxConditionalFacts = value; }
      if (key === "maxAggregateDrafts") { outer.maxAggregateCandidates = value; providers.maxAggregateDrafts = value; }
      if (key === "maxAggregateConditionalFactsCanonicalBytes" || key === "maxExecutionCanonicalBytes") { outer.maxAggregateResultCanonicalBytes = value; providers.maxAggregateConditionalFactsCanonicalBytes = value; providers.maxExecutionCanonicalBytes = value; }
      return outer;
    };
    for (const [key, hard] of Object.entries(providerHard)) {
      const exact = providerInput(key, hard);
      expect((normalizeAcquisitionOptions(exact).providers as unknown as Record<string, unknown>)[key]).toBe(hard);
      const above = providerInput(key, hard + 1);
      expect(errorCode(() => normalizeAcquisitionOptions(above))).toBe("acquisition-contract.invalid-options");
    }
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
      { maxPartitions: 13, providers: { maxPartitions: 13, maxConditionalFacts: 12 } },
      { maxAggregateCandidates: 201, providers: { maxAggregateDrafts: 200 } },
      { maxAggregateResultCanonicalBytes: 16_777_217, providers: { maxAggregateConditionalFactsCanonicalBytes: 16_777_216, maxExecutionCanonicalBytes: 16_777_217 } },
      { maxAggregateResultCanonicalBytes: 16_777_217, providers: { maxAggregateConditionalFactsCanonicalBytes: 16_777_217, maxExecutionCanonicalBytes: 16_777_216 } },
      { providers: { maxProviderRecords: 101, maxConditionalIdentifiers: 100 } },
      { providers: { maxProviderRecordCanonicalBytes: 262_145, maxConditionalFactCanonicalBytes: 262_144 } },
      { maxQueries: 0 }, { maxQueries: Number.MAX_SAFE_INTEGER + 1 },
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
    const a = createProviderPartitionKey(partitionPreimage()); const b = createProviderPartitionKey(partitionPreimage({ endpointClass: "alternate-search" }));
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
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ normalizedOrigin: "https://example.org", requestedUrl: "https://example.org/works", finalUrl: "https://example.org/works", redirectWitnesses: [] }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ finalUrl: "https://api.crossref.org/unrelated" }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ redirectWitnesses: [{ ordinal: 2, status: 302, fromUrl: URL, fromOrigin: "https://api.crossref.org", toUrl: "https://api.crossref.org/works?page=2", toOrigin: "https://api.crossref.org" }] }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-input");
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
    const doiA = candidate({ providerRecordId: "record-a" });
    const doiB = candidate({ providerRecordId: "record-b" });
    const doiGroup = group([doiA, doiB]);
    const doiResult = result({ candidates: [doiB, doiA], candidateGroups: [doiGroup] });
    expect(validateAcademicAcquisitionResult(doiResult).candidateGroups).toEqual([doiGroup]);

    const urlA = candidate({ providerRecordId: "url-a", identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/article" });
    const urlB = candidate({ providerRecordId: "url-b", identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: "https://example.org/article" });
    const urlGroup = group([urlA, urlB], { identityKind: "canonical-url", identityValueSha256: sha256Hex(canonicalJson(urlA.canonicalUrl)) });
    expect(validateAcademicAcquisitionResult(result({ candidates: [urlA, urlB], candidateGroups: [urlGroup] })).candidateGroups[0]?.identityKind).toBe("canonical-url");

    const conflictA = candidate({ providerRecordId: "conflict-a", identifiers: { doi: "10.1234/a", pmid: null, pmcid: null }, canonicalUrl: "https://example.org/conflict" });
    const conflictB = candidate({ providerRecordId: "conflict-b", identifiers: { doi: "10.1234/b", pmid: null, pmcid: null }, canonicalUrl: "https://example.org/conflict" });
    const conflictGroup = group([conflictA, conflictB], { identityKind: "canonical-url", identityValueSha256: sha256Hex(canonicalJson(conflictA.canonicalUrl)), status: "ambiguous" });
    expect(validateAcademicAcquisitionResult(result({ candidates: [conflictA, conflictB], candidateGroups: [conflictGroup] })).candidateGroups[0]?.status).toBe("ambiguous");

    const bridgeA = candidate({ providerRecordId: "bridge-a", identifiers: { doi: "10.1234/bridge", pmid: null, pmcid: null }, canonicalUrl: null });
    const bridgeB = candidate({ providerRecordId: "bridge-b", identifiers: { doi: "10.1234/bridge", pmid: "123", pmcid: null }, canonicalUrl: null });
    const bridgeC = candidate({ providerRecordId: "bridge-c", identifiers: { doi: null, pmid: "123", pmcid: null }, canonicalUrl: null });
    const bridgeGroup = group([bridgeA, bridgeB, bridgeC], { identityKind: "doi", identityValueSha256: sha256Hex(canonicalJson("10.1234/bridge")), status: "ambiguous" });
    const forward = validateAcademicAcquisitionResult(result({ candidates: [bridgeA, bridgeB, bridgeC], candidateGroups: [bridgeGroup] }));
    const reverse = validateAcademicAcquisitionResult(result({ candidates: [bridgeC, bridgeB, bridgeA], candidateGroups: [bridgeGroup] }));
    expect(forward.candidateGroups).toEqual(reverse.candidateGroups);
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [conflictA, conflictB], candidateGroups: [{ ...conflictGroup, status: "compatible", groupKey: group([conflictA, conflictB], { identityKind: "canonical-url", identityValueSha256: sha256Hex(canonicalJson(conflictA.canonicalUrl)), status: "compatible" }).groupKey }] })))).toBe("acquisition-contract.invalid-key");
  });

  test("constructors require PMCID candidate partition and payload hashes plus every claimed field", () => {
    expect(document().pmcid).toBe("PMC123");
    expect(errorCode(() => document(candidate(), trace({ partitionKeySha256: HASH_B })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => createAcademicDocument({ ...document(), documentKey: undefined } as never))).toBeDefined();

    const pmcTrace = providerTrace({ provider: "pmc", operation: "fetch", endpointClass: "pmc-bioc", target: "ncbi", normalizedInput: { kind: "pmcid", pmcid: "PMC123" }, url: "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/PMC123/unicode", accessLevel: "full-text" });
    const pmcCandidate = candidate({ provider: "pmc", endpointClass: "pmc-bioc", providerRecordId: "PMC123", identifiers: { doi: null, pmid: null, pmcid: "PMC123" }, canonicalUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", partitionKeySha256: pmcTrace.partitionKeySha256, traceKey: pmcTrace.traceKey, accessLevel: "full-text" });
    const pmcDocument = createAcademicDocument({ pmcid: "PMC123", candidateKey: pmcCandidate.candidateKey, partitionKeySha256: pmcTrace.partitionKeySha256, responsePayloadSha256: HASH_A, provider: "pmc", traceKey: pmcTrace.traceKey, accessLevel: "full-text", sections: [{ sectionType: "results", text: "x" }] });
    const pmcGroup = group(pmcCandidate, { identityKind: "pmcid", identityValueSha256: sha256Hex(canonicalJson("PMC123")) });
    expect(validateAcademicAcquisitionResult(result({ candidates: [pmcCandidate], candidateGroups: [pmcGroup], documents: [pmcDocument], traces: [pmcTrace] })).documents).toEqual([pmcDocument]);
    const crossrefCandidate = candidate();
    const wrongPmcCandidate = candidate({ provider: "pmc", endpointClass: "pmc-bioc", providerRecordId: "PMC124", identifiers: { doi: null, pmid: null, pmcid: "PMC124" }, canonicalUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC124/", partitionKeySha256: pmcTrace.partitionKeySha256, traceKey: pmcTrace.traceKey, accessLevel: "full-text" });
    const crossrefDocument = createAcademicDocument({ ...({ pmcid: "PMC123", candidateKey: crossrefCandidate.candidateKey, partitionKeySha256: pmcTrace.partitionKeySha256, responsePayloadSha256: HASH_A, provider: "pmc", traceKey: pmcTrace.traceKey, accessLevel: "full-text", sections: [] } as const) });
    const wrongPmcDocument = createAcademicDocument({ pmcid: "PMC123", candidateKey: wrongPmcCandidate.candidateKey, partitionKeySha256: pmcTrace.partitionKeySha256, responsePayloadSha256: HASH_A, provider: "pmc", traceKey: pmcTrace.traceKey, accessLevel: "full-text", sections: [] });
    const wrongTraceDocument = createAcademicDocument({ pmcid: "PMC123", candidateKey: pmcCandidate.candidateKey, partitionKeySha256: trace().partitionKeySha256, responsePayloadSha256: HASH_A, provider: "pmc", traceKey: trace().traceKey, accessLevel: "full-text", sections: [] });
    const wrongHashDocument = createAcademicDocument({ pmcid: "PMC123", candidateKey: pmcCandidate.candidateKey, partitionKeySha256: pmcTrace.partitionKeySha256, responsePayloadSha256: HASH_B, provider: "pmc", traceKey: pmcTrace.traceKey, accessLevel: "full-text", sections: [] });
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [crossrefCandidate], candidateGroups: [group(crossrefCandidate)], documents: [crossrefDocument], traces: [pmcTrace, trace()] })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [wrongPmcCandidate], candidateGroups: [group(wrongPmcCandidate, { identityKind: "pmcid", identityValueSha256: sha256Hex(canonicalJson("PMC124")) })], documents: [wrongPmcDocument], traces: [pmcTrace] })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [pmcCandidate], candidateGroups: [pmcGroup], documents: [wrongTraceDocument], traces: [pmcTrace, trace()] })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [pmcCandidate], candidateGroups: [pmcGroup], documents: [wrongHashDocument], traces: [pmcTrace] })))).toBe("acquisition-contract.invalid-key");
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

  test("exposes opaque sink type without a public factory or staged constructor", () => {
    expect("createAcquisitionProvenanceSinkInternal" in contractsModule).toBe(false);
    expect("acquisitionSinkBeforeDispatchInternal" in contractsModule).toBe(false);
    expect("acquisitionSinkSettledInternal" in contractsModule).toBe(false);
    expect(canonicalJson(normalizeAcquisitionOptions(undefined))).not.toMatch(/staged|beforeDispatch|settled/u);
  });

  test("brands ordinary capabilities without canonicalizing functions or AbortSignals", () => {
    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_A}`, options: PARTITION_LIMITS });
    expect(Object.keys(owner)).toEqual(["capabilityKind"]);
    expect(new AbortController().signal.aborted).toBe(false);
    expect(errorCode(() => assertProviderRequestPartitionInternal({ capabilityKind: "provider-request-partition", execute: () => undefined }))).toBe("acquisition-contract.invalid-capability");
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

    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_A}`, options: { ...PARTITION_LIMITS, maxPartitions: 2, maxStringCanonicalBytes: 262_144 } });
    const exactEscaped = `${"\"".repeat(131_068)}search`;
    const exactPartition = registerProviderRequestPartitionInternal(owner, partitionSnapshot({ endpointClass: exactEscaped }));
    expect(lookupProviderRequestPartitionInternal(exactPartition).endpointClass).toBe(exactEscaped);
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, partitionSnapshot({ endpointClass: `${"\"".repeat(131_069)}search` })))).toBe("acquisition-contract.input-too-large");

    for (const escaped of ["\\", "\n"]) {
      expect(candidate({ title: escaped.repeat(524_287) }).title).toHaveLength(524_287);
      expect(errorCode(() => candidate({ title: escaped.repeat(524_288) }))).toBe("acquisition-contract.result-too-large");
    }
    const exactKey = "\"".repeat(524_287);
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...result(), [exactKey]: true }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...result(), [`${exactKey}\"`]: true }))).toBe("acquisition-contract.result-too-large");
  });

  test("returns fresh deeply frozen contracts and internal transport settlements without aliases", () => {
    const input = result(); const output = validateAcademicAcquisitionResult(input); expect(output).not.toBe(input); expect(Object.isFrozen(output)).toBe(true); expect(Object.isFrozen(output.candidates[0]?.identifiers)).toBe(true);
    expect(() => (output.normalizedQueries as string[]).push("mutate")).toThrow(); expect(validateAcademicAcquisitionResult(input)).not.toBe(output);
  });

  test("projects bounded requested final redirect URLs without query values auth body peer DNS or raw headers", () => {
    const projected = acquisitionTraceSettlementInternal(settlement(), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 });
    expect(canonicalJson(projected)).not.toMatch(/SECRET|payloadUtf8|connectedPeer|contentType|93\.184/u);
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement(), { maxCanonicalUrlBytes: 10, maxRedirects: 5 }))).toBe("acquisition-contract.result-too-large");
    const original = trace(); const { schemaVersion: _schemaVersion, traceKey: _traceKey, provenanceStatus: _status, ...input } = original;
    const forgedUrl = { canonicalUrl: "https://example.org/works?secret=value", canonicalUrlSha256: HASH_A };
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, requestedUrl: forgedUrl } } as never))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, requestedUrl: { ...input.settlement.requestedUrl, canonicalUrl: "https://api.crossref.org/works?secret=value" } } } as never))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, redirects: [{ ...input.settlement.redirects[0]!, ordinal: 2 }] } } as never))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcquisitionTrace({ ...input, provider: "openalex" } as never))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcquisitionTrace({ ...input, operation: "fetch" } as never))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createAcquisitionTrace({ ...input, endpointClass: "unrelated" } as never))).toBe("acquisition-contract.invalid-input");
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
    const mismatchedFailure = { provider: "openalex" as const, operation: "search" as const, partitionKey: trace().partitionKey, partitionKeySha256: trace().partitionKeySha256, code: "provider.terminal" as const, retryable: false };
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ status: "partial", partitions: { requested: 1, dispatched: 1, succeeded: 0, failed: 1, blocked: 0 }, candidates: [], candidateGroups: [], failures: [mismatchedFailure] })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [candidate(), candidate()] })))).toBe("acquisition-contract.invalid-key");
  });

  test("reports exact redacted AcquisitionContractError codes", () => {
    expect(errorCode(() => normalizeAcquisitionOptions({ maxQueries: 0 }))).toBe("acquisition-contract.invalid-options");
    expect(errorCode(() => createProviderPartitionKey({ ...partitionPreimage(), requestedUrl: "https://user:SECRET@api.crossref.org/" }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => createBlockedTraceSettlementInternal({ requestedUrl: URL, retrievedAt: "bad", limits: { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 } }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ outcome: "failure", failureCode: "transport.unknown" as never, payloadUtf8: null }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-input");
    expect(acquisitionTraceSettlementInternal(settlement({ outcome: "failure", failureCode: "transport.json-root-invalid", payloadUtf8: null }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }).code).toBe("invalid-response");
  });

  test("registers adapter-shaped partitions only through a real owner", () => {
    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_A}`, options: PARTITION_LIMITS });
    const item = registerProviderRequestPartitionInternal(owner, partitionSnapshot());
    assertProviderRequestPartitionInternal(item);
    expect(lookupProviderRequestPartitionInternal(item).partitionKeySha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
