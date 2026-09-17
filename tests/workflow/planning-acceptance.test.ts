import { mkdir, mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import { reduceLedgerEvents } from "../../src/domain/reducer.js";
import { openEventLedger, type EventLedger } from "../../src/storage/event-ledger.js";
import { createOwnedRunRoot, type OwnedRunRoot } from "../../src/storage/run-root.js";
import { readPlanningArtifactInternal } from "../../src/storage/planning-artifact-internal.js";
import { verifyTransaction } from "../../src/storage/transaction-store.js";
import {
  validateCoordinatorPlanningResultInternal,
  type ValidatedCoordinatorPlanningResultInternal,
} from "../../src/workflow/planning-contract-internal.js";
import {
  ResearchPlanningAcceptanceError,
  acceptPlanningResultInternal,
  createPlanningAcceptanceTestHooksInternal,
  getPlanningAcceptanceFailureInternal,
  type PlanningAcceptanceFaultInternal,
  type PlanningAcceptanceTestHooksInternal,
} from "../../src/workflow/planning-acceptance-internal.js";

const RUN_ID = `run-${"a".repeat(16)}` as const;
const ATTEMPT_ID = `attempt-${"b".repeat(16)}` as const;
const TX_ID = `tx-${"c".repeat(16)}` as const;
const CONTROL_TASK_ID = `task-${"d".repeat(16)}` as const;
const OTHER_TX_ID = `tx-${"f".repeat(16)}` as const;
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

function hooks(overrides: { randomBytes?: (size: number) => Uint8Array; now?: () => Date; faultAt?: PlanningAcceptanceFaultInternal | null } = {}): PlanningAcceptanceTestHooksInternal {
  return createPlanningAcceptanceTestHooksInternal({
    randomBytes: overrides.randomBytes ?? counterRandomBytes(),
    now: overrides.now ?? (() => new Date(NOW)),
    faultAt: overrides.faultAt ?? null,
  });
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

async function expectCode(operation: Promise<unknown>, code: string): Promise<ResearchPlanningAcceptanceError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningAcceptanceError);
    expect((error as ResearchPlanningAcceptanceError).code).toBe(code);
    expect((error as Error).message).toBe(`Research planning acceptance failed (${code})`);
    return error as ResearchPlanningAcceptanceError;
  }
  return expect.unreachable(`expected ${code}`) as never;
}

async function ledgerLength(ledger: EventLedger): Promise<number> {
  return (await ledger.readAll()).length;
}

async function artifactFiles(root: OwnedRunRoot): Promise<string[]> {
  return readdir(join(root.path, ".state", "planning", "results")).catch(() => [] as string[]);
}

describe("ResearchPlanningAcceptanceError", () => {
  test("uses the closed message shape and freezes instances", () => {
    const error = new ResearchPlanningAcceptanceError("planning-acceptance.cancelled");
    expect(error.message).toBe("Research planning acceptance failed (planning-acceptance.cancelled)");
    expect(error.name).toBe("ResearchPlanningAcceptanceError");
    expect(Object.isFrozen(error)).toBe(true);
  });

  test("sanitizes an unknown code to ledger-failed", () => {
    const error = new ResearchPlanningAcceptanceError("planning-acceptance.nope" as never);
    expect(error.code).toBe("planning-acceptance.ledger-failed");
    expect(error.message).toBe("Research planning acceptance failed (planning-acceptance.ledger-failed)");
  });
});

describe("test hooks capability", () => {
  test("accepts an exact descriptor and returns a frozen capability", () => {
    const capability = hooks();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(capability.capabilityKind).toBe("planning-acceptance-test-hooks");
  });

  test.each([
    ["missing field", { randomBytes: () => new Uint8Array(16), now: () => new Date(NOW) }],
    ["extra field", { randomBytes: () => new Uint8Array(16), now: () => new Date(NOW), faultAt: null, extra: 1 }],
    ["unknown fault", { randomBytes: () => new Uint8Array(16), now: () => new Date(NOW), faultAt: "after-everything" }],
    ["non-function now", { randomBytes: () => new Uint8Array(16), now: NOW, faultAt: null }],
    ["null", null],
    ["array", []],
  ])("rejects a malformed descriptor: %s", (_label, descriptor) => {
    expect(() => createPlanningAcceptanceTestHooksInternal(descriptor)).toThrow(ResearchPlanningAcceptanceError);
    try { createPlanningAcceptanceTestHooksInternal(descriptor); } catch (error) {
      expect((error as ResearchPlanningAcceptanceError).code).toBe("planning-acceptance.invalid-hooks");
    }
  });

  test("rejects a proxied descriptor", () => {
    const descriptor = new Proxy({ randomBytes: () => new Uint8Array(16), now: () => new Date(NOW), faultAt: null }, {});
    expect(() => createPlanningAcceptanceTestHooksInternal(descriptor)).toThrow(ResearchPlanningAcceptanceError);
  });

  test("getPlanningAcceptanceFailureInternal returns null for foreign errors", () => {
    expect(getPlanningAcceptanceFailureInternal(new Error("x"))).toBeNull();
    expect(getPlanningAcceptanceFailureInternal(null)).toBeNull();
    expect(getPlanningAcceptanceFailureInternal(new ResearchPlanningAcceptanceError("planning-acceptance.cancelled"))).toBeNull();
  });
});

