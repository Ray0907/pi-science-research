import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename as nodeRename,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { ID_PATTERNS, isSha256, isTimestamp, type RunId } from "../domain/ids.js";

export const RUN_ROOT_OWNER_FILE = ".pi-science-research-owner.json";
const MAX_MARKER_BYTES = 4096;
const MAX_PATH_BYTES = 4096;
const MAX_COMPONENT_BYTES = 255;
const MAX_TOPIC_BYTES = 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const projectQueues = new Map<string, Promise<void>>();
const openRootInodes = new Set<string>();
const ownedRootObjects = new WeakSet<object>();

export type RunRootDurabilityStep =
  | "research-temp-directory-synced"
  | "research-parent-synced"
  | "leaf-temp-directory-synced"
  | "marker-synced"
  | "leaf-marker-directory-synced"
  | "leaf-parent-synced";

export interface CreateOwnedRunRootOptions {
  trustedProject: string;
  repositoryRoot?: string;
  topic: string;
  runId: RunId;
  ownershipToken?: string;
  requestedPath?: string;
  allowAbsoluteRequestedPath?: boolean;
  approveOutside?: (canonicalPath: string) => boolean | Promise<boolean>;
  approvedOutsideRoots?: readonly string[];
  forbiddenRoots?: readonly string[];
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  durability?: (handle: FileHandle, step: RunRootDurabilityStep) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  onCheck?: (phase: string) => void | Promise<void>;
}

export interface RunRootVerificationOptions {
  onCheck?: (phase: string) => void | Promise<void>;
}

export interface ContainedWriteOptions {
  onCheck?: (phase: string) => void | Promise<void>;
}

export interface ContainedWriteOpenOptions {
  onCheck?: (phase: string) => void | Promise<void>;
}

export interface ContainedWriteAuthorization {
  readonly relativePath: string;
  readonly existingParentPath: string;
  readonly remainingPath: string;
  /** Pinned owned-root descriptor for native openat2-style integrations; valid while the root is open. */
  readonly rootFd: number;
  /** Pinned nearest-parent descriptor for native integrations; valid until close(). */
  readonly parentFd: number;
  readonly openFlags: number;
  /**
   * Revalidates the authorization, then fails closed because Node 24 exposes
   * no relocation-safe openat2 equivalent. It performs no filesystem write.
   */
  openExclusive(mode?: number, options?: ContainedWriteOpenOptions): Promise<FileHandle>;
  close(): Promise<void>;
}

export interface OwnedRunRoot {
  readonly path: string;
  readonly runId: RunId;
  readonly ownershipToken: string;
  readonly dev: number;
  readonly ino: number;
  readonly markerSha256: string;
  close(): Promise<void>;
}

interface InternalOwnedRunRoot extends OwnedRunRoot {
  readonly rootHandle: FileHandle;
  readonly inodeKey: string;
  readonly markerDev: number;
  readonly markerIno: number;
  closed: boolean;
}

interface OwnerMarker {
  schemaVersion: 1;
  runId: RunId;
  createdAt: string;
  ownershipTokenSha256: string;
  rootDevice: string;
  rootInode: string;
}

interface OwnerMarkerSeed {
  runId: RunId;
  createdAt: string;
  ownershipTokenSha256: string;
}

export type RunRootErrorCode =
  | "run-root.invalid-options"
  | "run-root.invalid-path"
  | "run-root.path-too-long"
  | "run-root.symlink"
  | "run-root.unsafe-link"
  | "run-root.unsafe-root"
  | "run-root.outside-denied"
  | "run-root.conflict"
  | "run-root.owner-mismatch"
  | "run-root.marker-invalid"
  | "run-root.replaced"
  | "run-root.outside-root"
  | "run-root.not-file"
  | "run-root.closed"
  | "run-root.already-open"
  | "run-root.io-failed";

export class RunRootError extends Error {
  readonly code: RunRootErrorCode;

  constructor(code: RunRootErrorCode) {
    super(`Research run-root operation failed (${code})`);
    this.name = "RunRootError";
    this.code = code;
  }
}

export async function createOwnedRunRoot(
  options: CreateOwnedRunRootOptions,
): Promise<OwnedRunRoot> {
  try {
    assertClosedOptions(options);
    const trustedProject = await canonicalExistingDirectory(options.trustedProject);
    const projectStat = await safeStat(trustedProject);
    const queueKey = inodeKey(projectStat);
    return await withProjectQueue(queueKey, async () => createOwnedRunRootLocked(options, trustedProject, projectStat));
  } catch (error) {
    throw wrap(error);
  }
}

