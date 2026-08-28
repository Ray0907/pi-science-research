import {types as utilTypes} from "node:util";
import {
  assertAcademicAcquisitionDependencyFactoryInternal,
  createAcademicAcquisitionCallCapabilities,
  createAcademicAcquisitionClient,
  createDefaultAcademicAcquisitionDependencyFactoryInternal,
  getAcademicAcquisitionClientNormalizedOptionsInternal,
  getAcademicAcquisitionErrorCodeInternal,
  type AcademicAcquisitionClient,
  type AcademicAcquisitionDependencyFactoryInternal,
} from "../../src/acquisition/coordinator.js";
import type {
  AcademicAcquisitionOptions,
  AcademicAcquisitionResult,
  AcademicFetchInput,
  AcademicSearchInput,
  NormalizedAcquisitionOptionsInternal,
} from "../../src/acquisition/contracts.js";

export type AcademicToolErrorCode =
  | "academic-tool.invalid-input" | "academic-tool.invalid-options"
  | "academic-tool.disabled" | "academic-tool.pre-session" | "academic-tool.unavailable"
  | "academic-tool.stale-generation" | "academic-tool.shutdown"
  | "academic-tool.cancelled" | "academic-tool.deadline-exceeded"
  | "academic-tool.security-policy" | "academic-tool.sink-settlement-failure"
  | "academic-tool.provider-failure" | "academic-tool.result-too-large"
  | "academic-tool.truncation-invariant" | "academic-tool.internal-contract";

const TOOL_ERROR_CODES = Object.freeze([
  "academic-tool.invalid-input", "academic-tool.invalid-options", "academic-tool.disabled",
  "academic-tool.pre-session", "academic-tool.unavailable", "academic-tool.stale-generation",
  "academic-tool.shutdown", "academic-tool.cancelled", "academic-tool.deadline-exceeded",
  "academic-tool.security-policy", "academic-tool.sink-settlement-failure",
  "academic-tool.provider-failure", "academic-tool.result-too-large",
  "academic-tool.truncation-invariant", "academic-tool.internal-contract",
] as const satisfies readonly AcademicToolErrorCode[]);
const TOOL_ERROR_CODE_SET = new Set<string>(TOOL_ERROR_CODES);
const academicToolErrorStates = new WeakMap<object,AcademicToolErrorCode>();
const academicRenderInvariantErrors = new WeakSet<object>();
const NATIVE_IS_PROXY = utilTypes.isProxy;
const NATIVE_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const NATIVE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const NATIVE_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const NATIVE_IS_FROZEN = Object.isFrozen;
const NATIVE_FREEZE = Object.freeze;
const NATIVE_DEFINE_PROPERTY = Object.defineProperty;
const NATIVE_OWN_KEYS = Reflect.ownKeys;
const NATIVE_ARRAY_IS_ARRAY = Array.isArray;
const ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!;
const THROW_IF_ABORTED = AbortSignal.prototype.throwIfAborted;
const ADD_EVENT_LISTENER = AbortSignal.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = AbortSignal.prototype.removeEventListener;
const NATIVE_IS_PROMISE=utilTypes.isPromise,NATIVE_PROMISE=Promise,NATIVE_PROMISE_PROTOTYPE=Promise.prototype,NATIVE_PROMISE_THEN=Promise.prototype.then;
const NATIVE_PROMISE_CONSTRUCTOR_DESCRIPTOR=Object.getOwnPropertyDescriptor(Promise.prototype,"constructor")!,NATIVE_PROMISE_THEN_DESCRIPTOR=Object.getOwnPropertyDescriptor(Promise.prototype,"then")!,NATIVE_PROMISE_SPECIES_DESCRIPTOR=Object.getOwnPropertyDescriptor(Promise,Symbol.species)!,NATIVE_PROMISE_SPECIES_GETTER=NATIVE_PROMISE_SPECIES_DESCRIPTOR.get;
function authenticBasePromise(value:unknown):value is Promise<void>{if(value===null||typeof value!=="object"||NATIVE_IS_PROXY(value)||!NATIVE_IS_PROMISE(value))return false;try{if(NATIVE_GET_PROTOTYPE_OF(value)!==NATIVE_PROMISE_PROTOTYPE||NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value,"constructor")!==undefined||NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value,"then")!==undefined)return false;const constructorDescriptor=NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(NATIVE_PROMISE_PROTOTYPE,"constructor"),thenDescriptor=NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(NATIVE_PROMISE_PROTOTYPE,"then"),speciesDescriptor=NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(NATIVE_PROMISE,Symbol.species);return !!constructorDescriptor&&"value" in constructorDescriptor&&constructorDescriptor.value===NATIVE_PROMISE&&constructorDescriptor.writable===NATIVE_PROMISE_CONSTRUCTOR_DESCRIPTOR.writable&&constructorDescriptor.enumerable===NATIVE_PROMISE_CONSTRUCTOR_DESCRIPTOR.enumerable&&constructorDescriptor.configurable===NATIVE_PROMISE_CONSTRUCTOR_DESCRIPTOR.configurable&&!!thenDescriptor&&"value" in thenDescriptor&&thenDescriptor.value===NATIVE_PROMISE_THEN&&thenDescriptor.writable===NATIVE_PROMISE_THEN_DESCRIPTOR.writable&&thenDescriptor.enumerable===NATIVE_PROMISE_THEN_DESCRIPTOR.enumerable&&thenDescriptor.configurable===NATIVE_PROMISE_THEN_DESCRIPTOR.configurable&&!!speciesDescriptor&&"get" in speciesDescriptor&&speciesDescriptor.get===NATIVE_PROMISE_SPECIES_GETTER&&speciesDescriptor.set===NATIVE_PROMISE_SPECIES_DESCRIPTOR.set&&speciesDescriptor.enumerable===NATIVE_PROMISE_SPECIES_DESCRIPTOR.enumerable&&speciesDescriptor.configurable===NATIVE_PROMISE_SPECIES_DESCRIPTOR.configurable;}catch{return false;}}

