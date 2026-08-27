import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import { performance as nodePerformance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";

import type { ConnectedPeer } from "./contracts.js";
import { NetworkPolicyError, createAcquisitionDnsResolver, resolveAllSafeProviderAddressesInternal, validateFixedProviderUrl, type AcquisitionDnsResolver, type AcquisitionNetworkTarget, type NetworkPolicyOptions, type ValidatedProviderUrl } from "./network-policy.js";
import { RequestDeadlineErrorInternal, assertRequestDeadlineInternal, type RequestDeadlineInternal } from "./request-deadline-internal.js";

export type SecureTransportErrorCode="transport.invalid-options"|"transport.invalid-input"|"transport.invalid-capability"|"transport.unsupported-runtime"|"transport.closed";
export class SecureTransportError extends Error { readonly code:SecureTransportErrorCode;constructor(code:SecureTransportErrorCode){super(`Secure transport rejected (${code})`);this.name="SecureTransportError";this.code=code;} }
export interface NodeClockInternal { readonly monotonicNow:()=>number;readonly timestampNow:()=>string;readonly setTimer:(callback:()=>void,milliseconds:number)=>unknown;readonly clearTimer:(handle:unknown)=>void; }
export interface NodeResolverInternal { readonly resolve4:(hostname:string)=>Promise<readonly string[]>;readonly resolve6:(hostname:string)=>Promise<readonly string[]>;readonly cancel:()=>void;readonly destroy:()=>void; }
export interface NodeRequestOwnedAgentInternal { readonly protocol:"http:"|"https:";readonly keepAlive:false;readonly maxSockets:1;readonly maxFreeSockets:0;readonly destroy:()=>void; }
export type NodeHopProtocolFailureInternal="header-overflow"|"unexpected-content-length"|"invalid-header-token"|"invalid-chunk"|"invalid-version"|"invalid-status"|"invalid-protocol";
export interface NodeRequestCallbacksInternal { readonly onSecureConnected:(tls:Readonly<{address:string|undefined;family:string|number|undefined;hostnameVerified:boolean;authorized:boolean;authorizationError:Error|null;}>)=>void;readonly onProtocolFailure:(code:NodeHopProtocolFailureInternal)=>void;readonly onResponse:(statusCode:number,httpVersion:string,rawHeaders:readonly string[])=>void;readonly onData:(chunk:Uint8Array)=>"continue"|"abort";readonly onEnd:()=>void;readonly onError:(kind:"connect"|"tls"|"socket")=>void; }
export interface NodeRequestHandleInternal { readonly end:()=>void;readonly abort:()=>void;readonly destroy:()=>void; }
export interface NodeRequestOptionsInternal { readonly url:string;readonly pinnedAddress:string;readonly family:4|6;readonly hostHeader:string;readonly servername:string;readonly headers:readonly Readonly<{name:string;value:string}>[];readonly agent:NodeRequestOwnedAgentInternal;readonly ca:readonly string[];readonly rejectUnauthorized:true;readonly maxHeaderSize:number;readonly insecureHTTPParser:false;readonly joinDuplicateHeaders:false;readonly checkServerIdentity:(hostname:string,certificate:object)=>Error|undefined; }
export interface NodeOperationsInternal { readonly createResolver:()=>NodeResolverInternal;readonly createRequestOwnedAgent:(protocol:"http:"|"https:")=>NodeRequestOwnedAgentInternal;readonly httpRequest:(options:NodeRequestOptionsInternal,callbacks:NodeRequestCallbacksInternal)=>NodeRequestHandleInternal;readonly httpsRequest:(options:NodeRequestOptionsInternal,callbacks:NodeRequestCallbacksInternal)=>NodeRequestHandleInternal;readonly bundledRootCertificates:readonly string[];readonly checkServerIdentity:(hostname:string,certificate:object)=>Error|undefined;readonly clock:NodeClockInternal; }
export interface NodeRuntimeCapabilitiesInternal { readonly capabilityKind:"node-runtime-capabilities"; }
export interface NodePinnedHopCallbacksInternal extends NodeRequestCallbacksInternal {}
export type NodePinnedHopFailureCodeInternal="hop.connect-timeout"|"hop.connect-failed"|"hop.tls-failed"|"hop.peer-unavailable"|"hop.peer-mismatch"|"hop.protocol-failed";
export type NodePinnedHopSettlementInternal=Readonly<{outcome:"ended";failureCode:null;peer:ConnectedPeer;startedAt:string;settledAt:string}>|Readonly<{outcome:"failed";failureCode:NodePinnedHopFailureCodeInternal;peer:ConnectedPeer|null;startedAt:string;settledAt:string}>|Readonly<{outcome:"cancelled";failureCode:"hop.cancelled"|"hop.deadline";peer:ConnectedPeer|null;startedAt:string;settledAt:string}>;
export interface NodePinnedHopHandleInternal { readonly ownerId:`hop-owner-v1-${string}`;readonly completion:Promise<NodePinnedHopSettlementInternal>;abort():void;close():Promise<void>;forceClose():void; }
export type PinnedHopRuntimeErrorCodeInternal="pinned-runtime.invalid-input"|"pinned-runtime.invalid-capability"|"pinned-runtime.target-mismatch"|"pinned-runtime.pin-replayed"|"pinned-runtime.pin-stale"|"pinned-runtime.closed";
export class PinnedHopRuntimeErrorInternal extends Error { readonly code:PinnedHopRuntimeErrorCodeInternal;constructor(code:PinnedHopRuntimeErrorCodeInternal){super(`Pinned hop runtime rejected (${code})`);this.name="PinnedHopRuntimeErrorInternal";this.code=code;} }
export interface PinnedProviderTargetInternal { readonly capabilityKind:"pinned-provider-target";readonly target:AcquisitionNetworkTarget;readonly url:string;readonly origin:string;readonly hostname:string;readonly port:443;readonly hostHeader:string;readonly address:string;readonly family:4|6;readonly allAddressesSha256:string; }
export interface PinnedHopOpenRequestInternal { readonly ownerId:`hop-owner-v1-${string}`;readonly url:string;readonly headers:readonly Readonly<{name:string;value:string}>[];readonly maxHeaderSize:number;readonly connectTimeoutMs:number; }
export interface PinnedHopRuntimeInternal { readonly capabilityKind:"pinned-hop-runtime";resolveProviderTarget(url:unknown,deadline:RequestDeadlineInternal):Promise<PinnedProviderTargetInternal>;openPinnedHop(target:PinnedProviderTargetInternal,request:PinnedHopOpenRequestInternal,callbacks:NodePinnedHopCallbacksInternal,deadline:RequestDeadlineInternal):NodePinnedHopHandleInternal;close():Promise<void>; }

type RuntimeState={readonly ops:NodeOperationsInternal;open:boolean;readonly usedResolvers:WeakSet<object>;readonly usedAgents:WeakSet<object>;readonly usedRequests:WeakSet<object>};
type DnsOperation={readonly resolver:NodeResolverInternal;gate:boolean;cleaned:boolean;cancelled:boolean;reject:(error:Error)=>void};
type DnsState={readonly runtime:NodeRuntimeCapabilitiesInternal;readonly active:Set<DnsOperation>;open:boolean};
type PinState={readonly runtime:PinnedHopRuntimeInternal;readonly deadline:RequestDeadlineInternal;state:"resolved"|"consumed"|"stale"};
type HopState={gate:boolean;settled:boolean;request:NodeRequestHandleInternal|null;agent:NodeRequestOwnedAgentInternal|null;timer:unknown;deadline:RequestDeadlineInternal;deadlineListener:()=>void;resolve:(value:NodePinnedHopSettlementInternal)=>void;startedAt:string;startEpochMs:number;startMonotonic:number;lastSafeMonotonic:number;peer:ConnectedPeer|null;callbacks:NodePinnedHopCallbacksInternal;ops:NodeOperationsInternal;};
type PinnedRuntimeState={readonly node:NodeRuntimeCapabilitiesInternal;readonly ops:NodeOperationsInternal;readonly options:NetworkPolicyOptions|undefined;readonly dns:AcquisitionDnsResolver;open:boolean;readonly pins:Set<PinnedProviderTargetInternal>;readonly handles:Set<NodePinnedHopHandleInternal>;readonly owners:Set<string>};
const usedResolversGlobal=new WeakSet<object>();const usedAgentsGlobal=new WeakSet<object>();const usedRequestsGlobal=new WeakSet<object>();const runtimeStates=new WeakMap<object,RuntimeState>();const realAgents=new WeakMap<object,http.Agent|https.Agent>();const dnsStates=new WeakMap<object,DnsState>();const pinStates=new WeakMap<object,PinState>();const pinnedRuntimeStates=new WeakMap<object,PinnedRuntimeState>();const hopStates=new WeakMap<object,HopState>();
const ADD_EVENT=EventTarget.prototype.addEventListener;const REMOVE_EVENT=EventTarget.prototype.removeEventListener;const ABORTED_GETTER=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!;
function transportFail(code:SecureTransportErrorCode):never{throw new SecureTransportError(code);}function pinnedFail(code:PinnedHopRuntimeErrorCodeInternal):never{throw new PinnedHopRuntimeErrorInternal(code);}
function descriptors(value:unknown,keys:readonly string[],kind:"transport"|"pinned"):PropertyDescriptorMap{const fail=()=>kind==="transport"?transportFail("transport.invalid-capability"):pinnedFail("pinned-runtime.invalid-input");if(value===null||typeof value!=="object"||utilTypes.isProxy(value))return fail();const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return fail();let result:PropertyDescriptorMap;try{result=Object.getOwnPropertyDescriptors(value);}catch{return fail();}const own=Reflect.ownKeys(result);if(own.some((key)=>typeof key!=="string"||!keys.includes(key))||own.length!==keys.length)return fail();for(const key of keys){const item=result[key];if(!item||!("value" in item)||!item.enumerable)return fail();}return result;}
function exactFunctions(value:unknown,keys:readonly string[]):PropertyDescriptorMap{const result=descriptors(value,keys,"transport");for(const key of keys)if(typeof result[key]!.value!=="function")transportFail("transport.invalid-capability");return result;}
function runtimeState(value:unknown):RuntimeState{if(value===null||typeof value!=="object"||utilTypes.isProxy(value))transportFail("transport.invalid-capability");const state=runtimeStates.get(value);if(!state||!Object.isFrozen(value)||(value as NodeRuntimeCapabilitiesInternal).capabilityKind!=="node-runtime-capabilities")transportFail("transport.invalid-capability");return state;}
function validateRoots(value:unknown):readonly string[]{
  if(!Array.isArray(value)||utilTypes.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||!Object.isFrozen(value))transportFail("transport.invalid-capability");
  const lengthDescriptor=Object.getOwnPropertyDescriptor(value,"length");
  const length=lengthDescriptor&&"value" in lengthDescriptor?lengthDescriptor.value:undefined;
  if(!Number.isSafeInteger(length)||length<1||length>1_024)transportFail("transport.invalid-capability");
  const all=Object.getOwnPropertyDescriptors(value as object) as PropertyDescriptorMap;
  if(Reflect.ownKeys(all).length!==length+1)transportFail("transport.invalid-capability");
  let aggregateBytes=0;
  for(let index=0;index<length;index+=1){
    const item=all[String(index)];
    if(!item||!("value" in item)||typeof item.value!=="string"||!item.enumerable||!hasWellFormedUtf16(item.value))transportFail("transport.invalid-capability");
    const bytes=Buffer.byteLength(item.value,"utf8");aggregateBytes+=bytes;
    if(bytes>1_048_576||!Number.isSafeInteger(aggregateBytes)||aggregateBytes>67_108_864)transportFail("transport.invalid-capability");
  }
  return value as readonly string[];
}
function validateResolver(value:unknown,state:RuntimeState):NodeResolverInternal{const d=exactFunctions(value,["resolve4","resolve6","cancel","destroy"]);if(state.usedResolvers.has(value as object))transportFail("transport.invalid-capability");state.usedResolvers.add(value as object);return Object.freeze({resolve4:d.resolve4!.value,resolve6:d.resolve6!.value,cancel:d.cancel!.value,destroy:d.destroy!.value});}
function validateAgent(value:unknown,protocol:"http:"|"https:",state:RuntimeState):NodeRequestOwnedAgentInternal{if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||state.usedAgents.has(value))transportFail("transport.invalid-capability");const d=descriptors(value,["protocol","keepAlive","maxSockets","maxFreeSockets","destroy"],"transport");if(d.protocol!.value!==protocol||d.keepAlive!.value!==false||d.maxSockets!.value!==1||d.maxFreeSockets!.value!==0||typeof d.destroy!.value!=="function")transportFail("transport.invalid-capability");state.usedAgents.add(value);return value as NodeRequestOwnedAgentInternal;}
function validateRequestHandle(value:unknown,state:RuntimeState):NodeRequestHandleInternal{const d=exactFunctions(value,["end","abort","destroy"]);if(state.usedRequests.has(value as object))transportFail("transport.invalid-capability");state.usedRequests.add(value as object);return{end:d.end!.value,abort:d.abort!.value,destroy:d.destroy!.value};}

