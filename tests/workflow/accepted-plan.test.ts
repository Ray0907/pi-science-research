import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import { openEventLedger, type EventLedger } from "../../src/storage/event-ledger.js";
import { createOwnedRunRoot, type OwnedRunRoot } from "../../src/storage/run-root.js";
import {
  ResearchAcceptedPlanError,
  createAcceptedPlanTestHooksInternal,
  readAcceptedPlanInternal,
  type AcceptedPlanInternal,
} from "../../src/workflow/accepted-plan-internal.js";
import { assertValidatedPlanningTaskBoardInternal } from "../../src/workflow/planning-board-internal.js";
import {
  assertValidatedCoordinatorPlanningResultInternal,
  validateCoordinatorPlanningResultInternal,
  type ValidatedCoordinatorPlanningResultInternal,
} from "../../src/workflow/planning-contract-internal.js";
import {
  acceptPlanningResultInternal,
  createPlanningAcceptanceTestHooksInternal,
} from "../../src/workflow/planning-acceptance-internal.js";

const RUN_ID = `run-${"a".repeat(16)}` as const;
const ATTEMPT_ID = `attempt-${"b".repeat(16)}` as const;
const TX_ID = `tx-${"c".repeat(16)}` as const;
const CONTROL_TASK_ID = `task-${"d".repeat(16)}` as const;
const NOW = "2026-09-16T10:00:00.000Z";
const LATER = "2026-09-16T11:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const MAX_SOURCES = 30;

const roots: string[] = [];
const openLedgers: EventLedger[] = [];
const openRoots: OwnedRunRoot[] = [];

afterEach(async () => {
  for (const ledger of openLedgers.splice(0)) await ledger.close().catch(() => undefined);
  for (const root of openRoots.splice(0)) await root.close().catch(() => undefined);
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => undefined);
});

/** Deterministic, non-repeating byte source: byte value = (call counter + index) mod 256. */
function counterRandomBytes(): (size: number) => Uint8Array {
  let calls = 0;
  return (size) => {
    calls += 1;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) out[i] = (calls * 31 + i) & 0xff;
    return out;
  };
}

function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    schemaVersion: 1, runId: RUN_ID, revision: 1, question: "q", language: "en", depth: "standard",
    reproducible: false, allowCalculations: false, calculationPolicySha256: null, state: "created", checkpointStage: null,
    executionEpoch: 0, outputRoot: "research/run",
    roleModels: { coordinator: "p/m", researcher: "p/m", verifier: "p/m" },
    roleThinking: { coordinator: "medium", researcher: "medium", verifier: "medium" },
    budget: { activeTimeLimitMs: 600_000, activeTimeUsedMs: 0, finalizationReserveMs: 120_000, maxSources: MAX_SOURCES, admittedSources: 0, maxWaves: 3, waveOrdinal: 0 },
    taskRefs: [], attemptRefs: [], acceptedVerificationRef: null, currentRevisionId: null, blocker: null,
    createdAt: NOW, updatedAt: NOW, completedAt: null, ...overrides,
  };
}

function controlTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1, taskId: CONTROL_TASK_ID, revision: 1, description: "coordinator planning",
    evidenceRule: { minimumLineages: 0, independentVerificationAllowed: false, primarySourceRequired: false, fullTextRequired: false },
    role: "coordinator", state: "running", attemptIds: [ATTEMPT_ID], blocker: null, resolution: null, ...overrides,
  };
}

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    schemaVersion: 1, attemptId: ATTEMPT_ID, revision: 1, runId: RUN_ID, taskId: CONTROL_TASK_ID, executionEpoch: 0,
    logicalOperationId: "op-planning-1", attemptOrdinal: 1, retryOfAttemptId: null, attemptKind: "coordinator-planning",
    replayPolicy: "safe-read", state: "intent-recorded", providerModel: "p/m", thinkingLevel: "medium",
    promptTemplateSha256: HASH_A, renderedPromptSha256: HASH_B, logicalInputSha256: HASH_B, attemptEnvelopeSha256: HASH_C,
    toolAllowlist: ["research_input_read", "research_coordinator_submit"], deadlineAt: LATER, capabilityId: "cap-planning",
    resultSha256: null, billingStatus: "unknown", reportedUsage: null, error: null, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

