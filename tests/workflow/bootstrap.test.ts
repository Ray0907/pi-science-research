import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parse } from "../../src/domain/schema.js";
import { RunSnapshotSchema } from "../../src/domain/records.js";
import { openEventLedger, readVerifiedLedgerSnapshot } from "../../src/storage/event-ledger.js";
import { openOwnedRunRoot } from "../../src/storage/run-root.js";
import {
  createResearchRunLockTestHooksInternal,
  type ResearchRunLockPhaseInternal,
} from "../../src/storage/run-lock-internal.js";
import {
  ResearchBootstrapError,
  bootstrapResearchRunInternal,
  createResearchBootstrapContextInternal,
  createResearchBootstrapTestHooksInternal,
  createResolvedResearchRoleSnapshotInternal,
  getResearchBootstrapFailureInternal,
  projectResearchTopicInternal,
  type ResearchBootstrapOperationFaultInternal,
  type ResearchBootstrapPhaseInternal,
} from "../../src/workflow/bootstrap.js";
import { parseResearchInvocationInternal } from "../../src/workflow/research-options.js";
import { readFoundationStatus } from "../../extensions/research/status-reader.js";

const NOW = new Date("2026-08-25T12:34:56.000Z");
const TEST_RUN_ID = "run-01010101010101010101010101010101" as const;
const TEST_ROOT_OWNERSHIP_TOKEN = "02".repeat(32);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectFixture(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pi-bootstrap-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return project;
}

function invocation(raw = "What is durable research?") {
  return parseResearchInvocationInternal(raw, { mode: "rpc" });
}

function roles(value = invocation(), activeThinking: "low" | "high" = "high") {
  return createResolvedResearchRoleSnapshotInternal(value, {
    activeModel: "active/model",
    activeThinking,
    resolvedModels: {
      coordinator: "resolved/coordinator",
      researcher: "resolved/researcher",
      verifier: "resolved/verifier",
    },
  });
}

function context(project: string, value = invocation(), overrides: Partial<{
  roles: ReturnType<typeof roles>;
  signal: AbortSignal | undefined;
  allowAbsoluteRequestedPath: boolean;
  approveOutside: ((canonicalPath: string) => boolean | Promise<boolean>) | null;
  approvedOutsideRoots: readonly string[];
  forbiddenRoots: readonly string[];
}> = {}) {
  return createResearchBootstrapContextInternal({
    trustedProject: project,
    repositoryRoot: project,
    roles: overrides.roles ?? roles(value),
    signal: overrides.signal,
    allowAbsoluteRequestedPath: overrides.allowAbsoluteRequestedPath ?? false,
    approveOutside: overrides.approveOutside ?? null,
    approvedOutsideRoots: overrides.approvedOutsideRoots ?? [],
    forbiddenRoots: overrides.forbiddenRoots ?? [],
  });
}

function hooks(phases: ResearchBootstrapPhaseInternal[] = [], overrides: Partial<{
  now: () => Date;
  monotonicNow: () => number;
  faultAt: ResearchBootstrapOperationFaultInternal | null;
  lockFailAt: ResearchRunLockPhaseInternal | null;
  lockOnCheck: (phase: ResearchRunLockPhaseInternal) => void | Promise<void>;
  onCheck: (phase: ResearchBootstrapPhaseInternal) => void | Promise<void>;
}> = {}) {
  let randomOrdinal = 0;
  const lockHooks = createResearchRunLockTestHooksInternal({
    now: () => NOW,
    randomBytes: () => new Uint8Array(32).fill(0x5c),
    onCheck: overrides.lockOnCheck ?? null,
    failAt: overrides.lockFailAt ?? null,
  });
  return createResearchBootstrapTestHooksInternal({
    now: overrides.now ?? (() => new Date(NOW)),
    monotonicNow: overrides.monotonicNow ?? (() => 100),
    randomBytes: (size) => new Uint8Array(size).fill(++randomOrdinal),
    onCheck: (phase) => {
      phases.push(phase);
      return overrides.onCheck?.(phase);
    },
    faultAt: overrides.faultAt ?? null,
    lockHooks,
  });
}

function expectCode(code: string) {
  return expect.objectContaining({ name: "ResearchBootstrapError", code, message: `Research bootstrap failed (${code})` });
}

type OperationFaultExpectation = Readonly<{
  code: "bootstrap.persistence-failed" | "bootstrap.integrity-failed" | "bootstrap.cleanup-uncertain";
  lastDurableSeq: number | null;
  state: "orphan" | "created" | "planning" | "unknown" | null;
  cancelAfterRunCreated?: true;
  completeLines?: number;
}>;

