import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson, canonicalJsonBytes } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import {
  ID_PATTERNS,
  isSha256,
  isTimestamp,
  type AttemptId,
  type RunId,
  type Sha256,
  type TaskId,
  type Timestamp,
  type TransactionId,
} from "../domain/ids.js";
import {
  assertValidatedCoordinatorPlanningResultInternal,
  ResearchPlanningContractError,
  validateCoordinatorPlanningResultInternal,
  type ValidatedCoordinatorPlanningResultInternal,
} from "../workflow/planning-contract-internal.js";
import {
  assertValidatedPlanningTaskBoardInternal,
  buildPlanningTaskBoardInternal,
  ResearchPlanningBoardError,
  type ValidatedPlanningTaskBoardInternal,
} from "../workflow/planning-board-internal.js";
import { assertBoundedStructure, StructuralLimitError, type StructuralLimits } from "./bounded-structure.js";
import { revalidateOwnedRunRoot, RunRootError, type OwnedRunRoot } from "./run-root.js";

const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES_CEILING = 500;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const ARTIFACT_KEYS = [
  "schemaVersion", "kind", "executionEpoch", "transactionId", "createdAt",
  "attemptEnvelopeSha256", "logicalInputSha256", "maxSources", "result", "board",
] as const;

const SMALL_STRUCTURAL_LIMITS: StructuralLimits = {
  maxDepth: 4, maxNodes: 64, maxKeys: 64, maxArrayLength: 8, maxStringBytes: 256, maxScalarBytes: 4096,
};
const ARTIFACT_STRUCTURAL_LIMITS: StructuralLimits = {
  maxDepth: 16, maxNodes: 40_000, maxKeys: 40_000, maxArrayLength: 64, maxStringBytes: 16_384, maxScalarBytes: MAX_ARTIFACT_BYTES * 2,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ResearchPlanningArtifactErrorCode =
  | "planning-artifact.invalid-result"
  | "planning-artifact.invalid-board"
  | "planning-artifact.invalid-metadata"
  | "planning-artifact.invalid-ref"
  | "planning-artifact.invalid-binding"
  | "planning-artifact.invalid-hooks"
  | "planning-artifact.mismatch"
  | "planning-artifact.not-found"
  | "planning-artifact.corrupt"
  | "planning-artifact.unsafe-file"
  | "planning-artifact.io-failed"
  | "planning-artifact.cleanup-uncertain";

const KNOWN_CODES: readonly ResearchPlanningArtifactErrorCode[] = [
  "planning-artifact.invalid-result", "planning-artifact.invalid-board", "planning-artifact.invalid-metadata",
  "planning-artifact.invalid-ref", "planning-artifact.invalid-binding", "planning-artifact.invalid-hooks",
  "planning-artifact.mismatch", "planning-artifact.not-found", "planning-artifact.corrupt",
  "planning-artifact.unsafe-file", "planning-artifact.io-failed", "planning-artifact.cleanup-uncertain",
];

export class ResearchPlanningArtifactError extends Error {
  readonly code: ResearchPlanningArtifactErrorCode;

  constructor(code: ResearchPlanningArtifactErrorCode) {
    const safeCode: ResearchPlanningArtifactErrorCode = (KNOWN_CODES as readonly string[]).includes(code)
      ? code
      : "planning-artifact.io-failed";
    super(`Research planning artifact failed (${safeCode})`);
    this.name = "ResearchPlanningArtifactError";
    this.code = safeCode;
    Object.freeze(this);
  }
}

function fail(code: ResearchPlanningArtifactErrorCode): never {
  throw new ResearchPlanningArtifactError(code);
}

/** Boundary normalization: every failure that leaves this module is one of our own closed,
 * redacted codes — never a raw Node error (which can carry a filesystem path in `.message`)
 * and never an error from a dependency's own class re-thrown verbatim. Applied at every point
 * a caught `unknown` is about to be re-thrown as this function's outcome. */
function normalizeFailure(error: unknown): ResearchPlanningArtifactError {
  return error instanceof ResearchPlanningArtifactError ? error : new ResearchPlanningArtifactError("planning-artifact.io-failed");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isOrdinaryRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return keys.every((key) => expectedSet.has(key));
}

function expectedRelativePathFor(sha256: string): string {
  return `.state/planning/results/${sha256}.json`;
}

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

export interface ResearchPlanningArtifactMetadataInternal {
  readonly executionEpoch: 0;
  readonly transactionId: TransactionId;
  readonly createdAt: Timestamp;
  readonly attemptEnvelopeSha256: Sha256;
  readonly logicalInputSha256: Sha256;
  readonly maxSources: number;
}

export interface PlanningArtifactRefInternal {
  readonly relativePath: string;
  readonly sha256: Sha256;
  readonly decodedBytes: number;
}

export interface PlanningArtifactExpectedBindingInternal {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly executionEpoch: 0;
  readonly transactionId: TransactionId;
  readonly maxSources: number;
  readonly attemptEnvelopeSha256: Sha256;
  readonly logicalInputSha256: Sha256;
  readonly controlTaskId: TaskId;
}

export interface ReadPlanningArtifactResultInternal extends ResearchPlanningArtifactMetadataInternal {
  readonly result: ValidatedCoordinatorPlanningResultInternal;
  readonly board: ValidatedPlanningTaskBoardInternal;
}

function validateMetadataInternal(input: unknown): ResearchPlanningArtifactMetadataInternal {
  try {
    assertBoundedStructure(input, SMALL_STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) fail("planning-artifact.invalid-metadata");
    throw error;
  }
  if (!isOrdinaryRecord(input)) fail("planning-artifact.invalid-metadata");
  if (!exactKeys(input, ["executionEpoch", "transactionId", "createdAt", "attemptEnvelopeSha256", "logicalInputSha256", "maxSources"])) {
    fail("planning-artifact.invalid-metadata");
  }
  const { executionEpoch, transactionId, createdAt, attemptEnvelopeSha256, logicalInputSha256, maxSources } = input;
  if (executionEpoch !== 0) fail("planning-artifact.invalid-metadata");
  if (typeof transactionId !== "string" || !ID_PATTERNS.transaction.test(transactionId)) fail("planning-artifact.invalid-metadata");
  if (typeof createdAt !== "string" || !isTimestamp(createdAt)) fail("planning-artifact.invalid-metadata");
  if (typeof attemptEnvelopeSha256 !== "string" || !isSha256(attemptEnvelopeSha256)) fail("planning-artifact.invalid-metadata");
  if (typeof logicalInputSha256 !== "string" || !isSha256(logicalInputSha256)) fail("planning-artifact.invalid-metadata");
  if (typeof maxSources !== "number" || !Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > MAX_SOURCES_CEILING) {
    fail("planning-artifact.invalid-metadata");
  }
  return Object.freeze({
    executionEpoch: 0 as const,
    transactionId: transactionId as TransactionId,
    createdAt: createdAt as Timestamp,
    attemptEnvelopeSha256: attemptEnvelopeSha256 as Sha256,
    logicalInputSha256: logicalInputSha256 as Sha256,
    maxSources,
  });
}

function validateRefInternal(input: unknown): PlanningArtifactRefInternal {
  try {
    assertBoundedStructure(input, SMALL_STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) fail("planning-artifact.invalid-ref");
    throw error;
  }
  if (!isOrdinaryRecord(input)) fail("planning-artifact.invalid-ref");
  if (!exactKeys(input, ["relativePath", "sha256", "decodedBytes"])) fail("planning-artifact.invalid-ref");
  const { relativePath, sha256, decodedBytes } = input;
  if (typeof sha256 !== "string" || !isSha256(sha256)) fail("planning-artifact.invalid-ref");
  if (typeof relativePath !== "string" || relativePath !== expectedRelativePathFor(sha256)) fail("planning-artifact.invalid-ref");
  if (typeof decodedBytes !== "number" || !Number.isSafeInteger(decodedBytes) || decodedBytes < 1 || decodedBytes > MAX_ARTIFACT_BYTES) {
    fail("planning-artifact.invalid-ref");
  }
  return Object.freeze({ relativePath, sha256, decodedBytes });
}

function validateExpectedBindingInternal(input: unknown): PlanningArtifactExpectedBindingInternal {
  try {
    assertBoundedStructure(input, SMALL_STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) fail("planning-artifact.invalid-binding");
    throw error;
  }
  if (!isOrdinaryRecord(input)) fail("planning-artifact.invalid-binding");
  if (!exactKeys(input, ["runId", "attemptId", "executionEpoch", "transactionId", "maxSources", "attemptEnvelopeSha256", "logicalInputSha256", "controlTaskId"])) {
    fail("planning-artifact.invalid-binding");
  }
  const { runId, attemptId, executionEpoch, transactionId, maxSources, attemptEnvelopeSha256, logicalInputSha256, controlTaskId } = input;
  if (typeof runId !== "string" || !ID_PATTERNS.run.test(runId)) fail("planning-artifact.invalid-binding");
  if (typeof attemptId !== "string" || !ID_PATTERNS.attempt.test(attemptId)) fail("planning-artifact.invalid-binding");
  if (executionEpoch !== 0) fail("planning-artifact.invalid-binding");
  if (typeof transactionId !== "string" || !ID_PATTERNS.transaction.test(transactionId)) fail("planning-artifact.invalid-binding");
  if (typeof maxSources !== "number" || !Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > MAX_SOURCES_CEILING) {
    fail("planning-artifact.invalid-binding");
  }
  if (typeof attemptEnvelopeSha256 !== "string" || !isSha256(attemptEnvelopeSha256)) fail("planning-artifact.invalid-binding");
  if (typeof logicalInputSha256 !== "string" || !isSha256(logicalInputSha256)) fail("planning-artifact.invalid-binding");
  if (typeof controlTaskId !== "string" || !ID_PATTERNS.task.test(controlTaskId)) fail("planning-artifact.invalid-binding");
  return Object.freeze({
    runId: runId as RunId, attemptId: attemptId as AttemptId, executionEpoch: 0 as const, transactionId: transactionId as TransactionId,
    maxSources, attemptEnvelopeSha256: attemptEnvelopeSha256 as Sha256, logicalInputSha256: logicalInputSha256 as Sha256,
    controlTaskId: controlTaskId as TaskId,
  });
}

/** Reconstructs {controlTaskId, taskIds} bindings from a board-shaped value's own
 * proposalId -> task.taskId mapping, rebuilds the board via the real builder, and
 * requires the rebuild to be canonically byte-identical to the given board-shaped
 * value. Used identically by the write-side cross-check and the read-side rehydration
 * integrity check — one implementation, not two that could silently diverge. */
function rebuildAndCompareBoardInternal(
  result: ValidatedCoordinatorPlanningResultInternal,
  boardLike: unknown,
): ValidatedPlanningTaskBoardInternal {
  if (!isOrdinaryRecord(boardLike)) fail("planning-artifact.mismatch");
  const { controlTaskId, tasks } = boardLike;
  if (typeof controlTaskId !== "string" || !Array.isArray(tasks)) fail("planning-artifact.mismatch");
  const taskIdByProposalId = new Map<string, string>();
  for (const mapping of tasks) {
    if (!isOrdinaryRecord(mapping)) fail("planning-artifact.mismatch");
    const proposalId = mapping.proposalId;
    const task = mapping.task;
    if (typeof proposalId !== "string" || !isOrdinaryRecord(task) || typeof task.taskId !== "string") fail("planning-artifact.mismatch");
    taskIdByProposalId.set(proposalId, task.taskId);
  }
  const taskIds = result.tasks.map((proposal) => {
    const id = taskIdByProposalId.get(proposal.proposalId);
    if (id === undefined) fail("planning-artifact.mismatch");
    return id;
  });
  let rebuilt: ValidatedPlanningTaskBoardInternal;
  try {
    rebuilt = buildPlanningTaskBoardInternal(result, { controlTaskId, taskIds } as never);
  } catch {
    fail("planning-artifact.mismatch");
  }
  let rebuiltCanonical: string;
  let givenCanonical: string;
  try {
    rebuiltCanonical = canonicalJson(rebuilt);
    givenCanonical = canonicalJson(boardLike);
  } catch {
    fail("planning-artifact.mismatch");
  }
  if (rebuiltCanonical !== givenCanonical) fail("planning-artifact.mismatch");
  return rebuilt;
}

function buildArtifactPlainObject(
  metadata: ResearchPlanningArtifactMetadataInternal,
  result: ValidatedCoordinatorPlanningResultInternal,
  board: ValidatedPlanningTaskBoardInternal,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "coordinator-planning-artifact",
    executionEpoch: 0,
    transactionId: metadata.transactionId,
    createdAt: metadata.createdAt,
    attemptEnvelopeSha256: metadata.attemptEnvelopeSha256,
    logicalInputSha256: metadata.logicalInputSha256,
    maxSources: metadata.maxSources,
    result,
    board,
  };
}

