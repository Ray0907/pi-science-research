import { types as utilTypes } from "node:util";

import {
  createNodeRuntimeCapabilitiesInternal,
  getNodeRuntimeClockInternal,
  type NodeRuntimeCapabilitiesInternal,
} from "./node-pinned-hop-internal.js";

export interface RequestDeadlineTimerHandleInternal {
  readonly capabilityKind:"request-deadline-timer";
}
export interface RequestDeadlineSchedulerDescriptorInternal {
  readonly monotonicNow:()=>number;
  readonly setTimeout:(callback:()=>void,ms:number)=>unknown;
  readonly clearTimeout:(handle:unknown)=>void;
}
export interface RequestDeadlineSchedulerCapabilitiesInternal {
  readonly capabilityKind:"request-deadline-scheduler-capabilities";
  monotonicNow():number;
  setTimeout(callback:()=>void,ms:number):RequestDeadlineTimerHandleInternal;
  clearTimeout(handle:RequestDeadlineTimerHandleInternal):void;
}
export type RequestDeadlineErrorCodeInternal=
  | "request-deadline.invalid-options"
  | "request-deadline.invalid-capability"
  | "request-deadline.cancelled"
  | "request-deadline.expired"
  | "request-deadline.closed"
  | "request-deadline.replayed";
export class RequestDeadlineErrorInternal extends Error {
  readonly code:RequestDeadlineErrorCodeInternal;
  constructor(code:RequestDeadlineErrorCodeInternal){
    super(`Request deadline rejected (${code})`);
    this.name="RequestDeadlineErrorInternal";
    this.code=code;
  }
}
export interface RequestDeadlineInternal {
  readonly capabilityKind:"request-deadline";
  readonly signal:AbortSignal;
  remainingMs():number;
  throwIfExpired():void;
  close():void;
}

type SchedulerState={
  readonly monotonicNow:()=>number;
  readonly setTimeout:(callback:()=>void,ms:number)=>unknown;
  readonly clearTimeout:(handle:unknown)=>void;
  lastMonotonic:number;
};
type TimerState={readonly scheduler:object;readonly raw:unknown;active:boolean};
type DeadlineState={
  readonly scheduler:RequestDeadlineSchedulerCapabilitiesInternal;
  readonly controller:AbortController;
  deadlineAt:number;
  readonly callerSignal:AbortSignal|null;
  readonly callerListener:(()=>void)|null;
  timer:RequestDeadlineTimerHandleInternal|null;
  terminal:"cancelled"|"expired"|null;
  dispatching:boolean;
  open:boolean;
  owner:string|null;
};

const schedulerStates=new WeakMap<object,SchedulerState>();
const timerStates=new WeakMap<object,TimerState>();
const deadlineStates=new WeakMap<object,DeadlineState>();
const ABORTED_GETTER=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!;
const THROW_IF_ABORTED=AbortSignal.prototype.throwIfAborted;
const ADD_EVENT=EventTarget.prototype.addEventListener;
const REMOVE_EVENT=EventTarget.prototype.removeEventListener;

function fail(code:RequestDeadlineErrorCodeInternal):never{
  throw new RequestDeadlineErrorInternal(code);
}
function plainDescriptors(value:unknown,keys:readonly string[]):PropertyDescriptorMap{
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("request-deadline.invalid-capability");
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)fail("request-deadline.invalid-capability");
  let descriptors:PropertyDescriptorMap;
  try{descriptors=Object.getOwnPropertyDescriptors(value);}catch{return fail("request-deadline.invalid-capability");}
  const own=Reflect.ownKeys(descriptors);
  if(own.length!==keys.length||own.some((key)=>typeof key!=="string"||!keys.includes(key)))fail("request-deadline.invalid-capability");
  for(const key of keys){
    const descriptor=descriptors[key];
    if(!descriptor||!("value" in descriptor)||!descriptor.enumerable)fail("request-deadline.invalid-capability");
  }
  return descriptors;
}
function schedulerState(value:unknown):SchedulerState{
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("request-deadline.invalid-capability");
  const state=schedulerStates.get(value);
  if(!state||!Object.isFrozen(value)||(value as RequestDeadlineSchedulerCapabilitiesInternal).capabilityKind!=="request-deadline-scheduler-capabilities")fail("request-deadline.invalid-capability");
  return state;
}
function genuineSignal(value:unknown):{signal:AbortSignal;aborted:boolean}{
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("request-deadline.invalid-capability");
  let aborted:boolean;
  try{aborted=ABORTED_GETTER.call(value) as boolean;}catch{return fail("request-deadline.invalid-capability");}
  let threw=false;
  try{THROW_IF_ABORTED.call(value);}catch{threw=true;}
  if(threw!==aborted)fail("request-deadline.invalid-capability");
  return{signal:value as AbortSignal,aborted};
}
function latch(state:DeadlineState,reason:"cancelled"|"expired"):void{
  if(!state.open||state.terminal!==null)return;
  state.terminal=reason;
  state.dispatching=true;
  // Node writes native symbol fields during abort, so freezing must follow native dispatch.
  try{state.controller.abort();}catch{/* authentic owned controller failure is quarantined */}
  finally{state.dispatching=false;Object.freeze(state.controller.signal);}
}
function stateForDeadline(value:unknown,allowClosed=false):DeadlineState{
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("request-deadline.invalid-capability");
  const state=deadlineStates.get(value);
  if(!state||!Object.isFrozen(value)||(value as RequestDeadlineInternal).capabilityKind!=="request-deadline")fail("request-deadline.invalid-capability");
  genuineSignal(state.controller.signal);
  if((state.terminal!==null||!state.open)&&!state.dispatching&&!Object.isFrozen(state.controller.signal))fail("request-deadline.invalid-capability");
  if(!state.open&&!allowClosed)fail("request-deadline.closed");
  return state;
}

