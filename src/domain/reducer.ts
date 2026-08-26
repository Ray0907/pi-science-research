import { canonicalJson } from "../crypto/canonical-json.js";
import type { FoundationLedgerEvent, RequestIntentRecord, RequestRecord } from "./events.js";
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
  readonly activeScheduleIds: readonly string[];
  readonly consumedScheduleIds: readonly string[];
  readonly startedRetries: readonly ReducedStartedRetryState[];
  readonly recoveryDecision: RecoveryDecision;
}

export interface ReducedRequestState {
  readonly requestId: string;
  readonly attemptId: string;
  readonly executionEpoch: number;
  readonly logicalRequestId: string;
  readonly physicalAttemptOrdinal: number;
  readonly status: RequestRecord["status"] | "intent";
  readonly cacheEligible: boolean;
  readonly quarantined: boolean;
}

export interface ReducedLedgerState {
  readonly runState: RunSnapshot["state"] | null;
  readonly currentEpoch: number;
  readonly operations: Readonly<Record<string, ReducedOperationState>>;
  readonly requests: Readonly<Record<string, ReducedRequestState>>;
  readonly cacheEligibleRequestIds: readonly string[];
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
  readonly executionEpoch: number;
  consumedByAttemptId: string | null;
}

interface MutableOperation {
  readonly attempts: MutableAttempt[];
  readonly attemptOrdinals: Set<number>;
  readonly schedules: MutableSchedule[];
}

interface MutableRequest {
  readonly intent: RequestIntentRecord;
  readonly intentEvent: Extract<FoundationLedgerEvent, { type: "request_intent_recorded" }>;
  result: RequestRecord | null;
  resultSeq: number | null;
  quarantined: boolean;
}