interface Fixture { root: OwnedRunRoot; ledger: EventLedger; project: string }

/** Builds a real run root + ledger and appends the prefix up to `dispatch_started` (spec §15.6). */
async function fixture(options: { stopAfter?: "run_created" | "planning" | "reserved" | "task" | "dispatch_intent" | "dispatch_started"; attemptKind?: AttemptRecord["attemptKind"]; runId?: typeof RUN_ID } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-planning-acceptance-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  const runId = options.runId ?? RUN_ID;
  const root = await createOwnedRunRoot({
    trustedProject: project, repositoryRoot: project, topic: "planning acceptance", runId, ownershipToken: "e".repeat(64), now: () => new Date(NOW),
  });
  openRoots.push(root);
  await mkdir(join(root.path, ".state"), { recursive: true, mode: 0o700 });
  let eventCounter = 0;
  const ledger = await openEventLedger(join(root.path, ".state", "events.jsonl"), {
    now: () => new Date(NOW),
    eventId: () => `event-${String(++eventCounter).padStart(32, "0")}`,
  });
  openLedgers.push(ledger);
  const stop = options.stopAfter ?? "dispatch_started";

  await ledger.append("run_created", { run: runSnapshot({ runId }) });
  if (stop === "run_created") return { root, ledger, project };
  await ledger.append("state_changed", { from: "created", to: "planning", blocker: null });
  if (stop === "planning") return { root, ledger, project };
  await ledger.reserveIdentity("attempt", ATTEMPT_ID, "parent-generated");
  await ledger.reserveIdentity("transaction", TX_ID, "parent-generated");
  if (stop === "reserved") return { root, ledger, project };
  await ledger.append("task_upserted", { task: controlTask() });
  if (stop === "task") return { root, ledger, project };
  await ledger.append("dispatch_intent", { attempt: attemptRecord({ runId, attemptKind: options.attemptKind ?? "coordinator-planning" }) });
  if (stop === "dispatch_intent") return { root, ledger, project };
  await ledger.append("dispatch_started", { attemptId: ATTEMPT_ID, pid: null, requestCorrelation: null });
  return { root, ledger, project };
}

function proposal(proposalId: string, dependsOnProposalIds: string[] = []) {
  return {
    proposalId, description: `describe ${proposalId}`, role: "literature-searcher",
    evidenceRule: { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: true, fullTextRequired: false },
    dependsOnProposalIds,
  };
}

function result(options: { runId?: string; attemptId?: string; proposals?: ReturnType<typeof proposal>[]; maxSources?: number } = {}): ValidatedCoordinatorPlanningResultInternal {
  const runId = options.runId ?? RUN_ID;
  const attemptId = options.attemptId ?? ATTEMPT_ID;
  const tasks = options.proposals ?? [proposal("prop-aaaaaaaa"), proposal("prop-bbbbbbbb", ["prop-aaaaaaaa"])];
  return validateCoordinatorPlanningResultInternal(
    { schemaVersion: 1, runId, attemptId, resultType: "planning", tasks, rationale: "scope first" },
    { runId: runId as never, attemptId: attemptId as never, maxSources: options.maxSources ?? MAX_SOURCES },
  );
}

function input(overrides: Record<string, unknown> = {}) {
  return { attemptId: ATTEMPT_ID, transactionId: TX_ID, createdAt: NOW, ...overrides };
}

async function artifactFiles(root: OwnedRunRoot): Promise<string[]> {
  return readdir(join(root.path, ".state", "planning", "results")).catch(() => [] as string[]);
}