async function createOwnedRunRootLocked(
  options: CreateOwnedRunRootOptions,
  trustedProject: string,
  projectStat: Awaited<ReturnType<typeof stat>>,
): Promise<OwnedRunRoot> {
  validateCreateScalars(options);
  const repositoryRoot = await canonicalExistingDirectory(options.repositoryRoot ?? trustedProject);
  const token = options.ownershipToken ?? Buffer.from((options.randomBytes ?? nodeRandomBytes)(32)).toString("hex");
  if (!TOKEN_PATTERN.test(token)) fail("run-root.invalid-options");
  const now = (options.now ?? (() => new Date()))();
  const createdAt = now.toISOString();
  if (!isTimestamp(createdAt)) fail("run-root.invalid-options");

  const requested = options.requestedPath;
  let target: string;
  let collision = false;
  if (requested === undefined) {
    const researchParent = join(trustedProject, "research");
    await ensurePreparedResearchDirectory(researchParent, trustedProject, projectStat, options);
    target = join(researchParent, `${createdAt.slice(0, 10)}-${sanitizeTopicSlug(options.topic)}`);
    collision = true;
  } else {
    assertPortableRequestedPath(requested);
    if (isAbsolute(requested) && options.allowAbsoluteRequestedPath !== true) fail("run-root.invalid-path");
    target = await canonicalCandidate(isAbsolute(requested) ? requested : join(trustedProject, requested));
  }

  assertPathBounds(target);
  await assertNoSymlinkSegments(target);
  await assertForbiddenRoot(target, trustedProject, repositoryRoot, options);
  await authorizeLocation(target, trustedProject, options);
  await assertPinnedDirectory(trustedProject, projectStat);
  await options.onCheck?.("before-create");
  await assertPinnedDirectory(trustedProject, projectStat);
  await assertNoSymlinkSegments(target);

  const parent = await canonicalExistingDirectory(dirname(target));
  if (parent !== dirname(target)) fail("run-root.replaced");
  const ancestorPins = await pinExistingAncestors(parent);
  const markerSeed: OwnerMarkerSeed = {
    runId: options.runId,
    createdAt,
    ownershipTokenSha256: sha256Hex(token),
  };
  const published = await prepareAndPublishLeaf(target, collision, markerSeed, ancestorPins, options);
  try {
    return registerOwnedRoot(
      published.path,
      options.runId,
      token,
      published.handle,
      published.rootStat,
      published.markerStat,
      published.markerSha256,
    );
  } catch (error) {
    await published.handle.close().catch(() => undefined);
    throw wrap(error);
  }
}