// ---------------------------------------------------------------------------
// Test control capability (item 3): a small, frozen, WeakMap-authenticated
// opaque token — never a caller-suppliable callback, never a native handle.
// Only this module's own internal fsync/close/read/write calls ever execute;
// the control surface can only pause once at a named phase and/or inject one
// synthetic failure at a named phase, both single-use.
// ---------------------------------------------------------------------------

export type PlanningArtifactPhaseInternal =
  | "root-pinned"
  | "state-directory-ready"
  | "planning-directory-ready"
  | "results-directory-ready"
  | "before-leaf-open"
  | "after-leaf-write"
  | "after-leaf-sync"
  | "after-leaf-identity-recheck"
  | "after-results-directory-resync"
  | "before-reuse-open"
  | "after-reuse-read"
  | "after-reuse-sync"
  | "after-leaf-open"
  | "after-initial-identity-check"
  | "after-read"
  | "after-final-identity-check";

const PHASES: ReadonlySet<string> = new Set<PlanningArtifactPhaseInternal>([
  "root-pinned", "state-directory-ready", "planning-directory-ready", "results-directory-ready",
  "before-leaf-open", "after-leaf-write", "after-leaf-sync", "after-leaf-identity-recheck",
  "after-results-directory-resync", "before-reuse-open", "after-reuse-read", "after-reuse-sync",
  "after-leaf-open", "after-initial-identity-check", "after-read", "after-final-identity-check",
]);

