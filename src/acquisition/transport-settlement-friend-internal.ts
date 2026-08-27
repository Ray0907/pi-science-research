import {types as utilTypes} from "node:util";

import {
  acquisitionTraceSettlementInternal,
  assertProviderRequestPartitionInternal,
  lookupProviderRequestPartitionInternal,
  type AcquisitionOperation,
  type AcquisitionProvider,
  type AcquisitionTraceProjectionLimitsInternal,
  type AcquisitionTraceSettlement,
  type ProviderRequestPartitionInternal,
  type TransportSettlement,
} from "./contracts.js";

export type TransportSettlementPartitionStatusInternal="match"|"foreign"|"invalid";
type RawBinding=Readonly<{partitionKey:`partition-v1-${string}`;partitionKeySha256:string;provider:AcquisitionProvider;operation:AcquisitionOperation;endpointClass:string;requestedUrl:string}>;
const settlements=new WeakMap<object,RawBinding>();
const SHA=/^[a-f0-9]{64}$/u,KEY=/^partition-v1-[a-f0-9]{64}$/u,SETTLEMENT_KEYS=["schemaVersion","partitionKey","partitionKeySha256","provider","operation","endpointClass","normalizedOrigin","requestedUrl","finalUrl","redirectWitnesses","httpStatus","encodedBytes","decodedBytes","responsePayloadSha256","responseHeaders","responseHeadersSha256","connectedPeer","startedAt","settledAt","outcome","failureCode","payloadUtf8"] as const;
function invalid():never{throw new Error("transport settlement friend rejected");}
function dataDescriptor(descriptors:PropertyDescriptorMap,key:string):unknown{const descriptor=descriptors[key];if(!descriptor||!descriptor.enumerable||!("value" in descriptor))invalid();return descriptor.value;}

/** @internal Publisher callable only by the two audited transport producers. */
export function publishTransportSettlementInternal<T extends TransportSettlement>(settlement:T):T{
  if(settlement===null||typeof settlement!=="object"||utilTypes.isProxy(settlement)||Object.getPrototypeOf(settlement)!==Object.prototype)invalid();const keys=Reflect.ownKeys(settlement);if(keys.length>SETTLEMENT_KEYS.length||keys.length!==SETTLEMENT_KEYS.length||keys.some(key=>typeof key!=="string"||!SETTLEMENT_KEYS.includes(key as never)))invalid();
  const descriptors=Object.getOwnPropertyDescriptors(settlement),stack:object[]=[settlement],seen=new WeakSet<object>();
  while(stack.length){const current=stack.pop()!;if(utilTypes.isProxy(current)||!Object.isFrozen(current)||seen.has(current))invalid();seen.add(current);const currentDescriptors=current===settlement?descriptors:Object.getOwnPropertyDescriptors(current);for(const descriptor of Object.values(currentDescriptors)){if(!("value" in descriptor))invalid();const child=descriptor.value;if(child!==null&&typeof child==="object")stack.push(child as object);}}
  const partitionKey=dataDescriptor(descriptors,"partitionKey"),partitionKeySha256=dataDescriptor(descriptors,"partitionKeySha256"),provider=dataDescriptor(descriptors,"provider"),operation=dataDescriptor(descriptors,"operation"),endpointClass=dataDescriptor(descriptors,"endpointClass"),requestedUrl=dataDescriptor(descriptors,"requestedUrl");
  if(typeof partitionKey!=="string"||!KEY.test(partitionKey)||typeof partitionKeySha256!=="string"||!SHA.test(partitionKeySha256)||partitionKey!==`partition-v1-${partitionKeySha256}`||!(["crossref","openalex","pubmed","pmc"] as const).includes(provider as never)||!(["search","fetch"] as const).includes(operation as never)||typeof endpointClass!=="string"||typeof requestedUrl!=="string")invalid();
  settlements.set(settlement,Object.freeze({partitionKey:partitionKey as `partition-v1-${string}`,partitionKeySha256,provider:provider as AcquisitionProvider,operation:operation as AcquisitionOperation,endpointClass,requestedUrl}));return settlement;
}

/** @internal O(1) scheduler classifier; reads only the private publication sidecar. */
export function classifyTransportSettlementForPartitionInternal(settlement:unknown,partition:ProviderRequestPartitionInternal):TransportSettlementPartitionStatusInternal{
  assertProviderRequestPartitionInternal(partition);if(settlement===null||typeof settlement!=="object"||utilTypes.isProxy(settlement)||!Object.isFrozen(settlement))return"invalid";const binding=settlements.get(settlement as object);if(!binding)return"invalid";const snapshot=lookupProviderRequestPartitionInternal(partition);return binding.partitionKey===snapshot.partitionKey&&binding.partitionKeySha256===snapshot.partitionKeySha256&&binding.provider===snapshot.provider&&binding.operation===snapshot.operation&&binding.endpointClass===snapshot.endpointClass&&binding.requestedUrl===snapshot.url?"match":"foreign";
}

/** @internal Scheduler consumer; authenticates the retained raw identity and full trace contract. */
export function assertTransportSettlementForPartitionInternal(settlement:TransportSettlement,partition:ProviderRequestPartitionInternal,limits:AcquisitionTraceProjectionLimitsInternal):AcquisitionTraceSettlement{
  if(classifyTransportSettlementForPartitionInternal(settlement,partition)!=="match")invalid();return acquisitionTraceSettlementInternal(settlement,limits);
}
