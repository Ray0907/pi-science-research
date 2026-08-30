import { randomBytes as nodeRandomBytes } from "node:crypto";
import { join } from "node:path";
import { types as utilTypes } from "node:util";

import { isTimestamp, type RunId } from "../domain/ids.js";
import { RunSnapshotSchema, type RunSnapshot } from "../domain/records.js";
import { reduceLedgerEvents } from "../domain/reducer.js";
import { parse } from "../domain/schema.js";
import { appendFully, defaultDurability } from "../storage/atomic.js";
import { EventLedgerError, openEventLedger, type EventLedger } from "../storage/event-ledger.js";
import {
  acquireResearchRunLockInternal,
  isResearchRunLockAcquisitionCleanupUncertainInternal,
  isResearchRunLockTestHooksInternal,
  ResearchRunLockError,
  type ResearchRunLockInternal,
  type ResearchRunLockTestHooksInternal,
} from "../storage/run-lock-internal.js";
import {
  createOwnedRunRoot,
  revalidateOwnedRunRoot,
  RunRootError,
  type OwnedRunRoot,
} from "../storage/run-root.js";
import { isResearchInvocationInternal, type NormalizedResearchInvocationInternal } from "./research-options.js";

export type ResearchBootstrapErrorCode =
  | "bootstrap.invalid-input"
  | "bootstrap.calculation-runtime-unavailable"
  | "bootstrap.cancelled"
  | "bootstrap.clock-invalid"
  | "bootstrap.snapshot-invalid"
  | "bootstrap.location-denied"
  | "bootstrap.persistence-failed"
  | "bootstrap.integrity-failed"
  | "bootstrap.cleanup-uncertain";

const BOOTSTRAP_ERROR_CODES: readonly ResearchBootstrapErrorCode[] = Object.freeze([
  "bootstrap.invalid-input",
  "bootstrap.calculation-runtime-unavailable",
  "bootstrap.cancelled",
  "bootstrap.clock-invalid",
  "bootstrap.snapshot-invalid",
  "bootstrap.location-denied",
  "bootstrap.persistence-failed",
  "bootstrap.integrity-failed",
  "bootstrap.cleanup-uncertain",
]);
const ROLE_KEYS = ["coordinator", "researcher", "verifier"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MAX_MODEL_BYTES = 512;
const MAX_PATH_BYTES = 4_096;
const MAX_TOPIC_BYTES = 1_024;
const NATIVE_IS_PROMISE = utilTypes.isPromise;
const NATIVE_IS_PROXY = utilTypes.isProxy;
const NATIVE_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const NATIVE_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const NATIVE_REFLECT_APPLY = Reflect.apply;
const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const NATIVE_PROMISE_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  NATIVE_PROMISE_PROTOTYPE,
  "constructor",
)!;
const NATIVE_PROMISE_SPECIES_DESCRIPTOR = Object.getOwnPropertyDescriptor(NATIVE_PROMISE, Symbol.species)!;
const NATIVE_PROMISE_SPECIES_GETTER = NATIVE_PROMISE_SPECIES_DESCRIPTOR.get;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;
const NATIVE_ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const NATIVE_ABORTED_GETTER = Object.getOwnPropertyDescriptor(NATIVE_ABORT_SIGNAL_PROTOTYPE, "aborted")?.get;
const NATIVE_THROW_IF_ABORTED = Object.getOwnPropertyDescriptor(NATIVE_ABORT_SIGNAL_PROTOTYPE, "throwIfAborted")?.value;
const authenticErrors = new WeakSet<object>();
const failureSidecars = new WeakMap<object, ResearchBootstrapFailureInternal>();
const roleSnapshots = new WeakMap<object, { readonly invocation: NormalizedResearchInvocationInternal }>();
const contexts = new WeakSet<object>();
const hookStates = new WeakMap<object, MutableTestHookState>();

type ResearchRole = typeof ROLE_KEYS[number];
type ThinkingLevel = RunSnapshot["roleThinking"]["coordinator"];

export class ResearchBootstrapError extends Error {
  readonly code: ResearchBootstrapErrorCode;

  constructor(code: ResearchBootstrapErrorCode) {
    const safeCode = isBootstrapErrorCode(code) ? code : "bootstrap.persistence-failed";
    super(`Research bootstrap failed (${safeCode})`);
    this.name = "ResearchBootstrapError";
    this.code = safeCode;
  }
}

export interface ResolvedResearchRoleSnapshotInternal {
  readonly roleModels: Readonly<Record<ResearchRole, string>>;
  readonly roleThinking: Readonly<Record<ResearchRole, ThinkingLevel>>;
}

