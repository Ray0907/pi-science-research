import { types as utilTypes } from "node:util";

import { canonicalJsonBytes } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import type { FoundationLedgerEvent } from "../domain/events.js";
import {
  ID_PATTERNS,
  createIdGenerator,
  isTimestamp,
  type AttemptId,
  type RunId,
  type Sha256,
  type TaskId,
  type Timestamp,
  type TransactionId,
} from "../domain/ids.js";
import type { AttemptRecord, TaskRecord } from "../domain/records.js";
import { reduceLedgerEvents, type ReducedAttemptState } from "../domain/reducer.js";
import { assertBoundedStructure, StructuralLimitError, type StructuralLimits } from "../storage/bounded-structure.js";
import type { EventLedger } from "../storage/event-ledger.js";
import {
  ResearchPlanningArtifactError,
  writePlanningArtifactInternal,
  type PlanningArtifactRefInternal,
} from "../storage/planning-artifact-internal.js";
import { revalidateOwnedRunRoot, type OwnedRunRoot } from "../storage/run-root.js";
import { commitTransaction, prepareTransaction, TransactionStoreError } from "../storage/transaction-store.js";
import {
  buildPlanningTaskBoardInternal,
  ResearchPlanningBoardError,
  type ValidatedPlanningTaskBoardInternal,
} from "./planning-board-internal.js";
import {
  assertValidatedCoordinatorPlanningResultInternal,
  ResearchPlanningContractError,
  validateCoordinatorPlanningResultInternal,
  type ValidatedCoordinatorPlanningResultInternal,
} from "./planning-contract-internal.js";

export type ResearchPlanningAcceptanceErrorCode =
  | "planning-acceptance.invalid-input"
  | "planning-acceptance.invalid-result"
  | "planning-acceptance.invalid-context"
  | "planning-acceptance.invalid-hooks"
  | "planning-acceptance.precondition-failed"
  | "planning-acceptance.task-id-collision"
  | "planning-acceptance.cancelled"
  | "planning-acceptance.artifact-failed"
  | "planning-acceptance.transaction-failed"
  | "planning-acceptance.ledger-failed"
  | "planning-acceptance.integrity-failed";

const KNOWN_CODES: readonly ResearchPlanningAcceptanceErrorCode[] = [
  "planning-acceptance.invalid-input", "planning-acceptance.invalid-result", "planning-acceptance.invalid-context",
  "planning-acceptance.invalid-hooks", "planning-acceptance.precondition-failed", "planning-acceptance.task-id-collision",
  "planning-acceptance.cancelled", "planning-acceptance.artifact-failed", "planning-acceptance.transaction-failed",
  "planning-acceptance.ledger-failed", "planning-acceptance.integrity-failed",
];

const authenticErrors = new WeakSet<ResearchPlanningAcceptanceError>();

export class ResearchPlanningAcceptanceError extends Error {
  readonly code: ResearchPlanningAcceptanceErrorCode;

  constructor(code: ResearchPlanningAcceptanceErrorCode) {
    const safeCode: ResearchPlanningAcceptanceErrorCode = (KNOWN_CODES as readonly string[]).includes(code)
      ? code
      : "planning-acceptance.ledger-failed";
    super(`Research planning acceptance failed (${safeCode})`);
    this.name = "ResearchPlanningAcceptanceError";
    this.code = safeCode;
    authenticErrors.add(this);
    Object.freeze(this);
  }
}

function fail(code: ResearchPlanningAcceptanceErrorCode): never {
  throw new ResearchPlanningAcceptanceError(code);
}

export interface PlanningAcceptanceScopeInternal {
  readonly root: OwnedRunRoot;
  readonly ledger: EventLedger;
}

export interface PlanningAcceptanceInputInternal {
  readonly attemptId: AttemptId;
  readonly transactionId: TransactionId;
  readonly createdAt: Timestamp;
}

