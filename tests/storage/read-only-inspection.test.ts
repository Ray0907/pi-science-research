import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { openEventLedger, readVerifiedLedgerSnapshot } from "../../src/storage/event-ledger.js";
import { createOwnedRunRoot, inspectOwnedRunRootIntegrity } from "../../src/storage/run-root.js";
import type { RunSnapshot } from "../../src/domain/records.js";

const RUN = "run-0123456789abcdef" as const;
const TOKEN = "a".repeat(64);
const AT = "2026-08-25T12:34:56.000Z";
const roots: string[] = [];

function runSnapshot(): RunSnapshot {
  return {
    schemaVersion: 1, runId: RUN, revision: 1, question: "q", language: "en", depth: "standard", reproducible: false,
    allowCalculations: false, calculationPolicySha256: null, state: "created", checkpointStage: null, executionEpoch: 0,
    outputRoot: "research/run", roleModels: { coordinator: "p/m", researcher: "p/m", verifier: "p/m" },
    roleThinking: { coordinator: "medium", researcher: "medium", verifier: "medium" },
    budget: { activeTimeLimitMs: 600_000, activeTimeUsedMs: 0, finalizationReserveMs: 120_000, maxSources: 10, admittedSources: 0, maxWaves: 2, waveOrdinal: 0 },
    taskRefs: [], attemptRefs: [], acceptedVerificationRef: null, currentRevisionId: null, blocker: null,
    createdAt: AT, updatedAt: AT, completedAt: null,
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "pi-status-inspect-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  const owned = await createOwnedRunRoot({
    trustedProject: project, repositoryRoot: project, topic: "status", runId: RUN, ownershipToken: TOKEN,
    now: () => new Date(AT),
  });
  const root = owned.path;
  await owned.close();
  return { base, project, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read-only owned-root integrity inspection", () => {
  test("validates the closed marker without exposing authentication material or mutating files", async () => {
    const { root } = await fixture();
    const markerPath = join(root, ".pi-science-research-owner.json");
    const before = { bytes: await readFile(markerPath), stat: await stat(markerPath) };
    const inspected = await inspectOwnedRunRootIntegrity(root);
    expect(inspected.runId).toBe(RUN);
    expect(Object.keys(inspected)).not.toContain("ownershipToken");
    expect(JSON.stringify(inspected)).not.toContain(TOKEN);
    await inspected.close();
    const after = { bytes: await readFile(markerPath), stat: await stat(markerPath) };
    expect(after.bytes).toEqual(before.bytes);
    expect({ mtimeMs: after.stat.mtimeMs, mode: after.stat.mode }).toEqual({ mtimeMs: before.stat.mtimeMs, mode: before.stat.mode });
  });

  test("rejects tampered markers, symlinked roots, and root replacement races", async () => {
    const { base, root } = await fixture();
    await writeFile(join(root, ".pi-science-research-owner.json"), "{}\n", "utf8");
    await expect(inspectOwnedRunRootIntegrity(root)).rejects.toMatchObject({ code: "run-root.marker-invalid" });
    const alias = join(base, "alias");
    await symlink(root, alias);
    await expect(inspectOwnedRunRootIntegrity(alias)).rejects.toMatchObject({ code: "run-root.symlink" });

    const fresh = await fixture();
    const moved = `${fresh.root}.moved`;
    await expect(inspectOwnedRunRootIntegrity(fresh.root, {
      onCheck: async (phase) => {
        if (phase === "before-integrity-final-check") {
          await rename(fresh.root, moved);
          await mkdir(fresh.root, { mode: 0o700 });
        }
      },
    })).rejects.toMatchObject({ name: "RunRootError" });
  });
});

