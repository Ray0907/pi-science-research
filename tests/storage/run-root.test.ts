import { constants } from "node:fs";
import { spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  RunRootError,
  assertContainedWrite,
  createOwnedRunRoot,
  openOwnedRunRoot,
  revalidateOwnedRunRoot,
} from "../../src/storage/run-root.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import { acquireResearchRunLockInternal } from "../../src/storage/run-lock-internal.js";

const RUN_ID = "run-0123456789abcdef" as const;
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const NOW = new Date("2026-08-25T12:34:56.000Z");
const roots: string[] = [];

async function fixture(): Promise<{ base: string; project: string }> {
  const base = await mkdtemp(join(tmpdir(), "pi-run-root-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return { base, project };
}

function options(project: string, extra: Record<string, unknown> = {}) {
  return {
    trustedProject: project,
    repositoryRoot: project,
    topic: "CRISPR & RNA / review",
    runId: RUN_ID,
    ownershipToken: TOKEN,
    now: () => NOW,
    ...extra,
  };
}

function expectCode(code: string) {
  return expect.objectContaining({ code });
}

function spawnVitestChild(root:string,environment:Readonly<{BARRIER:string;PROJECT:string;RUN_ID:string;TOKEN:string;RESULT:string}>):Promise<void>{
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,[resolve(import.meta.dirname,"../../node_modules/vitest/vitest.mjs"),"run","--root",root,"child.test.ts"],{
      cwd:root,shell:false,
      env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,PATHEXT:process.env.PATHEXT,HOME:root,TMPDIR:root,TMP:root,TEMP:root,BARRIER:environment.BARRIER,PROJECT:environment.PROJECT,RUN_ID:environment.RUN_ID,TOKEN:environment.TOKEN,RESULT:environment.RESULT},
      stdio:["ignore","pipe","pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`child vitest failed (${code}) ${output.slice(-2000)}`));
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createOwnedRunRoot", () => {
  test("creates the deterministic default root and a closed canonical owner marker", async () => {
    const { project } = await fixture();

    const owned = await createOwnedRunRoot(options(project));

    expect(owned.path).toBe(join(await realpath(project), "research", "2026-08-25-crispr-rna-review"));
    expect((await stat(owned.path)).mode & 0o777).toBe(0o700);
    const markerText = await readFile(join(owned.path, ".pi-science-research-owner.json"), "utf8");
    expect(markerText.endsWith("\n")).toBe(true);
    expect(JSON.parse(markerText)).toEqual({
      schemaVersion: 1,
      runId: RUN_ID,
      createdAt: NOW.toISOString(),
      ownershipTokenSha256: sha256Hex(TOKEN),
      rootDevice: String((await stat(owned.path)).dev),
      rootInode: String((await stat(owned.path)).ino),
    });
    expect(markerText).not.toContain(TOKEN);
    await owned.close();
  });

  test("uses deterministic collision suffixes and never adopts an unowned directory", async () => {
    const { project } = await fixture();
    const parent = join(project, "research");
    await mkdir(join(parent, "2026-08-25-topic"), { recursive: true });
    await writeFile(join(parent, "2026-08-25-topic", "unrelated"), "x");

    const first = await createOwnedRunRoot(options(project, { topic: "topic" }));
    const second = await createOwnedRunRoot(options(project, { topic: "topic", ownershipToken: OTHER_TOKEN }));

    expect(first.path.endsWith("2026-08-25-topic-2")).toBe(true);
    expect(second.path.endsWith("2026-08-25-topic-3")).toBe(true);
    await first.close();
    await second.close();
  });

  test.each(["symlink", "directory", "file"] as const)(
    "default creation never clobbers a %s raced into the final candidate",
    async (kind) => {
      const { base, project } = await fixture();
      const canonicalProject = await realpath(project);
      const candidate = join(canonicalProject, "research", "2026-08-25-raced-final");
      const outside = join(base, "outside-racer");
      await mkdir(outside);
      let raced = false;
      const owned = await createOwnedRunRoot(options(project, {
        topic: "raced-final",
        onCheck: async (phase: string) => {
          if (phase !== "after-leaf-candidate-check-before-mkdir" || raced) return;
          raced = true;
          if (kind === "symlink") await symlink(outside, candidate);
          else if (kind === "directory") await mkdir(candidate);
          else await writeFile(candidate, "racer-content");
        },
      }));

      expect(raced).toBe(true);
      expect(owned.path).toBe(`${candidate}-2`);
      const racer = await lstat(candidate);
      expect(kind === "symlink" ? racer.isSymbolicLink() : kind === "directory" ? racer.isDirectory() : racer.isFile()).toBe(true);
      if (kind === "file") expect(await readFile(candidate, "utf8")).toBe("racer-content");
      await owned.close();
    },
  );

  test.each(["symlink", "directory", "file"] as const)(
    "explicit creation rejects and preserves a %s final-path racer",
    async (kind) => {
      const { base, project } = await fixture();
      const canonicalProject = await realpath(project);
      const candidate = join(canonicalProject, "explicit-raced-final");
      const outside = join(base, "outside-explicit-racer");
      await mkdir(outside);
      let raced = false;
      await expect(createOwnedRunRoot(options(project, {
        requestedPath: "explicit-raced-final",
        onCheck: async (phase: string) => {
          if (phase !== "after-leaf-candidate-check-before-mkdir" || raced) return;
          raced = true;
          if (kind === "symlink") await symlink(outside, candidate);
          else if (kind === "directory") await mkdir(candidate);
          else await writeFile(candidate, "explicit-racer-content");
        },
      }))).rejects.toBeInstanceOf(RunRootError);

      expect(raced).toBe(true);
      const racer = await lstat(candidate);
      expect(kind === "symlink" ? racer.isSymbolicLink() : kind === "directory" ? racer.isDirectory() : racer.isFile()).toBe(true);
      if (kind === "file") expect(await readFile(candidate, "utf8")).toBe("explicit-racer-content");
    },
  );

  test("a crash before marker creation leaves an unowned final leaf that is never adopted", async () => {
    const { project } = await fixture();
    let crashed = false;
    await expect(createOwnedRunRoot(options(project, {
      topic: "pre-marker-crash",
      onCheck: async (phase: string) => {
        if (phase === "after-final-leaf-open-before-marker" && !crashed) {
          crashed = true;
          throw new Error("crash");
        }
      },
    }))).rejects.toBeInstanceOf(RunRootError);
    expect(crashed).toBe(true);
    const canonicalProject = await realpath(project);
    const abandoned = join(canonicalProject, "research", "2026-08-25-pre-marker-crash");
    expect((await lstat(abandoned)).isDirectory()).toBe(true);
    await expect(lstat(join(abandoned, ".pi-science-research-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(openOwnedRunRoot(abandoned, RUN_ID, TOKEN)).rejects.toBeInstanceOf(RunRootError);

    const recovered = await createOwnedRunRoot(options(project, { topic: "pre-marker-crash", ownershipToken: OTHER_TOKEN }));
    expect(recovered.path).toBe(`${abandoned}-2`);
    await recovered.close();
  });

  test("concurrent creators receive distinct exclusive roots", async () => {
    const { project } = await fixture();

    const [a, b] = await Promise.all([
      createOwnedRunRoot(options(project, { topic: "same" })),
      createOwnedRunRoot(options(project, { topic: "same", ownershipToken: OTHER_TOKEN })),
    ]);

    expect(new Set([a.path, b.path])).toEqual(new Set([
      join(await realpath(project), "research", "2026-08-25-same"),
      join(await realpath(project), "research", "2026-08-25-same-2"),
    ]));
    await a.close();
    await b.close();
  });

  test("cross-process creators never adopt another process marker", async () => {
    const { base, project } = await fixture();
    const harnessRoot = join(base, "child-harness");
    await mkdir(harnessRoot);
    const barrier = join(harnessRoot, "start");
    const source = resolve("src/storage/run-root.ts");
    const lockSource = resolve("src/storage/run-lock-internal.ts");
    const childTest = join(harnessRoot, "child.test.ts");
    await writeFile(childTest, `
import { test, expect } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createOwnedRunRoot } from ${JSON.stringify(source)};
import { acquireResearchRunLockInternal } from ${JSON.stringify(lockSource)};

test("cross-process create", async () => {
  while (true) {
    try { await stat(process.env.BARRIER!); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const root = await createOwnedRunRoot({
    trustedProject: process.env.PROJECT!, repositoryRoot: process.env.PROJECT!, topic: "cross-process",
    runId: process.env.RUN_ID! as \`run-\${string}\`, ownershipToken: process.env.TOKEN!,
    now: () => new Date("2026-08-25T12:34:56.000Z"),
  });
  const marker = JSON.parse(await readFile(root.path + "/.pi-science-research-owner.json", "utf8"));
  const lock = await acquireResearchRunLockInternal(root, { executionEpoch: 1 });
  await writeFile(process.env.RESULT!, JSON.stringify({ path: root.path, marker }));
  await root.close();
  expect(lock.executionEpoch).toBe(1);
  expect(marker.runId).toBe(process.env.RUN_ID);
});
`);

    const children = [0, 1, 2].map((index) => {
      const runId = `run-${String(index + 1).repeat(16)}`;
      const token = String(index + 1).repeat(64);
      const result = join(harnessRoot, `result-${index}.json`);
      return {
        runId,
        token,
        result,
        completion: spawnVitestChild(harnessRoot, {
          BARRIER: barrier, PROJECT: project, RUN_ID: runId, TOKEN: token, RESULT: result,
        }),
      };
    });
    await writeFile(barrier, "go");
    const completions = await Promise.allSettled(children.map((child) => child.completion));
    const failure = completions.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;

    const records = await Promise.all(children.map(async (child) => ({
      child,
      value: JSON.parse(await readFile(child.result, "utf8")),
    })));
    const canonicalProject = await realpath(project);
    expect(new Set(records.map(({ value }) => value.path))).toEqual(new Set([
      join(canonicalProject, "research", "2026-08-25-cross-process"),
      join(canonicalProject, "research", "2026-08-25-cross-process-2"),
      join(canonicalProject, "research", "2026-08-25-cross-process-3"),
    ]));
    for (const { child, value } of records) {
      expect(value.marker.runId).toBe(child.runId);
      expect(value.marker.ownershipTokenSha256).toBe(sha256Hex(child.token));
      const stalePath = join(value.path, ".state", "controller.lock");
      expect((await lstat(stalePath)).isFile()).toBe(true);
      const opened = await openOwnedRunRoot(value.path, child.runId as `run-${string}`, child.token);
      await expect(acquireResearchRunLockInternal(opened, { executionEpoch: 2 })).rejects.toEqual(
        expectCode("lock.conflict"),
      );
      expect((await lstat(stalePath)).isFile()).toBe(true);
      await opened.close();
    }
  }, 30_000);

  test("generates a cryptographic token through the injected source when omitted", async () => {
    const { project } = await fixture();
    const owned = await createOwnedRunRoot({
      ...options(project),
      ownershipToken: undefined,
      randomBytes: (size: number) => Buffer.alloc(size, 0xcd),
    });
    expect(owned.ownershipToken).toBe("cd".repeat(32));
    await owned.close();
  });

  test.each([
    ["dot traversal", "../outside"],
    ["encoded traversal", "%2e%2e/outside"],
    ["double encoded traversal", "%252e%252e/outside"],
    ["portable backslash", "safe\\outside"],
    ["drive-qualified", "C:/outside"],
    ["nul", "safe\0outside"],
  ])("rejects %s requested paths", async (_name, requestedPath) => {
    const { project } = await fixture();
    await expect(createOwnedRunRoot(options(project, { requestedPath }))).rejects.toEqual(
      expectCode("run-root.invalid-path"),
    );
  });

  test("rejects an absolute requested path when absolute paths are disabled", async () => {
    const { base, project } = await fixture();
    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(base, "outside"),
      allowAbsoluteRequestedPath: false,
    }))).rejects.toEqual(expectCode("run-root.invalid-path"));
  });

  test("rejects filesystem, home, repository, research parent, and known secret roots", async () => {
    const { project } = await fixture();
    await mkdir(join(project, ".git"));
    await mkdir(join(project, ".pi"));
    const candidates = [
      parse(project).root,
      homedir(),
      project,
      join(project, "research"),
      join(project, ".git"),
      join(project, ".pi"),
    ];
    for (const requestedPath of candidates) {
      await expect(createOwnedRunRoot(options(project, {
        requestedPath,
        allowAbsoluteRequestedPath: true,
        approveOutside: async () => true,
      }))).rejects.toBeInstanceOf(RunRootError);
    }
  });

  test("rejects symlink segments and symlink leaves before approval", async () => {
    const { base, project } = await fixture();
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(project, "linked"));
    let approvals = 0;

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(project, "linked", "leaf"),
      allowAbsoluteRequestedPath: true,
      approveOutside: async () => { approvals += 1; return true; },
    }))).rejects.toEqual(expectCode("run-root.symlink"));
    expect(approvals).toBe(0);

    await mkdir(join(project, "real"));
    await symlink(outside, join(project, "real", "leaf"));
    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(project, "real", "leaf"),
      allowAbsoluteRequestedPath: true,
    }))).rejects.toEqual(expectCode("run-root.symlink"));
  });

  test("requires approval for an outside root and supplies the exact canonical path", async () => {
    const { base, project } = await fixture();
    const outside = join(base, "outside");
    await mkdir(outside);
    const candidate = join(outside, "run");
    const seen: string[] = [];

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: candidate,
      allowAbsoluteRequestedPath: true,
      approveOutside: async (path: string) => { seen.push(path); return false; },
    }))).rejects.toEqual(expectCode("run-root.outside-denied"));
    const canonicalCandidate = join(await realpath(outside), "run");
    expect(seen).toEqual([canonicalCandidate]);

    const owned = await createOwnedRunRoot(options(project, {
      requestedPath: candidate,
      allowAbsoluteRequestedPath: true,
      approveOutside: async (path: string) => { seen.push(path); return true; },
    }));
    expect(owned.path).toBe(canonicalCandidate);
    await owned.close();
  });

  test("headless allowlist uses path-segment descendant boundaries", async () => {
    const { base, project } = await fixture();
    const allowed = join(base, "allowed");
    const sibling = join(base, "allowed-confusion");
    await mkdir(allowed);
    await mkdir(sibling);

    const owned = await createOwnedRunRoot(options(project, {
      requestedPath: join(allowed, "child"),
      allowAbsoluteRequestedPath: true,
      approvedOutsideRoots: [allowed],
    }));
    await owned.close();

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(sibling, "child"),
      allowAbsoluteRequestedPath: true,
      approvedOutsideRoots: [allowed],
    }))).rejects.toEqual(expectCode("run-root.outside-denied"));
  });

  test("fails closed when an outside approved ancestor is swapped during approval", async () => {
    const { base, project } = await fixture();
    const outside = join(base, "outside");
    const moved = join(base, "outside-old");
    const replacement = join(base, "replacement");
    await mkdir(outside);
    await mkdir(replacement);

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(outside, "run"),
      allowAbsoluteRequestedPath: true,
      approveOutside: async () => {
        await rename(outside, moved);
        await rename(replacement, outside);
        return true;
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));
  });

  test.each([
    { policy: "interactive", restore: false },
    { policy: "allowlist", restore: true },
  ] as const)("approval proof rejects a $policy ancestor swap at before-create (restore=$restore)", async ({ policy, restore }) => {
    const { base, project } = await fixture();
    const outside = join(base, `outside-${policy}`);
    const moved = join(base, `outside-${policy}-old`);
    const replacement = join(base, `outside-${policy}-replacement`);
    await mkdir(outside);
    await mkdir(replacement);
    let swapped = false;

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(outside, "run"),
      allowAbsoluteRequestedPath: true,
      ...(policy === "interactive"
        ? { approveOutside: async () => true }
        : { approvedOutsideRoots: [outside] }),
      onCheck: async (phase: string) => {
        if (phase !== "before-create" || swapped) return;
        swapped = true;
        await rename(outside, moved);
        await rename(replacement, outside);
        if (restore) {
          await rename(outside, replacement);
          await rename(moved, outside);
        }
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));

    expect(swapped).toBe(true);
    await expect(lstat(join(outside, "run"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(replacement, "run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a higher approved ancestor swap-and-restore before writing", async () => {
    const { base, project } = await fixture();
    const high = join(base, "approved-high");
    const low = join(high, "low");
    const moved = join(base, "approved-high-old");
    const replacement = join(base, "approved-high-replacement");
    await mkdir(low, { recursive: true });
    await mkdir(join(replacement, "low"), { recursive: true });
    let swapped = false;

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(low, "run"),
      allowAbsoluteRequestedPath: true,
      approvedOutsideRoots: [high],
      onCheck: async (phase: string) => {
        if (phase !== "before-create" || swapped) return;
        swapped = true;
        await rename(high, moved);
        await rename(replacement, high);
        await rename(high, replacement);
        await rename(moved, high);
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));
    expect(swapped).toBe(true);
    await expect(lstat(join(low, "run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["leaf-swap-and-restore", "unrelated-parent-metadata"] as const)(
    "does not absorb $kind after the one-time approval advance",
    async (kind) => {
      const { base, project } = await fixture();
      const approved = join(base, `approved-once-${kind}`);
      await mkdir(approved);
      const target = join(approved, "run");
      let mutated = false;

      await expect(createOwnedRunRoot(options(project, {
        requestedPath: target,
        allowAbsoluteRequestedPath: true,
        approvedOutsideRoots: [approved],
        onCheck: async (phase: string) => {
          if (phase !== "after-final-leaf-sync-pin-before-path-check" || mutated) return;
          mutated = true;
          if (kind === "leaf-swap-and-restore") {
            const moved = join(base, "approved-leaf-moved");
            await rename(target, moved);
            await rename(moved, target);
          } else {
            const unrelated = join(approved, "unrelated");
            await mkdir(unrelated);
            await rm(unrelated, { recursive: true });
          }
        },
      }))).rejects.toEqual(expectCode("run-root.replaced"));
      expect(mutated).toBe(true);
    },
  );

  test("rechecks the approved outside chain immediately before exclusive creation", async () => {
    const { base, project } = await fixture();
    const outside = join(base, "outside-late-swap");
    const moved = join(base, "outside-late-swap-old");
    const replacement = join(base, "outside-late-swap-replacement");
    await mkdir(outside);
    await mkdir(replacement);
    let swapped = false;

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(outside, "run"),
      allowAbsoluteRequestedPath: true,
      approveOutside: async () => true,
      onCheck: async (phase: string) => {
        if (phase !== "after-leaf-candidate-check-before-mkdir" || swapped) return;
        swapped = true;
        await rename(outside, moved);
        await rename(replacement, outside);
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));
    expect(swapped).toBe(true);
    await expect(lstat(join(outside, "run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects proxy/accessor options and wraps callback secrets", async () => {
    const { project } = await fixture();
    const proxied = new Proxy(options(project), {});
    await expect(createOwnedRunRoot(proxied)).rejects.toEqual(expectCode("run-root.invalid-options"));

    const accessor = options(project);
    Object.defineProperty(accessor, "topic", { enumerable: true, get: () => "SECRET" });
    await expect(createOwnedRunRoot(accessor)).rejects.toEqual(expectCode("run-root.invalid-options"));

    await expect(createOwnedRunRoot(options(project, {
      now: () => { throw new Error("SECRET_CALLBACK_VALUE"); },
    }))).rejects.toSatisfy((error: unknown) =>
      error instanceof RunRootError && error.code === "run-root.io-failed" && !error.message.includes("SECRET"),
    );
  });

  test("approval and allowlists never override global credential roots", async () => {
    const { project } = await fixture();
    const sshTarget = join(homedir(), ".ssh", "pi-science-research-forbidden");
    let approvals = 0;
    await expect(createOwnedRunRoot(options(project, {
      requestedPath: sshTarget,
      allowAbsoluteRequestedPath: true,
      approvedOutsideRoots: [homedir()],
      approveOutside: async () => { approvals += 1; return true; },
    }))).rejects.toEqual(expectCode("run-root.unsafe-root"));
    expect(approvals).toBe(0);

    await expect(createOwnedRunRoot(options(project, {
      requestedPath: join(homedir(), ".ssh-confusion", "run"),
      allowAbsoluteRequestedPath: true,
      approveOutside: async () => { approvals += 1; return false; },
    }))).rejects.toEqual(expectCode("run-root.outside-denied"));
    expect(approvals).toBe(1);
  });

  test("XDG config roots are globally forbidden", async () => {
    const { base, project } = await fixture();
    const xdg = join(base, "xdg-config");
    await mkdir(xdg);
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await expect(createOwnedRunRoot(options(project, {
        requestedPath: join(xdg, "research-run"),
        allowAbsoluteRequestedPath: true,
        approvedOutsideRoots: [base],
      }))).rejects.toEqual(expectCode("run-root.unsafe-root"));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  test("never adopts a replacement research parent directory", async () => {
    const { base, project } = await fixture();
    let injected = false;
    const research = join(await realpath(project), "research");
    await expect(createOwnedRunRoot(options(project, {
      topic: "research-parent-swap",
      onCheck: async (phase: string) => {
        if (phase !== "after-research-final-open" || injected) return;
        injected = true;
        await rename(research, join(base, "moved-research-parent"));
        await mkdir(research);
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));
    expect(injected).toBe(true);
    expect((await lstat(research)).isDirectory()).toBe(true);
  });

  test.each([
    "after-final-leaf-sync-pin-before-path-check",
    "after-final-leaf-path-check-before-secondary-open",
    "after-final-leaf-secondary-open-before-fstat",
    "after-final-leaf-open-before-marker",
    "before-marker-create",
    "after-marker-pathname-open-before-root-recheck",
    "after-marker-create-before-write",
    "after-marker-write-before-fsync",
    "after-marker-fsync-before-finalization",
    "after-final-open-before-return",
    "after-leaf-parent-synced-before-return",
  ])("never adopts a replacement directory injected at %s", async (phase) => {
    const { base, project } = await fixture();
    let injected = false;
    await expect(createOwnedRunRoot(options(project, {
      topic: `swap-${phase}`,
      onCheck: async (seen: string) => {
        if (seen !== phase || injected) return;
        injected = true;
        const research = join(await realpath(project), "research");
        const entries = await readdir(research);
        const selected = entries.find((entry) => entry.includes(`swap-${phase}`));
        if (!selected) throw new Error("injection target absent");
        const original = join(research, selected);
        const moved = join(base, `moved-${phase}`);
        await rename(original, moved);
        await mkdir(original);
      },
    }))).rejects.toBeInstanceOf(RunRootError);
    expect(injected).toBe(true);
    const research = join(await realpath(project), "research");
    for (const entry of await readdir(research)) {
      if (!entry.includes(`swap-${phase}`)) continue;
      await expect(readFile(join(research, entry, ".pi-science-research-owner.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("rejects marker pathname replacement after descriptor validation during creation", async () => {
    const { project } = await fixture();
    let replaced = false;
    let replacementPath = "";
    await expect(createOwnedRunRoot(options(project, {
      topic: "marker-path-replacement",
      onCheck: async (phase: string) => {
        if (phase !== "after-marker-descriptor-validated-before-path-recheck" || replaced) return;
        replaced = true;
        const research = join(await realpath(project), "research");
        const leaf = (await readdir(research)).find((entry) => entry.includes("marker-path-replacement") && !entry.startsWith(".tmp-"));
        if (!leaf) throw new Error("published leaf absent");
        replacementPath = join(research, leaf, ".pi-science-research-owner.json");
        const bytes = await readFile(replacementPath);
        await rename(replacementPath, `${replacementPath}.moved`);
        await writeFile(replacementPath, bytes);
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));
    expect(replaced).toBe(true);
    expect((await lstat(replacementPath)).isFile()).toBe(true);
    expect((await lstat(`${replacementPath}.moved`)).isFile()).toBe(true);
  });

  test.each(["replacement", "swap-and-restore"] as const)(
    "never fsyncs a marker pathname %s injected immediately before marker sync",
    async (kind) => {
      const { project } = await fixture();
      let injected = false;
      const synced: string[] = [];
      await expect(createOwnedRunRoot(options(project, {
        topic: `marker-sync-${kind}`,
        onCheck: async (phase: string) => {
          if (phase !== "before-marker-synced-marker-sync-verification" || injected) return;
          injected = true;
          const research = join(await realpath(project), "research");
          const leaf = (await readdir(research)).find((entry) => entry.includes(`marker-sync-${kind}`));
          if (!leaf) throw new Error("marker leaf absent");
          const marker = join(research, leaf, ".pi-science-research-owner.json");
          const bytes = await readFile(marker);
          const original = `${marker}.original`;
          await rename(marker, original);
          await writeFile(marker, bytes);
          if (kind === "swap-and-restore") {
            await rename(marker, `${marker}.replacement`);
            await rename(original, marker);
          }
        },
        durability: async (handle: { sync(): Promise<void> }, step: string) => {
          synced.push(step);
          await handle.sync();
        },
      }))).rejects.toEqual(expectCode("run-root.replaced"));
      expect(injected).toBe(true);
      expect(synced).not.toContain("marker-synced");
    },
  );

  test("rejects in-place marker mutation after the marker was previously read", async () => {
    const { project } = await fixture();
    let mutated = false;
    await expect(createOwnedRunRoot(options(project, {
      topic: "marker-mutation",
      onCheck: async (phase: string) => {
        if (phase !== "after-final-marker-read-before-return" || mutated) return;
        mutated = true;
        const research = join(await realpath(project), "research");
        const leaf = (await readdir(research)).find((entry) => entry.includes("marker-mutation") && !entry.startsWith(".tmp-"));
        if (!leaf) throw new Error("published leaf absent");
        const markerPath = join(research, leaf, ".pi-science-research-owner.json");
        const original = await readFile(markerPath, "utf8");
        await writeFile(markerPath, original.replace("12:34:56.000Z", "12:34:57.000Z"));
      },
    }))).rejects.toBeInstanceOf(RunRootError);
    expect(mutated).toBe(true);
  });

  test.each([
    { kind: "hook", boundary: "after-research-candidate-check-before-mkdir" },
    { kind: "durability", boundary: "research-directory-synced" },
    { kind: "durability", boundary: "research-parent-synced" },
    { kind: "hook", boundary: "after-leaf-candidate-check-before-mkdir" },
    { kind: "hook", boundary: "after-final-leaf-open-before-marker" },
    { kind: "durability", boundary: "leaf-final-directory-synced" },
    { kind: "hook", boundary: "before-marker-create" },
    { kind: "hook", boundary: "after-marker-create-before-write" },
    { kind: "hook", boundary: "after-marker-write-before-fsync" },
    { kind: "durability", boundary: "marker-synced" },
    { kind: "durability", boundary: "leaf-marker-directory-synced" },
    { kind: "durability", boundary: "leaf-parent-synced" },
  ])("recovers safely after $kind failure at $boundary", async ({ kind, boundary }) => {
    const { project } = await fixture();
    await expect(createOwnedRunRoot(options(project, {
      topic: "durability",
      onCheck: async (phase: string) => {
        if (kind === "hook" && phase === boundary) throw new Error("injected");
      },
      durability: async (handle: { sync(): Promise<void> }, step: string) => {
        if (kind === "durability" && step === boundary) throw new Error("injected");
        await handle.sync();
      },
    }))).rejects.toBeInstanceOf(RunRootError);

    const recovered = await createOwnedRunRoot(options(project, { topic: "durability", ownershipToken: OTHER_TOKEN }));
    const marker = JSON.parse(await readFile(join(recovered.path, ".pi-science-research-owner.json"), "utf8"));
    expect(marker.runId).toBe(RUN_ID);
    expect(marker.ownershipTokenSha256).toBe(sha256Hex(OTHER_TOKEN));
    const research = join(await realpath(project), "research");
    for (const entry of await readdir(research)) {
      const info = await lstat(join(research, entry));
      if (!info.isDirectory()) continue;
      let text: string;
      try {
        text = await readFile(join(research, entry, ".pi-science-research-owner.json"), "utf8");
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      let visibleMarker: Record<string, unknown>;
      try {
        visibleMarker = JSON.parse(text);
      } catch {
        expect(join(research, entry)).not.toBe(recovered.path);
        continue;
      }
      expect(visibleMarker.runId).toBe(RUN_ID);
      expect([sha256Hex(TOKEN), sha256Hex(OTHER_TOKEN)]).toContain(visibleMarker.ownershipTokenSha256);
    }
    await recovered.close();
  });

  test.each([
    "research-parent-synced",
    "leaf-parent-synced",
    "leaf-final-directory-synced",
    "leaf-marker-directory-synced",
  ] as const)("does not fsync a swapped-and-restored directory at %s", async (step) => {
    const { base, project } = await fixture();
    const synced: string[] = [];
    let swapped = false;
    await expect(createOwnedRunRoot(options(project, {
      topic: `sync-swap-${step}`,
      onCheck: async (phase: string) => {
        if (phase !== `before-${step}-directory-sync-verification` || swapped) return;
        swapped = true;
        const canonicalProject = await realpath(project);
        const research = join(canonicalProject, "research");
        const leaf = step.startsWith("leaf-") && step !== "leaf-parent-synced"
          ? join(research, (await readdir(research)).find((entry) => entry.includes(`sync-swap-${step}`))!)
          : undefined;
        const target = step === "research-parent-synced"
          ? canonicalProject
          : step === "leaf-parent-synced" ? research : leaf!;
        const moved = join(base, `moved-${step}`);
        const replacement = join(base, `replacement-${step}`);
        await mkdir(replacement);
        await rename(target, moved);
        await rename(replacement, target);
        await rename(target, replacement);
        await rename(moved, target);
      },
      durability: async (handle: { sync(): Promise<void> }, seen: string) => {
        synced.push(seen);
        await handle.sync();
      },
    }))).rejects.toEqual(expectCode("run-root.replaced"));
    expect(swapped).toBe(true);
    expect(synced).not.toContain(step);
  });

  test("fails closed when the project root is swapped during checks", async () => {
    const { base, project } = await fixture();
    const moved = join(base, "project-old");
    const outside = join(base, "outside");
    await mkdir(outside);
    let swapped = false;

    await expect(createOwnedRunRoot(options(project, {
      onCheck: async (phase: string) => {
        if (phase === "before-create" && !swapped) {
          swapped = true;
          await rename(project, moved);
          await symlink(outside, project);
        }
      },
    }))).rejects.toBeInstanceOf(RunRootError);
    expect(await lstat(project)).toMatchObject({});
    expect((await lstat(project)).isSymbolicLink()).toBe(true);
  });

  test("failure paths close every descriptor exposed to durability hooks", async () => {
    const { project } = await fixture();
    const handles: Array<{ stat(): Promise<unknown> }> = [];
    await expect(createOwnedRunRoot(options(project, {
      topic: "descriptor-cleanup",
      durability: async (handle: { stat(): Promise<unknown>; sync(): Promise<void> }, step: string) => {
        handles.push(handle);
        if (step === "marker-synced") throw new Error("injected");
        await handle.sync();
      },
    }))).rejects.toBeInstanceOf(RunRootError);
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) await expect(handle.stat()).rejects.toBeDefined();
  });

  test("propagates durability failure and does not return a partially owned root", async () => {
    const { project } = await fixture();
    await expect(createOwnedRunRoot(options(project, {
      durability: async (_handle: unknown, step: string) => {
        if (step === "marker-synced") throw new Error("SECRET should not leak");
      },
    }))).rejects.toEqual(expectCode("run-root.io-failed"));

    const recovered = await createOwnedRunRoot(options(project));
    expect(recovered.path.endsWith("2026-08-25-crispr-rna-review-2")).toBe(true);
    await recovered.close();
  });
});

describe("openOwnedRunRoot", () => {
  test("resumes only a matching run and token and pins the root inode", async () => {
    const { project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const createdStat = await stat(created.path);
    await created.close();

    const opened = await openOwnedRunRoot(created.path, RUN_ID, TOKEN);
    expect(opened.dev).toBe(Number(createdStat.dev));
    expect(opened.ino).toBe(Number(createdStat.ino));
    await opened.close();
    const reopened = await openOwnedRunRoot(created.path, RUN_ID, TOKEN);
    await reopened.close();

    await expect(openOwnedRunRoot(created.path, RUN_ID, OTHER_TOKEN)).rejects.toEqual(
      expectCode("run-root.owner-mismatch"),
    );
  });

  test("rejects a copied owner marker whose pinned root identity differs", async () => {
    const { project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const marker = await readFile(join(created.path, ".pi-science-research-owner.json"));
    const replacement = join(await realpath(project), "copied-marker-root");
    await mkdir(replacement);
    await writeFile(join(replacement, ".pi-science-research-owner.json"), marker);
    await created.close();

    await expect(openOwnedRunRoot(replacement, RUN_ID, TOKEN)).rejects.toEqual(expectCode("run-root.owner-mismatch"));
  });

  test("active ownership revalidation detects same-inode marker mutation", async () => {
    const { project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const markerPath = join(created.path, ".pi-science-research-owner.json");
    const original = await readFile(markerPath, "utf8");
    await writeFile(markerPath, original.replace("12:34:56.000Z", "12:34:57.000Z"));

    await expect(revalidateOwnedRunRoot(created)).rejects.toEqual(expectCode("run-root.replaced"));
    await created.close();
  });

  test("open rejects marker pathname replacement after descriptor validation", async () => {
    const { project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const markerPath = join(created.path, ".pi-science-research-owner.json");
    await created.close();
    let replaced = false;

    await expect(openOwnedRunRoot(created.path, RUN_ID, TOKEN, {
      onCheck: async (phase: string) => {
        if (phase !== "after-marker-descriptor-validated-before-path-recheck" || replaced) return;
        replaced = true;
        const bytes = await readFile(markerPath);
        await rename(markerPath, `${markerPath}.moved`);
        await writeFile(markerPath, bytes);
      },
    })).rejects.toEqual(expectCode("run-root.replaced"));
    expect(replaced).toBe(true);
    expect((await lstat(markerPath)).isFile()).toBe(true);
  });

  test("active revalidation rejects marker pathname replacement", async () => {
    const { project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const markerPath = join(created.path, ".pi-science-research-owner.json");
    let replaced = false;

    await expect(revalidateOwnedRunRoot(created, {
      onCheck: async (phase: string) => {
        if (phase !== "after-marker-descriptor-validated-before-path-recheck" || replaced) return;
        replaced = true;
        const bytes = await readFile(markerPath);
        await rename(markerPath, `${markerPath}.moved`);
        await writeFile(markerPath, bytes);
      },
    })).rejects.toEqual(expectCode("run-root.replaced"));
    expect(replaced).toBe(true);
    await created.close();
  });

  test("open rejects root pathname replacement after reading a valid marker", async () => {
    const { base, project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const originalPath = created.path;
    const marker = await readFile(join(originalPath, ".pi-science-research-owner.json"));
    await created.close();
    const moved = join(base, "moved-open-root");
    let replaced = false;

    await expect(openOwnedRunRoot(originalPath, RUN_ID, TOKEN, {
      onCheck: async (phase: string) => {
        if (phase !== "after-open-owner-marker-read-before-final-root-check" || replaced) return;
        replaced = true;
        await rename(originalPath, moved);
        await mkdir(originalPath);
        await writeFile(join(originalPath, ".pi-science-research-owner.json"), marker);
      },
    })).rejects.toEqual(expectCode("run-root.replaced"));
    expect(replaced).toBe(true);
    expect((await lstat(originalPath)).isDirectory()).toBe(true);
    expect((await lstat(moved)).isDirectory()).toBe(true);
  });

  test("rejects a root reached through a symlinked parent alias", async () => {
    const { project } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const research = dirname(created.path);
    const alias = join(project, "research-alias");
    await created.close();
    await symlink(research, alias);

    await expect(openOwnedRunRoot(join(alias, basename(created.path)), RUN_ID, TOKEN)).rejects.toEqual(
      expectCode("run-root.symlink"),
    );
  });

  test("rejects missing, malformed, extra-key, symlinked, and hardlinked markers", async () => {
    const { project, base } = await fixture();
    const created = await createOwnedRunRoot(options(project));
    const marker = join(created.path, ".pi-science-research-owner.json");
    await created.close();

    await rm(marker);
    await expect(openOwnedRunRoot(created.path, RUN_ID, TOKEN)).rejects.toBeInstanceOf(RunRootError);
    await writeFile(marker, "{}\n");
    await expect(openOwnedRunRoot(created.path, RUN_ID, TOKEN)).rejects.toBeInstanceOf(RunRootError);
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, runId: RUN_ID, createdAt: NOW.toISOString(), ownershipTokenSha256: sha256Hex(TOKEN), extra: true }) + "\n");
    await expect(openOwnedRunRoot(created.path, RUN_ID, TOKEN)).rejects.toBeInstanceOf(RunRootError);

    await rm(marker);
    const target = join(base, "marker-target");
    await writeFile(target, "{}\n");
    await symlink(target, marker);
    await expect(openOwnedRunRoot(created.path, RUN_ID, TOKEN)).rejects.toEqual(expectCode("run-root.symlink"));

    await rm(marker);
    const rootIdentity = await stat(created.path);
    const valid = JSON.stringify({
      schemaVersion: 1, runId: RUN_ID, createdAt: NOW.toISOString(), ownershipTokenSha256: sha256Hex(TOKEN),
      rootDevice: String(rootIdentity.dev), rootInode: String(rootIdentity.ino),
    }) + "\n";
    await writeFile(marker, valid);
    await link(marker, join(base, "marker-hardlink"));
    await expect(openOwnedRunRoot(created.path, RUN_ID, TOKEN)).rejects.toEqual(expectCode("run-root.unsafe-link"));
  });

  test("rejects an unrelated empty or nonempty directory without exposing details", async () => {
    const { project } = await fixture();
    const empty = join(project, "empty");
    const full = join(project, "full");
    await mkdir(empty);
    await mkdir(full);
    await writeFile(join(full, "secret.txt"), "SECRET");
    for (const path of [empty, full]) {
      await expect(openOwnedRunRoot(path, RUN_ID, TOKEN)).rejects.toSatisfy((error: unknown) => {
        return error instanceof RunRootError && !error.message.includes("SECRET") && !error.message.includes(TOKEN);
      });
    }
  });
});

describe("assertContainedWrite", () => {
  test("authorizes only a strict descendant and exposes no-follow exclusive flags", async () => {
    const { project } = await fixture();
    const owned = await createOwnedRunRoot(options(project));
    const target = join(owned.path, ".state", "events.jsonl");

    const authorization = await assertContainedWrite(owned, target);

    expect(authorization.relativePath).toBe(".state/events.jsonl");
    expect(Number.isInteger(authorization.rootFd)).toBe(true);
    expect(authorization.rootFd).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(authorization.parentFd)).toBe(true);
    expect(authorization.parentFd).toBeGreaterThanOrEqual(0);
    expect(authorization.openFlags & constants.O_EXCL).not.toBe(0);
    expect(authorization.openFlags & constants.O_NOFOLLOW).not.toBe(0);
    await expect(authorization.openExclusive()).rejects.toBeInstanceOf(RunRootError);
    await authorization.close();
    await mkdir(join(owned.path, ".state"));
    const refreshed = await assertContainedWrite(owned, target);
    await expect(refreshed.openExclusive()).rejects.toEqual(expectCode("run-root.io-failed"));
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await refreshed.close();
    await owned.close();
  });

  test.each([".", "..", "../outside", "prefix/../../outside"]) (
    "rejects traversal or the root itself: %s",
    async (relative) => {
      const { project } = await fixture();
      const owned = await createOwnedRunRoot(options(project));
      await expect(assertContainedWrite(owned, resolve(owned.path, relative))).rejects.toBeInstanceOf(RunRootError);
      await owned.close();
    },
  );

  test("rejects prefix-confusion siblings", async () => {
    const { project } = await fixture();
    const owned = await createOwnedRunRoot(options(project));
    await expect(assertContainedWrite(owned, `${owned.path}-evil/file`)).rejects.toEqual(
      expectCode("run-root.outside-root"),
    );
    await owned.close();
  });

  test("rejects existing symlink segments, symlink leaves, and hardlinked leaves", async () => {
    const { base, project } = await fixture();
    const owned = await createOwnedRunRoot(options(project));
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(owned.path, "linked"));
    await expect(assertContainedWrite(owned, join(owned.path, "linked", "file"))).rejects.toEqual(expectCode("run-root.symlink"));

    const real = join(owned.path, "real");
    await mkdir(real);
    await symlink(join(outside, "file"), join(real, "leaf"));
    await expect(assertContainedWrite(owned, join(real, "leaf"))).rejects.toEqual(expectCode("run-root.symlink"));

    await rm(join(real, "leaf"));
    await writeFile(join(real, "leaf"), "x");
    await link(join(real, "leaf"), join(base, "hardlink"));
    await expect(assertContainedWrite(owned, join(real, "leaf"))).rejects.toEqual(expectCode("run-root.unsafe-link"));
    await owned.close();
  });

  test("revalidates ownership and rejects root replacement", async () => {
    const { base, project } = await fixture();
    const owned = await createOwnedRunRoot(options(project));
    const original = `${owned.path}-moved`;
    await rename(owned.path, original);
    await mkdir(owned.path);
    const replacementIdentity = await stat(owned.path);
    await writeFile(join(owned.path, ".pi-science-research-owner.json"), JSON.stringify({
      schemaVersion: 1, runId: RUN_ID, createdAt: NOW.toISOString(), ownershipTokenSha256: sha256Hex(TOKEN),
      rootDevice: String(replacementIdentity.dev), rootInode: String(replacementIdentity.ino),
    }) + "\n");

    await expect(assertContainedWrite(owned, join(owned.path, "file"))).rejects.toEqual(expectCode("run-root.replaced"));
    expect((await stat(original)).isDirectory()).toBe(true);
    await owned.close();
  });

  test("a post-authorization ancestor swap cannot create an outside file", async () => {
    const { base, project } = await fixture();
    const owned = await createOwnedRunRoot(options(project));
    const parent = join(owned.path, "parent");
    const moved = join(owned.path, "parent-old");
    const outside = join(base, "outside");
    await mkdir(parent);
    await mkdir(outside);
    const authorization = await assertContainedWrite(owned, join(parent, "file"));
    let hookRan = false;

    await expect(authorization.openExclusive(0o600, {
      onCheck: async (phase: string) => {
        if (phase === "after-final-check-before-open") {
          hookRan = true;
          await rename(parent, moved);
          await symlink(outside, parent);
        }
      },
    })).rejects.toBeInstanceOf(RunRootError);
    expect(hookRan).toBe(true);
    await expect(lstat(join(outside, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    await authorization.close();
    await owned.close();
  });

  test("fails closed when an ancestor is swapped between checks", async () => {
    const { base, project } = await fixture();
    const owned = await createOwnedRunRoot(options(project));
    const parent = join(owned.path, "parent");
    const moved = join(owned.path, "parent-old");
    const outside = join(base, "outside");
    await mkdir(parent);
    await mkdir(outside);
    let swapped = false;

    await expect(assertContainedWrite(owned, join(parent, "file"), {
      onCheck: async (phase: string) => {
        if (phase === "before-authorize" && !swapped) {
          swapped = true;
          await rename(parent, moved);
          await symlink(outside, parent);
        }
      },
    })).rejects.toEqual(expectCode("run-root.symlink"));
    expect(await stat(outside)).toBeDefined();
    await owned.close();
  });
});