export interface ResolvedResearchRoleDescriptorInternal {
  readonly activeModel: string;
  readonly activeThinking: ThinkingLevel;
  readonly resolvedModels: Readonly<Record<ResearchRole, string>>;
}

export interface ResearchBootstrapContextDescriptorInternal {
  readonly trustedProject: string;
  readonly repositoryRoot: string;
  readonly roles: ResolvedResearchRoleSnapshotInternal;
  readonly signal: AbortSignal | undefined;
  readonly allowAbsoluteRequestedPath: boolean;
  readonly approveOutside: ((canonicalPath: string) => boolean | Promise<boolean>) | null;
  readonly approvedOutsideRoots: readonly string[];
  readonly forbiddenRoots: readonly string[];
}

export interface ResearchBootstrapContextInternal extends ResearchBootstrapContextDescriptorInternal {}

export type ResearchBootstrapPhaseInternal =
  | "before-root-create"
  | "after-root-create"
  | "after-lock-acquire"
  | "after-ledger-open"
  | "after-ledger-directory-sync"
  | "after-run-created"
  | "after-planning-transition"
  | "after-active-checkpoint"
  | "before-final-verify"
  | "after-ledger-close"
  | "after-lock-release"
  | "before-root-close";

export type ResearchBootstrapOperationFaultInternal =
  | "root-create-before"
  | "ledger-open-before"
  | "ledger-directory-sync-before"
  | "run-created-write-partial"
  | "run-created-durability"
  | "planning-transition-write-partial"
  | "planning-transition-durability"
  | "normal-active-checkpoint-write-partial"
  | "normal-active-checkpoint-durability"
  | "cancellation-active-checkpoint-write-partial"
  | "cancellation-active-checkpoint-durability"
  | "cancel-requested-write-partial"
  | "cancel-requested-durability"
  | "cancelled-transition-write-partial"
  | "cancelled-transition-durability"
  | "ledger-read-before"
  | "ledger-verify-before"
  | "ledger-close-after"
  | "root-revalidate-before"
  | "root-close-after";

export interface ResearchBootstrapTestHooksDescriptorInternal {
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly onCheck: ((phase: ResearchBootstrapPhaseInternal) => void | Promise<void>) | null;
  readonly faultAt: ResearchBootstrapOperationFaultInternal | null;
  readonly lockHooks: ResearchRunLockTestHooksInternal | null;
}

export interface ResearchBootstrapTestHooksInternal {
  readonly capabilityKind: "research-bootstrap-test-hooks";
}

interface MutableTestHookState extends ResearchBootstrapTestHooksDescriptorInternal {
  faultAt: ResearchBootstrapOperationFaultInternal | null;
}

export interface ResearchBootstrapResultInternal {
  readonly runId: RunId;
  readonly rootPath: string;
  readonly state: "planning";
  readonly budget: RunSnapshot["budget"];
}

export interface ResearchBootstrapFailureInternal {
  readonly runId: RunId;
  readonly rootPath: string;
  readonly lastDurableSeq: number;
  readonly state: "orphan" | "created" | "planning" | "cancelled" | "unknown";
}

/** Returns durable recovery metadata only for errors created by this module instance. */
export function getResearchBootstrapFailureInternal(error: unknown): ResearchBootstrapFailureInternal | null {
  if (error === null || typeof error !== "object" || !authenticErrors.has(error)) return null;
  return failureSidecars.get(error) ?? null;
}

/** Resolves the invocation's explicit role models without changing unspecified active-session roles. */
export function createResolvedResearchRoleSnapshotInternal(
  invocation: NormalizedResearchInvocationInternal,
  descriptor: ResolvedResearchRoleDescriptorInternal,
): ResolvedResearchRoleSnapshotInternal {
  if (!isResearchInvocationInternal(invocation)) fail("bootstrap.invalid-input");
  const values = exactDataValues(descriptor, ["activeModel", "activeThinking", "resolvedModels"]);
  const activeModel = checkedModel(values.activeModel);
  const activeThinking = values.activeThinking;
  if (!isThinkingLevel(activeThinking)) fail("bootstrap.invalid-input");
  const resolved = exactDataValues(values.resolvedModels, ROLE_KEYS);
  const checkedResolved = Object.fromEntries(ROLE_KEYS.map((role) => [role, checkedModel(resolved[role])])) as Record<ResearchRole, string>;
  const roleModels = Object.freeze(Object.fromEntries(ROLE_KEYS.map((role) => [
    role,
    invocation.modelOverrides[role] === null ? activeModel : checkedResolved[role],
  ])) as Record<ResearchRole, string>);
  const roleThinking = Object.freeze(Object.fromEntries(ROLE_KEYS.map((role) => [role, activeThinking])) as Record<ResearchRole, ThinkingLevel>);
  const snapshot = Object.freeze({ roleModels, roleThinking });
  roleSnapshots.set(snapshot, { invocation });
  return snapshot;
}

