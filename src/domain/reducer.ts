import type { FoundationLedgerEvent } from "./events.js";
import type { AttemptId, TransactionId } from "./ids.js";
import type { AttemptRecord, RetrySchedule, RunSnapshot, TaskRecord } from "./records.js";

export type RecoveryDecision =
  | Readonly<{ kind: "skip-committed" }>
  | Readonly<{ kind: "finish-transaction"; transactionId: TransactionId }>
  | Readonly<{ kind: "retry-safe-read"; schedule: RetrySchedule }>
  | Readonly<{ kind: "resume-started-retry"; attemptId: AttemptId; attemptOrdinal: number; schedule: RetrySchedule }>
  | Readonly<{ kind: "needs-retry-schedule"; failedAttemptId: AttemptId; nextAttemptOrdinal: number; replayPolicy: "safe-read" }>
  | Readonly<{ kind: "block-never"; code: "uncertain-nonreplayable" }>
  | Readonly<{ kind: "quarantined"; reason: "cancelled-epoch" | "superseded" }>
  | Readonly<{ kind: "no-action"; reason: "terminal" | "superseded" }>
  | Readonly<{ kind: "not-found" }>;

export interface ReducedAttemptState {
  readonly attemptId: string;
  readonly taskId: string;
  readonly executionEpoch: number;
  readonly ordinal: number;
  readonly replayPolicy: "safe-read" | "never";
  readonly phase: "intent" | "started" | "failed" | "result" | "records" | "committed" | "quarantined";
  readonly failureState: "retryable-failed" | "terminal-failed" | "cancelled" | "superseded" | null;
  readonly transactionId: string | null;
  readonly resultSeq: number | null;
  readonly quarantineReason: "cancelled-epoch" | "superseded" | null;
}

export interface ReducedStartedRetryState {
  readonly attemptId: AttemptId;
  readonly attemptOrdinal: number;
  readonly schedule: RetrySchedule;
}

export interface ReducedOperationState {
  readonly logicalOperationId: string;
  readonly attempts: readonly ReducedAttemptState[];
  readonly schedules: readonly RetrySchedule[];
  readonly consumedScheduleIds: readonly string[];
  readonly startedRetries: readonly ReducedStartedRetryState[];
}

export interface ReducedLedgerState {
  readonly runState: RunSnapshot["state"] | null;
  readonly currentEpoch: number;
  readonly operations: Readonly<Record<string, ReducedOperationState>>;
  readonly cancelledEpochs: Readonly<Record<string, number>>;
}

export class LedgerReducerCorruptionError extends Error {
  readonly code: string;
  readonly eventSeq: number;
  readonly eventIndex: number;

  constructor(code: string, eventSeq: number, eventIndex: number) {
    super(`Ledger reduction failed at event ${eventIndex} (sequence ${eventSeq}): ${code}`);
    this.name = "LedgerReducerCorruptionError";
    this.code = code;
    this.eventSeq = eventSeq;
    this.eventIndex = eventIndex;
  }
}

type FailureState = Exclude<ReducedAttemptState["failureState"], null>;
type AttemptPhase = ReducedAttemptState["phase"];

interface MutableAttempt {
  readonly record: AttemptRecord;
  phase: AttemptPhase;
  failureState: FailureState | null;
  result: { transactionId: string; seq: number } | null;
  quarantineReason: "cancelled-epoch" | "superseded" | null;
}

interface MutableSchedule {
  readonly schedule: RetrySchedule;
  readonly eventSeq: number;
  consumedByAttemptId: string | null;
}

interface MutableOperation {
  readonly attempts: MutableAttempt[];
  readonly schedules: MutableSchedule[];
}

interface TransactionState {
  readonly attemptId: string;
  readonly resultSeq: number;
  recordsCommitted: boolean;
  quarantined: boolean;
}

const immutableAttemptFields: readonly (keyof AttemptRecord)[] = [
  "runId",
  "taskId",
  "attemptKind",
  "providerModel",
  "promptTemplateSha256",
  "logicalInputSha256",
  "toolAllowlist",
  "deadlineAt",
  "replayPolicy",
];

