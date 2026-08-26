import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { FoundationEventPayload, FoundationEventType, FoundationLedgerEvent } from "../../src/domain/events.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import { recoveryDecisionFor, reduceLedgerEvents } from "../../src/domain/reducer.js";
import { openEventLedger, type EventLedger } from "../../src/storage/event-ledger.js";
import {
  RetryStoreError,
  assertRetryContinuation,
  cancelRetryEpoch,
  createRetryController,
  recoverRetryState,
  scheduleRetry,
  startNewLogicalOperation,
  startScheduledRetry,
  type RetryPolicy,
} from "../../src/storage/retry-store.js";

const AT = new Date("2026-08-25T12:00:00.000Z");
const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RUN_ID = "run-0000000000000001";
const TASK_ID = "task-0000000000000001";
const ATTEMPT_1 = "attempt-0000000000000001";
const ATTEMPT_2 = "attempt-0000000000000002";
const RETRY_1 = "retry-0000000000000001";
const RETRY_2 = "retry-0000000000000002";
const LOGICAL = "operation-primary";
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function runSnapshot(): RunSnapshot {
  return {
    schemaVersion: 1, runId: RUN_ID, revision: 1, question: "question", language: "en", depth: "standard",
    reproducible: false, allowCalculations: false, calculationPolicySha256: null, state: "created", checkpointStage: null,
    executionEpoch: 0, outputRoot: "research/run",
    roleModels: { coordinator: "provider/model", researcher: "provider/model", verifier: "provider/model" },
    roleThinking: { coordinator: "medium", researcher: "medium", verifier: "medium" },
    budget: { activeTimeLimitMs: 3_600_000, activeTimeUsedMs: 0, finalizationReserveMs: 600_000, maxSources: 20, admittedSources: 0, maxWaves: 3, waveOrdinal: 0 },
    taskRefs: [], attemptRefs: [], acceptedVerificationRef: null, currentRevisionId: null, blocker: null,
    createdAt: AT.toISOString(), updatedAt: AT.toISOString(), completedAt: null,
  };
}

function taskRecord(): TaskRecord {
  return {
    schemaVersion: 1, taskId: TASK_ID, revision: 1, description: "research",
    evidenceRule: { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: false, fullTextRequired: false },
    role: "literature-searcher", state: "running", attemptIds: [], blocker: null, resolution: null,
  };
}

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    schemaVersion: 1, attemptId: ATTEMPT_1, revision: 1, runId: RUN_ID, taskId: TASK_ID, executionEpoch: 0,
    logicalOperationId: LOGICAL, attemptOrdinal: 1, retryOfAttemptId: null, attemptKind: "research", replayPolicy: "safe-read",
    state: "intent-recorded", providerModel: "provider/model", thinkingLevel: "medium", promptTemplateSha256: HASH,
    renderedPromptSha256: HASH, logicalInputSha256: HASH, attemptEnvelopeSha256: HASH_B, toolAllowlist: ["scholarly_search"],
    deadlineAt: "2026-08-25T13:00:00.000Z", capabilityId: "capability", resultSha256: null, billingStatus: "unknown",
    reportedUsage: null, error: null, createdAt: AT.toISOString(), updatedAt: AT.toISOString(), ...overrides,
  };
}

function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000,
    retryAfterMs: null, reasonClass: "transient", scheduleId: () => RETRY_1,
    attemptId: () => ATTEMPT_2, ...overrides,
  };
}

async function newLedger(): Promise<EventLedger> {
  return (await newLedgerWithPath()).ledger;
}

async function newLedgerWithPath(): Promise<{ ledger: EventLedger; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "retry-store-"));
  roots.push(root);
  const path = join(root, "events.jsonl");
  let event = 0;
  return { path, ledger: await openEventLedger(path, { now: () => AT, eventId: () => `event-${++event}` }) };
}

