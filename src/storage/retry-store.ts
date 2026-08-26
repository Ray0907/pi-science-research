import { canonicalJson } from "../crypto/canonical-json.js";
import type { FoundationEventOfType, FoundationLedgerEvent } from "../domain/events.js";
import type { AttemptId, RetryScheduleId } from "../domain/ids.js";
import type { AttemptRecord, RetrySchedule, RunSnapshot } from "../domain/records.js";
import { reduceLedgerEvents } from "../domain/reducer.js";
import type { EventLedger } from "./event-ledger.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs: number | null;
  reasonClass: string;
  scheduleId: () => string;
  attemptId: () => string;
}

export type ScheduleRetryResult =
  | Readonly<{ kind: "scheduled"; schedule: RetrySchedule; sourceSeq: number }>
  | Readonly<{ kind: "already-scheduled"; schedule: RetrySchedule; sourceSeq: number }>
  | Readonly<{ kind: "cancelled"; executionEpoch: number }>
  | Readonly<{ kind: "blocked"; code: "retry-attempts-exhausted"; attemptsUsed: number; maxAttempts: number }>
  | Readonly<{ kind: "blocked"; code: "retry-budget-exhausted" | "retry-deadline-exhausted" }>;

export interface FrozenRetryDescriptor {
  readonly scheduleId: RetryScheduleId;
  readonly scheduledFromSeq: number;
  readonly attemptId: AttemptId;
  readonly attemptOrdinal: number;
  readonly retryOfAttemptId: AttemptId;
  readonly executionEpoch: number;
  readonly logicalOperationId: string;
  readonly runId: AttemptRecord["runId"];
  readonly taskId: AttemptRecord["taskId"];
  readonly attemptKind: AttemptRecord["attemptKind"];
  readonly providerModel: string;
  readonly thinkingLevel: AttemptRecord["thinkingLevel"];
  readonly promptTemplateSha256: string;
  readonly logicalInputSha256: string;
  readonly toolAllowlist: readonly string[];
  readonly deadlineAt: string;
  readonly replayPolicy: "safe-read";
}

export type StartRetryResult =
  | Readonly<{ kind: "not-ready"; notBeforeAt: string }>
  | Readonly<{ kind: "cancelled"; executionEpoch: number }>
  | Readonly<{ kind: "blocked"; code: "retry-budget-exhausted" | "retry-deadline-exhausted" }>
  | Readonly<{ kind: "started"; descriptor: FrozenRetryDescriptor }>
  | Readonly<{ kind: "already-started"; descriptor: FrozenRetryDescriptor }>;

export interface RecoveredSchedule {
  readonly scheduleId: RetryScheduleId;
  readonly status: "pending" | "started" | "cancelled";
  readonly sourceSeq: number;
  readonly executionEpoch: number;
  readonly logicalOperationId: string;
  readonly failedAttemptId: AttemptId;
  readonly nextAttemptOrdinal: number;
  readonly notBeforeAt: string;
  readonly delayMs: number;
  readonly startedAttemptId: AttemptId | null;
}

export interface RecoveredRetryState {
  readonly schedules: Readonly<Record<string, RecoveredSchedule>>;
}

export interface RetryRecoveryDiagnostics {
  eventsVisited: number;
  schedulesDerived: number;
}

export type RetryStoreErrorCode =
  | "retry.predecessor"
  | "retry.nonreplayable"
  | "retry.policy"
  | "retry.rng"
  | "retry.identity"
  | "retry.schedule-not-found"
  | "retry.immutable-change"
  | "retry.logical-operation"
  | "retry.cancel-epoch"
  | "retry.corruption";

export class RetryStoreError extends Error {
  readonly code: RetryStoreErrorCode;
  constructor(code: RetryStoreErrorCode) {
    super(`Retry operation failed (${code})`);
    this.name = "RetryStoreError";
    this.code = code;
  }
}

