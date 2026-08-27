import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { normalizeCanonicalUrl, normalizeDoi, normalizePmcid, normalizePmid } from "../scholarly/identifiers.js";

interface StructuralLimits {
  maxDepth:number;maxNodes:number;maxKeys:number;maxArrayLength:number;maxStringBytes:number;maxScalarBytes:number;
}
class StructuralLimitError extends Error { readonly reason:"unsafe"|"limit";constructor(reason:"unsafe"|"limit"){super("Acquisition structure rejected");this.reason=reason;} }
function assertBoundedStructure(value:unknown,limits:StructuralLimits):void {
  const active=new WeakSet<object>();const seenDescriptors=new WeakMap<object,PropertyDescriptorMap>();let nodes=0;let keys=0;let scalarBytes=0;
  const add=(bytes:number):void=>{scalarBytes+=bytes;if(!Number.isSafeInteger(scalarBytes)||bytes>limits.maxStringBytes||scalarBytes>limits.maxScalarBytes)throw new StructuralLimitError("limit");};
  const visit=(item:unknown,depth:number):void=>{nodes+=1;if(nodes>limits.maxNodes||depth>limits.maxDepth)throw new StructuralLimitError("limit");if(typeof item==="string"){add(Buffer.byteLength(item,"utf8"));return;}if(item===null||typeof item==="boolean"){add(1);return;}if(typeof item==="number"){if(!Number.isFinite(item))throw new StructuralLimitError("unsafe");add(8);return;}if(typeof item!=="object"||utilTypes.isProxy(item))throw new StructuralLimitError("unsafe");if(active.has(item))throw new StructuralLimitError("unsafe");const array=Array.isArray(item);const prototype=Object.getPrototypeOf(item);if((array&&prototype!==Array.prototype)||(!array&&prototype!==Object.prototype&&prototype!==null))throw new StructuralLimitError("unsafe");let descriptors=seenDescriptors.get(item);if(!descriptors){descriptors=Object.getOwnPropertyDescriptors(item);seenDescriptors.set(item,descriptors);}const ownKeys=Reflect.ownKeys(descriptors);if(ownKeys.some((key)=>typeof key!=="string"))throw new StructuralLimitError("unsafe");if(array&&(item as unknown[]).length>limits.maxArrayLength)throw new StructuralLimitError("limit");active.add(item);try{for(const key of ownKeys as string[]){if(array&&key==="length")continue;keys+=1;if(keys>limits.maxKeys)throw new StructuralLimitError("limit");add(Buffer.byteLength(key,"utf8"));const descriptor=descriptors[key]!;if(!("value"in descriptor)||!descriptor.enumerable)throw new StructuralLimitError("unsafe");if(array&&(!/^(0|[1-9][0-9]*)$/u.test(key)||Number(key)>=(item as unknown[]).length))throw new StructuralLimitError("unsafe");visit(descriptor.value,depth+1);}if(array&&ownKeys.length!==(item as unknown[]).length+1)throw new StructuralLimitError("unsafe");}finally{active.delete(item);}};
  visit(value,0);
}

export type AcquisitionProvider = "crossref" | "openalex" | "pubmed" | "pmc";
export type AcquisitionOperation = "search" | "fetch";
export type ProviderNormalizedInput =
  | Readonly<{ kind: "query"; query: string; limit: number }>
  | Readonly<{ kind: "doi"; doi: string }>
  | Readonly<{ kind: "pmid-list"; pmids: readonly string[] }>
  | Readonly<{ kind: "pmid-link"; pmid: string }>
  | Readonly<{ kind: "pmcid"; pmcid: string }>;
export type AcquisitionAccessLevel = "metadata-only" | "abstract-only" | "partial-text" | "full-text";
export type AcquisitionProvenanceStatus = "uncommitted";
export type TransportFailureCode =
  | "network.dns-empty" | "network.dns-nxdomain" | "network.dns-temporary" | "network.dns-unsafe"
  | "transport.cancelled" | "transport.deadline-exceeded" | "transport.connect-timeout"
  | "transport.connect-failed" | "transport.tls-failed" | "transport.peer-unavailable"
  | "transport.peer-mismatch" | "transport.redirect-invalid" | "transport.too-many-redirects"
  | "transport.too-many-headers" | "transport.headers-too-large" | "transport.framing-invalid" | "transport.protocol-invalid"
  | "transport.encoded-too-large" | "transport.too-many-encoding-layers"
  | "transport.unsupported-encoding" | "transport.decompression-failed"
  | "transport.decompression-ratio" | "transport.decoded-too-large" | "transport.invalid-utf8"
  | "transport.json-root-invalid" | "transport.http-retryable" | "transport.http-terminal";
export type AcquisitionContractErrorCode =
  | "acquisition-contract.invalid-options" | "acquisition-contract.invalid-input"
  | "acquisition-contract.input-too-large" | "acquisition-contract.result-too-large"
  | "acquisition-contract.invalid-key" | "acquisition-contract.invalid-provenance"
  | "acquisition-contract.invalid-capability";
export class AcquisitionContractError extends Error {
  readonly code: AcquisitionContractErrorCode;
  constructor(code: AcquisitionContractErrorCode) {
    super(`Acquisition contract rejected (${code})`);
    this.name = "AcquisitionContractError";
    this.code = code;
  }
}

export interface AcademicTransportOptions {
  readonly maxDnsAddresses?:number;readonly maxRedirects?:number;
  readonly maxHeaders?:number;readonly maxHeaderCanonicalBytes?:number;
  readonly maxOutboundHeaders?:number;readonly maxOutboundHeaderValueCanonicalBytes?:number;
  readonly maxCanonicalUrlBytes?:number;readonly maxEncodedBytes?:number;readonly maxDecodedBodyBytes?:number;
  readonly maxDecompressionRatio?:number;readonly maxEncodingLayers?:number;
  readonly connectTimeoutMs?:number;readonly requestDeadlineMs?:number;
  readonly maxStructureDepth?:number;readonly maxStructureNodes?:number;
  readonly maxStructureKeys?:number;readonly maxStringCanonicalBytes?:number;
  readonly maxScalarCanonicalBytes?:number;
}
export interface AcademicProviderParseOptions {
  readonly maxProviderRecords?:number;readonly maxProviderRecordCanonicalBytes?:number;
  readonly maxAuthors?:number;readonly maxPartitions?:number;readonly maxAggregateDrafts?:number;
  readonly maxConditionalFacts?:number;readonly maxConditionalIdentifiers?:number;
  readonly maxConditionalFactCanonicalBytes?:number;readonly maxAggregateConditionalFactsCanonicalBytes?:number;
  readonly maxExecutionCanonicalBytes?:number;readonly maxStructureDepth?:number;readonly maxStructureNodes?:number;
  readonly maxStructureKeys?:number;readonly maxObjectWireBytes?:number;
  readonly maxStringCanonicalBytes?:number;readonly maxScalarCanonicalBytes?:number;
}
export interface AcademicNcbiProviderOptions extends AcademicProviderParseOptions {
  readonly maxJoinedPmids?:number;readonly maxPassages?:number;
  readonly maxSections?:number;readonly maxDocumentCanonicalBytes?:number;
}
export interface AcademicAcquisitionOptions {
  readonly transport?:AcademicTransportOptions;readonly providers?:AcademicNcbiProviderOptions;
  readonly maxQueries?:number;readonly maxCanonicalQueryBytes?:number;readonly maxTotalQueryBytes?:number;
  readonly maxPartitions?:number;readonly maxConcurrency?:number;readonly maxPerOriginConcurrency?:number;
  readonly maxCleanupDiagnostics?:number;readonly maxResultsPerQuery?:number;readonly maxAggregateCandidates?:number;
  readonly maxAggregateResultCanonicalBytes?:number;readonly maxVisibleBytes?:number;readonly maxVisibleLines?:number;
  readonly sinkSettlementTimeoutMs?:number;readonly shutdownGraceMs?:number;
  readonly maxStructureDepth?:number;readonly maxStructureNodes?:number;readonly maxStructureKeys?:number;
  readonly maxStringCanonicalBytes?:number;readonly maxScalarCanonicalBytes?:number;
}
export interface NormalizedAcquisitionOptionsInternal {
  readonly capabilityKind:"normalized-acquisition-options";
  readonly transport:Readonly<Required<AcademicTransportOptions>>;
  readonly providers:Readonly<Required<AcademicNcbiProviderOptions>>;
  readonly maxQueries:number;readonly maxCanonicalQueryBytes:number;readonly maxTotalQueryBytes:number;
  readonly maxPartitions:number;readonly maxConcurrency:number;readonly maxPerOriginConcurrency:number;
  readonly maxCleanupDiagnostics:number;readonly maxResultsPerQuery:number;readonly maxAggregateCandidates:number;
  readonly maxAggregateResultCanonicalBytes:number;readonly maxVisibleBytes:number;readonly maxVisibleLines:number;
  readonly sinkSettlementTimeoutMs:number;readonly shutdownGraceMs:number;
  readonly maxStructureDepth:number;readonly maxStructureNodes:number;readonly maxStructureKeys:number;
  readonly maxStringCanonicalBytes:number;readonly maxScalarCanonicalBytes:number;
  readonly optionsSha256:string;
}

export interface ProviderRequestPartitionInternal { readonly capabilityKind:"provider-request-partition"; }
export interface ProviderPartitionPlanOwnerInternal { readonly capabilityKind:"provider-partition-plan-owner"; }
export interface ProviderRequestPartitionSnapshotInternal {
  readonly provider:AcquisitionProvider; readonly operation:AcquisitionOperation;
  readonly endpointClass:string; readonly partitionKey:`partition-v1-${string}`;
  readonly partitionKeySha256:string; readonly normalizedInput:ProviderNormalizedInput;
  readonly normalizedInputSha256:string; readonly target:"crossref"|"openalex"|"ncbi";
  readonly url:string;
}
export interface ProviderPartitionRegistryOptionsInternal {
  readonly maxPartitions:number; readonly maxCanonicalUrlBytes:number;
  readonly maxStructureDepth:number; readonly maxStructureNodes:number;
  readonly maxStructureKeys:number; readonly maxStringCanonicalBytes:number;
  readonly maxScalarCanonicalBytes:number;
}