export interface PlanningAcceptanceContextInternal {
  readonly signal: AbortSignal | null;
}

export type PlanningAcceptanceFaultInternal =
  | "before-artifact-write"
  | "before-result-recorded"
  | "after-result-recorded"
  | "after-transaction-commit"
  | "after-records-committed"
  | "after-attempt-committed"
  | "after-control-task-resolved"
  | "after-first-board-task"
  | "before-final-verify";

const FAULTS: ReadonlySet<string> = new Set<PlanningAcceptanceFaultInternal>([
  "before-artifact-write", "before-result-recorded", "after-result-recorded", "after-transaction-commit",
  "after-records-committed", "after-attempt-committed", "after-control-task-resolved", "after-first-board-task",
  "before-final-verify",
]);

export interface PlanningAcceptanceTestHooksDescriptorInternal {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly now: () => Date;
  readonly faultAt: PlanningAcceptanceFaultInternal | null;
}

export interface PlanningAcceptanceTestHooksInternal {
  readonly capabilityKind: "planning-acceptance-test-hooks";
}

interface HookState extends PlanningAcceptanceTestHooksDescriptorInternal {
  consumedFault: boolean;
}

const hookStates = new WeakMap<PlanningAcceptanceTestHooksInternal, HookState>();

export type PlanningAcceptanceStageInternal =
  | "preconditions"
  | "artifact"
  | "result-recorded"
  | "transaction"
  | "records-committed"
  | "attempt-committed"
  | "control-task"
  | "board-tasks"
  | "final-verify";

export interface PlanningAcceptanceFailureInternal {
  readonly lastDurableSeq: number;
  readonly stage: PlanningAcceptanceStageInternal;
}

const failureSidecars = new WeakMap<ResearchPlanningAcceptanceError, PlanningAcceptanceFailureInternal>();

export function getPlanningAcceptanceFailureInternal(error: unknown): PlanningAcceptanceFailureInternal | null {
  if (error === null || typeof error !== "object" || !authenticErrors.has(error as ResearchPlanningAcceptanceError)) return null;
  return failureSidecars.get(error as ResearchPlanningAcceptanceError) ?? null;
}

export interface AcceptedPlanningCheckpointInternal {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly transactionId: TransactionId;
  readonly controlTaskId: TaskId;
  readonly resultSeq: number;
  readonly resultSha256: Sha256;
  readonly artifact: { readonly relativePath: string; readonly sha256: Sha256; readonly decodedBytes: number };
  readonly taskRefs: readonly { readonly taskId: TaskId; readonly revision: 1 }[];
}

const SMALL_STRUCTURAL_LIMITS: StructuralLimits = {
  maxDepth: 3, maxNodes: 16, maxKeys: 16, maxArrayLength: 4, maxStringBytes: 256, maxScalarBytes: 1024,
};

function exactDataValues(value: unknown, fields: readonly string[], code: ResearchPlanningAcceptanceErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail(code);
  const output: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code);
    output[field] = descriptor.value;
  }
  return output;
}

export function createPlanningAcceptanceTestHooksInternal(descriptor: unknown): PlanningAcceptanceTestHooksInternal {
  const values = exactDataValues(descriptor, ["randomBytes", "now", "faultAt"], "planning-acceptance.invalid-hooks");
  if (typeof values.randomBytes !== "function" || typeof values.now !== "function"
    || (values.faultAt !== null && (typeof values.faultAt !== "string" || !FAULTS.has(values.faultAt)))) fail("planning-acceptance.invalid-hooks");
  const capability = Object.freeze({ capabilityKind: "planning-acceptance-test-hooks" as const });
  hookStates.set(capability, {
    randomBytes: values.randomBytes as (size: number) => Uint8Array,
    now: values.now as () => Date,
    faultAt: values.faultAt as PlanningAcceptanceFaultInternal | null,
    consumedFault: false,
  });
  return capability;
}