const OPERATION_FAULT_EXPECTATIONS = {
  "root-create-before": { code: "bootstrap.persistence-failed", lastDurableSeq: null, state: null },
  "ledger-open-before": { code: "bootstrap.persistence-failed", lastDurableSeq: 0, state: "orphan" },
  "ledger-directory-sync-before": { code: "bootstrap.persistence-failed", lastDurableSeq: 0, state: "orphan", completeLines: 0 },
  "run-created-write-partial": { code: "bootstrap.persistence-failed", lastDurableSeq: 0, state: "orphan", completeLines: 0 },
  "run-created-durability": { code: "bootstrap.persistence-failed", lastDurableSeq: 0, state: "orphan", completeLines: 1 },
  "planning-transition-write-partial": { code: "bootstrap.persistence-failed", lastDurableSeq: 1, state: "created", completeLines: 1 },
  "planning-transition-durability": { code: "bootstrap.persistence-failed", lastDurableSeq: 1, state: "created", completeLines: 2 },
  "normal-active-checkpoint-write-partial": { code: "bootstrap.persistence-failed", lastDurableSeq: 2, state: "planning", completeLines: 2 },
  "normal-active-checkpoint-durability": { code: "bootstrap.persistence-failed", lastDurableSeq: 2, state: "planning", completeLines: 3 },
  "cancellation-active-checkpoint-write-partial": { code: "bootstrap.persistence-failed", lastDurableSeq: 1, state: "created", cancelAfterRunCreated: true, completeLines: 1 },
  "cancellation-active-checkpoint-durability": { code: "bootstrap.persistence-failed", lastDurableSeq: 1, state: "created", cancelAfterRunCreated: true, completeLines: 2 },
  "cancel-requested-write-partial": { code: "bootstrap.persistence-failed", lastDurableSeq: 2, state: "created", cancelAfterRunCreated: true, completeLines: 2 },
  "cancel-requested-durability": { code: "bootstrap.persistence-failed", lastDurableSeq: 2, state: "created", cancelAfterRunCreated: true, completeLines: 3 },
  "cancelled-transition-write-partial": { code: "bootstrap.persistence-failed", lastDurableSeq: 3, state: "created", cancelAfterRunCreated: true, completeLines: 3 },
  "cancelled-transition-durability": { code: "bootstrap.persistence-failed", lastDurableSeq: 3, state: "created", cancelAfterRunCreated: true, completeLines: 4 },
  "ledger-read-before": { code: "bootstrap.integrity-failed", lastDurableSeq: 3, state: "unknown", completeLines: 3 },
  "ledger-verify-before": { code: "bootstrap.integrity-failed", lastDurableSeq: 3, state: "unknown", completeLines: 3 },
  "ledger-close-after": { code: "bootstrap.cleanup-uncertain", lastDurableSeq: 3, state: "planning", completeLines: 3 },
  "root-revalidate-before": { code: "bootstrap.integrity-failed", lastDurableSeq: 3, state: "unknown", completeLines: 3 },
  "root-close-after": { code: "bootstrap.cleanup-uncertain", lastDurableSeq: 3, state: "planning", completeLines: 3 },
} as const satisfies Readonly<Record<ResearchBootstrapOperationFaultInternal, OperationFaultExpectation>>;

const OPERATION_FAULT_CASES = Object.entries(OPERATION_FAULT_EXPECTATIONS) as readonly (
  readonly [ResearchBootstrapOperationFaultInternal, OperationFaultExpectation]
)[];

async function faultOutcome(
  faultAt: ResearchBootstrapOperationFaultInternal | null,
  code: string,
  lockFailAt: ResearchRunLockPhaseInternal | null = null,
) {
  const project = await projectFixture();
  await mkdir(join(project, "runs"));
  const value = invocation("--output runs/fault-run Failure secret question");
  const error = await bootstrapResearchRunInternal(value, context(project, value), hooks([], { faultAt, lockFailAt }))
    .then(() => null, (caught: unknown) => caught);
  expect(error).toEqual(expectCode(code));
  expect(error).toBeInstanceOf(ResearchBootstrapError);
  expect((error as Error).message).not.toContain(project);
  expect((error as Error).message).not.toContain("Failure secret question");
  return { project, rootPath: join(await realpath(project), "runs", "fault-run"), error };
}

