import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import { recoveryDecisionFor, reduceLedgerEvents } from "../../src/domain/reducer.js";
import { openEventLedger, type EventLedger } from "../../src/storage/event-ledger.js";
import {
  RetryStoreError,
  assertRetryContinuation,
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
    maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000, activeTimeRemainingMs: 60_000,
    finalizationReserveMs: 10_000, retryAfterMs: null, reasonClass: "transient", scheduleId: () => RETRY_1,
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

  test("caps at deadline and active budget without consuming finalization reserve", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    const capped = await scheduleRetry(ledger, attemptRecord(), policy({ baseDelayMs: 30_000, activeTimeRemainingMs: 12_000, finalizationReserveMs: 10_000 }), AT, () => 1);
    expect(capped).toMatchObject({ kind: "scheduled", schedule: { delayMs: 2_000 } });
    await ledger.close();

    const ledger2 = await newLedger();
    await seedFailed(ledger2);
    expect(await scheduleRetry(ledger2, attemptRecord(), policy({ activeTimeRemainingMs: 10_000, finalizationReserveMs: 10_000 }), AT, () => 0)).toEqual({ kind: "blocked", code: "retry-budget-exhausted" });
    await ledger2.close();
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

  test("a start ordered before cancellation commits exactly once before the cancellation boundary", async () => {
    const ledger = await newLedger();
    await seedFailed(ledger);
    await scheduleRetry(ledger, attemptRecord(), policy(), AT, () => 0);
    const controller = createRetryController(ledger);
    const startFirst = controller.start(RETRY_1, AT, policy());
    const cancelSecond = controller.cancel(0, "user-pause");
    await expect(startFirst).resolves.toMatchObject({ kind: "started", descriptor: { attemptId: ATTEMPT_2 } });
    await expect(cancelSecond).resolves.toMatchObject({ type: "cancel_requested" });
    expect((await ledger.readAll()).slice(-3).map((event) => event.type)).toEqual(["identity_reserved", "retry_started", "cancel_requested"]);
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