export interface RedirectWitness {
  readonly ordinal: number; readonly status: 301 | 302 | 303 | 307 | 308;
  readonly fromUrl: string; readonly fromOrigin: string;
  readonly toUrl: string; readonly toOrigin: string;
}
export interface ResponseHeaderProjection {
  readonly contentType: string | null; readonly retryAfter: string | null;
  readonly etag: string | null; readonly lastModified: string | null;
}
export interface ConnectedPeer { readonly address: string; readonly family: 4 | 6; }
export interface TransportSettlementBase {
  readonly schemaVersion: 1;
  readonly partitionKey: `partition-v1-${string}`;
  readonly partitionKeySha256: string;
  readonly provider: AcquisitionProvider; readonly operation: AcquisitionOperation;
  readonly endpointClass: string; readonly normalizedOrigin: string;
  readonly requestedUrl: string; readonly finalUrl: string | null;
  readonly redirectWitnesses: readonly RedirectWitness[];
  readonly httpStatus: number | null; readonly encodedBytes: number; readonly decodedBytes: number;
  readonly responsePayloadSha256: string | null;
  readonly responseHeaders: ResponseHeaderProjection;
  readonly responseHeadersSha256: string | null;
  readonly connectedPeer: ConnectedPeer | null;
  readonly startedAt: string; readonly settledAt: string;
}
export type TransportSettlement =
  | (TransportSettlementBase & { readonly outcome: "success"; readonly failureCode: null; readonly payloadUtf8: string })
  | (TransportSettlementBase & { readonly outcome: "failure"; readonly failureCode: Exclude<TransportFailureCode, "transport.cancelled" | "transport.deadline-exceeded">; readonly payloadUtf8: null })
  | (TransportSettlementBase & { readonly outcome: "cancelled"; readonly failureCode: "transport.cancelled" | "transport.deadline-exceeded"; readonly payloadUtf8: null });
export type AcquisitionTraceSettlementCode =
  | "success" | "availability" | "terminal-provider" | "http-retryable" | "http-terminal"
  | "invalid-response" | "sink-blocked" | "cancelled" | "deadline-exceeded" | "security-policy";
export interface AcquisitionTraceUrl { readonly canonicalUrl: string; readonly canonicalUrlSha256: string; }
export interface AcquisitionTraceRedirect {
  readonly ordinal: number; readonly status: 301 | 302 | 303 | 307 | 308;
  readonly from: AcquisitionTraceUrl; readonly to: AcquisitionTraceUrl;
}
export interface AcquisitionTraceSettlement {
  readonly outcome: "success" | "failure" | "cancelled" | "blocked";
  readonly code: AcquisitionTraceSettlementCode;
  readonly requestedUrl: AcquisitionTraceUrl; readonly finalUrl: AcquisitionTraceUrl | null;
  readonly redirects: readonly AcquisitionTraceRedirect[];
  readonly httpStatus: number | null; readonly encodedBytes: number; readonly decodedBytes: number;
  readonly responsePayloadSha256: string | null; readonly responseHeadersSha256: string | null;
  readonly retrievedAt: string;
}
export type AcquisitionTraceWarningCode = "provider.invalid-url-omitted" | "provider.invalid-identifier-omitted" | "provider.followup-unavailable";
export interface AcquisitionTraceWarning {
  readonly code: AcquisitionTraceWarningCode; readonly recordOrdinal: number | null;
  readonly field: "URL" | "primary_location.landing_page_url" | "doi" | "ids.doi" | "ids.pmid" | "ids.pmcid" | "elink";
}
export interface AcademicAuthor {
  readonly family: string | null; readonly given: string | null; readonly literal: string | null; readonly orcid: string | null;
}
export interface AcademicCandidate {
  readonly schemaVersion: 1; readonly candidateKey: `candidate-v1-${string}`;
  readonly provenanceStatus: AcquisitionProvenanceStatus;
  readonly provider: AcquisitionProvider; readonly endpointClass: string;
  readonly providerRecordId: string | null; readonly providerOrdinal: number | null;
  readonly partitionKeySha256: string; readonly responsePayloadSha256: string; readonly traceKey: `trace-v1-${string}`;
  readonly identifiers: Readonly<{ doi: string | null; pmid: string | null; pmcid: string | null }>;
  readonly canonicalUrl: string | null; readonly title: string | null; readonly authors: readonly AcademicAuthor[];
  readonly containerTitle: string | null; readonly publisher: string | null;
  readonly published: Readonly<{ date: string | null; precision: "day" | "month" | "year" | "unknown" }>;
  readonly publicationType: "journal-article" | "review" | "dataset" | "other";
  readonly accessLevel: AcquisitionAccessLevel; readonly abstractText: string | null;
}
export interface AcademicCandidateGroup {
  readonly groupKey: `candidate-group-v1-${string}`;
  readonly identityKind: "doi" | "pmid" | "pmcid" | "canonical-url" | "provider-result";
  readonly identityValueSha256: string; readonly status: "compatible" | "ambiguous";
  readonly candidateKeys: readonly `candidate-v1-${string}`[];
}
export interface AcademicDocumentSection { readonly sectionType: string; readonly text: string; }
export interface AcademicDocument {
  readonly schemaVersion: 1; readonly documentKey: `document-v1-${string}`;
  readonly pmcid: string; readonly candidateKey: `candidate-v1-${string}`;
  readonly partitionKeySha256: string; readonly responsePayloadSha256: string;
  readonly provenanceStatus: AcquisitionProvenanceStatus; readonly provider: "pmc";
  readonly traceKey: `trace-v1-${string}`; readonly accessLevel: AcquisitionAccessLevel;
  readonly sections: readonly AcademicDocumentSection[];
}
export interface AcquisitionTrace {
  readonly schemaVersion: 1; readonly traceKey: `trace-v1-${string}`;
  readonly provenanceStatus: AcquisitionProvenanceStatus;
  readonly provider: AcquisitionProvider; readonly operation: AcquisitionOperation; readonly endpointClass: string;
  readonly partitionKey: `partition-v1-${string}`; readonly partitionKeySha256: string;
  readonly accessLevel: AcquisitionAccessLevel | null; readonly settlement: AcquisitionTraceSettlement;
  readonly warnings: readonly AcquisitionTraceWarning[];
}
export interface AcquisitionFailure {
  readonly provider: AcquisitionProvider; readonly operation: AcquisitionOperation;
  readonly partitionKey: `partition-v1-${string}`; readonly partitionKeySha256: string;
  readonly code: "provider.retryable" | "provider.terminal" | "provider.invalid-response" | "provider.unsupported" | "sink.failed";
  readonly retryable: boolean;
}
export interface AcademicSearchInput {
  readonly queries: readonly string[]; readonly providers?: readonly ("crossref" | "openalex" | "pubmed")[];
  readonly maxResultsPerQuery?: number; readonly publicationTypes?: readonly ("journal-article" | "review" | "dataset" | "other")[];
  readonly fromYear?: number; readonly toYear?: number;
}
export interface AcademicFetchInput { readonly identifierKind: "doi" | "pmid" | "pmcid"; readonly identifier: string; }
export interface AcademicPartitionSummary { readonly requested:number;readonly dispatched:number;readonly succeeded:number;readonly failed:number;readonly blocked:number; }
export interface AcademicAcquisitionResult {
  readonly schemaVersion:1;readonly provenanceStatus:"uncommitted";readonly status:"complete"|"partial";
  readonly normalizedQueries:readonly string[];readonly partitions:AcademicPartitionSummary;
  readonly candidates:readonly AcademicCandidate[];readonly candidateGroups:readonly AcademicCandidateGroup[];
  readonly documents:readonly AcademicDocument[];readonly traces:readonly AcquisitionTrace[];
  readonly failures:readonly AcquisitionFailure[];readonly optionsSha256:string;
}
export interface AcquisitionProvenanceHandle { readonly correlationKey:string; }
export interface AcquisitionProvenanceSink { readonly capabilityKind:"acquisition-provenance-sink"; }
export interface AcquisitionProvenanceSinkDescriptor {
  readonly beforeDispatch:(intent:Readonly<{partitionKey:string;partitionKeySha256:string;provider:AcquisitionProvider;operation:AcquisitionOperation;endpointClass:string;normalizedInputSha256:string;requestedUrl:string;}>,signal:AbortSignal)=>Promise<AcquisitionProvenanceHandle>;
  readonly settled:(handle:AcquisitionProvenanceHandle,settlement:TransportSettlement,settlementSignal:AbortSignal)=>Promise<void>;
}
export interface AcademicCandidateInput extends Omit<AcademicCandidate,"schemaVersion"|"candidateKey"|"provenanceStatus"> {}
export interface AcademicDocumentInput extends Omit<AcademicDocument,"schemaVersion"|"documentKey"|"provenanceStatus"> {}
export interface AcquisitionTraceInput extends Omit<AcquisitionTrace,"schemaVersion"|"traceKey"|"provenanceStatus"> {}
export interface AcquisitionTraceProjectionLimitsInternal { readonly maxCanonicalUrlBytes:number;readonly maxRedirects:number; }

const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_PARTITION = /^partition-v1-[a-f0-9]{64}$/u;
const KEY_TRACE = /^trace-v1-[a-f0-9]{64}$/u;
const KEY_CANDIDATE = /^candidate-v1-[a-f0-9]{64}$/u;
const KEY_DOCUMENT = /^document-v1-[a-f0-9]{64}$/u;
const KEY_GROUP = /^candidate-group-v1-[a-f0-9]{64}$/u;
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PROVIDERS = ["crossref","openalex","pubmed","pmc"] as const;
const OPERATIONS = ["search","fetch"] as const;
const ACCESS = ["metadata-only","abstract-only","partial-text","full-text"] as const;
const TRANSPORT_FAILURES = [
  "network.dns-empty","network.dns-nxdomain","network.dns-temporary","network.dns-unsafe",
  "transport.cancelled","transport.deadline-exceeded","transport.connect-timeout","transport.connect-failed",
  "transport.tls-failed","transport.peer-unavailable","transport.peer-mismatch","transport.redirect-invalid",
  "transport.too-many-redirects","transport.too-many-headers","transport.headers-too-large","transport.framing-invalid",
  "transport.protocol-invalid","transport.encoded-too-large","transport.too-many-encoding-layers",
  "transport.unsupported-encoding","transport.decompression-failed","transport.decompression-ratio",
  "transport.decoded-too-large","transport.invalid-utf8","transport.json-root-invalid",
  "transport.http-retryable","transport.http-terminal",
] as const satisfies readonly TransportFailureCode[];
const PUBLIC_STRUCTURE: StructuralLimits = { maxDepth:64,maxNodes:100_000,maxKeys:100_000,maxArrayLength:100_000,maxStringBytes:1_048_576,maxScalarBytes:8_388_608 };
const OPTION_STRUCTURE: StructuralLimits = { maxDepth:64,maxNodes:100_000,maxKeys:100_000,maxArrayLength:100_000,maxStringBytes:1_048_576,maxScalarBytes:8_388_608 };