interface PlanningArtifactTestControlState {
  failAt: PlanningArtifactPhaseInternal | null;
  pauseAt: PlanningArtifactPhaseInternal | null;
  paused: { resolve: () => void } | null;
  consumedPause: boolean;
  consumedFail: boolean;
  /** Non-null only when `pauseAt` is armed. Resolves once `fireControlPhase` has actually
   * reached that phase AND installed the resume resolver in `paused` — never before. Created
   * eagerly at construction time so `waitForPlanningArtifactPauseInternal` can be awaited
   * before the guarded operation even starts, and repeated calls observe the same promise. */
  reached: { promise: Promise<void>; resolve: () => void } | null;
}

export class PlanningArtifactTestControlInternal {
  private constructor() {}
}

const testControlStates = new WeakMap<PlanningArtifactTestControlInternal, PlanningArtifactTestControlState>();

/** Authenticates `control` against the WeakMap by reference identity only — never inspects a
 * property of `control` itself, so a Proxy's traps are never invoked and a revoked Proxy is
 * handled safely (WeakMap membership is an identity operation, not a [[Get]]/trap-based one).
 * Throws the closed `planning-artifact.invalid-hooks` code for anything that is not the exact
 * object returned by `createPlanningArtifactTestControlInternal` — including `null`, primitives,
 * a spread copy (no state lives on the object itself), a forged same-prototype instance, and a
 * Proxy (revoked or not) wrapping a genuine token. */
function authenticateControlState(control: unknown): PlanningArtifactTestControlState {
  if (typeof control !== "object" || control === null) fail("planning-artifact.invalid-hooks");
  const state = testControlStates.get(control as PlanningArtifactTestControlInternal);
  if (!state) fail("planning-artifact.invalid-hooks");
  return state;
}

/** `undefined` alone means "no test control supplied" (the normal production call shape) and is
 * passed through unauthenticated. Anything else — including a forged/copied/proxied value — must
 * authenticate or the call fails closed with `planning-artifact.invalid-hooks`, before this
 * module performs any root revalidation or filesystem access. */
function authenticateOptionalControl(control: unknown): PlanningArtifactTestControlInternal | undefined {
  if (control === undefined) return undefined;
  authenticateControlState(control);
  return control as PlanningArtifactTestControlInternal;
}

export function createPlanningArtifactTestControlInternal(
  descriptor: { readonly failAt: PlanningArtifactPhaseInternal | null; readonly pauseAt: PlanningArtifactPhaseInternal | null },
): PlanningArtifactTestControlInternal {
  try {
    assertBoundedStructure(descriptor, SMALL_STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) fail("planning-artifact.invalid-hooks");
    throw error;
  }
  if (!isOrdinaryRecord(descriptor)) fail("planning-artifact.invalid-hooks");
  if (!exactKeys(descriptor, ["failAt", "pauseAt"])) fail("planning-artifact.invalid-hooks");
  const { failAt, pauseAt } = descriptor;
  if (failAt !== null && (typeof failAt !== "string" || !PHASES.has(failAt))) fail("planning-artifact.invalid-hooks");
  if (pauseAt !== null && (typeof pauseAt !== "string" || !PHASES.has(pauseAt))) fail("planning-artifact.invalid-hooks");
  const control = Object.create(PlanningArtifactTestControlInternal.prototype) as PlanningArtifactTestControlInternal;
  Object.freeze(control);
  let reached: PlanningArtifactTestControlState["reached"] = null;
  if (pauseAt !== null) {
    let resolveReached!: () => void;
    const promise = new Promise<void>((resolve) => { resolveReached = resolve; });
    reached = { promise, resolve: resolveReached };
  }
  testControlStates.set(control, { failAt, pauseAt, paused: null, consumedPause: false, consumedFail: false, reached });
  return control;
}

/** Resumes a one-shot pause previously armed via `createPlanningArtifactTestControlInternal`'s
 * `pauseAt`. Idempotent no-op ONLY for an authentic control that is not currently paused (never
 * armed, already consumed, or already resumed) — an unauthentic control (forged/copied/proxied)
 * rejects with `planning-artifact.invalid-hooks` instead of silently pretending success. */
export function resumePlanningArtifactTestControlInternal(control: unknown): void {
  const state = authenticateControlState(control);
  if (!state.paused) return;
  const resolve = state.paused.resolve;
  state.paused = null;
  resolve();
}

