import { constants } from "node:fs";
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
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCES_CEILING = 500;
const READ_CHUNK_BYTES = 64 * 1024;
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

export type PlanningArtifactPhaseInternal =
  | "mkdir-state-directory-synced" | "mkdir-state-parent-synced"
  | "mkdir-planning-directory-synced" | "mkdir-planning-parent-synced"
  | "mkdir-results-directory-synced" | "mkdir-results-parent-synced"
  | "artifact-file-synced"
  | "results-directory-synced"
  | "existing-artifact-resynced";

export interface PlanningArtifactTestHooksInternal {
  readonly durability?: (handle: FileHandle, phase: PlanningArtifactPhaseInternal) => Promise<void>;
  readonly onPhase?: (phase: PlanningArtifactPhaseInternal) => Promise<void>;
}

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

export type ResearchPlanningArtifactErrorCode =
  | "planning-artifact.invalid-result"
  | "planning-artifact.invalid-board"
  | "planning-artifact.invalid-metadata"
  | "planning-artifact.invalid-ref"
  | "planning-artifact.invalid-binding"
  | "planning-artifact.mismatch"
  | "planning-artifact.not-found"
  | "planning-artifact.corrupt"
  | "planning-artifact.unsafe-file"
  | "planning-artifact.io-failed"
  | "planning-artifact.cleanup-uncertain";

const KNOWN_CODES: readonly ResearchPlanningArtifactErrorCode[] = [
  "planning-artifact.invalid-result", "planning-artifact.invalid-board", "planning-artifact.invalid-metadata",
  "planning-artifact.invalid-ref", "planning-artifact.invalid-binding", "planning-artifact.mismatch",
  "planning-artifact.not-found", "planning-artifact.corrupt", "planning-artifact.unsafe-file",
  "planning-artifact.io-failed", "planning-artifact.cleanup-uncertain",
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Mirrors transaction-store.ts's own (unexported) assertOwnedDirectory exactly: rejects a
 * symlink, a non-directory, a directory not owned by the current uid, or one with any
 * group/other permission bit set — not just "is it a directory". */
async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => fail("planning-artifact.unsafe-file"));
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    fail("planning-artifact.unsafe-file");
  }
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

const releasedHandles = new WeakSet<FileHandle>();

async function closeQuietly(handle: FileHandle | undefined): Promise<boolean> {
  if (!handle || releasedHandles.has(handle)) return true;
  try {
    await handle.close();
    releasedHandles.add(handle);
    return true;
  } catch {
    try {
      await handle.stat();
      return false;
    } catch (statError) {
      if (isNodeError(statError, "EBADF")) {
        releasedHandles.add(handle);
        return true;
      }
      return false;
    }
  }
}

async function durability(
  handle: FileHandle,
  phase: PlanningArtifactPhaseInternal,
  hooks: PlanningArtifactTestHooksInternal | undefined,
): Promise<void> {
  try {
    await (hooks?.durability ?? ((h: FileHandle) => h.sync()))(handle, phase);
  } catch {
    fail("planning-artifact.io-failed");
  }
}

async function onPhase(phase: PlanningArtifactPhaseInternal, hooks: PlanningArtifactTestHooksInternal | undefined): Promise<void> {
  try {
    await hooks?.onPhase?.(phase);
  } catch {
    fail("planning-artifact.io-failed");
  }
}

async function ensureDurableDirectory(
  path: string,
  parent: string,
  selfPhase: PlanningArtifactPhaseInternal,
  parentPhase: PlanningArtifactPhaseInternal,
  hooks: PlanningArtifactTestHooksInternal | undefined,
): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) fail("planning-artifact.io-failed");
  }
  await assertOwnedDirectory(path);
  await syncDirectory(path, selfPhase, hooks);
  await syncDirectory(parent, parentPhase, hooks);
}

