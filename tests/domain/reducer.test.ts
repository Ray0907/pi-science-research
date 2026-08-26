import { describe, expect, test } from "vitest";

import type { FoundationEventPayload, FoundationEventType, FoundationLedgerEvent } from "../../src/domain/events.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import {
  LedgerReducerCorruptionError,
  recoveryDecisionFor,
  reduceLedgerEvents,
} from "../../src/domain/reducer.js";

const AT = "2026-08-25T12:00:00.000Z";
const LATER = "2026-08-25T12:01:00.000Z";
const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RUN_ID = "run-0000000000000001";
const TASK_ID = "task-0000000000000001";
const ATTEMPT_1 = "attempt-0000000000000001";
const ATTEMPT_2 = "attempt-0000000000000002";
const ATTEMPT_3 = "attempt-0000000000000003";
const TX_1 = "tx-0000000000000001";
const RETRY_1 = "retry-0000000000000001";
const RETRY_2 = "retry-0000000000000002";
const REVISION_1 = "rev-20260825T120000000Z-000000000001";
const LOGICAL = "operation-primary";

function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    revision: 1,
    question: "question",
    language: "en",
    depth: "standard",
    reproducible: false,
    allowCalculations: false,
    calculationPolicySha256: null,
    state: "created",
    checkpointStage: null,
    executionEpoch: 0,
    outputRoot: "research/run",
    roleModels: { coordinator: "provider/model", researcher: "provider/model", verifier: "provider/model" },
    roleThinking: { coordinator: "medium", researcher: "medium", verifier: "medium" },
    budget: {
      activeTimeLimitMs: 600_000,
      activeTimeUsedMs: 0,
      finalizationReserveMs: 120_000,
      maxSources: 20,
      admittedSources: 0,
      maxWaves: 3,
      waveOrdinal: 0,
    },
    taskRefs: [],
    attemptRefs: [],
    acceptedVerificationRef: null,
    currentRevisionId: null,
    blocker: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    ...overrides,
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    revision: 1,
    description: "research",
    evidenceRule: {
      minimumLineages: 1,
      independentVerificationAllowed: true,
      primarySourceRequired: false,
      fullTextRequired: false,
    },
    role: "literature-searcher",
    state: "running",
    attemptIds: [],
    blocker: null,
    resolution: null,
    ...overrides,
  };
}

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    schemaVersion: 1,
    attemptId: ATTEMPT_1,
    revision: 1,
    runId: RUN_ID,
    taskId: TASK_ID,
    executionEpoch: 0,
    logicalOperationId: LOGICAL,
    attemptOrdinal: 1,
    retryOfAttemptId: null,
    attemptKind: "research",
    replayPolicy: "safe-read",
    state: "intent-recorded",
    providerModel: "provider/model",
    thinkingLevel: "medium",
    promptTemplateSha256: HASH,
    renderedPromptSha256: HASH,
    logicalInputSha256: HASH,
    attemptEnvelopeSha256: HASH_B,
    toolAllowlist: ["scholarly_search"],
    deadlineAt: LATER,
    capabilityId: "capability",
    resultSha256: null,
    billingStatus: "unknown",
    reportedUsage: null,
    error: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

class Events {
  readonly values: FoundationLedgerEvent[] = [];

  add<T extends FoundationEventType>(type: T, payload: FoundationEventPayload<T>): FoundationLedgerEvent {
    const seq = this.values.length + 1;
    const event = {
      schemaVersion: 1,
      seq,
      occurredAt: AT,
      eventId: `event-${seq}`,
      type,
      payload,
      prevSha256: seq === 1 ? "0".repeat(64) : HASH,
      entrySha256: HASH,
    } as FoundationLedgerEvent;
    this.values.push(event);
    return event;
  }

  base(attempt = attemptRecord()): void {
    this.add("run_created", { run: runSnapshot() });
    this.add("state_changed", { from: "created", to: "planning", blocker: null });
    this.add("state_changed", { from: "planning", to: "researching", blocker: null });
    this.add("task_upserted", { task: taskRecord() });
    this.add("identity_reserved", { kind: "attempt", id: attempt.attemptId, origin: "parent-generated" });
    this.add("dispatch_intent", { attempt });
  }