export function reduceLedgerEvents(events: readonly FoundationLedgerEvent[]): ReducedLedgerState {
  const attempts = new Map<string, MutableAttempt>();
  const operations = new Map<string, MutableOperation>();
  const tasks = new Map<string, { record: TaskRecord; event: FoundationLedgerEvent; index: number }>();
  const reservations = new Map<string, Set<string>>();
  const schedules = new Map<string, MutableSchedule>();
  const retryEdges = new Set<string>();
  const pendingScheduleOperations = new Set<string>();
  const retryStartsByAttempt = new Map<string, MutableSchedule>();
  const startedRetryPredecessors = new Set<string>();
  const committedOperations = new Set<string>();
  const transactions = new Map<string, TransactionState>();
  const committedRevisions = new Map<string, { manifestSha256: string; completionCommitId: string }>();
  const cancelledEpochs = new Map<number, number>();
  const resumedEpochs = new Set<number>();
  let runId: string | null = null;
  let runOrigin: { record: RunSnapshot; event: FoundationLedgerEvent; index: number } | null = null;
  let runState: RunSnapshot["state"] | null = null;
  let runDepth: RunSnapshot["depth"] | null = null;
  let runBlocker: RunSnapshot["blocker"] = null;
  let lastCheckpoint: RunSnapshot["checkpointStage"] = null;
  let currentEpoch = 0;

  const fail = (event: FoundationLedgerEvent, index: number, code: string): never => {
    throw new LedgerReducerCorruptionError(code, event.seq, index);
  };
  const requireAttempt = (event: FoundationLedgerEvent, index: number, attemptId: string): MutableAttempt => {
    const attempt = attempts.get(attemptId);
    if (!attempt) fail(event, index, "reducer.attempt-not-found");
    return attempt!;
  };
  const reserved = (kind: string, id: string) => reservations.get(kind)?.has(id) === true;

  events.forEach((event, index) => {
    if (event.seq !== index + 1) fail(event, index, "reducer.sequence");

    switch (event.type) {
      case "identity_reserved": {
        let identities = reservations.get(event.payload.kind);
        if (!identities) {
          identities = new Set();
          reservations.set(event.payload.kind, identities);
        }
        if (identities.has(event.payload.id)) fail(event, index, "reducer.duplicate-reservation");
        identities.add(event.payload.id);
        break;
      }
      case "run_created": {
        if (runId !== null) fail(event, index, "reducer.duplicate-run");
        if (event.payload.run.executionEpoch !== 0) fail(event, index, "reducer.initial-epoch");
        if (event.payload.run.state !== "created") fail(event, index, "reducer.initial-run-state");
        runId = event.payload.run.runId;
        runOrigin = { record: event.payload.run, event, index };
        runState = event.payload.run.state;
        runDepth = event.payload.run.depth;
        runBlocker = event.payload.run.blocker;
        lastCheckpoint = event.payload.run.checkpointStage;
        currentEpoch = 0;
        break;
      }
      case "state_changed": {
        if (runState === null) fail(event, index, "reducer.run-not-found");
        const currentRunState = runState!;
        if (currentRunState === "completed" || currentRunState === "cancelled") fail(event, index, "reducer.run-terminal");
        if (event.payload.from !== currentRunState) fail(event, index, "reducer.run-state-from");
        if (event.payload.to === "completed") fail(event, index, "reducer.completion-event-required");
        if (!isAllowedRunTransition(currentRunState, event.payload.to, runDepth, lastCheckpoint, runBlocker, event.payload.blocker)) {
          fail(event, index, "reducer.run-transition");
        }
        runState = event.payload.to;
        runBlocker = event.payload.blocker;
        if (isCheckpointStage(runState)) lastCheckpoint = runState;
        break;
      }
      case "task_upserted": {
        tasks.set(event.payload.task.taskId, { record: event.payload.task, event, index });
        break;
      }
      case "dispatch_intent": {
        const record = event.payload.attempt;
        if (runId === null || record.runId !== runId) fail(event, index, "reducer.run-not-found");
        if (!tasks.has(record.taskId)) fail(event, index, "reducer.task-not-found");
        if (!reserved("attempt", record.attemptId)) fail(event, index, "reducer.attempt-not-reserved");
        if (attempts.has(record.attemptId)) fail(event, index, "reducer.duplicate-attempt");
        if (record.state !== "intent-recorded") fail(event, index, "reducer.attempt-initial-state");
        if (record.executionEpoch !== currentEpoch || cancelledEpochs.has(currentEpoch)) fail(event, index, "reducer.attempt-epoch");

        let operation = operations.get(record.logicalOperationId);
        if (!operation) {
          operation = { attempts: [], schedules: [] };
          operations.set(record.logicalOperationId, operation);
        }
        const expectedOrdinal = operation.attempts.length + 1;
        if (record.attemptOrdinal !== expectedOrdinal) fail(event, index, "reducer.attempt-ordinal");
        if (expectedOrdinal === 1) {
          if (record.retryOfAttemptId !== null) fail(event, index, "reducer.retry-backlink");
        } else {
          const predecessor = operation.attempts[expectedOrdinal - 2]!;
          if (record.retryOfAttemptId !== predecessor.record.attemptId) fail(event, index, "reducer.retry-backlink");
          for (const field of immutableAttemptFields) {
            if (!equalField(record[field], operation.attempts[0]!.record[field])) fail(event, index, "reducer.retry-immutable");
          }
          const startedSchedule = retryStartsByAttempt.get(record.attemptId);
          if (!startedSchedule
            || startedSchedule.schedule.logicalOperationId !== record.logicalOperationId
            || startedSchedule.schedule.nextAttemptOrdinal !== record.attemptOrdinal
            || startedSchedule.schedule.failedAttemptId !== predecessor.record.attemptId) {
            fail(event, index, "reducer.retry-start-missing");
          }
        }
        const attempt: MutableAttempt = { record, phase: "intent", failureState: null, result: null, quarantineReason: null };
        attempts.set(record.attemptId, attempt);
        operation.attempts.push(attempt);
        break;
      }
      case "dispatch_started": {
        const attempt = requireAttempt(event, index, event.payload.attemptId);
        if (attempt.phase !== "intent") fail(event, index, "reducer.attempt-transition");
        attempt.phase = "started";
        break;
      }
      case "attempt_usage_recorded": {
        requireAttempt(event, index, event.payload.attemptId);
        break;
      }
      case "result_recorded": {
        const attempt = requireAttempt(event, index, event.payload.attemptId);
        if (!reserved("transaction", event.payload.transactionId)) fail(event, index, "reducer.transaction-not-reserved");
        if (transactions.has(event.payload.transactionId)) fail(event, index, "reducer.duplicate-transaction");
        if (attempt.result !== null || attempt.phase === "committed" || attempt.phase === "records") fail(event, index, "reducer.duplicate-result");
        const cancellationSeq = cancelledEpochs.get(attempt.record.executionEpoch);
        const retryWasStarted = startedRetryPredecessors.has(attempt.record.attemptId);
        const quarantined = attempt.failureState === "superseded"
          || retryWasStarted
          || (cancellationSeq !== undefined && event.seq > cancellationSeq);
        if (!quarantined && attempt.phase !== "started") fail(event, index, "reducer.attempt-transition");
        attempt.result = { transactionId: event.payload.transactionId, seq: event.seq };
        const transaction: TransactionState = {
          attemptId: attempt.record.attemptId,
          resultSeq: event.seq,
          recordsCommitted: false,
          quarantined,
        };
        transactions.set(event.payload.transactionId, transaction);
        if (quarantined) {
          attempt.phase = "quarantined";
          attempt.failureState = "superseded";
          attempt.quarantineReason = cancellationSeq !== undefined && event.seq > cancellationSeq ? "cancelled-epoch" : "superseded";
          break;
        }
        attempt.phase = "result";
        break;
      }
      case "records_committed": {
        const transaction = transactions.get(event.payload.transactionId);
        if (!transaction) fail(event, index, "reducer.transaction-not-found");
        const committedTransaction = transaction!;
        if (committedTransaction.quarantined) fail(event, index, "reducer.transaction-quarantined");
        if (committedTransaction.resultSeq !== event.payload.sourceResultSeq) fail(event, index, "reducer.source-result-link");
        if (committedTransaction.recordsCommitted) fail(event, index, "reducer.duplicate-records-commit");
        const attempt = requireAttempt(event, index, committedTransaction.attemptId);
        if (attempt.phase !== "result") fail(event, index, "reducer.attempt-transition");
        committedTransaction.recordsCommitted = true;
        attempt.phase = "records";
        break;
      }
      case "attempt_committed": {
        const attempt = requireAttempt(event, index, event.payload.attemptId);
        const transaction = transactions.get(event.payload.transactionId);
        if (!attempt.result || !transaction?.recordsCommitted) fail(event, index, "reducer.records-not-committed");
        const result = attempt.result!;
        const committedTransaction = transaction!;
        if (result.transactionId !== event.payload.transactionId
          || result.seq !== event.payload.sourceResultSeq
          || committedTransaction.attemptId !== event.payload.attemptId) fail(event, index, "reducer.commit-link");
        if (attempt.record.taskId !== event.payload.taskId) fail(event, index, "reducer.commit-task");
        if (attempt.phase !== "records") fail(event, index, "reducer.attempt-transition");
        if (committedOperations.has(attempt.record.logicalOperationId)) fail(event, index, "reducer.duplicate-operation-commit");
        committedOperations.add(attempt.record.logicalOperationId);
        attempt.phase = "committed";
        break;
      }
      case "attempt_failed": {
        const attempt = requireAttempt(event, index, event.payload.attemptId);
        if (attempt.phase === "committed" || attempt.phase === "records") fail(event, index, "reducer.attempt-transition");
        if (attempt.failureState !== null) {
          const retryWasStarted = startedRetryPredecessors.has(attempt.record.attemptId);
          if (attempt.failureState === "retryable-failed" && event.payload.state === "superseded" && retryWasStarted) {
            attempt.failureState = "superseded";
            attempt.phase = "failed";
            break;
          }
          fail(event, index, "reducer.duplicate-failure");
        }
        if (attempt.phase === "result" && event.payload.state !== "superseded") fail(event, index, "reducer.attempt-transition");
        attempt.failureState = event.payload.state;
        attempt.phase = event.payload.state === "superseded" && attempt.result ? "quarantined" : "failed";
        if (attempt.phase === "quarantined") attempt.quarantineReason = "superseded";
        break;
      }
      case "retry_scheduled": {
        if (!reserved("retry-schedule", event.payload.scheduleId)) fail(event, index, "reducer.schedule-not-reserved");
        if (schedules.has(event.payload.scheduleId)) fail(event, index, "reducer.duplicate-schedule");
        const predecessor = requireAttempt(event, index, event.payload.failedAttemptId);
        if (predecessor.failureState !== "retryable-failed" || predecessor.record.replayPolicy !== "safe-read") fail(event, index, "reducer.retry-predecessor");
        if (predecessor.record.logicalOperationId !== event.payload.logicalOperationId
          || event.payload.nextAttemptOrdinal !== predecessor.record.attemptOrdinal + 1) fail(event, index, "reducer.retry-edge");
        const operation = operations.get(event.payload.logicalOperationId)!;
        const edge = retryEdge(event.payload.logicalOperationId, event.payload.failedAttemptId, event.payload.nextAttemptOrdinal);
        if (retryEdges.has(edge)) fail(event, index, "reducer.duplicate-retry-edge");
        if (pendingScheduleOperations.has(event.payload.logicalOperationId)) fail(event, index, "reducer.multiple-pending-schedules");
        const cancellationSeq = cancelledEpochs.get(predecessor.record.executionEpoch);
        if (cancellationSeq !== undefined && event.seq > cancellationSeq && currentEpoch === predecessor.record.executionEpoch) {
          fail(event, index, "reducer.retry-after-cancel");
        }
        const schedule: RetrySchedule = Object.freeze({ schemaVersion: 1, ...event.payload, replayPolicy: "safe-read" });
        const mutable: MutableSchedule = { schedule, eventSeq: event.seq, consumedByAttemptId: null };
        schedules.set(schedule.scheduleId, mutable);
        retryEdges.add(edge);
        pendingScheduleOperations.add(event.payload.logicalOperationId);
        operation.schedules.push(mutable);
        break;
      }
      case "retry_started": {
        const schedule = schedules.get(event.payload.scheduleId);
        if (!schedule) fail(event, index, "reducer.schedule-not-found");
        const startedSchedule = schedule!;
        if (startedSchedule.consumedByAttemptId !== null || retryStartsByAttempt.has(event.payload.attemptId)) fail(event, index, "reducer.duplicate-retry-start");
        if (event.payload.scheduledFromSeq !== startedSchedule.eventSeq) fail(event, index, "reducer.retry-schedule-seq");
        if (event.payload.logicalOperationId !== startedSchedule.schedule.logicalOperationId
          || event.payload.attemptOrdinal !== startedSchedule.schedule.nextAttemptOrdinal) fail(event, index, "reducer.retry-start-link");
        if (!reserved("attempt", event.payload.attemptId) || attempts.has(event.payload.attemptId)) fail(event, index, "reducer.retry-attempt-identity");
        const predecessor = requireAttempt(event, index, startedSchedule.schedule.failedAttemptId);
        const cancellationSeq = cancelledEpochs.get(predecessor.record.executionEpoch);
        if (cancellationSeq !== undefined && event.seq > cancellationSeq && currentEpoch === predecessor.record.executionEpoch) {
          fail(event, index, "reducer.retry-after-cancel");
        }
        startedSchedule.consumedByAttemptId = event.payload.attemptId;
        pendingScheduleOperations.delete(startedSchedule.schedule.logicalOperationId);
        startedRetryPredecessors.add(startedSchedule.schedule.failedAttemptId);
        retryStartsByAttempt.set(event.payload.attemptId, startedSchedule);
        break;
      }
      case "cancel_requested": {
        if (runId === null || event.payload.executionEpoch !== currentEpoch) fail(event, index, "reducer.cancel-epoch");
        if (cancelledEpochs.has(currentEpoch)) fail(event, index, "reducer.duplicate-cancel");
        cancelledEpochs.set(currentEpoch, event.seq);
        break;
      }
      case "resume_epoch_started": {
        if (event.payload.priorEpoch !== currentEpoch
          || event.payload.executionEpoch !== currentEpoch + 1) fail(event, index, "reducer.resume-epoch");
        if (resumedEpochs.has(event.payload.executionEpoch)) fail(event, index, "reducer.duplicate-resume");
        const cancelSeq = cancelledEpochs.get(currentEpoch);
        if (cancelSeq === undefined || event.payload.priorCancelSeq !== cancelSeq) fail(event, index, "reducer.resume-cancel-link");
        resumedEpochs.add(event.payload.executionEpoch);
        currentEpoch = event.payload.executionEpoch;
        if (event.payload.checkpointStage !== null) lastCheckpoint = event.payload.checkpointStage;
        break;
      }
      case "request_intent_recorded":
      case "request_result_recorded":
      case "request_retry_scheduled":
      case "request_retry_started": {
        requireAttempt(event, index, event.payload.attemptId);
        break;
      }
      case "revision_committed": {
        if (!reserved("revision", event.payload.revisionId)) fail(event, index, "reducer.revision-not-reserved");
        if (committedRevisions.has(event.payload.revisionId)) fail(event, index, "reducer.duplicate-revision-commit");
        committedRevisions.set(event.payload.revisionId, {
          manifestSha256: event.payload.manifestSha256,
          completionCommitId: event.payload.completionCommitId,
        });
        break;
      }
      case "run_completed": {
        if (runState === "completed" || runState === "cancelled") fail(event, index, "reducer.run-terminal");
        if (runState !== "synthesizing") fail(event, index, "reducer.run-completion-state");
        const revision = committedRevisions.get(event.payload.revisionId);
        if (!revision) fail(event, index, "reducer.revision-not-committed");
        const committedRevision = revision!;
        if (committedRevision.manifestSha256 !== event.payload.manifestSha256
          || committedRevision.completionCommitId !== event.payload.completionCommitId) {
          fail(event, index, "reducer.run-completion-link");
        }
        runState = "completed";
        runBlocker = null;
        break;
      }
      case "active_time_checkpoint":
      case "budget_amended":
      case "lock_recovered":
      case "revision_prepared":
      case "revision_failed":
        break;
      default:
        assertNever(event);
    }
  });

  const finalRunOrigin = runOrigin as unknown as { record: RunSnapshot; event: FoundationLedgerEvent; index: number } | null;
  if (finalRunOrigin) {
    for (const reference of finalRunOrigin.record.taskRefs) {
      const task = tasks.get(reference.taskId);
      if (!task || task.record.revision !== reference.revision) fail(finalRunOrigin.event, finalRunOrigin.index, "reducer.run-task-ref");
    }
    for (const reference of finalRunOrigin.record.attemptRefs) {
      const attempt = attempts.get(reference.attemptId);
      if (!attempt || attempt.record.revision !== reference.revision) fail(finalRunOrigin.event, finalRunOrigin.index, "reducer.run-attempt-ref");
    }
  }
  for (const { record, event, index } of tasks.values()) {
    for (const attemptId of record.attemptIds) {
      if (!attempts.has(attemptId)) fail(event, index, "reducer.task-attempt-ref");
    }
  }

  const operationOutput = Object.create(null) as Record<string, ReducedOperationState>;
  for (const [logicalOperationId, operation] of operations) {
    const attemptOutput = operation.attempts.map<ReducedAttemptState>((attempt) => Object.freeze({
      attemptId: attempt.record.attemptId,
      taskId: attempt.record.taskId,
      executionEpoch: attempt.record.executionEpoch,
      ordinal: attempt.record.attemptOrdinal,
      replayPolicy: attempt.record.replayPolicy,
      phase: attempt.phase,
      failureState: attempt.failureState,
      transactionId: attempt.result?.transactionId ?? null,
      resultSeq: attempt.result?.seq ?? null,
      quarantineReason: attempt.quarantineReason,
    }));
    const scheduleOutput = operation.schedules.map(({ schedule }) => schedule);
    const consumed = operation.schedules.flatMap(({ schedule, consumedByAttemptId }) => consumedByAttemptId === null ? [] : [schedule.scheduleId]);
    const startedRetries = operation.schedules.flatMap<ReducedStartedRetryState>(({ schedule, consumedByAttemptId }) => {
      if (consumedByAttemptId === null || attempts.has(consumedByAttemptId)) return [];
      return [Object.freeze({
        attemptId: consumedByAttemptId as AttemptId,
        attemptOrdinal: schedule.nextAttemptOrdinal,
        schedule,
      })];
    });
    operationOutput[logicalOperationId] = Object.freeze({
      logicalOperationId,
      attempts: Object.freeze(attemptOutput),
      schedules: Object.freeze(scheduleOutput),
      consumedScheduleIds: Object.freeze(consumed),
      startedRetries: Object.freeze(startedRetries),
    });
  }
  const cancellationOutput = Object.create(null) as Record<string, number>;
  for (const [epoch, seq] of cancelledEpochs) cancellationOutput[String(epoch)] = seq;
  return Object.freeze({
    runState,
    currentEpoch,
    operations: Object.freeze(operationOutput),
    cancelledEpochs: Object.freeze(cancellationOutput),
  });
}

