import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalJson, canonicalJsonBytes } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import type { FoundationLedgerEvent } from "../domain/events.js";
import { isSha256, type AttemptId, type RunId, type Sha256, type TaskId, type TransactionId } from "../domain/ids.js";
import type { AttemptRecord, TaskRecord } from "../domain/records.js";
import { reduceLedgerEvents, type ReducedAttemptState } from "../domain/reducer.js";
import { readPlanningArtifactInternal, ResearchPlanningArtifactError } from "../storage/planning-artifact-internal.js";
import { revalidateOwnedRunRoot, type OwnedRunRoot } from "../storage/run-root.js";
import type { ValidatedPlanningTaskBoardInternal } from "./planning-board-internal.js";
import type { ValidatedCoordinatorPlanningResultInternal } from "./planning-contract-internal.js";

export type ResearchAcceptedPlanErrorCode =
  | "accepted-plan.invalid-root"
  | "accepted-plan.invalid-events"
  | "accepted-plan.invalid-hooks"
  | "accepted-plan.ambiguous"
  | "accepted-plan.missing-artifact-ref"
  | "accepted-plan.corrupt"
  | "accepted-plan.io-failed";

const KNOWN_CODES: readonly ResearchAcceptedPlanErrorCode[] = [
  "accepted-plan.invalid-root", "accepted-plan.invalid-events", "accepted-plan.invalid-hooks",
  "accepted-plan.ambiguous", "accepted-plan.missing-artifact-ref", "accepted-plan.corrupt", "accepted-plan.io-failed",
];

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const authenticErrors = new WeakSet<ResearchAcceptedPlanError>();

export class ResearchAcceptedPlanError extends Error {
  readonly code: ResearchAcceptedPlanErrorCode;

  constructor(code: ResearchAcceptedPlanErrorCode) {
    const safeCode: ResearchAcceptedPlanErrorCode = (KNOWN_CODES as readonly string[]).includes(code)
      ? code
      : "accepted-plan.io-failed";
    super(`Research accepted plan failed (${safeCode})`);
    this.name = "ResearchAcceptedPlanError";
    this.code = safeCode;
    authenticErrors.add(this);
    Object.freeze(this);
  }
}

function fail(code: ResearchAcceptedPlanErrorCode): never {
  throw new ResearchAcceptedPlanError(code);
}

export type AcceptedPlanFaultInternal = "before-artifact-read" | "after-artifact-read";

const FAULTS: ReadonlySet<string> = new Set<AcceptedPlanFaultInternal>(["before-artifact-read", "after-artifact-read"]);

export interface AcceptedPlanTestHooksInternal {
  readonly capabilityKind: "accepted-plan-test-hooks";
}

interface HookState {
  readonly faultAt: AcceptedPlanFaultInternal | null;
  consumedFault: boolean;
}

const hookStates = new WeakMap<AcceptedPlanTestHooksInternal, HookState>();