  started(attemptId = ATTEMPT_1): void {
    this.add("dispatch_started", { attemptId, pid: 123, requestCorrelation: null });
  }

  result(attemptId = ATTEMPT_1, transactionId = TX_1): FoundationLedgerEvent {
    this.add("identity_reserved", { kind: "transaction", id: transactionId, origin: "parent-generated" });
    return this.add("result_recorded", { attemptId, resultSha256: HASH, manifestSha256: null, transactionId });
  }

  records(attemptId: string, transactionId: string, sourceResultSeq: number): void {
    this.add("records_committed", {
      transactionId,
      sourceResultSeq,
      transactionManifestPath: `.state/transactions/committed/${transactionId}/manifest.json`,
      transactionManifestSha256: HASH,
      sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [],
    });
    this.add("attempt_committed", { attemptId, transactionId, taskId: TASK_ID, sourceResultSeq });
  }
}

function expectCorruption(events: readonly FoundationLedgerEvent[], code: string): void {
  try {
    reduceLedgerEvents(events);
    throw new Error("expected corruption");
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerReducerCorruptionError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("capability");
  }
}

describe("pure ledger recovery reduction", () => {
  test("returns immutable state without mutating frozen input events", () => {
    const events = new Events();
    events.base();
    const snapshot = JSON.stringify(events.values);
    deepFreeze(events.values);

    const state = reduceLedgerEvents(events.values);

    expect(JSON.stringify(events.values)).toBe(snapshot);
    expect(recoveryDecisionFor(state, "missing-operation")).toEqual({ kind: "not-found" });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.operations)).toBe(true);
    expect(Object.isFrozen(state.operations[LOGICAL])).toBe(true);
    expect(Object.isFrozen(state.operations[LOGICAL]!.attempts)).toBe(true);
  });

  test("returns not-found without inventing state for an empty ledger", () => {
    expect(recoveryDecisionFor(reduceLedgerEvents([]), LOGICAL)).toEqual({ kind: "not-found" });
  });

  test("a committed accepted attempt wins and is skipped", () => {
    const events = new Events();
    events.base();
    events.started();
    const result = events.result();
    events.records(ATTEMPT_1, TX_1, result.seq);

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({ kind: "skip-committed" });
  });

  test("finishes the same recorded transaction when canonical records are absent", () => {
    const events = new Events();
    events.base();
    events.started();
    events.result();

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "finish-transaction",
      transactionId: TX_1,
    });
  });

  test("requires durable scheduling for an uncertain safe-read intent", () => {
    const events = new Events();
    events.base();
    events.started();

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "needs-retry-schedule",
      failedAttemptId: ATTEMPT_1,
      nextAttemptOrdinal: 2,
      replayPolicy: "safe-read",
    });
  });

  test("preserves an unconsumed durable retry schedule across serialization", () => {
    const events = new Events();
    events.base();
    events.started();
    events.add("attempt_failed", { attemptId: ATTEMPT_1, state: "retryable-failed", errorClass: "timeout", message: "redacted" });
    events.add("identity_reserved", { kind: "retry-schedule", id: RETRY_1, origin: "parent-generated" });
    events.add("retry_scheduled", {
      scheduleId: RETRY_1,
      logicalOperationId: LOGICAL,
      failedAttemptId: ATTEMPT_1,
      nextAttemptOrdinal: 2,
      notBeforeAt: LATER,
      delayMs: 1_000,
      reasonClass: "transient",
    });
    const reparsed = JSON.parse(JSON.stringify(events.values)) as FoundationLedgerEvent[];

    expect(recoveryDecisionFor(reduceLedgerEvents(reparsed), LOGICAL)).toEqual({
      kind: "retry-safe-read",
      schedule: {
        schemaVersion: 1,
        scheduleId: RETRY_1,
        logicalOperationId: LOGICAL,
        failedAttemptId: ATTEMPT_1,
        nextAttemptOrdinal: 2,
        notBeforeAt: LATER,
        delayMs: 1_000,
        reasonClass: "transient",
        replayPolicy: "safe-read",
      },
    });
  });

  test("resumes the exact physical retry identity after retry_started crash prefix", () => {
    const events = scheduledRetryEvents();
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const scheduledSeq = events.values.find((event) => event.type === "retry_scheduled")!.seq;
    events.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: scheduledSeq });
    const reparsed = JSON.parse(JSON.stringify(events.values)) as FoundationLedgerEvent[];

    const decision = recoveryDecisionFor(reduceLedgerEvents(reparsed), LOGICAL);
    expect(decision).toEqual({
      kind: "resume-started-retry",
      attemptId: ATTEMPT_2,
      attemptOrdinal: 2,
      schedule: {
        schemaVersion: 1,
        scheduleId: RETRY_1,
        logicalOperationId: LOGICAL,
        failedAttemptId: ATTEMPT_1,
        nextAttemptOrdinal: 2,
        notBeforeAt: LATER,
        delayMs: 1,
        reasonClass: "transient",
        replayPolicy: "safe-read",
      },
    });
    expect(decision.kind === "resume-started-retry" && Object.isFrozen(decision.schedule)).toBe(true);

    const continuation = new Events();
    continuation.values.push(...reparsed);
    continuation.add("dispatch_intent", { attempt: attemptRecord({ attemptId: ATTEMPT_2, attemptOrdinal: 2, retryOfAttemptId: ATTEMPT_1, attemptEnvelopeSha256: "c".repeat(64) }) });
    continuation.started(ATTEMPT_2);
    expect(recoveryDecisionFor(reduceLedgerEvents(continuation.values), LOGICAL)).toEqual({
      kind: "needs-retry-schedule",
      failedAttemptId: ATTEMPT_2,
      nextAttemptOrdinal: 3,
      replayPolicy: "safe-read",
    });
  });

  test("blocks an uncertain never attempt", () => {
    const events = new Events();
    events.base(attemptRecord({ attemptKind: "calculation", replayPolicy: "never", billingStatus: "not-applicable" }));
    events.started();

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "block-never",
      code: "uncertain-nonreplayable",
    });
  });

  test("does not block already settled terminal or cancelled never attempts", () => {
    for (const failureState of ["terminal-failed", "cancelled"] as const) {
      const events = new Events();
      events.base(attemptRecord({ attemptKind: "calculation", replayPolicy: "never", billingStatus: "not-applicable" }));
      events.started();
      events.add("attempt_failed", { attemptId: ATTEMPT_1, state: failureState, errorClass: "settled", message: "settled" });
      events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
      expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
        kind: "no-action",
        reason: "terminal",
      });
    }
  });

  test("quarantines a result arriving after its epoch cancellation", () => {
    const events = new Events();
    events.base();
    events.started();
    events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    events.result();

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "quarantined",
      reason: "cancelled-epoch",
    });
  });

  test("keeps a pre-boundary uncommitted result eligible for the same transaction", () => {
    const events = new Events();
    events.base();
    events.started();
    events.result();
    events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "finish-transaction",
      transactionId: TX_1,
    });
  });

  test("allows a pre-boundary result transaction to roll forward after cancellation", () => {
    const events = new Events();
    events.base();
    events.started();
    const result = events.result();
    events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    events.records(ATTEMPT_1, TX_1, result.seq);

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({ kind: "skip-committed" });
  });

  test("cancellation permanently suppresses a schedule accepted in that epoch", () => {
    const events = scheduledRetryEvents();
    const cancel = events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "quarantined",
      reason: "cancelled-epoch",
    });

    events.add("resume_epoch_started", {
      priorEpoch: 0,
      executionEpoch: 1,
      priorCancelSeq: cancel.seq,
      checkpointStage: "researching",
      ownerTokenSha256: HASH,
    });
    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({
      kind: "quarantined",
      reason: "cancelled-epoch",
    });
  });

  test("binds a quarantined transaction to its original attempt and rejects later reuse", () => {
    const events = new Events();
    events.base();
    events.started();
    const cancel = events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    events.result(ATTEMPT_1, TX_1);
    events.add("resume_epoch_started", {
      priorEpoch: 0,
      executionEpoch: 1,
      priorCancelSeq: cancel.seq,
      checkpointStage: "researching",
      ownerTokenSha256: HASH,
    });
    const next = attemptRecord({ attemptId: ATTEMPT_2, logicalOperationId: "operation-next-epoch", executionEpoch: 1, attemptEnvelopeSha256: "c".repeat(64) });
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    events.add("dispatch_intent", { attempt: next });
    events.started(ATTEMPT_2);
    events.add("result_recorded", { attemptId: ATTEMPT_2, resultSha256: HASH, manifestSha256: null, transactionId: TX_1 });

    expectCorruption(events.values, "reducer.duplicate-transaction");

    const originalOnly = events.values.slice(0, -4);
    const state = reduceLedgerEvents(originalOnly);
    expect(state.operations[LOGICAL]!.attempts[0]).toMatchObject({
      phase: "quarantined",
      transactionId: TX_1,
      quarantineReason: "cancelled-epoch",
    });
  });

  test("rejects canonical record commitment for a quarantined transaction", () => {
    const events = new Events();
    events.base();
    events.started();
    events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    const lateResult = events.result(ATTEMPT_1, TX_1);
    events.add("records_committed", {
      transactionId: TX_1,
      sourceResultSeq: lateResult.seq,
      transactionManifestPath: "transaction/manifest.json",
      transactionManifestSha256: HASH,
      sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [],
    });
    expectCorruption(events.values, "reducer.transaction-quarantined");
  });

  test("permanently quarantines attempts from every cancelled epoch across multiple resumes", () => {
    const events = new Events();
    events.base();
    events.started();
    const cancel0 = events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    events.add("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: cancel0.seq, checkpointStage: "researching", ownerTokenSha256: HASH });

    const epoch1Operation = "operation-epoch-1";
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    events.add("dispatch_intent", { attempt: attemptRecord({ attemptId: ATTEMPT_2, logicalOperationId: epoch1Operation, executionEpoch: 1, attemptEnvelopeSha256: "c".repeat(64) }) });
    events.started(ATTEMPT_2);
    const cancel1 = events.add("cancel_requested", { executionEpoch: 1, reason: "user-pause" });
    events.add("resume_epoch_started", { priorEpoch: 1, executionEpoch: 2, priorCancelSeq: cancel1.seq, checkpointStage: "researching", ownerTokenSha256: HASH });

    const epoch2Operation = "operation-epoch-2";
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_3, origin: "parent-generated" });
    events.add("dispatch_intent", { attempt: attemptRecord({ attemptId: ATTEMPT_3, logicalOperationId: epoch2Operation, executionEpoch: 2, attemptEnvelopeSha256: "d".repeat(64) }) });
    events.started(ATTEMPT_3);
    events.result(ATTEMPT_1, TX_1);
    events.result(ATTEMPT_2, "tx-0000000000000002");

    const state = reduceLedgerEvents(events.values);
    expect(recoveryDecisionFor(state, LOGICAL)).toEqual({ kind: "quarantined", reason: "cancelled-epoch" });
    expect(recoveryDecisionFor(state, epoch1Operation)).toEqual({ kind: "quarantined", reason: "cancelled-epoch" });
    expect(recoveryDecisionFor(state, epoch2Operation)).toMatchObject({ kind: "needs-retry-schedule", failedAttemptId: ATTEMPT_3 });
    expect(state.cancelledEpochs).toEqual({ "0": cancel0.seq, "1": cancel1.seq });
  });

  test("quarantines old retry work and accepts a replacement schedule only after resume", () => {
    const blocked = new Events();
    blocked.base();
    blocked.started();
    blocked.add("attempt_failed", { attemptId: ATTEMPT_1, state: "retryable-failed", errorClass: "timeout", message: "redacted" });
    blocked.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    blocked.add("identity_reserved", { kind: "retry-schedule", id: RETRY_1, origin: "parent-generated" });
    blocked.add("retry_scheduled", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, failedAttemptId: ATTEMPT_1, nextAttemptOrdinal: 2, notBeforeAt: LATER, delayMs: 1, reasonClass: "blocked" });
    expectCorruption(blocked.values, "reducer.retry-after-cancel");

    const oldSchedule = scheduledRetryEvents();
    const cancel = oldSchedule.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    oldSchedule.add("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    oldSchedule.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const oldScheduleSeq = oldSchedule.values.find((event) => event.type === "retry_scheduled")!.seq;
    oldSchedule.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: oldScheduleSeq });
    expectCorruption(oldSchedule.values, "reducer.retry-after-cancel");

    const replacement = scheduledRetryEvents();
    const replacementCancel = replacement.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    replacement.add("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: replacementCancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    replacement.add("identity_reserved", { kind: "retry-schedule", id: RETRY_2, origin: "parent-generated" });
    replacement.add("retry_scheduled", { scheduleId: RETRY_2, logicalOperationId: LOGICAL, failedAttemptId: ATTEMPT_1, nextAttemptOrdinal: 2, notBeforeAt: LATER, delayMs: 2, reasonClass: "resumed" });
    expect(recoveryDecisionFor(reduceLedgerEvents(replacement.values), LOGICAL)).toMatchObject({
      kind: "retry-safe-read",
      schedule: { scheduleId: RETRY_2 },
    });
    const cancel1 = replacement.add("cancel_requested", { executionEpoch: 1, reason: "user-pause" });
    replacement.add("resume_epoch_started", { priorEpoch: 1, executionEpoch: 2, priorCancelSeq: cancel1.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
    expect(recoveryDecisionFor(reduceLedgerEvents(replacement.values), LOGICAL)).toEqual({
      kind: "quarantined",
      reason: "cancelled-epoch",
    });
  });

  test("keeps later-epoch work eligible while old-epoch late results stay quarantined", () => {
    const events = new Events();
    events.base();
    events.started();
    const cancel = events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    events.add("resume_epoch_started", {
      priorEpoch: 0,
      executionEpoch: 1,
      priorCancelSeq: cancel.seq,
      checkpointStage: "researching",
      ownerTokenSha256: HASH,
    });
    events.result();
    const next = attemptRecord({
      attemptId: ATTEMPT_2,
      logicalOperationId: "operation-next-epoch",
      executionEpoch: 1,
      attemptEnvelopeSha256: "c".repeat(64),
    });
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    events.add("dispatch_intent", { attempt: next });
    events.started(ATTEMPT_2);
    events.result(ATTEMPT_2, "tx-0000000000000002");

    const state = reduceLedgerEvents(events.values);
    expect(recoveryDecisionFor(state, LOGICAL)).toEqual({ kind: "quarantined", reason: "cancelled-epoch" });
    expect(recoveryDecisionFor(state, "operation-next-epoch")).toEqual({
      kind: "finish-transaction",
      transactionId: "tx-0000000000000002",
    });
    expect(state.currentEpoch).toBe(1);
  });

  test("keeps the started retry resumable when its predecessor result arrives late", () => {
    const events = scheduledRetryEvents();
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const scheduledSeq = events.values.find((event) => event.type === "retry_scheduled")!.seq;
    events.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: scheduledSeq });
    events.result(ATTEMPT_1);

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toMatchObject({
      kind: "resume-started-retry",
      attemptId: ATTEMPT_2,
      attemptOrdinal: 2,
      schedule: { scheduleId: RETRY_1 },
    });
  });

  test("a committed retry is never replaced by its late superseded predecessor", () => {
    const events = scheduledRetryEvents();
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const scheduledSeq = events.values.find((event) => event.type === "retry_scheduled")!.seq;
    events.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: scheduledSeq });
    const retry = attemptRecord({
      attemptId: ATTEMPT_2,
      attemptOrdinal: 2,
      retryOfAttemptId: ATTEMPT_1,
      attemptEnvelopeSha256: "c".repeat(64),
    });
    events.add("dispatch_intent", { attempt: retry });
    events.started(ATTEMPT_2);
    const result = events.result(ATTEMPT_2, "tx-0000000000000002");
    events.records(ATTEMPT_2, "tx-0000000000000002", result.seq);
    events.add("attempt_failed", { attemptId: ATTEMPT_1, state: "superseded", errorClass: "late", message: "diagnostic" });

    expect(recoveryDecisionFor(reduceLedgerEvents(events.values), LOGICAL)).toEqual({ kind: "skip-committed" });
  });
});