async function syncDirectory(path: string, phase: PlanningArtifactPhaseInternal, hooks: PlanningArtifactTestHooksInternal | undefined): Promise<void> {
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW | (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0));
    const stat = await handle.stat();
    if (!stat.isDirectory()) fail("planning-artifact.unsafe-file");
    await durability(handle, phase, hooks);
  } catch (error) {
    failure = error;
  }
  const closed = await closeQuietly(handle);
  if (!closed && !failure) failure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
  if (failure) throw failure;
  await onPhase(phase, hooks);
}

async function writeFully(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten < 1) fail("planning-artifact.io-failed");
    offset += bytesWritten;
  }
}

async function readAllChunked(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, expectedBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) fail("planning-artifact.unsafe-file");
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > expectedBytes) fail("planning-artifact.unsafe-file");
    parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  if (total !== expectedBytes) fail("planning-artifact.unsafe-file");
  return Buffer.concat(parts, total);
}

function assertStableRegularFile(descriptorStat: { isFile(): boolean; nlink: bigint }, pathStat: { isFile(): boolean; isSymbolicLink(): boolean; nlink: bigint }): void {
  if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || descriptorStat.nlink !== 1n || pathStat.nlink !== 1n) {
    fail("planning-artifact.unsafe-file");
  }
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

export async function writePlanningArtifactInternal(
  authenticRoot: OwnedRunRoot,
  authenticResult: ValidatedCoordinatorPlanningResultInternal,
  authenticBoard: ValidatedPlanningTaskBoardInternal,
  metadataInput: unknown,
  testHooks?: PlanningArtifactTestHooksInternal,
): Promise<PlanningArtifactRefInternal> {
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

  const stateDir = join(authenticRoot.path, ".state");
  const planningDir = join(stateDir, "planning");
  const resultsDir = join(planningDir, "results");
  await ensureDurableDirectory(stateDir, authenticRoot.path, "mkdir-state-directory-synced", "mkdir-state-parent-synced", testHooks);
  await ensureDurableDirectory(planningDir, stateDir, "mkdir-planning-directory-synced", "mkdir-planning-parent-synced", testHooks);
  await ensureDurableDirectory(resultsDir, planningDir, "mkdir-results-directory-synced", "mkdir-results-parent-synced", testHooks);

  // Re-bracket: the root is checked via its pinned descriptor (not a re-followed pathname, unlike
  // the per-directory lstat checks above), so a root-level replacement between entry and here is
  // still caught even though intermediate-directory pathname races remain the documented,
  // accepted same-user limitation shared with run-root.ts/transaction-store.ts.
  try {
    await revalidateOwnedRunRoot(authenticRoot);
  } catch (error) {
    if (error instanceof RunRootError) fail("planning-artifact.unsafe-file");
    throw error;
  }

  const leafPath = join(resultsDir, `${sha256}.json`);
  let handle: FileHandle | undefined;
  let failure: unknown;
  let reused = false;
  try {
    try {
      handle = await open(leafPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        reused = true;
        await reuseExistingArtifact(leafPath, bytes, testHooks);
      } else {
        throw error;
      }
    }
    if (!reused && handle) {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) fail("planning-artifact.unsafe-file");
      await writeFully(handle, bytes);
      await durability(handle, "artifact-file-synced", testHooks);
    }
  } catch (error) {
    failure = error;
  }
  const closed = await closeQuietly(handle);
  if (!closed && !failure) failure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
  if (failure) throw failure;
  if (!reused) await onPhase("artifact-file-synced", testHooks);

  // Always re-confirm directory durability, even on idempotent reuse — a prior writer's fsync
  // of this directory entry is never assumed, matching the file-level "reuse is verified AND
  // (re-)durable, never merely trusted" rule the reuse path already applies to file content.
  await syncDirectory(resultsDir, "results-directory-synced", testHooks);

  return Object.freeze({ relativePath, sha256, decodedBytes: bytes.byteLength });
}

