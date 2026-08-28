import type {
  NodeOperationsInternal, NodeRequestCallbacksInternal, NodeRequestHandleInternal,
  NodeRequestOptionsInternal, NodeRequestOwnedAgentInternal, NodeResolverInternal,
} from "../../src/acquisition/node-pinned-hop-internal.js";

export interface MockSecureTransportControl {
  ops:NodeOperationsInternal;
  now:number;
  timestampNow:()=>string;
  timers:Map<number,()=>void>;
  timerMilliseconds:Map<number,number>;
  requests:Array<{options:NodeRequestOptionsInternal;callbacks:NodeRequestCallbacksInternal;handle:NodeRequestHandleInternal;counts:{end:number;abort:number;destroy:number}}>;
  agents:Array<{agent:NodeRequestOwnedAgentInternal;destroyCount:number}>;
  resolvers:Array<{resolver:NodeResolverInternal;cancelCount:number;destroyCount:number}>;
  resolve4:(hostname:string)=>Promise<readonly string[]>;
  resolve6:(hostname:string)=>Promise<readonly string[]>;
  onRequest?:(callbacks:NodeRequestCallbacksInternal)=>void;
}

/** Task 11 AST-audited fake-only source; captures no ambient network or process capability. */
export function createMockSecureTransportCapabilities():MockSecureTransportControl {
  let timerId=0;const timers=new Map<number,()=>void>();const timerMilliseconds=new Map<number,number>();const requests:MockSecureTransportControl["requests"]=[];const agents:MockSecureTransportControl["agents"]=[];const resolvers:MockSecureTransportControl["resolvers"]=[];
  const control={} as MockSecureTransportControl;control.now=100;control.timerMilliseconds=timerMilliseconds;control.timestampNow=()=>new Date(1_700_000_000_000+control.now).toISOString();control.timers=timers;control.requests=requests;control.agents=agents;control.resolvers=resolvers;control.resolve4=async()=>["8.8.8.8"];control.resolve6=async()=>["2606:4700:4700::1111"];
  const ops:NodeOperationsInternal={
    createResolver:()=>{const record={cancelCount:0,destroyCount:0,resolver:null as unknown as NodeResolverInternal};const resolver={resolve4:(hostname:string)=>control.resolve4(hostname),resolve6:(hostname:string)=>control.resolve6(hostname),cancel:()=>{record.cancelCount+=1;},destroy:()=>{record.destroyCount+=1;}};record.resolver=resolver;resolvers.push(record);return resolver;},
    createRequestOwnedAgent:(protocol)=>{const record={destroyCount:0,agent:null as unknown as NodeRequestOwnedAgentInternal};const agent={protocol,keepAlive:false as const,maxSockets:1 as const,maxFreeSockets:0 as const,destroy:()=>{record.destroyCount+=1;}};record.agent=agent;agents.push(record);return agent;},
    httpRequest:(options,callbacks)=>makeRequest(options,callbacks),httpsRequest:(options,callbacks)=>makeRequest(options,callbacks),
    bundledRootCertificates:Object.freeze(["TEST ROOT A","TEST ROOT B"]),checkServerIdentity:()=>undefined,
    clock:{monotonicNow:()=>control.now,timestampNow:()=>control.timestampNow(),setTimer:(callback,milliseconds)=>{const id=++timerId;timers.set(id,callback);timerMilliseconds.set(id,milliseconds);return id;},clearTimer:(handle)=>{timers.delete(handle as number);timerMilliseconds.delete(handle as number);}},
  };
  function makeRequest(options:NodeRequestOptionsInternal,callbacks:NodeRequestCallbacksInternal):NodeRequestHandleInternal { const counts={end:0,abort:0,destroy:0};const handle={end:()=>{counts.end+=1;},abort:()=>{counts.abort+=1;},destroy:()=>{counts.destroy+=1;}};requests.push({options,callbacks,handle,counts});control.onRequest?.(callbacks);return handle; }
  control.ops=ops;return control;
}
