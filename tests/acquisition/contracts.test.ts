import { describe, expect, test, vi } from "vitest";

const canonicalCounter = vi.hoisted(() => ({ calls: 0, stringLengths: [] as number[] }));
vi.mock("../../src/crypto/canonical-json.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/crypto/canonical-json.js")>();
  return { ...actual, canonicalJson(value: unknown) { canonicalCounter.calls += 1; if (typeof value === "string") canonicalCounter.stringLengths.push(value.length); return actual.canonicalJson(value); } };
});

import * as contractsModule from "../../src/acquisition/contracts.js";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import {
  AcquisitionContractError,
  acquisitionTraceSettlementInternal as acquisitionTraceSettlementInternalExported,
  assertNormalizedAcademicTransportOptionsInternal,
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
  type AcquisitionProvenanceHandle,
  type AcademicCandidate,
  type AcademicCandidateGroup,
  type AcquisitionTrace,
  type ProviderPartitionRegistryOptionsInternal,
  type ProviderRequestPartitionInternal,
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
function registeredPartition(overrides: Record<string, unknown> = {}): ProviderRequestPartitionInternal {
  const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${sha256Hex(canonicalJson(overrides))}`, options: PARTITION_LIMITS });
  return registerProviderRequestPartitionInternal(owner, partitionSnapshot(overrides));
}
const PROJECTION_LIMITS = { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 } as const;
function acquisitionTraceSettlementInternal(
  value: TransportSettlement,
  limits: { maxCanonicalUrlBytes: number; maxRedirects: number },
  partitionOverrides: Record<string, unknown> = {},
): AcquisitionTrace["settlement"] {
  registeredPartition(partitionOverrides);
  return acquisitionTraceSettlementInternalExported(value, limits);
}
function settlement(overrides: Partial<TransportSettlement> = {}): TransportSettlement {
  const key = createProviderPartitionKey(partitionPreimage());
  return {
    schemaVersion: 1, ...key, provider: "crossref", operation: "search", endpointClass: "works-search",
    normalizedOrigin: "https://api.crossref.org", requestedUrl: URL, finalUrl: "https://api.crossref.org/works?page=2",
    redirectWitnesses: [{ ordinal: 1, status: 302, fromUrl: URL, fromOrigin: "https://api.crossref.org", toUrl: "https://api.crossref.org/works?page=2", toOrigin: "https://api.crossref.org" }],
    httpStatus: 200, encodedBytes: 2, decodedBytes: 2, responsePayloadSha256: HASH_A,
    responseHeaders: { contentType: "application/json", retryAfter: null, etag: null, lastModified: null },
    responseHeadersSha256: HASH_B, connectedPeer: { address: "93.184.216.34", family: 4 },
    startedAt: AT, settledAt: LATER, outcome: "success", failureCode: null, payloadUtf8: "{}", ...overrides,
  } as TransportSettlement;
}
function trace(overrides: Record<string, unknown> = {}): AcquisitionTrace {
  const projected = acquisitionTraceSettlementInternal(settlement(), PROJECTION_LIMITS);
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
    settlement: acquisitionTraceSettlementInternal(transport, PROJECTION_LIMITS, { provider: input.provider, operation: input.operation, endpointClass: input.endpointClass, target: input.target, normalizedInput: input.normalizedInput, requestedUrl: input.url }), warnings: [] });
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
    assertNormalizedAcquisitionOptionsInternal(value);assertNormalizedAcademicTransportOptionsInternal(value.transport);
    expect(errorCode(() => assertNormalizedAcquisitionOptionsInternal({ ...value }))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => assertNormalizedAcquisitionOptionsInternal({ ...value, transport: { ...value.transport } }))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => assertNormalizedAcademicTransportOptionsInternal({ ...value.transport }))).toBe("acquisition-contract.invalid-capability");
    const lookalike=Object.freeze({ ...value.transport });expect(errorCode(() => assertNormalizedAcademicTransportOptionsInternal(lookalike))).toBe("acquisition-contract.invalid-capability");const forgedNormalized=Object.freeze({...value,transport:lookalike});expect(errorCode(()=>assertNormalizedAcademicTransportOptionsInternal(forgedNormalized.transport))).toBe("acquisition-contract.invalid-capability");
    let traps=0;const proxy=new Proxy(value.transport,{get(){traps+=1;throw new Error("SECRET");}});expect(errorCode(() => assertNormalizedAcademicTransportOptionsInternal(proxy))).toBe("acquisition-contract.invalid-capability");expect(traps).toBe(0);
  });

  test("keeps normalized transport planner fields and options hash stable after raw option mutation with O1 repeated assertions", () => {
    const raw = { maxQueries: 3, transport: { maxDnsAddresses: 4 } }; const value = normalizeAcquisitionOptions(raw);
    raw.maxQueries = 2; raw.transport.maxDnsAddresses = 5;
    expect(value.maxQueries).toBe(3); expect(value.transport.maxDnsAddresses).toBe(4);
    const hash = value.optionsSha256; for (let index = 0; index < 10_000; index += 1) {assertNormalizedAcquisitionOptionsInternal(value);assertNormalizedAcademicTransportOptionsInternal(value.transport);} expect(value.optionsSha256).toBe(hash);
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

  test("ref-counts minimal bindings and preserves authentic outputs after owner close", () => {
    const preimage = partitionPreimage({ normalizedInput: { kind: "query", query: "indexed", limit: 1 }, requestedUrl: "https://api.crossref.org/works?query=indexed" });
    const snapshot = partitionSnapshot(preimage);
    const ownerA = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_A}`, options: PARTITION_LIMITS });
    const ownerB = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${HASH_B}`, options: PARTITION_LIMITS });
    const partitionA = registerProviderRequestPartitionInternal(ownerA, snapshot);
    registerProviderRequestPartitionInternal(ownerB, snapshot);
    const key = createProviderPartitionKey(preimage);
    const indexedSettlement = settlement({ ...key, requestedUrl: preimage.requestedUrl, finalUrl: preimage.requestedUrl, redirectWitnesses: [] });
    const indexedProjected = acquisitionTraceSettlementInternalExported(indexedSettlement, PROJECTION_LIMITS);
    const indexedTraceInput = { provider: "crossref" as const, operation: "search" as const, endpointClass: "works-search", ...key, accessLevel: "metadata-only" as const, settlement: indexedProjected, warnings: [] };
    const indexedTrace = createAcquisitionTrace(indexedTraceInput);
    const validated = validateAcademicAcquisitionResult(result({ candidates: [], candidateGroups: [], traces: [indexedTrace] }));
    closeProviderPartitionPlanOwnerInternal(ownerA);
    expect(errorCode(() => lookupProviderRequestPartitionInternal(partitionA))).toBe("acquisition-contract.invalid-capability");
    expect(acquisitionTraceSettlementInternalExported(indexedSettlement, PROJECTION_LIMITS).outcome).toBe("success");
    closeProviderPartitionPlanOwnerInternal(ownerB);
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(indexedSettlement, PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-capability");
    expect(createAcquisitionTrace(indexedTraceInput).traceKey).toBe(indexedTrace.traceKey);
    expect(validateAcademicAcquisitionResult(validated).traces[0]?.traceKey).toBe(indexedTrace.traceKey);

    const ownerC = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${"c".repeat(64)}`, options: PARTITION_LIMITS });
    registerProviderRequestPartitionInternal(ownerC, snapshot);
    expect(acquisitionTraceSettlementInternalExported(indexedSettlement, PROJECTION_LIMITS).outcome).toBe("success");
    closeProviderPartitionPlanOwnerInternal(ownerC);

    const blockedPreimage = partitionPreimage({ normalizedInput: { kind: "query", query: "blocked-index", limit: 1 }, requestedUrl: "https://api.crossref.org/works?query=blocked-index" });
    const blockedOwner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${"d".repeat(64)}`, options: PARTITION_LIMITS });
    registerProviderRequestPartitionInternal(blockedOwner, partitionSnapshot(blockedPreimage));
    const blockedKey = createProviderPartitionKey(blockedPreimage);
    const blockedSettlement = createBlockedTraceSettlementInternal({ requestedUrl: blockedPreimage.requestedUrl, retrievedAt: AT, limits: PROJECTION_LIMITS });
    const blockedTraceInput = { provider: "crossref" as const, operation: "search" as const, endpointClass: "works-search", ...blockedKey, accessLevel: null, settlement: blockedSettlement, warnings: [] };
    const blockedTrace = createAcquisitionTrace(blockedTraceInput);
    closeProviderPartitionPlanOwnerInternal(blockedOwner);
    expect(createAcquisitionTrace(blockedTraceInput).traceKey).toBe(blockedTrace.traceKey);
  });

  test("authenticates many identical owner leases without scanning registrations", () => {
    const preimage = partitionPreimage({ normalizedInput: { kind: "query", query: "constant-lookup", limit: 1 }, requestedUrl: "https://api.crossref.org/works?query=constant-lookup" });
    const snapshot = partitionSnapshot(preimage);
    const owners = Array.from({ length: 48 }, (_, index) => createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${index.toString(16).padStart(64, "0")}`, options: PARTITION_LIMITS }));
    for (const owner of owners) registerProviderRequestPartitionInternal(owner, snapshot);
    const key = createProviderPartitionKey(preimage);
    const raw = settlement({ ...key, requestedUrl: preimage.requestedUrl, finalUrl: preimage.requestedUrl, redirectWitnesses: [] });
    const deref = vi.spyOn(WeakRef.prototype, "deref");
    deref.mockClear();
    const projected = acquisitionTraceSettlementInternalExported(raw, PROJECTION_LIMITS);
    expect(deref).not.toHaveBeenCalled();
    deref.mockRestore();
    const projectedTrace = createAcquisitionTrace({ provider: "crossref", operation: "search", endpointClass: "works-search", ...key, accessLevel: "metadata-only", settlement: projected, warnings: [] });
    const validated = validateAcademicAcquisitionResult(result({ candidates: [], candidateGroups: [], traces: [projectedTrace] }));
    for (const owner of owners.slice(0, -1)) closeProviderPartitionPlanOwnerInternal(owner);
    expect(acquisitionTraceSettlementInternalExported(raw, PROJECTION_LIMITS).outcome).toBe("success");
    closeProviderPartitionPlanOwnerInternal(owners.at(-1)!);
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(raw, PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-capability");
    expect(createAcquisitionTrace({ provider: "crossref", operation: "search", endpointClass: "works-search", ...key, accessLevel: "metadata-only", settlement: projected, warnings: [] }).traceKey).toBe(projectedTrace.traceKey);
    expect(validateAcademicAcquisitionResult(validated).traces[0]?.traceKey).toBe(projectedTrace.traceKey);
  });

  test("keeps timestamp out of trace key while every deterministic settlement fact changes it", () => {
    const key = createProviderPartitionKey(partitionPreimage()); registeredPartition();
    const makeTrace = (transportOverrides: Partial<TransportSettlement>, accessLevel: "metadata-only" | "abstract-only" = "metadata-only") => createAcquisitionTrace({ provider: "crossref", operation: "search", endpointClass: "works-search", ...key, accessLevel, settlement: acquisitionTraceSettlementInternalExported(settlement(transportOverrides), PROJECTION_LIMITS), warnings: [] });
    const a = makeTrace({}); const b = makeTrace({ settledAt: AT }); expect(a.traceKey).toBe(b.traceKey);
    expect(makeTrace({}, "abstract-only").traceKey).not.toBe(a.traceKey);
    expect(makeTrace({ payloadUtf8: "123", decodedBytes: 3 }).traceKey).not.toBe(a.traceKey);
  });

  test("keeps the exact two-argument projector API and validates payload bytes separately", () => {
    registeredPartition();
    expect(acquisitionTraceSettlementInternalExported.length).toBe(2);
    expect(acquisitionTraceSettlementInternalExported(settlement({ payloadUtf8: "12345678", decodedBytes: 8 }), PROJECTION_LIMITS).decodedBytes).toBe(8);
    expect(acquisitionTraceSettlementInternalExported(settlement({ payloadUtf8: "éé", decodedBytes: 4 }), PROJECTION_LIMITS).decodedBytes).toBe(4);
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ payloadUtf8: "éé", decodedBytes: 2 }), PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ payloadUtf8: null } as never), PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ payloadUtf8: "x", decodedBytes: 67_108_865 }), PROJECTION_LIMITS))).toBe("acquisition-contract.result-too-large");
    let payloadGetterTouched = false;
    const accessor = Object.defineProperty({ ...settlement() }, "payloadUtf8", { enumerable: true, get() { payloadGetterTouched = true; return "{}"; } });
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(accessor as TransportSettlement, PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-input");
    expect(payloadGetterTouched).toBe(false);
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement(), { ...PROJECTION_LIMITS, maxDecodedBodyBytes: 8 } as never))).toBe("acquisition-contract.invalid-input");
  });

  test("authenticates limits and binding fields before hostile nested settlement data", () => {
    let touched = false;
    const hostileNested = new Proxy({}, { ownKeys() { touched = true; throw new Error("untouched"); } });
    const hostileSettlement = settlement({ responseHeaders: hostileNested as never });
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(hostileSettlement, { ...PROJECTION_LIMITS, excess: true } as never))).toBe("acquisition-contract.invalid-input");
    expect(touched).toBe(false);
    expect(errorCode(() => acquisitionTraceSettlementInternalExported({ ...hostileSettlement, partitionKey: `partition-v1-${HASH_B}`, partitionKeySha256: HASH_B } as TransportSettlement, PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-capability");
    expect(touched).toBe(false);

    const original = trace(); const { schemaVersion: _schema, traceKey: _key, provenanceStatus: _provenance, ...traceInput } = original;
    const forgedSettlement = { ...traceInput.settlement };
    const hostileWarnings = new Proxy([], { ownKeys() { touched = true; throw new Error("untouched"); } });
    expect(errorCode(() => createAcquisitionTrace({ ...traceInput, settlement: forgedSettlement, warnings: hostileWarnings } as never))).toBe("acquisition-contract.invalid-capability");
    expect(touched).toBe(false);
  });

  test("authenticates settlement claims with a live partition and permits only fixed redirect origins", () => {
    const pubmedInput = { provider: "pubmed", operation: "search", endpointClass: "opaque-v1", target: "ncbi", normalizedInput: { kind: "query", query: "cancer", limit: 10 }, requestedUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?term=x" } as const;
    registeredPartition(pubmedInput);
    const pubmedKey = createProviderPartitionKey(pubmedInput);
    const base = settlement({ ...pubmedKey, provider: "pubmed", endpointClass: "opaque-v1", normalizedOrigin: "https://eutils.ncbi.nlm.nih.gov", requestedUrl: pubmedInput.requestedUrl,
      finalUrl: "https://www.ncbi.nlm.nih.gov/result", redirectWitnesses: [{ ordinal: 1, status: 302, fromUrl: pubmedInput.requestedUrl, fromOrigin: "https://eutils.ncbi.nlm.nih.gov", toUrl: "https://www.ncbi.nlm.nih.gov/result", toOrigin: "https://www.ncbi.nlm.nih.gov" }] });
    const projectedForward = acquisitionTraceSettlementInternalExported(base, PROJECTION_LIMITS);
    expect(projectedForward.redirects).toHaveLength(1);
    const publicPubmedInput = { provider: "pubmed" as const, operation: "search" as const, endpointClass: "opaque-v1", ...pubmedKey, accessLevel: "metadata-only" as const, settlement: projectedForward, warnings: [] };
    expect(createAcquisitionTrace(publicPubmedInput).settlement.finalUrl?.canonicalUrl).toBe("https://www.ncbi.nlm.nih.gov/result");
    expect(errorCode(() => createAcquisitionTrace({ ...publicPubmedInput, settlement: { ...projectedForward, finalUrl: { ...projectedForward.finalUrl!, canonicalUrl: "https://foo.ncbi.nlm.nih.gov/result" } } }))).toBe("acquisition-contract.invalid-capability");

    const reverseInput = { ...pubmedInput, requestedUrl: "https://www.ncbi.nlm.nih.gov/start" };
    registeredPartition(reverseInput);
    const reverseKey = createProviderPartitionKey(reverseInput);
    const reverse = settlement({ ...reverseKey, provider: "pubmed", endpointClass: "opaque-v1", normalizedOrigin: "https://www.ncbi.nlm.nih.gov", requestedUrl: reverseInput.requestedUrl,
      finalUrl: "https://eutils.ncbi.nlm.nih.gov/end", redirectWitnesses: [{ ordinal: 1, status: 307, fromUrl: reverseInput.requestedUrl, fromOrigin: "https://www.ncbi.nlm.nih.gov", toUrl: "https://eutils.ncbi.nlm.nih.gov/end", toOrigin: "https://eutils.ncbi.nlm.nih.gov" }] });
    expect(acquisitionTraceSettlementInternalExported(reverse, PROJECTION_LIMITS).redirects).toHaveLength(1);
    const sibling = { ...base, finalUrl: "https://foo.ncbi.nlm.nih.gov/result", redirectWitnesses: [{ ...base.redirectWitnesses[0]!, toUrl: "https://foo.ncbi.nlm.nih.gov/result", toOrigin: "https://foo.ncbi.nlm.nih.gov" }] } as TransportSettlement;
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(sibling, PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ partitionKey: `partition-v1-${HASH_B}`, partitionKeySha256: HASH_B }), PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement(), PROJECTION_LIMITS))).toBeUndefined();
    for (const mismatch of [
      { provider: "openalex" }, { operation: "fetch" }, { endpointClass: "other" },
      { partitionKey: `partition-v1-${HASH_B}` }, { partitionKeySha256: HASH_B },
      { requestedUrl: "https://eutils.ncbi.nlm.nih.gov/other", finalUrl: "https://eutils.ncbi.nlm.nih.gov/other", redirectWitnesses: [] },
    ]) expect(errorCode(() => acquisitionTraceSettlementInternalExported({ ...base, ...mismatch } as TransportSettlement, PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-key");
    const staleInput = partitionPreimage({ normalizedInput: { kind: "query", query: "stale", limit: 1 }, requestedUrl: "https://api.crossref.org/works?query=stale" });
    const closed = registeredPartition(staleInput); closeProviderPartitionPlanOwnerInternal(lookupProviderRequestPartitionOwnerInternal(closed));
    const staleKey = createProviderPartitionKey(staleInput);
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ ...staleKey, requestedUrl: staleInput.requestedUrl, finalUrl: staleInput.requestedUrl, redirectWitnesses: [] }), PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-capability");
  });

  test("preflights redirect counts before copying hostile arrays", () => {
    registeredPartition(); let touched = false;
    const hostile = Array(6).fill(undefined) as unknown[];
    for (let index = 0; index < 5; index += 1) hostile[index] = settlement().redirectWitnesses[0];
    Object.defineProperty(hostile, "5", { enumerable: true, get() { touched = true; throw new Error("untouched"); } });
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ redirectWitnesses: hostile as never }), PROJECTION_LIMITS))).toBe("acquisition-contract.result-too-large");
    expect(touched).toBe(false);
    const sparse = Array(6); sparse[0] = settlement().redirectWitnesses[0];
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ redirectWitnesses: sparse as never }), PROJECTION_LIMITS))).toBe("acquisition-contract.result-too-large");
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ redirectWitnesses: new Proxy([], {}) }), PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-input");
    const publicTrace = trace(); const { schemaVersion: _s, traceKey: _k, provenanceStatus: _p, ...input } = publicTrace;
    const publicHostile = Array(6).fill(undefined); Object.defineProperty(publicHostile, "5", { enumerable: true, get() { touched = true; throw new Error("untouched"); } });
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, redirects: publicHostile } } as never))).toBe("acquisition-contract.invalid-capability");
    expect(touched).toBe(false);
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ traces: [{ ...publicTrace, settlement: { ...publicTrace.settlement, redirects: publicHostile } } as AcquisitionTrace] })))).toBe("acquisition-contract.result-too-large");
    expect(touched).toBe(false);
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
    expect(errorCode(() => acquisitionTraceSettlementInternal(settlement({ normalizedOrigin: "https://example.org", requestedUrl: "https://example.org/works", finalUrl: "https://example.org/works", redirectWitnesses: [] }), { maxCanonicalUrlBytes: 4_096, maxRedirects: 5 }))).toBe("acquisition-contract.invalid-key");
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

  test("preflights result collection hard counts and keeps grouping bounded without diagnostic exports", () => {
    let touched = false; const hostile = Array(1_001).fill(candidate());
    Object.defineProperty(hostile, "1000", { enumerable: true, get() { touched = true; throw new Error("untouched"); } });
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: hostile as never })))).toBe("acquisition-contract.result-too-large");
    expect(touched).toBe(false);
    expect("validateAcademicAcquisitionResultWithDiagnosticsInternal" in contractsModule).toBe(false);
    expect("AcquisitionGroupingDiagnosticsInternal" in contractsModule).toBe(false);

    const prepare = (count: number) => {
      const candidates = Array.from({ length: count }, (_, index) => candidate({ providerRecordId: `scale-${index}`, identifiers: { doi: `10.1234/scale-${index}`, pmid: null, pmcid: null }, canonicalUrl: `https://example.org/scale/${index}` }));
      return result({ candidates, candidateGroups: candidates.map((item) => group(item)).sort((left, right) => left.groupKey < right.groupKey ? -1 : left.groupKey > right.groupKey ? 1 : 0) });
    };
    const small = prepare(128); const large = prepare(256);
    const startedSmall = performance.now(); validateAcademicAcquisitionResult(small); const smallMs = performance.now() - startedSmall;
    const startedLarge = performance.now(); validateAcademicAcquisitionResult(large); const largeMs = performance.now() - startedLarge;
    expect(largeMs).toBeLessThan(smallMs * 8 + 500);
  });

  test("validates exact Gregorian candidate publication dates on creation and reconstruction",()=>{for(const published of [{date:null,precision:"unknown"},{date:"0001",precision:"year"},{date:"9999-12",precision:"month"},{date:"2000-02-29",precision:"day"}] as const)expect(()=>candidate({published})).not.toThrow();const invalid=[{date:"2024",precision:"unknown"},{date:null,precision:"day"},{date:"0000",precision:"year"},{date:"10000",precision:"year"},{date:"2024-00",precision:"month"},{date:"2024-13",precision:"month"},{date:"1900-02-29",precision:"day"},{date:"2024-02-30",precision:"day"},{date:"2024-04-31",precision:"day"}] as const;for(const published of invalid)expect(errorCode(()=>candidate({published})),JSON.stringify(published)).toBe("acquisition-contract.invalid-input");const authentic=result(),forged={...authentic.candidates[0]!,published:{date:"1900-02-29",precision:"day"}};expect(errorCode(()=>validateAcademicAcquisitionResult({...authentic,candidates:[forged]} as never))).toBe("acquisition-contract.invalid-input");});

  test("enforces aggregate canonical scalar bytes without counting container punctuation", () => {
    const { schemaVersion: _schemaVersion, candidateKey: _candidateKey, provenanceStatus: _provenanceStatus, ...input } = candidate();
    const authors = (size: number) => Array.from({ length: 1_024 }, () => ({ family: null, given: null, literal: "x".repeat(size), orcid: null }));
    expect(createAcademicCandidate({ ...input, authors: authors(6_000) }).authors).toHaveLength(1_024);
    expect(errorCode(() => createAcademicCandidate({ ...input, authors: authors(9_000) }))).toBe("acquisition-contract.result-too-large");
  });

  test("requires successful sufficiently accessible traces for every candidate and document access level", () => {
    const accessLevels = ["metadata-only", "abstract-only", "partial-text", "full-text"] as const;
    for (const [traceRank, traceAccess] of accessLevels.entries()) {
      const candidateTrace = trace({ accessLevel: traceAccess });
      for (const [candidateRank, candidateAccess] of accessLevels.entries()) {
        const value = candidate({ partitionKeySha256: candidateTrace.partitionKeySha256, traceKey: candidateTrace.traceKey, accessLevel: candidateAccess });
        const input = result({ candidates: [value], candidateGroups: [group(value)], traces: [candidateTrace] });
        if (traceRank >= candidateRank) expect(validateAcademicAcquisitionResult(input).candidates[0]?.accessLevel).toBe(candidateAccess);
        else expect(errorCode(() => validateAcademicAcquisitionResult(input))).toBe("acquisition-contract.invalid-key");
      }
    }

    const nullAccessTrace = trace({ accessLevel: null });
    const nullCandidate = candidate({ partitionKeySha256: nullAccessTrace.partitionKeySha256, traceKey: nullAccessTrace.traceKey });
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [nullCandidate], candidateGroups: [group(nullCandidate)], traces: [nullAccessTrace] })))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [candidate()], candidateGroups: [group(candidate())], traces: [] })))).toBe("acquisition-contract.invalid-key");

    registeredPartition();
    const failureSettlement = acquisitionTraceSettlementInternalExported(settlement({ outcome: "failure", failureCode: "transport.http-terminal", payloadUtf8: null }), PROJECTION_LIMITS);
    const failureKey = createProviderPartitionKey(partitionPreimage());
    const failureTrace = createAcquisitionTrace({ provider: "crossref", operation: "search", endpointClass: "works-search", ...failureKey, accessLevel: null, settlement: failureSettlement, warnings: [] });
    const failureCandidate = candidate({ partitionKeySha256: failureTrace.partitionKeySha256, traceKey: failureTrace.traceKey });
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [failureCandidate], candidateGroups: [group(failureCandidate)], traces: [failureTrace] })))).toBe("acquisition-contract.invalid-key");

    const pmcPartition = { provider: "pmc" as const, operation: "fetch" as const, endpointClass: "pmc-bioc", target: "ncbi" as const, normalizedInput: { kind: "pmcid" as const, pmcid: "PMC123" }, url: "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/PMC123/unicode" };
    for (const [traceRank, traceAccess] of accessLevels.entries()) {
      const pmcTrace = providerTrace({ ...pmcPartition, accessLevel: traceAccess });
      for (const [documentRank, documentAccess] of accessLevels.entries()) {
        const pmcCandidate = candidate({ provider: "pmc", endpointClass: "pmc-bioc", providerRecordId: "PMC123", identifiers: { doi: null, pmid: null, pmcid: "PMC123" }, canonicalUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", partitionKeySha256: pmcTrace.partitionKeySha256, traceKey: pmcTrace.traceKey, accessLevel: documentAccess });
        const pmcDocument = createAcademicDocument({ pmcid: "PMC123", candidateKey: pmcCandidate.candidateKey, partitionKeySha256: pmcTrace.partitionKeySha256, responsePayloadSha256: HASH_A, provider: "pmc", traceKey: pmcTrace.traceKey, accessLevel: documentAccess, sections: [] });
        const input = result({ candidates: [pmcCandidate], candidateGroups: [group(pmcCandidate, { identityKind: "pmcid", identityValueSha256: sha256Hex(canonicalJson("PMC123")) })], documents: [pmcDocument], traces: [pmcTrace] });
        if (traceRank >= documentRank) expect(validateAcademicAcquisitionResult(input).documents[0]?.accessLevel).toBe(documentAccess);
        else expect(errorCode(() => validateAcademicAcquisitionResult(input))).toBe("acquisition-contract.invalid-key");
      }
    }
    const nullPmcTrace = providerTrace({ ...pmcPartition, accessLevel: null });
    const nullPmcCandidate = candidate({ provider: "pmc", endpointClass: "pmc-bioc", providerRecordId: "PMC123", identifiers: { doi: null, pmid: null, pmcid: "PMC123" }, canonicalUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", partitionKeySha256: nullPmcTrace.partitionKeySha256, traceKey: nullPmcTrace.traceKey, accessLevel: "metadata-only" });
    const nullPmcDocument = createAcademicDocument({ pmcid: "PMC123", candidateKey: nullPmcCandidate.candidateKey, partitionKeySha256: nullPmcTrace.partitionKeySha256, responsePayloadSha256: HASH_A, provider: "pmc", traceKey: nullPmcTrace.traceKey, accessLevel: "metadata-only", sections: [] });
    expect(errorCode(() => validateAcademicAcquisitionResult(result({ candidates: [nullPmcCandidate], candidateGroups: [group(nullPmcCandidate, { identityKind: "pmcid", identityValueSha256: sha256Hex(canonicalJson("PMC123")) })], documents: [nullPmcDocument], traces: [nullPmcTrace] })))).toBe("acquisition-contract.invalid-key");
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

  test("exports the exact provenance handle while deferring sink executables", () => {
    const handle: AcquisitionProvenanceHandle = { correlationKey: "correlation-1" };
    expect(handle).toEqual({ correlationKey: "correlation-1" });
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
    const oversizedUnknown = `${exactKey}\"`;
    expect(errorCode(() => validateAcademicAcquisitionResult({ ...result(), [oversizedUnknown]: true }))).toBe("acquisition-contract.invalid-input");
    expect(errorCode(() => normalizeAcquisitionOptions({ [oversizedUnknown]: 1 }))).toBe("acquisition-contract.invalid-options");
    expect(errorCode(() => normalizeAcquisitionOptions({ transport: { [oversizedUnknown]: 1 } }))).toBe("acquisition-contract.invalid-options");
    const { schemaVersion: _schema, candidateKey: _key, provenanceStatus: _provenance, ...candidateInput } = candidate();
    expect(errorCode(() => createAcademicCandidate({ ...candidateInput, identifiers: { ...candidateInput.identifiers, [oversizedUnknown]: true } } as never))).toBe("acquisition-contract.invalid-input");
    const nestedPartition = partitionSnapshot();
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, { ...nestedPartition, normalizedInput: { ...nestedPartition.normalizedInput, [oversizedUnknown]: true } }))).toBe("acquisition-contract.invalid-input");
  });

  test("rejects oversized proxy arrays before every trap in options results and constructors", () => {
    const hostile = () => {
      let traps = 0;
      const failTrap = () => { traps += 1; throw new Error("SECRET proxy trap"); };
      const value = new Proxy(Array(100_001), {
        getOwnPropertyDescriptor: failTrap, ownKeys: failTrap, getPrototypeOf: failTrap, get: failTrap,
        set: failTrap, has: failTrap, defineProperty: failTrap, deleteProperty: failTrap,
        setPrototypeOf: failTrap, isExtensible: failTrap, preventExtensions: failTrap,
      });
      return { value, traps: () => traps };
    };
    const options = hostile(); expect(errorCode(() => normalizeAcquisitionOptions(options.value))).toBe("acquisition-contract.invalid-options"); expect(options.traps()).toBe(0);
    const publicResult = hostile(); expect(errorCode(() => validateAcademicAcquisitionResult(publicResult.value))).toBe("acquisition-contract.invalid-input"); expect(publicResult.traps()).toBe(0);
    const constructor = hostile(); expect(errorCode(() => createAcademicCandidate(constructor.value as never))).toBe("acquisition-contract.invalid-input"); expect(constructor.traps()).toBe(0);
  });

  test("rejects nested proxy arrays before length or descriptor enumeration", () => {
    const dense = Array.from({ length: 17 }, (_, index) => String(index + 1));
    let lengthReads = 0; let ownKeysReads = 0; let otherDescriptorReads = 0; let prototypeReads = 0;
    const hostile = new Proxy(dense, {
      getOwnPropertyDescriptor(target, key) { if (key === "length") { lengthReads += 1; return Reflect.getOwnPropertyDescriptor(target, key); } otherDescriptorReads += 1; throw new Error("unexpected descriptor enumeration"); },
      ownKeys() { ownKeysReads += 1; throw new Error("unexpected ownKeys enumeration"); },
      getPrototypeOf() { prototypeReads += 1; throw new Error("unexpected prototype access"); },
    });
    const preimage = partitionPreimage({ provider: "pubmed", endpointClass: "pubmed-search", target: "ncbi", normalizedInput: { kind: "pmid-list", pmids: dense }, requestedUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?id=1" });
    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${"f".repeat(64)}`, options: { ...PARTITION_LIMITS, maxStructureNodes: 16 } });
    const snapshot = partitionSnapshot(preimage);
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, { ...snapshot, normalizedInput: { kind: "pmid-list", pmids: hostile } }))).toBe("acquisition-contract.invalid-input");
    expect({ lengthReads, ownKeysReads, otherDescriptorReads, prototypeReads }).toEqual({ lengthReads: 0, ownKeysReads: 0, otherDescriptorReads: 0, prototypeReads: 0 });
    let throwingDescriptors = 0; let throwingOwnKeys = 0;
    const throwingLength = new Proxy(dense, { getOwnPropertyDescriptor() { throwingDescriptors += 1; throw new Error("SECRET length trap"); }, ownKeys() { throwingOwnKeys += 1; throw new Error("unexpected ownKeys enumeration"); } });
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, { ...snapshot, normalizedInput: { kind: "pmid-list", pmids: throwingLength } }))).toBe("acquisition-contract.invalid-input");
    expect({ throwingDescriptors, throwingOwnKeys }).toEqual({ throwingDescriptors: 0, throwingOwnKeys: 0 });
  });

  test("bounds nested snapshot arrays from their length descriptor before a second descriptor map", () => {
    const pmids = ["1"];
    const input = partitionPreimage({ provider: "pubmed", endpointClass: "pubmed-search", target: "ncbi", normalizedInput: { kind: "pmid-list", pmids }, requestedUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?id=1" });
    const originalLength = Object.getOwnPropertyDescriptor;
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    let lengthReads = 0; let descriptorMaps = 0;
    const lengthSpy = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((value, key) => {
      if (value === pmids && key === "length") { lengthReads += 1; const descriptor = originalLength(value, key)!; return lengthReads === 2 ? { ...descriptor, value: 100_001 } : descriptor; }
      return originalLength(value, key);
    });
    const descriptorsSpy = vi.spyOn(Object, "getOwnPropertyDescriptors").mockImplementation((value) => { if (value === pmids) descriptorMaps += 1; return originalDescriptors(value); });
    let code: string | undefined;
    try { code = errorCode(() => createProviderPartitionKey(input as Parameters<typeof createProviderPartitionKey>[0])); }
    finally { lengthSpy.mockRestore(); descriptorsSpy.mockRestore(); }
    expect(code).toBe("acquisition-contract.input-too-large");
    expect({ lengthReads, descriptorMaps }).toEqual({ lengthReads: 2, descriptorMaps: 1 });
  });

  test("rejects proxy arrays before explicit array caps or enumeration", () => {
    registeredPartition();
    const redirects = Array.from({ length: 6 }, () => ({ ordinal: 1, status: 302 as const, fromUrl: URL, fromOrigin: "https://api.crossref.org", toUrl: URL, toOrigin: "https://api.crossref.org" }));
    let lengthReads = 0; let ownKeysReads = 0;
    const hostile = new Proxy(redirects, { getOwnPropertyDescriptor(target, key) { if (key === "length") { lengthReads += 1; return Reflect.getOwnPropertyDescriptor(target, key); } throw new Error("unexpected descriptor enumeration"); }, ownKeys() { ownKeysReads += 1; throw new Error("unexpected ownKeys enumeration"); } });
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ redirectWitnesses: hostile }), PROJECTION_LIMITS))).toBe("acquisition-contract.invalid-input");
    expect({ lengthReads, ownKeysReads }).toEqual({ lengthReads: 0, ownKeysReads: 0 });
  });

  test("rejects overlong strings and keys before canonical expansion", () => {
    const owner = createProviderPartitionPlanOwnerInternal({ planId: `plan-v1-${"e".repeat(64)}`, options: { ...PARTITION_LIMITS, maxStringCanonicalBytes: 128 } });
    const endpointClass = "x".repeat(129);
    const partition = partitionSnapshot({ endpointClass });
    const { endpointClass: _endpointClass, ...partitionRest } = partition;
    const endpointFirst = { endpointClass, ...partitionRest };
    canonicalCounter.calls = 0; canonicalCounter.stringLengths = [];
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, endpointFirst))).toBe("acquisition-contract.input-too-large");
    expect(canonicalCounter.stringLengths).not.toContain(endpointClass.length);

    const overlongKey = "k".repeat(129);
    canonicalCounter.calls = 0; canonicalCounter.stringLengths = [];
    expect(errorCode(() => registerProviderRequestPartitionInternal(owner, { ...partition, [overlongKey]: 1 }))).toBe("acquisition-contract.invalid-input");
    expect(canonicalCounter.calls).toBe(0);
    const hugeKey = "k".repeat(1_048_577);
    expect(errorCode(() => normalizeAcquisitionOptions({ [hugeKey]: 1 }))).toBe("acquisition-contract.invalid-options");

    const requestedUrl = `https://api.crossref.org/${"q".repeat(180)}`;
    const input = partitionPreimage({ normalizedInput: { kind: "query", query: "long-url", limit: 1 }, requestedUrl });
    registeredPartition(input);
    const key = createProviderPartitionKey(input);
    canonicalCounter.calls = 0; canonicalCounter.stringLengths = [];
    expect(errorCode(() => acquisitionTraceSettlementInternalExported(settlement({ ...key, requestedUrl, finalUrl: requestedUrl, redirectWitnesses: [] }), { maxCanonicalUrlBytes: 32, maxRedirects: 5 }))).toBe("acquisition-contract.result-too-large");
    expect(canonicalCounter.stringLengths).not.toContain(requestedUrl.length);
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
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, requestedUrl: forgedUrl } } as never))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, requestedUrl: { ...input.settlement.requestedUrl, canonicalUrl: "https://api.crossref.org/works?secret=value" } } } as never))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, redirects: [{ ...input.settlement.redirects[0]!, ordinal: 2 }] } } as never))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...input.settlement, redirects: [{ ...input.settlement.redirects[0]!, from: { ...input.settlement.redirects[0]!.from, canonicalUrlSha256: HASH_B } }] } } as never))).toBe("acquisition-contract.invalid-capability");
    expect(errorCode(() => createAcquisitionTrace({ ...input, provider: "openalex" } as never))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => createAcquisitionTrace({ ...input, operation: "fetch" } as never))).toBe("acquisition-contract.invalid-key");
    expect(errorCode(() => createAcquisitionTrace({ ...input, endpointClass: "opaque-endpoint-v1" } as never))).toBe("acquisition-contract.invalid-key");
  });

  test("permits access only for authentic success settlements", () => {
    registeredPartition(); const key = createProviderPartitionKey(partitionPreimage());
    const traceInput = (projected: AcquisitionTrace["settlement"], accessLevel: "metadata-only" | null) => ({ provider: "crossref" as const, operation: "search" as const, endpointClass: "works-search", ...key, accessLevel, settlement: projected, warnings: [] });
    const success = acquisitionTraceSettlementInternalExported(settlement(), PROJECTION_LIMITS);
    expect(createAcquisitionTrace(traceInput(success, "metadata-only")).accessLevel).toBe("metadata-only");
    expect(createAcquisitionTrace(traceInput(success, null)).accessLevel).toBeNull();

    const failures = [
      ["network.dns-empty", "availability"], ["network.dns-nxdomain", "terminal-provider"], ["network.dns-temporary", "availability"], ["transport.connect-failed", "availability"], ["transport.connect-timeout", "availability"], ["transport.http-retryable", "http-retryable"],
      ["transport.http-terminal", "http-terminal"], ["transport.json-root-invalid", "invalid-response"],
      ["network.dns-unsafe", "security-policy"], ["transport.tls-failed", "security-policy"],
      ["transport.peer-unavailable", "security-policy"], ["transport.peer-mismatch", "security-policy"],
      ["transport.redirect-invalid", "security-policy"], ["transport.too-many-redirects", "security-policy"],
      ["transport.too-many-headers", "security-policy"], ["transport.headers-too-large", "security-policy"],
      ["transport.framing-invalid", "security-policy"], ["transport.protocol-invalid", "security-policy"],
      ["transport.encoded-too-large", "security-policy"], ["transport.too-many-encoding-layers", "security-policy"],
      ["transport.unsupported-encoding", "security-policy"], ["transport.decompression-failed", "security-policy"],
      ["transport.decompression-ratio", "security-policy"], ["transport.decoded-too-large", "security-policy"],
      ["transport.invalid-utf8", "security-policy"],
    ] as const;
    for (const [failureCode, code] of failures) {
      const projected = acquisitionTraceSettlementInternalExported(settlement({ outcome: "failure", failureCode, payloadUtf8: null, finalUrl: null, redirectWitnesses: [], httpStatus: null, encodedBytes: 0, decodedBytes: 0, responsePayloadSha256: null }), PROJECTION_LIMITS);
      expect(projected.code).toBe(code);
      expect(createAcquisitionTrace(traceInput(projected, null)).accessLevel).toBeNull();
      expect(errorCode(() => createAcquisitionTrace(traceInput(projected, "metadata-only")))).toBe("acquisition-contract.invalid-input");
    }
    for (const failureCode of ["transport.cancelled", "transport.deadline-exceeded"] as const) {
      const projected = acquisitionTraceSettlementInternalExported(settlement({ outcome: "cancelled", failureCode, payloadUtf8: null, finalUrl: null, redirectWitnesses: [], httpStatus: null, encodedBytes: 0, decodedBytes: 0, responsePayloadSha256: null }), PROJECTION_LIMITS);
      expect(createAcquisitionTrace(traceInput(projected, null)).accessLevel).toBeNull();
      expect(errorCode(() => createAcquisitionTrace(traceInput(projected, "metadata-only")))).toBe("acquisition-contract.invalid-input");
    }
    const blocked = createBlockedTraceSettlementInternal({ requestedUrl: URL, retrievedAt: AT, limits: PROJECTION_LIMITS });
    expect(createAcquisitionTrace(traceInput(blocked, null)).accessLevel).toBeNull();
    expect(errorCode(() => createAcquisitionTrace(traceInput(blocked, "metadata-only")))).toBe("acquisition-contract.invalid-input");
  });

  test("uses structural ceilings rather than an unlisted trace-warning cap", () => {
    const original = trace(); const { schemaVersion: _schema, traceKey: _key, provenanceStatus: _provenance, ...input } = original;
    const warnings = Array.from({ length: 1_201 }, (_, recordOrdinal) => ({ code: "provider.invalid-url-omitted" as const, recordOrdinal, field: "URL" as const }));
    expect(createAcquisitionTrace({ ...input, warnings }).warnings).toHaveLength(1_201);
    let touched = false; const overflow = Array(100_001); Object.defineProperty(overflow, "100000", { enumerable: true, get() { touched = true; throw new Error("untouched"); } });
    expect(errorCode(() => createAcquisitionTrace({ ...input, warnings: overflow } as never))).toBe("acquisition-contract.result-too-large");
    expect(touched).toBe(false);
  });

  test("keeps retrieval timestamps out of trace keys and rejects forged settlement clones", () => {
    registeredPartition(); const key = createProviderPartitionKey(partitionPreimage());
    const build = (settledAt: string) => createAcquisitionTrace({ provider: "crossref", operation: "search", endpointClass: "works-search", ...key, accessLevel: "metadata-only", settlement: acquisitionTraceSettlementInternalExported(settlement({ settledAt }), PROJECTION_LIMITS), warnings: [] });
    const a = build(LATER); const b = build("2030-01-01T00:00:00.000Z"); expect(a.traceKey).toBe(b.traceKey);
    const { schemaVersion: _schemaVersion, traceKey: _traceKey, provenanceStatus: _status, ...input } = a;
    expect(errorCode(() => createAcquisitionTrace({ ...input, settlement: { ...a.settlement } }))).toBe("acquisition-contract.invalid-capability");
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
    expect(errorCode(() => createBlockedTraceSettlementInternal({ requestedUrl: URL, retrievedAt: "bad", limits: PROJECTION_LIMITS }))).toBe("acquisition-contract.invalid-input");
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