/** Creates a closed nominal bootstrap context; it is valid only in this module instance. */
export function createResearchBootstrapContextInternal(
  descriptor: ResearchBootstrapContextDescriptorInternal,
): ResearchBootstrapContextInternal {
  const values = exactDataValues(descriptor, [
    "trustedProject", "repositoryRoot", "roles", "signal", "allowAbsoluteRequestedPath",
    "approveOutside", "approvedOutsideRoots", "forbiddenRoots",
  ]);
  const trustedProject = checkedPath(values.trustedProject);
  const repositoryRoot = checkedPath(values.repositoryRoot);
  const roles = authenticateRoles(values.roles);
  const signal = checkedSignal(values.signal);
  if (typeof values.allowAbsoluteRequestedPath !== "boolean") fail("bootstrap.invalid-input");
  if (values.approveOutside !== null && typeof values.approveOutside !== "function") fail("bootstrap.invalid-input");
  const approvedOutsideRoots = checkedPathArray(values.approvedOutsideRoots);
  const forbiddenRoots = checkedPathArray(values.forbiddenRoots);
  const context = Object.freeze({
    trustedProject,
    repositoryRoot,
    roles,
    signal,
    allowAbsoluteRequestedPath: values.allowAbsoluteRequestedPath,
    approveOutside: values.approveOutside as ResearchBootstrapContextInternal["approveOutside"],
    approvedOutsideRoots,
    forbiddenRoots,
  });
  contexts.add(context);
  return context;
}

/** Creates nominal hooks so production callers cannot accidentally inject bootstrap internals. */
export function createResearchBootstrapTestHooksInternal(
  descriptor: ResearchBootstrapTestHooksDescriptorInternal,
): ResearchBootstrapTestHooksInternal {
  const values = exactDataValues(descriptor, ["now", "monotonicNow", "randomBytes", "onCheck", "faultAt", "lockHooks"]);
  if (typeof values.now !== "function" || typeof values.monotonicNow !== "function" || typeof values.randomBytes !== "function"
    || (values.onCheck !== null && typeof values.onCheck !== "function")
    || (values.faultAt !== null && !isOperationFault(values.faultAt))
    || (values.lockHooks !== null && !isResearchRunLockTestHooksInternal(values.lockHooks))) fail("bootstrap.invalid-input");
  const capability = Object.freeze({ capabilityKind: "research-bootstrap-test-hooks" as const });
  hookStates.set(capability, {
    now: values.now as () => Date,
    monotonicNow: values.monotonicNow as () => number,
    randomBytes: values.randomBytes as (size: number) => Uint8Array,
    onCheck: values.onCheck as MutableTestHookState["onCheck"],
    faultAt: values.faultAt as ResearchBootstrapOperationFaultInternal | null,
    lockHooks: values.lockHooks as ResearchRunLockTestHooksInternal | null,
  });
  return capability;
}

/** Returns the longest code-point prefix whose UTF-8 representation fits the run-root topic bound. */
export function projectResearchTopicInternal(question: string): string {
  if (typeof question !== "string" || hasUnpairedSurrogate(question)) fail("bootstrap.invalid-input");
  let bytes = 0;
  let topic = "";
  for (const codePoint of question) {
    const width = Buffer.byteLength(codePoint, "utf8");
    if (bytes + width > MAX_TOPIC_BYTES) break;
    bytes += width;
    topic += codePoint;
  }
  return topic.length === 0 ? "research" : topic;
}