function adapterErrorCode(value:unknown):string{
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value))return"";
  const descriptor=Object.getOwnPropertyDescriptor(value,"code");
  return descriptor&&"value" in descriptor&&typeof descriptor.value==="string"?descriptor.value:"";
}
function parserFailureFor(code:string):NodeHopProtocolFailureInternal|null{
  if(code==="HPE_HEADER_OVERFLOW")return"header-overflow";
  if(["HPE_UNEXPECTED_CONTENT_LENGTH","HPE_INVALID_CONTENT_LENGTH","HPE_INVALID_TRANSFER_ENCODING"].includes(code))return"unexpected-content-length";
  if(code==="HPE_INVALID_HEADER_TOKEN")return"invalid-header-token";
  if(code==="HPE_INVALID_CHUNK_SIZE")return"invalid-chunk";
  if(code==="HPE_INVALID_VERSION")return"invalid-version";
  if(code==="HPE_INVALID_STATUS")return"invalid-status";
  return code.startsWith("HPE_")?"invalid-protocol":null;
}
function isTlsErrorCode(code:string):boolean{
  return code.startsWith("ERR_TLS_")||code.startsWith("ERR_SSL_")||code.startsWith("ERR_OSSL_")||code.startsWith("CERT_")||[
    "DEPTH_ZERO_SELF_SIGNED_CERT","SELF_SIGNED_CERT_IN_CHAIN","UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT","UNABLE_TO_GET_ISSUER_CERT_LOCALLY","EPROTO",
  ].includes(code);
}
function adaptNodeRequest(protocol:"http:"|"https:",options:NodeRequestOptionsInternal,callbacks:NodeRequestCallbacksInternal):NodeRequestHandleInternal{
  const module=protocol==="https:"?https:http;
  let lookupUsed=false;
  let phase:"connect"|"tls"|"secure"="connect";
  let callbackGate=true;
  let destroyed=false;
  let request!:http.ClientRequest;
  const destroyOnce=()=>{if(destroyed)return;destroyed=true;request.destroy();};
  const requestOptions={
    agent:(realAgents.get(options.agent as object)??options.agent) as never,
    headers:[...options.headers.map(({name,value})=>[name,value] as const),["Host",options.hostHeader] as const],
    setHost:false,
    servername:options.servername,
    ca:options.ca,
    rejectUnauthorized:options.rejectUnauthorized,
    maxHeaderSize:options.maxHeaderSize,
    insecureHTTPParser:options.insecureHTTPParser,
    joinDuplicateHeaders:options.joinDuplicateHeaders,
    lookup:(_hostname:string,_opts:unknown,callback:(error:Error|null,address:string,family:number)=>void)=>{
      if(lookupUsed){callback(new Error("Pinned lookup replayed"),"",options.family);return;}
      lookupUsed=true;callback(null,options.pinnedAddress,options.family);
    },
    checkServerIdentity:options.checkServerIdentity,
  };
  request=module.request(options.url,requestOptions as never,(response)=>{
    if(!callbackGate)return;
    if(protocol==="http:")phase="secure";
    callbacks.onResponse(response.statusCode??0,response.httpVersion,response.rawHeaders);
    if(destroyed){callbackGate=false;return;}
    response.on("data",(chunk:Buffer)=>{
      if(!callbackGate)return;
      if(callbacks.onData(new Uint8Array(chunk))==="abort"){callbackGate=false;callbacks.onError("socket");destroyOnce();}
    });
    response.on("end",()=>{if(!callbackGate)return;callbackGate=false;callbacks.onEnd();});
  });
  request.on("socket",(socket)=>{
    if(protocol!=="https:")return;
    socket.once("connect",()=>{if(callbackGate&&phase==="connect")phase="tls";});
    socket.once("secureConnect",()=>{
      if(!callbackGate||phase==="secure")return;
      phase="secure";
      const secure=socket as tls.TLSSocket;
      let verified=false;
      try{verified=options.checkServerIdentity(options.servername,secure.getPeerCertificate())===undefined;}catch{verified=false;}
      callbacks.onSecureConnected({
        address:secure.remoteAddress,
        family:secure.remoteFamily,
        hostnameVerified:verified,
        authorized:secure.authorized,
        authorizationError:secure.authorizationError==null?null:secure.authorizationError instanceof Error?secure.authorizationError:new Error("TLS authorization failed"),
      });
      if(destroyed)callbackGate=false;
    });
  });
  request.on("error",(error)=>{
    if(!callbackGate)return;
    callbackGate=false;
    const code=adapterErrorCode(error);
    const parserFailure=parserFailureFor(code);
    if(parserFailure!==null){callbacks.onProtocolFailure(parserFailure);return;}
    callbacks.onError(phase==="secure"?"socket":protocol==="https:"&&(phase==="tls"||isTlsErrorCode(code))?"tls":"connect");
  });
  return{end:()=>request.end(),abort:destroyOnce,destroy:destroyOnce};
}
// Sole built-in adapter. Construction is lazy: Resolver/Agent/request/timers are created only by methods.
export const realNodeOperations:NodeOperationsInternal=Object.freeze<NodeOperationsInternal>({createResolver:()=>{const resolver=new Resolver();return{resolve4:(hostname)=>resolver.resolve4(hostname),resolve6:(hostname)=>resolver.resolve6(hostname),cancel:()=>resolver.cancel(),destroy:()=>undefined};},createRequestOwnedAgent:(protocol)=>{const agent=protocol==="https:"?new https.Agent({keepAlive:false,maxSockets:1,maxFreeSockets:0}):new http.Agent({keepAlive:false,maxSockets:1,maxFreeSockets:0});const wrapper=Object.freeze({protocol,keepAlive:false as const,maxSockets:1 as const,maxFreeSockets:0 as const,destroy:()=>agent.destroy()});realAgents.set(wrapper,agent);return wrapper;},httpRequest:(options,callbacks)=>adaptNodeRequest("http:",options,callbacks),httpsRequest:(options,callbacks)=>adaptNodeRequest("https:",options,callbacks),bundledRootCertificates:tls.rootCertificates,checkServerIdentity:(hostname,certificate)=>tls.checkServerIdentity(hostname,certificate as tls.PeerCertificate),clock:Object.freeze<NodeClockInternal>({monotonicNow:()=>nodePerformance.now(),timestampNow:()=>new Date().toISOString(),setTimer:(callback,milliseconds)=>nodeSetTimeout(callback,milliseconds),clearTimer:(handle)=>nodeClearTimeout(handle as ReturnType<typeof nodeSetTimeout>)})});

