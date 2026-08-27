import { describe, expect, test, vi } from "vitest";

import {
  RequestDeadlineErrorInternal,
  assertRequestDeadlineInternal,
  assertRequestDeadlineOwnedByInternal,
  assertRequestDeadlineSchedulerCapabilitiesInternal,
  claimRequestDeadlineInternal,
  createRequestDeadlineInternal,
  createRequestDeadlineSchedulerCapabilitiesInternal,
} from "../../src/acquisition/request-deadline-internal.js";

function errorCode(action:()=>unknown):string|undefined { try{action();}catch(error){expect(error).toBeInstanceOf(RequestDeadlineErrorInternal);expect((error as Error).message).toMatch(/^Request deadline rejected \(request-deadline\.[a-z-]+\)$/u);return (error as RequestDeadlineErrorInternal).code;}return undefined; }
function fakeScheduler() { let now=100;let next=0;const timers=new Map<number,()=>void>();const cleared:number[]=[];const scheduler=createRequestDeadlineSchedulerCapabilitiesInternal({monotonicNow:()=>now,setTimeout:(callback)=>{const id=++next;timers.set(id,callback);return id;},clearTimeout:(id)=>{cleared.push(id as number);timers.delete(id as number);}});return {scheduler,timers,cleared,setNow:(value:number)=>{now=value;}}; }