/** Creates and verifies the initial durable three-event research ledger. */
export async function bootstrapResearchRunInternal(
  invocation: NormalizedResearchInvocationInternal,
  context: ResearchBootstrapContextInternal,
  testHooks?: ResearchBootstrapTestHooksInternal,
): Promise<ResearchBootstrapResultInternal> {
  let root: OwnedRunRoot | undefined;
  let lock: ResearchRunLockInternal | undefined;
  let ledger: EventLedger | undefined;
  let primary: ResearchBootstrapError | undefined;
  let cleanupUncertain = false;
  let approvalInvalid = false;
  let approvalFailed = false;
  let integrityStage = false;
  let stateClassificationUnknown = false;
  const durable: DurableBootstrapState = { lastSeq: 0, state: "orphan", activeCheckpoint: false };
  const hooks = authenticateHooks(testHooks);

  try {
    authenticateInvocationContext(invocation, context);
    if (invocation.allowCalculations) fail("bootstrap.calculation-runtime-unavailable");
    throwIfCancelled(context.signal);

    const runId = createRunId(hooks);
    const startedAt = wallClock(hooks);
    const monotonicStarted = monotonicClock(hooks);
    const budget = initialBudget(invocation);
    const topic = projectResearchTopicInternal(invocation.question);

    await phase(hooks, "before-root-create");
    throwIfCancelled(context.signal);
    operationFault(hooks, "root-create-before");
    // The root and lock primitives provide the POSIX foundation used here.
    // Their Darwin pathname fallbacks retain the documented same-user race limitation.
    root = await createOwnedRunRoot({
      trustedProject: context.trustedProject,
      repositoryRoot: context.repositoryRoot,
      topic,
      runId,
      requestedPath: invocation.requestedOutput ?? undefined,
      allowAbsoluteRequestedPath: context.allowAbsoluteRequestedPath,
      approveOutside: context.approveOutside === null ? undefined : async (canonicalPath) => {
        let returned: unknown;
        try { returned = context.approveOutside!(canonicalPath); }
        catch { approvalFailed = true; return false; }
        if (typeof returned === "boolean") return returned;
        if (!isAuthenticBasePromise(returned)) { approvalInvalid = true; return false; }
        let settled: unknown;
        try { settled = await settleAuthenticBasePromise(returned); }
        catch { approvalFailed = true; return false; }
        if (typeof settled !== "boolean") { approvalInvalid = true; return false; }
        return settled;
      },
      approvedOutsideRoots: context.approvedOutsideRoots,
      forbiddenRoots: context.forbiddenRoots,
      now: () => new Date(startedAt.time),
      randomBytes: (size) => randomBytes(hooks, size),
    });
    const snapshot = createInitialSnapshot(invocation, context.roles, root.path, runId, startedAt.timestamp, budget);
    await phase(hooks, "after-root-create");
    throwIfCancelled(context.signal);

    lock = await acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks?.lockHooks ?? undefined);
    await phase(hooks, "after-lock-acquire");
    throwIfCancelled(context.signal);

    operationFault(hooks, "ledger-open-before");
    const ledgerFaults = ledgerFaultOptions(hooks, startedAt.time);
    ledger = await openEventLedger(join(lock.statePath, "events.jsonl"), {
      now: () => new Date(ledgerFaults.timestamp),
      eventId: () => `event-${Buffer.from(randomBytes(hooks, 16)).toString("hex")}`,
      io: ledgerFaults.io,
      durability: ledgerFaults.durability,
    });
    await phase(hooks, "after-ledger-open");
    throwIfCancelled(context.signal);

    operationFault(hooks, "ledger-directory-sync-before");
    await lock.syncStateDirectory();
    await phase(hooks, "after-ledger-directory-sync");
    throwIfCancelled(context.signal);

    ledgerFaults.nextAppend = "run-created";
    const created = await ledger.append("run_created", { run: snapshot });
    durable.lastSeq = created.seq;
    durable.state = "created";
    await phase(hooks, "after-run-created");
    await cancelAtBoundary(context.signal, ledger, lock, hooks, ledgerFaults, durable, startedAt, monotonicStarted);

    ledgerFaults.nextAppend = "planning-transition";
    const planning = await ledger.append("state_changed", { from: "created", to: "planning", blocker: null });
    durable.lastSeq = planning.seq;
    durable.state = "planning";
    await phase(hooks, "after-planning-transition");
    await cancelAtBoundary(context.signal, ledger, lock, hooks, ledgerFaults, durable, startedAt, monotonicStarted);

    await appendActiveCheckpoint(ledger, lock, hooks, ledgerFaults, durable, startedAt, monotonicStarted, "normal-active-checkpoint");
    await phase(hooks, "after-active-checkpoint");
    await cancelAtBoundary(context.signal, ledger, lock, hooks, ledgerFaults, durable, startedAt, monotonicStarted);

    integrityStage = true;
    await phase(hooks, "before-final-verify");
    operationFault(hooks, "ledger-read-before");
    const events = await ledger.readAll();
    operationFault(hooks, "ledger-verify-before");
    await ledger.verify();
    const reduced = reduceLedgerEvents(events);
    if (events.length !== 3 || events[0]?.type !== "run_created" || events[1]?.type !== "state_changed"
      || events[2]?.type !== "active_time_checkpoint" || events[0].payload.run.runId !== runId
      || reduced.runState !== "planning" || reduced.currentEpoch !== 0) fail("bootstrap.integrity-failed");
  } catch (error) {
    primary = classifyFailure(error, approvalInvalid, approvalFailed, integrityStage);
    if (integrityStage && primary.code === "bootstrap.integrity-failed") stateClassificationUnknown = true;
  }

  if (ledger) {
    try {
      await ledger.close();
      operationFault(hooks, "ledger-close-after");
    } catch { cleanupUncertain = true; }
    try { await phase(hooks, "after-ledger-close"); }
    catch (error) { primary ??= classifyFailure(error, false, false, false); }
  }
  if (lock) {
    let released = false;
    try {
      await lock.release();
      released = true;
    } catch {
      cleanupUncertain = true;
      try { await lock.closePreservingLock(); } catch { cleanupUncertain = true; }
    }
    if (released) {
      try { await phase(hooks, "after-lock-release"); }
      catch (error) { primary ??= classifyFailure(error, false, false, false); }
    }
  }
  if (root) {
    try {
      operationFault(hooks, "root-revalidate-before");
      await revalidateOwnedRunRoot(root);
    } catch (error) {
      if (!primary || primary.code === "bootstrap.cancelled") primary = classifyIntegrityFailure(error);
      stateClassificationUnknown = true;
    }
    try { await phase(hooks, "before-root-close"); }
    catch (error) { primary ??= classifyFailure(error, false, false, false); }
    try {
      await root.close();
      operationFault(hooks, "root-close-after");
    } catch { cleanupUncertain = true; }
  }

  const finalError = cleanupUncertain ? createError("bootstrap.cleanup-uncertain") : primary;
  if (finalError) {
    if (root) attachFailureSidecar(finalError, root, durable, stateClassificationUnknown);
    throw finalError;
  }
  const resultBudget = initialBudget(invocation);
  return Object.freeze({ runId: root!.runId, rootPath: root!.path, state: "planning" as const, budget: resultBudget });
}