function exactDataValues(value: unknown, fields: readonly string[], code: ResearchAcceptedPlanErrorCode): Record<string, unknown> {
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

export function createAcceptedPlanTestHooksInternal(descriptor: unknown): AcceptedPlanTestHooksInternal {
  const values = exactDataValues(descriptor, ["faultAt"], "accepted-plan.invalid-hooks");
  if (values.faultAt !== null && (typeof values.faultAt !== "string" || !FAULTS.has(values.faultAt))) {
    fail("accepted-plan.invalid-hooks");
  }
  const capability = Object.freeze({ capabilityKind: "accepted-plan-test-hooks" as const });
  hookStates.set(capability, { faultAt: values.faultAt as AcceptedPlanFaultInternal | null, consumedFault: false });
  return capability;
}

function authenticateHooks(testHooks: unknown): HookState | null {
  if (testHooks === undefined) return null;
  if (testHooks === null || typeof testHooks !== "object") fail("accepted-plan.invalid-hooks");
  const state = hookStates.get(testHooks as AcceptedPlanTestHooksInternal);
  if (!state) fail("accepted-plan.invalid-hooks");
  return state;
}

function fault(hooks: HookState | null, phase: AcceptedPlanFaultInternal): void {
  if (!hooks || hooks.faultAt !== phase || hooks.consumedFault) return;
  hooks.consumedFault = true;
  fail("accepted-plan.io-failed");
}

export interface AcceptedPlanInternal {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly transactionId: TransactionId;
  readonly controlTaskId: TaskId;
  readonly resultSeq: number;
  readonly resultSha256: Sha256;
  readonly maxSources: number;
  readonly artifact: { readonly relativePath: string; readonly sha256: Sha256; readonly decodedBytes: number };
  readonly result: ValidatedCoordinatorPlanningResultInternal;
  readonly board: ValidatedPlanningTaskBoardInternal;
  readonly taskRefs: readonly { readonly taskId: TaskId; readonly revision: number }[];
}

interface DerivedAcceptedAttempt {
  readonly runId: RunId;
  readonly attempt: AttemptRecord;
  readonly state: ReducedAttemptState;
  readonly resultSeq: number;
  readonly transactionId: TransactionId;
  readonly resultSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly maxSources: number;
  readonly controlTaskId: TaskId;
}

function validateEvents(events: unknown): readonly FoundationLedgerEvent[] {
  if (!Array.isArray(events) || utilTypes.isProxy(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    fail("accepted-plan.invalid-events");
  }
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event) || utilTypes.isProxy(event)) {
      fail("accepted-plan.invalid-events");
    }
    const proto = Object.getPrototypeOf(event);
    if (proto !== Object.prototype && proto !== null) fail("accepted-plan.invalid-events");
    const { seq, type, payload } = event as { seq?: unknown; type?: unknown; payload?: unknown };
    if (!Number.isSafeInteger(seq) || typeof type !== "string" || payload === null || typeof payload !== "object") {
      fail("accepted-plan.invalid-events");
    }
  }
  return events as readonly FoundationLedgerEvent[];
}

function deriveAcceptedAttempt(
  events: readonly FoundationLedgerEvent[],
  reduced: ReturnType<typeof reduceLedgerEvents>,
  rootRunId: RunId,
): DerivedAcceptedAttempt | null {
  const planningIntents = new Map<string, AttemptRecord>();
  let runId: RunId | null = null;
  for (const event of events) {
    if (event.type === "run_created") runId = event.payload.run.runId as RunId;
    if (event.type === "dispatch_intent" && event.payload.attempt.attemptKind === "coordinator-planning") {
      planningIntents.set(event.payload.attempt.attemptId, event.payload.attempt);
    }
  }
  const committed = Object.values(reduced.operations).flatMap((operation) => operation.attempts)
    .filter((attempt) => attempt.phase === "committed" && planningIntents.has(attempt.attemptId));
  if (committed.length === 0) return null;
  if (committed.length > 1) fail("accepted-plan.ambiguous");
  const state = committed[0]!;
  const attempt = planningIntents.get(state.attemptId)!;
  if (runId === null || runId !== rootRunId || attempt.runId !== runId || attempt.executionEpoch !== 0) fail("accepted-plan.corrupt");
  if (state.resultSeq === null || state.transactionId === null) fail("accepted-plan.corrupt");

  const recorded = events.find((event) => event.seq === state.resultSeq);
  if (!recorded || recorded.type !== "result_recorded" || recorded.payload.attemptId !== attempt.attemptId
    || recorded.payload.transactionId !== state.transactionId) fail("accepted-plan.corrupt");
  if (recorded.payload.manifestSha256 === null) fail("accepted-plan.missing-artifact-ref");
  if (!isSha256(recorded.payload.manifestSha256) || !isSha256(recorded.payload.resultSha256)) fail("accepted-plan.corrupt");

  let maxSources: number | null = null;
  for (const event of events) {
    if (event.seq >= state.resultSeq) break;
    if (event.type === "run_created") maxSources = event.payload.run.budget.maxSources;
    if (event.type === "budget_amended") maxSources = event.payload.newBudget.maxSources;
  }
  if (maxSources === null) fail("accepted-plan.corrupt");

  return Object.freeze({
    runId,
    attempt,
    state,
    resultSeq: state.resultSeq,
    transactionId: state.transactionId as TransactionId,
    resultSha256: recorded.payload.resultSha256,
    manifestSha256: recorded.payload.manifestSha256,
    maxSources,
    controlTaskId: attempt.taskId as TaskId,
  });
}