interface RetryBoundary { queue: Promise<void> }
const retryBoundaries = new WeakMap<EventLedger, RetryBoundary>();

export function scheduleRetry(
  ledger: EventLedger,
  failedAttempt: AttemptRecord,
  policy: RetryPolicy,
  now: Date,
  rng: () => number,
): Promise<ScheduleRetryResult> {
  return withRetryBoundary(ledger, () => scheduleRetryUnlocked(ledger, failedAttempt, policy, now, rng));
}

async function scheduleRetryUnlocked(
  ledger: EventLedger,
  failedAttempt: AttemptRecord,
  policy: RetryPolicy,
  now: Date,
  rng: () => number,
): Promise<ScheduleRetryResult> {
  validatePolicy(policy);
  const nowMs = validateDate(now);
  const events = await ledger.readAll();
  reduceLedgerEvents(events);
  const canonical = canonicalAttempt(events, failedAttempt.attemptId);
  if (!canonical) throw new RetryStoreError("retry.predecessor");
  if (canonical.replayPolicy !== "safe-read") throw new RetryStoreError("retry.nonreplayable");
  if (!sameAttemptSnapshot(canonical, failedAttempt) || failedAttempt.state !== "intent-recorded") throw new RetryStoreError("retry.predecessor");
  if (latestFailure(events, canonical.attemptId) !== "retryable-failed") throw new RetryStoreError("retry.predecessor");

  const epochState = canonicalEpochState(events);
  if (!epochState.hasRun) throw new RetryStoreError("retry.corruption");
  if (epochState.cancelledEpochs.has(epochState.currentEpoch)) {
    return Object.freeze({ kind: "cancelled", executionEpoch: epochState.currentEpoch });
  }

  const operationAttempts = events.flatMap((event) => event.type === "dispatch_intent"
    && event.payload.attempt.logicalOperationId === canonical.logicalOperationId ? [event.payload.attempt] : []);
  const attemptsUsed = operationAttempts.length;
  if (attemptsUsed >= policy.maxAttempts) {
    return Object.freeze({ kind: "blocked", code: "retry-attempts-exhausted", attemptsUsed, maxAttempts: policy.maxAttempts });
  }
  const nextAttemptOrdinal = canonical.attemptOrdinal + 1;
  if (nextAttemptOrdinal !== attemptsUsed + 1) throw new RetryStoreError("retry.corruption");

  const budget = canonicalBudget(events);
  const deadlineRemainingMs = new Date(canonical.deadlineAt).getTime() - nowMs;
  if (!(deadlineRemainingMs > 0)) return Object.freeze({ kind: "blocked", code: "retry-deadline-exhausted" });
  const activeBudgetMs = budget.activeTimeLimitMs - budget.activeTimeUsedMs - budget.finalizationReserveMs;
  if (!(activeBudgetMs > 0)) return Object.freeze({ kind: "blocked", code: "retry-budget-exhausted" });
  const availableMs = Math.min(policy.maxDelayMs, activeBudgetMs, deadlineRemainingMs);

  const currentSchedule = Object.values(recoverRetryState(events).schedules).find((schedule) =>
    schedule.executionEpoch === epochState.currentEpoch
    && schedule.logicalOperationId === canonical.logicalOperationId
    && schedule.failedAttemptId === canonical.attemptId
    && schedule.nextAttemptOrdinal === nextAttemptOrdinal);
  if (currentSchedule) {
    const source = events[currentSchedule.sourceSeq - 1];
    if (!source || source.type !== "retry_scheduled") throw new RetryStoreError("retry.corruption");
    return Object.freeze({ kind: "already-scheduled", schedule: scheduleFrom(source), sourceSeq: source.seq });
  }

  const exponent = Math.max(0, nextAttemptOrdinal - 2);
  const jitterBound = boundedExponential(policy.baseDelayMs, exponent, policy.maxDelayMs);
  const jitter = Math.floor(validateRng(rng) * jitterBound);
  const requested = policy.retryAfterMs === null ? jitter : Math.max(jitter, policy.retryAfterMs);
  const delayMs = Math.max(0, Math.floor(Math.min(requested, availableMs)));
  const notBeforeAt = safeTimestamp(nowMs + delayMs);
  const scheduleId = policy.scheduleId();
  if (!/^retry-[a-z0-9]{16,64}$/.test(scheduleId)) throw new RetryStoreError("retry.identity");

  await ledger.reserveIdentity("retry-schedule", scheduleId, "parent-generated");
  const event = await ledger.append("retry_scheduled", {
    scheduleId: scheduleId as RetryScheduleId,
    logicalOperationId: canonical.logicalOperationId,
    failedAttemptId: canonical.attemptId,
    nextAttemptOrdinal,
    notBeforeAt,
    delayMs,
    reasonClass: policy.reasonClass,
  });
  return Object.freeze({ kind: "scheduled", schedule: scheduleFrom(event), sourceSeq: event.seq });
}