describe("input / context / result / hooks validation (before any ledger read)", () => {
  test("rejects a forged same-shape result", async () => {
    const { root, ledger } = await fixture();
    const before = await ledgerLength(ledger);
    const forged = JSON.parse(JSON.stringify(result()));
    await expectCode(acceptPlanningResultInternal({ root, ledger }, forged, input(), { signal: null }, hooks()), "planning-acceptance.invalid-result");
    expect(await ledgerLength(ledger)).toBe(before);
    expect(await artifactFiles(root)).toEqual([]);
  });

  test.each([
    ["missing createdAt", { attemptId: ATTEMPT_ID, transactionId: TX_ID }],
    ["extra key", { attemptId: ATTEMPT_ID, transactionId: TX_ID, createdAt: NOW, extra: true }],
    ["bad attempt pattern", { attemptId: "attempt-short", transactionId: TX_ID, createdAt: NOW }],
    ["bad transaction pattern", { attemptId: ATTEMPT_ID, transactionId: "tx-short", createdAt: NOW }],
    ["bad timestamp", { attemptId: ATTEMPT_ID, transactionId: TX_ID, createdAt: "yesterday" }],
    ["null", null],
  ])("rejects malformed input: %s", async (_label, badInput) => {
    const { root, ledger } = await fixture();
    const before = await ledgerLength(ledger);
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), badInput, { signal: null }, hooks()), "planning-acceptance.invalid-input");
    expect(await ledgerLength(ledger)).toBe(before);
  });

  test("rejects a getter-decorated input", async () => {
    const { root, ledger } = await fixture();
    const decorated = Object.defineProperty({ attemptId: ATTEMPT_ID, transactionId: TX_ID }, "createdAt", { get: () => NOW, enumerable: true });
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), decorated, { signal: null }, hooks()), "planning-acceptance.invalid-input");
  });

  test("rejects a proxied input with zero ledger writes", async () => {
    const { root, ledger } = await fixture();
    const before = await ledgerLength(ledger);
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), new Proxy(input(), {}), { signal: null }, hooks()), "planning-acceptance.invalid-input");
    expect(await ledgerLength(ledger)).toBe(before);
  });

  test("rejects a proxied context with zero ledger writes", async () => {
    const { root, ledger } = await fixture();
    const before = await ledgerLength(ledger);
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), input(), new Proxy({ signal: null }, {}), hooks()), "planning-acceptance.invalid-context");
    expect(await ledgerLength(ledger)).toBe(before);
  });

  test("rejects a getter-decorated context with zero ledger writes", async () => {
    const { root, ledger } = await fixture();
    const before = await ledgerLength(ledger);
    const context = Object.defineProperty({}, "signal", { get: () => null, enumerable: true });
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), input(), context, hooks()), "planning-acceptance.invalid-context");
    expect(await ledgerLength(ledger)).toBe(before);
  });

  test.each([
    ["missing signal", {}],
    ["extra key", { signal: null, extra: 1 }],
    ["non-signal", { signal: "abort" }],
    ["null", null],
  ])("rejects malformed context: %s", async (_label, badContext) => {
    const { root, ledger } = await fixture();
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), input(), badContext, hooks()), "planning-acceptance.invalid-context");
  });

  test("rejects a forged hooks capability but accepts undefined", async () => {
    const { root, ledger } = await fixture();
    const forged = Object.freeze({ capabilityKind: "planning-acceptance-test-hooks" });
    await expectCode(acceptPlanningResultInternal({ root, ledger }, result(), input(), { signal: null }, forged), "planning-acceptance.invalid-hooks");
  });

  test("rejects a scope missing root or ledger", async () => {
    const { root, ledger } = await fixture();
    await expectCode(acceptPlanningResultInternal({ root } as never, result(), input(), { signal: null }, hooks()), "planning-acceptance.invalid-input");
    await expectCode(acceptPlanningResultInternal({ ledger } as never, result(), input(), { signal: null }, hooks()), "planning-acceptance.invalid-input");
  });

  test("maps a foreign scope getter error to the closed ledger failure", async () => {
    const fx = await fixture();
    const before = await ledgerLength(fx.ledger);
    const root = Object.defineProperty({}, "path", { get: () => { throw new Error("boom /secret/path"); } });
    const error = await expectCode(
      acceptPlanningResultInternal({ root, ledger: fx.ledger } as never, result(), input(), { signal: null }, hooks()),
      "planning-acceptance.ledger-failed",
    );
    expect(JSON.stringify({ name: error.name, code: error.code, message: error.message })).not.toContain("secret");
    expect(await ledgerLength(fx.ledger)).toBe(before);
  });
});