function acceptanceHooks() {
  return createPlanningAcceptanceTestHooksInternal({ randomBytes: counterRandomBytes(), now: () => new Date(NOW), faultAt: null });
}

/** Full slice-4 acceptance on top of the fixture; returns the checkpoint. */
async function accepted(fx: Fixture, authentic = result()) {
  return acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, authentic, input(), { signal: null }, acceptanceHooks());
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<ResearchAcceptedPlanError> {
  try { await operation; } catch (error) {
    expect(error).toBeInstanceOf(ResearchAcceptedPlanError);
    expect((error as ResearchAcceptedPlanError).code).toBe(code);
    expect((error as Error).message).toBe(`Research accepted plan failed (${code})`);
    return error as ResearchAcceptedPlanError;
  }
  return expect.unreachable(`expected ${code}`) as never;
}

/** Snapshot of everything under .state for zero-write assertions: relative path → size + mtimeNs. */
async function stateSnapshot(root: OwnedRunRoot): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name); const r = `${rel}/${entry.name}`;
      const st = await lstat(abs, { bigint: true });
      out[r] = `${st.size}:${st.mtimeNs}`;
      if (entry.isDirectory()) await walk(abs, r);
    }
  };
  await walk(join(root.path, ".state"), ".state");
  return out;
}

describe("ResearchAcceptedPlanError", () => {
  test("closed message and frozen", () => {
    const e = new ResearchAcceptedPlanError("accepted-plan.corrupt");
    expect(e.message).toBe("Research accepted plan failed (accepted-plan.corrupt)");
    expect(Object.isFrozen(e)).toBe(true);
  });
  test("unknown code sanitizes to io-failed", () => {
    expect(new ResearchAcceptedPlanError("accepted-plan.nope" as never).code).toBe("accepted-plan.io-failed");
  });
});

describe("hooks", () => {
  test.each([[null], [[]], [{}], [{ faultAt: "elsewhere" }], [{ faultAt: null, extra: 1 }]])("rejects %j", (d) => {
    expect(() => createAcceptedPlanTestHooksInternal(d)).toThrow(ResearchAcceptedPlanError);
  });
  test("forged capability rejected, undefined accepted", async () => {
    const fx = await fixture();
    const events = await fx.ledger.readAll();
    await expectCode(readAcceptedPlanInternal(fx.root, events, Object.freeze({ capabilityKind: "accepted-plan-test-hooks" })), "accepted-plan.invalid-hooks");
    expect(await readAcceptedPlanInternal(fx.root, events)).toBeNull();
  });
});

describe("no accepted plan yet", () => {
  test("returns null on the dispatch_started prefix, with zero writes", async () => {
    const fx = await fixture();
    const before = await stateSnapshot(fx.root);
    expect(await readAcceptedPlanInternal(fx.root, await fx.ledger.readAll())).toBeNull();
    expect(await stateSnapshot(fx.root)).toEqual(before);
  });
  test("returns null after attempt_failed", async () => {
    const fx = await fixture();
    await fx.ledger.append("attempt_failed", { attemptId: ATTEMPT_ID, state: "terminal-failed", errorClass: "planning.timeout", message: "planning.timeout" });
    expect(await readAcceptedPlanInternal(fx.root, await fx.ledger.readAll())).toBeNull();
  });
  test("returns null on an empty ledger snapshot", async () => {
    const fx = await fixture({ stopAfter: "run_created" });
    expect(await readAcceptedPlanInternal(fx.root, await fx.ledger.readAll())).toBeNull();
  });
});