async function seedFailed(ledger: EventLedger, attempt = attemptRecord(), failure: "retryable-failed" | "terminal-failed" | "cancelled" | "superseded" = "retryable-failed"): Promise<void> {
  await ledger.append("run_created", { run: runSnapshot() });
  await ledger.append("state_changed", { from: "created", to: "planning", blocker: null });
  await ledger.append("state_changed", { from: "planning", to: "researching", blocker: null });
  await ledger.append("task_upserted", { task: taskRecord() });
  await ledger.reserveIdentity("attempt", attempt.attemptId, "parent-generated");
  await ledger.append("dispatch_intent", { attempt });
  await ledger.append("dispatch_started", { attemptId: attempt.attemptId, pid: 1, requestCorrelation: null });
  if (failure === "superseded") throw new Error("superseded requires replacement fixture");
  await ledger.append("attempt_failed", { attemptId: attempt.attemptId, state: failure, errorClass: "transient", message: "safe" });
}

async function expectRetryError(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ name: "RetryStoreError", code });
  await expect(action).rejects.not.toThrow(/capability|secret/i);
}

class EventBuilder {
  readonly values: FoundationLedgerEvent[] = [];
  add<T extends FoundationEventType>(type: T, payload: FoundationEventPayload<T>): FoundationLedgerEvent {
    const seq = this.values.length + 1;
    const event = { schemaVersion: 1, seq, occurredAt: AT.toISOString(), eventId: `large-${seq}`, type, payload, prevSha256: HASH, entrySha256: HASH } as FoundationLedgerEvent;
    this.values.push(event);
    return event;
  }
}