export async function openOwnedRunRoot(
  path: string,
  runId: RunId,
  ownershipToken: string,
  options: RunRootVerificationOptions = {},
): Promise<OwnedRunRoot> {
  assertSimpleOptions(options, new Set(["onCheck"]));
  if (!ID_PATTERNS.run.test(runId) || !TOKEN_PATTERN.test(ownershipToken)) fail("run-root.owner-mismatch");
  assertPathBounds(path);
  await assertNoSymlinkSegments(resolve(path));
  const canonical = await canonicalExistingDirectory(path);
  await assertNoSymlinkSegments(canonical);
  await assertIntrinsicUnsafeRoot(canonical);
  await assertGlobalForbiddenRoot(canonical, []);
  let rootHandle: FileHandle | undefined = await openDirectoryNoFollow(canonical);
  try {
    const rootStat = await rootHandle.stat();
    const pathStat = await safeLstat(canonical);
    if (!rootStat.isDirectory() || !sameInode(rootStat, pathStat)) fail("run-root.replaced");
    const markerRead = await readOwnerMarker(canonical, options.onCheck);
    assertOwner(markerRead.marker, runId, ownershipToken);
    assertMarkerRootBinding(markerRead.marker, rootStat, "run-root.owner-mismatch");
    await invokeCheck(options.onCheck, "after-open-owner-marker-read-before-final-root-check");
    await rootHandle.close();
    rootHandle = undefined;
    const verified = await verifyOpenedRootPath(
      canonical,
      rootStat,
      markerRead,
      runId,
      ownershipToken,
    );
    try {
      return registerOwnedRoot(
        canonical,
        runId,
        ownershipToken,
        verified.handle,
        verified.rootStat,
        verified.markerStat,
        verified.markerSha256,
      );
    } catch (error) {
      await verified.handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await rootHandle?.close().catch(() => undefined);
    throw wrap(error);
  }
}

export async function assertContainedWrite(
  root: OwnedRunRoot,
  target: string,
  options: ContainedWriteOptions = {},
): Promise<ContainedWriteAuthorization> {
  try {
    return await assertContainedWriteInternal(root, target, options);
  } catch (error) {
    throw wrap(error);
  }
}

async function assertContainedWriteInternal(
  root: OwnedRunRoot,
  target: string,
  options: ContainedWriteOptions,
): Promise<ContainedWriteAuthorization> {
  assertSimpleOptions(options, new Set(["onCheck"]));
  const internal = asInternal(root);
  await revalidateOwnedRunRoot(internal);
  assertPathBounds(target);
  const absolute = resolve(target);
  const rel = relative(internal.path, absolute);
  if (rel === "" || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(rel.startsWith("..") || isAbsolute(rel) ? "run-root.outside-root" : "run-root.invalid-path");
  }
  assertPortableRelative(rel);
  const first = await inspectContainedPath(internal.path, rel);
  await options.onCheck?.("before-authorize");
  await revalidateOwnedRunRoot(internal);
  const second = await inspectContainedPath(internal.path, rel);
  if (first.existingParentPath !== second.existingParentPath || !sameInode(first.parentStat, second.parentStat)) {
    fail("run-root.replaced");
  }
  const parentHandle = await openDirectoryNoFollow(second.existingParentPath);
  try {
    const handleStat = await parentHandle.stat();
    if (!sameInode(handleStat, second.parentStat)) fail("run-root.replaced");
    let closed = false;
    const openFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
    return {
      relativePath: rel.split(sep).join("/"),
      existingParentPath: second.existingParentPath,
      remainingPath: second.remainingPath.split(sep).join("/"),
      rootFd: internal.rootHandle.fd,
      parentFd: parentHandle.fd,
      openFlags,
      async openExclusive(mode = 0o600, openOptions: ContainedWriteOpenOptions = {}) {
        try {
          assertSimpleOptions(openOptions, new Set(["onCheck"]));
          if (closed) fail("run-root.closed");
          if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) fail("run-root.invalid-options");
          await revalidateOwnedRunRoot(internal);
          const current = await inspectContainedPath(internal.path, rel);
          const pinned = await parentHandle.stat();
          if (
            current.existingParentPath !== second.existingParentPath ||
            current.remainingPath !== second.remainingPath ||
            !sameInode(current.parentStat, second.parentStat) ||
            !sameInode(pinned, second.parentStat) ||
            current.remainingPath.includes(sep)
          ) fail("run-root.replaced");
          await openOptions.onCheck?.("after-final-check-before-open");
          await revalidateOwnedRunRoot(internal);
          const afterHook = await inspectContainedPath(internal.path, rel);
          const parentAfterHook = await safeLstat(second.existingParentPath);
          if (
            afterHook.existingParentPath !== second.existingParentPath ||
            afterHook.remainingPath !== second.remainingPath ||
            !sameInode(afterHook.parentStat, second.parentStat) ||
            !sameInode(parentAfterHook, pinned)
          ) fail("run-root.replaced");
          // Node exposes a directory descriptor but not openat2(RESOLVE_BENEATH)
          // or an equivalent primitive that also prevents relocation of that
          // directory during creation. Authorization is therefore pure: callers
          // may pass parentFd/remainingPath to a native safe primitive, while
          // this JavaScript helper refuses to mutate on every supported OS.
          fail("run-root.io-failed");
        } catch (error) {
          throw wrap(error);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await parentHandle.close();
      },
    };
  } catch (error) {
    await parentHandle.close().catch(() => undefined);
    throw wrap(error);
  }
}

export async function revalidateOwnedRunRoot(
  root: OwnedRunRoot,
  options: RunRootVerificationOptions = {},
): Promise<void> {
  assertSimpleOptions(options, new Set(["onCheck"]));
  const internal = asInternal(root);
  if (internal.closed) fail("run-root.closed");
  const handleStat = await internal.rootHandle.stat().catch(() => fail("run-root.replaced"));
  const pathStat = await safeLstat(internal.path);
  if (!handleStat.isDirectory() || pathStat.isSymbolicLink() || !sameInode(handleStat, pathStat)) {
    fail("run-root.replaced");
  }
  if (Number(handleStat.dev) !== internal.dev || Number(handleStat.ino) !== internal.ino) fail("run-root.replaced");
  const read = await readOwnerMarker(internal.path, options.onCheck);
  if (
    Number(read.stat.dev) !== internal.markerDev || Number(read.stat.ino) !== internal.markerIno ||
    read.sha256 !== internal.markerSha256
  ) fail("run-root.replaced");
  assertOwner(read.marker, internal.runId, internal.ownershipToken);
  assertMarkerRootBinding(read.marker, handleStat, "run-root.replaced");
  await verifyPinnedRootPath(internal.path, internal.rootHandle, handleStat);
}

function registerOwnedRoot(
  path: string,
  runId: RunId,
  ownershipToken: string,
  rootHandle: FileHandle,
  rootStat: Awaited<ReturnType<FileHandle["stat"]>>,
  markerStat: Awaited<ReturnType<FileHandle["stat"]>>,
  markerSha256: string,
): OwnedRunRoot {
  const key = inodeKey(rootStat);
  if (openRootInodes.has(key)) fail("run-root.already-open");
  openRootInodes.add(key);
  const root = {
    path,
    runId,
    dev: Number(rootStat.dev),
    ino: Number(rootStat.ino),
    markerSha256,
    async close() {
      if (internal.closed) return;
      internal.closed = true;
      openRootInodes.delete(internal.inodeKey);
      await internal.rootHandle.close();
    },
  } as InternalOwnedRunRoot;
  const internal = root;
  Object.defineProperties(root, {
    ownershipToken: { value: ownershipToken, enumerable: false, writable: false },
    rootHandle: { value: rootHandle, enumerable: false, writable: false },
    inodeKey: { value: key, enumerable: false, writable: false },
    markerDev: { value: Number(markerStat.dev), enumerable: false, writable: false },
    markerIno: { value: Number(markerStat.ino), enumerable: false, writable: false },
    closed: { value: false, enumerable: false, writable: true },
  });
  for (const property of ["path", "runId", "dev", "ino", "markerSha256", "close"] as const) {
    Object.defineProperty(root, property, { writable: false, configurable: false });
  }
  ownedRootObjects.add(root);
  return root;
}

async function readOwnerMarker(
  root: string,
  onCheck?: (phase: string) => void | Promise<void>,
): Promise<{
  marker: OwnerMarker;
  stat: Awaited<ReturnType<FileHandle["stat"]>>;
  sha256: string;
}> {
  const markerPath = join(root, RUN_ROOT_OWNER_FILE);
  const before = await safeLstat(markerPath);
  if (before.isSymbolicLink()) fail("run-root.symlink");
  if (!before.isFile()) fail("run-root.marker-invalid");
  if (before.nlink !== 1) fail("run-root.unsafe-link");
  if (before.size <= 0 || before.size > MAX_MARKER_BYTES) fail("run-root.marker-invalid");
  const handle = await openReadNoFollow(markerPath);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameStableFileObservation(opened, before)) fail("run-root.replaced");
    const bytes = await readBounded(handle, MAX_MARKER_BYTES);
    const after = await handle.stat();
    if (!sameStableFileObservation(opened, after) || bytes.byteLength !== after.size) fail("run-root.replaced");
    let text: string;
    let value: unknown;
    try {
      text = fatalUtf8.decode(bytes);
      value = JSON.parse(text);
    } catch {
      fail("run-root.marker-invalid");
    }
    const marker = parseOwnerMarker(value);
    if (`${canonicalJson(marker)}\n` !== text!) fail("run-root.marker-invalid");
    await invokeCheck(onCheck, "after-marker-descriptor-validated-before-path-recheck");
    const pathAfterRead = await safeLstat(markerPath);
    if (
      pathAfterRead.isSymbolicLink() || !pathAfterRead.isFile() || pathAfterRead.nlink !== 1 ||
      !sameStableFileObservation(pathAfterRead, after)
    ) fail("run-root.replaced");
    const reopened = await openReadNoFollow(markerPath);
    try {
      const reopenedStat = await reopened.stat();
      const finalPathStat = await safeLstat(markerPath);
      if (
        !reopenedStat.isFile() || reopenedStat.nlink !== 1 ||
        finalPathStat.isSymbolicLink() || !finalPathStat.isFile() || finalPathStat.nlink !== 1 ||
        !sameStableFileObservation(reopenedStat, after) ||
        !sameStableFileObservation(finalPathStat, after)
      ) fail("run-root.replaced");
    } finally {
      await reopened.close().catch(() => undefined);
    }
    return { marker, stat: after, sha256: sha256Hex(bytes) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function verifyOpenedRootPath(
  path: string,
  expectedRoot: Awaited<ReturnType<FileHandle["stat"]>>,
  expectedMarker: Awaited<ReturnType<typeof readOwnerMarker>>,
  runId: RunId,
  ownershipToken: string,
): Promise<{
  handle: FileHandle;
  rootStat: Awaited<ReturnType<FileHandle["stat"]>>;
  markerStat: Awaited<ReturnType<FileHandle["stat"]>>;
  markerSha256: string;
}> {
  const pathBefore = await safeLstat(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isDirectory() || !sameInode(pathBefore, expectedRoot)) {
    fail("run-root.replaced");
  }
  const handle = await openDirectoryNoFollow(path);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameInode(opened, expectedRoot) || !sameInode(opened, pathBefore)) {
      fail("run-root.replaced");
    }
    const marker = await readOwnerMarker(path);
    if (
      !sameStableFileObservation(marker.stat, expectedMarker.stat) ||
      marker.sha256 !== expectedMarker.sha256
    ) fail("run-root.replaced");
    assertOwner(marker.marker, runId, ownershipToken);
    assertMarkerRootBinding(marker.marker, opened, "run-root.replaced");
    const pathAfter = await safeLstat(path);
    const finalStat = await handle.stat();
    if (
      pathAfter.isSymbolicLink() || !pathAfter.isDirectory() ||
      !sameInode(pathAfter, expectedRoot) || !sameInode(finalStat, expectedRoot) ||
      !sameInode(pathAfter, finalStat)
    ) fail("run-root.replaced");
    return { handle, rootStat: finalStat, markerStat: marker.stat, markerSha256: marker.sha256 };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw wrap(error);
  }
}