describe("input validation", () => {
  test.each([["not array", {}], ["non-record element", [1]], ["proxied array", new Proxy([], {})]])("invalid-events: %s", async (_l, events) => {
    const fx = await fixture();
    await expectCode(readAcceptedPlanInternal(fx.root, events), "accepted-plan.invalid-events");
  });
  test("reducer corruption → invalid-events", async () => {
    const fx = await fixture();
    const events = await fx.ledger.readAll();
    await expectCode(readAcceptedPlanInternal(fx.root, [events[1]!]), "accepted-plan.invalid-events");
  });
  test("invalid-root after owner marker removal", async () => {
    const fx = await fixture();
    const events = await fx.ledger.readAll();
    await rm(join(fx.root.path, ".pi-science-research-owner.json"), { force: true });
    await expectCode(readAcceptedPlanInternal(fx.root, events), "accepted-plan.invalid-root");
  });
});

describe("accepted plan (happy path)", () => {
  test("rehydrates the plan the acceptance protocol committed, with zero writes", async () => {
    const fx = await fixture();
    const authentic = result();
    const checkpoint = await accepted(fx, authentic);
    const before = await stateSnapshot(fx.root);
    const events = await fx.ledger.readAll();

    const plan = await readAcceptedPlanInternal(fx.root, events);
    expect(plan).not.toBeNull();
    const p = plan as AcceptedPlanInternal;
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.runId).toBe(RUN_ID);
    expect(p.attemptId).toBe(ATTEMPT_ID);
    expect(p.transactionId).toBe(TX_ID);
    expect(p.controlTaskId).toBe(CONTROL_TASK_ID);
    expect(p.resultSeq).toBe(checkpoint.resultSeq);
    expect(p.resultSha256).toBe(checkpoint.resultSha256);
    expect(p.maxSources).toBe(MAX_SOURCES);
    expect(p.artifact).toEqual(checkpoint.artifact);
    expect(() => assertValidatedCoordinatorPlanningResultInternal(p.result)).not.toThrow();
    expect(() => assertValidatedPlanningTaskBoardInternal(p.board)).not.toThrow();
    expect(sha256Hex(canonicalJsonBytes(p.result))).toBe(checkpoint.resultSha256);
    expect(p.taskRefs).toEqual(checkpoint.taskRefs.map((ref) => ({ taskId: ref.taskId, revision: 1 })));
    expect(await stateSnapshot(fx.root)).toEqual(before);
  });

  test("taskRefs report the latest ledger revision of each board task", async () => {
    const fx = await fixture();
    const checkpoint = await accepted(fx);
    const first = checkpoint.taskRefs[0]!.taskId;
    const events0 = await fx.ledger.readAll();
    const record = events0.filter((event) => event.type === "task_upserted")
      .map((event) => (event as Extract<typeof event, { type: "task_upserted" }>).payload.task)
      .find((task) => task.taskId === first)!;
    await fx.ledger.append("task_upserted", { task: { ...record, revision: 2, state: "ready" } });
    const plan = (await readAcceptedPlanInternal(fx.root, await fx.ledger.readAll()))!;
    expect(plan.taskRefs.find((ref) => ref.taskId === first)?.revision).toBe(2);
  });

  test("a budget_amended appended after acceptance does not invalidate the plan", async () => {
    const fx = await fixture();
    await accepted(fx);
    const budget = runSnapshot().budget;
    await fx.ledger.append("budget_amended", { oldBudget: budget, newBudget: { ...budget, maxSources: 1 }, operatorSource: "tui", reason: "later" });
    const plan = await readAcceptedPlanInternal(fx.root, await fx.ledger.readAll());
    expect(plan?.maxSources).toBe(MAX_SOURCES);
  });
});