describe("preconditions (ledger-derived, zero side effects)", () => {
  async function expectPrecondition(fx: Fixture, code: string, options: { result?: ValidatedCoordinatorPlanningResultInternal; input?: Record<string, unknown>; hooks?: PlanningAcceptanceTestHooksInternal } = {}) {
    const before = await ledgerLength(fx.ledger);
    await expectCode(
      acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, options.result ?? result(), options.input ?? input(), { signal: null }, options.hooks ?? hooks()),
      code,
    );
    expect(await ledgerLength(fx.ledger)).toBe(before);
    expect(await artifactFiles(fx.root)).toEqual([]);
    await fx.ledger.verify();
  }

  test("rejects when the run is still in created state", async () => {
    await expectPrecondition(await fixture({ stopAfter: "run_created" }), "planning-acceptance.precondition-failed");
  });

  test("rejects when the attempt has no dispatch_intent", async () => {
    await expectPrecondition(await fixture({ stopAfter: "task" }), "planning-acceptance.precondition-failed");
  });

  test("rejects when the attempt is at intent phase (no dispatch_started)", async () => {
    await expectPrecondition(await fixture({ stopAfter: "dispatch_intent" }), "planning-acceptance.precondition-failed");
  });

  test("rejects a non-planning attempt kind", async () => {
    await expectPrecondition(await fixture({ attemptKind: "research" }), "planning-acceptance.precondition-failed");
  });

  test("rejects when epoch 0 has been cancelled", async () => {
    const fx = await fixture();
    await fx.ledger.append("cancel_requested", { executionEpoch: 0, reason: "abort-signal" });
    await expectPrecondition(fx, "planning-acceptance.precondition-failed");
  });

  test("rejects an unreserved transaction id", async () => {
    await expectPrecondition(await fixture(), "planning-acceptance.precondition-failed", { input: input({ transactionId: OTHER_TX_ID }) });
  });

  test("rejects a transaction id already consumed by a result_recorded", async () => {
    const fx = await fixture();
    await fx.ledger.append("result_recorded", { attemptId: ATTEMPT_ID, resultSha256: HASH_A, manifestSha256: null, transactionId: TX_ID });
    await expectPrecondition(fx, "planning-acceptance.precondition-failed");
  });

  test("rejects a result bound to another run", async () => {
    const other = `run-${"9".repeat(16)}`;
    await expectPrecondition(await fixture(), "planning-acceptance.precondition-failed", { result: result({ runId: other }) });
  });

  test("rejects a result bound to another attempt", async () => {
    const other = `attempt-${"9".repeat(16)}`;
    await expectPrecondition(await fixture(), "planning-acceptance.precondition-failed", { result: result({ attemptId: other }) });
  });

  test("rejects when the ledger-derived maxSources is below an evidence rule's lineage requirement", async () => {
    const fx = await fixture();
    const before = runSnapshot().budget;
    await fx.ledger.append("budget_amended", { oldBudget: before, newBudget: { ...before, maxSources: 1 }, operatorSource: "tui", reason: "test" });
    const base = proposal("prop-00000000");
    const needsTwo = { ...base, evidenceRule: { ...base.evidenceRule, minimumLineages: 2 } };
    await expectPrecondition(fx, "planning-acceptance.precondition-failed", { result: result({ proposals: [needsTwo] }) });
  });

  test("rejects when the control task is not running", async () => {
    const fx = await fixture({ stopAfter: "reserved" });
    await fx.ledger.append("task_upserted", { task: controlTask({ state: "blocked", blocker: { code: "x", message: "y" } }) });
    await expectPrecondition(fx, "planning-acceptance.precondition-failed");
  });

  test("rejects a generated task id that collides with an existing task", async () => {
    const fx = await fixture();
    const collidingSuffix = "11".repeat(16);
    await fx.ledger.append("task_upserted", { task: controlTask({ taskId: `task-${collidingSuffix}`, role: "literature-searcher", state: "open", attemptIds: [] }) });
    const constant = () => new Uint8Array(16).fill(0x11);
    await expectPrecondition(fx, "planning-acceptance.task-id-collision", {
      result: result({ proposals: [proposal("prop-aaaaaaaa")] }),
      hooks: hooks({ randomBytes: constant }),
    });
  });

  test("rejects when the run root no longer validates", async () => {
    const fx = await fixture();
    await rm(join(fx.root.path, ".pi-science-research-owner.json"), { force: true });
    await expectPrecondition(fx, "planning-acceptance.precondition-failed");
  });

  test("maps a foreign ledger read error to the closed ledger failure", async () => {
    const fx = await fixture();
    const before = await ledgerLength(fx.ledger);
    const ledger: EventLedger = {
      append: fx.ledger.append.bind(fx.ledger),
      reserveIdentity: fx.ledger.reserveIdentity.bind(fx.ledger),
      readAll: async () => { throw new Error("boom /secret/path"); },
      verify: fx.ledger.verify.bind(fx.ledger),
      close: fx.ledger.close.bind(fx.ledger),
    };
    const error = await expectCode(
      acceptPlanningResultInternal({ root: fx.root, ledger }, result(), input(), { signal: null }, hooks()),
      "planning-acceptance.ledger-failed",
    );
    expect(JSON.stringify({ name: error.name, code: error.code, message: error.message })).not.toContain("secret");
    expect(await ledgerLength(fx.ledger)).toBe(before);
  });
});