export function startScheduledRetry(
  ledger: EventLedger,
  scheduleId: string,
  now: Date,
  policy: Pick<RetryPolicy, "attemptId">,
): Promise<StartRetryResult> {
  return withRetryBoundary(ledger, () => startScheduledRetryUnlocked(ledger, scheduleId, now, policy));
}

async function startScheduledRetryUnlocked(
  ledger: EventLedger,
  scheduleId: string,
  now: Date,
  policy: Pick<RetryPolicy, "attemptId">,
): Promise<StartRetryResult> {
  const nowMs = validateDate(now);
  const events = await ledger.readAll();
  reduceLedgerEvents(events);
  const recovered = recoverRetryState(events).schedules[scheduleId];
  if (!recovered) throw new RetryStoreError("retry.schedule-not-found");
  if (recovered.status === "cancelled") return Object.freeze({ kind: "cancelled", executionEpoch: recovered.executionEpoch });
  const predecessor = canonicalAttempt(events, recovered.failedAttemptId);
  if (!predecessor) throw new RetryStoreError("retry.corruption");
  if (recovered.status === "started") return Object.freeze({ kind: "already-started", descriptor: descriptorFor(recovered, predecessor) });

  const budget = canonicalBudget(events);
  if (!(new Date(predecessor.deadlineAt).getTime() - nowMs > 0)) return Object.freeze({ kind: "blocked", code: "retry-deadline-exhausted" });
  if (!(budget.activeTimeLimitMs - budget.activeTimeUsedMs - budget.finalizationReserveMs > 0)) {
    return Object.freeze({ kind: "blocked", code: "retry-budget-exhausted" });
  }
  if (nowMs < new Date(recovered.notBeforeAt).getTime()) return Object.freeze({ kind: "not-ready", notBeforeAt: recovered.notBeforeAt });

  const attemptId = policy.attemptId();
  if (!/^attempt-[a-z0-9]{16,64}$/.test(attemptId)) throw new RetryStoreError("retry.identity");
  await ledger.reserveIdentity("attempt", attemptId, "parent-generated");
  await ledger.append("retry_started", {
    scheduleId: recovered.scheduleId,
    logicalOperationId: recovered.logicalOperationId,
    attemptId: attemptId as AttemptId,
    attemptOrdinal: recovered.nextAttemptOrdinal,
    scheduledFromSeq: recovered.sourceSeq,
  });
  return Object.freeze({ kind: "started", descriptor: descriptorFor({ ...recovered, status: "started", startedAttemptId: attemptId as AttemptId }, predecessor) });
}

