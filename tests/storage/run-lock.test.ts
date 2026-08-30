import {
  closeSync as actualCloseSync,
  constants,
  fstatSync as actualFstatSync,
  openSync as actualOpenSync,
} from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { sha256Hex } from "../../src/crypto/hash.js";
import { createOwnedRunRoot, type OwnedRunRoot } from "../../src/storage/run-root.js";
import {
  ResearchRunLockError,
  acquireResearchRunLockInternal,
  createResearchRunLockRetentionObserverInternal,
  createResearchRunLockTestHooksInternal,
  getResearchRunLockRetentionCountsInternal,
  type ResearchRunLockPhaseInternal,
} from "../../src/storage/run-lock-internal.js";

const RUN_ID = "run-0123456789abcdef" as const;
const ROOT_TOKEN = "a".repeat(64);
const OWNER_TOKEN = Buffer.alloc(32, 0x5c);
const NOW = new Date("2026-08-25T12:34:56.000Z");
const temporaryRoots: string[] = [];

async function fixture(): Promise<OwnedRunRoot> {
  const base = await mkdtemp(join(tmpdir(), "pi-run-lock-"));
  temporaryRoots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return createOwnedRunRoot({
    trustedProject: project,
    repositoryRoot: project,
    requestedPath: "owned",
    topic: "run lock",
    runId: RUN_ID,
    ownershipToken: ROOT_TOKEN,
    now: () => NOW,
  });
}

function hooks(onCheck: ((phase: ResearchRunLockPhaseInternal) => void | Promise<void>) | null = null) {
  return createResearchRunLockTestHooksInternal({
    now: () => NOW,
    randomBytes: (size) => {
      expect(size).toBe(32);
      return OWNER_TOKEN;
    },
    onCheck,
    failAt: null,
  });
}

function expectCode(code: string) {
  return expect.objectContaining({ code });
}

afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("acquireResearchRunLockInternal", () => {
  test("publishes a canonical durable controller record in a private state directory", async () => {
    const root = await fixture();
    const phases: ResearchRunLockPhaseInternal[] = [];

    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 7 }, hooks((phase) => {
      phases.push(phase);
    }));

    const rootStat = await lstat(root.path);
    const stateStat = await lstat(join(root.path, ".state"));
    const text = await readFile(join(root.path, ".state", "controller.lock"), "utf8");
    expect(text).toBe(`${JSON.stringify({
      acquiredAt: NOW.toISOString(),
      executionEpoch: 7,
      ownerTokenSha256: sha256Hex(OWNER_TOKEN),
      rootDevice: String(rootStat.dev),
      rootInode: String(rootStat.ino),
      runId: RUN_ID,
      schemaVersion: 1,
      stateDevice: String(stateStat.dev),
      stateInode: String(stateStat.ino),
    })}\n`);
    expect(stateStat.mode & 0o777).toBe(0o700);
    expect((await lstat(join(root.path, ".state", "controller.lock"))).mode & 0o777).toBe(0o600);
    expect(lock).toEqual({
      runId: RUN_ID,
      executionEpoch: 7,
      statePath: join(root.path, ".state"),
      ownerTokenSha256: sha256Hex(OWNER_TOKEN),
      syncStateDirectory: expect.any(Function),
      release: expect.any(Function),
      closePreservingLock: expect.any(Function),
    });
    expect(Object.isFrozen(lock)).toBe(true);
    expect(JSON.stringify(lock)).not.toContain(OWNER_TOKEN.toString("hex"));
    expect(phases).toEqual([
      "before-state-create",
      "after-state-open",
      "after-root-directory-sync",
      "before-lock-open",
      "after-lock-open",
      "after-lock-write",
      "after-lock-sync",
      "after-state-publication-sync",
    ]);

    await lock.release();
    await root.close();
  });

  test("rejects lock pathname replacement immediately after pathname publication", async () => {
    const root = await fixture();
    const lockPath = join(root.path, ".state", "controller.lock");
    const movedLockPath = `${lockPath}.original`;
    let replaced = false;

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 8 }, hooks(async (phase) => {
      if (phase !== "after-lock-open" || replaced) return;
      replaced = true;
      await rename(lockPath, movedLockPath);
      await writeFile(lockPath, "", { mode: 0o600 });
    }))).rejects.toEqual(expectCode("lock.replaced"));
    expect(replaced).toBe(true);
    expect((await lstat(lockPath)).isFile()).toBe(true);
    expect((await lstat(movedLockPath)).isFile()).toBe(true);
    await root.close();
  });

  test("releases only its verified lock and release is idempotent after confirmed absence", async () => {
    const root = await fixture();
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks());
    const lockPath = join(root.path, ".state", "controller.lock");

    await lock.release();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await lock.release();
    await expect(lock.syncStateDirectory()).rejects.toEqual(expectCode("lock.closed"));

    await root.close();
  });

  test("preserves a foreign lock raced in after pinned unlink", async () => {
    const root = await fixture();
    const lockPath = join(root.path, ".state", "controller.lock");
    let raced = false;
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 9 }, hooks(async (phase) => {
      if (phase !== "after-lock-unlink" || raced) return;
      raced = true;
      await writeFile(lockPath, "foreign-controller", { mode: 0o600 });
    }));

    await expect(lock.release()).rejects.toEqual(expectCode("lock.replaced"));
    expect(raced).toBe(true);
    expect(await readFile(lockPath, "utf8")).toBe("foreign-controller");
    await lock.closePreservingLock();
    expect(await readFile(lockPath, "utf8")).toBe("foreign-controller");
    await root.close();
  });

  test("redacts live state-path replacement failures from directory sync", async () => {
    const root = await fixture();
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 1 }, hooks());
    const movedStatePath = join(root.path, ".state-moved");
    await rename(lock.statePath, movedStatePath);

    let caught: unknown;
    try {
      await lock.syncStateDirectory();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResearchRunLockError);
    expect(caught).toEqual(expectCode("lock.io-failed"));
    expect((caught as Error).message).toBe("Research run lock failed (lock.io-failed)");
    expect(JSON.stringify(caught)).not.toContain(root.path);
    expect(Reflect.ownKeys(caught as object)).not.toContain("path");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(caught as object))) {
      if ("value" in descriptor && typeof descriptor.value === "string") {
        expect(descriptor.value).not.toContain(root.path);
      }
    }

    await lock.closePreservingLock();
    await root.close();
  });

  test("directory sync rechecks release operation ownership after root revalidation", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-sync-release-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    let blockNextRevalidation = false;
    let watchDescriptorAccess = false;
    let continueRevalidation!: () => void;
    let announceRevalidation!: () => void;
    let continueRelease!: () => void;
    let announceRelease!: () => void;
    const revalidationStarted = new Promise<void>((resolve) => { announceRevalidation = resolve; });
    const revalidationGate = new Promise<void>((resolve) => { continueRevalidation = resolve; });
    const releaseStarted = new Promise<void>((resolve) => { announceRelease = resolve; });
    const releaseGate = new Promise<void>((resolve) => { continueRelease = resolve; });
    const retainedFds = new Set<number>();
    const descriptorAccesses: string[] = [];
    let captureRetainedFds = false;
    let root: OwnedRunRoot | undefined;
    let releaseOutcome: Promise<void> | undefined;
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const fd = actualOpenSync(path, flags, mode);
        if (captureRetainedFds) {
          const text = String(path);
          if (
            (text.endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) ||
            (text.endsWith("/.state") && (flags & constants.O_DIRECTORY) !== 0) ||
            (text.endsWith("/controller.lock") && (flags & constants.O_CREAT) !== 0)
          ) retainedFds.add(fd);
        }
        return fd;
      },
      fstatSync(fd: number) {
        if (watchDescriptorAccess && retainedFds.has(fd)) descriptorAccesses.push(`fstat:${fd}`);
        return actualFs.fstatSync(fd);
      },
      fsyncSync(fd: number) {
        if (watchDescriptorAccess && retainedFds.has(fd)) descriptorAccesses.push(`fsync:${fd}`);
        return actualFs.fsyncSync(fd);
      },
    }));
    vi.doMock("node:fs/promises", () => ({
      ...actualFsPromises,
      async lstat(path: Parameters<typeof lstat>[0], options?: Parameters<typeof lstat>[1]) {
        if (blockNextRevalidation && String(path).endsWith("/owned")) {
          blockNextRevalidation = false;
          announceRevalidation();
          await revalidationGate;
        }
        return actualFsPromises.lstat(path, options as never);
      },
    }));

    try {
      const [rootModule, lockModule] = await Promise.all([
        import("../../src/storage/run-root.js"),
        import("../../src/storage/run-lock-internal.js"),
      ]);
      root = await rootModule.createOwnedRunRoot({
        trustedProject: project,
        repositoryRoot: project,
        requestedPath: "owned",
        topic: "sync release ownership",
        runId: RUN_ID,
        ownershipToken: ROOT_TOKEN,
        now: () => NOW,
      });
      captureRetainedFds = true;
      const lockHooks = lockModule.createResearchRunLockTestHooksInternal({
        now: () => NOW,
        randomBytes: () => OWNER_TOKEN,
        onCheck: async (phase) => {
          if (phase !== "before-release-verify") return;
          announceRelease();
          await releaseGate;
        },
        failAt: null,
      });
      const lock = await lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 16 }, lockHooks);
      captureRetainedFds = false;
      expect(retainedFds.size).toBe(3);

      blockNextRevalidation = true;
      const syncOutcome = lock.syncStateDirectory();
      await revalidationStarted;
      releaseOutcome = lock.release();
      await releaseStarted;
      watchDescriptorAccess = true;
      continueRevalidation();

      await expect(syncOutcome).rejects.toEqual(expectCode("lock.closed"));
      expect(descriptorAccesses).toEqual([]);
      watchDescriptorAccess = false;
      continueRelease();
      await releaseOutcome;
    } finally {
      continueRevalidation();
      continueRelease();
      await releaseOutcome?.catch(() => undefined);
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("directory sync never accesses descriptor numbers consumed by close", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-sync-close-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    let blockNextRevalidation = false;
    let watchDescriptorAccess = false;
    let continueRevalidation!: () => void;
    let announceRevalidation!: () => void;
    const revalidationStarted = new Promise<void>((resolve) => { announceRevalidation = resolve; });
    const revalidationGate = new Promise<void>((resolve) => { continueRevalidation = resolve; });
    const retainedFds = new Set<number>();
    const replacementFds: number[] = [];
    const descriptorAccesses: string[] = [];
    let captureRetainedFds = false;
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const fd = actualOpenSync(path, flags, mode);
        if (captureRetainedFds) {
          const text = String(path);
          if (
            (text.endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) ||
            (text.endsWith("/.state") && (flags & constants.O_DIRECTORY) !== 0) ||
            (text.endsWith("/controller.lock") && (flags & constants.O_CREAT) !== 0)
          ) retainedFds.add(fd);
        }
        return fd;
      },
      fstatSync(fd: number) {
        if (watchDescriptorAccess && retainedFds.has(fd)) descriptorAccesses.push(`fstat:${fd}`);
        return actualFs.fstatSync(fd);
      },
      fsyncSync(fd: number) {
        if (watchDescriptorAccess && retainedFds.has(fd)) descriptorAccesses.push(`fsync:${fd}`);
        return actualFs.fsyncSync(fd);
      },
    }));
    vi.doMock("node:fs/promises", () => ({
      ...actualFsPromises,
      async lstat(path: Parameters<typeof lstat>[0], options?: Parameters<typeof lstat>[1]) {
        if (blockNextRevalidation && String(path).endsWith("/owned")) {
          blockNextRevalidation = false;
          announceRevalidation();
          await revalidationGate;
        }
        return actualFsPromises.lstat(path, options as never);
      },
    }));

    try {
      const [rootModule, lockModule] = await Promise.all([
        import("../../src/storage/run-root.js"),
        import("../../src/storage/run-lock-internal.js"),
      ]);
      root = await rootModule.createOwnedRunRoot({
        trustedProject: project,
        repositoryRoot: project,
        requestedPath: "owned",
        topic: "sync close ownership",
        runId: RUN_ID,
        ownershipToken: ROOT_TOKEN,
        now: () => NOW,
      });
      captureRetainedFds = true;
      const lock = await lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 17 });
      captureRetainedFds = false;
      expect(retainedFds.size).toBe(3);

      blockNextRevalidation = true;
      const syncOutcome = lock.syncStateDirectory();
      await revalidationStarted;
      await lock.closePreservingLock();
      for (let index = 0; index < retainedFds.size; index += 1) {
        replacementFds.push(actualOpenSync(
          join(base, `replacement-${index}`),
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        ));
      }
      expect(new Set(replacementFds)).toEqual(retainedFds);
      watchDescriptorAccess = true;
      continueRevalidation();

      await expect(syncOutcome).rejects.toEqual(expectCode("lock.closed"));
      expect(descriptorAccesses).toEqual([]);
      for (const fd of replacementFds) expect(actualFstatSync(fd).isFile()).toBe(true);
    } finally {
      continueRevalidation();
      for (const fd of replacementFds) try { actualCloseSync(fd); } catch { /* replacement remains test-owned */ }
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("refuses release after lock content ownership mismatch and preserves the pathname", async () => {
    const root = await fixture();
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 2 }, hooks());
    const lockPath = join(root.path, ".state", "controller.lock");
    const original = await readFile(lockPath, "utf8");
    await writeFile(lockPath, original.replace(sha256Hex(OWNER_TOKEN), "b".repeat(64)));

    await expect(lock.release()).rejects.toEqual(expectCode("lock.owner-mismatch"));
    expect(await readFile(lockPath, "utf8")).toContain("b".repeat(64));
    await lock.closePreservingLock();
    await expect(lock.release()).rejects.toEqual(expectCode("lock.closed"));

    await root.close();
  });

  test("exclusive publication admits only one concurrent controller", async () => {
    const root = await fixture();
    const first = await acquireResearchRunLockInternal(root, { executionEpoch: 4 }, hooks());

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 4 }, hooks())).rejects.toEqual(
      expectCode("lock.conflict"),
    );
    expect(await readFile(join(root.path, ".state", "controller.lock"), "utf8")).toContain(
      sha256Hex(OWNER_TOKEN),
    );

    await first.release();
    await root.close();
  });

  test("overlapping state creators sync the run-root before either publishes", async () => {
    type Outcome =
      | { readonly status: "fulfilled"; readonly value: Awaited<ReturnType<typeof acquireResearchRunLockInternal>> }
      | { readonly status: "rejected"; readonly reason: unknown };
    const root = await fixture();
    const phases: Record<"a" | "b", ResearchRunLockPhaseInternal[]> = { a: [], b: [] };
    let arrivals = 0;
    let releaseBeforeStateCreate!: () => void;
    const bothAtStateCreate = new Promise<void>((resolve) => { releaseBeforeStateCreate = resolve; });
    let releaseMkdirWinner!: () => void;
    const mkdirWinnerMayContinue = new Promise<void>((resolve) => { releaseMkdirWinner = resolve; });
    let announceMkdirWinner!: () => void;
    const mkdirWinnerOpenedState = new Promise<void>((resolve) => { announceMkdirWinner = resolve; });
    let mkdirWinner: "a" | "b" | null = null;

    const overlappingHooks = (id: "a" | "b") => hooks(async (phase) => {
      phases[id].push(phase);
      if (phase === "before-state-create") {
        arrivals += 1;
        if (arrivals === 2) releaseBeforeStateCreate();
        await bothAtStateCreate;
      }
      if (phase === "after-state-open" && mkdirWinner === null) {
        mkdirWinner = id;
        announceMkdirWinner();
        await mkdirWinnerMayContinue;
      }
    });
    const settle = async (
      promise: ReturnType<typeof acquireResearchRunLockInternal>,
    ): Promise<Outcome> => promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    const aOutcome = settle(acquireResearchRunLockInternal(root, { executionEpoch: 5 }, overlappingHooks("a")));
    const bOutcome = settle(acquireResearchRunLockInternal(root, { executionEpoch: 5 }, overlappingHooks("b")));
    await mkdirWinnerOpenedState;
    const loser = mkdirWinner === "a" ? "b" : "a";
    const loserOutcome = await (loser === "a" ? aOutcome : bOutcome);
    releaseMkdirWinner();
    const winnerOutcome = await (mkdirWinner === "a" ? aOutcome : bOutcome);
    if (loserOutcome.status === "fulfilled") await loserOutcome.value.release();
    if (winnerOutcome.status === "fulfilled") await winnerOutcome.value.release();
    await root.close();

    expect(loserOutcome.status).toBe("fulfilled");
    const rootSync = phases[loser].indexOf("after-root-directory-sync");
    const lockOpen = phases[loser].indexOf("before-lock-open");
    expect(rootSync).toBeGreaterThanOrEqual(0);
    expect(lockOpen).toBeGreaterThan(rootSync);
    expect(winnerOutcome).toEqual({ status: "rejected", reason: expectCode("lock.conflict") });
  });

  test("rejects forged and proxied test-hook capabilities before state I/O", async () => {
    const root = await fixture();
    const authentic = hooks();
    const forged = Object.freeze({ capabilityKind: "research-run-lock-test-hooks" as const });
    const proxied = new Proxy(authentic, {});

    for (const capability of [forged, proxied]) {
      await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, capability)).rejects.toEqual(
        expectCode("lock.invalid-input"),
      );
      await expect(lstat(join(root.path, ".state"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await root.close();
  });

  test("closePreservingLock retains the lock while consuming its close fault once", async () => {
    const root = await fixture();
    const oneShot = createResearchRunLockTestHooksInternal({
      now: () => NOW,
      randomBytes: () => OWNER_TOKEN,
      onCheck: null,
      failAt: "before-descriptor-close",
    });
    const lockPath = join(root.path, ".state", "controller.lock");
    const first = await acquireResearchRunLockInternal(root, { executionEpoch: 11 }, oneShot);

    await expect(first.closePreservingLock()).rejects.toEqual(expectCode("lock.io-failed"));
    expect((await lstat(lockPath)).isFile()).toBe(true);
    await expect(first.release()).rejects.toEqual(expectCode("lock.closed"));
    await rm(lockPath);

    const second = await acquireResearchRunLockInternal(root, { executionEpoch: 11 }, oneShot);
    await second.closePreservingLock();
    expect((await lstat(lockPath)).isFile()).toBe(true);
    await root.close();
  });

  test("rejects closePreservingLock while release owns the lifecycle", async () => {
    const root = await fixture();
    let announceRelease!: () => void;
    const releaseEntered = new Promise<void>((resolve) => { announceRelease = resolve; });
    let continueRelease!: () => void;
    const releaseMayContinue = new Promise<void>((resolve) => { continueRelease = resolve; });
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 12 }, hooks(async (phase) => {
      if (phase !== "before-release-verify") return;
      announceRelease();
      await releaseMayContinue;
    }));
    const releaseOutcome = lock.release().then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await releaseEntered;
    let closeError: unknown;
    try { await lock.closePreservingLock(); } catch (error) { closeError = error; }
    continueRelease();
    const released = await releaseOutcome;

    expect(closeError).toEqual(expectCode("lock.closed"));
    expect(released).toEqual({ status: "fulfilled" });
    await root.close();
  });

  test("never retries a consumed descriptor number after post-close failure", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-close-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    let lockFd: number | undefined;
    let replacementFd: number | undefined;
    let lockCloseAttempts = 0;
    const replacementPath = join(base, "replacement-fd");
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const fd = actualOpenSync(path, flags, mode);
        if (String(path).endsWith("/controller.lock") && (flags & constants.O_CREAT) !== 0) lockFd = fd;
        return fd;
      },
      closeSync(fd: number) {
        if (fd === lockFd && lockCloseAttempts === 0) {
          lockCloseAttempts += 1;
          actualCloseSync(fd);
          replacementFd = actualOpenSync(
            replacementPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
          );
          throw Object.assign(new Error("injected post-close failure"), { code: "EIO" });
        }
        if (fd === lockFd) lockCloseAttempts += 1;
        return actualCloseSync(fd);
      },
    }));

    try {
      const [{ createOwnedRunRoot: createRoot }, lockModule] = await Promise.all([
        import("../../src/storage/run-root.js"),
        import("../../src/storage/run-lock-internal.js"),
      ]);
      root = await createRoot({
        trustedProject: project,
        repositoryRoot: project,
        requestedPath: "owned",
        topic: "run lock close retry",
        runId: RUN_ID,
        ownershipToken: ROOT_TOKEN,
        now: () => NOW,
      });
      const lock = await lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 12 });

      await expect(lock.closePreservingLock()).rejects.toEqual(expectCode("lock.io-failed"));
      expect(replacementFd).toBe(lockFd);
      expect(actualFstatSync(replacementFd!).isFile()).toBe(true);
      await expect(lock.release()).rejects.toEqual(expectCode("lock.closed"));
      await lock.closePreservingLock();
      expect(lockCloseAttempts).toBe(1);
      expect(actualFstatSync(replacementFd!).isFile()).toBe(true);
    } finally {
      if (replacementFd !== undefined) {
        try { actualCloseSync(replacementFd); } catch { /* replacement already closed by faulty retry */ }
      } else if (lockFd !== undefined) {
        try { actualCloseSync(lockFd); } catch { /* original descriptor consumed */ }
      }
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("does not retry a consumed verification descriptor number", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-reopen-close-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    const reopenedFds: number[] = [];
    let injectedFd: number | undefined;
    let replacementFd: number | undefined;
    let injectedCloseAttempts = 0;
    const replacementPath = join(base, "verification-replacement-fd");
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const fd = actualOpenSync(path, flags, mode);
        if (String(path).endsWith("/controller.lock") && (flags & constants.O_CREAT) === 0) {
          reopenedFds.push(fd);
          injectedFd ??= fd;
        }
        return fd;
      },
      closeSync(fd: number) {
        if (fd === injectedFd && injectedCloseAttempts === 0) {
          injectedCloseAttempts += 1;
          actualCloseSync(fd);
          replacementFd = actualOpenSync(
            replacementPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
          );
          throw Object.assign(new Error("injected post-close verification failure"), { code: "EIO" });
        }
        if (fd === injectedFd) injectedCloseAttempts += 1;
        return actualCloseSync(fd);
      },
    }));

    try {
      const [{ createOwnedRunRoot: createRoot }, lockModule] = await Promise.all([
        import("../../src/storage/run-root.js"),
        import("../../src/storage/run-lock-internal.js"),
      ]);
      root = await createRoot({
        trustedProject: project,
        repositoryRoot: project,
        requestedPath: "owned",
        topic: "run lock reopen close",
        runId: RUN_ID,
        ownershipToken: ROOT_TOKEN,
        now: () => NOW,
      });
      await expect(lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 14 })).rejects.toEqual(
        expectCode("lock.io-failed"),
      );

      expect(injectedCloseAttempts).toBe(1);
      expect(replacementFd).toBe(injectedFd);
      expect(actualFstatSync(replacementFd!).isFile()).toBe(true);
    } finally {
      if (replacementFd !== undefined) try { actualCloseSync(replacementFd); } catch { /* faulty retry closed it */ }
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("does not retry a consumed acquisition-cleanup descriptor number", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-acquire-cleanup-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    let lockFd: number | undefined;
    let stateFd: number | undefined;
    let lockRootFd: number | undefined;
    let replacementFd: number | undefined;
    let stateCloseAttempts = 0;
    const replacementPath = join(base, "cleanup-replacement-fd");
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const fd = actualOpenSync(path, flags, mode);
        const text = String(path);
        if (text.endsWith("/controller.lock") && (flags & constants.O_CREAT) !== 0) lockFd = fd;
        else if (text.endsWith("/.state") && (flags & constants.O_DIRECTORY) !== 0) stateFd = fd;
        else if (text.endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) lockRootFd = fd;
        return fd;
      },
      closeSync(fd: number) {
        if (fd === stateFd && stateCloseAttempts === 0) {
          stateCloseAttempts += 1;
          actualCloseSync(fd);
          replacementFd = actualOpenSync(
            replacementPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
          );
          throw Object.assign(new Error("injected post-close cleanup failure"), { code: "EIO" });
        }
        if (fd === stateFd) stateCloseAttempts += 1;
        return actualCloseSync(fd);
      },
    }));

    try {
      const [{ createOwnedRunRoot: createRoot }, lockModule] = await Promise.all([
        import("../../src/storage/run-root.js"),
        import("../../src/storage/run-lock-internal.js"),
      ]);
      root = await createRoot({
        trustedProject: project,
        repositoryRoot: project,
        requestedPath: "owned",
        topic: "run lock acquisition cleanup",
        runId: RUN_ID,
        ownershipToken: ROOT_TOKEN,
        now: () => NOW,
      });
      const failAfterOpen = lockModule.createResearchRunLockTestHooksInternal({
        now: () => NOW,
        randomBytes: () => OWNER_TOKEN,
        onCheck: null,
        failAt: "after-lock-open",
      });

      await expect(lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 15 }, failAfterOpen)).rejects.toEqual(
        expectCode("lock.io-failed"),
      );
      expect(stateCloseAttempts).toBe(1);
      expect(replacementFd).toBe(stateFd);
      expect(actualFstatSync(replacementFd!).isFile()).toBe(true);
      for (const fd of [lockFd!, lockRootFd!]) {
        expect(() => actualFstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      }
    } finally {
      for (const fd of [replacementFd, lockFd, lockRootFd]) {
        if (fd !== undefined) try { actualCloseSync(fd); } catch { /* consumed or closed by faulty retry */ }
      }
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("release never retries a consumed descriptor number", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-release-close-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    let lockFd: number | undefined;
    let stateFd: number | undefined;
    let lockRootFd: number | undefined;
    let replacementFd: number | undefined;
    let stateCloseAttempts = 0;
    const replacementPath = join(base, "release-replacement-fd");
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const fd = actualOpenSync(path, flags, mode);
        const text = String(path);
        if (text.endsWith("/controller.lock") && (flags & constants.O_CREAT) !== 0) lockFd = fd;
        else if (text.endsWith("/.state") && (flags & constants.O_DIRECTORY) !== 0) stateFd = fd;
        else if (text.endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) lockRootFd = fd;
        return fd;
      },
      closeSync(fd: number) {
        if (fd === stateFd && stateCloseAttempts === 0) {
          stateCloseAttempts += 1;
          actualCloseSync(fd);
          replacementFd = actualOpenSync(
            replacementPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
            0o600,
          );
          throw Object.assign(new Error("injected post-close state failure"), { code: "EIO" });
        }
        if (fd === stateFd) stateCloseAttempts += 1;
        return actualCloseSync(fd);
      },
    }));

    try {
      const [{ createOwnedRunRoot: createRoot }, lockModule] = await Promise.all([
        import("../../src/storage/run-root.js"),
        import("../../src/storage/run-lock-internal.js"),
      ]);
      root = await createRoot({
        trustedProject: project,
        repositoryRoot: project,
        requestedPath: "owned",
        topic: "run lock release close retry",
        runId: RUN_ID,
        ownershipToken: ROOT_TOKEN,
        now: () => NOW,
      });
      const lock = await lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 13 });
      const lockPath = join(root.path, ".state", "controller.lock");

      await expect(lock.release()).rejects.toEqual(expectCode("lock.io-failed"));
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => actualFstatSync(lockFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(replacementFd).toBe(stateFd);
      expect(actualFstatSync(replacementFd!).isFile()).toBe(true);
      expect(() => actualFstatSync(lockRootFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));

      await lock.release();
      expect(stateCloseAttempts).toBe(1);
      expect(actualFstatSync(replacementFd!).isFile()).toBe(true);
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const fd of [replacementFd, lockFd, lockRootFd]) {
        if (fd !== undefined) try { actualCloseSync(fd); } catch { /* consumed or closed by faulty retry */ }
      }
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  test("validates the exact options shape before filesystem I/O", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    const invalid: unknown[] = [
      {},
      { executionEpoch: -1 },
      { executionEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { executionEpoch: 0, extra: true },
      Object.create({ executionEpoch: 0 }),
      new Proxy({ executionEpoch: 0 }, {}),
      Object.defineProperty({}, "executionEpoch", { enumerable: true, get: () => 0 }),
      { executionEpoch: 0, [Symbol("extra")]: true },
    ];

    for (const options of invalid) {
      await expect(acquireResearchRunLockInternal(root, options as { executionEpoch: number }, hooks())).rejects.toEqual(
        expectCode("lock.invalid-input"),
      );
      await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await root.close();
  });

  test("Linux state creation mutates only the descriptor-anchored root", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-linux-state-create-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    const anchoredRoot = join(project, "owned");
    const movedRoot = join(project, "owned-original");
    let raced = false;
    const hostPlatform = process.platform;
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const rootModule = await import("../../src/storage/run-root.js");
    root = await rootModule.createOwnedRunRoot({
      trustedProject: project,
      repositoryRoot: project,
      requestedPath: "owned",
      topic: "linux anchored state creation",
      runId: RUN_ID,
      ownershipToken: ROOT_TOKEN,
      now: () => NOW,
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const translateProcChild = (path: Parameters<typeof actualOpenSync>[0]) => {
      if (hostPlatform === "linux") return path;
      const text = String(path);
      const match = /^\/proc\/self\/fd\/[0-9]+\/(.+)$/.exec(text);
      return match ? join(raced ? movedRoot : anchoredRoot, match[1]!) : path;
    };
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        return actualOpenSync(translateProcChild(path), flags, mode);
      },
      mkdirSync(path: Parameters<typeof actualFs.mkdirSync>[0], options?: Parameters<typeof actualFs.mkdirSync>[1]) {
        const text = String(path);
        if (!raced && text.endsWith("/.state")) {
          raced = true;
          actualFs.renameSync(anchoredRoot, movedRoot);
          actualFs.mkdirSync(anchoredRoot, { mode: 0o700 });
        }
        return actualFs.mkdirSync(translateProcChild(path), options as never);
      },
    }));

    try {
      const lockModule = await import("../../src/storage/run-lock-internal.js");
      await expect(lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 18 })).rejects.toBeInstanceOf(
        lockModule.ResearchRunLockError,
      );
      expect(raced).toBe(true);
      expect((await lstat(join(movedRoot, ".state"))).isDirectory()).toBe(true);
      await expect(lstat(join(anchoredRoot, ".state"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs");
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  test("Linux state open adopts only the descriptor-anchored directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-run-lock-linux-state-open-"));
    temporaryRoots.push(base);
    const project = join(base, "project");
    await mkdir(project);
    const anchoredRoot = join(project, "owned");
    const movedRoot = join(project, "owned-original");
    let raced = false;
    const hostPlatform = process.platform;
    let openedState: ReturnType<typeof actualFstatSync> | undefined;
    let originalState: Awaited<ReturnType<typeof lstat>> | undefined;
    let root: OwnedRunRoot | undefined;
    vi.resetModules();
    const rootModule = await import("../../src/storage/run-root.js");
    root = await rootModule.createOwnedRunRoot({
      trustedProject: project,
      repositoryRoot: project,
      requestedPath: "owned",
      topic: "linux anchored state open",
      runId: RUN_ID,
      ownershipToken: ROOT_TOKEN,
      now: () => NOW,
    });
    await mkdir(join(anchoredRoot, ".state"), { mode: 0o700 });
    originalState = await lstat(join(anchoredRoot, ".state"));
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const translateProcChild = (path: Parameters<typeof actualOpenSync>[0]) => {
      if (hostPlatform === "linux") return path;
      const text = String(path);
      const match = /^\/proc\/self\/fd\/[0-9]+\/(.+)$/.exec(text);
      return match ? join(raced ? movedRoot : anchoredRoot, match[1]!) : path;
    };
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync(path: Parameters<typeof actualOpenSync>[0], flags: number, mode?: number) {
        const text = String(path);
        if (!raced && text.endsWith("/.state") && (flags & constants.O_DIRECTORY) !== 0) {
          raced = true;
          actualFs.renameSync(anchoredRoot, movedRoot);
          actualFs.mkdirSync(anchoredRoot, { mode: 0o700 });
          actualFs.mkdirSync(join(anchoredRoot, ".state"), { mode: 0o700 });
        }
        const fd = actualOpenSync(translateProcChild(path), flags, mode);
        if (text.endsWith("/.state") && (flags & constants.O_DIRECTORY) !== 0) openedState = actualFstatSync(fd);
        return fd;
      },
    }));

    try {
      const lockModule = await import("../../src/storage/run-lock-internal.js");
      await expect(lockModule.acquireResearchRunLockInternal(root, { executionEpoch: 19 })).rejects.toBeInstanceOf(
        lockModule.ResearchRunLockError,
      );
      expect(raced).toBe(true);
      expect(openedState).toMatchObject({ dev: originalState.dev, ino: originalState.ino });
      await expect(lstat(join(anchoredRoot, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await root?.close().catch(() => undefined);
      vi.doUnmock("node:fs");
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  test("rejects a symlinked state directory without publishing through it", async () => {
    const root = await fixture();
    const target = join(root.path, "state-target");
    const statePath = join(root.path, ".state");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, statePath);

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks())).rejects.toEqual(
      expectCode("lock.symlink"),
    );
    expect((await lstat(statePath)).isSymbolicLink()).toBe(true);
    await expect(lstat(join(target, "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await root.close();
  });

  test("rejects a symlinked lock without changing its target", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    const target = join(root.path, "lock-target");
    const lockPath = join(statePath, "controller.lock");
    await mkdir(statePath, { mode: 0o700 });
    await writeFile(target, "sentinel", { mode: 0o600 });
    await symlink(target, lockPath);

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks())).rejects.toEqual(
      expectCode("lock.symlink"),
    );
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("sentinel");
    await root.close();
  });

  test("rejects a multiply-linked lock without replacing either link", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    const target = join(root.path, "lock-target");
    const lockPath = join(statePath, "controller.lock");
    await mkdir(statePath, { mode: 0o700 });
    await writeFile(target, "sentinel", { mode: 0o600 });
    await link(target, lockPath);

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks())).rejects.toEqual(
      expectCode("lock.unsafe-link"),
    );
    expect((await lstat(target)).nlink).toBe(2);
    expect((await lstat(lockPath)).nlink).toBe(2);
    expect(await readFile(lockPath, "utf8")).toBe("sentinel");
    await root.close();
  });

  test("rejects unsafe existing state directories before lock creation", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    await mkdir(statePath, { mode: 0o755 });
    await chmod(statePath, 0o755);

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks())).rejects.toEqual(
      expectCode("lock.state-invalid"),
    );
    await expect(lstat(join(statePath, "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await root.close();
  });

  test("classifies a non-directory state path as invalid before lock I/O", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    await writeFile(statePath, "not a directory");

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks())).rejects.toEqual(
      expectCode("lock.state-invalid"),
    );
    expect(await readFile(statePath, "utf8")).toBe("not a directory");
    await root.close();
  });

  test("revalidates authentic root ownership after test-hook boundaries", async () => {
    const root = await fixture();
    const markerPath = join(root.path, ".pi-science-research-owner.json");
    let changed = false;

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks(async (phase) => {
      if (phase !== "after-state-open" || changed) return;
      changed = true;
      const marker = await readFile(markerPath, "utf8");
      await writeFile(markerPath, marker.replace("12:34:56.000Z", "12:34:57.000Z"));
    }))).rejects.toEqual(expectCode("lock.replaced"));
    expect(changed).toBe(true);
    await expect(lstat(join(root.path, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await root.close();
  });

  test("rejects replacement of the pinned state directory", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    let replaced = false;

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks(async (phase) => {
      if (phase !== "after-state-open" || replaced) return;
      replaced = true;
      await rename(statePath, join(root.path, ".state-original"));
      await mkdir(statePath, { mode: 0o700 });
    }))).rejects.toEqual(expectCode("lock.replaced"));
    expect(replaced).toBe(true);
    await expect(lstat(join(statePath, "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await root.close();
  });

  test("rejects non-file lock pathnames without changing them", async () => {
    const root = await fixture();
    const statePath = join(root.path, ".state");
    const lockPath = join(statePath, "controller.lock");
    await mkdir(lockPath, { recursive: true, mode: 0o700 });

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, hooks())).rejects.toEqual(
      expectCode("lock.conflict"),
    );
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    await root.close();
  });

  test.each([
    new Date(Number.NaN),
    Object.create(Date.prototype) as Date,
  ])("rejects an invalid acquired-at source as invalid input", async (invalidNow) => {
    const root = await fixture();
    const invalidHooks = createResearchRunLockTestHooksInternal({
      now: () => invalidNow,
      randomBytes: () => OWNER_TOKEN,
      onCheck: null,
      failAt: null,
    });

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 0 }, invalidHooks)).rejects.toEqual(
      expectCode("lock.invalid-input"),
    );
    await expect(lstat(join(root.path, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await root.close();
  });

  test.each([Number.NaN, 1.5, "1", null])(
    "rejects invalid execution epoch %j before state I/O",
    async (executionEpoch) => {
      const root = await fixture();
      await expect(acquireResearchRunLockInternal(
        root,
        { executionEpoch } as { executionEpoch: number },
        hooks(),
      )).rejects.toEqual(expectCode("lock.invalid-input"));
      await expect(lstat(join(root.path, ".state"))).rejects.toMatchObject({ code: "ENOENT" });
      await root.close();
    },
  );

  test("rejects replay by pathname replacement even when the record bytes are authentic", async () => {
    const root = await fixture();
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 20 }, hooks());
    const lockPath = join(root.path, ".state", "controller.lock");
    const replay = await readFile(lockPath);
    await rename(lockPath, `${lockPath}.owned`);
    await writeFile(lockPath, replay, { mode: 0o600 });

    await expect(lock.release()).rejects.toEqual(expectCode("lock.replaced"));
    expect(await readFile(lockPath)).toEqual(replay);
    await lock.closePreservingLock();
    await root.close();
  });

  test.each(["root", "state", "lock"] as const)(
    "release fails closed after %s pathname replacement",
    async (target) => {
      const root = await fixture();
      const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 21 }, hooks());
      const statePath = join(root.path, ".state");
      const lockPath = join(statePath, "controller.lock");
      if (target === "root") {
        await rename(root.path, `${root.path}.owned`);
        await mkdir(root.path, { mode: 0o700 });
      } else if (target === "state") {
        await rename(statePath, `${statePath}.owned`);
        await mkdir(statePath, { mode: 0o700 });
      } else {
        const bytes = await readFile(lockPath);
        await rename(lockPath, `${lockPath}.owned`);
        await writeFile(lockPath, bytes, { mode: 0o600 });
      }

      await expect(lock.release()).rejects.toEqual(expectCode("lock.replaced"));
      await lock.closePreservingLock();
      await root.close();
    },
  );

  test("serializes concurrent release and keeps repeated release idempotent", async () => {
    const root = await fixture();
    const phases: ResearchRunLockPhaseInternal[] = [];
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 22 }, hooks((phase) => {
      phases.push(phase);
    }));

    await Promise.all([lock.release(), lock.release(), lock.release()]);
    await lock.release();
    expect(phases.filter((phase) => phase === "before-lock-unlink")).toHaveLength(1);
    expect(phases.filter((phase) => phase === "before-descriptor-close")).toHaveLength(1);
    await root.close();
  });

  test.each([
    "before-state-create",
    "after-state-open",
    "after-root-directory-sync",
    "before-lock-open",
    "after-lock-open",
    "after-lock-write",
    "after-lock-sync",
    "after-state-publication-sync",
  ] as const)("consumes acquisition phase fault once at %s", async (failAt) => {
    const root = await fixture();
    const oneShot = createResearchRunLockTestHooksInternal({
      now: () => NOW,
      randomBytes: () => OWNER_TOKEN,
      onCheck: null,
      failAt,
    });
    const lockPath = join(root.path, ".state", "controller.lock");

    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 23 }, oneShot)).rejects.toEqual(
      expectCode("lock.io-failed"),
    );
    await rm(lockPath, { force: true });
    const recovered = await acquireResearchRunLockInternal(root, { executionEpoch: 23 }, oneShot);
    await recovered.release();
    await root.close();
  });

  test.each([
    "before-release-verify",
    "before-lock-unlink",
    "after-lock-unlink",
    "after-state-release-sync",
    "before-descriptor-close",
  ] as const)("consumes release phase fault once at %s and finishes on retry", async (failAt) => {
    const root = await fixture();
    const oneShot = createResearchRunLockTestHooksInternal({
      now: () => NOW,
      randomBytes: () => OWNER_TOKEN,
      onCheck: null,
      failAt,
    });
    const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 24 }, oneShot);
    const lockPath = join(root.path, ".state", "controller.lock");

    await expect(lock.release()).rejects.toEqual(expectCode("lock.io-failed"));
    await lock.release();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await root.close();
  });

  test("authentically observes exact lock descriptor retention without a loader seam", async () => {
    const root = await fixture();
    const observer = createResearchRunLockRetentionObserverInternal();
    const forged = Object.freeze({ capabilityKind: "research-run-lock-retention-observer" as const });
    expect(Object.isFrozen(observer)).toBe(true);
    expect(() => getResearchRunLockRetentionCountsInternal(forged as never)).toThrow(expectCode("lock.invalid-input"));
    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 25 }, undefined, forged as never)).rejects.toEqual(
      expectCode("lock.invalid-input"),
    );
    await expect(lstat(join(root.path, ".state"))).rejects.toMatchObject({ code: "ENOENT" });

    const closeFault = createResearchRunLockTestHooksInternal({
      now: () => NOW,
      randomBytes: () => OWNER_TOKEN,
      onCheck: null,
      failAt: "before-descriptor-close",
    });
    const released = await acquireResearchRunLockInternal(root, { executionEpoch: 25 }, closeFault, observer);
    expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 3 });
    expect(Object.isFrozen(getResearchRunLockRetentionCountsInternal(observer))).toBe(true);
    await expect(released.release()).rejects.toEqual(expectCode("lock.io-failed"));
    expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 3 });
    await released.release();
    expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });

    for (const failAt of [
      "before-release-verify", "before-lock-unlink", "after-lock-unlink",
      "after-state-release-sync", "before-descriptor-close",
    ] as const) {
      const preservingCloseFault = createResearchRunLockTestHooksInternal({
        now: () => NOW,
        randomBytes: () => OWNER_TOKEN,
        onCheck: null,
        failAt,
      });
      const preserving = await acquireResearchRunLockInternal(root, { executionEpoch: 26 }, preservingCloseFault, observer);
      await expect(preserving.release()).rejects.toEqual(expectCode("lock.io-failed"));
      expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 3 });
      await preserving.closePreservingLock();
      expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });
      await rm(join(root.path, ".state", "controller.lock"), { force: true });
    }

    for (const [failAt, expectedRetained] of [
      ["after-state-open", 2],
      ["after-lock-open", 3],
      ["after-lock-write", 3],
      ["after-lock-sync", 3],
    ] as const) {
      let observed = -1;
      const acquisitionFault = createResearchRunLockTestHooksInternal({
        now: () => NOW,
        randomBytes: () => OWNER_TOKEN,
        onCheck: (phase) => {
          if (phase === failAt) observed = getResearchRunLockRetentionCountsInternal(observer).descriptors;
        },
        failAt,
      });
      await expect(acquireResearchRunLockInternal(root, { executionEpoch: 26 }, acquisitionFault, observer)).rejects.toEqual(
        expectCode("lock.io-failed"),
      );
      expect(observed).toBe(expectedRetained);
      expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });
      await rm(join(root.path, ".state", "controller.lock"), { force: true });
    }

    const lockPath = join(root.path, ".state", "controller.lock");
    const replacedLockPath = `${lockPath}.verification-owned`;
    let verificationRetained = -1;
    const verificationFault = createResearchRunLockTestHooksInternal({
      now: () => NOW,
      randomBytes: () => OWNER_TOKEN,
      onCheck: async (phase) => {
        if (phase !== "after-state-publication-sync") return;
        verificationRetained = getResearchRunLockRetentionCountsInternal(observer).descriptors;
        const bytes = await readFile(lockPath);
        await rename(lockPath, replacedLockPath);
        await writeFile(lockPath, bytes, { mode: 0o600 });
      },
      failAt: null,
    });
    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 26 }, verificationFault, observer)).rejects.toEqual(
      expectCode("lock.replaced"),
    );
    expect(verificationRetained).toBe(3);
    expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });
    await rm(lockPath);
    await rm(replacedLockPath);

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 26 + cycle }, undefined, observer);
      expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 3 });
      await lock.closePreservingLock();
      expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });
      await rm(join(root.path, ".state", "controller.lock"));
    }
    const stale = await acquireResearchRunLockInternal(root, { executionEpoch: 126 }, undefined, observer);
    await stale.closePreservingLock();
    expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });
    await expect(acquireResearchRunLockInternal(root, { executionEpoch: 127 }, undefined, observer)).rejects.toEqual(
      expectCode("lock.conflict"),
    );
    expect(getResearchRunLockRetentionCountsInternal(observer)).toEqual({ descriptors: 0 });
    await root.close();
  });

  test.each(["now", "randomBytes", "onCheck"] as const)(
    "redacts a malicious exported lock error thrown by the %s callback",
    async (seam) => {
      const root = await fixture();
      const secret = `SECRET:${seam}:${root.path}:${ROOT_TOKEN}`;
      const malicious = () => { throw new ResearchRunLockError(secret as never); };
      const maliciousHooks = createResearchRunLockTestHooksInternal({
        now: seam === "now" ? malicious : () => NOW,
        randomBytes: seam === "randomBytes" ? malicious : () => OWNER_TOKEN,
        onCheck: seam === "onCheck" ? malicious : null,
        failAt: null,
      });

      let caught: unknown;
      try { await acquireResearchRunLockInternal(root, { executionEpoch: 128 }, maliciousHooks); } catch (error) { caught = error; }
      await root.close();
      expect(caught).toBeInstanceOf(ResearchRunLockError);
      expect((caught as ResearchRunLockError).code).toBe("lock.io-failed");
      expect((caught as Error).message).toBe("Research run lock failed (lock.io-failed)");
      expect(JSON.stringify(caught)).not.toContain(secret);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(caught as object))) {
        if ("value" in descriptor && typeof descriptor.value === "string") expect(descriptor.value).not.toContain(secret);
      }
    },
  );

  test("redacts callback, path, token, and injected I/O details", async () => {
    const root = await fixture();
    const secret = `SECRET:${root.path}:${ROOT_TOKEN}`;
    const secretHooks = hooks(() => { throw Object.assign(new Error(secret), { path: secret }); });

    let caught: unknown;
    try { await acquireResearchRunLockInternal(root, { executionEpoch: 128 }, secretHooks); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ResearchRunLockError);
    expect(String((caught as Error).message)).toBe("Research run lock failed (lock.io-failed)");
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(Reflect.ownKeys(caught as object)).toEqual(expect.arrayContaining(["stack", "message", "name", "code"]));
    expect(Reflect.ownKeys(caught as object)).not.toContain("path");
    await root.close();
  });
});