async function reuseExistingArtifact(leafPath: string, expectedBytes: Buffer, testHooks: PlanningArtifactTestHooksInternal | undefined): Promise<void> {
  const before = await lstat(leafPath).catch(() => fail("planning-artifact.unsafe-file"));
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) fail("planning-artifact.unsafe-file");
  if (before.size > MAX_ARTIFACT_BYTES) fail("planning-artifact.unsafe-file");
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(leafPath, constants.O_RDONLY | NO_FOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("planning-artifact.unsafe-file");
    if (stat.size > MAX_ARTIFACT_BYTES) fail("planning-artifact.unsafe-file");
    // The upfront size-ceiling checks (above and on `before`) already bound this read to at
    // most MAX_ARTIFACT_BYTES regardless of the existing file's own size, so reading exactly
    // the existing file's real size is safe here and preserves "different size" and "same size,
    // different bytes" both surfacing as a content mismatch (planning-artifact.corrupt) below,
    // rather than conflating a size difference with a structural planning-artifact.unsafe-file.
    const existingBytes = await readAllChunked(handle, Number(stat.size));
    if (!existingBytes.equals(expectedBytes)) fail("planning-artifact.corrupt");
    await durability(handle, "existing-artifact-resynced", testHooks);
  } catch (error) {
    failure = error;
  }
  const closed = await closeQuietly(handle);
  if (!closed && !failure) failure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
  if (failure) throw failure;
  await onPhase("existing-artifact-resynced", testHooks);
}

export async function readPlanningArtifactInternal(
  authenticRoot: OwnedRunRoot,
  refInput: unknown,
  expectedBindingInput: unknown,
): Promise<ReadPlanningArtifactResultInternal> {
  const binding = validateExpectedBindingInternal(expectedBindingInput);
  try {
    await revalidateOwnedRunRoot(authenticRoot);
  } catch (error) {
    if (error instanceof RunRootError) fail("planning-artifact.unsafe-file");
    throw error;
  }
  if (binding.runId !== authenticRoot.runId) fail("planning-artifact.invalid-binding");
  const ref = validateRefInternal(refInput);

  const path = join(authenticRoot.path, ref.relativePath);
  let handle: FileHandle | undefined;
  let result: ReadPlanningArtifactResultInternal | undefined;
  let failure: unknown;
  try {
    try {
      handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) fail("planning-artifact.not-found");
      if (isNodeError(error, "ELOOP")) fail("planning-artifact.unsafe-file");
      throw error;
    }
    const initialDescriptorStat = await handle.stat({ bigint: true });
    const initialPathStat = await lstat(path, { bigint: true });
    assertStableRegularFile(initialDescriptorStat, initialPathStat);
    if (initialDescriptorStat.dev !== initialPathStat.dev || initialDescriptorStat.ino !== initialPathStat.ino) fail("planning-artifact.unsafe-file");
    if (initialDescriptorStat.size !== BigInt(ref.decodedBytes)) fail("planning-artifact.unsafe-file");
    if (initialDescriptorStat.size > BigInt(MAX_ARTIFACT_BYTES)) fail("planning-artifact.unsafe-file");

    const bytes = await readAllChunked(handle, ref.decodedBytes);

    const afterDescriptorStat = await handle.stat({ bigint: true });
    const afterPathStat = await lstat(path, { bigint: true });
    assertStableRegularFile(afterDescriptorStat, afterPathStat);
    if (afterDescriptorStat.dev !== initialDescriptorStat.dev || afterDescriptorStat.ino !== initialDescriptorStat.ino
      || afterDescriptorStat.size !== initialDescriptorStat.size
      || afterDescriptorStat.mtimeNs !== initialDescriptorStat.mtimeNs
      || afterDescriptorStat.ctimeNs !== initialDescriptorStat.ctimeNs) fail("planning-artifact.unsafe-file");

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
  const closed = await closeQuietly(handle);
  if (!closed && !failure) failure = new ResearchPlanningArtifactError("planning-artifact.cleanup-uncertain");
  if (failure) throw failure;
  return result!;
}