export function recoverRetryState(
  events: readonly FoundationLedgerEvent[],
  diagnostics?: RetryRecoveryDiagnostics,
): RecoveredRetryState {
  reduceLedgerEvents(events);
  const schedules = new Map<string, Omit<RecoveredSchedule, "status">>();
  const cancelledEpochs = new Set<number>();
  let epoch = 0;
  for (const event of events) {
    if (diagnostics) diagnostics.eventsVisited += 1;
    if (event.type === "resume_epoch_started") epoch = event.payload.executionEpoch;
    else if (event.type === "retry_scheduled") {
      schedules.set(event.payload.scheduleId, {
        scheduleId: event.payload.scheduleId as RetryScheduleId,
        sourceSeq: event.seq,
        executionEpoch: epoch,
        logicalOperationId: event.payload.logicalOperationId,
        failedAttemptId: event.payload.failedAttemptId as AttemptId,
        nextAttemptOrdinal: event.payload.nextAttemptOrdinal,
        notBeforeAt: event.payload.notBeforeAt,
        delayMs: event.payload.delayMs,
        startedAttemptId: null,
      });
    } else if (event.type === "retry_started") {
      const schedule = schedules.get(event.payload.scheduleId);
      if (!schedule || schedule.sourceSeq !== event.payload.scheduledFromSeq) throw new RetryStoreError("retry.corruption");
      schedules.set(event.payload.scheduleId, { ...schedule, startedAttemptId: event.payload.attemptId as AttemptId });
    } else if (event.type === "cancel_requested") cancelledEpochs.add(event.payload.executionEpoch);
  }
  const output = Object.create(null) as Record<string, RecoveredSchedule>;
  for (const [id, schedule] of schedules) {
    if (diagnostics) diagnostics.schedulesDerived += 1;
    output[id] = Object.freeze({
      ...schedule,
      status: cancelledEpochs.has(schedule.executionEpoch) ? "cancelled" : schedule.startedAttemptId === null ? "pending" : "started",
    });
  }
  return Object.freeze({ schedules: Object.freeze(output) });
}

export interface RetryController {
  schedule(failedAttempt: AttemptRecord, policy: RetryPolicy, now: Date, rng: () => number): Promise<ScheduleRetryResult>;
  start(scheduleId: string, now: Date, policy: Pick<RetryPolicy, "attemptId">): Promise<StartRetryResult>;
  cancel(executionEpoch: number, reason: FoundationEventOfType<"cancel_requested">["payload"]["reason"]): Promise<FoundationEventOfType<"cancel_requested">>;
}

export function createRetryController(ledger: EventLedger): RetryController {
  const controller: RetryController = {
    schedule: (attempt, policy, now, rng) => scheduleRetry(ledger, attempt, policy, now, rng),
    start: (id, now, policy) => startScheduledRetry(ledger, id, now, policy),
    cancel: (executionEpoch, reason) => cancelRetryEpoch(ledger, executionEpoch, reason),
  };
  return Object.freeze(controller);
}

/**
 * Package orchestration routes cancellation through this helper so it shares
 * the per-ledger retry boundary. Raw EventLedger cancellation appends are not
 * part of that atomic controller contract.
 */
export function cancelRetryEpoch(
  ledger: EventLedger,
  executionEpoch: number,
  reason: FoundationEventOfType<"cancel_requested">["payload"]["reason"],
): Promise<FoundationEventOfType<"cancel_requested">> {
  return withRetryBoundary(ledger, async () => {
    const events = await ledger.readAll();
    reduceLedgerEvents(events);
    const epochState = canonicalEpochState(events);
    if (!Number.isSafeInteger(executionEpoch) || executionEpoch < 0
      || !epochState.hasRun
      || executionEpoch !== epochState.currentEpoch
      || epochState.cancelledEpochs.has(executionEpoch)) {
      throw new RetryStoreError("retry.cancel-epoch");
    }
    return ledger.append("cancel_requested", { executionEpoch, reason });
  });
}

const retryImmutableFields: readonly (keyof AttemptRecord)[] = [
  "runId", "taskId", "attemptKind", "providerModel", "promptTemplateSha256", "logicalInputSha256", "toolAllowlist", "deadlineAt", "replayPolicy",
];