describe("request deadline lifecycle",()=>{
  test("creates one frozen branded absolute request deadline and clears its timer once",()=>{
    const fake=fakeScheduler();const deadline=createRequestDeadlineInternal(100,fake.scheduler);
    expect(Object.isFrozen(deadline)).toBe(true);expect(deadline.signal).toBeInstanceOf(AbortSignal);expect(Object.isFrozen(deadline.signal)).toBe(false);expect(fake.timers.size).toBe(1);expect(deadline.remainingMs()).toBe(100);
    fake.setNow(150.2);expect(deadline.remainingMs()).toBe(50);const lateTimer=[...fake.timers.values()][0]!;deadline.close();deadline.close();lateTimer();expect(Object.isFrozen(deadline.signal)).toBe(true);expect(deadline.signal.aborted).toBe(false);expect(fake.cleared).toHaveLength(1);expect(errorCode(()=>deadline.remainingMs())).toBe("request-deadline.closed");expect([...fake.timers.values()]).toHaveLength(0);
    expect(errorCode(()=>createRequestDeadlineInternal(300_001,fake.scheduler))).toBe("request-deadline.invalid-options");
  });

  test("installs caller cancellation before reentrant clocks and timer allocation",()=>{
    const callerDuringClock=new AbortController();let timerCalls=0;const clockScheduler=createRequestDeadlineSchedulerCapabilitiesInternal({monotonicNow:()=>{callerDuringClock.abort();return 10;},setTimeout:()=>{timerCalls+=1;return 1;},clearTimeout:()=>undefined});const fromClock=createRequestDeadlineInternal(100,clockScheduler,callerDuringClock.signal);expect(timerCalls).toBe(0);expect(errorCode(()=>fromClock.throwIfExpired())).toBe("request-deadline.cancelled");expect(Object.isFrozen(fromClock.signal)).toBe(true);
    const callerDuringTimer=new AbortController();const cleared:number[]=[];const timerScheduler=createRequestDeadlineSchedulerCapabilitiesInternal({monotonicNow:()=>10,setTimeout:()=>{callerDuringTimer.abort();return 7;},clearTimeout:(handle)=>{cleared.push(handle as number);}});const fromTimer=createRequestDeadlineInternal(100,timerScheduler,callerDuringTimer.signal);expect(errorCode(()=>fromTimer.throwIfExpired())).toBe("request-deadline.cancelled");expect(cleared).toEqual([7]);expect(Object.isFrozen(fromTimer.signal)).toBe(true);
  });

  test("close quarantines listeners timers and signal even when timer cleanup throws",()=>{const caller=new AbortController();const scheduler=createRequestDeadlineSchedulerCapabilitiesInternal({monotonicNow:()=>10,setTimeout:()=>1,clearTimeout:()=>{throw new Error("SECRET");}});const deadline=createRequestDeadlineInternal(100,scheduler,caller.signal);expect(errorCode(()=>deadline.close())).toBe("request-deadline.invalid-capability");expect(Object.isFrozen(deadline.signal)).toBe(true);expect(deadline.signal.aborted).toBe(false);caller.abort();expect(deadline.signal.aborted).toBe(false);expect(()=>deadline.close()).not.toThrow();expect(errorCode(()=>deadline.throwIfExpired())).toBe("request-deadline.closed");});

  test("preserves first caller-cancel versus deadline reason and rejects forged cross-owner replayed closed deadlines",()=>{
    const callerFirst=fakeScheduler();const caller=new AbortController();const a=createRequestDeadlineInternal(10,callerFirst.scheduler,caller.signal);let abortEvents=0;let dispatchCode:string|undefined;a.signal.addEventListener("abort",()=>{abortEvents+=1;expect(Object.isFrozen(a.signal)).toBe(false);try{a.throwIfExpired();}catch(error){dispatchCode=(error as RequestDeadlineErrorInternal).code;}});caller.abort(new Error("SECRET"));expect(abortEvents).toBe(1);expect(dispatchCode).toBe("request-deadline.cancelled");expect(a.signal.aborted).toBe(true);expect(Object.isFrozen(a.signal)).toBe(true);callerFirst.setNow(111);for(const callback of callerFirst.timers.values())callback();expect(abortEvents).toBe(1);expect(errorCode(()=>a.throwIfExpired())).toBe("request-deadline.cancelled");
    const timerFirst=fakeScheduler();const laterCaller=new AbortController();const b=createRequestDeadlineInternal(10,timerFirst.scheduler,laterCaller.signal);timerFirst.setNow(111);for(const callback of timerFirst.timers.values())callback();expect(b.signal.aborted).toBe(true);expect(Object.isFrozen(b.signal)).toBe(true);laterCaller.abort();expect(errorCode(()=>b.throwIfExpired())).toBe("request-deadline.expired");
    claimRequestDeadlineInternal(b,"transport-request-v1-owner-a");expect(errorCode(()=>claimRequestDeadlineInternal(b,"transport-request-v1-owner-a"))).toBe("request-deadline.replayed");expect(errorCode(()=>assertRequestDeadlineOwnedByInternal(b,"transport-request-v1-owner-b"))).toBe("request-deadline.replayed");
    expect(errorCode(()=>assertRequestDeadlineInternal({ ...b }))).toBe("request-deadline.invalid-capability");b.close();expect(errorCode(()=>assertRequestDeadlineInternal(b))).toBe("request-deadline.closed");
    const getter=Object.defineProperty({},"monotonicNow",{enumerable:true,get(){throw new Error("SECRET");}});expect(errorCode(()=>createRequestDeadlineSchedulerCapabilitiesInternal(getter as never))).toBe("request-deadline.invalid-capability");
    let methodCalls=0;const branded=createRequestDeadlineSchedulerCapabilitiesInternal({monotonicNow:()=>{methodCalls+=1;return 1;},setTimeout:()=>{methodCalls+=1;return 1;},clearTimeout:()=>{methodCalls+=1;}});assertRequestDeadlineSchedulerCapabilitiesInternal(branded);expect(methodCalls).toBe(0);expect(errorCode(()=>assertRequestDeadlineSchedulerCapabilitiesInternal(Object.freeze({...branded})))).toBe("request-deadline.invalid-capability");let traps=0;const proxy=new Proxy(branded,{get(){traps+=1;throw new Error("SECRET");}});expect(errorCode(()=>assertRequestDeadlineSchedulerCapabilitiesInternal(proxy))).toBe("request-deadline.invalid-capability");expect(traps).toBe(0);expect(methodCalls).toBe(0);
  });
});