const transportDefaults: Required<AcademicTransportOptions> = {
  maxDnsAddresses:16,maxRedirects:5,maxHeaders:64,maxHeaderCanonicalBytes:65_536,
  maxOutboundHeaders:8,maxOutboundHeaderValueCanonicalBytes:4_096,maxCanonicalUrlBytes:4_096,
  maxEncodedBytes:8_388_608,maxDecodedBodyBytes:16_777_216,maxDecompressionRatio:100,maxEncodingLayers:2,
  connectTimeoutMs:10_000,requestDeadlineMs:60_000,maxStructureDepth:64,maxStructureNodes:250_000,
  maxStructureKeys:250_000,maxStringCanonicalBytes:1_048_576,maxScalarCanonicalBytes:16_777_216,
};
const transportHard: Required<AcademicTransportOptions> = {
  maxDnsAddresses:64,maxRedirects:5,maxHeaders:256,maxHeaderCanonicalBytes:262_144,
  maxOutboundHeaders:16,maxOutboundHeaderValueCanonicalBytes:16_384,maxCanonicalUrlBytes:16_384,
  maxEncodedBytes:33_554_432,maxDecodedBodyBytes:67_108_864,maxDecompressionRatio:1_000,maxEncodingLayers:4,
  connectTimeoutMs:30_000,requestDeadlineMs:300_000,maxStructureDepth:128,maxStructureNodes:1_000_000,
  maxStructureKeys:1_000_000,maxStringCanonicalBytes:4_194_304,maxScalarCanonicalBytes:67_108_864,
};
const providerBaseDefaults = {
  maxProviderRecords:100,maxProviderRecordCanonicalBytes:262_144,maxAuthors:256,
  maxConditionalIdentifiers:100,maxConditionalFactCanonicalBytes:262_144,
  maxStructureDepth:64,maxStructureNodes:250_000,maxStructureKeys:250_000,maxObjectWireBytes:8_388_608,
  maxStringCanonicalBytes:1_048_576,maxScalarCanonicalBytes:16_777_216,maxJoinedPmids:100,
  maxPassages:10_000,maxSections:5_000,maxDocumentCanonicalBytes:16_777_216,
} as const;
const providerHard: Required<AcademicNcbiProviderOptions> = {
  maxProviderRecords:1_000,maxProviderRecordCanonicalBytes:1_048_576,maxAuthors:1_024,
  maxPartitions:64,maxAggregateDrafts:1_000,maxConditionalFacts:64,maxConditionalIdentifiers:1_000,
  maxConditionalFactCanonicalBytes:1_048_576,maxAggregateConditionalFactsCanonicalBytes:67_108_864,
  maxExecutionCanonicalBytes:67_108_864,maxStructureDepth:128,maxStructureNodes:1_000_000,
  maxStructureKeys:1_000_000,maxObjectWireBytes:33_554_432,maxStringCanonicalBytes:4_194_304,
  maxScalarCanonicalBytes:67_108_864,maxJoinedPmids:1_000,maxPassages:50_000,maxSections:20_000,
  maxDocumentCanonicalBytes:67_108_864,
};
const topDefaults = {
  maxQueries:4,maxCanonicalQueryBytes:1_024,maxTotalQueryBytes:4_096,maxPartitions:12,maxConcurrency:4,
  maxPerOriginConcurrency:2,maxCleanupDiagnostics:323,maxResultsPerQuery:25,maxAggregateCandidates:200,
  maxAggregateResultCanonicalBytes:16_777_216,maxVisibleBytes:24_576,maxVisibleLines:500,
  sinkSettlementTimeoutMs:10_000,shutdownGraceMs:5_000,maxStructureDepth:16,maxStructureNodes:10_000,
  maxStructureKeys:10_000,maxStringCanonicalBytes:262_144,maxScalarCanonicalBytes:1_048_576,
} as const;
const topHard = {
  maxQueries:16,maxCanonicalQueryBytes:4_096,maxTotalQueryBytes:32_768,maxPartitions:64,maxConcurrency:16,
  maxPerOriginConcurrency:8,maxCleanupDiagnostics:323,maxResultsPerQuery:100,maxAggregateCandidates:1_000,
  maxAggregateResultCanonicalBytes:67_108_864,maxVisibleBytes:49_152,maxVisibleLines:2_000,
  sinkSettlementTimeoutMs:30_000,shutdownGraceMs:30_000,maxStructureDepth:64,maxStructureNodes:100_000,
  maxStructureKeys:100_000,maxStringCanonicalBytes:1_048_576,maxScalarCanonicalBytes:8_388_608,
} as const;
const topKeys = Object.keys(topDefaults);
const transportKeys = Object.keys(transportDefaults);
const providerKeys = Object.keys(providerHard);

type OptionState = { transport:object;providers:object;hash:string;scalars:Record<string,number> };
const normalizedOptionsRegistry = new WeakMap<object,OptionState>();
type OwnerState = { planId:string;options:ProviderPartitionRegistryOptionsInternal;open:boolean;keys:Set<string>;count:number };
const ownerRegistry = new WeakMap<object,OwnerState>();
const partitionRegistry = new WeakMap<object,{owner:ProviderPartitionPlanOwnerInternal;snapshot:ProviderRequestPartitionSnapshotInternal}>();
const sinkRegistry = new WeakMap<object,AcquisitionProvenanceSinkDescriptor>();
const sinkHandleRegistry = new WeakMap<object,{sink:AcquisitionProvenanceSink;handle:AcquisitionProvenanceHandle}>();

function fail(code:AcquisitionContractErrorCode):never { throw new AcquisitionContractError(code); }
function plain(value:unknown):value is Record<string,unknown> { if (value===null||typeof value!=="object"||utilTypes.isProxy(value)) return false; const p=Object.getPrototypeOf(value); return p===Object.prototype||p===null; }
function exactKeys(value:Record<string,unknown>,allowed:readonly string[]):boolean { const keys=Reflect.ownKeys(value); return keys.every((key)=>typeof key==="string"&&allowed.includes(key))&&keys.length===allowed.filter((key)=>Object.hasOwn(value,key)).length; }
function requireClosed(value:unknown,allowed:readonly string[],code:AcquisitionContractErrorCode):Record<string,unknown> { if (!plain(value)||Reflect.ownKeys(value).some((k)=>typeof k!=="string"||!allowed.includes(k as string))) fail(code); return value; }
function checkedAdd(left:number,right:number,code:AcquisitionContractErrorCode):number { const value=left+right;if(!Number.isSafeInteger(value))fail(code);return value; }
function checkedMultiply(left:number,right:number,code:AcquisitionContractErrorCode):number { const value=left*right;if(!Number.isSafeInteger(value))fail(code);return value; }
function integer(value:unknown,maximum:number,code:AcquisitionContractErrorCode):number { if(!Number.isSafeInteger(value)||typeof value!=="number"||value<1||value>maximum)fail(code);return value; }
function nonnegative(value:unknown,code:AcquisitionContractErrorCode):number { if(!Number.isSafeInteger(value)||typeof value!=="number"||value<0)fail(code);return value; }
function oneOf<T extends string>(value:unknown,values:readonly T[],code:AcquisitionContractErrorCode):T { if(typeof value!=="string"||!values.includes(value as T))fail(code);return value as T; }
function stringValue(value:unknown,code:AcquisitionContractErrorCode,nullable=false):string|null { if(nullable&&value===null)return null;if(typeof value!=="string")fail(code);return value; }
function hashValue(value:unknown,code:AcquisitionContractErrorCode):string { if(typeof value!=="string"||!SHA256.test(value))fail(code);return value; }
function keyValue(value:unknown,pattern:RegExp,code:AcquisitionContractErrorCode):string { if(typeof value!=="string"||!pattern.test(value))fail(code);return value; }
function timestamp(value:unknown,code:AcquisitionContractErrorCode):string { if(typeof value!=="string"||!RFC3339_MS.test(value)||new Date(value).toISOString()!==value)fail(code);return value; }
function deepFreeze<T>(value:T):T { if(value&&typeof value==="object"&&!Object.isFrozen(value)){ for(const key of Reflect.ownKeys(value as object)){const d=Object.getOwnPropertyDescriptor(value as object,key);if(d&&"value"in d)deepFreeze(d.value);}Object.freeze(value);}return value; }
function rejectAliases(value:unknown):void { const seen=new WeakSet<object>();const visit=(item:unknown):void=>{if(item===null||typeof item!=="object")return;if(seen.has(item))fail("acquisition-contract.invalid-input");seen.add(item);for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))){if("value"in descriptor)visit(descriptor.value);}};visit(value); }
function snapshot<T>(value:unknown,limits:StructuralLimits,invalid:AcquisitionContractErrorCode,tooLarge:AcquisitionContractErrorCode):T {
  try { assertBoundedStructure(value,limits);rejectAliases(value);const encoded=canonicalJson(value);if(Buffer.byteLength(encoded,"utf8")>limits.maxScalarBytes)fail(tooLarge);return JSON.parse(encoded) as T; }
  catch(error){if(error instanceof AcquisitionContractError)throw error;if(error instanceof StructuralLimitError&&error.reason==="limit")fail(tooLarge);fail(invalid);}
}
function frozenCopy<T>(value:T):T { return deepFreeze(JSON.parse(canonicalJson(value)) as T); }
function prefixHash(prefix:string,preimage:unknown):string { return `${prefix}${sha256Hex(canonicalJson(preimage))}`; }