interface MutableRequestSchedule {
  readonly event: Extract<FoundationLedgerEvent, { type: "request_retry_scheduled" }>;
  readonly executionEpoch: number;
  startedRequestId: string | null;
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
  const scheduleClasses = new Map<string, "attempt" | "request">();
  const retryEdges = new Map<string, MutableSchedule>();
  const pendingScheduleOperations = new Map<string, MutableSchedule>();
  const pendingSchedulesByEpoch = new Map<number, Set<MutableSchedule>>();
  const retryStartsByAttempt = new Map<string, MutableSchedule>();
  const startedRetryPredecessors = new Set<string>();
  const committedOperations = new Set<string>();
  const transactions = new Map<string, TransactionState>();
  const committedRevisions = new Map<string, { manifestSha256: string; completionCommitId: string }>();
  const cancelledEpochs = new Map<number, number>();
  const cancelReasons = new Map<number, Extract<FoundationLedgerEvent, { type: "cancel_requested" }>["payload"]["reason"]>();
  const resumedEpochs = new Set<number>();
  const requests = new Map<string, MutableRequest>();
  const attemptTaskOwners = new Map<string, string>();
  const requestIntentBySeq = new Map<number, MutableRequest>();
  const requestSchedules = new Map<string, MutableRequestSchedule>();
  const requestScheduleEdges = new Map<string, MutableRequestSchedule>();
  const requestStarts = new Map<string, { schedule: MutableRequestSchedule; attemptId: string; ordinal: number }>();
  const requestSeriesOrdinals = new Map<string, string>();
  const journalPositions = new Map<string, string>();
  const journalHashes = new Set<string>();
  const journalNextSeq = new Map<string, number>();
  let resumeTransitionPending = false;
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
  const requireLiveRequestTarget = (event: FoundationLedgerEvent, index: number, attemptId: string): MutableAttempt => {
    const attempt = requireAttempt(event, index, attemptId);
    if (attempt.phase !== "started" || attempt.failureState !== null) fail(event, index, "reducer.request-target-state");
    const task = tasks.get(attempt.record.taskId)?.record;
    if (!task || task.state !== "running" || task.attemptIds.filter((id) => id === attemptId).length !== 1
      || attemptTaskOwners.get(attemptId) !== task.taskId) fail(event, index, "reducer.request-target-task");
    if (attempt.record.executionEpoch !== currentEpoch || cancelledEpochs.has(attempt.record.executionEpoch)) {
      fail(event, index, "reducer.request-target-epoch");
    }
    return attempt;
  };
  const recordJournal = (event: FoundationLedgerEvent & { payload: { attemptId: string; journalLocalSeq: number; journalEntrySha256: string } }, index: number): void => {
    const key = `${event.payload.attemptId}\0${event.payload.journalLocalSeq}`;
    const hashKey = `${event.payload.attemptId}\0${event.payload.journalEntrySha256}`;
    if (journalPositions.has(key)) fail(event, index, "reducer.request-journal-position");
    if (journalHashes.has(hashKey)) fail(event, index, "reducer.request-journal-hash");
    const expected = journalNextSeq.get(event.payload.attemptId) ?? 1;
    if (event.payload.journalLocalSeq !== expected) fail(event, index, "reducer.request-journal-sequence");
    journalPositions.set(key, event.payload.journalEntrySha256);
    journalHashes.add(hashKey);
    journalNextSeq.set(event.payload.attemptId, expected + 1);
  };

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
        const currentCancelReason = cancelReasons.get(currentEpoch);
        if (currentCancelReason === "user-abandon" && event.payload.to !== "cancelled") fail(event, index, "reducer.abandon-transition");
        if (currentCancelReason !== undefined && currentCancelReason !== "user-abandon"
          && event.payload.to !== "paused" && event.payload.to !== "cancelled" && !resumeTransitionPending) {
          fail(event, index, "reducer.cancel-transition");
        }
        if (event.payload.to === "recovering" && currentRunState === "paused") {
          if (!resumeTransitionPending) fail(event, index, "reducer.resume-transition");
          resumeTransitionPending = false;
        } else if (resumeTransitionPending) {
          fail(event, index, "reducer.resume-transition");
        }
        runState = event.payload.to;
        runBlocker = event.payload.blocker;
        if (isCheckpointStage(runState)) lastCheckpoint = runState;
        break;
      }
      case "task_upserted": {
        const next = event.payload.task;
        const prior = tasks.get(next.taskId);
        if (!prior) {
          if (next.revision !== 1) fail(event, index, "reducer.task-revision");
        } else {
          if (next.revision !== prior.record.revision + 1) fail(event, index, "reducer.task-revision");
          if (prior.record.state === "resolved" || prior.record.state === "cancelled") fail(event, index, "reducer.task-terminal");
          if (!isAllowedTaskTransition(prior.record.state, next.state)) fail(event, index, "reducer.task-transition");
          if (next.attemptIds.length < prior.record.attemptIds.length
            || prior.record.attemptIds.some((id, offset) => next.attemptIds[offset] !== id)) fail(event, index, "reducer.task-attempt-history");
        }
        if (new Set(next.attemptIds).size !== next.attemptIds.length) fail(event, index, "reducer.task-attempt-history");
        for (const attemptId of next.attemptIds) {
          if (!reserved("attempt", attemptId)) fail(event, index, "reducer.task-attempt-not-reserved");
          const owner = attemptTaskOwners.get(attemptId);
          if (owner !== undefined && owner !== next.taskId) fail(event, index, "reducer.task-attempt-owner");
          attemptTaskOwners.set(attemptId, next.taskId);
        }
        if (next.state === "resolved") {
          const committed = next.attemptIds.some((id) => attempts.get(id)?.phase === "committed" && attempts.get(id)?.record.taskId === next.taskId);
          if (!committed || next.resolution === null) fail(event, index, "reducer.task-resolution");
        }
        tasks.set(next.taskId, { record: next, event, index });
        break;
      }
      case "dispatch_intent": {
        if (resumeTransitionPending) fail(event, index, "reducer.resume-transition-pending");
        const record = event.payload.attempt;
        if (runId === null || record.runId !== runId) fail(event, index, "reducer.run-not-found");
        const owningTask = tasks.get(record.taskId);
        if (!owningTask) fail(event, index, "reducer.task-not-found");
        if (owningTask!.record.state !== "running") fail(event, index, "reducer.dispatch-task-state");
        if (owningTask!.record.attemptIds.filter((id) => id === record.attemptId).length !== 1
          || attemptTaskOwners.get(record.attemptId) !== record.taskId) fail(event, index, "reducer.dispatch-task-owner");
        if (!reserved("attempt", record.attemptId)) fail(event, index, "reducer.attempt-not-reserved");
        if (attempts.has(record.attemptId)) fail(event, index, "reducer.duplicate-attempt");
        if (record.state !== "intent-recorded") fail(event, index, "reducer.attempt-initial-state");
        if (record.executionEpoch !== currentEpoch || cancelledEpochs.has(currentEpoch)) fail(event, index, "reducer.attempt-epoch");

        const declaredRetry = retryStartsByAttempt.get(record.attemptId);
        if (declaredRetry) {
          const linkedOperation = operations.get(declaredRetry.schedule.logicalOperationId)!;
          const linkedPredecessor = attempts.get(declaredRetry.schedule.failedAttemptId)!;
          const frozenBaseline = linkedOperation.attempts[0]!.record;
          const linked = record.logicalOperationId === declaredRetry.schedule.logicalOperationId
            && record.attemptOrdinal === declaredRetry.schedule.nextAttemptOrdinal
            && record.retryOfAttemptId === linkedPredecessor.record.attemptId
            && record.replayPolicy === "safe-read"
            && declaredRetry.executionEpoch === record.executionEpoch
            && immutableAttemptFields.every((field) => equalField(record[field], frozenBaseline[field]));
          if (!linked) fail(event, index, "reducer.retry-dispatch-link");
        }

        let operation = operations.get(record.logicalOperationId);
        if (!operation) {
          operation = { attempts: [], attemptOrdinals: new Set(), schedules: [] };
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
          const startedSchedule = declaredRetry;
          if (!startedSchedule
            || startedSchedule.executionEpoch !== record.executionEpoch
            || startedSchedule.schedule.logicalOperationId !== record.logicalOperationId
            || startedSchedule.schedule.nextAttemptOrdinal !== record.attemptOrdinal
            || startedSchedule.schedule.failedAttemptId !== predecessor.record.attemptId) {
            fail(event, index, "reducer.retry-start-missing");
          }
        }
        const attempt: MutableAttempt = { record, phase: "intent", failureState: null, result: null, quarantineReason: null };
        attempts.set(record.attemptId, attempt);
        operation.attempts.push(attempt);
        operation.attemptOrdinals.add(record.attemptOrdinal);
        if (declaredRetry) startedRetryPredecessors.add(declaredRetry.schedule.failedAttemptId);
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
        const retryWasStarted = startedRetryPredecessors.has(attempt.record.attemptId);
        if (event.payload.state === "superseded" && !retryWasStarted) {
          fail(event, index, "reducer.superseded-without-replacement");
        }
        if (attempt.phase === "committed" || attempt.phase === "records") fail(event, index, "reducer.attempt-transition");
        if (attempt.failureState !== null) {
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
        if (resumeTransitionPending) fail(event, index, "reducer.resume-transition-pending");
        if (!reserved("retry-schedule", event.payload.scheduleId)) fail(event, index, "reducer.schedule-not-reserved");
        if (scheduleClasses.has(event.payload.scheduleId)) fail(event, index, "reducer.schedule-namespace");
        if (schedules.has(event.payload.scheduleId)) fail(event, index, "reducer.duplicate-schedule");
        const predecessor = requireAttempt(event, index, event.payload.failedAttemptId);
        if (predecessor.failureState !== "retryable-failed" || predecessor.record.replayPolicy !== "safe-read") fail(event, index, "reducer.retry-predecessor");
        if (predecessor.record.logicalOperationId !== event.payload.logicalOperationId
          || event.payload.nextAttemptOrdinal !== predecessor.record.attemptOrdinal + 1) fail(event, index, "reducer.retry-edge");
        if (cancelledEpochs.has(currentEpoch)) fail(event, index, "reducer.retry-after-cancel");
        const operation = operations.get(event.payload.logicalOperationId)!;
        const edge = retryEdge(event.payload.logicalOperationId, event.payload.failedAttemptId, event.payload.nextAttemptOrdinal);
        const priorEdge = retryEdges.get(edge);
        if (priorEdge && !cancelledEpochs.has(priorEdge.executionEpoch)) fail(event, index, "reducer.duplicate-retry-edge");
        if (operation.attemptOrdinals.has(event.payload.nextAttemptOrdinal)) {
          fail(event, index, "reducer.duplicate-retry-edge");
        }
        if (pendingScheduleOperations.has(event.payload.logicalOperationId)) fail(event, index, "reducer.multiple-pending-schedules");
        const schedule: RetrySchedule = Object.freeze({ schemaVersion: 1, ...event.payload, replayPolicy: "safe-read" });
        const mutable: MutableSchedule = { schedule, eventSeq: event.seq, executionEpoch: currentEpoch, consumedByAttemptId: null };
        schedules.set(schedule.scheduleId, mutable);
        scheduleClasses.set(schedule.scheduleId, "attempt");
        retryEdges.set(edge, mutable);
        pendingScheduleOperations.set(event.payload.logicalOperationId, mutable);
        let epochSchedules = pendingSchedulesByEpoch.get(currentEpoch);
        if (!epochSchedules) {
          epochSchedules = new Set();
          pendingSchedulesByEpoch.set(currentEpoch, epochSchedules);
        }
        epochSchedules.add(mutable);
        operation.schedules.push(mutable);
        break;
      }
      case "retry_started": {
        if (resumeTransitionPending) fail(event, index, "reducer.resume-transition-pending");
        if (scheduleClasses.get(event.payload.scheduleId) !== "attempt") fail(event, index, "reducer.schedule-namespace");
        const schedule = schedules.get(event.payload.scheduleId);
        if (!schedule) fail(event, index, "reducer.schedule-not-found");
        const startedSchedule = schedule!;
        if (startedSchedule.consumedByAttemptId !== null || retryStartsByAttempt.has(event.payload.attemptId)) fail(event, index, "reducer.duplicate-retry-start");
        if (event.payload.scheduledFromSeq !== startedSchedule.eventSeq) fail(event, index, "reducer.retry-schedule-seq");
        if (event.payload.logicalOperationId !== startedSchedule.schedule.logicalOperationId
          || event.payload.attemptOrdinal !== startedSchedule.schedule.nextAttemptOrdinal) fail(event, index, "reducer.retry-start-link");
        if (!reserved("attempt", event.payload.attemptId) || attempts.has(event.payload.attemptId)) fail(event, index, "reducer.retry-attempt-identity");
        requireAttempt(event, index, startedSchedule.schedule.failedAttemptId);
        if (cancelledEpochs.has(startedSchedule.executionEpoch) || startedSchedule.executionEpoch !== currentEpoch) {
          fail(event, index, "reducer.retry-after-cancel");
        }
        startedSchedule.consumedByAttemptId = event.payload.attemptId;
        if (pendingScheduleOperations.get(startedSchedule.schedule.logicalOperationId) === startedSchedule) {
          pendingScheduleOperations.delete(startedSchedule.schedule.logicalOperationId);
        }
        pendingSchedulesByEpoch.get(startedSchedule.executionEpoch)?.delete(startedSchedule);
        retryStartsByAttempt.set(event.payload.attemptId, startedSchedule);
        break;
      }
      case "cancel_requested": {
        if (runId === null || event.payload.executionEpoch !== currentEpoch) fail(event, index, "reducer.cancel-epoch");
        if (cancelledEpochs.has(currentEpoch)) fail(event, index, "reducer.duplicate-cancel");
        cancelledEpochs.set(currentEpoch, event.seq);
        cancelReasons.set(currentEpoch, event.payload.reason);
        for (const schedule of pendingSchedulesByEpoch.get(currentEpoch) ?? []) {
          if (pendingScheduleOperations.get(schedule.schedule.logicalOperationId) === schedule) {
            pendingScheduleOperations.delete(schedule.schedule.logicalOperationId);
          }
        }
        pendingSchedulesByEpoch.delete(currentEpoch);
        break;
      }
      case "resume_epoch_started": {
        if (runState === "completed" || runState === "cancelled") fail(event, index, "reducer.run-terminal");
        if (runState !== "paused") fail(event, index, "reducer.resume-state");
        if (event.payload.priorEpoch !== currentEpoch
          || event.payload.executionEpoch !== currentEpoch + 1) fail(event, index, "reducer.resume-epoch");
        if (resumedEpochs.has(event.payload.executionEpoch)) fail(event, index, "reducer.duplicate-resume");
        const cancelSeq = cancelledEpochs.get(currentEpoch);
        const reason = cancelReasons.get(currentEpoch);
        if (cancelSeq === undefined || event.payload.priorCancelSeq !== cancelSeq) fail(event, index, "reducer.resume-cancel-link");
        if (reason === "user-abandon" || reason === undefined) fail(event, index, "reducer.resume-terminal-cancel");
        if (event.payload.checkpointStage !== lastCheckpoint) fail(event, index, "reducer.resume-checkpoint");
        resumedEpochs.add(event.payload.executionEpoch);
        currentEpoch = event.payload.executionEpoch;
        resumeTransitionPending = true;
        if (event.payload.checkpointStage !== null) lastCheckpoint = event.payload.checkpointStage;
        break;
      }
      case "request_intent_recorded": {
        if (resumeTransitionPending) fail(event, index, "reducer.resume-transition-pending");
        const attempt = requireAttempt(event, index, event.payload.attemptId);
        recordJournal(event, index);
        const intent = event.payload.intent;
        if (intent.attemptId !== event.payload.attemptId || intent.executionEpoch !== attempt.record.executionEpoch) fail(event, index, "reducer.request-owner");
        if (!reserved("request", intent.requestId) || requests.has(intent.requestId)) fail(event, index, "reducer.request-identity");
        if (intent.physicalAttemptOrdinal === 1) {
          if (cancelledEpochs.has(intent.executionEpoch)) fail(event, index, "reducer.request-cancelled");
          if (intent.retryOfRequestId !== null || requestStarts.has(intent.requestId)) fail(event, index, "reducer.request-backlink");
        } else {
          requireLiveRequestTarget(event, index, event.payload.attemptId);
          const started = requestStarts.get(intent.requestId);
          const predecessor = intent.retryOfRequestId === null ? undefined : requests.get(intent.retryOfRequestId);
          if (!started || !predecessor || started.attemptId !== intent.attemptId || started.ordinal !== intent.physicalAttemptOrdinal
            || started.schedule.event.payload.failedRequestId !== intent.retryOfRequestId
            || !sameRequestIdentity(predecessor.intent, intent)) fail(event, index, "reducer.request-start-link");
        }
        const seriesOrdinal = `${intent.logicalRequestId}\0${intent.physicalAttemptOrdinal}`;
        if (requestSeriesOrdinals.has(seriesOrdinal)) fail(event, index, "reducer.request-ordinal");
        const mutable: MutableRequest = { intent, intentEvent: event, result: null, resultSeq: null, quarantined: false };
        requests.set(intent.requestId, mutable);
        requestSeriesOrdinals.set(seriesOrdinal, intent.requestId);
        requestIntentBySeq.set(event.seq, mutable);
        break;
      }
      case "request_result_recorded": {
        const attempt = requireAttempt(event, index, event.payload.attemptId);
        recordJournal(event, index);
        const request = event.payload.request;
        const linked = requestIntentBySeq.get(event.payload.intentLedgerSeq);
        if (!linked || linked.result !== null || linked.intent.requestId !== request.requestId) fail(event, index, "reducer.request-intent-link");
        const matchedIntent = linked!;
        if (request.attemptId !== event.payload.attemptId || request.executionEpoch !== attempt.record.executionEpoch
          || !sameRequestIntentResult(matchedIntent.intent, request)) fail(event, index, "reducer.request-intent-mismatch");
        if (matchedIntent.intentEvent.payload.attemptId !== event.payload.attemptId) fail(event, index, "reducer.request-owner");
        if (!validRequestOutcome(request)) fail(event, index, "reducer.request-outcome");
        const cancelSeq = cancelledEpochs.get(request.executionEpoch);
        if (cancelSeq !== undefined && event.seq > cancelSeq) fail(event, index, "reducer.request-cancelled");
        matchedIntent.result = request;
        matchedIntent.resultSeq = event.seq;
        break;
      }
      case "request_retry_scheduled": {
        if (resumeTransitionPending) fail(event, index, "reducer.resume-transition-pending");
        requireAttempt(event, index, event.payload.attemptId);
        recordJournal(event, index);
        if (!reserved("retry-schedule", event.payload.scheduleId) || requestSchedules.has(event.payload.scheduleId)) fail(event, index, "reducer.request-schedule-identity");
        if (scheduleClasses.has(event.payload.scheduleId)) fail(event, index, "reducer.schedule-namespace");
        const predecessor = requests.get(event.payload.failedRequestId);
        if (!predecessor || predecessor.result?.status !== "retryable-error" || predecessor.intent.replayPolicy !== "safe-read"
          || predecessor.intent.logicalRequestId !== event.payload.logicalRequestId
          || predecessor.intent.physicalAttemptOrdinal + 1 !== event.payload.nextPhysicalAttemptOrdinal) fail(event, index, "reducer.request-schedule-link");
        const failedRequest = predecessor!;
        const owningAttempt = requireAttempt(event, index, failedRequest.intent.attemptId);
        if (owningAttempt.phase === "committed" || owningAttempt.phase === "quarantined"
          || owningAttempt.failureState === "cancelled" || owningAttempt.failureState === "terminal-failed"
          || owningAttempt.failureState === "superseded") fail(event, index, "reducer.request-schedule-attempt-state");
        if (tasks.get(owningAttempt.record.taskId)?.record.state !== "running") fail(event, index, "reducer.request-schedule-task-state");
        if (runState === "completed" || runState === "cancelled" || runState === "failed") fail(event, index, "reducer.request-schedule-run-state");
        if (event.payload.attemptId !== failedRequest.intent.attemptId
          || requireAttempt(event, index, event.payload.attemptId).record.executionEpoch !== failedRequest.intent.executionEpoch
          || failedRequest.intent.executionEpoch !== currentEpoch
          || cancelledEpochs.has(failedRequest.intent.executionEpoch)) fail(event, index, "reducer.request-schedule-owner");
        const edgeKey = `${event.payload.failedRequestId}\0${event.payload.nextPhysicalAttemptOrdinal}`;
        const priorEdge = requestScheduleEdges.get(edgeKey);
        if (priorEdge && !cancelledEpochs.has(priorEdge.executionEpoch)) fail(event, index, "reducer.request-schedule-link");
        const mutableSchedule = { event, executionEpoch: currentEpoch, startedRequestId: null };
        requestSchedules.set(event.payload.scheduleId, mutableSchedule);
        scheduleClasses.set(event.payload.scheduleId, "request");
        requestScheduleEdges.set(edgeKey, mutableSchedule);
        break;
      }
      case "request_retry_started": {
        if (resumeTransitionPending) fail(event, index, "reducer.resume-transition-pending");
        const attempt = requireLiveRequestTarget(event, index, event.payload.attemptId);
        recordJournal(event, index);
        if (scheduleClasses.get(event.payload.scheduleId) !== "request") fail(event, index, "reducer.schedule-namespace");
        const schedule = requestSchedules.get(event.payload.scheduleId);
        if (!schedule || schedule.startedRequestId !== null || schedule.event.seq !== event.payload.scheduledFromLedgerSeq
          || schedule.event.payload.logicalRequestId !== event.payload.logicalRequestId
          || schedule.event.payload.nextPhysicalAttemptOrdinal !== event.payload.physicalAttemptOrdinal
          || cancelledEpochs.has(schedule.executionEpoch) || attempt.record.executionEpoch !== currentEpoch
          || !reserved("request", event.payload.requestId) || requests.has(event.payload.requestId) || requestStarts.has(event.payload.requestId)) {
          fail(event, index, "reducer.request-retry-start-link");
        }
        const matchedSchedule = schedule!;
        matchedSchedule.startedRequestId = event.payload.requestId;
        requestStarts.set(event.payload.requestId, { schedule: matchedSchedule, attemptId: event.payload.attemptId, ordinal: event.payload.physicalAttemptOrdinal });
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
      if (!attempts.has(attemptId) && (!reserved("attempt", attemptId) || attemptTaskOwners.get(attemptId) !== record.taskId)) {
        fail(event, index, "reducer.task-attempt-ref");
      }
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
    const activeScheduleIds = operation.schedules.flatMap(({ schedule, executionEpoch }) =>
      cancelledEpochs.has(executionEpoch) ? [] : [schedule.scheduleId]);
    const consumed = operation.schedules.flatMap(({ schedule, consumedByAttemptId }) => consumedByAttemptId === null ? [] : [schedule.scheduleId]);
    const startedRetries = operation.schedules.flatMap<ReducedStartedRetryState>(({ schedule, executionEpoch, consumedByAttemptId }) => {
      if (cancelledEpochs.has(executionEpoch) || consumedByAttemptId === null || attempts.has(consumedByAttemptId)) return [];
      return [Object.freeze({
        attemptId: consumedByAttemptId as AttemptId,
        attemptOrdinal: schedule.nextAttemptOrdinal,
        schedule,
      })];
    });
    const frozenAttempts = Object.freeze(attemptOutput);
    const frozenSchedules = Object.freeze(scheduleOutput);
    const frozenActiveScheduleIds = Object.freeze(activeScheduleIds);
    const frozenConsumedScheduleIds = Object.freeze(consumed);
    const frozenStartedRetries = Object.freeze(startedRetries);
    operationOutput[logicalOperationId] = Object.freeze({
      logicalOperationId,
      attempts: frozenAttempts,
      schedules: frozenSchedules,
      activeScheduleIds: frozenActiveScheduleIds,
      consumedScheduleIds: frozenConsumedScheduleIds,
      startedRetries: frozenStartedRetries,
      recoveryDecision: decideRecovery(frozenAttempts, frozenSchedules, frozenActiveScheduleIds,
        frozenConsumedScheduleIds, frozenStartedRetries, cancelledEpochs),
    });
  }
  const requestOutput = Object.create(null) as Record<string, ReducedRequestState>;
  const cacheEligibleRequestIds: string[] = [];
  for (const [requestId, request] of requests) {
    const cancelSeq = cancelledEpochs.get(request.intent.executionEpoch);
    const cancelled = cancelSeq !== undefined && (request.resultSeq === null || request.resultSeq > cancelSeq);
    const cacheEligible = request.result?.status === "success" && !cancelled && !request.quarantined;
    if (cacheEligible) cacheEligibleRequestIds.push(requestId);
    requestOutput[requestId] = Object.freeze({
      requestId,
      attemptId: request.intent.attemptId,
      executionEpoch: request.intent.executionEpoch,
      logicalRequestId: request.intent.logicalRequestId,
      physicalAttemptOrdinal: request.intent.physicalAttemptOrdinal,
      status: request.result?.status ?? "intent",
      cacheEligible,
      quarantined: cancelled || request.quarantined,
    });
  }
  const cancellationOutput = Object.create(null) as Record<string, number>;
  for (const [epoch, seq] of cancelledEpochs) cancellationOutput[String(epoch)] = seq;
  return Object.freeze({
    runState,
    currentEpoch,
    operations: Object.freeze(operationOutput),
    requests: Object.freeze(requestOutput),
    cacheEligibleRequestIds: Object.freeze(cacheEligibleRequestIds.sort()),
    cancelledEpochs: Object.freeze(cancellationOutput),
  });
}

