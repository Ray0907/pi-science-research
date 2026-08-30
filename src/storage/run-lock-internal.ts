import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync as nativeCloseSync,
  constants,
  fstatSync as nativeFstatSync,
  fsyncSync as nativeFsyncSync,
  lstatSync as nativeLstatSync,
  mkdirSync as nativeMkdirSync,
  openSync as nativeOpenSync,
  readSync as nativeReadSync,
  unlinkSync as nativeUnlinkSync,
  writeSync as nativeWriteSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { isSha256, isTimestamp } from "../domain/ids.js";
import {
  RUN_ROOT_OWNER_FILE,
  RunRootError,
  revalidateOwnedRunRoot,
  type OwnedRunRoot,
} from "./run-root.js";

const STATE_DIRECTORY = ".state";
const LOCK_FILE = "controller.lock";
const MAX_LOCK_RECORD_BYTES = 4096;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const hooksState = new WeakMap<object, TestHookState>();
const retentionObserverState = new WeakMap<object, RetentionObserverState>();
const lockState = new WeakMap<object, InternalLockState>();

export type ResearchRunLockErrorCodeInternal =
  | "lock.invalid-input"
  | "lock.state-invalid"
  | "lock.conflict"
  | "lock.symlink"
  | "lock.unsafe-link"
  | "lock.replaced"
  | "lock.owner-mismatch"
  | "lock.closed"
  | "lock.io-failed";

const authenticLockErrors = new WeakSet<object>();

export class ResearchRunLockError extends Error {
  readonly code: ResearchRunLockErrorCodeInternal;

  constructor(code: ResearchRunLockErrorCodeInternal) {
    const safeCode = isLockErrorCode(code) ? code : "lock.io-failed";
    super(`Research run lock failed (${safeCode})`);
    this.name = "ResearchRunLockError";
    this.code = safeCode;
  }
}

export type ResearchRunLockPhaseInternal =
  | "before-state-create"
  | "after-state-open"
  | "after-root-directory-sync"
  | "before-lock-open"
  | "after-lock-open"
  | "after-lock-write"
  | "after-lock-sync"
  | "after-state-publication-sync"
  | "before-release-verify"
  | "before-lock-unlink"
  | "after-lock-unlink"
  | "after-state-release-sync"
  | "before-descriptor-close";

export interface ResearchRunLockTestHooksDescriptorInternal {
  readonly now: () => Date;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly onCheck: ((phase: ResearchRunLockPhaseInternal) => void | Promise<void>) | null;
  readonly failAt: ResearchRunLockPhaseInternal | null;
}

export interface ResearchRunLockTestHooksInternal {
  readonly capabilityKind: "research-run-lock-test-hooks";
}

export interface ResearchRunLockRetentionObserverInternal {
  readonly capabilityKind: "research-run-lock-retention-observer";
}

interface RetentionObserverState {
  root: number;
  state: number;
  lock: number;
}

type RetainedDescriptor = keyof RetentionObserverState;

interface TestHookState {
  readonly now: () => Date;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly onCheck: ((phase: ResearchRunLockPhaseInternal) => void | Promise<void>) | null;
  failAt: ResearchRunLockPhaseInternal | null;
}

export interface ResearchRunLockInternal {
  readonly runId: OwnedRunRoot["runId"];
  readonly executionEpoch: number;
  readonly statePath: string;
  readonly ownerTokenSha256: string;
  syncStateDirectory(): Promise<void>;
  release(): Promise<void>;
  closePreservingLock(): Promise<void>;
}

interface LockRecord {
  readonly schemaVersion: 1;
  readonly runId: OwnedRunRoot["runId"];
  readonly executionEpoch: number;
  readonly ownerTokenSha256: string;
  readonly acquiredAt: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly stateDevice: string;
  readonly stateInode: string;
}

type LockLifecycle =
  | "active"
  | "unlinked"
  | "release-closing"
  | "closing-preserving"
  | "released"
  | "closed-preserving";
type LockChildStrategy = "linux-procfs" | "darwin-pathname";

interface InternalLockState {
  readonly root: OwnedRunRoot;
  readonly statePath: string;
  readonly lockPath: string;
  readonly rootFd: number;
  readonly stateFd: number;
  readonly lockFd: number;
  readonly rootInitial: Stats;
  readonly stateInitial: Stats;
  readonly lockInitial: Stats;
  readonly record: LockRecord;
  readonly recordBytes: Buffer;
  readonly ownerToken: Buffer;
  readonly hooks: TestHookState | null;
  readonly retentionObserver: RetentionObserverState | null;
  readonly childStrategy: LockChildStrategy;
  lifecycle: LockLifecycle;
  closePromise: Promise<void> | null;
  releasePromise: Promise<void> | null;
  releaseInProgress: boolean;
  closeInProgress: boolean;
  rootClosed: boolean;
  stateClosed: boolean;
  lockClosed: boolean;
}