export function recoveryDecisionFor(state: ReducedLedgerState, logicalOperationId: string): RecoveryDecision {
  const operation = state.operations[logicalOperationId];
  if (!operation) return Object.freeze({ kind: "not-found" });
  if (operation.attempts.some((attempt) => attempt.phase === "committed")) return Object.freeze({ kind: "skip-committed" });
  const latest = operation.attempts.at(-1);
  if (!latest) return Object.freeze({ kind: "not-found" });
  if (state.currentEpoch === latest.executionEpoch && state.cancelledEpochs[String(latest.executionEpoch)] !== undefined) {
    return Object.freeze({ kind: "quarantined", reason: "cancelled-epoch" });
  }
  const startedRetry = operation.startedRetries.at(-1);
  if (startedRetry) {
    return Object.freeze({
      kind: "resume-started-retry",
      attemptId: startedRetry.attemptId,
      attemptOrdinal: startedRetry.attemptOrdinal,
      schedule: startedRetry.schedule,
    });
  }
  if (latest.phase === "quarantined") {
    return Object.freeze({ kind: "quarantined", reason: latest.quarantineReason ?? "superseded" });
  }
  if ((latest.phase === "result" || latest.phase === "records") && latest.transactionId) {
    return Object.freeze({ kind: "finish-transaction", transactionId: latest.transactionId as TransactionId });
  }
  if (latest.replayPolicy === "never") return Object.freeze({ kind: "block-never", code: "uncertain-nonreplayable" });
  const consumed = new Set(operation.consumedScheduleIds);
  const pending = operation.schedules.find((schedule) => !consumed.has(schedule.scheduleId)
    && schedule.failedAttemptId === latest.attemptId
    && schedule.nextAttemptOrdinal === latest.ordinal + 1);
  if (pending) return Object.freeze({ kind: "retry-safe-read", schedule: pending });
  if (latest.failureState === "terminal-failed" || latest.failureState === "cancelled") {
    return Object.freeze({ kind: "no-action", reason: "terminal" });
  }
  if (latest.failureState === "superseded") return Object.freeze({ kind: "no-action", reason: "superseded" });
  return Object.freeze({
    kind: "needs-retry-schedule",
    failedAttemptId: latest.attemptId as AttemptId,
    nextAttemptOrdinal: latest.ordinal + 1,
    replayPolicy: "safe-read",
  });
}