/** Test-only: resolves once the given control's armed `pauseAt` phase has actually been reached
 * and the resume resolver installed — never by polling, a timer, or a handle-count guess.
 * Repeated calls for the same control return the same promise. Rejects with the closed
 * `planning-artifact.invalid-hooks` code for an unauthentic control or one with no armed pause
 * (`pauseAt: null`). */
export function waitForPlanningArtifactPauseInternal(control: unknown): Promise<void> {
  // Deliberately NOT `async`: an async function always wraps its return value in a fresh
  // Promise per call, which would break "same promise for repeated observers" even when the
  // underlying `reached` deferred is identical. Returning the stored promise directly preserves
  // reference equality across repeated calls for a valid, armed control.
  let state: PlanningArtifactTestControlState;
  try {
    state = authenticateControlState(control);
    if (!state.reached) fail("planning-artifact.invalid-hooks");
  } catch (error) {
    return Promise.reject(error);
  }
  return state.reached.promise;
}

async function fireControlPhase(control: PlanningArtifactTestControlInternal | undefined, phase: PlanningArtifactPhaseInternal): Promise<void> {
  if (!control) return;
  const state = testControlStates.get(control)!;
  if (state.pauseAt === phase && !state.consumedPause) {
    state.consumedPause = true;
    await new Promise<void>((resolve) => {
      state.paused = { resolve };
      state.reached?.resolve();
    });
  }
  if (state.failAt === phase && !state.consumedFail) {
    state.consumedFail = true;
    fail("planning-artifact.io-failed");
  }
}

// ---------------------------------------------------------------------------
// Native handle tracking (retention accounting + confined-close discipline)
// ---------------------------------------------------------------------------

const openHandles = new Set<FileHandle>();
const releasedHandles = new WeakSet<FileHandle>();

/** Confined snapshot getter: a count only, never a path/native handle/raw fd. */
export function getPlanningArtifactOpenHandleCountInternal(): number {
  return openHandles.size;
}

async function trackedOpen(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const handle = mode === undefined ? await open(path, flags) : await open(path, flags, mode);
  openHandles.add(handle);
  return handle;
}

/** Closes exactly once. Returns true only when the handle is CONFIRMED released (either the
 * close() call itself succeeded, or — for the double-close/already-invalid case — a subsequent
 * stat() on the same handle object proves EBADF, never a raw numeric fd retry). Any other
 * outcome returns false, which the caller must treat as cleanup-uncertain, overriding whatever
 * else happened in that operation. */
async function trackedClose(handle: FileHandle | undefined): Promise<boolean> {
  if (!handle) return true;
  if (releasedHandles.has(handle)) {
    openHandles.delete(handle);
    return true;
  }
  try {
    await handle.close();
    releasedHandles.add(handle);
    openHandles.delete(handle);
    return true;
  } catch {
    try {
      await handle.stat();
      return false;
    } catch (statError) {
      if (isNodeError(statError, "EBADF")) {
        releasedHandles.add(handle);
        openHandles.delete(handle);
        return true;
      }
      return false;
    }
  }
}

async function nativeDurability(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch {
    fail("planning-artifact.io-failed");
  }
}

/** Closes `handle` and fails with `code` — but ONLY if the close itself is confirmed. An
 * unconfirmed close always overrides the caller's intended failure code with
 * `cleanup-uncertain`, per the rule that cleanup uncertainty overrides every other outcome. */
async function closeThenFail(handle: FileHandle | undefined, code: ResearchPlanningArtifactErrorCode): Promise<never> {
  const closed = await trackedClose(handle);
  fail(closed ? code : "planning-artifact.cleanup-uncertain");
}

/** Closes `handle` and rethrows `error` — but ONLY if the close itself is confirmed. An
 * unconfirmed close overrides `error` with `cleanup-uncertain`, same rule as `closeThenFail`. */
async function closeThenRethrow(handle: FileHandle | undefined, error: unknown): Promise<never> {
  const closed = await trackedClose(handle);
  if (!closed) fail("planning-artifact.cleanup-uncertain");
  throw error;
}

// ---------------------------------------------------------------------------
// Pinned directory chain — the shared lifecycle helper items 1/2 require.
// One implementation, reused by the writer, the reuse path, and the reader.
// ---------------------------------------------------------------------------

interface PinnedDirInternal {
  readonly handle: FileHandle;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly procfs: boolean;
}

/** Internal-only control-flow marker: a genuinely absent (never created) ancestor directory
 * on a read-only chain walk (`createIfMissing:false`) is "no artifact was ever written here",
 * i.e. not-found — distinct from a PRESENT-but-wrong-type ancestor, which is unsafe-file. Never
 * exported, never surfaces as a thrown value outside this module. */
class MissingAncestorInternal extends Error {}

function descriptorRelativeChildPath(parentFd: number, name: string): string {
  return `/proc/self/fd/${parentFd}/${name}`;
}

function assertSupportedPlatform(): void {
  if (DIRECTORY_FLAG === 0 || NO_FOLLOW === 0 || (process.platform !== "linux" && process.platform !== "darwin")) {
    fail("planning-artifact.io-failed");
  }
}

function assertOwnedDirectoryStat(stat: { isDirectory(): boolean; uid: bigint; mode: bigint }): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || (uid !== null && stat.uid !== BigInt(uid)) || (stat.mode & 0o077n) !== 0n) {
    fail("planning-artifact.unsafe-file");
  }
}

/** Opens and pins the run root itself. Anchors identity to `OwnedRunRoot`'s own public
 * `dev`/`ino` fields (never the private pinned handle) — this is what "genuine root auth"
 * means here: the caller's already-`revalidateOwnedRunRoot`-checked identity is what a freshly
 * opened, independently owned descriptor is required to match, not an assumption. */