export function createResearchRunLockRetentionObserverInternal(): ResearchRunLockRetentionObserverInternal {
  const observer = Object.freeze({ capabilityKind: "research-run-lock-retention-observer" as const });
  retentionObserverState.set(observer, { root: 0, state: 0, lock: 0 });
  return observer;
}

export function getResearchRunLockRetentionCountsInternal(
  observer: ResearchRunLockRetentionObserverInternal,
): Readonly<{ descriptors: number }> {
  const state = authenticateRetentionObserver(observer);
  if (state === null) fail("lock.invalid-input");
  return Object.freeze({ descriptors: state.root + state.state + state.lock });
}

export function createResearchRunLockTestHooksInternal(
  descriptor: ResearchRunLockTestHooksDescriptorInternal,
): ResearchRunLockTestHooksInternal {
  const values = exactDataDescriptors(descriptor, ["now", "randomBytes", "onCheck", "failAt"]);
  if (
    typeof values.now !== "function" ||
    typeof values.randomBytes !== "function" ||
    (values.onCheck !== null && typeof values.onCheck !== "function") ||
    (values.failAt !== null && !isLockPhase(values.failAt))
  ) fail("lock.invalid-input");
  const capability = Object.freeze({ capabilityKind: "research-run-lock-test-hooks" as const });
  hooksState.set(capability, {
    now: values.now as () => Date,
    randomBytes: values.randomBytes as (size: number) => Uint8Array,
    onCheck: values.onCheck as TestHookState["onCheck"],
    failAt: values.failAt as ResearchRunLockPhaseInternal | null,
  });
  return capability;
}