const NOT_FOUND_DECISION: RecoveryDecision = Object.freeze({ kind: "not-found" });

export function recoveryDecisionFor(state: ReducedLedgerState, logicalOperationId: string): RecoveryDecision {
  return state.operations[logicalOperationId]?.recoveryDecision ?? NOT_FOUND_DECISION;
}

function decideRecovery(
  attempts: readonly ReducedAttemptState[],
  schedules: readonly RetrySchedule[],
  activeScheduleIds: readonly string[],
  consumedScheduleIds: readonly string[],
  startedRetries: readonly ReducedStartedRetryState[],
  cancelledEpochs: ReadonlyMap<number, number>,
): RecoveryDecision {
  if (attempts.some((attempt) => attempt.phase === "committed")) return Object.freeze({ kind: "skip-committed" });
  const latest = attempts.at(-1);
  if (!latest) return NOT_FOUND_DECISION;
  const activeSchedules = new Set(activeScheduleIds);
  const startedRetry = startedRetries.at(-1);
  if (startedRetry) {
    return Object.freeze({
      kind: "resume-started-retry",
      attemptId: startedRetry.attemptId,
      attemptOrdinal: startedRetry.attemptOrdinal,
      schedule: startedRetry.schedule,
    });
  }
  const consumed = new Set(consumedScheduleIds);
  const pending = schedules.find((schedule) => activeSchedules.has(schedule.scheduleId)
    && !consumed.has(schedule.scheduleId)
    && schedule.failedAttemptId === latest.attemptId
    && schedule.nextAttemptOrdinal === latest.ordinal + 1);
  if (pending) return Object.freeze({ kind: "retry-safe-read", schedule: pending });
  if (latest.failureState === "terminal-failed" || latest.failureState === "cancelled") {
    return Object.freeze({ kind: "no-action", reason: "terminal" });
  }
  const cancelSeq = cancelledEpochs.get(latest.executionEpoch);
  if ((latest.phase === "result" || latest.phase === "records")
    && latest.transactionId
    && latest.resultSeq !== null
    && (cancelSeq === undefined || latest.resultSeq < cancelSeq)) {
    return Object.freeze({ kind: "finish-transaction", transactionId: latest.transactionId as TransactionId });
  }
  if (cancelSeq !== undefined) return Object.freeze({ kind: "quarantined", reason: "cancelled-epoch" });
  if (latest.phase === "quarantined") {
    return Object.freeze({ kind: "quarantined", reason: latest.quarantineReason ?? "superseded" });
  }
  if (latest.failureState === "superseded") return Object.freeze({ kind: "no-action", reason: "superseded" });
  if (latest.replayPolicy === "never") return Object.freeze({ kind: "block-never", code: "uncertain-nonreplayable" });
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

function sameRequestIdentity(left: RequestIntentRecord, right: RequestIntentRecord): boolean {
  return left.logicalRequestId === right.logicalRequestId
    && left.replayPolicy === right.replayPolicy
    && left.provider === right.provider
    && left.operation === right.operation
    && left.accessPolicySha256 === right.accessPolicySha256
    && canonicalJson(left.normalizedInput) === canonicalJson(right.normalizedInput);
}

function sameRequestIntentResult(intent: RequestIntentRecord, result: RequestRecord): boolean {
  return intent.requestId === result.requestId
    && intent.attemptId === result.attemptId
    && intent.executionEpoch === result.executionEpoch
    && intent.physicalAttemptOrdinal === result.physicalAttemptOrdinal
    && intent.retryOfRequestId === result.retryOfRequestId
    && sameRequestIdentity(intent, result as unknown as RequestIntentRecord);
}

function validRequestOutcome(request: RequestRecord): boolean {
  if (request.status === "success") {
    return request.responseSha256 !== null && request.responseFile !== null
      && request.responseFile.sha256 === request.responseSha256
      && request.responseFile.relativePath === `.state/request-payloads/${request.responseSha256}`
      && request.responseFile.decodedBytes === request.decodedBytes
      && request.errorClass === null;
  }
  if (request.status === "partial") return request.errorClass !== null;
  return request.responseSha256 === null && request.responseFile === null && request.errorClass !== null;
}

function isAllowedTaskTransition(from: TaskRecord["state"], to: TaskRecord["state"]): boolean {
  if (from === to) return true;
  const allowed: Record<TaskRecord["state"], readonly TaskRecord["state"][]> = {
    open: ["ready", "blocked", "cancelled"],
    ready: ["running", "blocked", "cancelled"],
    running: ["ready", "blocked", "resolved", "cancelled"],
    blocked: ["ready", "cancelled"],
    resolved: [],
    cancelled: [],
  };
  return allowed[from].includes(to);
}

function equalField(left: AttemptRecord[keyof AttemptRecord], right: AttemptRecord[keyof AttemptRecord]): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => value === right[index]);
  return left === right;
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled ledger event: ${String(value)}`);
}