describe("readVerifiedLedgerSnapshot", () => {
  test("verifies a stable semantic snapshot without modifying it", async () => {
    const { root } = await fixture();
    const path = join(root, ".state", "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const ledger = await openEventLedger(path, { now: () => new Date(AT), eventId: () => "event-1" });
    await ledger.append("run_created", { run: runSnapshot() });
    await ledger.close();
    const before = { bytes: await readFile(path), stat: await stat(path) };
    const events = await readVerifiedLedgerSnapshot(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("run_created");
    const after = { bytes: await readFile(path), stat: await stat(path) };
    expect(after.bytes).toEqual(before.bytes);
    expect({ mtimeMs: after.stat.mtimeMs, mode: after.stat.mode }).toEqual({ mtimeMs: before.stat.mtimeMs, mode: before.stat.mode });
  });

  test("rejects a torn tail without repairing or changing bytes", async () => {
    const { root } = await fixture();
    const path = join(root, ".state", "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const ledger = await openEventLedger(path, { now: () => new Date(AT), eventId: () => "event-1" });
    await ledger.append("run_created", { run: runSnapshot() });
    await ledger.close();
    await appendFile(path, '{"secret":"TORN_SECRET_SENTINEL"', "utf8");
    const before = await readFile(path);
    await expect(readVerifiedLedgerSnapshot(path)).rejects.toMatchObject({ code: "ledger.torn-tail" });
    expect(await readFile(path)).toEqual(before);
  });

  test("rejects semantic corruption and concurrent path replacement", async () => {
    const { root } = await fixture();
    const path = join(root, ".state", "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    let id = 0;
    const ledger = await openEventLedger(path, { now: () => new Date(AT), eventId: () => `event-${++id}` });
    await ledger.append("run_created", { run: runSnapshot() });
    await ledger.append("state_changed", { from: "planning", to: "researching", blocker: null });
    await ledger.close();
    await expect(readVerifiedLedgerSnapshot(path)).rejects.toMatchObject({ name: "LedgerReducerCorruptionError" });

    await rm(path);
    const healthy = await openEventLedger(path, { now: () => new Date(AT), eventId: () => "healthy-event" });
    await healthy.append("run_created", { run: runSnapshot() });
    await healthy.close();
    const replacement = join(root, ".state", "replacement.jsonl");
    await writeFile(replacement, await readFile(path));
    await expect(readVerifiedLedgerSnapshot(path, {
      onCheck: async (phase) => {
        if (phase === "before-final-path-check") {
          await rm(path);
          await writeFile(path, await readFile(replacement));
        }
      },
    })).rejects.toMatchObject({ code: "ledger.concurrent-mutation" });
    expect((await lstat(path)).isFile()).toBe(true);
  });

  test("rejects symlinked trusted-root segments", async () => {
    const { base, root } = await fixture();
    const outside = join(base, "outside");
    await mkdir(outside);
    const events = join(outside, "events.jsonl");
    await writeFile(events, "", "utf8");
    const state = join(root, ".state");
    await symlink(outside, state);
    await expect(readVerifiedLedgerSnapshot(join(state, "events.jsonl"), { trustedRoot: root }))
      .rejects.toMatchObject({ code: "ledger.symlink" });
  });

  test.each(["first-stat", "lstat"])("closes every acquired parent after injected %s failure and can reopen", async (kind) => {
    const { root } = await fixture();
    const path = join(root, ".state", "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const ledger = await openEventLedger(path, { now: () => new Date(AT), eventId: () => "event-1" });
    await ledger.append("run_created", { run: runSnapshot() });
    await ledger.close();
    const handles: FileHandle[] = [];
    const closes = new Map<FileHandle, number>();
    let lstatCalls = 0;
    const options = {
      trustedRoot: root,
      onHandleOpened: async (_kind: string, _path: string, handle: FileHandle) => {
        handles.push(handle);
        if (kind === "first-stat" && handles.length === 1) {
          Object.defineProperty(handle, "stat", { configurable: true, value: async () => { throw new Error("stat-secret"); } });
        }
      },
      lstat: async (target: string) => {
        lstatCalls++;
        if (kind === "lstat" && lstatCalls === 2) throw new Error("lstat-secret");
        return lstat(target, { bigint: true });
      },
      close: async (handle: FileHandle) => {
        closes.set(handle, (closes.get(handle) ?? 0) + 1);
        await handle.close();
      },
    };
    await expect(readVerifiedLedgerSnapshot(path, options)).rejects.toMatchObject({ code: "ledger.open-failed" });
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(closes.get(handle)).toBe(1);
    expect(await readVerifiedLedgerSnapshot(path, { trustedRoot: root })).toHaveLength(1);
  });

  test("preserves ledger primary errors across close failures and reports close-only failure", async () => {
    const { root } = await fixture();
    const path = join(root, ".state", "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const ledger = await openEventLedger(path, { now: () => new Date(AT), eventId: () => "event-1" });
    await ledger.append("run_created", { run: runSnapshot() });
    await ledger.close();
    const closeCounts = new Map<FileHandle, number>();
    const close = async (handle: FileHandle) => {
      closeCounts.set(handle, (closeCounts.get(handle) ?? 0) + 1);
      await handle.close();
      throw new Error("close-secret");
    };
    await appendFile(path, "{", "utf8");
    await expect(readVerifiedLedgerSnapshot(path, { trustedRoot: root, close })).rejects.toMatchObject({ code: "ledger.torn-tail" });
    for (const count of closeCounts.values()) expect(count).toBe(1);
    await writeFile(path, (await readFile(path)).subarray(0, -1));
    closeCounts.clear();
    await expect(readVerifiedLedgerSnapshot(path, { trustedRoot: root, close })).rejects.toMatchObject({ code: "ledger.close-failed" });
    for (const count of closeCounts.values()) expect(count).toBe(1);
    expect(await readVerifiedLedgerSnapshot(path, { trustedRoot: root })).toHaveLength(1);
  });

  test("does not leak descriptors across repeated success and failure", async () => {
    const { root } = await fixture();
    const path = join(root, ".state", "events.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const ledger = await openEventLedger(path, { now: () => new Date(AT), eventId: () => "event-1" });
    await ledger.append("run_created", { run: runSnapshot() });
    await ledger.close();
    const fdDir = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const before = (await readdir(fdDir)).length;
    for (let index = 0; index < 20; index++) await readVerifiedLedgerSnapshot(path);
    const after = (await readdir(fdDir)).length;
    expect(after).toBeLessThanOrEqual(before + 2);
  });
});