export async function acquireResearchRunLockInternal(
  root: OwnedRunRoot,
  options: { readonly executionEpoch: number },
  testHooks?: ResearchRunLockTestHooksInternal,
  retentionObserver?: ResearchRunLockRetentionObserverInternal,
): Promise<ResearchRunLockInternal> {
  let rootFd: number | undefined;
  let stateFd: number | undefined;
  let lockFd: number | undefined;
  let retention: RetentionObserverState | null = null;
  try {
    const optionValues = exactDataDescriptors(options, ["executionEpoch"]);
    const executionEpoch = optionValues.executionEpoch;
    if (!Number.isSafeInteger(executionEpoch) || (executionEpoch as number) < 0) fail("lock.invalid-input");
    const hooks = authenticateHooks(testHooks);
    retention = authenticateRetentionObserver(retentionObserver);
    await verifyAuthenticRoot(root);

    // Node exposes no openat/unlinkat API. Linux uses verified procfs child
    // paths. Darwin uses pathname effects bracketed by pinned inode checks;
    // under the foundation threat model a same-user race remains possible.
    if (DIRECTORY === 0 || NO_FOLLOW === 0 || (process.platform !== "linux" && process.platform !== "darwin")) {
      fail("lock.io-failed");
    }
    rootFd = openDirectory(root.path);
    retainDescriptor(retention, "root");
    const rootInitial = nativeFstatSync(rootFd);
    assertRootPair(root, rootInitial);
    const childStrategy = selectLockChildStrategy(rootFd);

    const statePath = join(root.path, STATE_DIRECTORY);
    const stateEffectPath = stateChildPath(childStrategy, rootFd, statePath);
    const existing = lstatIfExists(statePath);
    if (existing === null) {
      await invokePhase(hooks, "before-state-create");
      await verifyAuthenticRoot(root);
      verifyRootDescriptor(root, rootFd, rootInitial);
      try {
        nativeMkdirSync(stateEffectPath, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const publishedState = safeLstat(statePath);
      assertSafeState(rootInitial, publishedState, publishedState);
      verifyRootDescriptor(root, rootFd, rootInitial);
    } else {
      assertSafeState(rootInitial, existing, existing);
    }

    stateFd = openDirectory(stateEffectPath);
    retainDescriptor(retention, "state");
    const stateInitial = nativeFstatSync(stateFd);
    assertSafeState(rootInitial, stateInitial, safeLstat(statePath));
    await invokePhase(hooks, "after-state-open");
    await verifyAuthenticRoot(root);
    verifyRootAndState(root, rootFd, rootInitial, stateFd, stateInitial, statePath);

    // A peer can observe or win an EEXIST race before the mkdir winner has
    // synced this parent entry. Every acquisition therefore makes the pinned
    // run-root durable before attempting lock publication.
    nativeFsyncSync(rootFd);
    await invokePhase(hooks, "after-root-directory-sync");
    await verifyAuthenticRoot(root);
    verifyRootAndState(root, rootFd, rootInitial, stateFd, stateInitial, statePath);

    const token = generateOwnerToken(hooks);
    const ownerTokenSha256 = sha256Hex(token);
    const acquiredAt = currentTimestamp(hooks);
    const record: LockRecord = Object.freeze({
      schemaVersion: 1,
      runId: root.runId,
      executionEpoch: executionEpoch as number,
      ownerTokenSha256,
      acquiredAt,
      rootDevice: String(rootInitial.dev),
      rootInode: String(rootInitial.ino),
      stateDevice: String(stateInitial.dev),
      stateInode: String(stateInitial.ino),
    });
    const recordBytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (recordBytes.byteLength === 0 || recordBytes.byteLength > MAX_LOCK_RECORD_BYTES) fail("lock.io-failed");

    await invokePhase(hooks, "before-lock-open");
    await verifyAuthenticRoot(root);
    verifyRootAndState(root, rootFd, rootInitial, stateFd, stateInitial, statePath);
    const lockPath = join(statePath, LOCK_FILE);
    assertNoUnsafeExistingLock(lockPath);
    try {
      lockFd = nativeOpenSync(lockChildPath(childStrategy, stateFd, lockPath), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, 0o600);
    } catch (error) {
      if (isNodeError(error, "ELOOP")) fail("lock.symlink");
      if (isNodeError(error, "EEXIST")) {
        assertNoUnsafeExistingLock(lockPath);
        fail("lock.conflict");
      }
      throw error;
    }
    retainDescriptor(retention, "lock");
    const lockInitial = nativeFstatSync(lockFd);
    assertSafeLock(rootInitial, lockInitial, safeLstat(lockPath));
    verifyRootAndState(root, rootFd, rootInitial, stateFd, stateInitial, statePath);
    await invokePhase(hooks, "after-lock-open");
    await verifyAuthenticRoot(root);
    verifyPublicationPair(root, rootFd, rootInitial, stateFd, stateInitial, statePath, lockFd, lockInitial, lockPath);

    writeFully(lockFd, recordBytes);
    const lockPublished = nativeFstatSync(lockFd);
    assertSafeLock(rootInitial, lockPublished, safeLstat(lockPath));
    if (lockPublished.size !== recordBytes.byteLength || !sameInode(lockPublished, lockInitial)) fail("lock.replaced");
    await invokePhase(hooks, "after-lock-write");
    await verifyAuthenticRoot(root);
    verifyLockPair(childStrategy, stateFd, stateInitial, statePath, lockFd, lockPublished, lockPath, recordBytes);
    nativeFsyncSync(lockFd);
    await invokePhase(hooks, "after-lock-sync");
    await verifyAuthenticRoot(root);
    verifyPublicationPair(root, rootFd, rootInitial, stateFd, stateInitial, statePath, lockFd, lockPublished, lockPath);
    verifyLockPair(childStrategy, stateFd, stateInitial, statePath, lockFd, lockPublished, lockPath, recordBytes);
    nativeFsyncSync(stateFd);
    await invokePhase(hooks, "after-state-publication-sync");
    await verifyAuthenticRoot(root);
    verifyPublicationPair(root, rootFd, rootInitial, stateFd, stateInitial, statePath, lockFd, lockPublished, lockPath);
    verifyLockPair(childStrategy, stateFd, stateInitial, statePath, lockFd, lockPublished, lockPath, recordBytes);

    const state: InternalLockState = {
      root,
      statePath,
      lockPath,
      rootFd,
      stateFd,
      lockFd,
      rootInitial,
      stateInitial,
      lockInitial: lockPublished,
      record,
      recordBytes,
      ownerToken: token,
      hooks,
      retentionObserver: retention,
      childStrategy,
      lifecycle: "active",
      closePromise: null,
      releasePromise: null,
      releaseInProgress: false,
      closeInProgress: false,
      rootClosed: false,
      stateClosed: false,
      lockClosed: false,
    };
    rootFd = undefined;
    stateFd = undefined;
    lockFd = undefined;

    const lock: ResearchRunLockInternal = Object.freeze({
      runId: root.runId,
      executionEpoch: record.executionEpoch,
      statePath,
      ownerTokenSha256,
      async syncStateDirectory() {
        try {
          const current = requireLockState(lock);
          assertDirectorySyncOwnership(current);
          await verifyAuthenticRoot(current.root);
          // No await may separate this ownership check from descriptor I/O.
          assertDirectorySyncOwnership(current);
          verifyRootAndState(current.root, current.rootFd, current.rootInitial, current.stateFd, current.stateInitial, current.statePath);
          nativeFsyncSync(current.stateFd);
          verifyRootAndState(current.root, current.rootFd, current.rootInitial, current.stateFd, current.stateInitial, current.statePath);
        } catch (error) {
          throw wrap(error);
        }
      },
      async release() {
        return releaseLock(lock);
      },
      async closePreservingLock() {
        return closePreserving(lock);
      },
    });
    lockState.set(lock, state);
    return lock;
  } catch (error) {
    closeFailedAcquisitionDescriptors(retention, { lock: lockFd, state: stateFd, root: rootFd });
    throw wrap(error);
  }
}

async function releaseLock(lock: ResearchRunLockInternal): Promise<void> {
  const state = requireLockState(lock);
  if (state.lifecycle === "released") return;
  if (state.lifecycle === "closed-preserving" || state.lifecycle === "closing-preserving") fail("lock.closed");
  if (state.releasePromise) return state.releasePromise;
  if (state.releaseInProgress) fail("lock.closed");
  state.releaseInProgress = true;
  const attempt = (async () => {
    try {
      if (state.lifecycle === "release-closing") {
        await closeStateDescriptors(state);
        if (!allDescriptorsClosed(state)) fail("lock.io-failed");
        state.lifecycle = "released";
        return;
      }
      await invokePhase(state.hooks, "before-release-verify");
      await verifyAuthenticRoot(state.root);
      verifyReleaseOwnership(state);
      if (state.lifecycle === "active") {
        await invokePhase(state.hooks, "before-lock-unlink");
        await verifyAuthenticRoot(state.root);
        verifyReleaseOwnership(state);
        nativeUnlinkSync(lockChildPath(state.childStrategy, state.stateFd, state.lockPath));
        state.lifecycle = "unlinked";
        verifyUnlinkedOwnership(state);
        await invokePhase(state.hooks, "after-lock-unlink");
        await verifyAuthenticRoot(state.root);
      }
      verifyUnlinkedOwnership(state);
      nativeFsyncSync(state.stateFd);
      await invokePhase(state.hooks, "after-state-release-sync");
      await verifyAuthenticRoot(state.root);
      verifyUnlinkedOwnership(state);
      state.lifecycle = "release-closing";
      await invokePhase(state.hooks, "before-descriptor-close");
      await closeStateDescriptors(state);
      if (!allDescriptorsClosed(state)) fail("lock.io-failed");
      state.lifecycle = "released";
    } catch (error) {
      throw wrap(error);
    }
  })();
  state.releasePromise = attempt;
  try {
    await attempt;
  } finally {
    state.releaseInProgress = false;
    if (state.releasePromise === attempt) state.releasePromise = null;
  }
}

async function closePreserving(lock: ResearchRunLockInternal): Promise<void> {
  const state = requireLockState(lock);
  if (state.lifecycle === "released" || state.lifecycle === "closed-preserving") return;
  if (state.lifecycle === "release-closing" || state.releaseInProgress) fail("lock.closed");
  if (state.closePromise) return state.closePromise;
  if (state.closeInProgress) fail("lock.closed");
  state.closeInProgress = true;
  state.lifecycle = "closing-preserving";
  const attempt = (async () => {
    let failure: unknown;
    try { await invokePhase(state.hooks, "before-descriptor-close"); } catch (error) { failure = error; }
    try { closeOne(state, "lock"); } catch (error) { failure ??= error; }
    try { closeOne(state, "state"); } catch (error) { failure ??= error; }
    try { closeOne(state, "root"); } catch (error) { failure ??= error; }
    if (allDescriptorsClosed(state)) state.lifecycle = "closed-preserving";
    if (failure) throw wrap(failure);
    if (state.lifecycle !== "closed-preserving") fail("lock.io-failed");
  })();
  state.closePromise = attempt;
  try {
    await attempt;
  } finally {
    state.closeInProgress = false;
    if (state.closePromise === attempt) state.closePromise = null;
  }
}

function assertDirectorySyncOwnership(state: InternalLockState): void {
  if (
    state.lifecycle !== "active" ||
    state.releaseInProgress || state.releasePromise !== null ||
    state.closeInProgress || state.closePromise !== null
  ) fail("lock.closed");
}

function allDescriptorsClosed(state: InternalLockState): boolean {
  return state.lockClosed && state.stateClosed && state.rootClosed;
}

async function closeStateDescriptors(state: InternalLockState): Promise<void> {
  let failure: unknown;
  try { closeOne(state, "lock"); } catch (error) { failure = error; }
  try { closeOne(state, "state"); } catch (error) { failure ??= error; }
  try { closeOne(state, "root"); } catch (error) { failure ??= error; }
  if (failure) throw failure;
}

function closeOne(state: InternalLockState, which: "lock" | "state" | "root"): void {
  const closedKey = `${which}Closed` as "lockClosed" | "stateClosed" | "rootClosed";
  if (state[closedKey]) return;
  const fd = which === "lock" ? state.lockFd : which === "state" ? state.stateFd : state.rootFd;
  // POSIX leaves the numeric descriptor unusable by the caller after close,
  // including when close reports an error; retry could close a reused fd.
  state[closedKey] = true;
  releaseRetainedDescriptor(state.retentionObserver, which);
  nativeCloseSync(fd);
}

function verifyReleaseOwnership(state: InternalLockState): void {
  if (state.lifecycle === "unlinked") return verifyUnlinkedOwnership(state);
  verifyRootAndState(state.root, state.rootFd, state.rootInitial, state.stateFd, state.stateInitial, state.statePath);
  verifyLockPair(
    state.childStrategy,
    state.stateFd,
    state.stateInitial,
    state.statePath,
    state.lockFd,
    state.lockInitial,
    state.lockPath,
    state.recordBytes,
  );
  const parsed = parseLockRecord(readExact(state.lockFd, state.recordBytes.byteLength));
  if (!sameRecord(parsed, state.record) || !safeHashEqual(parsed.ownerTokenSha256, sha256Hex(state.ownerToken))) {
    fail("lock.owner-mismatch");
  }
}

function verifyUnlinkedOwnership(state: InternalLockState): void {
  verifyRootAndState(state.root, state.rootFd, state.rootInitial, state.stateFd, state.stateInitial, state.statePath);
  const descriptor = nativeFstatSync(state.lockFd);
  if (!descriptor.isFile() || descriptor.nlink !== 0 || !sameInode(descriptor, state.lockInitial)) fail("lock.owner-mismatch");
  if (lstatIfExists(state.lockPath) !== null) fail("lock.replaced");
  const parsed = parseLockRecord(readExact(state.lockFd, state.recordBytes.byteLength));
  if (!sameRecord(parsed, state.record) || !safeHashEqual(parsed.ownerTokenSha256, sha256Hex(state.ownerToken))) {
    fail("lock.owner-mismatch");
  }
}

function verifyPublicationPair(
  root: OwnedRunRoot,
  rootFd: number,
  rootInitial: Stats,
  stateFd: number,
  stateInitial: Stats,
  statePath: string,
  lockFd: number,
  lockInitial: Stats,
  lockPath: string,
): void {
  verifyRootAndState(root, rootFd, rootInitial, stateFd, stateInitial, statePath);
  assertSafeLock(rootInitial, nativeFstatSync(lockFd), safeLstat(lockPath));
  if (!sameStableFile(nativeFstatSync(lockFd), lockInitial)) fail("lock.replaced");
}

function verifyLockPair(
  childStrategy: LockChildStrategy,
  stateFd: number,
  stateExpected: Stats,
  statePath: string,
  lockFd: number,
  expected: Stats,
  lockPath: string,
  expectedBytes: Buffer,
): void {
  verifyPinnedStatePath(stateFd, stateExpected, statePath);
  const descriptor = nativeFstatSync(lockFd);
  const pathname = safeLstat(lockPath);
  assertSafeLock(expected, descriptor, pathname);
  if (!sameFileIdentityAndPolicy(descriptor, expected) || descriptor.size !== expectedBytes.byteLength) fail("lock.replaced");
  const actual = readExact(lockFd, MAX_LOCK_RECORD_BYTES);
  if (actual.byteLength !== expectedBytes.byteLength || !actual.equals(expectedBytes)) fail("lock.owner-mismatch");
  let reopened: number | undefined;
  try {
    reopened = nativeOpenSync(lockChildPath(childStrategy, stateFd, lockPath), constants.O_RDONLY | NO_FOLLOW);
    const reopenedStat = nativeFstatSync(reopened);
    if (!sameStableFile(reopenedStat, descriptor)) fail("lock.replaced");
    const reopenedBytes = readExact(reopened, MAX_LOCK_RECORD_BYTES);
    if (!reopenedBytes.equals(expectedBytes)) fail("lock.owner-mismatch");
    const finalDescriptor = nativeFstatSync(lockFd);
    const finalPathname = safeLstat(lockPath);
    assertSafeLock(expected, finalDescriptor, finalPathname);
    if (!sameStableFile(finalDescriptor, descriptor) || !sameStableFile(finalPathname, reopenedStat)) {
      fail("lock.replaced");
    }
    verifyPinnedStatePath(stateFd, stateExpected, statePath);
  } finally {
    if (reopened !== undefined) closeCleanupDescriptor(reopened);
  }
}

function verifyRootAndState(
  root: OwnedRunRoot,
  rootFd: number,
  rootInitial: Stats,
  stateFd: number,
  stateInitial: Stats,
  statePath: string,
): void {
  verifyRootDescriptor(root, rootFd, rootInitial);
  verifyPinnedStatePath(stateFd, stateInitial, statePath);
}

function verifyPinnedStatePath(stateFd: number, stateExpected: Stats, statePath: string): void {
  const stateDescriptor = nativeFstatSync(stateFd);
  const statePathStat = safeLstat(statePath);
  assertSafeState(stateExpected, stateDescriptor, statePathStat);
  if (!sameDirectory(stateDescriptor, stateExpected) || !sameDirectory(statePathStat, stateExpected)) {
    fail("lock.replaced");
  }
}

function verifyRootDescriptor(root: OwnedRunRoot, rootFd: number, initial: Stats): void {
  const descriptor = nativeFstatSync(rootFd);
  assertRootPair(root, descriptor);
  if (!sameDirectory(descriptor, initial)) fail("lock.replaced");
}

function assertRootPair(root: OwnedRunRoot, descriptor: Stats): void {
  const pathname = safeLstat(root.path);
  if (
    !descriptor.isDirectory() || pathname.isSymbolicLink() || !pathname.isDirectory() ||
    !sameInode(descriptor, pathname) || Number(descriptor.dev) !== root.dev || Number(descriptor.ino) !== root.ino
  ) fail("lock.replaced");
}

function assertSafeState(root: Stats, descriptor: Stats, pathname: Stats): void {
  if (pathname.isSymbolicLink()) fail("lock.symlink");
  if (!descriptor.isDirectory() || !pathname.isDirectory()) fail("lock.state-invalid");
  if (!sameInode(descriptor, pathname)) fail("lock.replaced");
  if ((descriptor.mode & 0o777) !== 0o700 || (pathname.mode & 0o777) !== 0o700) fail("lock.state-invalid");
  if (descriptor.uid !== root.uid || pathname.uid !== root.uid || !ownedByEffectiveUser(descriptor)) fail("lock.state-invalid");
}

function assertSafeLock(owner: Stats, descriptor: Stats, pathname: Stats): void {
  if (pathname.isSymbolicLink()) fail("lock.symlink");
  if (!descriptor.isFile() || !pathname.isFile()) fail("lock.replaced");
  if (descriptor.nlink !== 1 || pathname.nlink !== 1) fail("lock.unsafe-link");
  if (!sameInode(descriptor, pathname)) fail("lock.replaced");
  if ((descriptor.mode & 0o777) !== 0o600 || (pathname.mode & 0o777) !== 0o600) fail("lock.replaced");
  if (descriptor.uid !== owner.uid || pathname.uid !== owner.uid || !ownedByEffectiveUser(descriptor)) fail("lock.owner-mismatch");
}

function ownedByEffectiveUser(info: Stats): boolean {
  const getuid = process.getuid;
  return typeof getuid !== "function" || info.uid === getuid.call(process);
}

function assertNoUnsafeExistingLock(path: string): void {
  const existing = lstatIfExists(path);
  if (existing === null) return;
  if (existing.isSymbolicLink()) fail("lock.symlink");
  if (!existing.isFile()) fail("lock.conflict");
  if (existing.nlink !== 1) fail("lock.unsafe-link");
  fail("lock.conflict");
}

function openDirectory(path: string): number {
  try {
    return nativeOpenSync(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("lock.symlink");
    throw error;
  }
}

function selectLockChildStrategy(rootFd: number): LockChildStrategy {
  if (process.platform === "darwin") return "darwin-pathname";
  let markerFd: number | undefined;
  try {
    markerFd = nativeOpenSync(`/proc/self/fd/${rootFd}/${RUN_ROOT_OWNER_FILE}`, constants.O_RDONLY | NO_FOLLOW);
    if (!nativeFstatSync(markerFd).isFile()) fail("lock.io-failed");
    return "linux-procfs";
  } finally {
    if (markerFd !== undefined) closeCleanupDescriptor(markerFd);
  }
}

/** Darwin fallback retains pinned before/after checks but not kernel race-freedom. */
function stateChildPath(strategy: LockChildStrategy, rootFd: number, pathname: string): string {
  return strategy === "linux-procfs" ? `/proc/self/fd/${rootFd}/${STATE_DIRECTORY}` : pathname;
}

function lockChildPath(strategy: LockChildStrategy, parentFd: number, pathname: string): string {
  return strategy === "linux-procfs" ? `/proc/self/fd/${parentFd}/${LOCK_FILE}` : pathname;
}

function writeFully(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = nativeWriteSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (written <= 0) fail("lock.io-failed");
    offset += written;
  }
}

function readExact(fd: number, maximum: number): Buffer {
  const stat = nativeFstatSync(fd);
  if (stat.size < 1 || stat.size > maximum) fail("lock.owner-mismatch");
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = nativeReadSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (count <= 0) fail("lock.owner-mismatch");
    offset += count;
  }
  return bytes;
}

function parseLockRecord(bytes: Buffer): LockRecord {
  let value: unknown;
  try {
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) fail("lock.owner-mismatch");
    value = JSON.parse(text);
    const fields = [
      "schemaVersion", "runId", "executionEpoch", "ownerTokenSha256", "acquiredAt",
      "rootDevice", "rootInode", "stateDevice", "stateInode",
    ];
    const descriptors = exactDataDescriptors(value, fields, "lock.owner-mismatch");
    if (
      descriptors.schemaVersion !== 1 ||
      typeof descriptors.runId !== "string" ||
      !Number.isSafeInteger(descriptors.executionEpoch) || (descriptors.executionEpoch as number) < 0 ||
      !isSha256(descriptors.ownerTokenSha256) || !isTimestamp(descriptors.acquiredAt) ||
      !canonicalIntegerString(descriptors.rootDevice) || !canonicalIntegerString(descriptors.rootInode) ||
      !canonicalIntegerString(descriptors.stateDevice) || !canonicalIntegerString(descriptors.stateInode)
    ) fail("lock.owner-mismatch");
    const record = value as LockRecord;
    if (`${canonicalJson(record)}\n` !== text) fail("lock.owner-mismatch");
    return record;
  } catch (error) {
    if (isAuthenticLockError(error)) throw error;
    fail("lock.owner-mismatch");
  }
}

