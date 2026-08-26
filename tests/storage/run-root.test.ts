import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
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
} from "../../src/storage/run-root.js";
import { sha256Hex } from "../../src/crypto/hash.js";

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
    const valid = JSON.stringify({ schemaVersion: 1, runId: RUN_ID, createdAt: NOW.toISOString(), ownershipTokenSha256: sha256Hex(TOKEN) }) + "\n";
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
    expect(Number.isInteger(authorization.parentFd)).toBe(true);
    expect(authorization.parentFd).toBeGreaterThanOrEqual(0);
    expect(authorization.openFlags & constants.O_EXCL).not.toBe(0);
    expect(authorization.openFlags & constants.O_NOFOLLOW).not.toBe(0);
    await expect(authorization.openExclusive()).rejects.toBeInstanceOf(RunRootError);
    await authorization.close();
    await mkdir(join(owned.path, ".state"));
    const refreshed = await assertContainedWrite(owned, target);
    if (process.platform === "linux") {
      const created = await refreshed.openExclusive();
      await created.close();
    } else {
      await expect(refreshed.openExclusive()).rejects.toEqual(expectCode("run-root.io-failed"));
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
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
    await writeFile(join(owned.path, ".pi-science-research-owner.json"), JSON.stringify({
      schemaVersion: 1, runId: RUN_ID, createdAt: NOW.toISOString(), ownershipTokenSha256: sha256Hex(TOKEN),
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

    await expect(authorization.openExclusive(0o600, {
      onCheck: async (phase: string) => {
        if (phase === "before-open") {
          await rename(parent, moved);
          await symlink(outside, parent);
        }
      },
    })).rejects.toBeInstanceOf(RunRootError);
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