async function pinRootDirectory(root: OwnedRunRoot): Promise<PinnedDirInternal> {
  const preLstat = await lstat(root.path).catch(() => fail("planning-artifact.unsafe-file"));
  if (preLstat.isSymbolicLink() || !preLstat.isDirectory()) fail("planning-artifact.unsafe-file");
  const handle = await trackedOpen(root.path, constants.O_RDONLY | NO_FOLLOW | DIRECTORY_FLAG).catch(() => fail("planning-artifact.unsafe-file"));
  let stat: BigIntStats;
  try {
    stat = await handle.stat({ bigint: true });
  } catch {
    return closeThenFail(handle, "planning-artifact.unsafe-file");
  }
  if (!stat.isDirectory() || stat.dev !== BigInt(root.dev) || stat.ino !== BigInt(root.ino)) {
    return closeThenFail(handle, "planning-artifact.unsafe-file");
  }
  if (process.platform === "linux") {
    let probe: FileHandle | undefined;
    try {
      probe = await trackedOpen(descriptorRelativeChildPath(handle.fd, "."), constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
      if (!(await probe.stat()).isDirectory()) fail("planning-artifact.io-failed");
    } catch {
      const probeClosed = await trackedClose(probe);
      const rootClosed = await trackedClose(handle);
      if (!probeClosed || !rootClosed) fail("planning-artifact.cleanup-uncertain");
      fail("planning-artifact.io-failed");
    }
    if (!(await trackedClose(probe))) {
      await trackedClose(handle);
      fail("planning-artifact.cleanup-uncertain");
    }
  }
  return { handle, dev: stat.dev, ino: stat.ino, procfs: process.platform === "linux" };
}

/** Opens and pins one child directory of an already-pinned parent, creating it first if it
 * does not exist. On Linux the child is opened via `/proc/self/fd/<parentFd>/<name>` —
 * resolution tied to the SPECIFIC already-pinned parent directory instance, not to a freshly
 * re-walked pathname from the root, closing the "an ancestor was replaced/symlinked" attack for
 * every level below the root. Darwin has no descriptor-relative open, so it falls back to a
 * plain pathname open bracketed immediately before and after by identity re-checks against the
 * parent pin and the freshly opened child — this narrows, but (per this codebase's documented,
 * unavoidable, same-user limitation — Node/Darwin expose no openat2/RESOLVE_BENEATH) cannot
 * fully eliminate, the ancestor-rename race window on that platform. */
async function pinChildDirectory(
  parent: PinnedDirInternal,
  name: string,
  fullPath: string,
  createIfMissing: boolean,
): Promise<PinnedDirInternal> {
  if (createIfMissing) {
    try {
      await mkdir(fullPath, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) fail("planning-artifact.io-failed");
    }
  }
  // Immediately before opening: re-verify the parent pin is still what it was, then verify the
  // child's current pathname state. No other await is interposed between this check and the
  // sensitive open call below.
  await reverifyPinnedDirectory(parent);
  const preLstat = await lstat(fullPath).catch((error: unknown) => {
    if (!createIfMissing && isNodeError(error, "ENOENT")) throw new MissingAncestorInternal();
    fail("planning-artifact.unsafe-file");
  });
  if (preLstat.isSymbolicLink() || !preLstat.isDirectory()) fail("planning-artifact.unsafe-file");

  const openPath = parent.procfs ? descriptorRelativeChildPath(parent.handle.fd, name) : fullPath;
  const handle = await trackedOpen(openPath, constants.O_RDONLY | NO_FOLLOW | DIRECTORY_FLAG).catch(() => fail("planning-artifact.unsafe-file"));
  let stat: BigIntStats;
  try {
    stat = await handle.stat({ bigint: true });
  } catch {
    return closeThenFail(handle, "planning-artifact.unsafe-file");
  }
  try {
    assertOwnedDirectoryStat(stat);
  } catch (error) {
    return closeThenRethrow(handle, error);
  }
  // Re-lstat the plain pathname once more: proves a fresh pathname lookup right now sees the
  // same entity the descriptor-relative (or Darwin plain) open just landed on.
  let postLstat: BigIntStats;
  try {
    postLstat = await lstat(fullPath, { bigint: true });
  } catch {
    return closeThenFail(handle, "planning-artifact.unsafe-file");
  }
  if (postLstat.isSymbolicLink() || !postLstat.isDirectory() || postLstat.dev !== stat.dev || postLstat.ino !== stat.ino) {
    return closeThenFail(handle, "planning-artifact.unsafe-file");
  }
  return { handle, dev: stat.dev, ino: stat.ino, procfs: parent.procfs };
}

/** Re-verifies a pin still refers to what it did when opened: the descriptor's own current
 * stat must still report the same dev/ino (proves the underlying directory was not replaced
 * while we held the descriptor). Called before every sensitive action that follows an awaited
 * boundary. */
async function reverifyPinnedDirectory(pin: PinnedDirInternal): Promise<void> {
  const stat = await pin.handle.stat({ bigint: true }).catch(() => fail("planning-artifact.unsafe-file"));
  if (!stat.isDirectory() || stat.dev !== pin.dev || stat.ino !== pin.ino) fail("planning-artifact.unsafe-file");
}

async function closePinsQuietly(pins: readonly PinnedDirInternal[]): Promise<boolean> {
  let allClosed = true;
  for (let index = pins.length - 1; index >= 0; index -= 1) {
    const closed = await trackedClose(pins[index]!.handle);
    if (!closed) allClosed = false;
  }
  return allClosed;
}

interface DirectoryChain {
  readonly root: PinnedDirInternal;
  readonly state: PinnedDirInternal;
  readonly planning: PinnedDirInternal;
  readonly results: PinnedDirInternal;
}

/** Builds (creating as needed) and pins the full `.state/planning/results` chain under an
 * authenticated root, fsyncing each newly-relevant directory level and its parent as it goes.
 * The single implementation both the writer and (read-only, `createIfMissing:false`) the reader
 * use — no duplicated ancestor-walking logic between them. */
async function buildDirectoryChain(
  root: OwnedRunRoot,
  createIfMissing: boolean,
  control: PlanningArtifactTestControlInternal | undefined,
): Promise<DirectoryChain> {
  const opened: PinnedDirInternal[] = [];
  try {
    const rootPin = await pinRootDirectory(root);
    opened.push(rootPin);
    await fireControlPhase(control, "root-pinned");

    const statePath = join(root.path, ".state");
    const statePin = await pinChildDirectory(rootPin, ".state", statePath, createIfMissing);
    opened.push(statePin);
    if (createIfMissing) {
      await nativeDurability(statePin.handle);
      await nativeDurability(rootPin.handle);
    }
    await fireControlPhase(control, "state-directory-ready");

    const planningPath = join(statePath, "planning");
    const planningPin = await pinChildDirectory(statePin, "planning", planningPath, createIfMissing);
    opened.push(planningPin);
    if (createIfMissing) {
      await nativeDurability(planningPin.handle);
      await nativeDurability(statePin.handle);
    }
    await fireControlPhase(control, "planning-directory-ready");

    const resultsPath = join(planningPath, "results");
    const resultsPin = await pinChildDirectory(planningPin, "results", resultsPath, createIfMissing);
    opened.push(resultsPin);
    if (createIfMissing) {
      await nativeDurability(resultsPin.handle);
      await nativeDurability(planningPin.handle);
    }
    await fireControlPhase(control, "results-directory-ready");

    return { root: rootPin, state: statePin, planning: planningPin, results: resultsPin };
  } catch (error) {
    // Cleanup uncertainty overrides EVERY outcome unconditionally — including the internal
    // MissingAncestorInternal control-flow signal that would otherwise map to the softer
    // "not-found" — because a caller must never be told an operation resolved cleanly (even to
    // a benign not-found) when this module cannot confirm every descriptor it opened was
    // actually released.
    const closed = await closePinsQuietly(opened);
    if (!closed) throw new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
    throw error;
  }
}

async function withDirectoryChain<T>(
  root: OwnedRunRoot,
  createIfMissing: boolean,
  control: PlanningArtifactTestControlInternal | undefined,
  body: (chain: DirectoryChain) => Promise<T>,
): Promise<T> {
  const chain = await buildDirectoryChain(root, createIfMissing, control);
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await body(chain) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const closed = await closePinsQuietly([chain.root, chain.state, chain.planning, chain.results]);
  if (!closed) fail("planning-artifact.cleanup-uncertain");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// ---------------------------------------------------------------------------
// Bounded byte I/O helpers
// ---------------------------------------------------------------------------

async function writeFully(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten < 1) fail("planning-artifact.io-failed");
    offset += bytesWritten;
  }
}