function sameRecord(left: LockRecord, right: LockRecord): boolean {
  return left.schemaVersion === right.schemaVersion && left.runId === right.runId &&
    left.executionEpoch === right.executionEpoch && left.ownerTokenSha256 === right.ownerTokenSha256 &&
    left.acquiredAt === right.acquiredAt && left.rootDevice === right.rootDevice &&
    left.rootInode === right.rootInode && left.stateDevice === right.stateDevice && left.stateInode === right.stateInode;
}

function currentTimestamp(hooks: TestHookState | null): string {
  try {
    const value = (hooks?.now ?? (() => new Date()))();
    if (utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Date.prototype) fail("lock.invalid-input");
    let time: number;
    try { time = Date.prototype.getTime.call(value); } catch { fail("lock.invalid-input"); }
    if (!Number.isFinite(time)) fail("lock.invalid-input");
    const timestamp = Date.prototype.toISOString.call(value);
    if (!isTimestamp(timestamp)) fail("lock.invalid-input");
    return timestamp;
  } catch (error) {
    if (isAuthenticLockError(error)) throw error;
    fail("lock.io-failed");
  }
}

function generateOwnerToken(hooks: TestHookState | null): Buffer {
  try {
    const value = (hooks?.randomBytes ?? nodeRandomBytes)(32);
    if (utilTypes.isProxy(value) || !(value instanceof Uint8Array) || value.byteLength !== 32) fail("lock.invalid-input");
    return Buffer.from(value);
  } catch (error) {
    if (isAuthenticLockError(error)) throw error;
    fail("lock.io-failed");
  }
}