describe("run state reduction", () => {
  test("accepts valid state transitions and completes only through run_completed", () => {
    const events = new Events();
    events.add("run_created", { run: runSnapshot({ state: "created", checkpointStage: null, depth: "quick" }) });
    events.add("state_changed", { from: "created", to: "planning", blocker: null });
    events.add("state_changed", { from: "planning", to: "researching", blocker: null });
    events.add("state_changed", { from: "researching", to: "synthesizing", blocker: null });
    events.add("identity_reserved", { kind: "revision", id: REVISION_1, origin: "parent-generated" });
    events.add("revision_committed", { revisionId: REVISION_1, manifestSha256: HASH, completionCommitId: "completion-1" });
    events.add("run_completed", { revisionId: REVISION_1, manifestSha256: HASH, runSnapshotSha256: HASH_B, completionCommitId: "completion-1", completedAt: LATER });

    expect(reduceLedgerEvents(events.values).runState).toBe("completed");
  });

  test("accepts pause recovery and failed recovery only with represented prerequisite resolution", () => {
    const paused = new Events();
    paused.add("run_created", { run: runSnapshot({ state: "created", checkpointStage: null }) });
    paused.add("state_changed", { from: "created", to: "planning", blocker: null });
    paused.add("state_changed", { from: "planning", to: "paused", blocker: null });
    paused.add("state_changed", { from: "paused", to: "recovering", blocker: null });
    paused.add("state_changed", { from: "recovering", to: "planning", blocker: null });
    expect(reduceLedgerEvents(paused.values).runState).toBe("planning");

    const failed = new Events();
    failed.add("run_created", { run: runSnapshot({ state: "created", checkpointStage: null }) });
    failed.add("state_changed", { from: "created", to: "failed", blocker: { code: "retryable-storage", message: "blocked" } });
    failed.add("state_changed", { from: "failed", to: "recovering", blocker: null });
    expect(reduceLedgerEvents(failed.values).runState).toBe("recovering");
  });

  test("rejects invalid, terminal, and inconsistent completion transitions", () => {
    const cases: { build: () => FoundationLedgerEvent[]; code: string }[] = [
      {
        build: () => { const e = new Events(); e.add("run_created", { run: runSnapshot({ state: "researching", checkpointStage: "researching" }) }); return e.values; },
        code: "reducer.initial-run-state",
      },
      {
        build: () => { const e = new Events(); e.add("run_created", { run: runSnapshot({ state: "created", checkpointStage: null }) }); e.add("run_created", { run: runSnapshot({ state: "created", checkpointStage: null }) }); return e.values; },
        code: "reducer.duplicate-run",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "planning", to: "researching", blocker: null }); return e.values; },
        code: "reducer.run-state-from",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "created", to: "researching", blocker: null }); return e.values; },
        code: "reducer.run-transition",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "created", to: "cancelled", blocker: null }); e.add("state_changed", { from: "cancelled", to: "failed", blocker: { code: "x", message: "x" } }); return e.values; },
        code: "reducer.run-terminal",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "created", to: "failed", blocker: { code: "fatal-corruption", message: "blocked" } }); e.add("state_changed", { from: "failed", to: "recovering", blocker: null }); return e.values; },
        code: "reducer.run-transition",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "created", to: "planning", blocker: null }); e.add("state_changed", { from: "planning", to: "researching", blocker: null }); e.add("state_changed", { from: "researching", to: "synthesizing", blocker: null }); return e.values; },
        code: "reducer.run-transition",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("run_completed", { revisionId: REVISION_1, manifestSha256: HASH, runSnapshotSha256: HASH_B, completionCommitId: "completion-1", completedAt: LATER }); return e.values; },
        code: "reducer.run-completion-state",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "created", to: "planning", blocker: null }); e.add("state_changed", { from: "planning", to: "researching", blocker: null }); e.add("state_changed", { from: "researching", to: "verifying", blocker: null }); e.add("state_changed", { from: "verifying", to: "synthesizing", blocker: null }); e.add("run_completed", { revisionId: REVISION_1, manifestSha256: HASH, runSnapshotSha256: HASH_B, completionCommitId: "completion-1", completedAt: LATER }); return e.values; },
        code: "reducer.revision-not-committed",
      },
      {
        build: () => { const e = createdRunEvents(); e.add("state_changed", { from: "created", to: "planning", blocker: null }); e.add("state_changed", { from: "planning", to: "researching", blocker: null }); e.add("state_changed", { from: "researching", to: "verifying", blocker: null }); e.add("state_changed", { from: "verifying", to: "synthesizing", blocker: null }); e.add("state_changed", { from: "synthesizing", to: "completed", blocker: null }); return e.values; },
        code: "reducer.completion-event-required",
      },
      {
        build: () => {
          const e = new Events();
          e.add("run_created", { run: runSnapshot({ depth: "quick" }) });
          e.add("state_changed", { from: "created", to: "planning", blocker: null });
          e.add("state_changed", { from: "planning", to: "researching", blocker: null });
          e.add("state_changed", { from: "researching", to: "synthesizing", blocker: null });
          e.add("identity_reserved", { kind: "revision", id: REVISION_1, origin: "parent-generated" });
          e.add("revision_committed", { revisionId: REVISION_1, manifestSha256: HASH, completionCommitId: "completion-1" });
          e.add("run_completed", { revisionId: REVISION_1, manifestSha256: HASH, runSnapshotSha256: HASH_B, completionCommitId: "completion-1", completedAt: LATER });
          e.add("state_changed", { from: "completed", to: "failed", blocker: { code: "x", message: "x" } });
          return e.values;
        },
        code: "reducer.run-terminal",
      },
    ];
    for (const item of cases) expectCorruption(item.build(), item.code);
  });
});

