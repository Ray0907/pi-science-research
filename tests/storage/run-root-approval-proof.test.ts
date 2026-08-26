import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

const roots: string[] = [];
const RUN_ID = "run-0123456789abcdef" as const;
const TOKEN = "a".repeat(64);

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("rejects injected higher-ancestor ctime change with unchanged inode and mode", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-approval-proof-"));
  roots.push(base);
  const project = join(base, "project");
  const high = join(base, "approved-high");
  const low = join(high, "low");
  await mkdir(project);
  await mkdir(low, { recursive: true });
  const canonicalHigh = await realpath(high);

  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let inject = false;
  vi.doMock("node:fs/promises", () => ({
    ...actual,
    async lstat(path: string, options?: { bigint?: boolean }) {
      const info = await actual.lstat(path, options as never);
      if (String(path) !== canonicalHigh || !inject) return info;
      const changed = Object.assign(Object.create(Object.getPrototypeOf(info)), info) as typeof info & {
        ctimeMs: number | bigint;
        ctimeNs?: bigint;
      };
      Reflect.set(changed, "ctimeMs", typeof changed.ctimeMs === "bigint" ? changed.ctimeMs + 1n : changed.ctimeMs + 1);
      if (typeof changed.ctimeNs === "bigint") Reflect.set(changed, "ctimeNs", changed.ctimeNs + 1n);
      return changed;
    },
  }));

  const { createOwnedRunRoot } = await import("../../src/storage/run-root.js");
  await expect(createOwnedRunRoot({
    trustedProject: project,
    repositoryRoot: project,
    topic: "proof",
    runId: RUN_ID,
    ownershipToken: TOKEN,
    requestedPath: join(low, "run"),
    allowAbsoluteRequestedPath: true,
    approvedOutsideRoots: [high],
    now: () => new Date("2026-08-25T12:34:56.000Z"),
    onCheck: (phase: string) => { if (phase === "before-create") inject = true; },
  })).rejects.toMatchObject({ code: "run-root.replaced" });
});