export function normalizeAcquisitionOptions(raw:unknown):NormalizedAcquisitionOptionsInternal {
  let data:Record<string,unknown>={};
  if(raw!==undefined){try{assertBoundedStructure(raw,OPTION_STRUCTURE);rejectAliases(raw);data=JSON.parse(canonicalJson(raw)) as Record<string,unknown>;}catch{fail("acquisition-contract.invalid-options");}}
  if(!plain(data)||Reflect.ownKeys(data).some((key)=>typeof key!=="string"&&true))fail("acquisition-contract.invalid-options");
  const allowed=["transport","providers",...topKeys];if(Object.keys(data).some((key)=>!allowed.includes(key)))fail("acquisition-contract.invalid-options");
  const transportData=data.transport===undefined?{}:requireClosed(data.transport,transportKeys,"acquisition-contract.invalid-options");
  const providerData=data.providers===undefined?{}:requireClosed(data.providers,providerKeys,"acquisition-contract.invalid-options");
  const top={} as Record<string,number>;for(const key of topKeys){const k=key as keyof typeof topDefaults;top[key]=data[key]===undefined?topDefaults[k]:integer(data[key],topHard[k],"acquisition-contract.invalid-options");}
  const transport={} as Record<string,number>;for(const key of transportKeys){const k=key as keyof typeof transportDefaults;transport[key]=transportData[key]===undefined?transportDefaults[k]:integer(transportData[key],transportHard[k],"acquisition-contract.invalid-options");}
  const aliases:Record<string,number>={maxPartitions:top.maxPartitions!,maxAggregateDrafts:top.maxAggregateCandidates!,maxConditionalFacts:top.maxPartitions!,maxAggregateConditionalFactsCanonicalBytes:top.maxAggregateResultCanonicalBytes!,maxExecutionCanonicalBytes:top.maxAggregateResultCanonicalBytes!};
  const providers={} as Record<string,number>;for(const key of providerKeys){const k=key as keyof typeof providerHard;const fallback=key in aliases?aliases[key]!:providerBaseDefaults[key as keyof typeof providerBaseDefaults];providers[key]=providerData[key]===undefined?fallback:integer(providerData[key],providerHard[k],"acquisition-contract.invalid-options");}
  if(top.maxPerOriginConcurrency!>top.maxConcurrency!||transport.requestDeadlineMs!<transport.connectTimeoutMs!||providers.maxProviderRecords!<top.maxResultsPerQuery!||providers.maxJoinedPmids!<top.maxResultsPerQuery!)fail("acquisition-contract.invalid-options");
  for(const [key,value] of Object.entries(aliases))if(providers[key]!==value)fail("acquisition-contract.invalid-options");
  if(providers.maxConditionalIdentifiers!==providers.maxProviderRecords||providers.maxConditionalFactCanonicalBytes!==providers.maxProviderRecordCanonicalBytes)fail("acquisition-contract.invalid-options");
  const cleanup=checkedAdd(checkedMultiply(5,top.maxPartitions!,"acquisition-contract.invalid-options"),3,"acquisition-contract.invalid-options");if(top.maxCleanupDiagnostics!<cleanup)fail("acquisition-contract.invalid-options");
  const normalizedTransport=deepFreeze(transport as unknown as Required<AcademicTransportOptions>);const normalizedProviders=deepFreeze(providers as unknown as Required<AcademicNcbiProviderOptions>);
  const body={schemaVersion:1,transport:normalizedTransport,providers:normalizedProviders,...top};const optionsSha256=sha256Hex(canonicalJson(body));
  const output=deepFreeze({capabilityKind:"normalized-acquisition-options" as const,transport:normalizedTransport,providers:normalizedProviders,...top,optionsSha256}) as NormalizedAcquisitionOptionsInternal;
  const scalars:Record<string,number>={};for(const key of topKeys)scalars[key]=output[key as keyof NormalizedAcquisitionOptionsInternal] as number;
  normalizedOptionsRegistry.set(output,{transport:output.transport,providers:output.providers,hash:optionsSha256,scalars});return output;
}
export function assertNormalizedAcquisitionOptionsInternal(value:unknown):asserts value is NormalizedAcquisitionOptionsInternal {
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("acquisition-contract.invalid-capability");const state=normalizedOptionsRegistry.get(value);if(!state||!Object.isFrozen(value)||!Object.isFrozen(state.transport)||!Object.isFrozen(state.providers))fail("acquisition-contract.invalid-capability");
  const record=value as unknown as Record<string,unknown>;if(record.transport!==state.transport||record.providers!==state.providers||record.optionsSha256!==state.hash||record.capabilityKind!=="normalized-acquisition-options")fail("acquisition-contract.invalid-capability");
  for(const [key,expected] of Object.entries(state.scalars))if(record[key]!==expected)fail("acquisition-contract.invalid-capability");
}