export function createRequestDeadlineSchedulerCapabilitiesInternal(
  descriptor:RequestDeadlineSchedulerDescriptorInternal,
):RequestDeadlineSchedulerCapabilitiesInternal{
  const descriptors=plainDescriptors(descriptor,["monotonicNow","setTimeout","clearTimeout"]);
  for(const key of ["monotonicNow","setTimeout","clearTimeout"]){
    if(typeof descriptors[key]!.value!=="function")fail("request-deadline.invalid-capability");
  }
  const state:SchedulerState={
    monotonicNow:descriptors.monotonicNow!.value as ()=>number,
    setTimeout:descriptors.setTimeout!.value as SchedulerState["setTimeout"],
    clearTimeout:descriptors.clearTimeout!.value as SchedulerState["clearTimeout"],
    lastMonotonic:-1,
  };
  const output:Object&RequestDeadlineSchedulerCapabilitiesInternal=Object.freeze({
    capabilityKind:"request-deadline-scheduler-capabilities" as const,
    monotonicNow(this:unknown){
      const current=schedulerState(this);
      let now:unknown;
      try{now=current.monotonicNow();}catch{return fail("request-deadline.invalid-capability");}
      if(typeof now!=="number"||!Number.isFinite(now)||now<0||now<current.lastMonotonic)fail("request-deadline.invalid-capability");
      current.lastMonotonic=now;
      return now;
    },
    setTimeout(this:unknown,callback:()=>void,ms:number){
      const current=schedulerState(this);
      if(typeof callback!=="function"||typeof ms!=="number"||!Number.isSafeInteger(ms)||ms<0||ms>300_000)fail("request-deadline.invalid-capability");
      let raw:unknown;
      try{raw=current.setTimeout(callback,ms);}catch{return fail("request-deadline.invalid-capability");}
      const handle=Object.freeze({capabilityKind:"request-deadline-timer" as const});
      timerStates.set(handle,{scheduler:this as object,raw,active:true});
      return handle;
    },
    clearTimeout(this:unknown,handle:RequestDeadlineTimerHandleInternal){
      const current=schedulerState(this);
      if(handle===null||typeof handle!=="object"||utilTypes.isProxy(handle))fail("request-deadline.invalid-capability");
      const timer=timerStates.get(handle);
      if(!timer||timer.scheduler!==this)fail("request-deadline.invalid-capability");
      if(!timer.active)return;
      timer.active=false;
      try{current.clearTimeout(timer.raw);}catch{return fail("request-deadline.invalid-capability");}
    },
  });
  schedulerStates.set(output,state);
  return output;
}
export function createNodeRequestDeadlineSchedulerCapabilitiesInternal(
  runtime:NodeRuntimeCapabilitiesInternal=createNodeRuntimeCapabilitiesInternal(),
):RequestDeadlineSchedulerCapabilitiesInternal{
  const clock=getNodeRuntimeClockInternal(runtime);
  return createRequestDeadlineSchedulerCapabilitiesInternal({
    monotonicNow:clock.monotonicNow,
    setTimeout:clock.setTimer,
    clearTimeout:clock.clearTimer,
  });
}
export function createRequestDeadlineInternal(
  totalRequestDeadlineMs:number,
  scheduler:RequestDeadlineSchedulerCapabilitiesInternal,
  callerSignal?:AbortSignal,
):RequestDeadlineInternal{
  if(typeof totalRequestDeadlineMs!=="number"||!Number.isSafeInteger(totalRequestDeadlineMs)||totalRequestDeadlineMs<1||totalRequestDeadlineMs>300_000)fail("request-deadline.invalid-options");
  schedulerState(scheduler);
  const caller=callerSignal===undefined?null:genuineSignal(callerSignal);
  const controller=new AbortController();
  let output!:RequestDeadlineInternal;
  const callerListener=caller===null?null:()=>{const state=deadlineStates.get(output);if(state)latch(state,"cancelled");};
  const state:DeadlineState={scheduler,controller,deadlineAt:0,callerSignal:caller?.signal??null,callerListener,timer:null,terminal:null,dispatching:false,open:true,owner:null};
  output=Object.freeze({
    capabilityKind:"request-deadline" as const,
    signal:controller.signal,
    remainingMs(this:unknown){
      const current=stateForDeadline(this);
      return Math.max(0,Math.ceil(current.deadlineAt-current.scheduler.monotonicNow()));
    },
    throwIfExpired(this:unknown){
      const current=stateForDeadline(this);
      if(current.terminal===null&&current.scheduler.monotonicNow()>=current.deadlineAt)latch(current,"expired");
      if(current.terminal==="cancelled")fail("request-deadline.cancelled");
      if(current.terminal==="expired")fail("request-deadline.expired");
    },
    close(this:unknown){
      const current=stateForDeadline(this,true);
      if(!current.open)return;
      current.open=false;
      const timer=current.timer;current.timer=null;
      let cleanupError:unknown;
      try{if(timer)current.scheduler.clearTimeout(timer);}catch(error){cleanupError=error;}
      finally{
        if(current.callerSignal&&current.callerListener){try{REMOVE_EVENT.call(current.callerSignal,"abort",current.callerListener);}catch{/* quarantine */}}
        Object.freeze(current.controller.signal);
      }
      if(cleanupError!==undefined)throw cleanupError;
    },
  });
  deadlineStates.set(output,state);
  if(caller&&callerListener){
    try{ADD_EVENT.call(caller.signal,"abort",callerListener,{once:true});}catch{state.open=false;Object.freeze(controller.signal);return fail("request-deadline.invalid-capability");}
    if(ABORTED_GETTER.call(caller.signal) as boolean)latch(state,"cancelled");
  }
  let start:number;
  try{start=scheduler.monotonicNow();}catch(error){output.close();throw error;}
  state.deadlineAt=start+totalRequestDeadlineMs;
  if(!Number.isFinite(state.deadlineAt)||state.deadlineAt>Number.MAX_SAFE_INTEGER){output.close();fail("request-deadline.invalid-capability");}
  if(caller&&(ABORTED_GETTER.call(caller.signal) as boolean))latch(state,"cancelled");
  if(state.terminal!==null){if(caller&&callerListener)try{REMOVE_EVENT.call(caller.signal,"abort",callerListener);}catch{/* quarantine */}return output;}
  let timer:RequestDeadlineTimerHandleInternal;
  try{timer=scheduler.setTimeout(()=>latch(state,"expired"),totalRequestDeadlineMs);}catch(error){output.close();throw error;}
  state.timer=timer;
  if(caller&&(ABORTED_GETTER.call(caller.signal) as boolean))latch(state,"cancelled");
  if(state.terminal!==null){state.timer=null;try{scheduler.clearTimeout(timer);}finally{if(caller&&callerListener)try{REMOVE_EVENT.call(caller.signal,"abort",callerListener);}catch{/* quarantine */}}}
  return output;
}
export function assertRequestDeadlineInternal(value:unknown):asserts value is RequestDeadlineInternal{stateForDeadline(value);}
export function claimRequestDeadlineInternal(deadline:RequestDeadlineInternal,requestOwnerId:`transport-request-v1-${string}`):void{
  const state=stateForDeadline(deadline);
  if(typeof requestOwnerId!=="string"||!/^transport-request-v1-[A-Za-z0-9._-]+$/u.test(requestOwnerId))fail("request-deadline.invalid-capability");
  if(state.owner!==null)fail("request-deadline.replayed");
  state.owner=requestOwnerId;
}
export function assertRequestDeadlineOwnedByInternal(deadline:RequestDeadlineInternal,requestOwnerId:`transport-request-v1-${string}`):void{
  const state=stateForDeadline(deadline);
  if(state.owner!==requestOwnerId)fail("request-deadline.replayed");
}