async function verifyPinnedRootPath(
  path: string,
  retainedHandle: FileHandle,
  expectedRoot: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<void> {
  const pathBefore = await safeLstat(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isDirectory() || !sameInode(pathBefore, expectedRoot)) {
    fail("run-root.replaced");
  }
  const fresh = await openDirectoryNoFollow(path);
  try {
    const freshStat = await fresh.stat();
    const retainedStat = await retainedHandle.stat();
    const pathAfter = await safeLstat(path);
    if (
      !sameInode(freshStat, expectedRoot) || !sameInode(retainedStat, expectedRoot) ||
      pathAfter.isSymbolicLink() || !pathAfter.isDirectory() || !sameInode(pathAfter, expectedRoot)
    ) fail("run-root.replaced");
  } finally {
    await fresh.close().catch(() => undefined);
  }
}

function parseOwnerMarker(value: unknown): OwnerMarker {
  if (utilTypes.isProxy(value) || !isPlainRecord(value)) fail("run-root.marker-invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 6 || keys.some((key) => typeof key !== "string" || ![
    "schemaVersion", "runId", "createdAt", "ownershipTokenSha256", "rootDevice", "rootInode",
  ].includes(key))) {
    fail("run-root.marker-invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.runId !== "string" || !ID_PATTERNS.run.test(record.runId) ||
    !isTimestamp(record.createdAt) ||
    !isSha256(record.ownershipTokenSha256) ||
    typeof record.rootDevice !== "string" || !/^[0-9]+$/.test(record.rootDevice) ||
    typeof record.rootInode !== "string" || !/^[0-9]+$/.test(record.rootInode)
  ) fail("run-root.marker-invalid");
  return record as unknown as OwnerMarker;
}

function assertOwner(marker: OwnerMarker, runId: RunId, token: string): void {
  if (marker.runId !== runId || !safeHashEqual(marker.ownershipTokenSha256, sha256Hex(token))) {
    fail("run-root.owner-mismatch");
  }
}

function assertMarkerRootBinding(
  marker: OwnerMarker,
  rootStat: { dev: number | bigint; ino: number | bigint },
  code: "run-root.owner-mismatch" | "run-root.replaced",
): void {
  if (marker.rootDevice !== String(rootStat.dev) || marker.rootInode !== String(rootStat.ino)) fail(code);
}

interface PinnedAncestor {
  path: string;
  dev: number;
  ino: number;
}

interface PublishedLeaf {
  path: string;
  handle: FileHandle;
  rootStat: Awaited<ReturnType<FileHandle["stat"]>>;
  markerStat: Awaited<ReturnType<FileHandle["stat"]>>;
  markerSha256: string;
}