describe("acceptance protocol (happy path)", () => {
  test("appends the full V1 commit chain, pins both hashes, and returns a frozen checkpoint", async () => {
    const fx = await fixture();
    const before = await fx.ledger.readAll();
    const authentic = result();

    const checkpoint = await acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, authentic, input(), { signal: null }, hooks());

    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.artifact)).toBe(true);
    expect(Object.isFrozen(checkpoint.taskRefs)).toBe(true);
    expect(checkpoint.runId).toBe(RUN_ID);
    expect(checkpoint.attemptId).toBe(ATTEMPT_ID);
    expect(checkpoint.transactionId).toBe(TX_ID);
    expect(checkpoint.controlTaskId).toBe(CONTROL_TASK_ID);
    expect(checkpoint.taskRefs).toHaveLength(2);
    expect(checkpoint.resultSha256).toBe(sha256Hex(canonicalJsonBytes(authentic)));

    const after = await fx.ledger.readAll();
    await fx.ledger.verify();
    const appended = after.slice(before.length);
    expect(appended.map((event) => event.type)).toEqual([
      "result_recorded", "records_committed", "attempt_committed", "task_upserted", "task_upserted", "task_upserted",
    ]);
    const recorded = appended[0]!;
    if (recorded.type !== "result_recorded") throw new Error("unreachable");
    expect(recorded.seq).toBe(checkpoint.resultSeq);
    expect(recorded.payload).toEqual({ attemptId: ATTEMPT_ID, resultSha256: checkpoint.resultSha256, manifestSha256: checkpoint.artifact.sha256, transactionId: TX_ID });
    const artifactBytes = await readFile(join(fx.root.path, checkpoint.artifact.relativePath));
    expect(sha256Hex(artifactBytes)).toBe(recorded.payload.manifestSha256);
    expect(recorded.payload.manifestSha256).toBe(checkpoint.artifact.sha256);
    expect(artifactBytes.length).toBe(checkpoint.artifact.decodedBytes);
    const records = appended[1]!;
    if (records.type !== "records_committed") throw new Error("unreachable");
    expect(records.payload.sourceResultSeq).toBe(checkpoint.resultSeq);
    expect(records.payload.transactionId).toBe(TX_ID);
    for (const key of ["sourceRefs", "claimRefs", "evidenceRefs", "verificationRefs", "requestIds", "calculationIds"] as const) expect(records.payload[key]).toEqual([]);
    const committed = appended[2]!;
    if (committed.type !== "attempt_committed") throw new Error("unreachable");
    expect(committed.payload).toEqual({ attemptId: ATTEMPT_ID, transactionId: TX_ID, taskId: CONTROL_TASK_ID, sourceResultSeq: checkpoint.resultSeq });
    const control = appended[3]!;
    if (control.type !== "task_upserted") throw new Error("unreachable");
    expect(control.payload.task).toEqual(controlTask({ revision: 2, state: "resolved", resolution: "coordinator-planning-accepted" }));
    const boardTasks = appended.slice(4).map((event) => (event.type === "task_upserted" ? event.payload.task : null));
    expect(boardTasks.map((task) => task?.taskId)).toEqual(checkpoint.taskRefs.map((ref) => ref.taskId));
    for (const task of boardTasks) {
      expect(task?.revision).toBe(1);
      expect(task?.state).toBe("open");
      expect(task?.attemptIds).toEqual([]);
    }

    const reduced = reduceLedgerEvents(after);
    const attemptState = Object.values(reduced.operations).flatMap((op) => op.attempts).find((a) => a.attemptId === ATTEMPT_ID);
    expect(attemptState?.phase).toBe("committed");
    expect(attemptState?.transactionId).toBe(TX_ID);
    expect(attemptState?.resultSeq).toBe(checkpoint.resultSeq);
    expect(reduced.runState).toBe("planning");

    const verified = await verifyTransaction(fx.root.path, { transactionId: TX_ID, relativePath: records.payload.transactionManifestPath, sha256: records.payload.transactionManifestSha256 });
    expect(verified.manifest.sourceResultSeq).toBe(checkpoint.resultSeq);
    expect(verified.manifest.attemptId).toBe(ATTEMPT_ID);

    const rehydrated = await readPlanningArtifactInternal(fx.root, checkpoint.artifact, {
      runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: MAX_SOURCES,
      attemptEnvelopeSha256: HASH_C, logicalInputSha256: HASH_B, controlTaskId: CONTROL_TASK_ID,
    });
    expect(rehydrated.board.tasks.map((m) => m.task.taskId)).toEqual(checkpoint.taskRefs.map((ref) => ref.taskId));
    expect(checkpoint.artifact.relativePath).toBe(`.state/planning/results/${checkpoint.artifact.sha256}.json`);
  });

  test("reuses a byte-identical pre-existing artifact instead of rejecting it", async () => {
    const fx = await fixture();
    const authentic = result();
    await expectCode(
      acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, authentic, input(), { signal: null }, hooks({ faultAt: "before-result-recorded", randomBytes: counterRandomBytes() })),
      "planning-acceptance.ledger-failed",
    );
    expect(await artifactFiles(fx.root)).toHaveLength(1);
    const checkpoint = await acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, authentic, input(), { signal: null }, hooks({ randomBytes: counterRandomBytes() }));
    expect(await artifactFiles(fx.root)).toEqual([`${checkpoint.artifact.sha256}.json`]);
  });

  test("emits board tasks in topological order, not submission order", async () => {
    const fx = await fixture();
    const authentic = result({ proposals: [proposal("prop-bbbbbbbb", ["prop-aaaaaaaa"]), proposal("prop-aaaaaaaa")] });
    const checkpoint = await acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, authentic, input(), { signal: null }, hooks());
    const rehydrated = await readPlanningArtifactInternal(fx.root, checkpoint.artifact, {
      runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: MAX_SOURCES,
      attemptEnvelopeSha256: HASH_C, logicalInputSha256: HASH_B, controlTaskId: CONTROL_TASK_ID,
    });
    expect(rehydrated.board.tasks.map((m) => m.proposalId)).toEqual(["prop-aaaaaaaa", "prop-bbbbbbbb"]);
    expect(checkpoint.taskRefs.map((r) => r.taskId)).toEqual(rehydrated.board.tasks.map((m) => m.task.taskId));
  });
});