describe("semantic corruption", () => {
  test("rejects invalid attempt, transaction, schedule, and epoch histories with stable codes", () => {
    const cases: { name: string; build: () => FoundationLedgerEvent[]; code: string }[] = [
      {
        name: "run snapshot references an absent task",
        build: () => {
          const events = new Events();
          events.add("run_created", { run: runSnapshot({ taskRefs: [{ taskId: TASK_ID, revision: 1 }] }) });
          return events.values;
        },
        code: "reducer.run-task-ref",
      },
      {
        name: "task references an absent attempt",
        build: () => {
          const events = new Events();
          events.add("run_created", { run: runSnapshot() });
          events.add("task_upserted", { task: taskRecord({ attemptIds: [ATTEMPT_1] }) });
          return events.values;
        },
        code: "reducer.task-attempt-ref",
      },
      {
        name: "attempt references an absent task",
        build: () => {
          const events = new Events();
          events.add("run_created", { run: runSnapshot() });
          events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_1, origin: "parent-generated" });
          events.add("dispatch_intent", { attempt: attemptRecord() });
          return events.values;
        },
        code: "reducer.task-not-found",
      },
      {
        name: "duplicate attempt intent",
        build: () => {
          const events = new Events(); events.base(); events.add("dispatch_intent", { attempt: attemptRecord() }); return events.values;
        },
        code: "reducer.duplicate-attempt",
      },
      {
        name: "ordinal gap",
        build: () => {
          const events = new Events(); events.base();
          events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_3, origin: "parent-generated" });
          events.add("dispatch_intent", { attempt: attemptRecord({ attemptId: ATTEMPT_3, attemptOrdinal: 3, retryOfAttemptId: ATTEMPT_1, attemptEnvelopeSha256: "d".repeat(64) }) });
          return events.values;
        },
        code: "reducer.attempt-ordinal",
      },
      {
        name: "schedule before retryable failure",
        build: () => {
          const events = new Events(); events.base();
          events.add("identity_reserved", { kind: "retry-schedule", id: RETRY_1, origin: "parent-generated" });
          events.add("retry_scheduled", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, failedAttemptId: ATTEMPT_1, nextAttemptOrdinal: 2, notBeforeAt: LATER, delayMs: 1, reasonClass: "x" });
          return events.values;
        },
        code: "reducer.retry-predecessor",
      },
      {
        name: "retry start has wrong schedule sequence",
        build: () => {
          const events = scheduledRetryEvents();
          events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
          events.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: 1 });
          return events.values;
        },
        code: "reducer.retry-schedule-seq",
      },
      {
        name: "attempt commit lacks records commit",
        build: () => {
          const events = new Events(); events.base(); events.started(); const result = events.result();
          events.add("attempt_committed", { attemptId: ATTEMPT_1, transactionId: TX_1, taskId: TASK_ID, sourceResultSeq: result.seq });
          return events.values;
        },
        code: "reducer.records-not-committed",
      },
      {
        name: "records commit mismatches result sequence",
        build: () => {
          const events = new Events(); events.base(); events.started(); const result = events.result();
          events.add("records_committed", { transactionId: TX_1, sourceResultSeq: result.seq - 1, transactionManifestPath: "x", transactionManifestSha256: HASH, sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [] });
          return events.values;
        },
        code: "reducer.source-result-link",
      },
      {
        name: "resume epoch skips an increment",
        build: () => {
          const events = new Events(); events.base(); const cancel = events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
          events.add("resume_epoch_started", { priorEpoch: 0, executionEpoch: 2, priorCancelSeq: cancel.seq, checkpointStage: "researching", ownerTokenSha256: HASH });
          return events.values;
        },
        code: "reducer.resume-epoch",
      },
      {
        name: "duplicate cancellation epoch",
        build: () => {
          const events = new Events(); events.base(); events.add("cancel_requested", { executionEpoch: 0, reason: "user-pause" }); events.add("cancel_requested", { executionEpoch: 0, reason: "abort-signal" }); return events.values;
        },
        code: "reducer.duplicate-cancel",
      },
    ];

    for (const item of cases) expectCorruption(item.build(), item.code);
  });

  test("rejects direct supersession without a durably started distinct replacement", () => {
    for (const started of [false, true]) {
      const events = new Events();
      events.base();
      if (started) events.started();
      events.add("attempt_failed", { attemptId: ATTEMPT_1, state: "superseded", errorClass: "invalid", message: "invalid" });
      expectCorruption(events.values, "reducer.superseded-without-replacement");
    }
  });

  test("rejects a second durable schedule for an already consumed retry edge", () => {
    const events = scheduledRetryEvents();
    events.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const scheduledSeq = events.values.find((event) => event.type === "retry_scheduled")!.seq;
    events.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: scheduledSeq });
    events.add("identity_reserved", { kind: "retry-schedule", id: RETRY_2, origin: "parent-generated" });
    events.add("retry_scheduled", { scheduleId: RETRY_2, logicalOperationId: LOGICAL, failedAttemptId: ATTEMPT_1, nextAttemptOrdinal: 2, notBeforeAt: LATER, delayMs: 1, reasonClass: "duplicate" });
    expectCorruption(events.values, "reducer.duplicate-retry-edge");
  });

  test("rejects duplicate retry starts and wrong retry backlinks", () => {
    const duplicate = scheduledRetryEvents();
    duplicate.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const scheduledSeq = duplicate.values.find((event) => event.type === "retry_scheduled")!.seq;
    duplicate.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: scheduledSeq });
    duplicate.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: scheduledSeq });
    expectCorruption(duplicate.values, "reducer.duplicate-retry-start");

    const backlink = scheduledRetryEvents();
    backlink.add("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" });
    const sourceSeq = backlink.values.find((event) => event.type === "retry_scheduled")!.seq;
    backlink.add("retry_started", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: sourceSeq });
    backlink.add("dispatch_intent", { attempt: attemptRecord({ attemptId: ATTEMPT_2, attemptOrdinal: 2, retryOfAttemptId: ATTEMPT_3, attemptEnvelopeSha256: "c".repeat(64) }) });
    expectCorruption(backlink.values, "reducer.retry-backlink");
  });
});

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function createdRunEvents(): Events {
  const events = new Events();
  events.add("run_created", { run: runSnapshot({ state: "created", checkpointStage: null }) });
  return events;
}

function scheduledRetryEvents(): Events {
  const events = new Events();
  events.base();
  events.started();
  events.add("attempt_failed", { attemptId: ATTEMPT_1, state: "retryable-failed", errorClass: "timeout", message: "redacted" });
  events.add("identity_reserved", { kind: "retry-schedule", id: RETRY_1, origin: "parent-generated" });
  events.add("retry_scheduled", { scheduleId: RETRY_1, logicalOperationId: LOGICAL, failedAttemptId: ATTEMPT_1, nextAttemptOrdinal: 2, notBeforeAt: LATER, delayMs: 1, reasonClass: "transient" });
  return events;
}