describe.skipIf(process.platform === "win32")("durable research bootstrap", () => {
  test.each([
    ["quick", 900_000, 12, 1],
    ["standard", 2_700_000, 30, 2],
    ["deep", 7_200_000, 80, 4],
  ] as const)("creates a durable planning run for %s depth", async (depth, activeTimeLimitMs, maxSources, maxWaves) => {
    const project = await projectFixture();
    const value = invocation(`--depth ${depth} Full research question`);
    const phases: ResearchBootstrapPhaseInternal[] = [];

    const result = await bootstrapResearchRunInternal(value, context(project, value), hooks(phases));
    const canonicalProject = await realpath(project);

    expect(result).toEqual({
      runId: "run-01010101010101010101010101010101",
      rootPath: join(canonicalProject, "research", "2026-08-25-full-research-question"),
      state: "planning",
      budget: {
        activeTimeLimitMs,
        activeTimeUsedMs: 0,
        finalizationReserveMs: depth === "quick" ? 180_000 : depth === "standard" ? 540_000 : 600_000,
        maxSources,
        admittedSources: 0,
        maxWaves,
        waveOrdinal: 0,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.budget)).toBe(true);
    expect(phases).toEqual([
      "before-root-create", "after-root-create", "after-lock-acquire", "after-ledger-open",
      "after-ledger-directory-sync", "after-run-created", "after-planning-transition",
      "after-active-checkpoint", "before-final-verify", "after-ledger-close", "after-lock-release",
      "before-root-close",
    ]);

    const events = await readVerifiedLedgerSnapshot(join(result.rootPath, ".state", "events.jsonl"), { trustedRoot: result.rootPath });
    expect(events.map((event) => event.type)).toEqual(["run_created", "state_changed", "active_time_checkpoint"]);
    const created = events[0];
    expect(created?.type).toBe("run_created");
    if (created?.type !== "run_created") throw new Error("missing run_created");
    expect(parse(RunSnapshotSchema, created.payload.run).success).toBe(true);
    expect(created.payload.run).toEqual(expect.objectContaining({
      runId: result.runId,
      revision: 1,
      question: "Full research question",
      state: "created",
      checkpointStage: null,
      executionEpoch: 0,
      outputRoot: result.rootPath,
      taskRefs: [],
      attemptRefs: [],
      acceptedVerificationRef: null,
      currentRevisionId: null,
      blocker: null,
      completedAt: null,
      calculationPolicySha256: null,
    }));
    const status = await readFoundationStatus({ cwd: project, rootPath: result.rootPath });
    expect(status).toEqual({
      runId: result.runId,
      state: "planning",
      tasksByState: { open: 0, ready: 0, running: 0, blocked: 0, resolved: 0, cancelled: 0 },
      taskTotal: 0,
      attemptTotal: 0,
      pendingSafeReadSchedules: 0,
      earliestNotBeforeAt: null,
      uncertainNeverBlockers: 0,
      pendingTransactions: 0,
      unmaterializedResults: 0,
      committedTransactions: 0,
      executionEpoch: 0,
      integrity: "verified",
    });
  });

  test("resolves explicit models and keeps unspecified roles exactly on the active model/thinking", () => {
    const value = invocation("--model-role researcher=selected/requested Question");
    const snapshot = roles(value, "low");

    expect(snapshot).toEqual({
      roleModels: { coordinator: "active/model", researcher: "resolved/researcher", verifier: "active/model" },
      roleThinking: { coordinator: "low", researcher: "low", verifier: "low" },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.roleModels)).toBe(true);
    expect(Object.isFrozen(snapshot.roleThinking)).toBe(true);
    expect(() => createResearchBootstrapContextInternal({
      trustedProject: "/tmp", repositoryRoot: "/tmp", roles: structuredClone(snapshot), signal: undefined,
      allowAbsoluteRequestedPath: false, approveOutside: null, approvedOutsideRoots: [], forbiddenRoots: [],
    })).toThrow(expectCode("bootstrap.invalid-input"));
  });

  test("uses collision suffixes and honors custom relative output roots", async () => {
    const project = await projectFixture();
    const firstValue = invocation("Collision topic");
    const first = await bootstrapResearchRunInternal(firstValue, context(project, firstValue), hooks());
    const second = await bootstrapResearchRunInternal(firstValue, context(project, firstValue), hooks());
    await mkdir(join(project, "custom"));
    const customValue = invocation("--output custom/run Custom topic");
    const custom = await bootstrapResearchRunInternal(customValue, context(project, customValue), hooks());

    expect(basename(first.rootPath)).toBe("2026-08-25-collision-topic");
    expect(basename(second.rootPath)).toBe("2026-08-25-collision-topic-2");
    expect(custom.rootPath).toBe(join(await realpath(project), "custom", "run"));
  });

  test("closes each root, ledger, and lock across 100 bounded sequential bootstraps", async () => {
    const project = await projectFixture();
    await mkdir(join(project, "runs"));
    for (let index = 0; index < 100; index += 1) {
      const value = invocation(`--output runs/run-${index} Bounded bootstrap ${index}`);
      const result = await bootstrapResearchRunInternal(value, context(project, value), hooks());
      const ledgerPath = join(result.rootPath, ".state", "events.jsonl");
      await expect(lstat(join(result.rootPath, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      const reopenedLedger = await openEventLedger(ledgerPath);
      await reopenedLedger.close();
      const reopenedRoot = await openOwnedRunRoot(result.rootPath, result.runId, TEST_ROOT_OWNERSHIP_TOKEN);
      await reopenedRoot.close();
    }
  });

  test("requires and preserves explicit outside approval, including an authentic base promise", async () => {
    const project = await projectFixture();
    const outside = join(project, "..", "outside");
    await mkdir(outside);
    const target = join(outside, "approved-run");
    const value = invocation(`--output ${target} Outside topic`);
    const approvals: string[] = [];
    const approvedContext = context(project, value, {
      allowAbsoluteRequestedPath: true,
      approveOutside: (canonicalPath) => {
        approvals.push(canonicalPath);
        return Promise.resolve(true);
      },
    });

    const result = await bootstrapResearchRunInternal(value, approvedContext, hooks());
    const canonicalTarget = join(await realpath(outside), "approved-run");
    expect(result.rootPath).toBe(canonicalTarget);
    expect(approvals).toEqual([canonicalTarget]);
  });

  test("rejects non-base and ambiently compromised approval promises", async () => {
    const rejectedApproval = async (approveOutside: (canonicalPath: string) => boolean | Promise<boolean>) => {
      const project = await projectFixture();
      const outside = join(project, "..", `outside-${roots.length}`);
      await mkdir(outside);
      const value = invocation(`--output ${join(outside, "run")} Promise authentication`);
      await expect(bootstrapResearchRunInternal(value, context(project, value, {
        allowAbsoluteRequestedPath: true,
        approveOutside,
      }), hooks())).rejects.toEqual(expectCode("bootstrap.invalid-input"));
    };

    class DerivedPromise extends Promise<boolean> {}
    await rejectedApproval(() => new DerivedPromise((resolve) => { resolve(true); }));
    await rejectedApproval(() => ({ then: (resolve: (value: boolean) => void) => { resolve(true); } }) as never);
    await rejectedApproval(() => {
      const promise = Promise.resolve(true);
      Object.defineProperty(promise, "constructor", { value: Promise, configurable: true });
      return promise;
    });

    const constructorDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")!;
    try {
      class AmbientPromise extends Promise<unknown> {}
      Object.defineProperty(Promise.prototype, "constructor", { ...constructorDescriptor, value: AmbientPromise });
      await rejectedApproval(() => Promise.resolve(true));
    } finally {
      Object.defineProperty(Promise.prototype, "constructor", constructorDescriptor);
    }

    const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!;
    try {
      Object.defineProperty(Promise, Symbol.species, { ...speciesDescriptor, get: () => Promise });
      await rejectedApproval(() => Promise.resolve(true));
    } finally {
      Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
    }
  });

  test("parses the complete snapshot after root creation but before state or lock creation", async () => {
    const project = await projectFixture();
    const value = invocation("Invalid snapshot");
    const questionSchema = RunSnapshotSchema.properties.question as unknown as Record<string, unknown>;
    const priorMinimum = Object.getOwnPropertyDescriptor(questionSchema, "minLength");
    Object.defineProperty(questionSchema, "minLength", { value: 1_000_000, enumerable: true, configurable: true });
    try {
      await expect(bootstrapResearchRunInternal(value, context(project, value), hooks()))
        .rejects.toEqual(expectCode("bootstrap.snapshot-invalid"));
    } finally {
      if (priorMinimum) Object.defineProperty(questionSchema, "minLength", priorMinimum);
      else delete questionSchema.minLength;
    }

    const rootPath = join(await realpath(project), "research", "2026-08-25-invalid-snapshot");
    expect((await lstat(rootPath)).isDirectory()).toBe(true);
    await expect(lstat(join(rootPath, ".state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("projects topics at direct UTF-8 boundaries without splitting code points", () => {
    expect(projectResearchTopicInternal("")).toBe("research");
    expect(Buffer.byteLength(projectResearchTopicInternal("a".repeat(1024)), "utf8")).toBe(1024);
    expect(projectResearchTopicInternal(`${"a".repeat(1023)}étail`)).toBe("a".repeat(1023));
    expect(projectResearchTopicInternal(`${"a".repeat(1020)}😀tail`)).toBe(`${"a".repeat(1020)}😀`);
  });

  test("persists the full 16 KiB question while bounding only its projected topic", async () => {
    const project = await projectFixture();
    const question = "q".repeat(16 * 1024);
    const value = invocation(question);
    const result = await bootstrapResearchRunInternal(value, context(project, value), hooks());
    const events = await readVerifiedLedgerSnapshot(join(result.rootPath, ".state", "events.jsonl"), { trustedRoot: result.rootPath });
    const created = events[0];
    expect(created?.type).toBe("run_created");
    if (created?.type === "run_created") expect(created.payload.run.question).toBe(question);
  });

  test("records monotonic active elapsed time and rejects invalid or regressing clocks", async () => {
    const project = await projectFixture();
    const value = invocation("Clocked topic");
    let wallCall = 0;
    let monotonicCall = 0;
    const result = await bootstrapResearchRunInternal(value, context(project, value), hooks([], {
      now: () => new Date(NOW.getTime() + (wallCall++ === 0 ? 0 : 25)),
      monotonicNow: () => monotonicCall++ === 0 ? 100 : 125,
    }));
    const events = await readVerifiedLedgerSnapshot(join(result.rootPath, ".state", "events.jsonl"), { trustedRoot: result.rootPath });
    const checkpoint = events[2];
    expect(checkpoint?.type).toBe("active_time_checkpoint");
    if (checkpoint?.type === "active_time_checkpoint") {
      expect(checkpoint.payload).toEqual(expect.objectContaining({ addedMs: 25, totalMs: 25 }));
    }

    let backwardCall = 0;
    const backwardValue = invocation("Backward clock topic");
    await expect(bootstrapResearchRunInternal(backwardValue, context(project, backwardValue), hooks([], {
      monotonicNow: () => backwardCall++ === 0 ? 100 : 99,
    }))).rejects.toEqual(expectCode("bootstrap.clock-invalid"));

    let wallBackwardCall = 0;
    const wallBackwardValue = invocation("Backward wall clock topic");
    await expect(bootstrapResearchRunInternal(wallBackwardValue, context(project, wallBackwardValue), hooks([], {
      now: () => new Date(NOW.getTime() - (wallBackwardCall++ === 0 ? 0 : 1)),
    }))).rejects.toEqual(expectCode("bootstrap.clock-invalid"));

    for (const invalid of [-1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalidValue = invocation(`Invalid monotonic clock ${String(invalid)}`);
      await expect(bootstrapResearchRunInternal(invalidValue, context(project, invalidValue), hooks([], {
        monotonicNow: () => invalid,
      }))).rejects.toEqual(expectCode("bootstrap.clock-invalid"));
    }

    let fractionalCall = 0;
    const fractionalValue = invocation("Fractional monotonic clock");
    const fractional = await bootstrapResearchRunInternal(
      fractionalValue,
      context(project, fractionalValue),
      hooks([], { monotonicNow: () => fractionalCall++ === 0 ? 100.25 : 100.75 }),
    );
    const fractionalEvents = await readVerifiedLedgerSnapshot(join(fractional.rootPath, ".state", "events.jsonl"));
    const fractionalCheckpoint = fractionalEvents.at(-1);
    expect(fractionalCheckpoint?.type).toBe("active_time_checkpoint");
    if (fractionalCheckpoint?.type === "active_time_checkpoint") expect(fractionalCheckpoint.payload.addedMs).toBe(0.5);
  });

  test("classifies denied outside locations without publishing a run", async () => {
    const project = await projectFixture();
    const outside = join(project, "..", "denied-outside");
    await mkdir(outside);
    const target = join(outside, "denied-run");
    const value = invocation(`--output ${target} Denied secret question`);
    const error = await bootstrapResearchRunInternal(value, context(project, value, {
      allowAbsoluteRequestedPath: true,
      approveOutside: () => false,
    }), hooks()).then(() => null, (caught: unknown) => caught);

    expect(error).toEqual(expectCode("bootstrap.location-denied"));
    expect((error as Error).message).not.toContain(target);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(OPERATION_FAULT_CASES)("fails closed at exact operation fault %s", async (faultAt, expected) => {
    const project = await projectFixture();
    await mkdir(join(project, "runs"));
    const value = invocation(`--output runs/fault-run Fault matrix ${faultAt}`);
    const controller = new AbortController();
    const error = await bootstrapResearchRunInternal(
      value,
      context(project, value, { signal: expected.cancelAfterRunCreated ? controller.signal : undefined }),
      hooks([], {
        faultAt,
        onCheck: (phase) => {
          if (expected.cancelAfterRunCreated && phase === "after-run-created") controller.abort("private reason");
        },
      }),
    ).then(() => null, (caught: unknown) => caught);
    const rootPath = join(await realpath(project), "runs", "fault-run");

    expect(error).toEqual(expectCode(expected.code));
    expect(error).toBeInstanceOf(ResearchBootstrapError);
    expect((error as Error).message).not.toContain(project);
    expect((error as Error).message).not.toContain(`Fault matrix ${faultAt}`);
    if (expected.lastDurableSeq === null) {
      expect(getResearchBootstrapFailureInternal(error)).toBeNull();
      await expect(lstat(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }

    expect((await lstat(rootPath)).isDirectory()).toBe(true);
    const failure = getResearchBootstrapFailureInternal(error);
    expect(failure).toEqual({
      runId: TEST_RUN_ID,
      rootPath,
      lastDurableSeq: expected.lastDurableSeq,
      state: expected.state,
    });
    expect(Object.isFrozen(failure)).toBe(true);
    await expect(lstat(join(rootPath, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const ledgerPath = join(rootPath, ".state", "events.jsonl");
    if (expected.completeLines !== undefined) {
      const ledgerBytes = await readFile(ledgerPath);
      expect(ledgerBytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)).toBe(expected.completeLines);
    }
    if (faultAt === "ledger-close-after") {
      const reopenedLedger = await openEventLedger(ledgerPath);
      await reopenedLedger.close();
    }
    if (faultAt === "root-close-after") {
      const reopenedRoot = await openOwnedRunRoot(rootPath, TEST_RUN_ID, TEST_ROOT_OWNERSHIP_TOKEN);
      await reopenedRoot.close();
    }
  });

  test.each([
    "before-state-create",
    "after-state-open",
    "after-root-directory-sync",
    "before-lock-open",
  ] as const)("classifies pre-publication lock acquisition fault %s as persistence failure", async (lockFailAt) => {
    const outcome = await faultOutcome(null, "bootstrap.persistence-failed", lockFailAt);
    await expect(lstat(join(outcome.rootPath, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    "after-lock-open",
    "after-lock-write",
    "after-lock-sync",
    "after-state-publication-sync",
  ] as const)("classifies post-publication lock acquisition fault %s as cleanup uncertainty", async (lockFailAt) => {
    const outcome = await faultOutcome(null, "bootstrap.cleanup-uncertain", lockFailAt);
    expect((await lstat(join(outcome.rootPath, ".state", "controller.lock"))).isFile()).toBe(true);
  });

  test.each([
    ["before-release-verify", true],
    ["before-lock-unlink", true],
    ["after-lock-unlink", false],
    ["after-state-release-sync", false],
    ["before-descriptor-close", false],
  ] as const)("closes descriptors after release fault %s and reports cleanup uncertainty", async (lockFailAt, lockRemains) => {
    const outcome = await faultOutcome(null, "bootstrap.cleanup-uncertain", lockFailAt);
    const lockPath = join(outcome.rootPath, ".state", "controller.lock");
    if (lockRemains) expect((await lstat(lockPath)).isFile()).toBe(true);
    else await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("runs cleanup in ledger-close, lock-release, preserving-close, root-revalidate, root-close order", async () => {
    const project = await projectFixture();
    const value = invocation("--output ordered-cleanup Ordered cleanup");
    const timeline: string[] = [];
    const error = await bootstrapResearchRunInternal(value, context(project, value), hooks([], {
      faultAt: "run-created-durability",
      lockFailAt: "before-release-verify",
      onCheck: (phase) => { timeline.push(`bootstrap:${phase}`); },
      lockOnCheck: (phase) => { timeline.push(`lock:${phase}`); },
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toEqual(expectCode("bootstrap.cleanup-uncertain"));
    expect(timeline.slice(timeline.indexOf("bootstrap:after-ledger-close"))).toEqual([
      "bootstrap:after-ledger-close",
      "lock:before-release-verify",
      "lock:before-descriptor-close",
      "bootstrap:before-root-close",
    ]);
    expect((await lstat(join(await realpath(project), "ordered-cleanup", ".state", "controller.lock"))).isFile()).toBe(true);
  });

  test("preserves a residual lock and gives cleanup uncertainty precedence when release is uncertain", async () => {
    const releaseOnly = await faultOutcome(null, "bootstrap.cleanup-uncertain", "before-release-verify");
    expect((await lstat(join(releaseOnly.rootPath, ".state", "controller.lock"))).isFile()).toBe(true);

    const withPrimaryFailure = await faultOutcome(
      "run-created-durability",
      "bootstrap.cleanup-uncertain",
      "before-release-verify",
    );
    expect((await lstat(join(withPrimaryFailure.rootPath, ".state", "controller.lock"))).isFile()).toBe(true);
  });

  test("authenticates native signals without enumerating or freezing the live signal", async () => {
    const project = await projectFixture();
    const value = invocation("Native cancellation authentication");
    let proxyTouched = false;
    const proxied = new Proxy(new AbortController().signal, {
      ownKeys() { proxyTouched = true; throw new Error("must not enumerate"); },
    });
    expect(() => context(project, value, { signal: proxied })).toThrow(expectCode("bootstrap.invalid-input"));
    expect(proxyTouched).toBe(false);

    const fake = Object.create(AbortSignal.prototype) as AbortSignal;
    expect(() => context(project, value, { signal: fake })).toThrow(expectCode("bootstrap.invalid-input"));

    let accessorTouched = false;
    const accessorSignal = new AbortController().signal;
    Object.defineProperty(accessorSignal, "aborted", {
      configurable: true,
      get() { accessorTouched = true; throw new Error("must not invoke"); },
    });
    expect(() => context(project, value, { signal: accessorSignal })).toThrow(expectCode("bootstrap.invalid-input"));
    expect(accessorTouched).toBe(false);

    const controller = new AbortController();
    const liveContext = context(project, value, { signal: controller.signal });
    expect(Object.isFrozen(controller.signal)).toBe(false);
    controller.abort("redacted reason");
    await expect(bootstrapResearchRunInternal(value, liveContext, hooks()))
      .rejects.toEqual(expectCode("bootstrap.cancelled"));
    expect(Object.isFrozen(controller.signal)).toBe(false);
  });

  test.each([
    "before-root-create",
    "after-root-create",
    "after-lock-acquire",
    "after-ledger-open",
    "after-ledger-directory-sync",
  ] as const)("cancels at the %s pre-run boundary without publishing a run", async (boundary) => {
    const project = await projectFixture();
    const value = invocation(`--output boundary-${boundary} Boundary cancellation`);
    const controller = new AbortController();
    const error = await bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks([], {
      onCheck: (phase) => { if (phase === boundary) controller.abort("private reason"); },
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toEqual(expectCode("bootstrap.cancelled"));
    const rootPath = join(await realpath(project), `boundary-${boundary}`);
    if (boundary === "before-root-create") {
      await expect(lstat(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(getResearchBootstrapFailureInternal(error)).toBeNull();
    } else {
      expect(getResearchBootstrapFailureInternal(error)).toEqual({
        runId: "run-01010101010101010101010101010101",
        rootPath,
        lastDurableSeq: 0,
        state: "orphan",
      });
      await expect(lstat(join(rootPath, ".state", "controller.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test.each([
    ["after-run-created", ["run_created", "active_time_checkpoint", "cancel_requested", "state_changed"]],
    ["after-planning-transition", ["run_created", "state_changed", "active_time_checkpoint", "cancel_requested", "state_changed"]],
    ["after-active-checkpoint", ["run_created", "state_changed", "active_time_checkpoint", "cancel_requested", "state_changed"]],
  ] as const)("durably cancels at %s without duplicating the active checkpoint", async (boundary, eventTypes) => {
    const project = await projectFixture();
    const value = invocation(`Cancel durably at ${boundary}`);
    const controller = new AbortController();
    const error = await bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks([], {
      onCheck: (phase) => { if (phase === boundary) controller.abort("private reason"); },
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toEqual(expectCode("bootstrap.cancelled"));
    const failure = getResearchBootstrapFailureInternal(error);
    expect(failure).toEqual({
      runId: "run-01010101010101010101010101010101",
      rootPath: expect.any(String),
      lastDurableSeq: eventTypes.length,
      state: "cancelled",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    const events = await readVerifiedLedgerSnapshot(join(failure!.rootPath, ".state", "events.jsonl"), { trustedRoot: failure!.rootPath });
    expect(events.map((event) => event.type)).toEqual(eventTypes);
    const cancellation = events.find((event) => event.type === "cancel_requested");
    expect(cancellation?.payload).toEqual({ executionEpoch: 0, reason: "abort-signal" });
    const transition = events.at(-1);
    expect(transition?.type).toBe("state_changed");
    if (transition?.type === "state_changed") expect(transition.payload.to).toBe("cancelled");
  });

  test("ignores an abort after the final cancellation boundary", async () => {
    const project = await projectFixture();
    const value = invocation("Late abort");
    const controller = new AbortController();
    const result = await bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks([], {
      onCheck: (phase) => { if (phase === "before-final-verify") controller.abort("too late"); },
    }));
    expect(result.state).toBe("planning");
    const events = await readVerifiedLedgerSnapshot(join(result.rootPath, ".state", "events.jsonl"), { trustedRoot: result.rootPath });
    expect(events.map((event) => event.type)).toEqual(["run_created", "state_changed", "active_time_checkpoint"]);
  });

  test("gives cleanup uncertainty precedence over cancellation append persistence failure", async () => {
    const project = await projectFixture();
    const value = invocation("Cancellation persistence cleanup precedence");
    const controller = new AbortController();
    const error = await bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks([], {
      faultAt: "cancelled-transition-durability",
      lockFailAt: "before-release-verify",
      onCheck: (phase) => { if (phase === "after-run-created") controller.abort("private reason"); },
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toEqual(expectCode("bootstrap.cleanup-uncertain"));
    const failure = getResearchBootstrapFailureInternal(error);
    expect(failure).toEqual(expect.objectContaining({ lastDurableSeq: 3, state: "created" }));
    expect((await lstat(join(failure!.rootPath, ".state", "controller.lock"))).isFile()).toBe(true);
  });

  test("gives final root integrity failure precedence over durable cancellation", async () => {
    const project = await projectFixture();
    const value = invocation("Cancellation integrity precedence");
    const controller = new AbortController();
    const error = await bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks([], {
      faultAt: "root-revalidate-before",
      onCheck: (phase) => { if (phase === "after-run-created") controller.abort("private reason"); },
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toEqual(expectCode("bootstrap.integrity-failed"));
    expect(error).toBeInstanceOf(ResearchBootstrapError);
    const failure = getResearchBootstrapFailureInternal(error);
    expect(failure).toEqual({
      runId: "run-01010101010101010101010101010101",
      rootPath: expect.any(String),
      lastDurableSeq: 4,
      state: "unknown",
    });
    expect(Object.isFrozen(failure)).toBe(true);
  });

  test("exposes frozen sidecars only for authentic errors and gives cleanup precedence", async () => {
    expect(getResearchBootstrapFailureInternal(new ResearchBootstrapError("bootstrap.cancelled"))).toBeNull();
    expect(getResearchBootstrapFailureInternal({ code: "bootstrap.cancelled" })).toBeNull();
    let touched = false;
    const proxy = new Proxy({}, { ownKeys() { touched = true; throw new Error("must not enumerate"); } });
    expect(getResearchBootstrapFailureInternal(proxy)).toBeNull();
    expect(touched).toBe(false);

    const project = await projectFixture();
    const value = invocation("Cancellation cleanup precedence");
    const controller = new AbortController();
    const error = await bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks([], {
      lockFailAt: "before-release-verify",
      onCheck: (phase) => { if (phase === "after-run-created") controller.abort("private reason"); },
    })).then(() => null, (caught: unknown) => caught);
    expect(error).toEqual(expectCode("bootstrap.cleanup-uncertain"));
    expect(getResearchBootstrapFailureInternal(error)).toEqual(expect.objectContaining({
      lastDurableSeq: 4,
      state: "cancelled",
    }));
    expect(Object.keys(error as object).sort()).toEqual(["code", "name"]);
    expect(JSON.stringify(error)).not.toContain("rootPath");
  });

  test("rejects calculation-enabled runs before IDs, clocks, approval, hooks, or filesystem creation", async () => {
    const project = await projectFixture();
    const value = invocation("--allow-calculations --calculation-policy policy.json Calculate");
    let touched = 0;
    const testHooks = createResearchBootstrapTestHooksInternal({
      now: () => { touched++; return NOW; },
      monotonicNow: () => { touched++; return 0; },
      randomBytes: (size) => { touched++; return new Uint8Array(size); },
      onCheck: () => { touched++; },
      faultAt: null,
      lockHooks: null,
    });
    const denied = context(project, value, { approveOutside: () => { touched++; return true; } });

    await expect(bootstrapResearchRunInternal(value, denied, testHooks)).rejects.toEqual(expectCode("bootstrap.calculation-runtime-unavailable"));
    expect(touched).toBe(0);
    await expect(readFile(join(project, "research"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed on invalid clocks and cancellation with redacted errors", async () => {
    const project = await projectFixture();
    const value = invocation();
    await expect(bootstrapResearchRunInternal(value, context(project, value), hooks([], {
      now: () => new Date(Number.NaN),
    }))).rejects.toEqual(expectCode("bootstrap.clock-invalid"));

    const controller = new AbortController();
    controller.abort("secret cancellation reason");
    await expect(bootstrapResearchRunInternal(value, context(project, value, { signal: controller.signal }), hooks()))
      .rejects.toEqual(expectCode("bootstrap.cancelled"));
  });

  test("rejects forged nested lock hooks while creating nominal bootstrap hooks", () => {
    expect(() => createResearchBootstrapTestHooksInternal({
      now: () => NOW,
      monotonicNow: () => 0,
      randomBytes: (size) => new Uint8Array(size),
      onCheck: null,
      faultAt: null,
      lockHooks: Object.freeze({ capabilityKind: "research-run-lock-test-hooks" }) as never,
    })).toThrow(expectCode("bootstrap.invalid-input"));
  });

  test("exposes only the closed bootstrap error contract", () => {
    const error = new ResearchBootstrapError("bootstrap.persistence-failed");
    expect(error).toEqual(expectCode("bootstrap.persistence-failed"));
    expect(String(error)).not.toContain("path");
  });
});