export class AcademicToolError extends Error {
  declare readonly name:"AcademicToolError";
  declare readonly code:AcademicToolErrorCode;
  constructor(code:AcademicToolErrorCode) {
    const safeCode = TOOL_ERROR_CODE_SET.has(code) ? code : "academic-tool.internal-contract";
    super(safeCode);
    NATIVE_DEFINE_PROPERTY(this,"code",{value:safeCode,enumerable:true,writable:false,configurable:false});
    NATIVE_DEFINE_PROPERTY(this,"name",{value:"AcademicToolError",enumerable:true,writable:false,configurable:false});
    academicToolErrorStates.set(this,safeCode);
  }
}
function authenticatedToolErrorCode(value:unknown):AcademicToolErrorCode|null {
  if(value===null||typeof value!=="object") return null;
  return academicToolErrorStates.get(value)??null;
}
const toolFail=(code:AcademicToolErrorCode):never=>{throw new AcademicToolError(code);};
export function freshAcademicToolErrorInternal(error:unknown,fallback:AcademicToolErrorCode="academic-tool.internal-contract"):never {
  return toolFail(authenticatedToolErrorCode(error)??fallback);
}
export function academicRenderInvariantInternal():never {
  const error=new AcademicToolError("academic-tool.truncation-invariant");academicRenderInvariantErrors.add(error);throw error;
}
export function mapAcademicRenderErrorInternal(error:unknown):never {
  if(error!==null&&typeof error==="object"&&academicRenderInvariantErrors.has(error)) toolFail("academic-tool.truncation-invariant");
  return toolFail("academic-tool.internal-contract");
}