async function readAllChunked(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedBytes + 1);
  let total = 0;
  while (total < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) fail("planning-artifact.unsafe-file");
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > expectedBytes) fail("planning-artifact.unsafe-file");
  }
  if (total !== expectedBytes) fail("planning-artifact.unsafe-file");
  return buffer.subarray(0, total);
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertStableRegularFile(descriptorStat: BigIntStats, pathStat: BigIntStats): void {
  if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || descriptorStat.nlink !== 1n || pathStat.nlink !== 1n) {
    fail("planning-artifact.unsafe-file");
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function writePlanningArtifactInternal(
  authenticRoot: OwnedRunRoot,
  authenticResult: ValidatedCoordinatorPlanningResultInternal,
  authenticBoard: ValidatedPlanningTaskBoardInternal,
  metadataInput: unknown,
  testControl?: PlanningArtifactTestControlInternal,
): Promise<PlanningArtifactRefInternal> {
  try {
    return await writePlanningArtifactInternalUnsafe(authenticRoot, authenticResult, authenticBoard, metadataInput, testControl);
  } catch (error) {
    throw normalizeFailure(error);
  }
}

async function writePlanningArtifactInternalUnsafe(
  authenticRoot: OwnedRunRoot,
  authenticResult: ValidatedCoordinatorPlanningResultInternal,
  authenticBoard: ValidatedPlanningTaskBoardInternal,
  metadataInput: unknown,
  testControl: PlanningArtifactTestControlInternal | undefined,
): Promise<PlanningArtifactRefInternal> {
  testControl = authenticateOptionalControl(testControl);
  assertSupportedPlatform();
  try {
    assertValidatedCoordinatorPlanningResultInternal(authenticResult);
  } catch (error) {
    if (error instanceof ResearchPlanningContractError) fail("planning-artifact.invalid-result");
    throw error;
  }
  try {
    assertValidatedPlanningTaskBoardInternal(authenticBoard);
  } catch (error) {
    if (error instanceof ResearchPlanningBoardError) fail("planning-artifact.invalid-board");
    throw error;
  }
  try {
    await revalidateOwnedRunRoot(authenticRoot);
  } catch (error) {
    if (error instanceof RunRootError) fail("planning-artifact.unsafe-file");
    throw error;
  }
  // Symmetric with the read side's binding.runId === authenticRoot.runId check: without this,
  // a caller bug could silently persist one run's content under a different run's directory
  // tree with no error until a later read happened to expose the mismatch.
  if (authenticResult.runId !== authenticRoot.runId) fail("planning-artifact.invalid-result");
  const metadata = validateMetadataInternal(metadataInput);

  let revalidatedResult: ValidatedCoordinatorPlanningResultInternal;
  try {
    revalidatedResult = validateCoordinatorPlanningResultInternal(authenticResult, {
      runId: authenticResult.runId, attemptId: authenticResult.attemptId, maxSources: metadata.maxSources,
    } as never);
  } catch (error) {
    if (error instanceof ResearchPlanningContractError) fail("planning-artifact.invalid-result");
    throw error;
  }

  const rebuiltBoard = rebuildAndCompareBoardInternal(revalidatedResult, authenticBoard);

  // Persist the objects that were actually checked (revalidatedResult/rebuiltBoard), not the
  // pre-revalidation inputs — canonically identical when validation succeeds, but this makes
  // that equivalence structural rather than an assumption the persisted bytes rely on.
  const artifact = buildArtifactPlainObject(metadata, revalidatedResult, rebuiltBoard);
  let bytes: Buffer;
  try {
    bytes = canonicalJsonBytes(artifact);
  } catch {
    fail("planning-artifact.invalid-result");
  }
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) fail("planning-artifact.invalid-result");
  const sha256 = sha256Hex(bytes);
  const relativePath = expectedRelativePathFor(sha256);

  return withDirectoryChain(authenticRoot, true, testControl, async (chain) => {
    const resultsPath = join(authenticRoot.path, ".state", "planning", "results");
    const name = `${sha256}.json`;
    const leafPath = join(resultsPath, name);

    await fireControlPhase(testControl, "before-leaf-open");
    // Final identity re-check immediately before the sensitive create, with nothing else
    // awaited in between.
    await reverifyPinnedDirectory(chain.results);
    const openPath = chain.results.procfs ? descriptorRelativeChildPath(chain.results.handle.fd, name) : leafPath;

    let leafHandle: FileHandle | undefined;
    let reused = false;
    let leafFailure: unknown;
    try {
      try {
        leafHandle = await trackedOpen(openPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          reused = true;
        } else {
          throw error;
        }
      }
      if (reused) {
        await reuseExistingArtifact(leafPath, bytes, testControl);
      } else if (leafHandle) {
        const createdStat = await leafHandle.stat({ bigint: true });
        const createdPathStat = await lstat(leafPath, { bigint: true }).catch(() => fail("planning-artifact.unsafe-file"));
        assertStableRegularFile(createdStat, createdPathStat);
        if (!sameInode(createdStat, createdPathStat)) fail("planning-artifact.unsafe-file");
        await writeFully(leafHandle, bytes);
        await fireControlPhase(testControl, "after-leaf-write");
        await nativeDurability(leafHandle);
        await fireControlPhase(testControl, "after-leaf-sync");
        // Re-confirm identity after writing, before declaring success — not just at open time.
        const finalStat = await leafHandle.stat({ bigint: true });
        const finalPathStat = await lstat(leafPath, { bigint: true }).catch(() => fail("planning-artifact.unsafe-file"));
        assertStableRegularFile(finalStat, finalPathStat);
        if (!sameInode(finalStat, createdStat) || !sameInode(finalPathStat, createdStat)
          || !sameStableFile(finalStat, finalPathStat)
          || finalStat.size !== BigInt(bytes.byteLength)) fail("planning-artifact.unsafe-file");
        await fireControlPhase(testControl, "after-leaf-identity-recheck");
      }
    } catch (error) {
      leafFailure = error;
    }
    const leafClosed = await trackedClose(leafHandle);
    if (!leafClosed) leafFailure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
    if (leafFailure) throw leafFailure;

    // Always re-confirm directory durability, even on idempotent reuse — a prior writer's fsync
    // of this directory entry is never assumed, matching the file-level "reuse is verified AND
    // (re-)durable, never merely trusted" rule the reuse path already applies to file content.
    await reverifyPinnedDirectory(chain.results);
    await nativeDurability(chain.results.handle);
    await fireControlPhase(testControl, "after-results-directory-resync");

    return Object.freeze({ relativePath, sha256, decodedBytes: bytes.byteLength });
  });
}