async function invokePhase(hooks: TestHookState | null, phase: ResearchRunLockPhaseInternal): Promise<void> {
  if (!hooks) return;
  try {
    if (hooks.onCheck) await hooks.onCheck(phase);
    if (hooks.failAt === phase) {
      hooks.failAt = null;
      fail("lock.io-failed");
    }
  } catch (error) {
    if (isAuthenticLockError(error)) throw error;
    fail("lock.io-failed");
  }
}

function authenticateHooks(value: ResearchRunLockTestHooksInternal | undefined): TestHookState | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Object.isFrozen(value)) {
    fail("lock.invalid-input");
  }
  const state = hooksState.get(value);
  if (!state) fail("lock.invalid-input");
  return state;
}

function authenticateRetentionObserver(
  value: ResearchRunLockRetentionObserverInternal | undefined,
): RetentionObserverState | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Object.isFrozen(value)) {
    fail("lock.invalid-input");
  }
  const state = retentionObserverState.get(value);
  if (!state) fail("lock.invalid-input");
  return state;
}

function retainDescriptor(state: RetentionObserverState | null, descriptor: RetainedDescriptor): void {
  if (state !== null) state[descriptor] += 1;
}

function releaseRetainedDescriptor(state: RetentionObserverState | null, descriptor: RetainedDescriptor): void {
  if (state !== null && state[descriptor] > 0) state[descriptor] -= 1;
}