describe("corruption fails closed", () => {
  test("artifact file deleted → corrupt (never null)", async () => {
    const fx = await fixture();
    const checkpoint = await accepted(fx);
    await rm(join(fx.root.path, checkpoint.artifact.relativePath));
    await expectCode(readAcceptedPlanInternal(fx.root, await fx.ledger.readAll()), "accepted-plan.corrupt");
  });

  test("artifact bytes replaced (same path) → corrupt", async () => {
    const fx = await fixture();
    const checkpoint = await accepted(fx);
    await writeFile(join(fx.root.path, checkpoint.artifact.relativePath), "{}");
    await expectCode(readAcceptedPlanInternal(fx.root, await fx.ledger.readAll()), "accepted-plan.corrupt");
  });

  test("tampered resultSha256 in the snapshot → corrupt", async () => {
    const fx = await fixture();
    await accepted(fx);
    const events = (await fx.ledger.readAll()).map((event) => event.type === "result_recorded"
      ? { ...event, payload: { ...event.payload, resultSha256: HASH_A } }
      : event);
    await expectCode(readAcceptedPlanInternal(fx.root, events), "accepted-plan.corrupt");
  });

  test("board task missing from the snapshot → corrupt", async () => {
    const fx = await fixture();
    const checkpoint = await accepted(fx);
    const drop = checkpoint.taskRefs[1]!.taskId;
    const events = (await fx.ledger.readAll()).filter((event) => !(event.type === "task_upserted" && event.payload.task.taskId === drop));
    // The reducer accepts this snapshot; the reader must detect the missing committed board record.
    await expectCode(readAcceptedPlanInternal(fx.root, events), "accepted-plan.corrupt");
  });

  test("manifestSha256 null on a committed planning attempt → missing-artifact-ref", async () => {
    const fx = await fixture();
    await accepted(fx);
    const events = (await fx.ledger.readAll()).map((event) => event.type === "result_recorded"
      ? { ...event, payload: { ...event.payload, manifestSha256: null } }
      : event);
    await expectCode(readAcceptedPlanInternal(fx.root, events), "accepted-plan.missing-artifact-ref");
  });

  test("two committed planning attempts → ambiguous", async () => {
    const fx = await fixture();
    await accepted(fx);
    const ATTEMPT_2 = `attempt-${"e".repeat(16)}` as const;
    const TX_2 = `tx-${"e".repeat(16)}` as const;
    const CONTROL_2 = `task-${"e".repeat(16)}` as const;
    await fx.ledger.reserveIdentity("attempt", ATTEMPT_2, "parent-generated");
    await fx.ledger.reserveIdentity("transaction", TX_2, "parent-generated");
    await fx.ledger.append("task_upserted", { task: controlTask({ taskId: CONTROL_2, attemptIds: [ATTEMPT_2] }) });
    await fx.ledger.append("dispatch_intent", { attempt: attemptRecord({ attemptId: ATTEMPT_2, taskId: CONTROL_2, logicalOperationId: "op-planning-2" }) });
    await fx.ledger.append("dispatch_started", { attemptId: ATTEMPT_2, pid: null, requestCorrelation: null });
    let calls = 100;
    const secondRandomBytes = (size: number) => {
      calls += 1;
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) out[i] = (calls * 31 + i) & 0xff;
      return out;
    };
    const secondHooks = createPlanningAcceptanceTestHooksInternal({ randomBytes: secondRandomBytes, now: () => new Date(NOW), faultAt: null });
    await acceptPlanningResultInternal(
      { root: fx.root, ledger: fx.ledger }, result({ attemptId: ATTEMPT_2 }),
      { attemptId: ATTEMPT_2, transactionId: TX_2, createdAt: NOW }, { signal: null }, secondHooks,
    );
    await expectCode(readAcceptedPlanInternal(fx.root, await fx.ledger.readAll()), "accepted-plan.ambiguous");
  });

  test("fault injection maps to io-failed and writes nothing", async () => {
    const fx = await fixture();
    await accepted(fx);
    const before = await stateSnapshot(fx.root);
    for (const faultAt of ["before-artifact-read", "after-artifact-read"] as const) {
      await expectCode(
        readAcceptedPlanInternal(fx.root, await fx.ledger.readAll(), createAcceptedPlanTestHooksInternal({ faultAt })),
        "accepted-plan.io-failed",
      );
    }
    expect(await stateSnapshot(fx.root)).toEqual(before);
  });
});