async function readAndCrossCheck(
  root: OwnedRunRoot,
  events: readonly FoundationLedgerEvent[],
  derived: DerivedAcceptedAttempt,
  hooks: HookState | null,
): Promise<AcceptedPlanInternal> {
  const relativePath = `.state/planning/results/${derived.manifestSha256}.json`;
  let decodedBytes: number;
  try {
    const stat = await lstat(join(root.path, relativePath), { bigint: true });
    if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_ARTIFACT_BYTES)) fail("accepted-plan.corrupt");
    decodedBytes = Number(stat.size);
  } catch (error) {
    if (error instanceof ResearchAcceptedPlanError) throw error;
    fail("accepted-plan.corrupt");
  }
  // ponytail: lstat only supplies the closed ref size; the artifact reader re-checks size, hash, and identity.

  fault(hooks, "before-artifact-read");
  let rehydrated;
  try {
    rehydrated = await readPlanningArtifactInternal(root, {
      relativePath,
      sha256: derived.manifestSha256,
      decodedBytes,
    }, {
      runId: derived.runId,
      attemptId: derived.attempt.attemptId,
      executionEpoch: 0,
      transactionId: derived.transactionId,
      maxSources: derived.maxSources,
      attemptEnvelopeSha256: derived.attempt.attemptEnvelopeSha256,
      logicalInputSha256: derived.attempt.logicalInputSha256,
      controlTaskId: derived.controlTaskId,
    });
  } catch (error) {
    if (error instanceof ResearchPlanningArtifactError) fail("accepted-plan.corrupt");
    throw error;
  }
  fault(hooks, "after-artifact-read");

  if (sha256Hex(canonicalJsonBytes(rehydrated.result)) !== derived.resultSha256) fail("accepted-plan.corrupt");

  const firstRevision = new Map<string, TaskRecord>();
  const latest = new Map<string, TaskRecord>();
  let attemptCommittedOk = false;
  for (const event of events) {
    if (event.type === "task_upserted") {
      if (!firstRevision.has(event.payload.task.taskId)) firstRevision.set(event.payload.task.taskId, event.payload.task);
      latest.set(event.payload.task.taskId, event.payload.task);
    }
    if (event.type === "attempt_committed" && event.payload.attemptId === derived.attempt.attemptId
      && event.payload.taskId === derived.controlTaskId && event.payload.sourceResultSeq === derived.resultSeq
      && event.payload.transactionId === derived.transactionId) attemptCommittedOk = true;
  }
  if (!attemptCommittedOk) fail("accepted-plan.corrupt");
  const control = latest.get(derived.controlTaskId);
  if (!control || control.state !== "resolved") fail("accepted-plan.corrupt");
  const taskRefs: { readonly taskId: TaskId; readonly revision: number }[] = [];
  for (const mapping of rehydrated.board.tasks) {
    const first = firstRevision.get(mapping.task.taskId);
    const current = latest.get(mapping.task.taskId);
    if (!first || !current || canonicalJson(first) !== canonicalJson(mapping.task)) fail("accepted-plan.corrupt");
    taskRefs.push(Object.freeze({ taskId: mapping.task.taskId as TaskId, revision: current.revision }));
  }

  return Object.freeze({
    runId: derived.runId,
    attemptId: derived.attempt.attemptId as AttemptId,
    transactionId: derived.transactionId,
    controlTaskId: derived.controlTaskId,
    resultSeq: derived.resultSeq,
    resultSha256: derived.resultSha256,
    maxSources: derived.maxSources,
    artifact: Object.freeze({ relativePath, sha256: derived.manifestSha256, decodedBytes }),
    result: rehydrated.result,
    board: rehydrated.board,
    taskRefs: Object.freeze(taskRefs),
  });
}

export async function readAcceptedPlanInternal(
  authenticRoot: OwnedRunRoot,
  events: unknown,
  testHooks?: unknown,
): Promise<AcceptedPlanInternal | null> {
  try {
    const hooks = authenticateHooks(testHooks);
    const validEvents = validateEvents(events);
    try {
      await revalidateOwnedRunRoot(authenticRoot);
    } catch {
      fail("accepted-plan.invalid-root");
    }
    let reduced;
    try {
      reduced = reduceLedgerEvents(validEvents);
    } catch {
      fail("accepted-plan.invalid-events");
    }
    const derived = deriveAcceptedAttempt(validEvents, reduced, authenticRoot.runId);
    if (derived === null) return null;
    return await readAndCrossCheck(authenticRoot, validEvents, derived, hooks);
  } catch (error) {
    if (error instanceof ResearchAcceptedPlanError) throw error;
    throw new ResearchAcceptedPlanError("accepted-plan.io-failed");
  }
}