function authenticateHooks(testHooks: unknown): HookState | null {
  if (testHooks === undefined) return null;
  if (testHooks === null || typeof testHooks !== "object") fail("planning-acceptance.invalid-hooks");
  const state = hookStates.get(testHooks as PlanningAcceptanceTestHooksInternal);
  if (!state) fail("planning-acceptance.invalid-hooks");
  return state;
}

function fault(hooks: HookState | null, phase: PlanningAcceptanceFaultInternal): void {
  if (!hooks || hooks.faultAt !== phase || hooks.consumedFault) return;
  hooks.consumedFault = true;
  fail(phase === "before-artifact-write" ? "planning-acceptance.artifact-failed" : "planning-acceptance.ledger-failed");
}

function validateScope(scope: unknown): PlanningAcceptanceScopeInternal {
  const values = exactDataValues(scope, ["root", "ledger"], "planning-acceptance.invalid-input");
  const root = values.root as OwnedRunRoot | null;
  const ledger = values.ledger as EventLedger | null;
  if (root === null || typeof root !== "object" || typeof root.path !== "string" || typeof root.runId !== "string"
    || !ID_PATTERNS.run.test(root.runId)) fail("planning-acceptance.invalid-input");
  if (ledger === null || typeof ledger !== "object" || typeof ledger.append !== "function"
    || typeof ledger.readAll !== "function" || typeof ledger.verify !== "function") fail("planning-acceptance.invalid-input");
  return { root, ledger };
}

function validateInput(input: unknown): PlanningAcceptanceInputInternal {
  try {
    assertBoundedStructure(input, SMALL_STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) fail("planning-acceptance.invalid-input");
    throw error;
  }
  const values = exactDataValues(input, ["attemptId", "transactionId", "createdAt"], "planning-acceptance.invalid-input");
  const { attemptId, transactionId, createdAt } = values;
  if (typeof attemptId !== "string" || !ID_PATTERNS.attempt.test(attemptId)) fail("planning-acceptance.invalid-input");
  if (typeof transactionId !== "string" || !ID_PATTERNS.transaction.test(transactionId)) fail("planning-acceptance.invalid-input");
  if (!isTimestamp(createdAt)) fail("planning-acceptance.invalid-input");
  return Object.freeze({ attemptId: attemptId as AttemptId, transactionId: transactionId as TransactionId, createdAt });
}

function validateContext(context: unknown): PlanningAcceptanceContextInternal {
  const values = exactDataValues(context, ["signal"], "planning-acceptance.invalid-context");
  const signal = values.signal;
  if (signal !== null && !(signal instanceof AbortSignal)) fail("planning-acceptance.invalid-context");
  return Object.freeze({ signal: signal as AbortSignal | null });
}

interface DerivedBindings {
  readonly runId: RunId;
  readonly maxSources: number;
  readonly attempt: AttemptRecord;
  readonly attemptState: ReducedAttemptState;
  readonly controlTask: TaskRecord;
  readonly existingTaskIds: ReadonlySet<string>;
  readonly lastSeq: number;
}