export interface AcademicToolDependenciesDescriptor {
  readonly enabled?:boolean;
  readonly options?:AcademicAcquisitionOptions;
  readonly acquisitionDependencyFactory?:AcademicAcquisitionDependencyFactoryInternal;
}
export interface AcademicToolDependencies {readonly capabilityKind:"academic-tool-dependencies";}
type DependencyState=Readonly<{enabled:boolean;options:AcademicAcquisitionOptions|undefined;factory:AcademicAcquisitionDependencyFactoryInternal}>;
const dependencyStates=new WeakMap<object,DependencyState>();
function plainDescriptor(value:unknown):PropertyDescriptorMap {
  if(value===null||typeof value!=="object"||NATIVE_IS_PROXY(value)||NATIVE_GET_PROTOTYPE_OF(value)!==Object.prototype) toolFail("academic-tool.internal-contract");
  const descriptors=NATIVE_GET_OWN_PROPERTY_DESCRIPTORS(value),keys=NATIVE_OWN_KEYS(descriptors),allowed=["enabled","options","acquisitionDependencyFactory"];
  if(keys.some(key=>typeof key!=="string"||!allowed.includes(key))||keys.length>allowed.length) toolFail("academic-tool.internal-contract");
  for(const key of keys as string[]) {const descriptor=descriptors[key]!;if(!descriptor.enumerable||!("value" in descriptor)) toolFail("academic-tool.internal-contract");}
  return descriptors;
}
export function createAcademicToolDependencies(descriptor:AcademicToolDependenciesDescriptor={}):AcademicToolDependencies {
  const d=plainDescriptor(descriptor),enabledValue=d.enabled?.value;
  if(enabledValue!==undefined&&typeof enabledValue!=="boolean") toolFail("academic-tool.internal-contract");
  const factory=(d.acquisitionDependencyFactory?.value??createDefaultAcademicAcquisitionDependencyFactoryInternal()) as AcademicAcquisitionDependencyFactoryInternal;
  try {assertAcademicAcquisitionDependencyFactoryInternal(factory);} catch {return toolFail("academic-tool.internal-contract");}
  const output=NATIVE_FREEZE({capabilityKind:"academic-tool-dependencies" as const});
  dependencyStates.set(output,NATIVE_FREEZE({enabled:enabledValue??true,options:d.options?.value as AcademicAcquisitionOptions|undefined,factory}));
  return output;
}
export function createDefaultAcademicToolDependencies():AcademicToolDependencies {return createAcademicToolDependencies();}
export function getAcademicToolDependenciesInternal(value:AcademicToolDependencies):DependencyState {
  if(value===null||typeof value!=="object"||NATIVE_IS_PROXY(value)||!NATIVE_IS_FROZEN(value)) toolFail("academic-tool.internal-contract");
  const state=dependencyStates.get(value as object);if(!state) toolFail("academic-tool.internal-contract");return state!;
}

