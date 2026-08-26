import {
  closeSync as realCloseSync,
  constants,
  fstatSync as realFstatSync,
  openSync as realOpenSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

const roots: string[] = [];
const RUN_ID = "run-0123456789abcdef" as const;
const TOKEN = "a".repeat(64);

async function projectFixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pi-run-root-sync-pin-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return project;
}

function options(project: string) {
  return {
    trustedProject: project,
    repositoryRoot: project,
    requestedPath: "owned",
    topic: "sync pin",
    runId: RUN_ID,
    ownershipToken: TOKEN,
    now: () => new Date("2026-08-25T12:34:56.000Z"),
  };
}

afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("fails creation when the immediate synchronous directory open fails", async () => {
  const project = await projectFixture();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let attempted = false;
  vi.doMock("node:fs", () => ({
    ...realFs,
    openSync(path: Parameters<typeof realOpenSync>[0], flags: number, mode?: number) {
      if (String(path).endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) {
        attempted = true;
        throw Object.assign(new Error("injected sync open failure"), { code: "EIO" });
      }
      return realOpenSync(path, flags, mode);
    },
  }));

  const { createOwnedRunRoot } = await import("../../src/storage/run-root.js");
  await expect(createOwnedRunRoot(options(project))).rejects.toMatchObject({ code: "run-root.io-failed" });
  expect(attempted).toBe(true);
});

test("retains the original synchronous pin until OwnedRunRoot.close and closes it once", async () => {
  const project = await projectFixture();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let pinnedFd: number | undefined;
  let pinCloses = 0;
  vi.doMock("node:fs", () => ({
    ...realFs,
    openSync(path: Parameters<typeof realOpenSync>[0], flags: number, mode?: number) {
      const fd = realOpenSync(path, flags, mode);
      if (String(path).endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) pinnedFd = fd;
      return fd;
    },
    closeSync(fd: number) {
      if (fd === pinnedFd) pinCloses += 1;
      return realCloseSync(fd);
    },
  }));

  const { createOwnedRunRoot } = await import("../../src/storage/run-root.js");
  const owned = await createOwnedRunRoot(options(project));
  expect(pinnedFd).toBeTypeOf("number");
  expect(realFstatSync(pinnedFd!).isDirectory()).toBe(true);
  expect(pinCloses).toBe(0);
  await owned.close();
  await owned.close();
  expect(pinCloses).toBe(1);
  expect(() => realFstatSync(pinnedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

test("retains registration after a close failure and releases it after a successful retry", async () => {
  const project = await projectFixture();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let pinnedFd: number | undefined;
  let attempts = 0;
  vi.doMock("node:fs", () => ({
    ...realFs,
    openSync(path: Parameters<typeof realOpenSync>[0], flags: number, mode?: number) {
      const fd = realOpenSync(path, flags, mode);
      if (String(path).endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) pinnedFd = fd;
      return fd;
    },
    closeSync(fd: number) {
      if (fd === pinnedFd && attempts++ === 0) throw Object.assign(new Error("injected close failure"), { code: "EIO" });
      return realCloseSync(fd);
    },
  }));

  const { createOwnedRunRoot, openOwnedRunRoot } = await import("../../src/storage/run-root.js");
  const owned = await createOwnedRunRoot(options(project));
  await expect(owned.close()).rejects.toThrow("injected close failure");
  expect(realFstatSync(pinnedFd!).isDirectory()).toBe(true);
  await expect(openOwnedRunRoot(owned.path, RUN_ID, TOKEN)).rejects.toMatchObject({ code: "run-root.already-open" });
  await owned.close();
  const reopened = await openOwnedRunRoot(owned.path, RUN_ID, TOKEN);
  await reopened.close();
  expect(attempts).toBe(2);
});

test("treats an actual close followed by an error as confirmed closure", async () => {
  const project = await projectFixture();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let pinnedFd: number | undefined;
  let injected = false;
  vi.doMock("node:fs", () => ({
    ...realFs,
    openSync(path: Parameters<typeof realOpenSync>[0], flags: number, mode?: number) {
      const fd = realOpenSync(path, flags, mode);
      if (String(path).endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) pinnedFd = fd;
      return fd;
    },
    closeSync(fd: number) {
      realCloseSync(fd);
      if (fd === pinnedFd && !injected) {
        injected = true;
        throw Object.assign(new Error("post-close failure"), { code: "EIO" });
      }
    },
  }));

  const { createOwnedRunRoot, openOwnedRunRoot } = await import("../../src/storage/run-root.js");
  const owned = await createOwnedRunRoot(options(project));
  await owned.close();
  expect(() => realFstatSync(pinnedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  const reopened = await openOwnedRunRoot(owned.path, RUN_ID, TOKEN);
  await reopened.close();
});

test("serializes concurrent closes into one successful descriptor release", async () => {
  const project = await projectFixture();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let pinnedFd: number | undefined;
  let closes = 0;
  vi.doMock("node:fs", () => ({
    ...realFs,
    openSync(path: Parameters<typeof realOpenSync>[0], flags: number, mode?: number) {
      const fd = realOpenSync(path, flags, mode);
      if (String(path).endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) pinnedFd = fd;
      return fd;
    },
    closeSync(fd: number) {
      if (fd === pinnedFd) closes += 1;
      return realCloseSync(fd);
    },
  }));

  const { createOwnedRunRoot, openOwnedRunRoot } = await import("../../src/storage/run-root.js");
  const owned = await createOwnedRunRoot(options(project));
  await Promise.all([owned.close(), owned.close(), owned.close()]);
  expect(closes).toBe(1);
  const reopened = await openOwnedRunRoot(owned.path, RUN_ID, TOKEN);
  await reopened.close();
});

test("closes the immediate descriptor when synchronous fstat fails", async () => {
  const project = await projectFixture();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let pinnedFd: number | undefined;
  vi.doMock("node:fs", () => ({
    ...realFs,
    openSync(path: Parameters<typeof realOpenSync>[0], flags: number, mode?: number) {
      const fd = realOpenSync(path, flags, mode);
      if (String(path).endsWith("/owned") && (flags & constants.O_DIRECTORY) !== 0) pinnedFd = fd;
      return fd;
    },
    fstatSync(fd: number, options?: Parameters<typeof realFstatSync>[1]) {
      if (fd === pinnedFd) throw Object.assign(new Error("injected sync fstat failure"), { code: "EIO" });
      return realFstatSync(fd, options);
    },
  }));

  const { createOwnedRunRoot } = await import("../../src/storage/run-root.js");
  await expect(createOwnedRunRoot(options(project))).rejects.toMatchObject({ code: "run-root.io-failed" });
  expect(pinnedFd).toBeTypeOf("number");
  expect(() => realFstatSync(pinnedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
});