describe("durable retry scheduling", () => {
  test("writes RED-required absolute full-jitter schedule after reserving its globally unique ID", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    const result = await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0.5);
    expect(result).toMatchObject({ kind: "scheduled", schedule: { scheduleId: RETRY_1, nextAttemptOrdinal: 2, delayMs: 500, notBeforeAt: "2026-08-25T12:00:00.500Z" } });
    const events = await ledger.readAll();
    expect(events.slice(-2).map((event) => event.type)).toEqual(["identity_reserved", "retry_scheduled"]);
    expect(events.at(-1)?.payload).toMatchObject({ scheduleId: RETRY_1 });
    await ledger.close();
  });

  test("counts ordinal one and persists exhaustion across reopen without consulting RNG", async () => {
    const { ledger, path } = await newLedgerWithPath();
    await seedFailed(ledger);
    const exhausted = await scheduleRetry(ledger, attemptRecord(), policy({ maxAttempts: 1 }), AT, () => { throw new Error("must not draw"); });
    expect(exhausted).toEqual({ kind: "blocked", code: "retry-attempts-exhausted", attemptsUsed: 1, maxAttempts: 1 });
    expect((await ledger.readAll()).some((event) => event.type === "retry_scheduled")).toBe(false);
    await ledger.close();
    const reopened = await openEventLedger(path);
    expect(await scheduleRetry(reopened, attemptRecord(), policy({ maxAttempts: 1 }), AT, () => 0)).toEqual(exhausted);
    await reopened.close();
  });

  test("reopen preserves the exact absolute schedule and backoff instead of drawing again", async () => {
    const { ledger, path } = await newLedgerWithPath();
    await seedFailed(ledger);
    const scheduled = await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0.75);
    await ledger.close();
    const reopened = await openEventLedger(path);
    const repeated = await scheduleRetry(reopened, attemptRecord(), policy({ scheduleId: () => "retry-0000000000009999" }), new Date("2026-08-25T12:00:10.000Z"), () => { throw new Error("must not redraw"); });
    expect(repeated).toMatchObject({ kind: "already-scheduled", schedule: (scheduled as { schedule: unknown }).schedule });
    await reopened.close();
  });

  test.each(["never", "terminal-failed", "cancelled", "running", "committed", "superseded"])("rejects an ineligible %s predecessor", async (state) => {
    const ledger = await newLedger();
    const attempt = attemptRecord({ replayPolicy: state === "never" ? "never" : "safe-read", attemptKind: state === "never" ? "calculation" : "research", billingStatus: state === "never" ? "not-applicable" : "unknown" });
    if (state === "terminal-failed" || state === "cancelled") await seedFailed(ledger, attempt, state);
    else if (state === "running" || state === "committed" || state === "superseded") {
      await seedFailed(ledger, attempt);
      // Canonical history remains retryable-failed; a caller cannot masquerade with a changed state.
      attempt.state = state;
    } else if (state === "never") await seedFailed(ledger, attempt);
    else await seedFailed(ledger, attempt);
    await expectRetryError(scheduleRetry(ledger, attempt, policy(), AT, () => 0), state === "never" ? "retry.nonreplayable" : "retry.predecessor");
    await ledger.close();
  });

  test("uses overflow-safe capped full jitter and a larger Retry-After before budget caps", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger, attemptRecord({ attemptOrdinal: 1 }));
    const result = await scheduleRetry(ledger, attemptRecord(), policy({ baseDelayMs: Number.MAX_SAFE_INTEGER, maxDelayMs: 20_000, retryAfterMs: 15_000 }), AT, () => 0.25);
    expect(result).toMatchObject({ kind: "scheduled", schedule: { delayMs: 15_000, notBeforeAt: "2026-08-25T12:00:15.000Z" } });
    await ledger.close();
  });

  test("rejects invalid RNG and invalid Retry-After consistently", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await expectRetryError(scheduleRetry(ledger, attemptRecord(), policy({ retryAfterMs: -1 }), AT, () => 0), "retry.policy");
    await expectRetryError(scheduleRetry(ledger, attemptRecord(), policy(), AT, () => Number.NaN), "retry.rng");
    await ledger.close();
  });

  test("derives active budget from canonical checkpoints and preserves the finalization reserve", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await ledger.append("active_time_checkpoint", {
      ownerTokenSha256: HASH, intervalStartedAt: AT.toISOString(), intervalEndedAt: "2026-08-25T12:49:58.000Z",
      addedMs: 2_998_000, totalMs: 2_998_000,
    });
    const capped = await scheduleRetry(ledger, attemptRecord(), policy({ baseDelayMs: 30_000 }), AT, () => 1);
    expect(capped).toMatchObject({ kind: "scheduled", schedule: { delayMs: 2_000 } });
    await ledger.close();
  });

  test("uses the latest canonical budget amendment after reopen and rejects exhausted budget", async () => {
    const { ledger, path } = await newLedgerWithPath();
    await seedFailed(ledger);
    await ledger.append("active_time_checkpoint", {
      ownerTokenSha256: HASH, intervalStartedAt: AT.toISOString(), intervalEndedAt: "2026-08-25T12:08:00.000Z", addedMs: 480_000, totalMs: 480_000,
    });
    const oldBudget = { ...runSnapshot().budget, activeTimeUsedMs: 480_000 };
    const newBudget = { ...oldBudget, activeTimeLimitMs: 600_000, finalizationReserveMs: 120_000 };
    await ledger.append("budget_amended", { oldBudget, newBudget, operatorSource: "tui", reason: "smaller budget" });
    await ledger.close();
    const reopened = await openEventLedger(path);
    expect(await scheduleRetry(reopened, attemptRecord(), policy(), AT, () => 0)).toEqual({ kind: "blocked", code: "retry-budget-exhausted" });
    expect((await reopened.readAll()).some((event) => event.type === "retry_scheduled")).toBe(false);
    await reopened.close();
  });

  test("starts only when due, reserves the new attempt, and recovers the same crash-prefix descriptor", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 1);
    expect(await startScheduledRetry(ledger, RETRY_1, new Date("2026-08-25T12:00:00.999Z"), policy())).toMatchObject({ kind: "not-ready", notBeforeAt: "2026-08-25T12:00:01.000Z" });
    const started = await startScheduledRetry(ledger, RETRY_1, new Date("2026-08-25T12:00:01.000Z"), policy());
    expect(started).toMatchObject({ kind: "started", descriptor: { scheduleId: RETRY_1, attemptId: ATTEMPT_2, attemptOrdinal: 2, retryOfAttemptId: ATTEMPT_1, logicalOperationId: LOGICAL, logicalInputSha256: HASH } });
    const events = await ledger.readAll();
    expect(events.slice(-2).map((event) => event.type)).toEqual(["identity_reserved", "retry_started"]);
    expect(recoveryDecisionFor(reduceLedgerEvents(events), LOGICAL)).toMatchObject({ kind: "resume-started-retry", attemptId: ATTEMPT_2, attemptOrdinal: 2 });
    expect(await startScheduledRetry(ledger, RETRY_1, new Date("2026-08-25T12:00:02.000Z"), policy())).toMatchObject({ kind: "already-started", descriptor: { attemptId: ATTEMPT_2 } });
    await ledger.close();
  });

  test("start re-evaluates canonical budget and deadline before appending any start", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 1);
    await ledger.append("active_time_checkpoint", {
      ownerTokenSha256: HASH, intervalStartedAt: AT.toISOString(), intervalEndedAt: "2026-08-25T12:50:00.000Z",
      addedMs: 3_000_000, totalMs: 3_000_000,
    });
    const before = (await ledger.readAll()).length;
    expect(await startScheduledRetry(ledger, RETRY_1, new Date("2026-08-25T12:00:01.000Z"), policy())).toEqual({ kind: "blocked", code: "retry-budget-exhausted" });
    expect((await ledger.readAll()).length).toBe(before);
    await ledger.close();

    const deadlineLedger = await newLedger();
    await seedFailed(deadlineLedger);
    await scheduleRetry(deadlineLedger, attemptRecord(), policy(), AT, () => 0);
    expect(await startScheduledRetry(deadlineLedger, RETRY_1, new Date("2026-08-25T13:00:00.000Z"), policy())).toEqual({ kind: "blocked", code: "retry-deadline-exhausted" });
    await deadlineLedger.close();
  });

  test("start uses a checkpointed and amended canonical budget after reopen", async () => {
    const { ledger, path } = await newLedgerWithPath();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    await ledger.append("active_time_checkpoint", {
      ownerTokenSha256: HASH, intervalStartedAt: AT.toISOString(), intervalEndedAt: "2026-08-25T12:08:00.000Z", addedMs: 480_000, totalMs: 480_000,
    });
    const oldBudget = { ...runSnapshot().budget, activeTimeUsedMs: 480_000 };
    await ledger.append("budget_amended", {
      oldBudget, newBudget: { ...oldBudget, activeTimeLimitMs: 600_000, finalizationReserveMs: 120_000 }, operatorSource: "json", reason: "canonical amendment",
    });
    await ledger.close();
    const reopened = await openEventLedger(path);
    const before = (await reopened.readAll()).length;
    expect(await startScheduledRetry(reopened, RETRY_1, AT, policy())).toEqual({ kind: "blocked", code: "retry-budget-exhausted" });
    expect((await reopened.readAll()).length).toBe(before);
    await reopened.close();
  });

  test("reconstructs immutable pending, started and cancelled schedule states in O(events) input semantics", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 1);
    let state = recoverRetryState(await ledger.readAll());
    expect(state.schedules[RETRY_1]).toMatchObject({ status: "pending", sourceSeq: 10, executionEpoch: 0, nextAttemptOrdinal: 2 });
    expect(Object.isFrozen(state.schedules)).toBe(true);
    await ledger.append("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    state = recoverRetryState(await ledger.readAll());
    expect(state.schedules[RETRY_1]).toMatchObject({ status: "cancelled", startedAttemptId: null });
    await ledger.close();
  });

  test("cancellation wins when it is ordered before start by the controller boundary", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    const controller = createRetryController(ledger);
    const cancelFirst = controller.cancel(0, "user-pause");
    const startSecond = controller.start(RETRY_1, AT, policy());
    await expect(cancelFirst).resolves.toMatchObject({ type: "cancel_requested" });
    await expect(startSecond).resolves.toEqual({ kind: "cancelled", executionEpoch: 0 });
    expect((await ledger.readAll()).some((event) => event.type === "retry_started")).toBe(false);
    await ledger.close();
  });

  test("cancellation permanently quarantines crash-after-start work across resume", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    await startScheduledRetry(ledger, RETRY_1, AT, policy());
    const cancel = await cancelRetryEpoch(ledger, 0, "user-pause");
    expect(recoverRetryState(await ledger.readAll()).schedules[RETRY_1]).toMatchObject({ status: "cancelled", startedAttemptId: ATTEMPT_2 });
    expect(await startScheduledRetry(ledger, RETRY_1, AT, policy())).toEqual({ kind: "cancelled", executionEpoch: 0 });
    await ledger.append("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    expect(recoverRetryState(await ledger.readAll()).schedules[RETRY_1]).toMatchObject({ status: "cancelled", executionEpoch: 0 });
    expect(await startScheduledRetry(ledger, RETRY_1, AT, policy())).toEqual({ kind: "cancelled", executionEpoch: 0 });
    await ledger.close();
  });

  test("cancel-before-schedule blocks until resume, then creates an epoch-bound replacement", async () => {
    const { ledger, path } = await newLedgerWithPath();
    await seedFailed(ledger);
    const cancel = await cancelRetryEpoch(ledger, 0, "user-pause");
    const before = (await ledger.readAll()).length;
    expect(await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0)).toEqual({ kind: "cancelled", executionEpoch: 0 });
    expect((await ledger.readAll()).length).toBe(before);
    await ledger.append("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    expect(await scheduleRetry(ledger, attemptRecord(), policy({ scheduleId: () => RETRY_2 }), AT, () => 0)).toMatchObject({ kind: "scheduled", schedule: { scheduleId: RETRY_2 } });
    expect(recoverRetryState(await ledger.readAll()).schedules[RETRY_2]).toMatchObject({ status: "pending", executionEpoch: 1 });
    const started = await startScheduledRetry(ledger, RETRY_2, AT, policy());
    expect(started).toMatchObject({ kind: "started", descriptor: { executionEpoch: 1, retryOfAttemptId: ATTEMPT_1, logicalOperationId: LOGICAL } });
    await cancelRetryEpoch(ledger, 1, "user-pause");
    expect(recoverRetryState(await ledger.readAll()).schedules[RETRY_2]).toMatchObject({ status: "cancelled", executionEpoch: 1, startedAttemptId: ATTEMPT_2 });
    await ledger.close();
    const reopened = await openEventLedger(path);
    expect(await startScheduledRetry(reopened, RETRY_2, AT, policy())).toEqual({ kind: "cancelled", executionEpoch: 1 });
    expect(await scheduleRetry(reopened, attemptRecord(), policy(), AT, () => 0)).toEqual({ kind: "cancelled", executionEpoch: 1 });
    await reopened.close();
  });

  test("resume never revives an old schedule and permits one fresh current-epoch edge", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    const cancel = await cancelRetryEpoch(ledger, 0, "user-pause");
    await ledger.append("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    expect(await startScheduledRetry(ledger, RETRY_1, AT, policy())).toEqual({ kind: "cancelled", executionEpoch: 0 });
    const replacement = await scheduleRetry(ledger, attemptRecord(), policy({ scheduleId: () => RETRY_2 }), AT, () => 0);
    expect(replacement).toMatchObject({ kind: "scheduled", schedule: { scheduleId: RETRY_2 } });
    expect(await scheduleRetry(ledger, attemptRecord(), policy({ scheduleId: () => "retry-0000000000000003" }), AT, () => 0)).toMatchObject({ kind: "already-scheduled", schedule: { scheduleId: RETRY_2 } });
    expect(recoverRetryState(await ledger.readAll()).schedules).toMatchObject({
      [RETRY_1]: { status: "cancelled", executionEpoch: 0 },
      [RETRY_2]: { status: "pending", executionEpoch: 1 },
    });
    await ledger.close();
  });

  test("canonical epoch validation rejects no-run, future, stale, negative, and duplicate cancellation without appending", async () => {
    const empty = await newLedger();
    await expect(cancelRetryEpoch(empty, 0, "user-pause")).rejects.toMatchObject({ code: "retry.cancel-epoch" });
    expect(await empty.readAll()).toEqual([]);
    await empty.close();

    const ledger = await newLedger();
    await seedFailed(ledger);
    const first = createRetryController(ledger);
    const second = createRetryController(ledger);
    const before = (await ledger.readAll()).length;
    const [future, current] = await Promise.allSettled([
      first.cancel(1, "user-pause"),
      second.cancel(0, "user-pause"),
    ]);
    expect(future).toMatchObject({ status: "rejected", reason: { code: "retry.cancel-epoch" } });
    expect(current).toMatchObject({ status: "fulfilled", value: { type: "cancel_requested", payload: { executionEpoch: 0 } } });
    const eventsAfterCancel = await ledger.readAll();
    expect(eventsAfterCancel).toHaveLength(before + 1);
    const cancel = eventsAfterCancel.at(-1)!;
    await ledger.append("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    const afterResume = (await ledger.readAll()).length;
    await expect(first.cancel(-1, "user-pause")).rejects.toMatchObject({ code: "retry.cancel-epoch" });
    await expect(second.cancel(0, "user-pause")).rejects.toMatchObject({ code: "retry.cancel-epoch" });
    await expect(cancelRetryEpoch(ledger, 2, "user-pause")).rejects.toMatchObject({ code: "retry.cancel-epoch" });
    expect(await ledger.readAll()).toHaveLength(afterResume);
    await expect(first.cancel(1, "user-pause")).resolves.toMatchObject({ type: "cancel_requested", payload: { executionEpoch: 1 } });
    const afterLegal = (await ledger.readAll()).length;
    await expect(second.cancel(1, "user-pause")).rejects.toMatchObject({ code: "retry.cancel-epoch" });
    expect(await ledger.readAll()).toHaveLength(afterLegal);
    await ledger.close();
  });

  test("a start ordered before cancellation commits once and is then quarantined", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    const controller = createRetryController(ledger);
    const startFirst = controller.start(RETRY_1, AT, policy());
    const cancelSecond = controller.cancel(0, "user-pause");
    await expect(startFirst).resolves.toMatchObject({ kind: "started", descriptor: { attemptId: ATTEMPT_2 } });
    await expect(cancelSecond).resolves.toMatchObject({ type: "cancel_requested" });
    expect((await ledger.readAll()).slice(-3).map((event) => event.type)).toEqual(["identity_reserved", "retry_started", "cancel_requested"]);
    expect(recoverRetryState(await ledger.readAll()).schedules[RETRY_1]?.status).toBe("cancelled");
    await ledger.close();
  });

  test("separate controllers and direct scheduling share one non-poisoning ledger boundary", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    const first = createRetryController(ledger);
    const second = createRetryController(ledger);
    const ids = ["retry-0000000000000101", "retry-0000000000000102", "retry-0000000000000103"];
    const calls = [
      first.schedule(attemptRecord(), policy({ scheduleId: () => ids[0]! }), AT, () => 0),
      second.schedule(attemptRecord(), policy({ scheduleId: () => ids[1]! }), AT, () => 0),
      scheduleRetry(ledger, attemptRecord(), policy({ scheduleId: () => ids[2]! }), AT, () => 0),
    ];
    const results = await Promise.all(calls);
    expect(results.map((result) => result.kind).sort()).toEqual(["already-scheduled", "already-scheduled", "scheduled"]);
    expect((await ledger.readAll()).filter((event) => event.type === "retry_scheduled")).toHaveLength(1);
    await expect(first.schedule(attemptRecord(), policy({ retryAfterMs: -1 }), AT, () => 0)).rejects.toMatchObject({ code: "retry.policy" });
    await expect(second.schedule(attemptRecord(), policy(), AT, () => 0)).resolves.toMatchObject({ kind: "already-scheduled" });
    await ledger.close();
  });

  test("separate controllers and direct starts commit exactly one physical start", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    const first = createRetryController(ledger);
    const second = createRetryController(ledger);
    const attempts = ["attempt-0000000000000101", "attempt-0000000000000102", "attempt-0000000000000103"];
    const results = await Promise.all([
      first.start(RETRY_1, AT, policy({ attemptId: () => attempts[0]! })),
      second.start(RETRY_1, AT, policy({ attemptId: () => attempts[1]! })),
      startScheduledRetry(ledger, RETRY_1, AT, policy({ attemptId: () => attempts[2]! })),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["already-started", "already-started", "started"]);
    expect((await ledger.readAll()).filter((event) => event.type === "retry_started")).toHaveLength(1);
    await ledger.close();
  });

  test("a replacement controller consumes the prior canonical schedule with the same frozen descriptor", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    const replacement = createRetryController(ledger);
    await expect(replacement.start(RETRY_1, AT, policy())).resolves.toMatchObject({ kind: "started", descriptor: { scheduleId: RETRY_1, providerModel: "provider/model", toolAllowlist: ["scholarly_search"] } });
    await ledger.close();
  });

  test("large many-epoch recovery visits each event and derives each schedule once", () => {
    const events = new EventBuilder();
    events.add("run_created", { run: runSnapshot() });
    events.add("task_upserted", { task: taskRecord() });
    const epochs = 12;
    const perEpoch = 20;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (let item = 0; item < perEpoch; item += 1) {
        const suffix = String(epoch * perEpoch + item + 1).padStart(16, "0");
        const attemptId = `attempt-${suffix}`;
        const scheduleId = `retry-${suffix}`;
        const attempt = attemptRecord({ attemptId, executionEpoch: epoch, logicalOperationId: `large-operation-${suffix}` });
        events.add("identity_reserved", { kind: "attempt", id: attemptId, origin: "parent-generated" });
        events.add("dispatch_intent", { attempt });
        events.add("dispatch_started", { attemptId, pid: null, requestCorrelation: null });
        events.add("attempt_failed", { attemptId, state: "retryable-failed", errorClass: "transient", message: "safe" });
        events.add("identity_reserved", { kind: "retry-schedule", id: scheduleId, origin: "parent-generated" });
        events.add("retry_scheduled", { scheduleId, logicalOperationId: attempt.logicalOperationId, failedAttemptId: attemptId, nextAttemptOrdinal: 2, notBeforeAt: AT.toISOString(), delayMs: 0, reasonClass: "transient" });
      }
      const cancel = events.add("cancel_requested", { executionEpoch: epoch, reason: "user-pause" });
      if (epoch + 1 < epochs) events.add("resume_epoch_started", { priorEpoch: epoch, executionEpoch: epoch + 1, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    }
    const diagnostics = { eventsVisited: 0, schedulesDerived: 0 };
    const state = recoverRetryState(events.values, diagnostics);
    expect(diagnostics).toEqual({ eventsVisited: events.values.length, schedulesDerived: epochs * perEpoch });
    expect(Object.values(state.schedules)).toHaveLength(epochs * perEpoch);
    expect(Object.values(state.schedules).every((schedule) => schedule.status === "cancelled")).toBe(true);
  });

  test.each([
    ["promptTemplateSha256", HASH_B], ["logicalInputSha256", HASH_B], ["providerModel", "other/model"],
    ["toolAllowlist", ["other"]], ["deadlineAt", "2026-08-25T13:00:01.000Z"], ["replayPolicy", "never"],
  ] as const)("rejects immutable retry mismatch in %s", (field, value) => {
    const first = attemptRecord();
    const changed = attemptRecord({ attemptId: ATTEMPT_2, attemptOrdinal: 2, retryOfAttemptId: ATTEMPT_1, [field]: value });
    expect(() => assertRetryContinuation(first, changed)).toThrowError(expect.objectContaining({ code: "retry.immutable-change" }));
  });

  test("changed logical input starts a distinct ordinal-one logical operation", () => {
    const first = attemptRecord();
    const changed = attemptRecord({ attemptId: ATTEMPT_2, attemptOrdinal: 2, retryOfAttemptId: ATTEMPT_1, logicalInputSha256: HASH_B });
    expect(startNewLogicalOperation(first, { ...changed, logicalOperationId: "operation-changed", attemptOrdinal: 1, retryOfAttemptId: null })).toMatchObject({ logicalOperationId: "operation-changed", attemptOrdinal: 1 });
    expect(() => startNewLogicalOperation(first, { ...changed, logicalOperationId: LOGICAL, attemptOrdinal: 1, retryOfAttemptId: null })).toThrowError(expect.objectContaining({ code: "retry.logical-operation" }));
  });
});