export interface AcademicSessionManager {
  readonly generation:number;
  search(input:AcademicSearchInput,signal?:AbortSignal):Promise<AcademicAcquisitionResult>;
  fetch(input:AcademicFetchInput,signal?:AbortSignal):Promise<AcademicAcquisitionResult>;
  shutdown():Promise<void>;
}
type ManagerState={
  dependencies:DependencyState;generation:number;lifecycle:"open"|"stale-generation"|"shutdown";
  controller:AbortController;client:AcademicAcquisitionClient|null;normalized:NormalizedAcquisitionOptionsInternal|null;shutdownPromise:Promise<void>|null;continuationWaiters:number;
};
const managerStates=new WeakMap<object,ManagerState>();
const callContinuationStates=new WeakMap<object,Readonly<{manager:ManagerState;external:AbortSignal|null}>>();
function managerState(value:unknown):ManagerState {
  if(value===null||typeof value!=="object"||NATIVE_IS_PROXY(value)||!NATIVE_IS_FROZEN(value)) toolFail("academic-tool.internal-contract");
  const state=managerStates.get(value as object);if(!state) toolFail("academic-tool.internal-contract");return state!;
}
function assertManagerStateLifecycle(state:ManagerState):void {
  if(state.lifecycle==="stale-generation") toolFail("academic-tool.stale-generation");
  if(state.lifecycle==="shutdown") toolFail("academic-tool.shutdown");
}
export function assertAcademicSessionManagerLifecycleInternal(manager:AcademicSessionManager):void {assertManagerStateLifecycle(managerState(manager));}
function continuationState(manager:AcademicSessionManager,result:AcademicAcquisitionResult):Readonly<{state:ManagerState;external:AbortSignal|null}>{const state=managerState(manager);assertManagerStateLifecycle(state);if(result===null||typeof result!=="object"||NATIVE_IS_PROXY(result))toolFail("academic-tool.internal-contract");const continuation=callContinuationStates.get(result);if(!continuation||continuation.manager!==state)toolFail("academic-tool.internal-contract");return NATIVE_FREEZE({state,external:continuation!.external});}
export function assertAcademicSessionCallContinuationInternal(manager:AcademicSessionManager,result:AcademicAcquisitionResult):void {const continuation=continuationState(manager,result);if(continuation.external!==null&&ABORTED.call(continuation.external))toolFail("academic-tool.cancelled");}
export function awaitAcademicSessionContinuationInternal(manager:AcademicSessionManager,result:AcademicAcquisitionResult,update:unknown):Promise<void>{const continuation=continuationState(manager,result),state=continuation.state,external=continuation.external;if(!authenticBasePromise(update))toolFail("academic-tool.internal-contract");return new NATIVE_PROMISE<void>((resolve,reject)=>{let terminal=false,installed=false;const generationSignal=state.controller.signal;const cleanup=()=>{if(!installed)return;installed=false;REMOVE_EVENT_LISTENER.call(generationSignal,"abort",generationAbort);if(external!==null)REMOVE_EVENT_LISTENER.call(external,"abort",externalAbort);state.continuationWaiters-=1;};const finish=(code:AcademicToolErrorCode|null)=>{if(terminal)return;terminal=true;cleanup();if(code===null)resolve();else reject(new AcademicToolError(code));};const lifecycleCode=():AcademicToolErrorCode=>state.lifecycle==="stale-generation"?"academic-tool.stale-generation":state.lifecycle==="shutdown"?"academic-tool.shutdown":"academic-tool.internal-contract";const generationAbort=()=>finish(lifecycleCode()),externalAbort=()=>finish(state.lifecycle==="open"?"academic-tool.cancelled":lifecycleCode());ADD_EVENT_LISTENER.call(generationSignal,"abort",generationAbort,{once:true});if(external!==null)ADD_EVENT_LISTENER.call(external,"abort",externalAbort,{once:true});installed=true;state.continuationWaiters+=1;try{NATIVE_PROMISE_THEN.call(update,()=>finish(null),()=>finish("academic-tool.internal-contract"));}catch{finish("academic-tool.internal-contract");return;}if(state.lifecycle!=="open"||ABORTED.call(generationSignal))generationAbort();else if(external!==null&&ABORTED.call(external))externalAbort();});}
export function assertAcademicSessionContinuationIdleInternal(manager:AcademicSessionManager):void {const state=managerState(manager);if(state.continuationWaiters!==0)toolFail("academic-tool.internal-contract");}
function genuineSignal(value:unknown):AbortSignal|null {
  if(value===undefined) return null;
  if(value===null||typeof value!=="object"||NATIVE_IS_PROXY(value)) toolFail("academic-tool.internal-contract");
  try {
    if(NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value,"aborted")!==undefined||NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value,"throwIfAborted")!==undefined) toolFail("academic-tool.internal-contract");
    const aborted=ABORTED.call(value) as boolean;let threw=false;
    try {THROW_IF_ABORTED.call(value);} catch {threw=true;}
    if(aborted!==threw) toolFail("academic-tool.internal-contract");
    return value as AbortSignal;
  } catch {return toolFail("academic-tool.internal-contract");}
}
function ownData(value:unknown,allowed:readonly string[],required:readonly string[]):PropertyDescriptorMap {
  if(value===null||typeof value!=="object"||NATIVE_IS_PROXY(value)||NATIVE_GET_PROTOTYPE_OF(value)!==Object.prototype) toolFail("academic-tool.invalid-input");
  const d=NATIVE_GET_OWN_PROPERTY_DESCRIPTORS(value),keys=NATIVE_OWN_KEYS(d);
  if(keys.some(key=>typeof key!=="string"||!allowed.includes(key))||required.some(key=>!keys.includes(key))) toolFail("academic-tool.invalid-input");
  for(const key of keys as string[]) {const item=d[key]!;if(!item.enumerable||!("value" in item)) toolFail("academic-tool.invalid-input");}
  return d;
}
function denseStrings(value:unknown,maximum:number,enums?:readonly string[]):readonly string[] {
  if(!NATIVE_ARRAY_IS_ARRAY(value)||NATIVE_IS_PROXY(value)) toolFail("academic-tool.invalid-input");
  const lengthDescriptor=NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value,"length");
  if(!lengthDescriptor||!("value" in lengthDescriptor)||!Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0||lengthDescriptor.value>maximum) toolFail("academic-tool.invalid-input");
  const length=lengthDescriptor!.value as number,d=NATIVE_GET_OWN_PROPERTY_DESCRIPTORS(value),keys=NATIVE_OWN_KEYS(d);
  if(keys.length!==length+1) toolFail("academic-tool.invalid-input");
  const output:string[]=[];
  for(let index=0;index<length;index++) {const item=d[String(index)];if(!item||!("value" in item)||!item.enumerable||typeof item.value!=="string"||(enums&&!enums.includes(item.value))) toolFail("academic-tool.invalid-input");output.push(item.value);}
  return NATIVE_FREEZE(output);
}
function integer(value:unknown,minimum:number,maximum:number):number {
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<minimum||value>maximum) toolFail("academic-tool.invalid-input");return value as number;
}
function searchInput(value:unknown):AcademicSearchInput {
  const d=ownData(value,["queries","providers","maxResultsPerQuery","publicationTypes","fromYear","toYear"],["queries"]),queries=denseStrings(d.queries!.value,16);
  if(queries.length<1) toolFail("academic-tool.invalid-input");
  const output:Record<string,unknown>={queries};
  if(d.providers) output.providers=denseStrings(d.providers.value,3,["crossref","openalex","pubmed"]);
  if(d.maxResultsPerQuery) output.maxResultsPerQuery=integer(d.maxResultsPerQuery.value,1,100);
  if(d.publicationTypes) output.publicationTypes=denseStrings(d.publicationTypes.value,4,["journal-article","review","dataset","other"]);
  if(d.fromYear) output.fromYear=integer(d.fromYear.value,1,9999);
  if(d.toYear) output.toYear=integer(d.toYear.value,1,9999);
  return NATIVE_FREEZE(output) as unknown as AcademicSearchInput;
}
function fetchInput(value:unknown):AcademicFetchInput {
  const d=ownData(value,["identifierKind","identifier"],["identifierKind","identifier"]),kind=d.identifierKind!.value,identifier=d.identifier!.value;
  if(typeof kind!=="string"||!["doi","pmid","pmcid"].includes(kind)||typeof identifier!=="string") toolFail("academic-tool.invalid-input");
  return NATIVE_FREEZE({identifierKind:kind,identifier}) as AcademicFetchInput;
}
const acquisitionMap:Readonly<Record<string,AcademicToolErrorCode>>=NATIVE_FREEZE({
  "acquisition.invalid-input":"academic-tool.invalid-input",
  "acquisition.too-many-queries":"academic-tool.invalid-input",
  "acquisition.query-too-large":"academic-tool.invalid-input",
  "acquisition.too-many-partitions":"academic-tool.invalid-input",
  "acquisition.invalid-options":"academic-tool.invalid-options",
  "acquisition.closed":"academic-tool.shutdown",
  "acquisition.cancelled":"academic-tool.cancelled",
  "acquisition.deadline-exceeded":"academic-tool.deadline-exceeded",
  "acquisition.security-failure":"academic-tool.security-policy",
  "acquisition.sink-settlement-failure":"academic-tool.sink-settlement-failure",
  "acquisition.provider-failure":"academic-tool.provider-failure",
  "acquisition.result-too-large":"academic-tool.result-too-large",
  "acquisition.internal-contract":"academic-tool.internal-contract",
});
export function mapAcademicAcquisitionErrorInternal(error:unknown):never {
  const code=getAcademicAcquisitionErrorCodeInternal(error);return toolFail(code===null?("academic-tool.internal-contract"):acquisitionMap[code]??"academic-tool.internal-contract");
}
function mapped(error:unknown,state:ManagerState,external:AbortSignal|null):never {
  if(state.lifecycle==="stale-generation") toolFail("academic-tool.stale-generation");
  if(state.lifecycle==="shutdown") toolFail("academic-tool.shutdown");
  if(external!==null&&ABORTED.call(external)) toolFail("academic-tool.cancelled");
  const toolCode=authenticatedToolErrorCode(error);if(toolCode!==null) toolFail(toolCode);
  return mapAcademicAcquisitionErrorInternal(error);
}
function client(state:ManagerState):AcademicAcquisitionClient {
  if(state.lifecycle!=="open") toolFail(state.lifecycle==="stale-generation"?"academic-tool.stale-generation":"academic-tool.shutdown");
  if(!state.dependencies.enabled) toolFail("academic-tool.disabled");
  if(state.client!==null) return state.client;
  try {
    const created=createAcademicAcquisitionClient(state.dependencies.options,state.dependencies.factory);
    const normalized=getAcademicAcquisitionClientNormalizedOptionsInternal(created);
    state.client=created;state.normalized=normalized;return created;
  } catch(error) {
    const code=getAcademicAcquisitionErrorCodeInternal(error);
    if(code==="acquisition.invalid-options") toolFail("academic-tool.invalid-options");
    return toolFail("academic-tool.unavailable");
  }
}
async function invoke(state:ManagerState,kind:"search"|"fetch",input:unknown,signalValue?:AbortSignal):Promise<AcademicAcquisitionResult> {
  if(!state.dependencies.enabled) toolFail("academic-tool.disabled");
  if(state.lifecycle!=="open") toolFail(state.lifecycle==="stale-generation"?"academic-tool.stale-generation":"academic-tool.shutdown");
  const acquisitionClient=client(state);
  let inputValue:AcademicSearchInput|AcademicFetchInput,external:AbortSignal|null=null;
  try {
    inputValue=kind==="search"?searchInput(input):fetchInput(input);
    external=genuineSignal(signalValue);
    if(external!==null&&ABORTED.call(external)) toolFail("academic-tool.cancelled");
  } catch(error) {return mapped(error,state,external);}
  const controller=new AbortController(),generationSignal=state.controller.signal,abortGeneration=()=>controller.abort(),abortExternal=()=>controller.abort();
  ADD_EVENT_LISTENER.call(generationSignal,"abort",abortGeneration,{once:true});
  if(external!==null) ADD_EVENT_LISTENER.call(external,"abort",abortExternal,{once:true});
  if(ABORTED.call(generationSignal)) abortGeneration();
  if(external!==null&&ABORTED.call(external)) abortExternal();
  try {
    const capability=createAcademicAcquisitionCallCapabilities({signal:controller.signal});
    const result=kind==="search"?await acquisitionClient.search(inputValue as AcademicSearchInput,capability):await acquisitionClient.fetch(inputValue as AcademicFetchInput,capability);
    assertManagerStateLifecycle(state);
    if(result===null||typeof result!=="object"||NATIVE_IS_PROXY(result)||callContinuationStates.has(result)) toolFail("academic-tool.internal-contract");
    callContinuationStates.set(result,NATIVE_FREEZE({manager:state,external}));
    return result;
  } catch(error) {return mapped(error,state,external);}
  finally {REMOVE_EVENT_LISTENER.call(generationSignal,"abort",abortGeneration);if(external!==null) REMOVE_EVENT_LISTENER.call(external,"abort",abortExternal);}
}
export function createAcademicSessionManager(dependencies:AcademicToolDependencies,generation:number):AcademicSessionManager {
  const dependency=getAcademicToolDependenciesInternal(dependencies);
  if(!Number.isSafeInteger(generation)||generation<1) toolFail("academic-tool.internal-contract");
  let manager!:AcademicSessionManager;
  const state:ManagerState={dependencies:dependency,generation,controller:new AbortController(),lifecycle:"open",client:null,normalized:null,shutdownPromise:null,continuationWaiters:0};
  manager=NATIVE_FREEZE({
    generation,
    search(input:AcademicSearchInput,signal?:AbortSignal){return invoke(state,"search",input,signal);},
    fetch(input:AcademicFetchInput,signal?:AbortSignal){return invoke(state,"fetch",input,signal);},
    shutdown(){
      if(state.shutdownPromise!==null) return state.shutdownPromise;
      if(state.lifecycle==="open") state.lifecycle="shutdown";
      state.controller.abort();
      const created=state.client;
      state.shutdownPromise=(async()=>{if(created!==null) try {await created.close();} catch {/* closed and redacted */}})();
      return state.shutdownPromise;
    },
  });
  managerStates.set(manager,state);return manager;
}
export function detachAcademicSessionManagerInternal(manager:AcademicSessionManager,reason:"stale-generation"|"shutdown"):void {
  const state=managerState(manager);if(state.lifecycle!=="open") return;state.lifecycle=reason;state.controller.abort();
}
export function getAcademicSessionNormalizedOptionsInternal(manager:AcademicSessionManager):NormalizedAcquisitionOptionsInternal|null {return managerState(manager).normalized;}