async function verifyAuthenticRoot(root: OwnedRunRoot): Promise<void> {
  try {
    await revalidateOwnedRunRoot(root);
  } catch (error) {
    if (error instanceof RunRootError) {
      if (error.code === "run-root.invalid-options") fail("lock.invalid-input");
      if (error.code === "run-root.closed") fail("lock.closed");
      fail("lock.replaced");
    }
    throw error;
  }
}

function exactDataDescriptors(
  value: unknown,
  fields: readonly string[],
  code: ResearchRunLockErrorCodeInternal = "lock.invalid-input",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail(code);
  const output: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    output[field] = descriptor.value;
  }
  return output;
}

function isLockPhase(value: unknown): value is ResearchRunLockPhaseInternal {
  return typeof value === "string" && [
    "before-state-create", "after-state-open", "after-root-directory-sync", "before-lock-open",
    "after-lock-open", "after-lock-write", "after-lock-sync", "after-state-publication-sync",
    "before-release-verify", "before-lock-unlink", "after-lock-unlink", "after-state-release-sync",
    "before-descriptor-close",
  ].includes(value);
}

function requireLockState(lock: ResearchRunLockInternal): InternalLockState {
  if (lock === null || typeof lock !== "object" || utilTypes.isProxy(lock) || !Object.isFrozen(lock)) fail("lock.invalid-input");
  const state = lockState.get(lock);
  if (!state) fail("lock.invalid-input");
  return state;
}