async function readPreconditions(
  scope: PlanningAcceptanceScopeInternal,
  result: ValidatedCoordinatorPlanningResultInternal,
  input: PlanningAcceptanceInputInternal,
): Promise<DerivedBindings> {
  try {
    await revalidateOwnedRunRoot(scope.root);
  } catch {
    fail("planning-acceptance.precondition-failed");
  }

  let events: FoundationLedgerEvent[];
  try {
    events = await scope.ledger.readAll();
  } catch {
    fail("planning-acceptance.ledger-failed");
  }
  let reduced;
  try {
    reduced = reduceLedgerEvents(events);
  } catch {
    fail("planning-acceptance.ledger-failed");
  }

  if (reduced.runState !== "planning" || reduced.currentEpoch !== 0 || "0" in reduced.cancelledEpochs) {
    fail("planning-acceptance.precondition-failed");
  }

  let runId: RunId | null = null;
  let maxSources: number | null = null;
  let attempt: AttemptRecord | null = null;
  const tasks = new Map<string, TaskRecord>();
  const reservedTransactions = new Set<string>();
  const usedTransactions = new Set<string>();
  let lastSeq = 0;

  for (const event of events) {
    lastSeq = event.seq;
    switch (event.type) {
      case "run_created":
        runId = event.payload.run.runId as RunId;
        maxSources = event.payload.run.budget.maxSources;
        break;
      case "budget_amended":
        maxSources = event.payload.newBudget.maxSources;
        break;
      case "identity_reserved":
        if (event.payload.kind === "transaction") reservedTransactions.add(event.payload.id);
        break;
      case "task_upserted":
        tasks.set(event.payload.task.taskId, event.payload.task);
        break;
      case "dispatch_intent":
        if (event.payload.attempt.attemptId === input.attemptId) attempt = event.payload.attempt;
        break;
      case "result_recorded":
        usedTransactions.add(event.payload.transactionId);
        break;
      default:
        break;
    }
  }

  if (runId === null || maxSources === null || attempt === null) fail("planning-acceptance.precondition-failed");
  if (runId !== scope.root.runId || attempt.runId !== runId) fail("planning-acceptance.precondition-failed");
  if (attempt.attemptKind !== "coordinator-planning" || attempt.executionEpoch !== 0) fail("planning-acceptance.precondition-failed");

  const attemptState = Object.values(reduced.operations).flatMap((operation) => operation.attempts)
    .find((candidate) => candidate.attemptId === input.attemptId);
  if (!attemptState || attemptState.phase !== "started" || attemptState.taskId !== attempt.taskId) {
    fail("planning-acceptance.precondition-failed");
  }

  const controlTask = tasks.get(attempt.taskId);
  if (!controlTask || controlTask.state !== "running" || !controlTask.attemptIds.includes(input.attemptId)) {
    fail("planning-acceptance.precondition-failed");
  }
  if (!reservedTransactions.has(input.transactionId) || usedTransactions.has(input.transactionId)) {
    fail("planning-acceptance.precondition-failed");
  }
  if (result.runId !== runId || result.attemptId !== input.attemptId) fail("planning-acceptance.precondition-failed");
  try {
    validateCoordinatorPlanningResultInternal(result, { runId, attemptId: input.attemptId, maxSources });
  } catch (error) {
    if (error instanceof ResearchPlanningContractError) fail("planning-acceptance.precondition-failed");
    throw error;
  }

  return Object.freeze({
    runId, maxSources, attempt, attemptState, controlTask,
    existingTaskIds: new Set(tasks.keys()), lastSeq,
  });
}

function generateTaskIds(hooks: HookState | null, count: number, existing: ReadonlySet<string>): readonly TaskId[] {
  const generator = createIdGenerator(hooks ? { randomBytes: hooks.randomBytes, now: hooks.now } : {});
  const ids: TaskId[] = [];
  for (let i = 0; i < count; i += 1) {
    let id: string;
    try {
      id = generator.next("task");
    } catch {
      fail("planning-acceptance.task-id-collision");
    }
    if (existing.has(id) || ids.includes(id as TaskId)) fail("planning-acceptance.task-id-collision");
    ids.push(id as TaskId);
  }
  return Object.freeze(ids);
}

interface Progress {
  lastDurableSeq: number;
  stage: PlanningAcceptanceStageInternal;
}

function attachSidecar(error: ResearchPlanningAcceptanceError, progress: Progress): ResearchPlanningAcceptanceError {
  failureSidecars.set(error, Object.freeze({ lastDurableSeq: progress.lastDurableSeq, stage: progress.stage }));
  return error;
}