interface DurableBootstrapState {
  lastSeq: number;
  state: "orphan" | "created" | "planning" | "cancelled";
  activeCheckpoint: boolean;
}

type BootstrapAppendPurpose =
  | "run-created"
  | "planning-transition"
  | "normal-active-checkpoint"
  | "cancellation-active-checkpoint"
  | "cancel-requested"
  | "cancelled-transition";

interface BootstrapLedgerFaultOptions {
  timestamp: number;
  io: { append: typeof appendFully } | undefined;
  durability: typeof defaultDurability | undefined;
  nextAppend: BootstrapAppendPurpose | null;
}

async function cancelAtBoundary(
  signal: AbortSignal | undefined,
  ledger: EventLedger,
  lock: ResearchRunLockInternal,
  hooks: MutableTestHookState | null,
  ledgerFaults: BootstrapLedgerFaultOptions,
  durable: DurableBootstrapState,
  startedAt: { readonly time: number; readonly timestamp: string },
  monotonicStarted: number,
): Promise<void> {
  if (!isCancellationRequested(signal)) return;
  if (!durable.activeCheckpoint) {
    await appendActiveCheckpoint(
      ledger, lock, hooks, ledgerFaults, durable, startedAt, monotonicStarted, "cancellation-active-checkpoint",
    );
  }
  ledgerFaults.nextAppend = "cancel-requested";
  const requested = await ledger.append("cancel_requested", { executionEpoch: 0, reason: "abort-signal" });
  durable.lastSeq = requested.seq;
  const from = durable.state;
  if (from !== "created" && from !== "planning") fail("bootstrap.integrity-failed");
  ledgerFaults.nextAppend = "cancelled-transition";
  const cancelled = await ledger.append("state_changed", { from, to: "cancelled", blocker: null });
  durable.lastSeq = cancelled.seq;
  durable.state = "cancelled";
  fail("bootstrap.cancelled");
}

async function appendActiveCheckpoint(
  ledger: EventLedger,
  lock: ResearchRunLockInternal,
  hooks: MutableTestHookState | null,
  ledgerFaults: BootstrapLedgerFaultOptions,
  durable: DurableBootstrapState,
  startedAt: { readonly time: number; readonly timestamp: string },
  monotonicStarted: number,
  purpose: "normal-active-checkpoint" | "cancellation-active-checkpoint",
): Promise<void> {
  const endedAt = wallClock(hooks);
  const monotonicEnded = monotonicClock(hooks);
  const addedMs = elapsedMilliseconds(startedAt.time, endedAt.time, monotonicStarted, monotonicEnded);
  ledgerFaults.timestamp = endedAt.time;
  ledgerFaults.nextAppend = purpose;
  const checkpoint = await ledger.append("active_time_checkpoint", {
    ownerTokenSha256: lock.ownerTokenSha256,
    intervalStartedAt: startedAt.timestamp,
    intervalEndedAt: endedAt.timestamp,
    addedMs,
    totalMs: addedMs,
  });
  durable.lastSeq = checkpoint.seq;
  durable.activeCheckpoint = true;
}