function lstatIfExists(path: string): Stats | null {
  try {
    return nativeLstatSync(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function safeLstat(path: string): Stats {
  try {
    return nativeLstatSync(path);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("lock.symlink");
    throw error;
  }
}

function sameInode(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return sameInode(left, right) && left.isDirectory() && right.isDirectory() &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

function sameFileIdentityAndPolicy(left: Stats, right: Stats): boolean {
  return sameInode(left, right) && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.nlink === right.nlink;
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return sameFileIdentityAndPolicy(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function canonicalIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function safeHashEqual(left: string, right: string): boolean {
  return isSha256(left) && isSha256(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function closeCleanupDescriptor(fd: number): void {
  // A reported close failure does not preserve ownership of the numeric fd.
  nativeCloseSync(fd);
}

function closeFailedAcquisitionDescriptors(
  retention: RetentionObserverState | null,
  descriptors: Readonly<Record<RetainedDescriptor, number | undefined>>,
): void {
  for (const descriptor of ["lock", "state", "root"] as const) {
    const fd = descriptors[descriptor];
    if (fd === undefined) continue;
    releaseRetainedDescriptor(retention, descriptor);
    try { closeCleanupDescriptor(fd); } catch { /* numeric descriptor already consumed */ }
  }
}

function wrap(error: unknown): ResearchRunLockError {
  if (isAuthenticLockError(error)) return error;
  if (isNodeError(error, "ELOOP")) return createLockError("lock.symlink");
  return createLockError("lock.io-failed");
}

function createLockError(code: ResearchRunLockErrorCodeInternal): ResearchRunLockError {
  const error = new ResearchRunLockError(code);
  Object.freeze(error);
  authenticLockErrors.add(error);
  return error;
}

function isAuthenticLockError(error: unknown): error is ResearchRunLockError {
  return error instanceof ResearchRunLockError && authenticLockErrors.has(error) && Object.isFrozen(error) &&
    isLockErrorCode(error.code) && error.name === "ResearchRunLockError" &&
    error.message === `Research run lock failed (${error.code})`;
}

function isLockErrorCode(value: unknown): value is ResearchRunLockErrorCodeInternal {
  return typeof value === "string" && [
    "lock.invalid-input", "lock.state-invalid", "lock.conflict", "lock.symlink", "lock.unsafe-link",
    "lock.replaced", "lock.owner-mismatch", "lock.closed", "lock.io-failed",
  ].includes(value);
}

function fail(code: ResearchRunLockErrorCodeInternal): never {
  throw createLockError(code);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