async function reuseExistingArtifact(
  leafPath: string,
  expectedBytes: Buffer,
  testControl: PlanningArtifactTestControlInternal | undefined,
): Promise<void> {
  await fireControlPhase(testControl, "before-reuse-open");
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    try {
      handle = await trackedOpen(leafPath, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
    } catch (error) {
      if (isNodeError(error, "ELOOP")) fail("planning-artifact.unsafe-file");
      throw error;
    }
    const initial = await handle.stat({ bigint: true });
    const initialPath = await lstat(leafPath, { bigint: true }).catch(() => fail("planning-artifact.unsafe-file"));
    assertStableRegularFile(initial, initialPath);
    if (!sameInode(initial, initialPath)) fail("planning-artifact.unsafe-file");
    if (initial.size > BigInt(MAX_ARTIFACT_BYTES)) fail("planning-artifact.unsafe-file");
    // The upfront size-ceiling checks already bound this read to at most MAX_ARTIFACT_BYTES
    // regardless of the existing file's own size, so reading exactly the existing file's real
    // size is safe here and preserves "different size" and "same size, different bytes" both
    // surfacing as a content mismatch (planning-artifact.corrupt) below.
    const existingBytes = await readAllChunked(handle, Number(initial.size));
    await fireControlPhase(testControl, "after-reuse-read");

    const afterStat = await handle.stat({ bigint: true });
    const afterPathStat = await lstat(leafPath, { bigint: true }).catch(() => fail("planning-artifact.unsafe-file"));
    assertStableRegularFile(afterStat, afterPathStat);
    if (!sameInode(afterStat, initial) || !sameInode(afterPathStat, initial) || !sameStableFile(afterStat, initial)) {
      fail("planning-artifact.unsafe-file");
    }

    if (!existingBytes.equals(expectedBytes)) fail("planning-artifact.corrupt");
    await nativeDurability(handle);
    await fireControlPhase(testControl, "after-reuse-sync");
  } catch (error) {
    failure = error;
  }
  const closed = await trackedClose(handle);
  if (!closed) failure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
  if (failure) throw failure;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function readPlanningArtifactInternal(
  authenticRoot: OwnedRunRoot,
  refInput: unknown,
  expectedBindingInput: unknown,
  testControl?: PlanningArtifactTestControlInternal,
): Promise<ReadPlanningArtifactResultInternal> {
  try {
    return await readPlanningArtifactInternalUnsafe(authenticRoot, refInput, expectedBindingInput, testControl);
  } catch (error) {
    throw normalizeFailure(error);
  }
}

async function readPlanningArtifactInternalUnsafe(
  authenticRoot: OwnedRunRoot,
  refInput: unknown,
  expectedBindingInput: unknown,
  testControl: PlanningArtifactTestControlInternal | undefined,
): Promise<ReadPlanningArtifactResultInternal> {
  testControl = authenticateOptionalControl(testControl);
  assertSupportedPlatform();
  const binding = validateExpectedBindingInternal(expectedBindingInput);
  try {
    await revalidateOwnedRunRoot(authenticRoot);
  } catch (error) {
    if (error instanceof RunRootError) fail("planning-artifact.unsafe-file");
    throw error;
  }
  if (binding.runId !== authenticRoot.runId) fail("planning-artifact.invalid-binding");
  const ref = validateRefInternal(refInput);

  // Read never mkdirs: the chain must already exist. createIfMissing:false means a missing
  // ancestor surfaces as planning-artifact.unsafe-file from pinChildDirectory's own lstat
  // check — except a missing LEAF's own missing *results* ancestor is indistinguishable from
  // "artifact truly never existed" only at the leaf-open step below, which maps ENOENT
  // specifically to not-found; a missing ancestor is a structural problem, not a plain
  // not-found, so it is intentionally reported as unsafe-file, not not-found.
  try {
    return await withDirectoryChain(authenticRoot, false, testControl, async (chain) => {
    const path = join(authenticRoot.path, ref.relativePath);
    const name = `${ref.sha256}.json`;
    const openPath = chain.results.procfs ? descriptorRelativeChildPath(chain.results.handle.fd, name) : path;

    let handle: FileHandle | undefined;
    let result: ReadPlanningArtifactResultInternal | undefined;
    let failure: unknown;
    try {
      try {
        await reverifyPinnedDirectory(chain.results);
        handle = await trackedOpen(openPath, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) fail("planning-artifact.not-found");
        if (isNodeError(error, "ELOOP")) fail("planning-artifact.unsafe-file");
        throw error;
      }
      await fireControlPhase(testControl, "after-leaf-open");
      const initialDescriptorStat = await handle.stat({ bigint: true });
      const initialPathStat = await lstat(path, { bigint: true }).catch(() => fail("planning-artifact.not-found"));
      assertStableRegularFile(initialDescriptorStat, initialPathStat);
      if (!sameInode(initialDescriptorStat, initialPathStat)) fail("planning-artifact.unsafe-file");
      if (initialDescriptorStat.size !== BigInt(ref.decodedBytes)) fail("planning-artifact.unsafe-file");
      if (initialDescriptorStat.size > BigInt(MAX_ARTIFACT_BYTES)) fail("planning-artifact.unsafe-file");
      await fireControlPhase(testControl, "after-initial-identity-check");

      const bytes = await readAllChunked(handle, ref.decodedBytes);
      await fireControlPhase(testControl, "after-read");

      const afterDescriptorStat = await handle.stat({ bigint: true });
      const afterPathStat = await lstat(path, { bigint: true }).catch(() => fail("planning-artifact.unsafe-file"));
      assertStableRegularFile(afterDescriptorStat, afterPathStat);
      if (!sameInode(afterDescriptorStat, initialDescriptorStat) || !sameInode(afterPathStat, initialDescriptorStat)
        || !sameStableFile(afterDescriptorStat, initialDescriptorStat)) fail("planning-artifact.unsafe-file");
      await fireControlPhase(testControl, "after-final-identity-check");

      if (sha256Hex(bytes) !== ref.sha256) fail("planning-artifact.corrupt");
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("planning-artifact.corrupt");

      let text: string;
      try {
        text = fatalUtf8.decode(bytes);
      } catch {
        fail("planning-artifact.corrupt");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        fail("planning-artifact.corrupt");
      }
      try {
        assertBoundedStructure(parsed, ARTIFACT_STRUCTURAL_LIMITS);
      } catch (error) {
        if (error instanceof StructuralLimitError) fail("planning-artifact.corrupt");
        throw error;
      }
      let canonical: string;
      try {
        canonical = canonicalJson(parsed);
      } catch {
        fail("planning-artifact.corrupt");
      }
      if (canonical !== text) fail("planning-artifact.corrupt");

      if (!isOrdinaryRecord(parsed) || !exactKeys(parsed, ARTIFACT_KEYS)) fail("planning-artifact.corrupt");
      const {
        schemaVersion, kind, executionEpoch, transactionId, createdAt,
        attemptEnvelopeSha256, logicalInputSha256, maxSources, result: rawResult, board: rawBoard,
      } = parsed;
      if (schemaVersion !== 1) fail("planning-artifact.corrupt");
      if (kind !== "coordinator-planning-artifact") fail("planning-artifact.corrupt");
      if (executionEpoch !== 0) fail("planning-artifact.corrupt");
      if (typeof createdAt !== "string" || !isTimestamp(createdAt)) fail("planning-artifact.corrupt");
      if (typeof transactionId !== "string" || !ID_PATTERNS.transaction.test(transactionId)) fail("planning-artifact.corrupt");
      if (transactionId !== binding.transactionId) fail("planning-artifact.invalid-binding");
      if (typeof attemptEnvelopeSha256 !== "string" || !isSha256(attemptEnvelopeSha256)) fail("planning-artifact.corrupt");
      if (attemptEnvelopeSha256 !== binding.attemptEnvelopeSha256) fail("planning-artifact.invalid-binding");
      if (typeof logicalInputSha256 !== "string" || !isSha256(logicalInputSha256)) fail("planning-artifact.corrupt");
      if (logicalInputSha256 !== binding.logicalInputSha256) fail("planning-artifact.invalid-binding");
      if (typeof maxSources !== "number" || !Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > MAX_SOURCES_CEILING) fail("planning-artifact.corrupt");
      if (maxSources !== binding.maxSources) fail("planning-artifact.invalid-binding");

      // Cross-check the stored result's OWN claimed runId/attemptId against the caller's
      // expected binding BEFORE handing them to the stricter validator below — otherwise a
      // caller-side wrong binding value would surface as "invalid-result" (implying the
      // stored artifact is corrupt) rather than "invalid-binding" (the caller's mistake).
      if (!isOrdinaryRecord(rawResult)) fail("planning-artifact.corrupt");
      const rawRunId = rawResult.runId;
      const rawAttemptId = rawResult.attemptId;
      if (typeof rawRunId !== "string" || typeof rawAttemptId !== "string") fail("planning-artifact.corrupt");
      if (rawRunId !== binding.runId || rawAttemptId !== binding.attemptId) fail("planning-artifact.invalid-binding");

      let freshResult: ValidatedCoordinatorPlanningResultInternal;
      try {
        freshResult = validateCoordinatorPlanningResultInternal(rawResult, {
          runId: rawRunId, attemptId: rawAttemptId, maxSources,
        } as never);
      } catch (error) {
        if (error instanceof ResearchPlanningContractError) fail("planning-artifact.invalid-result");
        throw error;
      }
      if (freshResult.runId !== binding.runId || freshResult.attemptId !== binding.attemptId) fail("planning-artifact.invalid-binding");

      const rebuiltBoard = rebuildAndCompareBoardInternal(freshResult, rawBoard);
      if (rebuiltBoard.controlTaskId !== binding.controlTaskId) fail("planning-artifact.invalid-binding");

      result = Object.freeze({
        executionEpoch: 0 as const,
        transactionId: transactionId as TransactionId,
        createdAt: createdAt as Timestamp,
        attemptEnvelopeSha256: attemptEnvelopeSha256 as Sha256,
        logicalInputSha256: logicalInputSha256 as Sha256,
        maxSources,
        result: freshResult,
        board: rebuiltBoard,
      });
    } catch (error) {
      failure = error;
    }
    const closed = await trackedClose(handle);
    if (!closed) failure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
    if (failure) throw failure;

    return result!;
    });
  } catch (error) {
    if (error instanceof MissingAncestorInternal) fail("planning-artifact.not-found");
    throw error;
  }
}