function normalizeStageFailure(error: unknown, stage: PlanningAcceptanceStageInternal): ResearchPlanningAcceptanceError {
  if (error instanceof ResearchPlanningAcceptanceError) return error;
  if (error instanceof ResearchPlanningArtifactError || error instanceof ResearchPlanningBoardError) {
    return new ResearchPlanningAcceptanceError("planning-acceptance.artifact-failed");
  }
  if (error instanceof TransactionStoreError) return new ResearchPlanningAcceptanceError("planning-acceptance.transaction-failed");
  switch (stage) {
    case "artifact": return new ResearchPlanningAcceptanceError("planning-acceptance.artifact-failed");
    case "transaction": return new ResearchPlanningAcceptanceError("planning-acceptance.transaction-failed");
    case "final-verify": return new ResearchPlanningAcceptanceError("planning-acceptance.integrity-failed");
    default: return new ResearchPlanningAcceptanceError("planning-acceptance.ledger-failed");
  }
}

async function runProtocol(
  scope: PlanningAcceptanceScopeInternal,
  result: ValidatedCoordinatorPlanningResultInternal,
  input: PlanningAcceptanceInputInternal,
  context: PlanningAcceptanceContextInternal,
  hooks: HookState | null,
  bindings: DerivedBindings,
  taskIds: readonly TaskId[],
): Promise<AcceptedPlanningCheckpointInternal> {
  const progress: Progress = { lastDurableSeq: bindings.lastSeq, stage: "artifact" };
  let effectsBegan = false;
  try {
    fault(hooks, "before-artifact-write");
    const board: ValidatedPlanningTaskBoardInternal = buildPlanningTaskBoardInternal(result, {
      controlTaskId: bindings.controlTask.taskId as TaskId,
      taskIds,
    });
    const artifact: PlanningArtifactRefInternal = await writePlanningArtifactInternal(scope.root, result, board, {
      executionEpoch: 0,
      transactionId: input.transactionId,
      createdAt: input.createdAt,
      attemptEnvelopeSha256: bindings.attempt.attemptEnvelopeSha256,
      logicalInputSha256: bindings.attempt.logicalInputSha256,
      maxSources: bindings.maxSources,
    });

    if (context.signal?.aborted) fail("planning-acceptance.cancelled");

    progress.stage = "result-recorded";
    effectsBegan = true;
    fault(hooks, "before-result-recorded");
    const resultSha256 = sha256Hex(canonicalJsonBytes(result)) as Sha256;
    const recorded = await scope.ledger.append("result_recorded", {
      attemptId: input.attemptId,
      resultSha256,
      manifestSha256: artifact.sha256,
      transactionId: input.transactionId,
    });
    progress.lastDurableSeq = recorded.seq;
    const resultSeq = recorded.seq;
    fault(hooks, "after-result-recorded");

    progress.stage = "transaction";
    await prepareTransaction(scope.root.path, {
      schemaVersion: 1,
      transactionId: input.transactionId,
      runId: bindings.runId,
      attemptId: input.attemptId,
      sourceResultSeq: resultSeq,
      createdAt: input.createdAt,
      sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [],
    });
    const manifest = await commitTransaction(scope.root.path, input.transactionId);
    fault(hooks, "after-transaction-commit");

    progress.stage = "records-committed";
    const records = await scope.ledger.append("records_committed", {
      transactionId: input.transactionId,
      sourceResultSeq: resultSeq,
      transactionManifestPath: manifest.relativePath,
      transactionManifestSha256: manifest.sha256,
      sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [],
    });
    progress.lastDurableSeq = records.seq;
    fault(hooks, "after-records-committed");

    progress.stage = "attempt-committed";
    const committed = await scope.ledger.append("attempt_committed", {
      attemptId: input.attemptId,
      transactionId: input.transactionId,
      taskId: bindings.controlTask.taskId,
      sourceResultSeq: resultSeq,
    });
    progress.lastDurableSeq = committed.seq;
    fault(hooks, "after-attempt-committed");

    progress.stage = "control-task";
    const nextControlTask: TaskRecord = {
      ...bindings.controlTask,
      revision: bindings.controlTask.revision + 1,
      state: "resolved",
      resolution: "coordinator-planning-accepted",
    };
    const resolved = await scope.ledger.append("task_upserted", { task: nextControlTask });
    progress.lastDurableSeq = resolved.seq;
    fault(hooks, "after-control-task-resolved");

    progress.stage = "board-tasks";
    const taskRefs: { readonly taskId: TaskId; readonly revision: 1 }[] = [];
    for (const [index, mapping] of board.tasks.entries()) {
      const task = structuredClone(mapping.task) as TaskRecord;
      const upserted = await scope.ledger.append("task_upserted", { task });
      progress.lastDurableSeq = upserted.seq;
      taskRefs.push(Object.freeze({ taskId: mapping.task.taskId as TaskId, revision: 1 as const }));
      if (index === 0) fault(hooks, "after-first-board-task");
    }

    progress.stage = "final-verify";
    fault(hooks, "before-final-verify");
    const events = await scope.ledger.readAll();
    await scope.ledger.verify();
    const reduced = reduceLedgerEvents(events);
    const attemptState = Object.values(reduced.operations).flatMap((operation) => operation.attempts)
      .find((candidate) => candidate.attemptId === input.attemptId);
    if (!attemptState || attemptState.phase !== "committed" || attemptState.transactionId !== input.transactionId
      || attemptState.resultSeq !== resultSeq || reduced.runState !== "planning" || reduced.currentEpoch !== 0) {
      fail("planning-acceptance.integrity-failed");
    }
    const latestTasks = new Map<string, TaskRecord>();
    for (const event of events) if (event.type === "task_upserted") latestTasks.set(event.payload.task.taskId, event.payload.task);
    const control = latestTasks.get(bindings.controlTask.taskId);
    if (!control || control.state !== "resolved") fail("planning-acceptance.integrity-failed");
    for (const ref of taskRefs) {
      const task = latestTasks.get(ref.taskId);
      if (!task || task.revision !== 1 || task.state !== "open") fail("planning-acceptance.integrity-failed");
    }

    return Object.freeze({
      runId: bindings.runId,
      attemptId: input.attemptId,
      transactionId: input.transactionId,
      controlTaskId: bindings.controlTask.taskId as TaskId,
      resultSeq,
      resultSha256,
      artifact: Object.freeze({ relativePath: artifact.relativePath, sha256: artifact.sha256, decodedBytes: artifact.decodedBytes }),
      taskRefs: Object.freeze(taskRefs),
    });
  } catch (error) {
    const normalized = normalizeStageFailure(error, progress.stage);
    // ponytail: no rollback; the documented V1 recovery rules define reconciliation when a later increment implements it.
    throw effectsBegan ? attachSidecar(normalized, progress) : normalized;
  }
}

export async function acceptPlanningResultInternal(
  scope: PlanningAcceptanceScopeInternal,
  authenticResult: ValidatedCoordinatorPlanningResultInternal,
  input: unknown,
  context: unknown,
  testHooks?: unknown,
): Promise<AcceptedPlanningCheckpointInternal> {
  try {
    const hooks = authenticateHooks(testHooks);
    const validScope = validateScope(scope);
    try {
      assertValidatedCoordinatorPlanningResultInternal(authenticResult);
    } catch {
      fail("planning-acceptance.invalid-result");
    }
    const validInput = validateInput(input);
    const validContext = validateContext(context);
    const bindings = await readPreconditions(validScope, authenticResult, validInput);
    const taskIds = generateTaskIds(hooks, authenticResult.tasks.length, bindings.existingTaskIds);
    return runProtocol(validScope, authenticResult, validInput, validContext, hooks, bindings, taskIds);
  } catch (error) {
    if (error instanceof ResearchPlanningAcceptanceError) throw error;
    throw new ResearchPlanningAcceptanceError("planning-acceptance.ledger-failed");
  }
}