function exactTimestampEpoch(value:unknown):number|null{
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))return null;
  const epoch=Date.parse(value);
  return Number.isFinite(epoch)&&new Date(epoch).toISOString()===value?epoch:null;
}
function productionFeaturesAvailable():boolean{
  return typeof Resolver==="function"&&typeof http.Agent==="function"&&typeof https.Agent==="function"&&
    typeof http.request==="function"&&typeof https.request==="function"&&typeof tls.checkServerIdentity==="function"&&
    Array.isArray(tls.rootCertificates)&&Object.isFrozen(tls.rootCertificates)&&typeof nodeSetTimeout==="function"&&
    typeof nodeClearTimeout==="function"&&typeof nodePerformance?.now==="function";
}
export function createNodeRuntimeCapabilitiesInternal(ops:NodeOperationsInternal=realNodeOperations):NodeRuntimeCapabilitiesInternal{
  if(ops===realNodeOperations&&!productionFeaturesAvailable())transportFail("transport.unsupported-runtime");
  const keys=["createResolver","createRequestOwnedAgent","httpRequest","httpsRequest","bundledRootCertificates","checkServerIdentity","clock"];
  const d=descriptors(ops,keys,"transport");
  for(const key of ["createResolver","createRequestOwnedAgent","httpRequest","httpsRequest","checkServerIdentity"]){
    if(typeof d[key]!.value!=="function")transportFail("transport.invalid-capability");
  }
  const roots=validateRoots(d.bundledRootCertificates!.value);
  const clockD=exactFunctions(d.clock!.value,["monotonicNow","timestampNow","setTimer","clearTimer"]);
  const rawMonotonic=clockD.monotonicNow!.value as ()=>unknown;
  const rawTimestamp=clockD.timestampNow!.value as ()=>unknown;
  let lastMonotonic=-1;
  let lastTimestamp=-1;
  const clock=Object.freeze<NodeClockInternal>({
    monotonicNow:()=>{
      let value:unknown;try{value=rawMonotonic();}catch{return transportFail("transport.invalid-capability");}
      if(typeof value!=="number"||!Number.isFinite(value)||value<0||value<lastMonotonic)transportFail("transport.invalid-capability");
      lastMonotonic=value;return value;
    },
    timestampNow:()=>{
      let value:unknown;try{value=rawTimestamp();}catch{return transportFail("transport.invalid-capability");}
      const epoch=exactTimestampEpoch(value);
      if(epoch===null||epoch<lastTimestamp)transportFail("transport.invalid-capability");
      lastTimestamp=epoch;return value as string;
    },
    setTimer:clockD.setTimer!.value,
    clearTimer:clockD.clearTimer!.value,
  });
  const normalized:NodeOperationsInternal={
    createResolver:d.createResolver!.value,
    createRequestOwnedAgent:d.createRequestOwnedAgent!.value,
    httpRequest:d.httpRequest!.value,
    httpsRequest:d.httpsRequest!.value,
    bundledRootCertificates:roots,
    checkServerIdentity:d.checkServerIdentity!.value,
    clock,
  };
  const output=Object.freeze({capabilityKind:"node-runtime-capabilities" as const});
  runtimeStates.set(output,{ops:normalized,open:true,usedResolvers:usedResolversGlobal,usedAgents:usedAgentsGlobal,usedRequests:usedRequestsGlobal});
  return output;
}
export function getNodeRuntimeClockInternal(runtime:NodeRuntimeCapabilitiesInternal):NodeClockInternal{return runtimeState(runtime).ops.clock;}
function safeErrorCode(value:unknown):string|undefined{if(value===null||typeof value!=="object"||utilTypes.isProxy(value))return undefined;const descriptor=Object.getOwnPropertyDescriptor(value,"code");return descriptor&&"value" in descriptor&&typeof descriptor.value==="string"?descriptor.value:undefined;}
function resolverStrings(value:unknown):readonly string[]|"overflow"|"invalid"{if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return"invalid";const lengthDescriptor=Object.getOwnPropertyDescriptor(value,"length");if(!lengthDescriptor||!("value" in lengthDescriptor)||typeof lengthDescriptor.value!=="number"||!Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0)return"invalid";const length=lengthDescriptor.value;if(length>64)return"overflow";const all=Object.getOwnPropertyDescriptors(value as object) as PropertyDescriptorMap;if(Reflect.ownKeys(all).length!==length+1)return"invalid";const output:string[]=[];for(let index=0;index<length;index+=1){const item=all[String(index)];if(!item||!("value" in item)||!item.enumerable||typeof item.value!=="string")return"invalid";output.push(item.value);}return output;}
function dnsAbortError():Error{return Object.assign(new Error("DNS operation cancelled"),{code:"ABORT_ERR"});}
function destroyDnsOperation(state:DnsState,operation:DnsOperation,cancel:boolean,rejectRace:boolean):void{
  if(!operation.gate&&!rejectRace)return;
  operation.gate=false;
  if(cancel&&!operation.cancelled){operation.cancelled=true;try{operation.resolver.cancel();}catch{/* quarantine */}}
  if(!operation.cleaned){operation.cleaned=true;try{operation.resolver.destroy();}catch{/* quarantine */}}
  state.active.delete(operation);
  if(rejectRace)operation.reject(dnsAbortError());
}
function closeDnsState(state:DnsState):void{
  if(!state.open)return;
  state.open=false;
  for(const operation of [...state.active])destroyDnsOperation(state,operation,true,true);
}
export function createNodeDnsResolver(runtime:NodeRuntimeCapabilitiesInternal=createNodeRuntimeCapabilitiesInternal()):AcquisitionDnsResolver{
  const node=runtimeState(runtime);
  let output!:AcquisitionDnsResolver;
  const state:DnsState={runtime,active:new Set(),open:true};
  output=createAcquisitionDnsResolver({
    resolveAll:async(hostname,signal)=>{
      if(!state.open)transportFail("transport.closed");
      let raw:NodeResolverInternal;
      try{raw=node.ops.createResolver();}catch{return transportFail("transport.invalid-capability");}
      const resolver=validateResolver(raw,node);
      let rejectAbort!:(error:Error)=>void;
      const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
      const operation:DnsOperation={resolver,gate:true,cleaned:false,cancelled:false,reject:rejectAbort};
      state.active.add(operation);
      if(!state.open)destroyDnsOperation(state,operation,true,true);
      const onAbort=()=>destroyDnsOperation(state,operation,true,true);
      try{
        ADD_EVENT.call(signal,"abort",onAbort,{once:true});
        if(ABORTED_GETTER.call(signal))onAbort();
        if(!operation.gate)return await aborted;
        const first=resolver.resolve4(hostname);
        if(!operation.gate)return await aborted;
        const second=resolver.resolve6(hostname);
        const work=Promise.allSettled([first,second]).then((settled)=>{
          if(!operation.gate)throw dnsAbortError();
          const answers:Array<{address:string;family:4|6}>=[];
          const errors:unknown[]=[];
          for(let index=0;index<2;index+=1){
            const result=settled[index]!;
            if(result.status==="fulfilled"){
              const strings=resolverStrings(result.value);
              if(strings==="overflow"||answers.length+(strings==="invalid"?1:strings.length)>64)return Array.from({length:65},()=>({address:"",family:4 as const}));
              if(strings==="invalid")answers.push({address:"",family:index===0?4:6});
              else for(const address of strings)answers.push({address,family:index===0?4:6});
            }else errors.push(result.reason);
          }
          if(errors.length){
            const onlyNoData=errors.every((error)=>["ENODATA","EAI_NODATA"].includes(safeErrorCode(error)??""));
            if(answers.length===0||!onlyNoData)throw errors.length===1?errors[0]:new AggregateError(errors);
          }
          return answers;
        });
        return await Promise.race([work,aborted]);
      }finally{
        try{REMOVE_EVENT.call(signal,"abort",onAbort);}catch{/* quarantine */}
        destroyDnsOperation(state,operation,false,false);
      }
    },
    close:()=>closeDnsState(state),
  });
  dnsStates.set(output,state);
  return output;
}
function pinnedNetworkOptions(value:NetworkPolicyOptions|undefined):NetworkPolicyOptions|undefined{if(value===undefined)return undefined;const keys=["maxDnsAddresses","maxCanonicalUrlBytes","maxStructureDepth","maxStructureNodes","maxStructureKeys","maxStringCanonicalBytes","maxScalarCanonicalBytes"] as const;const hard=[64,16_384,64,100_000,100_000,1_048_576,8_388_608] as const;if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new NetworkPolicyError("network.invalid-options");const d=Object.getOwnPropertyDescriptors(value);const own=Reflect.ownKeys(d);if(own.some((key)=>typeof key!=="string"||!keys.includes(key as typeof keys[number])))throw new NetworkPolicyError("network.invalid-options");const output:Record<string,number>={};for(let index=0;index<keys.length;index+=1){const descriptor=d[keys[index]!];if(!descriptor)continue;if(!descriptor.enumerable||!("value" in descriptor)||typeof descriptor.value!=="number"||!Number.isSafeInteger(descriptor.value)||descriptor.value<1||descriptor.value>hard[index]!)throw new NetworkPolicyError("network.invalid-options");output[keys[index]!]=descriptor.value;}return Object.freeze(output);}
function inferValidatedUrl(input:unknown):ValidatedProviderUrl{if(typeof input!=="string")return validateFixedProviderUrl("crossref",input);let hostname="";try{hostname=new URL(input).hostname;}catch{return validateFixedProviderUrl("crossref",input);}const target:AcquisitionNetworkTarget=hostname==="api.crossref.org"?"crossref":hostname==="api.openalex.org"?"openalex":"ncbi";return validateFixedProviderUrl(target,input);}
function callbacksInput(value:unknown):NodePinnedHopCallbacksInternal{const keys=["onSecureConnected","onProtocolFailure","onResponse","onData","onEnd","onError"];const d=descriptors(value,keys,"pinned");for(const key of keys)if(typeof d[key]!.value!=="function")pinnedFail("pinned-runtime.invalid-input");return Object.freeze({onSecureConnected:d.onSecureConnected!.value,onProtocolFailure:d.onProtocolFailure!.value,onResponse:d.onResponse!.value,onData:d.onData!.value,onEnd:d.onEnd!.value,onError:d.onError!.value});}
function hasWellFormedUtf16(value:string):boolean{
  for(let index=0;index<value.length;index+=1){
    const unit=value.charCodeAt(index);
    if(unit>=0xd800&&unit<=0xdbff){const low=value.charCodeAt(index+1);if(!(low>=0xdc00&&low<=0xdfff))return false;index+=1;}
    else if(unit>=0xdc00&&unit<=0xdfff)return false;
  }
  return true;
}
function canonicalStringBytes(value:string):number{
  if(!hasWellFormedUtf16(value))return Number.POSITIVE_INFINITY;
  return Buffer.byteLength(JSON.stringify(value),"utf8");
}
function validatedHeaders(value:unknown):readonly Readonly<{name:string;value:string}>[]{
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)pinnedFail("pinned-runtime.invalid-input");
  const all=Object.getOwnPropertyDescriptors(value as object) as PropertyDescriptorMap;
  const length=all.length?.value;
  if(typeof length!=="number"||!Number.isSafeInteger(length)||length<0||length>16||Reflect.ownKeys(all).length!==length+1)pinnedFail("pinned-runtime.invalid-input");
  const output:Array<Readonly<{name:string;value:string}>>=[];
  const seenNames=new Set<string>();
  const seenObjects=new WeakSet<object>();
  let aggregateCanonicalBytes=0;
  for(let index=0;index<length;index+=1){
    const item=all[String(index)];
    if(!item||!("value" in item)||!item.enumerable||item.value===null||typeof item.value!=="object"||seenObjects.has(item.value))pinnedFail("pinned-runtime.invalid-input");
    seenObjects.add(item.value);
    const header=descriptors(item.value,["name","value"],"pinned");
    const name=header.name!.value;
    const headerValue=header.value!.value;
    if((name!=="accept"&&name!=="user-agent"&&name!=="authorization")||seenNames.has(name)||typeof headerValue!=="string")pinnedFail("pinned-runtime.invalid-input");
    if(/[\u0000-\u001f\u007f-\u009f]/u.test(headerValue))pinnedFail("pinned-runtime.invalid-input");
    const valueBytes=canonicalStringBytes(headerValue);
    if(!Number.isSafeInteger(valueBytes)||valueBytes>16_384)pinnedFail("pinned-runtime.invalid-input");
    aggregateCanonicalBytes+=Buffer.byteLength(name,"utf8")+valueBytes;
    if(!Number.isSafeInteger(aggregateCanonicalBytes)||aggregateCanonicalBytes>16*16_384)pinnedFail("pinned-runtime.invalid-input");
    seenNames.add(name);
    output.push(Object.freeze({name,value:headerValue}));
  }
  return Object.freeze(output);
}
function requestInput(value:unknown):PinnedHopOpenRequestInternal{const d=descriptors(value,["ownerId","url","headers","maxHeaderSize","connectTimeoutMs"],"pinned");if(typeof d.ownerId!.value!=="string"||!/^hop-owner-v1-[A-Za-z0-9._-]+$/u.test(d.ownerId!.value)||typeof d.url!.value!=="string"||typeof d.maxHeaderSize!.value!=="number"||!Number.isSafeInteger(d.maxHeaderSize!.value)||d.maxHeaderSize!.value<1||d.maxHeaderSize!.value>262_144||typeof d.connectTimeoutMs!.value!=="number"||!Number.isSafeInteger(d.connectTimeoutMs!.value)||d.connectTimeoutMs!.value<1||d.connectTimeoutMs!.value>30_000)pinnedFail("pinned-runtime.invalid-input");const headers=validatedHeaders(d.headers!.value);return Object.freeze({ownerId:d.ownerId!.value as `hop-owner-v1-${string}`,url:d.url!.value,headers:Object.freeze(headers),maxHeaderSize:d.maxHeaderSize!.value,connectTimeoutMs:d.connectTimeoutMs!.value});}
function normalizePeer(address:string|undefined,family:string|number|undefined):ConnectedPeer|null{if(address===undefined||address.includes("%"))return null;const normalized=family===4||family==="IPv4"?4:family===6||family==="IPv6"?6:null;if(normalized===null)return null;let canonical:string;try{const parsed=new URL(normalized===6?`https://[${address}]/`:`https://${address}/`);canonical=normalized===6?parsed.hostname.slice(1,-1):parsed.hostname;}catch{return null;}return{address:canonical,family:normalized};}
function pinnedRuntimeState(value:unknown):PinnedRuntimeState{if(value===null||typeof value!=="object"||utilTypes.isProxy(value))pinnedFail("pinned-runtime.invalid-capability");const state=pinnedRuntimeStates.get(value);if(!state||!Object.isFrozen(value)||(value as PinnedHopRuntimeInternal).capabilityKind!=="pinned-hop-runtime")pinnedFail("pinned-runtime.invalid-capability");return state;}
function settlementTimestamp(state:HopState):{timestamp:string;valid:boolean}{
  let valid=true;
  let monotonic=state.lastSafeMonotonic;
  try{monotonic=state.ops.clock.monotonicNow();state.lastSafeMonotonic=monotonic;}catch{valid=false;}
  const elapsed=Math.min(300_000,Math.max(0,Math.floor(monotonic-state.startMonotonic)));
  const deterministicEpoch=Math.min(253_402_300_799_999,state.startEpochMs+elapsed);
  let wallEpoch:number|null=null;
  let wall:string|null=null;
  try{wall=state.ops.clock.timestampNow();wallEpoch=exactTimestampEpoch(wall);}catch{valid=false;}
  if(wallEpoch===null||wallEpoch<state.startEpochMs||wallEpoch<deterministicEpoch){valid=false;wall=null;}
  return{timestamp:valid&&wall!==null?wall:new Date(deterministicEpoch).toISOString(),valid};
}
function settleHop(handle:NodePinnedHopHandleInternal,state:HopState,settlement:NodePinnedHopSettlementInternal):void{
  if(state.settled)return;
  state.gate=false;state.settled=true;
  if(state.timer!==null){try{state.ops.clock.clearTimer(state.timer);}catch{/* quarantine */}state.timer=null;}
  try{REMOVE_EVENT.call(state.deadline.signal,"abort",state.deadlineListener);}catch{/* quarantine */}
  const request=state.request;state.request=null;if(request)try{request.destroy();}catch{/* quarantine */}
  const agent=state.agent;state.agent=null;if(agent)try{agent.destroy();}catch{/* quarantine */}
  state.resolve(Object.freeze(settlement));
  hopStates.delete(handle);
}
function cancelledSettlement(state:HopState):NodePinnedHopSettlementInternal{
  let code:"hop.cancelled"|"hop.deadline"="hop.cancelled";
  try{state.deadline.throwIfExpired();}catch(error){if(error instanceof RequestDeadlineErrorInternal&&error.code==="request-deadline.expired")code="hop.deadline";}
  return{outcome:"cancelled",failureCode:code,peer:state.peer,startedAt:state.startedAt,settledAt:settlementTimestamp(state).timestamp};
}
function openHop(ownerId:`hop-owner-v1-${string}`,target:PinnedProviderTargetInternal,request:PinnedHopOpenRequestInternal,upper:NodePinnedHopCallbacksInternal,deadline:RequestDeadlineInternal,node:RuntimeState):NodePinnedHopHandleInternal{
  const remaining=deadline.remainingMs();
  if(remaining===0)deadline.throwIfExpired();
  let startMonotonic:number;let startedAt:string;
  try{startMonotonic=node.ops.clock.monotonicNow();startedAt=node.ops.clock.timestampNow();}catch{return transportFail("transport.invalid-capability");}
  const startEpochMs=exactTimestampEpoch(startedAt);
  if(startEpochMs===null)transportFail("transport.invalid-capability");
  let rawAgent:NodeRequestOwnedAgentInternal;
  try{rawAgent=node.ops.createRequestOwnedAgent("https:");}catch{return transportFail("transport.invalid-capability");}
  const agent=validateAgent(rawAgent,"https:",node);
  let resolveCompletion!:(value:NodePinnedHopSettlementInternal)=>void;
  const completion=new Promise<NodePinnedHopSettlementInternal>((resolve)=>{resolveCompletion=resolve;});
  let handle!:NodePinnedHopHandleInternal;
  const state:HopState={
    gate:true,settled:false,request:null,agent,timer:null,deadline,
    deadlineListener:()=>{if(state.gate)settleHop(handle,state,cancelledSettlement(state));},
    resolve:resolveCompletion,startedAt,startEpochMs,startMonotonic,lastSafeMonotonic:startMonotonic,
    peer:null,callbacks:upper,ops:node.ops,
  };
  const fail=(failureCode:NodePinnedHopFailureCodeInternal)=>{
    const clock=settlementTimestamp(state);
    settleHop(handle,state,{outcome:"failed",failureCode:clock.valid?failureCode:"hop.protocol-failed",peer:state.peer,startedAt:state.startedAt,settledAt:clock.timestamp});
  };
  const guarded:NodeRequestCallbacksInternal={
    onSecureConnected:(tlsFacts)=>{
      if(!state.gate)return;
      const peer=normalizePeer(tlsFacts.address,tlsFacts.family);
      if(!tlsFacts.hostnameVerified||!tlsFacts.authorized||tlsFacts.authorizationError!==null){fail("hop.tls-failed");return;}
      if(!peer){fail("hop.peer-unavailable");return;}
      const expectedPeer=normalizePeer(target.address,target.family);
      if(!expectedPeer||peer.address!==expectedPeer.address||peer.family!==expectedPeer.family){fail("hop.peer-mismatch");return;}
      state.peer=Object.freeze({address:target.address,family:target.family});
      if(state.timer!==null){try{node.ops.clock.clearTimer(state.timer);}catch{fail("hop.protocol-failed");return;}state.timer=null;}
      try{upper.onSecureConnected(tlsFacts);}catch{fail("hop.protocol-failed");}
    },
    onProtocolFailure:(code)=>{if(!state.gate)return;try{upper.onProtocolFailure(code);}catch{/* quarantine */}fail("hop.protocol-failed");},
    onResponse:(status,version,headers)=>{if(!state.gate)return;if(state.peer===null){fail("hop.tls-failed");return;}try{upper.onResponse(status,version,headers);}catch{fail("hop.protocol-failed");}},
    onData:(chunk)=>{if(!state.gate||state.peer===null)return"abort";try{return upper.onData(chunk);}catch{fail("hop.protocol-failed");return"abort";}},
    onEnd:()=>{
      if(!state.gate)return;
      if(state.peer===null){fail("hop.tls-failed");return;}
      try{upper.onEnd();}catch{fail("hop.protocol-failed");return;}
      const clock=settlementTimestamp(state);
      if(!clock.valid){settleHop(handle,state,{outcome:"failed",failureCode:"hop.protocol-failed",peer:state.peer,startedAt:state.startedAt,settledAt:clock.timestamp});return;}
      settleHop(handle,state,{outcome:"ended",failureCode:null,peer:state.peer,startedAt:state.startedAt,settledAt:clock.timestamp});
    },
    onError:(kind)=>{if(!state.gate)return;try{upper.onError(kind);}catch{/* quarantine */}fail(kind==="tls"?"hop.tls-failed":"hop.connect-failed");},
  };
  const options:NodeRequestOptionsInternal=Object.freeze({
    url:target.url,pinnedAddress:target.address,family:target.family,hostHeader:target.hostHeader,servername:target.hostname,
    headers:request.headers,agent,ca:node.ops.bundledRootCertificates,rejectUnauthorized:true as const,maxHeaderSize:request.maxHeaderSize,
    insecureHTTPParser:false as const,joinDuplicateHeaders:false as const,
    checkServerIdentity:(hostname:string,certificate:object)=>{
      if(hostname!==target.hostname)return new Error("hostname mismatch");
      try{return node.ops.checkServerIdentity(hostname,certificate);}catch{return new Error("certificate validation failed");}
    },
  });
  let rawRequest:NodeRequestHandleInternal;
  try{rawRequest=node.ops.httpsRequest(options,guarded);}catch{try{agent.destroy();}catch{/* quarantine */}return transportFail("transport.invalid-capability");}
  try{state.request=validateRequestHandle(rawRequest,node);}catch(error){try{agent.destroy();}catch{/* quarantine */}throw error;}
  handle=Object.freeze({
    ownerId,completion,
    abort(){const current=hopStates.get(handle);if(!current||!current.gate)return;settleHop(handle,current,cancelledSettlement(current));},
    async close(){handle.abort();await completion;},
    forceClose(){const current=hopStates.get(handle);if(!current||!current.gate)return;current.gate=false;settleHop(handle,current,cancelledSettlement(current));},
  });
  hopStates.set(handle,state);
  ADD_EVENT.call(deadline.signal,"abort",state.deadlineListener,{once:true});
  if(ABORTED_GETTER.call(deadline.signal))state.deadlineListener();
  if(!state.gate)return handle;
  try{
    state.timer=node.ops.clock.setTimer(()=>{
      if(!state.gate)return;
      try{deadline.throwIfExpired();}catch{settleHop(handle,state,cancelledSettlement(state));return;}
      fail("hop.connect-timeout");
    },Math.min(request.connectTimeoutMs,remaining));
  }catch{fail("hop.protocol-failed");return handle;}
  try{state.request.end();}catch{fail("hop.connect-failed");}
  return handle;
}
export function createPinnedHopRuntimeInternal(options:NetworkPolicyOptions|undefined,runtime:NodeRuntimeCapabilitiesInternal=createNodeRuntimeCapabilitiesInternal()):PinnedHopRuntimeInternal{const normalizedOptions=pinnedNetworkOptions(options);const node=runtimeState(runtime);const dns=createNodeDnsResolver(runtime);let output!:PinnedHopRuntimeInternal;const state:PinnedRuntimeState={node:runtime,ops:node.ops,options:normalizedOptions,dns,open:true,pins:new Set(),handles:new Set(),owners:new Set()};output=Object.freeze({capabilityKind:"pinned-hop-runtime" as const,async resolveProviderTarget(url:unknown,deadline:RequestDeadlineInternal){if(!state.open)pinnedFail("pinned-runtime.closed");assertRequestDeadlineInternal(deadline);deadline.throwIfExpired();const validated=inferValidatedUrl(url);let safe;try{safe=await resolveAllSafeProviderAddressesInternal(validated,state.options,state.dns,deadline.signal);}catch(error){if(error instanceof NetworkPolicyError&&error.code==="network.cancelled")deadline.throwIfExpired();throw error;}deadline.throwIfExpired();const first=safe.addresses[0]!;const target=Object.freeze({capabilityKind:"pinned-provider-target" as const,...validated,address:first.address,family:first.family,allAddressesSha256:safe.allAddressesSha256});pinStates.set(target,{runtime:output,deadline,state:"resolved"});state.pins.add(target);return target;},openPinnedHop(target: PinnedProviderTargetInternal,requestValue:PinnedHopOpenRequestInternal,callbacksValue:NodePinnedHopCallbacksInternal,deadline:RequestDeadlineInternal){const pin=target!==null&&typeof target==="object"&&!utilTypes.isProxy(target)?pinStates.get(target):undefined;if(!state.open){if(pin?.runtime===output&&pin.state==="stale")pinnedFail("pinned-runtime.pin-stale");pinnedFail("pinned-runtime.closed");}if(!pin||pin.runtime!==output)pinnedFail("pinned-runtime.invalid-capability");if(pin.state==="stale")pinnedFail("pinned-runtime.pin-stale");if(pin.state!=="resolved")pinnedFail("pinned-runtime.pin-replayed");if(pin.deadline!==deadline)pinnedFail("pinned-runtime.target-mismatch");const request=requestInput(requestValue);const upper=callbacksInput(callbacksValue);if(request.url!==target.url)pinnedFail("pinned-runtime.target-mismatch");if(state.owners.has(request.ownerId))pinnedFail("pinned-runtime.pin-replayed");pin.state="consumed";state.pins.delete(target);state.owners.add(request.ownerId);const handle=openHop(request.ownerId,target,request,upper,deadline,node);state.handles.add(handle);void handle.completion.finally(()=>state.handles.delete(handle));return handle;},async close(){if(!state.open)return;state.open=false;for(const target of state.pins){const pin=pinStates.get(target);if(pin&&pin.state==="resolved")pin.state="stale";}const dnsState=dnsStates.get(dns);if(dnsState)closeDnsState(dnsState);for(const handle of [...state.handles])handle.abort();await Promise.all([...state.handles].map((handle)=>handle.close()));}});pinnedRuntimeStates.set(output,state);return output;}