async function ensurePreparedResearchDirectory(
  path: string,
  parent: string,
  parentStat: Awaited<ReturnType<typeof stat>>,
  options: CreateOwnedRunRootOptions,
): Promise<void> {
  const existing = await lstatIfExists(path);
  if (existing) {
    if (existing.isSymbolicLink()) fail("run-root.symlink");
    if (!existing.isDirectory()) fail("run-root.unsafe-root");
    return;
  }
  const pins = await pinExistingAncestors(parent);
  const createdTemp = await createUnpredictableTempDirectory(parent, options);
  const temp = createdTemp.path;
  let handle: FileHandle | undefined;
  try {
    const first = createdTemp.firstStat;
    await recheckPinnedAncestors(pins);
    await options.onCheck?.("after-research-temp-mkdir");
    await assertExpectedDirectory(temp, first);
    handle = await openDirectoryNoFollow(temp);
    const opened = await handle.stat();
    if (!sameInode(first, opened)) fail("run-root.replaced");
    await durability(options, handle, "research-temp-directory-synced");
    await recheckPinnedAncestors(pins);
    await assertPinnedDirectory(parent, parentStat);
    const raced = await lstatIfExists(path);
    if (raced) {
      if (raced.isSymbolicLink()) fail("run-root.symlink");
      if (!raced.isDirectory()) fail("run-root.unsafe-root");
      return;
    }
    await options.onCheck?.("before-research-rename");
    await recheckPinnedAncestors(pins);
    try {
      await performRename(options, temp, path);
    } catch (error) {
      if (!isCollisionError(error)) throw error;
    }
    await options.onCheck?.("after-research-rename");
    const published = await safeLstat(path);
    if (!published.isDirectory() || published.isSymbolicLink()) fail("run-root.replaced");
    const parentHandle = await openDirectoryNoFollow(parent);
    try {
      await durability(options, parentHandle, "research-parent-synced");
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
    await recheckPinnedAncestors(pins);
    await assertPinnedDirectory(parent, parentStat);
  } catch (error) {
    throw wrap(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function prepareAndPublishLeaf(
  base: string,
  useSuffix: boolean,
  markerSeed: OwnerMarkerSeed,
  ancestorPins: readonly PinnedAncestor[],
  options: CreateOwnedRunRootOptions,
): Promise<PublishedLeaf> {
  const parent = dirname(base);
  const createdTemp = await createUnpredictableTempDirectory(parent, options);
  const temp = createdTemp.path;
  let tempHandle: FileHandle | undefined;
  let finalHandle: FileHandle | undefined;
  try {
    // The temp name contains 128 bits of fresh entropy. createUnpredictableTempDirectory
    // performs the first lstat immediately after mkdir, before it resolves and
    // before any callback or other package-controlled operation can run.
    const first = createdTemp.firstStat;
    const marker: OwnerMarker = {
      schemaVersion: 1,
      ...markerSeed,
      rootDevice: String(first.dev),
      rootInode: String(first.ino),
    };
    const markerBytes = Buffer.from(`${canonicalJson(marker)}\n`, "utf8");
    if (markerBytes.byteLength > MAX_MARKER_BYTES) fail("run-root.marker-invalid");
    const markerSha256 = sha256Hex(markerBytes);
    await recheckPinnedAncestors(ancestorPins);
    await options.onCheck?.("after-leaf-temp-mkdir-before-pin");
    await assertExpectedDirectory(temp, first);
    await options.onCheck?.("after-leaf-temp-pin-before-open");
    tempHandle = await openDirectoryNoFollow(temp);
    const opened = await tempHandle.stat();
    if (!sameInode(first, opened)) fail("run-root.replaced");
    await recheckPinnedAncestors(ancestorPins);
    await durability(options, tempHandle, "leaf-temp-directory-synced");

    await options.onCheck?.("before-marker-create");
    await assertExpectedDirectory(temp, first);
    await recheckPinnedAncestors(ancestorPins);
    const markerHandle = await openExclusiveFile(join(temp, RUN_ROOT_OWNER_FILE));
    let markerStat: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      await options.onCheck?.("after-marker-create-before-write");
      await assertExpectedDirectory(temp, first);
      await recheckPinnedAncestors(ancestorPins);
      await writeFully(markerHandle, markerBytes);
      await options.onCheck?.("after-marker-write-before-fsync");
      await assertExpectedDirectory(temp, first);
      await recheckPinnedAncestors(ancestorPins);
      markerStat = await markerHandle.stat();
      if (!markerStat.isFile() || markerStat.nlink !== 1) fail("run-root.unsafe-link");
      await durability(options, markerHandle, "marker-synced");
      await assertExpectedDirectory(temp, first);
      await recheckPinnedAncestors(ancestorPins);
    } finally {
      await markerHandle.close().catch(() => undefined);
    }
    await options.onCheck?.("after-marker-fsync-before-rename");
    await assertExpectedDirectory(temp, first);
    if (!sameInode(await tempHandle.stat(), first)) fail("run-root.replaced");
    await durability(options, tempHandle, "leaf-marker-directory-synced");
    await recheckPinnedAncestors(ancestorPins);

    let publishedPath: string | undefined;
    for (let suffix = 1; suffix <= 10_000; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      if (!useSuffix && suffix > 1) fail("run-root.conflict");
      const existing = await lstatIfExists(candidate);
      if (existing) {
        if (!useSuffix) fail(existing.isSymbolicLink() ? "run-root.symlink" : "run-root.conflict");
        continue;
      }
      await options.onCheck?.("before-leaf-rename");
      await recheckPinnedAncestors(ancestorPins);
      try {
        await performRename(options, temp, candidate);
      } catch (error) {
        if (useSuffix && isCollisionError(error)) continue;
        throw error;
      }
      publishedPath = candidate;
      break;
    }
    if (!publishedPath) fail("run-root.conflict");

    await options.onCheck?.("after-leaf-rename-before-final-open");
    const published = await safeLstat(publishedPath);
    if (!published.isDirectory() || published.isSymbolicLink() || !sameInode(first, published)) fail("run-root.replaced");
    finalHandle = await openDirectoryNoFollow(publishedPath);
    const finalStat = await finalHandle.stat();
    if (!sameInode(first, finalStat)) fail("run-root.replaced");
    const markerRead = await readOwnerMarker(publishedPath, options.onCheck);
    if (!sameStableFileObservation(markerRead.stat, markerStat!) || markerRead.sha256 !== markerSha256) fail("run-root.replaced");
    assertMarkerSeed(markerRead.marker, markerSeed);
    assertMarkerRootBinding(markerRead.marker, first, "run-root.replaced");
    await options.onCheck?.("after-final-marker-read-before-return");
    await options.onCheck?.("after-final-open-before-return");
    await assertExpectedDirectory(publishedPath, first);
    if (!sameInode(await finalHandle.stat(), first)) fail("run-root.replaced");
    await recheckPinnedAncestors(ancestorPins);
    const parentHandle = await openDirectoryNoFollow(parent);
    try {
      await durability(options, parentHandle, "leaf-parent-synced");
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
    await options.onCheck?.("after-leaf-parent-synced-before-return");
    await recheckPinnedAncestors(ancestorPins);
    await finalHandle.close();
    finalHandle = undefined;
    await tempHandle.close();
    tempHandle = undefined;
    const verified = await verifyPublishedOwnership(
      publishedPath,
      first,
      markerSeed,
      markerStat!,
      markerSha256,
    );
    return { path: publishedPath, handle: verified.handle, rootStat: verified.rootStat, markerStat: verified.markerStat, markerSha256 };
  } catch (error) {
    await finalHandle?.close().catch(() => undefined);
    throw wrap(error);
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => undefined);
  }
}

async function verifyPublishedOwnership(
  path: string,
  expectedRoot: { dev: number | bigint; ino: number | bigint },
  markerSeed: OwnerMarkerSeed,
  expectedMarker: Awaited<ReturnType<FileHandle["stat"]>>,
  expectedMarkerSha256: string,
): Promise<{
  handle: FileHandle;
  rootStat: Awaited<ReturnType<FileHandle["stat"]>>;
  markerStat: Awaited<ReturnType<FileHandle["stat"]>>;
}> {
  const pathBefore = await safeLstat(path);
  if (pathBefore.isSymbolicLink() || !pathBefore.isDirectory() || !sameInode(pathBefore, expectedRoot)) {
    fail("run-root.replaced");
  }
  const handle = await openDirectoryNoFollow(path);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameInode(opened, expectedRoot) || !sameInode(opened, pathBefore)) {
      fail("run-root.replaced");
    }
    const marker = await readOwnerMarker(path);
    if (
      !sameStableFileObservation(marker.stat, expectedMarker) ||
      marker.sha256 !== expectedMarkerSha256
    ) fail("run-root.replaced");
    assertMarkerSeed(marker.marker, markerSeed);
    assertMarkerRootBinding(marker.marker, opened, "run-root.replaced");
    // These are the final asynchronous observations before returning the pinned
    // handle. No hook or filesystem operation is performed after them.
    const pathAfter = await safeLstat(path);
    const finalStat = await handle.stat();
    if (
      pathAfter.isSymbolicLink() || !pathAfter.isDirectory() ||
      !sameInode(pathAfter, expectedRoot) || !sameInode(finalStat, expectedRoot) ||
      !sameInode(pathAfter, finalStat)
    ) fail("run-root.replaced");
    return { handle, rootStat: finalStat, markerStat: marker.stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw wrap(error);
  }
}

function assertMarkerSeed(marker: OwnerMarker, seed: OwnerMarkerSeed): void {
  if (
    marker.runId !== seed.runId || marker.createdAt !== seed.createdAt ||
    !safeHashEqual(marker.ownershipTokenSha256, seed.ownershipTokenSha256)
  ) fail("run-root.replaced");
}

async function createUnpredictableTempDirectory(
  parent: string,
  options: CreateOwnedRunRootOptions,
): Promise<{ path: string; firstStat: Awaited<ReturnType<typeof lstat>> }> {
  const random = options.randomBytes ?? nodeRandomBytes;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const entropy = Buffer.from(random(16)).toString("hex");
    if (!/^[a-f0-9]{32}$/.test(entropy)) fail("run-root.invalid-options");
    const candidate = join(parent, `.tmp-run-root-${entropy}-${attempt}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
      const firstStat = await safeLstat(candidate);
      if (!firstStat.isDirectory() || firstStat.isSymbolicLink()) fail("run-root.replaced");
      return { path: candidate, firstStat };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw wrap(error);
    }
  }
  fail("run-root.conflict");
}

async function pinExistingAncestors(path: string): Promise<PinnedAncestor[]> {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  const pins: PinnedAncestor[] = [];
  let current = root;
  const rootStat = await safeLstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("run-root.symlink");
  pins.push({ path: root, dev: Number(rootStat.dev), ino: Number(rootStat.ino) });
  for (const segment of segments) {
    current = join(current, segment);
    const info = await safeLstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("run-root.symlink");
    pins.push({ path: current, dev: Number(info.dev), ino: Number(info.ino) });
  }
  return pins;
}

async function recheckPinnedAncestors(pins: readonly PinnedAncestor[]): Promise<void> {
  for (const pin of pins) {
    const info = await safeLstat(pin.path);
    if (info.isSymbolicLink() || !info.isDirectory() || Number(info.dev) !== pin.dev || Number(info.ino) !== pin.ino) {
      fail("run-root.replaced");
    }
  }
}

async function assertExpectedDirectory(
  path: string,
  expected: { dev: number | bigint; ino: number | bigint },
): Promise<void> {
  const info = await safeLstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || !sameInode(info, expected)) fail("run-root.replaced");
}

async function performRename(options: CreateOwnedRunRootOptions, from: string, to: string): Promise<void> {
  try {
    await (options.rename ?? nodeRename)(from, to);
  } catch (error) {
    if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) throw error;
    throw wrap(error);
  }
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw wrap(error);
  }
}

function isCollisionError(error: unknown): boolean {
  return isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY");
}

async function authorizeLocation(
  target: string,
  trustedProject: string,
  options: CreateOwnedRunRootOptions,
): Promise<void> {
  if (isStrictDescendantOrEqual(trustedProject, target)) return;
  const anchorBefore = await nearestExistingDirectory(target);
  const allowlist = options.approvedOutsideRoots ?? [];
  for (const entry of allowlist) {
    assertPathBounds(entry);
    const canonical = await canonicalExistingDirectory(entry);
    await assertIntrinsicUnsafeRoot(canonical);
    if (isStrictDescendantOrEqual(canonical, target)) {
      const anchorAfter = await nearestExistingDirectory(target);
      if (anchorBefore.path !== anchorAfter.path || !sameInode(anchorBefore.stat, anchorAfter.stat)) fail("run-root.replaced");
      return;
    }
  }
  if (!options.approveOutside) fail("run-root.outside-denied");
  const approved = await options.approveOutside(target);
  if (approved !== true) fail("run-root.outside-denied");
  const rechecked = await canonicalCandidate(target);
  const anchorAfter = await nearestExistingDirectory(target);
  if (rechecked !== target || anchorBefore.path !== anchorAfter.path || !sameInode(anchorBefore.stat, anchorAfter.stat)) {
    fail("run-root.replaced");
  }
}

async function assertForbiddenRoot(
  target: string,
  trustedProject: string,
  repositoryRoot: string,
  options: CreateOwnedRunRootOptions,
): Promise<void> {
  await assertIntrinsicUnsafeRoot(target);
  const researchParent = join(trustedProject, "research");
  if (target === trustedProject || target === repositoryRoot || target === researchParent) fail("run-root.unsafe-root");

  const projectSecretNames = [".git", ".pi", ".env", ".config", ".secrets", "credentials"];
  const forbidden = new Set<string>();
  for (const base of new Set([trustedProject, repositoryRoot])) {
    for (const name of projectSecretNames) forbidden.add(join(base, name));
  }

  for (const explicit of options.forbiddenRoots ?? []) forbidden.add(await canonicalCandidate(explicit));
  for (const root of forbidden) {
    if (isStrictDescendantOrEqual(root, target)) fail("run-root.unsafe-root");
  }
  await assertGlobalForbiddenRoot(target, options.forbiddenRoots ?? []);
}

async function assertGlobalForbiddenRoot(target: string, explicitRoots: readonly string[]): Promise<void> {
  let canonicalHome = resolve(homedir());
  try { canonicalHome = await realpath(canonicalHome); } catch { /* retain normalized home */ }
  const forbidden = new Set<string>();
  for (const name of [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".pi", ".agents", ".config"]) {
    forbidden.add(join(canonicalHome, name));
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) forbidden.add(await canonicalCandidate(xdg));
  for (const explicit of explicitRoots) forbidden.add(await canonicalCandidate(explicit));
  for (const root of forbidden) {
    if (isStrictDescendantOrEqual(root, target)) fail("run-root.unsafe-root");
  }
}

async function assertIntrinsicUnsafeRoot(path: string): Promise<void> {
  const filesystemRoot = parsePath(path).root;
  if (path === filesystemRoot) fail("run-root.unsafe-root");
  let home = resolve(homedir());
  try { home = await realpath(home); } catch { /* retain normalized home */ }
  if (path === home) fail("run-root.unsafe-root");
}

async function inspectContainedPath(root: string, rel: string): Promise<{
  existingParentPath: string;
  remainingPath: string;
  parentStat: Awaited<ReturnType<typeof lstat>>;
}> {
  const segments = rel.split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const next = join(current, segments[index]!);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw wrap(error);
      const parentStat = await safeLstat(current);
      return { existingParentPath: current, remainingPath: segments.slice(index).join(sep), parentStat };
    }
    if (info.isSymbolicLink()) fail("run-root.symlink");
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !info.isDirectory()) fail("run-root.not-file");
    if (isLeaf) {
      if (!info.isFile()) fail("run-root.not-file");
      if (info.nlink !== 1) fail("run-root.unsafe-link");
      const parentStat = await safeLstat(current);
      return { existingParentPath: current, remainingPath: segments[index]!, parentStat };
    }
    current = next;
  }
  fail("run-root.invalid-path");
}

async function nearestExistingDirectory(path: string): Promise<{
  path: string;
  stat: Awaited<ReturnType<typeof lstat>>;
}> {
  let current = resolve(path);
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail("run-root.symlink");
      if (!info.isDirectory()) {
        current = dirname(current);
        continue;
      }
      return { path: await realpath(current), stat: info };
    } catch (error) {
      if (error instanceof RunRootError) throw error;
      if (!isNodeError(error, "ENOENT")) throw wrap(error);
      const parent = dirname(current);
      if (parent === current) fail("run-root.invalid-path");
      current = parent;
    }
  }
}

async function canonicalCandidate(input: string): Promise<string> {
  const absolute = resolve(input);
  assertPathBounds(absolute);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail("run-root.symlink");
      if (!info.isDirectory()) {
        if (missing.length === 0) return await realpath(current);
        fail("run-root.invalid-path");
      }
      const canonical = await realpath(current);
      return join(canonical, ...missing.reverse());
    } catch (error) {
      if (error instanceof RunRootError) throw error;
      if (!isNodeError(error, "ENOENT")) throw wrap(error);
      const parent = dirname(current);
      if (parent === current) fail("run-root.invalid-path");
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  assertPathBounds(path);
  const canonical = await canonicalCandidate(path);
  const info = await safeLstat(canonical);
  if (info.isSymbolicLink()) fail("run-root.symlink");
  if (!info.isDirectory()) fail("run-root.unsafe-root");
  await assertNoSymlinkSegments(canonical);
  return canonical;
}

async function assertNoSymlinkSegments(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const rest = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of rest) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail("run-root.symlink");
    } catch (error) {
      if (error instanceof RunRootError) throw error;
      if (isNodeError(error, "ENOENT")) return;
      throw wrap(error);
    }
  }
}

async function assertPinnedDirectory(
  path: string,
  expected: Awaited<ReturnType<typeof stat>>,
): Promise<void> {
  const info = await safeLstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || !sameInode(info, expected)) fail("run-root.replaced");
}

function validateCreateScalars(options: CreateOwnedRunRootOptions): void {
  if (!ID_PATTERNS.run.test(options.runId)) fail("run-root.invalid-options");
  if (typeof options.topic !== "string" || Buffer.byteLength(options.topic, "utf8") > MAX_TOPIC_BYTES) {
    fail("run-root.invalid-options");
  }
  if (options.ownershipToken !== undefined && !TOKEN_PATTERN.test(options.ownershipToken)) fail("run-root.invalid-options");
}

function assertClosedOptions(options: CreateOwnedRunRootOptions): void {
  assertSimpleOptions(options, new Set([
    "trustedProject", "repositoryRoot", "topic", "runId", "ownershipToken", "requestedPath",
    "allowAbsoluteRequestedPath", "approveOutside", "approvedOutsideRoots", "forbiddenRoots", "now", "randomBytes",
    "durability", "rename", "onCheck",
  ]));
  if (options.approvedOutsideRoots !== undefined) validatePathArray(options.approvedOutsideRoots);
  if (options.forbiddenRoots !== undefined) validatePathArray(options.forbiddenRoots);
}

function validatePathArray(paths: readonly string[]): void {
  if (utilTypes.isProxy(paths) || Object.getPrototypeOf(paths) !== Array.prototype || paths.length > 100) {
    fail("run-root.invalid-options");
  }
  for (let index = 0; index < paths.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      fail("run-root.invalid-options");
    }
  }
}

function assertSimpleOptions(value: unknown, allowed: Set<string>): void {
  if (utilTypes.isProxy(value) || !isPlainRecord(value)) fail("run-root.invalid-options");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail("run-root.invalid-options");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("run-root.invalid-options");
  }
}

function assertPortableRequestedPath(path: string): void {
  if (path.includes("\0") || path.includes("\\") || /^[A-Za-z]:/.test(path)) fail("run-root.invalid-path");
  let decoded = path;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { fail("run-root.invalid-path"); }
    const segments = next.replace(/\\/g, "/").split("/");
    if (segments.some((segment) => segment === ".." || segment === ".")) fail("run-root.invalid-path");
    if (next === decoded) break;
    decoded = next;
  }
}

function assertPortableRelative(path: string): void {
  if (path.includes("\0") || path.includes("\\")) fail("run-root.invalid-path");
  const segments = path.split(sep);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail("run-root.invalid-path");
  for (const segment of segments) if (Buffer.byteLength(segment, "utf8") > MAX_COMPONENT_BYTES) fail("run-root.path-too-long");
}

function assertPathBounds(path: string): void {
  if (typeof path !== "string" || path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    fail("run-root.path-too-long");
  }
  for (const segment of resolve(path).split(sep).filter(Boolean)) {
    if (Buffer.byteLength(segment, "utf8") > MAX_COMPONENT_BYTES) fail("run-root.path-too-long");
  }
}

function sanitizeTopicSlug(topic: string): string {
  if (Buffer.byteLength(topic, "utf8") > MAX_TOPIC_BYTES) fail("run-root.invalid-options");
  const slug = topic.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "research";
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  try {
    const handle = await open(path, constants.O_RDONLY | directoryFlag | noFollow);
    const info = await handle.stat();
    if (!info.isDirectory()) { await handle.close(); fail("run-root.unsafe-root"); }
    return handle;
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("run-root.symlink");
    throw wrap(error);
  }
}

async function openExclusiveFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("run-root.symlink");
    if (isNodeError(error, "EEXIST")) fail("run-root.conflict");
    throw wrap(error);
  }
}

async function openReadNoFollow(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("run-root.symlink");
    throw wrap(error);
  }
}

async function writeFully(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten <= 0) fail("run-root.io-failed");
    offset += bytesWritten;
  }
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(1024, maximum + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximum) fail("run-root.marker-invalid");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function invokeCheck(
  hook: ((phase: string) => void | Promise<void>) | undefined,
  phase: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(phase);
  } catch (error) {
    throw wrap(error);
  }
}

async function durability(
  options: CreateOwnedRunRootOptions,
  handle: FileHandle,
  step: RunRootDurabilityStep,
): Promise<void> {
  try {
    if (options.durability) await options.durability(handle, step);
    else await handle.sync();
  } catch {
    fail("run-root.io-failed");
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try { return await lstat(path); } catch (error) { throw wrap(error); }
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
  try { return await stat(path); } catch (error) { throw wrap(error); }
}

function sameInode(a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }): boolean {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

function sameStableFileObservation(
  a: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint },
  b: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint },
): boolean {
  return sameInode(a, b) &&
    String(a.size) === String(b.size) &&
    String(a.mtimeMs) === String(b.mtimeMs) &&
    String(a.ctimeMs) === String(b.ctimeMs);
}

function inodeKey(info: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function isStrictDescendantOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeHashEqual(left: string, right: string): boolean {
  if (!isSha256(left) || !isSha256(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function asInternal(root: OwnedRunRoot): InternalOwnedRunRoot {
  if (utilTypes.isProxy(root) || !root || typeof root !== "object" || !ownedRootObjects.has(root)) {
    fail("run-root.invalid-options");
  }
  return root as InternalOwnedRunRoot;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function withProjectQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const chained = previous.catch(() => undefined).then(() => current);
  projectQueues.set(key, chained);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (projectQueues.get(key) === chained) projectQueues.delete(key);
  }
}

function wrap(error: unknown): RunRootError {
  if (error instanceof RunRootError) return error;
  if (isNodeError(error, "ELOOP")) return new RunRootError("run-root.symlink");
  return new RunRootError("run-root.io-failed");
}

function fail(code: RunRootErrorCode): never {
  throw new RunRootError(code);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