function isCheckpointStage(state: RunSnapshot["state"]): state is NonNullable<RunSnapshot["checkpointStage"]> {
  return state === "planning" || state === "researching" || state === "verifying" || state === "synthesizing";
}

function isAllowedRunTransition(
  from: RunSnapshot["state"],
  to: RunSnapshot["state"],
  depth: RunSnapshot["depth"] | null,
  lastCheckpoint: RunSnapshot["checkpointStage"],
  currentBlocker: RunSnapshot["blocker"],
  nextBlocker: RunSnapshot["blocker"],
): boolean {
  if (to === "failed" && nextBlocker === null) return false;
  if (to !== "failed" && to !== "paused" && nextBlocker !== null) return false;
  switch (from) {
    case "created":
      return to === "planning" || to === "cancelled" || to === "failed";
    case "planning":
      return to === "researching" || to === "paused" || to === "cancelled" || to === "failed";
    case "researching":
      return to === "verifying"
        || (to === "synthesizing" && depth === "quick")
        || to === "paused"
        || to === "cancelled"
        || to === "failed";
    case "verifying":
      return to === "researching" || to === "synthesizing" || to === "paused" || to === "cancelled" || to === "failed";
    case "synthesizing":
      return to === "paused" || to === "cancelled" || to === "failed";
    case "recovering":
      return to === lastCheckpoint || to === "paused" || to === "cancelled" || to === "failed";
    case "paused":
      return to === "recovering" || to === "cancelled" || to === "failed";
    case "failed":
      return to === "recovering"
        && currentBlocker !== null
        && currentBlocker.code.startsWith("retryable-")
        && nextBlocker === null;
    case "cancelled":
    case "completed":
      return false;
  }
}

function retryEdge(logicalOperationId: string, failedAttemptId: string, nextAttemptOrdinal: number): string {
  return JSON.stringify([logicalOperationId, failedAttemptId, nextAttemptOrdinal]);
}

function equalField(left: AttemptRecord[keyof AttemptRecord], right: AttemptRecord[keyof AttemptRecord]): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => value === right[index]);
  return left === right;
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled ledger event: ${String(value)}`);
}