describe("cancellation", () => {
  test("an already-aborted signal yields cancelled with zero ledger writes (artifact may exist)", async () => {
    const fx = await fixture();
    const before = await ledgerLength(fx.ledger);
    const controller = new AbortController();
    controller.abort();
    const error = await expectCode(
      acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, result(), input(), { signal: controller.signal }, hooks()),
      "planning-acceptance.cancelled",
    );
    expect(getPlanningAcceptanceFailureInternal(error)).toBeNull();
    expect(await ledgerLength(fx.ledger)).toBe(before);
    expect(await artifactFiles(fx.root)).toHaveLength(1);
    await fx.ledger.verify();
  });

  test("a signal aborted after result_recorded does not stop the protocol", async () => {
    const fx = await fixture();
    const controller = new AbortController();
    const originalAppend = fx.ledger.append.bind(fx.ledger);
    let appends = 0;
    const observingLedger: EventLedger = {
      ...fx.ledger,
      append: (async (type, payload) => {
        const event = await originalAppend(type, payload);
        appends += 1;
        if (appends === 1) controller.abort();
        return event;
      }) as EventLedger["append"],
      readAll: fx.ledger.readAll.bind(fx.ledger),
      verify: fx.ledger.verify.bind(fx.ledger),
      reserveIdentity: fx.ledger.reserveIdentity.bind(fx.ledger),
      close: fx.ledger.close.bind(fx.ledger),
    };
    const checkpoint = await acceptPlanningResultInternal({ root: fx.root, ledger: observingLedger }, result(), input(), { signal: controller.signal }, hooks());
    expect(controller.signal.aborted).toBe(true);
    expect(checkpoint.taskRefs).toHaveLength(2);
    await fx.ledger.verify();
  });
});