export function assertRetryContinuation(baseline: AttemptRecord, candidate: AttemptRecord): AttemptRecord {
  const linked = candidate.logicalOperationId === baseline.logicalOperationId
    && candidate.attemptOrdinal === baseline.attemptOrdinal + 1
    && candidate.retryOfAttemptId === baseline.attemptId
    && retryImmutableFields.every((field) => equalField(baseline[field], candidate[field]));
  if (!linked) throw new RetryStoreError("retry.immutable-change");
  return candidate;
}

export function startNewLogicalOperation(previous: AttemptRecord, candidate: AttemptRecord): AttemptRecord {
  if (candidate.logicalOperationId === previous.logicalOperationId || candidate.attemptOrdinal !== 1 || candidate.retryOfAttemptId !== null) {
    throw new RetryStoreError("retry.logical-operation");
  }
  return candidate;
}

function withRetryBoundary<T>(ledger: EventLedger, operation: () => Promise<T>): Promise<T> {
  let boundary = retryBoundaries.get(ledger);
  if (!boundary) {
    boundary = { queue: Promise.resolve() };
    retryBoundaries.set(ledger, boundary);
  }
  const result = boundary.queue.then(operation);
  boundary.queue = result.then(() => undefined, () => undefined);
  return result;
}

function canonicalAttempt(events: readonly FoundationLedgerEvent[], attemptId: string): AttemptRecord | undefined {
  for (const event of events) if (event.type === "dispatch_intent" && event.payload.attempt.attemptId === attemptId) return event.payload.attempt;
  return undefined;
}

function latestFailure(events: readonly FoundationLedgerEvent[], attemptId: string): FoundationEventOfType<"attempt_failed">["payload"]["state"] | null {
  let state: FoundationEventOfType<"attempt_failed">["payload"]["state"] | null = null;
  for (const event of events) if (event.type === "attempt_failed" && event.payload.attemptId === attemptId) state = event.payload.state;
  return state;
}

interface CanonicalEpochState {
  readonly hasRun: boolean;
  readonly currentEpoch: number;
  readonly cancelledEpochs: ReadonlySet<number>;
}

function canonicalEpochState(events: readonly FoundationLedgerEvent[]): CanonicalEpochState {
  let hasRun = false;
  let currentEpoch = 0;
  const cancelledEpochs = new Set<number>();
  for (const event of events) {
    if (event.type === "run_created") {
      hasRun = true;
      currentEpoch = event.payload.run.executionEpoch;
    } else if (event.type === "resume_epoch_started") currentEpoch = event.payload.executionEpoch;
    else if (event.type === "cancel_requested") cancelledEpochs.add(event.payload.executionEpoch);
  }
  return { hasRun, currentEpoch, cancelledEpochs };
}

function canonicalBudget(events: readonly FoundationLedgerEvent[]): RunSnapshot["budget"] {
  let budget: RunSnapshot["budget"] | undefined;
  for (const event of events) {
    if (event.type === "run_created") {
      if (budget) throw new RetryStoreError("retry.corruption");
      budget = structuredClone(event.payload.run.budget);
    } else if (event.type === "active_time_checkpoint") {
      if (!budget || event.payload.totalMs < budget.activeTimeUsedMs
        || event.payload.totalMs - budget.activeTimeUsedMs !== event.payload.addedMs) throw new RetryStoreError("retry.corruption");
      budget.activeTimeUsedMs = event.payload.totalMs;
    } else if (event.type === "budget_amended") {
      if (!budget || canonicalJson(event.payload.oldBudget) !== canonicalJson(budget)
        || event.payload.newBudget.activeTimeUsedMs !== budget.activeTimeUsedMs
        || !validBudget(event.payload.newBudget)) throw new RetryStoreError("retry.corruption");
      budget = structuredClone(event.payload.newBudget);
    }
  }
  if (!budget || !validBudget(budget)) throw new RetryStoreError("retry.corruption");
  return budget;
}