function attachFailureSidecar(
  error: ResearchBootstrapError,
  root: OwnedRunRoot,
  durable: DurableBootstrapState,
  unknown: boolean,
): void {
  const sidecar = Object.freeze({
    runId: root.runId,
    rootPath: root.path,
    lastDurableSeq: Number.isSafeInteger(durable.lastSeq) && durable.lastSeq >= 0 ? durable.lastSeq : 0,
    state: unknown ? "unknown" as const : durable.state,
  });
  failureSidecars.set(error, sidecar);
}

function createInitialSnapshot(
  invocation: NormalizedResearchInvocationInternal,
  roles: ResolvedResearchRoleSnapshotInternal,
  outputRoot: string,
  runId: RunId,
  timestamp: string,
  budget: RunSnapshot["budget"],
): RunSnapshot {
  const candidate = {
    schemaVersion: 1 as const,
    runId,
    revision: 1,
    question: invocation.question,
    language: invocation.language,
    depth: invocation.depth,
    reproducible: invocation.reproducible,
    allowCalculations: false,
    calculationPolicySha256: null,
    state: "created" as const,
    checkpointStage: null,
    executionEpoch: 0,
    outputRoot,
    roleModels: roles.roleModels,
    roleThinking: roles.roleThinking,
    budget,
    taskRefs: [],
    attemptRefs: [],
    acceptedVerificationRef: null,
    currentRevisionId: null,
    blocker: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
  const parsed = parse(RunSnapshotSchema, candidate);
  if (!parsed.success) fail("bootstrap.snapshot-invalid");
  return parsed.value;
}

function initialBudget(invocation: NormalizedResearchInvocationInternal): RunSnapshot["budget"] {
  return Object.freeze({
    activeTimeLimitMs: invocation.activeTimeLimitMs,
    activeTimeUsedMs: 0,
    finalizationReserveMs: invocation.finalizationReserveMs,
    maxSources: invocation.maxSources,
    admittedSources: 0,
    maxWaves: invocation.maxWaves,
    waveOrdinal: 0,
  });
}

function ledgerFaultOptions(hooks: MutableTestHookState | null, initialTimestamp: number): BootstrapLedgerFaultOptions {
  const output: BootstrapLedgerFaultOptions = {
    timestamp: initialTimestamp,
    io: undefined,
    durability: undefined,
    nextAppend: null,
  };
  if (!hooks) return output;
  output.io = {
    async append(handle, bytes) {
      const appendFault = output.nextAppend === null ? null : `${output.nextAppend}-write-partial`;
      if (appendFault !== null && hooks.faultAt === appendFault) {
        hooks.faultAt = null;
        output.nextAppend = null;
        const partial = Math.max(1, Math.floor(bytes.byteLength / 2));
        await handle.write(bytes, 0, partial, null);
        throw new Error("injected bootstrap append fault");
      }
      await appendFully(handle, bytes);
    },
  };
  output.durability = async (handle, reason) => {
    const appendFault = output.nextAppend === null ? null : `${output.nextAppend}-durability`;
    if (reason === "append" && appendFault !== null && hooks.faultAt === appendFault) {
      hooks.faultAt = null;
      output.nextAppend = null;
      throw new Error("injected bootstrap durability fault");
    }
    await defaultDurability(handle, reason);
    if (reason === "append") output.nextAppend = null;
  };
  return output;
}

function authenticateInvocationContext(
  invocation: NormalizedResearchInvocationInternal,
  context: ResearchBootstrapContextInternal,
): void {
  if (!isResearchInvocationInternal(invocation) || context === null || typeof context !== "object"
    || utilTypes.isProxy(context) || !Object.isFrozen(context) || !contexts.has(context)) fail("bootstrap.invalid-input");
  const roleState = roleSnapshots.get(context.roles);
  if (!roleState || roleState.invocation !== invocation) fail("bootstrap.invalid-input");
}

function authenticateRoles(value: unknown): ResolvedResearchRoleSnapshotInternal {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Object.isFrozen(value)
    || !roleSnapshots.has(value)) fail("bootstrap.invalid-input");
  return value as ResolvedResearchRoleSnapshotInternal;
}

function authenticateHooks(value: ResearchBootstrapTestHooksInternal | undefined): MutableTestHookState | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Object.isFrozen(value)) fail("bootstrap.invalid-input");
  const state = hookStates.get(value);
  if (!state) fail("bootstrap.invalid-input");
  return state;
}

function checkedSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || NATIVE_IS_PROXY(value)
    || NATIVE_GET_PROTOTYPE_OF(value) !== NATIVE_ABORT_SIGNAL_PROTOTYPE
    || typeof NATIVE_ABORTED_GETTER !== "function" || typeof NATIVE_THROW_IF_ABORTED !== "function") fail("bootstrap.invalid-input");
  try {
    if (NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value, "aborted") !== undefined
      || NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value, "throwIfAborted") !== undefined) fail("bootstrap.invalid-input");
    const aborted = NATIVE_REFLECT_APPLY(NATIVE_ABORTED_GETTER, value, []);
    if (typeof aborted !== "boolean") fail("bootstrap.invalid-input");
  } catch (error) {
    if (isAuthenticError(error)) throw error;
    fail("bootstrap.invalid-input");
  }
  return value as AbortSignal;
}

function isCancellationRequested(signal: AbortSignal | undefined): boolean {
  if (!signal) return false;
  let aborted: unknown;
  try { aborted = NATIVE_REFLECT_APPLY(NATIVE_ABORTED_GETTER!, signal, []); }
  catch { fail("bootstrap.invalid-input"); }
  if (typeof aborted !== "boolean") fail("bootstrap.invalid-input");
  if (!aborted) return false;
  try { NATIVE_REFLECT_APPLY(NATIVE_THROW_IF_ABORTED, signal, []); }
  catch { return true; }
  return true;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (isCancellationRequested(signal)) fail("bootstrap.cancelled");
}

function wallClock(hooks: MutableTestHookState | null): { readonly time: number; readonly timestamp: string } {
  let value: unknown;
  try { value = (hooks?.now ?? (() => new Date()))(); }
  catch { fail("bootstrap.clock-invalid"); }
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Date.prototype) {
    fail("bootstrap.clock-invalid");
  }
  let time: number;
  let timestamp: string;
  try {
    time = Reflect.apply(DATE_GET_TIME, value, []);
    timestamp = Reflect.apply(DATE_TO_ISO_STRING, value, []);
  } catch { fail("bootstrap.clock-invalid"); }
  if (!Number.isFinite(time) || !Number.isSafeInteger(time) || !isTimestamp(timestamp)) fail("bootstrap.clock-invalid");
  return Object.freeze({ time, timestamp });
}

function monotonicClock(hooks: MutableTestHookState | null): number {
  let value: unknown;
  try { value = (hooks?.monotonicNow ?? (() => performance.now()))(); }
  catch { fail("bootstrap.clock-invalid"); }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    fail("bootstrap.clock-invalid");
  }
  return value;
}

function elapsedMilliseconds(wallStart: number, wallEnd: number, monotonicStart: number, monotonicEnd: number): number {
  const elapsed = monotonicEnd - monotonicStart;
  if (wallEnd < wallStart || monotonicEnd < monotonicStart || !Number.isFinite(elapsed) || elapsed < 0) fail("bootstrap.clock-invalid");
  return elapsed;
}

function createRunId(hooks: MutableTestHookState | null): RunId {
  return `run-${Buffer.from(randomBytes(hooks, 16)).toString("hex")}`;
}

function randomBytes(hooks: MutableTestHookState | null, size: number): Uint8Array {
  let value: unknown;
  try { value = (hooks?.randomBytes ?? nodeRandomBytes)(size); }
  catch { fail("bootstrap.invalid-input"); }
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)
    || !(value instanceof Uint8Array) || value.byteLength !== size) fail("bootstrap.invalid-input");
  return value;
}

async function phase(hooks: MutableTestHookState | null, value: ResearchBootstrapPhaseInternal): Promise<void> {
  if (!hooks?.onCheck) return;
  try { await hooks.onCheck(value); }
  catch { fail("bootstrap.persistence-failed"); }
}

function operationFault(hooks: MutableTestHookState | null, value: ResearchBootstrapOperationFaultInternal): void {
  if (hooks?.faultAt !== value) return;
  hooks.faultAt = null;
  throw new Error("injected bootstrap operation fault");
}

function exactDataValues(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) fail("bootstrap.invalid-input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("bootstrap.invalid-input");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail("bootstrap.invalid-input");
  const output: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("bootstrap.invalid-input");
    output[field] = descriptor.value;
  }
  return output;
}

function checkedModel(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_MODEL_BYTES) fail("bootstrap.invalid-input");
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1 || hasUnpairedSurrogate(value)) {
    fail("bootstrap.invalid-input");
  }
  return value;
}

function checkedPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || hasUnpairedSurrogate(value)) {
    fail("bootstrap.invalid-input");
  }
  return value;
}

function checkedPathArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 100) {
    fail("bootstrap.invalid-input");
  }
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("bootstrap.invalid-input");
    output.push(checkedPath(descriptor.value));
  }
  return Object.freeze(output);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isAuthenticBasePromise(value: unknown): value is Promise<unknown> {
  if (value === null || typeof value !== "object" || NATIVE_IS_PROXY(value) || !NATIVE_IS_PROMISE(value)) return false;
  try {
    if (NATIVE_GET_PROTOTYPE_OF(value) !== NATIVE_PROMISE_PROTOTYPE
      || NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(value, "constructor") !== undefined) return false;
    const constructorDescriptor = NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(NATIVE_PROMISE_PROTOTYPE, "constructor");
    const speciesDescriptor = NATIVE_GET_OWN_PROPERTY_DESCRIPTOR(NATIVE_PROMISE, Symbol.species);
    if (!constructorDescriptor || !("value" in constructorDescriptor)
      || constructorDescriptor.value !== NATIVE_PROMISE
      || constructorDescriptor.writable !== NATIVE_PROMISE_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR.writable
      || constructorDescriptor.enumerable !== NATIVE_PROMISE_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR.enumerable
      || constructorDescriptor.configurable !== NATIVE_PROMISE_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR.configurable) return false;
    if (!speciesDescriptor || !("get" in speciesDescriptor)
      || speciesDescriptor.get !== NATIVE_PROMISE_SPECIES_GETTER
      || speciesDescriptor.set !== NATIVE_PROMISE_SPECIES_DESCRIPTOR.set
      || speciesDescriptor.enumerable !== NATIVE_PROMISE_SPECIES_DESCRIPTOR.enumerable
      || speciesDescriptor.configurable !== NATIVE_PROMISE_SPECIES_DESCRIPTOR.configurable) return false;
    return true;
  } catch { return false; }
}

function settleAuthenticBasePromise(value: Promise<unknown>): Promise<unknown> {
  return NATIVE_REFLECT_APPLY(NATIVE_PROMISE_THEN, value, [(settled: unknown) => settled]);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}

function classifyFailure(
  error: unknown,
  approvalInvalid: boolean,
  approvalFailed: boolean,
  integrityStage: boolean,
): ResearchBootstrapError {
  if (approvalInvalid) return createError("bootstrap.invalid-input");
  if (approvalFailed) return createError("bootstrap.location-denied");
  if (isAuthenticError(error)) return error;
  if (isResearchRunLockAcquisitionCleanupUncertainInternal(error)) return createError("bootstrap.cleanup-uncertain");
  if (integrityStage) return createError("bootstrap.integrity-failed");
  if (error instanceof RunRootError) {
    if (error.code === "run-root.outside-denied" || error.code === "run-root.unsafe-root") return createError("bootstrap.location-denied");
    if (error.code === "run-root.invalid-options" || error.code === "run-root.invalid-path" || error.code === "run-root.path-too-long") {
      return createError("bootstrap.invalid-input");
    }
    return createError("bootstrap.persistence-failed");
  }
  if (error instanceof EventLedgerError || error instanceof ResearchRunLockError) return createError("bootstrap.persistence-failed");
  return createError("bootstrap.persistence-failed");
}

function classifyIntegrityFailure(error: unknown): ResearchBootstrapError {
  if (isAuthenticError(error)) return error;
  return createError("bootstrap.integrity-failed");
}

function isBootstrapErrorCode(value: unknown): value is ResearchBootstrapErrorCode {
  return typeof value === "string" && (BOOTSTRAP_ERROR_CODES as readonly string[]).includes(value);
}

function isAuthenticError(value: unknown): value is ResearchBootstrapError {
  return value instanceof ResearchBootstrapError && authenticErrors.has(value) && Object.isFrozen(value)
    && isBootstrapErrorCode(value.code) && value.name === "ResearchBootstrapError"
    && value.message === `Research bootstrap failed (${value.code})`;
}

function createError(code: ResearchBootstrapErrorCode): ResearchBootstrapError {
  const error = new ResearchBootstrapError(code);
  Object.freeze(error);
  authenticErrors.add(error);
  return error;
}

function fail(code: ResearchBootstrapErrorCode): never {
  throw createError(code);
}

function isOperationFault(value: unknown): value is ResearchBootstrapOperationFaultInternal {
  return typeof value === "string" && [
    "root-create-before", "ledger-open-before", "ledger-directory-sync-before",
    "run-created-write-partial", "run-created-durability", "planning-transition-write-partial",
    "planning-transition-durability", "normal-active-checkpoint-write-partial",
    "normal-active-checkpoint-durability", "cancellation-active-checkpoint-write-partial",
    "cancellation-active-checkpoint-durability", "cancel-requested-write-partial",
    "cancel-requested-durability", "cancelled-transition-write-partial",
    "cancelled-transition-durability", "ledger-read-before", "ledger-verify-before",
    "ledger-close-after", "root-revalidate-before", "root-close-after",
  ].includes(value);
}
