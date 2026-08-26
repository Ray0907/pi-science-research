import { fstatSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

const RUN_ID = "run-0123456789abcdef" as const;
const TOKEN = "a".repeat(64);
const roots: string[] = [];

async function fixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pi-contained-close-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return project;
}

function createOptions(project: string) {
  return {
    trustedProject: project,
    repositoryRoot: project,
    topic: "contained close",
    runId: RUN_ID,
    ownershipToken: TOKEN,
    now: () => new Date("2026-08-25T12:34:56.000Z"),
  };
}

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadWithParentClose(
  behavior: (realClose: () => Promise<void>, attempt: number) => Promise<void>,
): Promise<{ module: typeof import("../../src/storage/run-root.js"); attempts: () => number }> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let attempts = 0;
  vi.doMock("node:fs/promises", () => ({
    ...actual,
    async open(path: string, flags: number, mode?: number) {
      const handle = await actual.open(path, flags, mode);
      if (String(path).endsWith("/.state")) {
        const realClose = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: () => behavior(realClose, attempts++),
        });
      }
      return handle;
    },
  }));
  return {
    module: await import("../../src/storage/run-root.js"),
    attempts: () => attempts,
  };
}

test("authorization close failure retains its descriptor and retries after root close", async () => {
  const project = await fixture();
  const loaded = await loadWithParentClose(async (realClose, attempt) => {
    if (attempt === 0) throw Object.assign(new Error("injected parent close failure"), { code: "EIO" });
    await realClose();
  });
  const owned = await loaded.module.createOwnedRunRoot(createOptions(project));
  const state = join(owned.path, ".state");
  await mkdir(state);
  const authorization = await loaded.module.assertContainedWrite(owned, join(state, "file"));

  await expect(authorization.close()).rejects.toThrow("injected parent close failure");
  expect(fstatSync(authorization.parentFd).isDirectory()).toBe(true);
  await owned.close();
  await authorization.close();
  expect(() => fstatSync(authorization.parentFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(loaded.attempts()).toBe(2);
});

test("authorization close confirms actual close followed by an error", async () => {
  const project = await fixture();
  const loaded = await loadWithParentClose(async (realClose) => {
    await realClose();
    throw Object.assign(new Error("post-close parent error"), { code: "EIO" });
  });
  const owned = await loaded.module.createOwnedRunRoot(createOptions(project));
  const state = join(owned.path, ".state");
  await mkdir(state);
  const authorization = await loaded.module.assertContainedWrite(owned, join(state, "file"));

  await authorization.close();
  expect(() => fstatSync(authorization.parentFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  await owned.close();
});

test("concurrent authorization closes perform one descriptor release", async () => {
  const project = await fixture();
  const loaded = await loadWithParentClose(async (realClose) => realClose());
  const owned = await loaded.module.createOwnedRunRoot(createOptions(project));
  const state = join(owned.path, ".state");
  await mkdir(state);
  const authorization = await loaded.module.assertContainedWrite(owned, join(state, "file"));

  await Promise.all([authorization.close(), authorization.close(), authorization.close()]);
  expect(loaded.attempts()).toBe(1);
  expect(() => fstatSync(authorization.parentFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  await owned.close();
});