function validBudget(budget: RunSnapshot["budget"]): boolean {
  const values = [budget.activeTimeLimitMs, budget.activeTimeUsedMs, budget.finalizationReserveMs];
  const reserve = Math.min(600_000, Math.max(60_000, 0.2 * budget.activeTimeLimitMs), 0.5 * budget.activeTimeLimitMs);
  return values.every((value) => Number.isFinite(value) && value >= 0)
    && budget.finalizationReserveMs === reserve
    && budget.activeTimeUsedMs <= budget.activeTimeLimitMs
    && budget.admittedSources <= budget.maxSources
    && budget.waveOrdinal <= budget.maxWaves;
}

function scheduleFrom(event: FoundationEventOfType<"retry_scheduled">): RetrySchedule {
  return Object.freeze({ schemaVersion: 1, ...event.payload, replayPolicy: "safe-read" });
}

function descriptorFor(schedule: RecoveredSchedule, predecessor: AttemptRecord): FrozenRetryDescriptor {
  if (schedule.startedAttemptId === null) throw new RetryStoreError("retry.corruption");
  return Object.freeze({
    scheduleId: schedule.scheduleId,
    scheduledFromSeq: schedule.sourceSeq,
    attemptId: schedule.startedAttemptId,
    attemptOrdinal: schedule.nextAttemptOrdinal,
    retryOfAttemptId: predecessor.attemptId as AttemptId,
    executionEpoch: schedule.executionEpoch,
    logicalOperationId: predecessor.logicalOperationId,
    runId: predecessor.runId,
    taskId: predecessor.taskId,
    attemptKind: predecessor.attemptKind,
    providerModel: predecessor.providerModel,
    thinkingLevel: predecessor.thinkingLevel,
    promptTemplateSha256: predecessor.promptTemplateSha256,
    logicalInputSha256: predecessor.logicalInputSha256,
    toolAllowlist: Object.freeze([...predecessor.toolAllowlist]),
    deadlineAt: predecessor.deadlineAt,
    replayPolicy: "safe-read",
  });
}

function validatePolicy(policy: RetryPolicy): void {
  const integers = [policy.maxAttempts, policy.baseDelayMs, policy.maxDelayMs];
  const retryAfterValid = policy.retryAfterMs === null || (Number.isFinite(policy.retryAfterMs) && policy.retryAfterMs >= 0);
  if (!integers.every((value) => Number.isSafeInteger(value) && value >= 0)
    || policy.maxAttempts < 1 || policy.baseDelayMs < 1 || policy.maxDelayMs < 1
    || !retryAfterValid || typeof policy.reasonClass !== "string") throw new RetryStoreError("retry.policy");
}

function validateDate(now: Date): number {
  const value = now.getTime();
  if (!Number.isFinite(value)) throw new RetryStoreError("retry.policy");
  return value;
}

function validateRng(rng: () => number): number {
  let value: number;
  try { value = rng(); } catch { throw new RetryStoreError("retry.rng"); }
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RetryStoreError("retry.rng");
  return value;
}

function boundedExponential(base: number, exponent: number, cap: number): number {
  let value = Math.min(base, cap);
  for (let index = 0; index < exponent && value < cap; index += 1) value = value > cap / 2 ? cap : value * 2;
  return value;
}

function safeTimestamp(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < -8.64e15 || milliseconds > 8.64e15) throw new RetryStoreError("retry.policy");
  return new Date(milliseconds).toISOString();
}

function sameAttemptSnapshot(left: AttemptRecord, right: AttemptRecord): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function equalField(left: AttemptRecord[keyof AttemptRecord], right: AttemptRecord[keyof AttemptRecord]): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => value === right[index]);
  return left === right;
}