describe("fault injection and sidecar", () => {
  const CASES: { fault: PlanningAcceptanceFaultInternal; code: string; appended: number; stage: string | null }[] = [
    { fault: "before-artifact-write", code: "planning-acceptance.artifact-failed", appended: 0, stage: null },
    { fault: "before-result-recorded", code: "planning-acceptance.ledger-failed", appended: 0, stage: "result-recorded" },
    { fault: "after-result-recorded", code: "planning-acceptance.ledger-failed", appended: 1, stage: "result-recorded" },
    { fault: "after-transaction-commit", code: "planning-acceptance.ledger-failed", appended: 1, stage: "transaction" },
    { fault: "after-records-committed", code: "planning-acceptance.ledger-failed", appended: 2, stage: "records-committed" },
    { fault: "after-attempt-committed", code: "planning-acceptance.ledger-failed", appended: 3, stage: "attempt-committed" },
    { fault: "after-control-task-resolved", code: "planning-acceptance.ledger-failed", appended: 4, stage: "control-task" },
    { fault: "after-first-board-task", code: "planning-acceptance.ledger-failed", appended: 5, stage: "board-tasks" },
    { fault: "before-final-verify", code: "planning-acceptance.ledger-failed", appended: 6, stage: "final-verify" },
  ];

  test.each(CASES)("fault at $fault → $code, $appended events appended, ledger still verifies", async ({ fault, code, appended, stage }) => {
    const fx = await fixture();
    const before = await fx.ledger.readAll();
    const error = await expectCode(
      acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, result(), input(), { signal: null }, hooks({ faultAt: fault })),
      code,
    );
    const after = await fx.ledger.readAll();
    expect(after.length - before.length).toBe(appended);
    await fx.ledger.verify();
    expect(() => reduceLedgerEvents(after)).not.toThrow();
    const sidecar = getPlanningAcceptanceFailureInternal(error);
    if (stage === null) {
      expect(sidecar).toBeNull();
    } else if (appended === 0) {
      expect(sidecar).toEqual({ lastDurableSeq: before[before.length - 1]!.seq, stage });
    } else {
      expect(sidecar).toEqual({ lastDurableSeq: after[after.length - 1]!.seq, stage });
      expect(Object.isFrozen(sidecar)).toBe(true);
    }
  });

  test("a fault before the final verify leaves a fully committed chain the reducer accepts as committed", async () => {
    const fx = await fixture();
    await expectCode(
      acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, result(), input(), { signal: null }, hooks({ faultAt: "before-final-verify" })),
      "planning-acceptance.ledger-failed",
    );
    const reduced = reduceLedgerEvents(await fx.ledger.readAll());
    const attemptState = Object.values(reduced.operations).flatMap((op) => op.attempts).find((a) => a.attemptId === ATTEMPT_ID);
    expect(attemptState?.phase).toBe("committed");
  });

  test("a second acceptance for the same attempt after success is rejected with zero new events", async () => {
    const fx = await fixture();
    await acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, result(), input(), { signal: null }, hooks());
    const before = await ledgerLength(fx.ledger);
    await expectCode(acceptPlanningResultInternal({ root: fx.root, ledger: fx.ledger }, result(), input(), { signal: null }, hooks()), "planning-acceptance.precondition-failed");
    expect(await ledgerLength(fx.ledger)).toBe(before);
  });
});