function validateNormalizedInput(value:unknown):ProviderNormalizedInput {
  if(!plain(value)||typeof value.kind!=="string")fail("acquisition-contract.invalid-input");
  switch(value.kind){case"query":{const v=requireClosed(value,["kind","query","limit"],"acquisition-contract.invalid-input");if(typeof v.query!=="string"||v.query.length===0)fail("acquisition-contract.invalid-input");return deepFreeze({kind:"query",query:v.query,limit:integer(v.limit,10_000,"acquisition-contract.invalid-input")});}
    case"doi":{const v=requireClosed(value,["kind","doi"],"acquisition-contract.invalid-input");return deepFreeze({kind:"doi",doi:normalizeDoi(v.doi)});}
    case"pmid-list":{const v=requireClosed(value,["kind","pmids"],"acquisition-contract.invalid-input");if(!Array.isArray(v.pmids)||v.pmids.length===0||v.pmids.length>1_000)fail("acquisition-contract.invalid-input");const pmids=v.pmids.map((item)=>normalizePmid(item));if(new Set(pmids).size!==pmids.length)fail("acquisition-contract.invalid-input");return deepFreeze({kind:"pmid-list",pmids});}
    case"pmid-link":{const v=requireClosed(value,["kind","pmid"],"acquisition-contract.invalid-input");return deepFreeze({kind:"pmid-link",pmid:normalizePmid(v.pmid)});}
    case"pmcid":{const v=requireClosed(value,["kind","pmcid"],"acquisition-contract.invalid-input");return deepFreeze({kind:"pmcid",pmcid:normalizePmcid(v.pmcid)});}
    default:return fail("acquisition-contract.invalid-input");}
}
function fixedUrl(value:unknown,target:"crossref"|"openalex"|"ncbi",maximum=16_384):string {
  if(typeof value!=="string")fail("acquisition-contract.invalid-input");if(value.length>maximum)fail("acquisition-contract.input-too-large");let url:URL;try{url=new URL(value);}catch{return fail("acquisition-contract.invalid-input");}
  if(url.protocol!=="https:"||url.username!==""||url.password!==""||url.hash!==""||url.port!==""||url.href!==value)fail("acquisition-contract.invalid-input");
  const allowed=target==="crossref"?["api.crossref.org"]:target==="openalex"?["api.openalex.org"]:["eutils.ncbi.nlm.nih.gov","www.ncbi.nlm.nih.gov"];
  if(!allowed.includes(url.hostname))fail("acquisition-contract.invalid-input");if(Buffer.byteLength(canonicalJson(value),"utf8")>maximum)fail("acquisition-contract.input-too-large");return value;
}
export function createProviderPartitionKey(input:Readonly<{provider:AcquisitionProvider;operation:AcquisitionOperation;endpointClass:string;target:"crossref"|"openalex"|"ncbi";normalizedInput:ProviderNormalizedInput;requestedUrl:string;}>):Readonly<{partitionKey:`partition-v1-${string}`;partitionKeySha256:string}> {
  const data=snapshot<Record<string,unknown>>(input,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.input-too-large");const v=requireClosed(data,["provider","operation","endpointClass","target","normalizedInput","requestedUrl"],"acquisition-contract.invalid-input");
  const provider=oneOf(v.provider,PROVIDERS,"acquisition-contract.invalid-input");const operation=oneOf(v.operation,OPERATIONS,"acquisition-contract.invalid-input");const endpointClass=stringValue(v.endpointClass,"acquisition-contract.invalid-input")!;if(endpointClass.length===0)fail("acquisition-contract.invalid-input");const target=oneOf(v.target,["crossref","openalex","ncbi"] as const,"acquisition-contract.invalid-input");
  if((provider==="crossref"&&target!=="crossref")||(provider==="openalex"&&target!=="openalex")||((provider==="pubmed"||provider==="pmc")&&target!=="ncbi"))fail("acquisition-contract.invalid-input");
  const normalizedInput=validateNormalizedInput(v.normalizedInput);const requestedUrl=fixedUrl(v.requestedUrl,target);const preimage={schemaVersion:1,provider,operation,endpointClass,target,normalizedInput,requestedUrl};const partitionKeySha256=sha256Hex(canonicalJson(preimage));return deepFreeze({partitionKey:`partition-v1-${partitionKeySha256}`,partitionKeySha256});
}
function registryOptions(value:unknown):ProviderPartitionRegistryOptionsInternal { const data=snapshot<Record<string,unknown>>(value,OPTION_STRUCTURE,"acquisition-contract.invalid-capability","acquisition-contract.invalid-capability");const keys=["maxPartitions","maxCanonicalUrlBytes","maxStructureDepth","maxStructureNodes","maxStructureKeys","maxStringCanonicalBytes","maxScalarCanonicalBytes"];const v=requireClosed(data,keys,"acquisition-contract.invalid-capability");return deepFreeze({maxPartitions:integer(v.maxPartitions,64,"acquisition-contract.invalid-capability"),maxCanonicalUrlBytes:integer(v.maxCanonicalUrlBytes,16_384,"acquisition-contract.invalid-capability"),maxStructureDepth:integer(v.maxStructureDepth,64,"acquisition-contract.invalid-capability"),maxStructureNodes:integer(v.maxStructureNodes,100_000,"acquisition-contract.invalid-capability"),maxStructureKeys:integer(v.maxStructureKeys,100_000,"acquisition-contract.invalid-capability"),maxStringCanonicalBytes:integer(v.maxStringCanonicalBytes,1_048_576,"acquisition-contract.invalid-capability"),maxScalarCanonicalBytes:integer(v.maxScalarCanonicalBytes,8_388_608,"acquisition-contract.invalid-capability")}); }
export function createProviderPartitionPlanOwnerInternal(input:Readonly<{planId:`plan-v1-${string}`;options:ProviderPartitionRegistryOptionsInternal;}>):ProviderPartitionPlanOwnerInternal { const data=snapshot<Record<string,unknown>>(input,OPTION_STRUCTURE,"acquisition-contract.invalid-capability","acquisition-contract.invalid-capability");const v=requireClosed(data,["planId","options"],"acquisition-contract.invalid-capability");if(typeof v.planId!=="string"||!/^plan-v1-[a-f0-9]{64}$/u.test(v.planId))fail("acquisition-contract.invalid-capability");const options=registryOptions(v.options);const owner=Object.freeze({capabilityKind:"provider-partition-plan-owner" as const});ownerRegistry.set(owner,{planId:v.planId,options,open:true,keys:new Set(),count:0});return owner; }
function ownerState(owner:unknown):OwnerState { if(owner===null||typeof owner!=="object"||utilTypes.isProxy(owner))fail("acquisition-contract.invalid-capability");const state=ownerRegistry.get(owner);if(!state||!state.open||!Object.isFrozen(owner)||(owner as ProviderPartitionPlanOwnerInternal).capabilityKind!=="provider-partition-plan-owner")fail("acquisition-contract.invalid-capability");return state; }
export function registerProviderRequestPartitionInternal(owner:ProviderPartitionPlanOwnerInternal,input:unknown):ProviderRequestPartitionInternal { const state=ownerState(owner);if(state.count>=state.options.maxPartitions)fail("acquisition-contract.input-too-large");const limits:StructuralLimits={maxDepth:state.options.maxStructureDepth,maxNodes:state.options.maxStructureNodes,maxKeys:state.options.maxStructureKeys,maxArrayLength:state.options.maxStructureNodes,maxStringBytes:state.options.maxStringCanonicalBytes,maxScalarBytes:state.options.maxScalarCanonicalBytes};const data=snapshot<Record<string,unknown>>(input,limits,"acquisition-contract.invalid-input","acquisition-contract.input-too-large");const keys=["provider","operation","endpointClass","partitionKey","partitionKeySha256","normalizedInput","normalizedInputSha256","target","url"];const v=requireClosed(data,keys,"acquisition-contract.invalid-input");for(const required of keys)if(!Object.hasOwn(v,required))fail("acquisition-contract.invalid-input");
  const provider=oneOf(v.provider,PROVIDERS,"acquisition-contract.invalid-input");const operation=oneOf(v.operation,OPERATIONS,"acquisition-contract.invalid-input");const endpointClass=stringValue(v.endpointClass,"acquisition-contract.invalid-input")!;const target=oneOf(v.target,["crossref","openalex","ncbi"] as const,"acquisition-contract.invalid-input");const normalizedInput=validateNormalizedInput(v.normalizedInput);const url=fixedUrl(v.url,target,state.options.maxCanonicalUrlBytes);const expected=createProviderPartitionKey({provider,operation,endpointClass,target,normalizedInput,requestedUrl:url});if(v.partitionKey!==expected.partitionKey||v.partitionKeySha256!==expected.partitionKeySha256||v.normalizedInputSha256!==sha256Hex(canonicalJson(normalizedInput)))fail("acquisition-contract.invalid-key");if(state.keys.has(expected.partitionKey))fail("acquisition-contract.invalid-key");
  const snapshotValue=deepFreeze({provider,operation,endpointClass,partitionKey:expected.partitionKey,partitionKeySha256:expected.partitionKeySha256,normalizedInput,normalizedInputSha256:v.normalizedInputSha256 as string,target,url}) as ProviderRequestPartitionSnapshotInternal;const partition=Object.freeze({capabilityKind:"provider-request-partition" as const});partitionRegistry.set(partition,{owner,snapshot:snapshotValue});state.keys.add(expected.partitionKey);state.count+=1;return partition;
}
export function assertProviderRequestPartitionInternal(value:unknown):asserts value is ProviderRequestPartitionInternal { if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("acquisition-contract.invalid-capability");const state=partitionRegistry.get(value);if(!state||!ownerRegistry.get(state.owner)?.open||!Object.isFrozen(value)||(value as ProviderRequestPartitionInternal).capabilityKind!=="provider-request-partition")fail("acquisition-contract.invalid-capability"); }
export function assertProviderRequestPartitionOwnedByInternal(value:ProviderRequestPartitionInternal,owner:ProviderPartitionPlanOwnerInternal):void { assertProviderRequestPartitionInternal(value);ownerState(owner);if(partitionRegistry.get(value)!.owner!==owner)fail("acquisition-contract.invalid-capability"); }
export function lookupProviderRequestPartitionInternal(value:ProviderRequestPartitionInternal):ProviderRequestPartitionSnapshotInternal { assertProviderRequestPartitionInternal(value);return frozenCopy(partitionRegistry.get(value)!.snapshot); }
export function lookupProviderRequestPartitionOwnerInternal(value:ProviderRequestPartitionInternal):ProviderPartitionPlanOwnerInternal { assertProviderRequestPartitionInternal(value);return partitionRegistry.get(value)!.owner; }
export function closeProviderPartitionPlanOwnerInternal(owner:ProviderPartitionPlanOwnerInternal):void { const state=ownerRegistry.get(owner as object);if(!state)fail("acquisition-contract.invalid-capability");state.open=false;state.keys.clear(); }
export function createProviderRequestPartitionFixtureInternal(input:Readonly<{partition:unknown;options:ProviderPartitionRegistryOptionsInternal;}>):ProviderRequestPartitionInternal { let data:Record<string,unknown>;try{assertBoundedStructure(input,OPTION_STRUCTURE);rejectAliases(input);data=JSON.parse(canonicalJson(input)) as Record<string,unknown>;}catch{return fail("acquisition-contract.invalid-capability");}const v=requireClosed(data,["partition","options"],"acquisition-contract.invalid-capability");const owner=createProviderPartitionPlanOwnerInternal({planId:`plan-v1-${sha256Hex(canonicalJson(v.partition))}`,options:v.options as ProviderPartitionRegistryOptionsInternal});return registerProviderRequestPartitionInternal(owner,v.partition); }

function validateProjectionLimits(value:unknown):AcquisitionTraceProjectionLimitsInternal { const data=snapshot<Record<string,unknown>>(value,OPTION_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.result-too-large");const v=requireClosed(data,["maxCanonicalUrlBytes","maxRedirects"],"acquisition-contract.invalid-input");return {maxCanonicalUrlBytes:integer(v.maxCanonicalUrlBytes,16_384,"acquisition-contract.invalid-input"),maxRedirects:integer(v.maxRedirects,5,"acquisition-contract.invalid-input")}; }
function canonicalTransportUrl(value:unknown,maximum:number):string { if(typeof value!=="string")fail("acquisition-contract.invalid-input");let normalized:string;try{normalized=normalizeCanonicalUrl(value,{maxCanonicalScalarBytes:16_384});}catch{return fail("acquisition-contract.invalid-input");}if(normalized!==value)fail("acquisition-contract.invalid-input");if(Buffer.byteLength(canonicalJson(value),"utf8")>maximum)fail("acquisition-contract.result-too-large");return value; }
function projectUrl(value:string,maximum:number):AcquisitionTraceUrl { const full=canonicalTransportUrl(value,maximum);const url=new URL(full);const pathname=url.pathname.replace(/%[0-9a-f]{2}/giu,(match)=>match.toUpperCase());const canonicalUrl=`${url.origin}${pathname}${url.search===""?"":"?redacted"}`;if(Buffer.byteLength(canonicalJson(canonicalUrl),"utf8")>maximum)fail("acquisition-contract.result-too-large");return deepFreeze({canonicalUrl,canonicalUrlSha256:sha256Hex(canonicalJson({schemaVersion:1,url:full}))}); }
function settlementCode(settlement:TransportSettlement):AcquisitionTraceSettlementCode { if(settlement.outcome==="success")return"success";switch(settlement.failureCode){case"network.dns-empty":case"network.dns-nxdomain":case"network.dns-temporary":case"transport.connect-failed":case"transport.connect-timeout":return"availability";case"transport.cancelled":return"cancelled";case"transport.deadline-exceeded":return"deadline-exceeded";case"transport.http-retryable":return"http-retryable";case"transport.http-terminal":return"http-terminal";default:return"security-policy";} }
function validateSettlement(value:unknown):TransportSettlement { const data=snapshot<Record<string,unknown>>(value,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.input-too-large");const common=["schemaVersion","partitionKey","partitionKeySha256","provider","operation","endpointClass","normalizedOrigin","requestedUrl","finalUrl","redirectWitnesses","httpStatus","encodedBytes","decodedBytes","responsePayloadSha256","responseHeaders","responseHeadersSha256","connectedPeer","startedAt","settledAt","outcome","failureCode","payloadUtf8"];const v=requireClosed(data,common,"acquisition-contract.invalid-input");if(v.schemaVersion!==1)fail("acquisition-contract.invalid-input");keyValue(v.partitionKey,KEY_PARTITION,"acquisition-contract.invalid-key");hashValue(v.partitionKeySha256,"acquisition-contract.invalid-key");if(v.partitionKey!==`partition-v1-${v.partitionKeySha256}`)fail("acquisition-contract.invalid-key");oneOf(v.provider,PROVIDERS,"acquisition-contract.invalid-input");oneOf(v.operation,OPERATIONS,"acquisition-contract.invalid-input");stringValue(v.endpointClass,"acquisition-contract.invalid-input");const normalizedOrigin=stringValue(v.normalizedOrigin,"acquisition-contract.invalid-input")!;let originUrl:URL;try{originUrl=new URL(normalizedOrigin);}catch{return fail("acquisition-contract.invalid-input");}if(originUrl.origin!==normalizedOrigin||originUrl.href!==`${normalizedOrigin}/`||originUrl.protocol!=="https:")fail("acquisition-contract.invalid-input");stringValue(v.requestedUrl,"acquisition-contract.invalid-input");if(v.finalUrl!==null)stringValue(v.finalUrl,"acquisition-contract.invalid-input");if(!Array.isArray(v.redirectWitnesses))fail("acquisition-contract.invalid-input");let expectedOrdinal=1;for(const item of v.redirectWitnesses){const r=requireClosed(item,["ordinal","status","fromUrl","fromOrigin","toUrl","toOrigin"],"acquisition-contract.invalid-input");if(r.ordinal!==expectedOrdinal)fail("acquisition-contract.invalid-input");expectedOrdinal+=1;if(![301,302,303,307,308].includes(r.status as number))fail("acquisition-contract.invalid-input");for(const key of ["fromUrl","fromOrigin","toUrl","toOrigin"])stringValue(r[key],"acquisition-contract.invalid-input");try{if(new URL(r.fromUrl as string).origin!==r.fromOrigin||new URL(r.toUrl as string).origin!==r.toOrigin)fail("acquisition-contract.invalid-input");}catch{return fail("acquisition-contract.invalid-input");}}if(v.httpStatus!==null)integer(v.httpStatus,999,"acquisition-contract.invalid-input");nonnegative(v.encodedBytes,"acquisition-contract.invalid-input");nonnegative(v.decodedBytes,"acquisition-contract.invalid-input");if(v.responsePayloadSha256!==null)hashValue(v.responsePayloadSha256,"acquisition-contract.invalid-input");if(v.responseHeadersSha256!==null)hashValue(v.responseHeadersSha256,"acquisition-contract.invalid-input");const headers=requireClosed(v.responseHeaders,["contentType","retryAfter","etag","lastModified"],"acquisition-contract.invalid-input");for(const key of ["contentType","retryAfter","etag","lastModified"])stringValue(headers[key],"acquisition-contract.invalid-input",true);if(v.connectedPeer!==null){const peer=requireClosed(v.connectedPeer,["address","family"],"acquisition-contract.invalid-input");stringValue(peer.address,"acquisition-contract.invalid-input");if(peer.family!==4&&peer.family!==6)fail("acquisition-contract.invalid-input");}timestamp(v.startedAt,"acquisition-contract.invalid-input");timestamp(v.settledAt,"acquisition-contract.invalid-input");if(v.outcome==="success"){if(v.failureCode!==null||typeof v.payloadUtf8!=="string"||v.responsePayloadSha256===null)fail("acquisition-contract.invalid-input");}else if(v.outcome==="failure"){oneOf(v.failureCode,TRANSPORT_FAILURES,"acquisition-contract.invalid-input");if(v.failureCode==="transport.cancelled"||v.failureCode==="transport.deadline-exceeded"||v.payloadUtf8!==null)fail("acquisition-contract.invalid-input");}else if(v.outcome==="cancelled"){if(!["transport.cancelled","transport.deadline-exceeded"].includes(v.failureCode as string)||v.payloadUtf8!==null)fail("acquisition-contract.invalid-input");}else fail("acquisition-contract.invalid-input");return deepFreeze(data) as unknown as TransportSettlement; }
export function acquisitionTraceSettlementInternal(settlement:TransportSettlement,limits:AcquisitionTraceProjectionLimitsInternal):AcquisitionTraceSettlement { const normalizedLimits=validateProjectionLimits(limits);const value=validateSettlement(settlement);if(value.redirectWitnesses.length>normalizedLimits.maxRedirects)fail("acquisition-contract.result-too-large");const urlSlots=checkedMultiply(checkedAdd(2,checkedMultiply(2,value.redirectWitnesses.length,"acquisition-contract.result-too-large"),"acquisition-contract.result-too-large"),normalizedLimits.maxCanonicalUrlBytes,"acquisition-contract.result-too-large");if(!Number.isSafeInteger(urlSlots))fail("acquisition-contract.result-too-large");const requestedUrl=projectUrl(value.requestedUrl,normalizedLimits.maxCanonicalUrlBytes);const finalUrl=value.finalUrl===null?null:projectUrl(value.finalUrl,normalizedLimits.maxCanonicalUrlBytes);const redirects=value.redirectWitnesses.map((item)=>deepFreeze({ordinal:item.ordinal,status:item.status,from:projectUrl(item.fromUrl,normalizedLimits.maxCanonicalUrlBytes),to:projectUrl(item.toUrl,normalizedLimits.maxCanonicalUrlBytes)}));return deepFreeze({outcome:value.outcome,code:settlementCode(value),requestedUrl,finalUrl,redirects,httpStatus:value.httpStatus,encodedBytes:value.encodedBytes,decodedBytes:value.decodedBytes,responsePayloadSha256:value.responsePayloadSha256,responseHeadersSha256:value.responseHeadersSha256,retrievedAt:timestamp(value.settledAt,"acquisition-contract.invalid-input")}); }
export function createBlockedTraceSettlementInternal(input:Readonly<{requestedUrl:string;retrievedAt:string;limits:AcquisitionTraceProjectionLimitsInternal;}>):AcquisitionTraceSettlement { const data=snapshot<Record<string,unknown>>(input,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.result-too-large");const v=requireClosed(data,["requestedUrl","retrievedAt","limits"],"acquisition-contract.invalid-input");const limits=validateProjectionLimits(v.limits);return deepFreeze({outcome:"blocked",code:"sink-blocked",requestedUrl:projectUrl(stringValue(v.requestedUrl,"acquisition-contract.invalid-input")!,limits.maxCanonicalUrlBytes),finalUrl:null,redirects:[],httpStatus:null,encodedBytes:0,decodedBytes:0,responsePayloadSha256:null,responseHeadersSha256:null,retrievedAt:timestamp(v.retrievedAt,"acquisition-contract.invalid-input")}); }

function validateTraceSettlement(value:unknown):AcquisitionTraceSettlement { const v=requireClosed(value,["outcome","code","requestedUrl","finalUrl","redirects","httpStatus","encodedBytes","decodedBytes","responsePayloadSha256","responseHeadersSha256","retrievedAt"],"acquisition-contract.invalid-input");const outcome=oneOf(v.outcome,["success","failure","cancelled","blocked"] as const,"acquisition-contract.invalid-input");const code=oneOf(v.code,["success","availability","terminal-provider","http-retryable","http-terminal","invalid-response","sink-blocked","cancelled","deadline-exceeded","security-policy"] as const,"acquisition-contract.invalid-input");const validateUrl=(item:unknown):AcquisitionTraceUrl=>{const u=requireClosed(item,["canonicalUrl","canonicalUrlSha256"],"acquisition-contract.invalid-input");const canonicalUrl=stringValue(u.canonicalUrl,"acquisition-contract.invalid-input")!;const canonicalUrlSha256=hashValue(u.canonicalUrlSha256,"acquisition-contract.invalid-key");return {canonicalUrl,canonicalUrlSha256};};validateUrl(v.requestedUrl);if(v.finalUrl!==null)validateUrl(v.finalUrl);if(!Array.isArray(v.redirects))fail("acquisition-contract.invalid-input");for(const item of v.redirects){const r=requireClosed(item,["ordinal","status","from","to"],"acquisition-contract.invalid-input");nonnegative(r.ordinal,"acquisition-contract.invalid-input");validateUrl(r.from);validateUrl(r.to);}if(v.httpStatus!==null)integer(v.httpStatus,999,"acquisition-contract.invalid-input");nonnegative(v.encodedBytes,"acquisition-contract.invalid-input");nonnegative(v.decodedBytes,"acquisition-contract.invalid-input");if(v.responsePayloadSha256!==null)hashValue(v.responsePayloadSha256,"acquisition-contract.invalid-key");if(v.responseHeadersSha256!==null)hashValue(v.responseHeadersSha256,"acquisition-contract.invalid-key");timestamp(v.retrievedAt,"acquisition-contract.invalid-input");
  if((outcome==="success"&&code!=="success")||(outcome==="blocked"&&code!=="sink-blocked")||(outcome==="cancelled"&&code!=="cancelled"&&code!=="deadline-exceeded")||(outcome==="failure"&&(code==="success"||code==="sink-blocked"||code==="cancelled"||code==="deadline-exceeded")))fail("acquisition-contract.invalid-input");
  if(outcome==="blocked"&&(v.finalUrl!==null||v.redirects.length!==0||v.httpStatus!==null||v.encodedBytes!==0||v.decodedBytes!==0||v.responsePayloadSha256!==null||v.responseHeadersSha256!==null))fail("acquisition-contract.invalid-input");
  return deepFreeze(v as unknown as AcquisitionTraceSettlement); }
function tracePreimage(value:Omit<AcquisitionTrace,"schemaVersion"|"traceKey"|"provenanceStatus">):unknown { return {schemaVersion:1,provider:value.provider,operation:value.operation,endpointClass:value.endpointClass,partitionKeySha256:value.partitionKeySha256,accessLevel:value.accessLevel,settlement:{outcome:value.settlement.outcome,code:value.settlement.code,requestedUrlSha256:value.settlement.requestedUrl.canonicalUrlSha256,finalUrlSha256:value.settlement.finalUrl?.canonicalUrlSha256??null,redirects:value.settlement.redirects.map((item)=>({ordinal:item.ordinal,status:item.status,fromUrlSha256:item.from.canonicalUrlSha256,toUrlSha256:item.to.canonicalUrlSha256})),httpStatus:value.settlement.httpStatus,encodedBytes:value.settlement.encodedBytes,decodedBytes:value.settlement.decodedBytes,responsePayloadSha256:value.settlement.responsePayloadSha256,responseHeadersSha256:value.settlement.responseHeadersSha256},warnings:value.warnings.map((item)=>({code:item.code,recordOrdinal:item.recordOrdinal,field:item.field}))}; }
export function createAcquisitionTrace(input:AcquisitionTraceInput):AcquisitionTrace { const data=snapshot<Record<string,unknown>>(input,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.result-too-large");if(Object.hasOwn(data,"provenanceStatus"))fail("acquisition-contract.invalid-provenance");const keys=["provider","operation","endpointClass","partitionKey","partitionKeySha256","accessLevel","settlement","warnings"];const v=requireClosed(data,keys,"acquisition-contract.invalid-input");const provider=oneOf(v.provider,PROVIDERS,"acquisition-contract.invalid-input");const operation=oneOf(v.operation,OPERATIONS,"acquisition-contract.invalid-input");const endpointClass=stringValue(v.endpointClass,"acquisition-contract.invalid-input")!;const partitionKey=keyValue(v.partitionKey,KEY_PARTITION,"acquisition-contract.invalid-key") as `partition-v1-${string}`;const partitionKeySha256=hashValue(v.partitionKeySha256,"acquisition-contract.invalid-key");if(partitionKey!==`partition-v1-${partitionKeySha256}`)fail("acquisition-contract.invalid-key");const accessLevel=v.accessLevel===null?null:oneOf(v.accessLevel,ACCESS,"acquisition-contract.invalid-input");const settlement=validateTraceSettlement(v.settlement);if(!Array.isArray(v.warnings))fail("acquisition-contract.invalid-input");const warnings=v.warnings.map((item)=>{const w=requireClosed(item,["code","recordOrdinal","field"],"acquisition-contract.invalid-input");return deepFreeze({code:oneOf(w.code,["provider.invalid-url-omitted","provider.invalid-identifier-omitted","provider.followup-unavailable"] as const,"acquisition-contract.invalid-input"),recordOrdinal:w.recordOrdinal===null?null:nonnegative(w.recordOrdinal,"acquisition-contract.invalid-input"),field:oneOf(w.field,["URL","primary_location.landing_page_url","doi","ids.doi","ids.pmid","ids.pmcid","elink"] as const,"acquisition-contract.invalid-input")});});const body={provider,operation,endpointClass,partitionKey,partitionKeySha256,accessLevel,settlement,warnings};const traceKey=prefixHash("trace-v1-",tracePreimage(body)) as `trace-v1-${string}`;return deepFreeze({schemaVersion:1,traceKey,provenanceStatus:"uncommitted" as const,...body}); }

function nullableIdentifier(value:unknown,kind:"doi"|"pmid"|"pmcid"):string|null { if(value===null)return null;if(typeof value!=="string")fail("acquisition-contract.invalid-input");try{const normalized=kind==="doi"?normalizeDoi(value):kind==="pmid"?normalizePmid(value):normalizePmcid(value);if(normalized!==value)fail("acquisition-contract.invalid-input");return normalized;}catch(error){if(error instanceof AcquisitionContractError)throw error;return fail("acquisition-contract.invalid-input");} }
function validateCandidateInput(input:unknown):Omit<AcademicCandidate,"schemaVersion"|"candidateKey"|"provenanceStatus"> { const allowed=["provider","endpointClass","providerRecordId","providerOrdinal","partitionKeySha256","responsePayloadSha256","traceKey","identifiers","canonicalUrl","title","authors","containerTitle","publisher","published","publicationType","accessLevel","abstractText"];const v=requireClosed(input,allowed,"acquisition-contract.invalid-input");const provider=oneOf(v.provider,PROVIDERS,"acquisition-contract.invalid-input");const endpointClass=stringValue(v.endpointClass,"acquisition-contract.invalid-input")!;const providerRecordId=stringValue(v.providerRecordId,"acquisition-contract.invalid-input",true);let providerOrdinal:number|null;if(v.providerOrdinal===null)providerOrdinal=null;else providerOrdinal=nonnegative(v.providerOrdinal,"acquisition-contract.invalid-input");if((providerRecordId===null)!==(providerOrdinal!==null))fail("acquisition-contract.invalid-input");const partitionKeySha256=hashValue(v.partitionKeySha256,"acquisition-contract.invalid-key");const responsePayloadSha256=hashValue(v.responsePayloadSha256,"acquisition-contract.invalid-key");const traceKey=keyValue(v.traceKey,KEY_TRACE,"acquisition-contract.invalid-key") as `trace-v1-${string}`;const ids=requireClosed(v.identifiers,["doi","pmid","pmcid"],"acquisition-contract.invalid-input");const identifiers=deepFreeze({doi:nullableIdentifier(ids.doi,"doi"),pmid:nullableIdentifier(ids.pmid,"pmid"),pmcid:nullableIdentifier(ids.pmcid,"pmcid")});let canonicalUrl:string|null;if(v.canonicalUrl===null)canonicalUrl=null;else try{canonicalUrl=normalizeCanonicalUrl(v.canonicalUrl);}catch{return fail("acquisition-contract.invalid-input");}const title=stringValue(v.title,"acquisition-contract.invalid-input",true);if(!Array.isArray(v.authors)||v.authors.length>1_024)fail("acquisition-contract.invalid-input");const authors=v.authors.map((item)=>{const a=requireClosed(item,["family","given","literal","orcid"],"acquisition-contract.invalid-input");return deepFreeze({family:stringValue(a.family,"acquisition-contract.invalid-input",true),given:stringValue(a.given,"acquisition-contract.invalid-input",true),literal:stringValue(a.literal,"acquisition-contract.invalid-input",true),orcid:stringValue(a.orcid,"acquisition-contract.invalid-input",true)});});const publishedData=requireClosed(v.published,["date","precision"],"acquisition-contract.invalid-input");const published=deepFreeze({date:stringValue(publishedData.date,"acquisition-contract.invalid-input",true),precision:oneOf(publishedData.precision,["day","month","year","unknown"] as const,"acquisition-contract.invalid-input")});return deepFreeze({provider,endpointClass,providerRecordId,providerOrdinal,partitionKeySha256,responsePayloadSha256,traceKey,identifiers,canonicalUrl,title,authors,containerTitle:stringValue(v.containerTitle,"acquisition-contract.invalid-input",true),publisher:stringValue(v.publisher,"acquisition-contract.invalid-input",true),published,publicationType:oneOf(v.publicationType,["journal-article","review","dataset","other"] as const,"acquisition-contract.invalid-input"),accessLevel:oneOf(v.accessLevel,ACCESS,"acquisition-contract.invalid-input"),abstractText:stringValue(v.abstractText,"acquisition-contract.invalid-input",true)}); }
export function createAcademicCandidate(input:AcademicCandidateInput):AcademicCandidate { const data=snapshot<Record<string,unknown>>(input,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.result-too-large");if(Object.hasOwn(data,"provenanceStatus"))fail("acquisition-contract.invalid-provenance");if(Object.hasOwn(data,"candidateKey")||Object.hasOwn(data,"schemaVersion"))fail("acquisition-contract.invalid-input");const body=validateCandidateInput(data);const preimage={schemaVersion:1,provider:body.provider,endpointClass:body.endpointClass,providerRecordId:body.providerRecordId,providerOrdinal:body.providerOrdinal,identifiers:body.identifiers,canonicalUrl:body.canonicalUrl,partitionKeySha256:body.partitionKeySha256,responsePayloadSha256:body.responsePayloadSha256};const candidateKey=prefixHash("candidate-v1-",preimage) as `candidate-v1-${string}`;return deepFreeze({schemaVersion:1,candidateKey,provenanceStatus:"uncommitted" as const,...body}); }
export function createAcademicDocument(input:AcademicDocumentInput):AcademicDocument { const data=snapshot<Record<string,unknown>>(input,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.result-too-large");if(Object.hasOwn(data,"provenanceStatus"))fail("acquisition-contract.invalid-provenance");if(Object.hasOwn(data,"documentKey")||Object.hasOwn(data,"schemaVersion"))fail("acquisition-contract.invalid-input");const v=requireClosed(data,["pmcid","candidateKey","partitionKeySha256","responsePayloadSha256","provider","traceKey","accessLevel","sections"],"acquisition-contract.invalid-input");let pmcid:string;try{pmcid=normalizePmcid(v.pmcid);if(pmcid!==v.pmcid)fail("acquisition-contract.invalid-input");}catch(error){if(error instanceof AcquisitionContractError)throw error;return fail("acquisition-contract.invalid-input");}const candidateKey=keyValue(v.candidateKey,KEY_CANDIDATE,"acquisition-contract.invalid-key") as `candidate-v1-${string}`;const partitionKeySha256=hashValue(v.partitionKeySha256,"acquisition-contract.invalid-key");const responsePayloadSha256=hashValue(v.responsePayloadSha256,"acquisition-contract.invalid-key");if(v.provider!=="pmc")fail("acquisition-contract.invalid-input");const traceKey=keyValue(v.traceKey,KEY_TRACE,"acquisition-contract.invalid-key") as `trace-v1-${string}`;const accessLevel=oneOf(v.accessLevel,ACCESS,"acquisition-contract.invalid-input");if(!Array.isArray(v.sections)||v.sections.length>20_000)fail("acquisition-contract.invalid-input");const sections=v.sections.map((item)=>{const section=requireClosed(item,["sectionType","text"],"acquisition-contract.invalid-input");return deepFreeze({sectionType:stringValue(section.sectionType,"acquisition-contract.invalid-input")!,text:stringValue(section.text,"acquisition-contract.invalid-input")!});});const preimage={schemaVersion:1,pmcid,candidateKey,partitionKeySha256,responsePayloadSha256};const documentKey=prefixHash("document-v1-",preimage) as `document-v1-${string}`;return deepFreeze({schemaVersion:1,documentKey,pmcid,candidateKey,partitionKeySha256,responsePayloadSha256,provenanceStatus:"uncommitted" as const,provider:"pmc" as const,traceKey,accessLevel,sections}); }

function rebuildTrace(value:unknown):AcquisitionTrace { const v=requireClosed(value,["schemaVersion","traceKey","provenanceStatus","provider","operation","endpointClass","partitionKey","partitionKeySha256","accessLevel","settlement","warnings"],"acquisition-contract.invalid-input");if(v.provenanceStatus!=="uncommitted")fail("acquisition-contract.invalid-provenance");const rebuilt=createAcquisitionTrace({provider:v.provider,operation:v.operation,endpointClass:v.endpointClass,partitionKey:v.partitionKey,partitionKeySha256:v.partitionKeySha256,accessLevel:v.accessLevel,settlement:v.settlement,warnings:v.warnings} as AcquisitionTraceInput);if(v.schemaVersion!==1||v.traceKey!==rebuilt.traceKey)fail("acquisition-contract.invalid-key");return rebuilt; }
function rebuildCandidate(value:unknown):AcademicCandidate { const v=requireClosed(value,["schemaVersion","candidateKey","provenanceStatus","provider","endpointClass","providerRecordId","providerOrdinal","partitionKeySha256","responsePayloadSha256","traceKey","identifiers","canonicalUrl","title","authors","containerTitle","publisher","published","publicationType","accessLevel","abstractText"],"acquisition-contract.invalid-input");if(v.provenanceStatus!=="uncommitted")fail("acquisition-contract.invalid-provenance");const input={...v};delete input.schemaVersion;delete input.candidateKey;delete input.provenanceStatus;const rebuilt=createAcademicCandidate(input as unknown as AcademicCandidateInput);if(v.schemaVersion!==1||v.candidateKey!==rebuilt.candidateKey)fail("acquisition-contract.invalid-key");return rebuilt; }
function rebuildDocument(value:unknown):AcademicDocument { const v=requireClosed(value,["schemaVersion","documentKey","pmcid","candidateKey","partitionKeySha256","responsePayloadSha256","provenanceStatus","provider","traceKey","accessLevel","sections"],"acquisition-contract.invalid-input");if(v.provenanceStatus!=="uncommitted")fail("acquisition-contract.invalid-provenance");const input={...v};delete input.schemaVersion;delete input.documentKey;delete input.provenanceStatus;const rebuilt=createAcademicDocument(input as unknown as AcademicDocumentInput);if(v.schemaVersion!==1||v.documentKey!==rebuilt.documentKey)fail("acquisition-contract.invalid-key");return rebuilt; }
function rebuildGroup(value:unknown,candidates:Set<string>):AcademicCandidateGroup { const v=requireClosed(value,["groupKey","identityKind","identityValueSha256","status","candidateKeys"],"acquisition-contract.invalid-input");const identityKind=oneOf(v.identityKind,["doi","pmid","pmcid","canonical-url","provider-result"] as const,"acquisition-contract.invalid-input");const identityValueSha256=hashValue(v.identityValueSha256,"acquisition-contract.invalid-key");const status=oneOf(v.status,["compatible","ambiguous"] as const,"acquisition-contract.invalid-input");if(!Array.isArray(v.candidateKeys)||v.candidateKeys.length===0)fail("acquisition-contract.invalid-input");const candidateKeys=v.candidateKeys.map((item)=>keyValue(item,KEY_CANDIDATE,"acquisition-contract.invalid-key") as `candidate-v1-${string}`);if(new Set(candidateKeys).size!==candidateKeys.length||candidateKeys.some((key)=>!candidates.has(key)))fail("acquisition-contract.invalid-key");const sorted=[...candidateKeys].sort();if(canonicalJson(sorted)!==canonicalJson(candidateKeys))fail("acquisition-contract.invalid-key");const groupKey=prefixHash("candidate-group-v1-",{schemaVersion:1,identityKind,identityValueSha256,sortedCandidateKeys:sorted,status}) as `candidate-group-v1-${string}`;if(v.groupKey!==groupKey)fail("acquisition-contract.invalid-key");return deepFreeze({groupKey,identityKind,identityValueSha256,status,candidateKeys}); }
export function validateAcademicAcquisitionResult(input:unknown):AcademicAcquisitionResult { const data=snapshot<Record<string,unknown>>(input,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.result-too-large");const v=requireClosed(data,["schemaVersion","provenanceStatus","status","normalizedQueries","partitions","candidates","candidateGroups","documents","traces","failures","optionsSha256"],"acquisition-contract.invalid-input");if(v.schemaVersion!==1)fail("acquisition-contract.invalid-input");if(v.provenanceStatus!=="uncommitted")fail("acquisition-contract.invalid-provenance");const status=oneOf(v.status,["complete","partial"] as const,"acquisition-contract.invalid-input");if(!Array.isArray(v.normalizedQueries))fail("acquisition-contract.invalid-input");const normalizedQueries=v.normalizedQueries.map((item)=>stringValue(item,"acquisition-contract.invalid-input")!);const p=requireClosed(v.partitions,["requested","dispatched","succeeded","failed","blocked"],"acquisition-contract.invalid-input");const partitions={requested:nonnegative(p.requested,"acquisition-contract.invalid-input"),dispatched:nonnegative(p.dispatched,"acquisition-contract.invalid-input"),succeeded:nonnegative(p.succeeded,"acquisition-contract.invalid-input"),failed:nonnegative(p.failed,"acquisition-contract.invalid-input"),blocked:nonnegative(p.blocked,"acquisition-contract.invalid-input")};if(checkedAdd(partitions.dispatched,partitions.blocked,"acquisition-contract.invalid-input")!==partitions.requested||partitions.blocked>partitions.failed||checkedAdd(partitions.succeeded,partitions.failed-partitions.blocked,"acquisition-contract.invalid-input")!==partitions.dispatched)fail("acquisition-contract.invalid-input");if(!Array.isArray(v.traces)||!Array.isArray(v.candidates)||!Array.isArray(v.documents)||!Array.isArray(v.candidateGroups)||!Array.isArray(v.failures))fail("acquisition-contract.invalid-input");const traces=v.traces.map(rebuildTrace);const traceMap=new Map(traces.map((item)=>[item.traceKey,item]));if(traceMap.size!==traces.length)fail("acquisition-contract.invalid-key");const candidates=v.candidates.map(rebuildCandidate);const candidateMap=new Map(candidates.map((item)=>[item.candidateKey,item]));if(candidateMap.size!==candidates.length)fail("acquisition-contract.invalid-key");for(const item of candidates){const t=traceMap.get(item.traceKey);if(!t||t.partitionKeySha256!==item.partitionKeySha256||t.provider!==item.provider||t.endpointClass!==item.endpointClass||t.settlement.responsePayloadSha256!==item.responsePayloadSha256)fail("acquisition-contract.invalid-key");}const documents=v.documents.map(rebuildDocument);const documentMap=new Map(documents.map((item)=>[item.documentKey,item]));if(documentMap.size!==documents.length)fail("acquisition-contract.invalid-key");for(const item of documents){const c=candidateMap.get(item.candidateKey);const t=traceMap.get(item.traceKey);if(!c||!t||t.partitionKeySha256!==item.partitionKeySha256||t.settlement.responsePayloadSha256!==item.responsePayloadSha256)fail("acquisition-contract.invalid-key");}const candidateGroups=v.candidateGroups.map((item)=>rebuildGroup(item,new Set(candidateMap.keys())));const groupKeys=new Set(candidateGroups.map((item)=>item.groupKey));if(groupKeys.size!==candidateGroups.length)fail("acquisition-contract.invalid-key");const groupedKeys=candidateGroups.flatMap((item)=>item.candidateKeys);if(groupedKeys.length!==candidateMap.size||new Set(groupedKeys).size!==groupedKeys.length||groupedKeys.some((key)=>!candidateMap.has(key)))fail("acquisition-contract.invalid-key");const failures=v.failures.map((item)=>{const f=requireClosed(item,["provider","operation","partitionKey","partitionKeySha256","code","retryable"],"acquisition-contract.invalid-input");const partitionKey=keyValue(f.partitionKey,KEY_PARTITION,"acquisition-contract.invalid-key");const partitionKeySha256=hashValue(f.partitionKeySha256,"acquisition-contract.invalid-key");if(partitionKey!==`partition-v1-${partitionKeySha256}`)fail("acquisition-contract.invalid-key");if(typeof f.retryable!=="boolean")fail("acquisition-contract.invalid-input");return deepFreeze({provider:oneOf(f.provider,PROVIDERS,"acquisition-contract.invalid-input"),operation:oneOf(f.operation,OPERATIONS,"acquisition-contract.invalid-input"),partitionKey:partitionKey as `partition-v1-${string}`,partitionKeySha256,code:oneOf(f.code,["provider.retryable","provider.terminal","provider.invalid-response","provider.unsupported","sink.failed"] as const,"acquisition-contract.invalid-input"),retryable:f.retryable});});const complete=partitions.failed===0&&failures.length===0;if((status==="complete")!==complete)fail("acquisition-contract.invalid-input");const optionsSha256=hashValue(v.optionsSha256,"acquisition-contract.invalid-key");return deepFreeze({schemaVersion:1,provenanceStatus:"uncommitted" as const,status,normalizedQueries,partitions,candidates,candidateGroups,documents,traces,failures,optionsSha256}); }

function capabilityDescriptor(value:unknown):AcquisitionProvenanceSinkDescriptor { if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail("acquisition-contract.invalid-capability");const descriptors=Object.getOwnPropertyDescriptors(value);const keys=Reflect.ownKeys(descriptors);if(keys.length!==2||!keys.includes("beforeDispatch")||!keys.includes("settled"))fail("acquisition-contract.invalid-capability");for(const key of ["beforeDispatch","settled"]){const descriptor=descriptors[key];if(!descriptor||!("value"in descriptor)||!descriptor.enumerable||typeof descriptor.value!=="function")fail("acquisition-contract.invalid-capability");}return {beforeDispatch:descriptors.beforeDispatch!.value as AcquisitionProvenanceSinkDescriptor["beforeDispatch"],settled:descriptors.settled!.value as AcquisitionProvenanceSinkDescriptor["settled"]}; }
function genuineSignal(value:unknown):asserts value is AbortSignal { if(value===null||typeof value!=="object")fail("acquisition-contract.invalid-capability");try{const getter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")?.get;if(!getter)fail("acquisition-contract.invalid-capability");getter.call(value);AbortSignal.prototype.throwIfAborted.call(value);}catch(error){try{const getter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!;if(getter.call(value)===true)return;}catch{}if(error instanceof AcquisitionContractError)throw error;fail("acquisition-contract.invalid-capability");} }
export function createAcquisitionProvenanceSinkInternal(descriptor:AcquisitionProvenanceSinkDescriptor):AcquisitionProvenanceSink { const safe=capabilityDescriptor(descriptor);const sink=Object.freeze({capabilityKind:"acquisition-provenance-sink" as const});sinkRegistry.set(sink,safe);return sink; }
function sinkDescriptor(sink:unknown):AcquisitionProvenanceSinkDescriptor { if(sink===null||typeof sink!=="object"||utilTypes.isProxy(sink))fail("acquisition-contract.invalid-capability");const descriptor=sinkRegistry.get(sink);if(!descriptor||!Object.isFrozen(sink)||(sink as AcquisitionProvenanceSink).capabilityKind!=="acquisition-provenance-sink")fail("acquisition-contract.invalid-capability");return descriptor; }
export async function acquisitionSinkBeforeDispatchInternal(sink:AcquisitionProvenanceSink,intent:Parameters<AcquisitionProvenanceSinkDescriptor["beforeDispatch"]>[0],signal:AbortSignal):Promise<AcquisitionProvenanceHandle> { const descriptor=sinkDescriptor(sink);genuineSignal(signal);const data=snapshot<Record<string,unknown>>(intent,PUBLIC_STRUCTURE,"acquisition-contract.invalid-input","acquisition-contract.input-too-large");const v=requireClosed(data,["partitionKey","partitionKeySha256","provider","operation","endpointClass","normalizedInputSha256","requestedUrl"],"acquisition-contract.invalid-input");keyValue(v.partitionKey,KEY_PARTITION,"acquisition-contract.invalid-key");hashValue(v.partitionKeySha256,"acquisition-contract.invalid-key");if(v.partitionKey!==`partition-v1-${v.partitionKeySha256}`)fail("acquisition-contract.invalid-key");oneOf(v.provider,PROVIDERS,"acquisition-contract.invalid-input");oneOf(v.operation,OPERATIONS,"acquisition-contract.invalid-input");stringValue(v.endpointClass,"acquisition-contract.invalid-input");hashValue(v.normalizedInputSha256,"acquisition-contract.invalid-key");stringValue(v.requestedUrl,"acquisition-contract.invalid-input");const raw=await descriptor.beforeDispatch(frozenCopy(data) as Parameters<AcquisitionProvenanceSinkDescriptor["beforeDispatch"]>[0],signal);const handleData=snapshot<Record<string,unknown>>(raw,PUBLIC_STRUCTURE,"acquisition-contract.invalid-capability","acquisition-contract.invalid-capability");const h=requireClosed(handleData,["correlationKey"],"acquisition-contract.invalid-capability");const handle=deepFreeze({correlationKey:stringValue(h.correlationKey,"acquisition-contract.invalid-capability")!});sinkHandleRegistry.set(handle,{sink,handle});return handle; }
export async function acquisitionSinkSettledInternal(sink:AcquisitionProvenanceSink,handle:AcquisitionProvenanceHandle,settlement:TransportSettlement,signal:AbortSignal):Promise<void> { const descriptor=sinkDescriptor(sink);genuineSignal(signal);if(handle===null||typeof handle!=="object"||sinkHandleRegistry.get(handle as object)?.sink!==sink)fail("acquisition-contract.invalid-capability");const safeSettlement=validateSettlement(settlement);await descriptor.settled(handle,safeSettlement,signal);sinkHandleRegistry.delete(handle as object); }
