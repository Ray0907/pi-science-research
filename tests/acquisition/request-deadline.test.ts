import { describe, expect, test, vi } from "vitest";

import {
  RequestDeadlineErrorInternal,
  assertRequestDeadlineInternal,
  assertRequestDeadlineOwnedByInternal,
  claimRequestDeadlineInternal,
  createRequestDeadlineInternal,
  createRequestDeadlineSchedulerCapabilitiesInternal,
} from "../../src/acquisition/request-deadline-internal.js";

function errorCode(action:()=>unknown):string|undefined { try{action();}catch(error){expect(error).toBeInstanceOf(RequestDeadlineErrorInternal);expect((error as Error).message).toMatch(/^Request deadline rejected \(request-deadline\.[a-z-]+\)$/u);return (error as RequestDeadlineErrorInternal).code;}return undefined; }
function fakeScheduler() { let now=100;let next=0;const timers=new Map<number,()=>void>();const cleared:number[]=[];const scheduler=createRequestDeadlineSchedulerCapabilitiesInternal({monotonicNow:()=>now,setTimeout:(callback)=>{const id=++next;timers.set(id,callback);return id;},clearTimeout:(id)=>{cleared.push(id as number);timers.delete(id as number);}});return {scheduler,timers,cleared,setNow:(value:number)=>{now=value;}}; }

describe("request deadline lifecycle",()=>{
  test("creates one frozen branded absolute request deadline and clears its timer once",()=>{
    const fake=fakeScheduler();const deadline=createRequestDeadlineInternal(100,fake.scheduler);
    expect(Object.isFrozen(deadline)).toBe(true);expect(deadline.signal).toBeInstanceOf(AbortSignal);expect(fake.timers.size).toBe(1);expect(deadline.remainingMs()).toBe(100);
    fake.setNow(150.2);expect(deadline.remainingMs()).toBe(50);deadline.close();deadline.close();expect(fake.cleared).toHaveLength(1);expect(errorCode(()=>deadline.remainingMs())).toBe("request-deadline.closed");expect([...fake.timers.values()]).toHaveLength(0);
    expect(errorCode(()=>createRequestDeadlineInternal(300_001,fake.scheduler))).toBe("request-deadline.invalid-options");
  });

  test("preserves first caller-cancel versus deadline reason and rejects forged cross-owner replayed closed deadlines",()=>{
    const callerFirst=fakeScheduler();const caller=new AbortController();const a=createRequestDeadlineInternal(10,callerFirst.scheduler,caller.signal);caller.abort(new Error("SECRET"));callerFirst.setNow(111);for(const callback of callerFirst.timers.values())callback();expect(errorCode(()=>a.throwIfExpired())).toBe("request-deadline.cancelled");
    const timerFirst=fakeScheduler();const laterCaller=new AbortController();const b=createRequestDeadlineInternal(10,timerFirst.scheduler,laterCaller.signal);timerFirst.setNow(111);for(const callback of timerFirst.timers.values())callback();laterCaller.abort();expect(errorCode(()=>b.throwIfExpired())).toBe("request-deadline.expired");
    claimRequestDeadlineInternal(b,"transport-request-v1-owner-a");expect(errorCode(()=>claimRequestDeadlineInternal(b,"transport-request-v1-owner-a"))).toBe("request-deadline.replayed");expect(errorCode(()=>assertRequestDeadlineOwnedByInternal(b,"transport-request-v1-owner-b"))).toBe("request-deadline.replayed");
    expect(errorCode(()=>assertRequestDeadlineInternal({ ...b }))).toBe("request-deadline.invalid-capability");b.close();expect(errorCode(()=>assertRequestDeadlineInternal(b))).toBe("request-deadline.closed");
    const getter=Object.defineProperty({},"monotonicNow",{enumerable:true,get(){throw new Error("SECRET");}});expect(errorCode(()=>createRequestDeadlineSchedulerCapabilitiesInternal(getter as never))).toBe("request-deadline.invalid-capability");
  });
});
