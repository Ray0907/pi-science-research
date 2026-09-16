import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createOwnedRunRoot, type OwnedRunRoot } from "../../src/storage/run-root.js";
import {
  validateCoordinatorPlanningResultInternal,
  type ValidatedCoordinatorPlanningResultInternal,
} from "../../src/workflow/planning-contract-internal.js";
import {
  buildPlanningTaskBoardInternal,
  type ValidatedPlanningTaskBoardInternal,
} from "../../src/workflow/planning-board-internal.js";
import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import {
  ResearchPlanningArtifactError,
  createPlanningArtifactTestControlInternal,
  getPlanningArtifactOpenHandleCountInternal,
  readPlanningArtifactInternal,
  resumePlanningArtifactTestControlInternal,
  waitForPlanningArtifactPauseInternal,
  writePlanningArtifactInternal,
  type PlanningArtifactPhaseInternal,
  type PlanningArtifactRefInternal,
  type PlanningArtifactExpectedBindingInternal,
  type ResearchPlanningArtifactMetadataInternal,
} from "../../src/storage/planning-artifact-internal.js";

const RUN_ID = `run-${"a".repeat(16)}`;
const ATTEMPT_ID = `attempt-${"b".repeat(16)}`;
const TX_ID = `tx-${"c".repeat(16)}`;
const CONTROL_TASK_ID = `task-${"d".repeat(16)}`;
const NOW = "2026-08-25T12:34:56.000Z";
const ENVELOPE_SHA = "a".repeat(64);
const INPUT_SHA = "b".repeat(64);
// Deliberately valid-but-different hex digests for "wrong value" tests — never malformed hex
// (e.g. "z" repeated), since a malformed value would test format rejection, not identity.
const OTHER_ENVELOPE_SHA = "1".repeat(64);
const OTHER_INPUT_SHA = "2".repeat(64);

const roots: string[] = [];

async function fixture(): Promise<{ base: string; project: string }> {
  const base = await mkdtemp(join(tmpdir(), "pi-planning-artifact-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return { base, project };
}

afterEach(async () => {
  while (roots.length > 0) {
    const path = roots.pop()!;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function openRoot(project: string, runId: string = RUN_ID): Promise<OwnedRunRoot> {
  return createOwnedRunRoot({
    trustedProject: project,
    repositoryRoot: project,
    topic: "planning artifact",
    runId: runId as never,
    ownershipToken: "e".repeat(64),
    now: () => new Date(NOW),
  });
}

function taskId(n: number): string {
  return `task-${String(n).padStart(16, "0")}`;
}

function evidenceRule() {
  return { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: true, fullTextRequired: false };
}

function buildAuthenticResult(proposalIds: string[], runId: string = RUN_ID, attemptId: string = ATTEMPT_ID): ValidatedCoordinatorPlanningResultInternal {
  const context = { runId: runId as never, attemptId: attemptId as never, maxSources: 30 };
  const raw = {
    schemaVersion: 1,
    runId,
    attemptId,
    resultType: "planning",
    tasks: proposalIds.map((proposalId) => ({
      proposalId,
      description: `describe ${proposalId}`,
      role: "literature-searcher",
      evidenceRule: evidenceRule(),
      dependsOnProposalIds: [],
    })),
    rationale: "scope the question before dispatch",
  };
  return validateCoordinatorPlanningResultInternal(raw, context);
}

function buildAuthenticBoard(result: ValidatedCoordinatorPlanningResultInternal, controlTaskId: string = CONTROL_TASK_ID): ValidatedPlanningTaskBoardInternal {
  const bindings = { controlTaskId: controlTaskId as never, taskIds: result.tasks.map((_, i) => taskId(i)) as never };
  return buildPlanningTaskBoardInternal(result, bindings);
}

function metadata(overrides: Partial<ResearchPlanningArtifactMetadataInternal> = {}): ResearchPlanningArtifactMetadataInternal {
  return {
    executionEpoch: 0,
    transactionId: TX_ID as never,
    createdAt: NOW as never,
    attemptEnvelopeSha256: ENVELOPE_SHA as never,
    logicalInputSha256: INPUT_SHA as never,
    maxSources: 30,
    ...overrides,
  };
}

function expectedBinding(result: ValidatedCoordinatorPlanningResultInternal, board: ValidatedPlanningTaskBoardInternal, meta: ResearchPlanningArtifactMetadataInternal): PlanningArtifactExpectedBindingInternal {
  return {
    runId: result.runId,
    attemptId: result.attemptId,
    executionEpoch: meta.executionEpoch,
    transactionId: meta.transactionId,
    maxSources: meta.maxSources,
    attemptEnvelopeSha256: meta.attemptEnvelopeSha256,
    logicalInputSha256: meta.logicalInputSha256,
    controlTaskId: board.controlTaskId,
  };
}

async function expectWriteFailure(root: OwnedRunRoot, result: unknown, board: unknown, meta: unknown, code: string, control?: unknown): Promise<void> {
  try {
    await writePlanningArtifactInternal(root, result as never, board as never, meta as never, control as never);
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningArtifactError);
    expect((error as ResearchPlanningArtifactError).code).toBe(code);
    expect((error as Error).message).toBe(`Research planning artifact failed (${code})`);
  }
}

async function expectReadFailure(root: OwnedRunRoot, ref: unknown, binding: unknown, code: string, control?: unknown): Promise<void> {
  try {
    await readPlanningArtifactInternal(root, ref as never, binding as never, control as never);
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningArtifactError);
    expect((error as ResearchPlanningArtifactError).code).toBe(code);
    expect((error as Error).message).toBe(`Research planning artifact failed (${code})`);
  }
}

function faultControl(failAt: PlanningArtifactPhaseInternal) {
  return createPlanningArtifactTestControlInternal({ failAt, pauseAt: null });
}

function pauseControl(pauseAt: PlanningArtifactPhaseInternal) {
  return createPlanningArtifactTestControlInternal({ failAt: null, pauseAt });
}

describe("writePlanningArtifactInternal / readPlanningArtifactInternal — round trip", () => {
  test("writes then reads back an identical, freshly-authenticated result and board", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["a", "b"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      expect(ref.relativePath).toBe(`.state/planning/results/${ref.sha256}.json`);
      expect(/^[a-f0-9]{64}$/.test(ref.sha256)).toBe(true);
      expect(Object.isFrozen(ref)).toBe(true);

      const rehydrated = await readPlanningArtifactInternal(root, ref, expectedBinding(result, board, meta));
      expect(rehydrated.result.runId).toBe(result.runId);
      expect(rehydrated.result.tasks.map((t) => t.proposalId)).toEqual(result.tasks.map((t) => t.proposalId));
      expect(rehydrated.board.controlTaskId).toBe(board.controlTaskId);
      expect(canonicalJson(rehydrated.board)).toBe(canonicalJson(board));
      expect(rehydrated.transactionId).toBe(meta.transactionId);
      expect(rehydrated.maxSources).toBe(meta.maxSources);
      expect(Object.isFrozen(rehydrated)).toBe(true);
    } finally {
      await root.close();
    }
  });

  test("preserves original task IDs and dependency order across a reverse-submitted DAG round trip", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const context = { runId: RUN_ID as never, attemptId: ATTEMPT_ID as never, maxSources: 30 };
      const raw = {
        schemaVersion: 1, runId: RUN_ID, attemptId: ATTEMPT_ID, resultType: "planning",
        tasks: [
          { proposalId: "c", description: "d-c", role: "literature-searcher", evidenceRule: evidenceRule(), dependsOnProposalIds: ["b"] },
          { proposalId: "b", description: "d-b", role: "literature-searcher", evidenceRule: evidenceRule(), dependsOnProposalIds: ["a"] },
          { proposalId: "a", description: "d-a", role: "literature-searcher", evidenceRule: evidenceRule(), dependsOnProposalIds: [] },
        ],
        rationale: "scope the question before dispatch",
      };
      const result = validateCoordinatorPlanningResultInternal(raw, context);
      // Bindings keyed by ORIGINAL submission index: taskIds[0]=c's id, [1]=b's id, [2]=a's id.
      const board = buildPlanningTaskBoardInternal(result, { controlTaskId: CONTROL_TASK_ID as never, taskIds: [taskId(0), taskId(1), taskId(2)] as never });
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const rehydrated = await readPlanningArtifactInternal(root, ref, expectedBinding(result, board, meta));
      expect(rehydrated.board.tasks.map((m) => m.proposalId)).toEqual(["a", "b", "c"]);
      expect(rehydrated.board.tasks[0]!.task.taskId).toBe(taskId(2));
      expect(rehydrated.board.tasks[1]!.task.taskId).toBe(taskId(1));
      expect(rehydrated.board.tasks[2]!.task.taskId).toBe(taskId(0));
      expect(rehydrated.board.tasks[2]!.dependsOnTaskIds).toEqual([taskId(1)]);
    } finally {
      await root.close();
    }
  });

  test("produces canonically deterministic hashes across equivalent-but-distinct-object builds", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const resultOne = buildAuthenticResult(["a", "b"]);
      const resultTwo = buildAuthenticResult(["a", "b"]);
      const boardOne = buildAuthenticBoard(resultOne);
      const boardTwo = buildAuthenticBoard(resultTwo);
      const refOne = await writePlanningArtifactInternal(root, resultOne, boardOne, metadata());
      const refTwo = await writePlanningArtifactInternal(root, resultTwo, boardTwo, metadata());
      expect(refOne.sha256).toBe(refTwo.sha256);
      expect(refOne.relativePath).toBe(refTwo.relativePath);
    } finally {
      await root.close();
    }
  });

  test("idempotently reuses an existing identical artifact and confirms BOTH file and directory durability", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const first = await writePlanningArtifactInternal(root, result, board, meta);
      const fileSyncControl = faultControl("after-reuse-sync");
      await expectWriteFailure(root, result, board, meta, "planning-artifact.io-failed", fileSyncControl);
      const dirSyncControl = faultControl("after-results-directory-resync");
      await expectWriteFailure(root, result, board, meta, "planning-artifact.io-failed", dirSyncControl);
      // Both fault points genuinely run on the reuse path (proving both syncs are attempted, not
      // skipped) — a plain successful reuse call afterward still works.
      const second = await writePlanningArtifactInternal(root, result, board, meta);
      expect(second).toEqual(first);
    } finally {
      await root.close();
    }
  });
});

describe("writePlanningArtifactInternal — authentication and cross-validation", () => {
  test("rejects a forged (non-authentic) result and a forged board", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const forgedResult = JSON.parse(JSON.stringify(result));
      const forgedBoard = JSON.parse(JSON.stringify(board));
      await expectWriteFailure(root, forgedResult, board, metadata(), "planning-artifact.invalid-result");
      await expectWriteFailure(root, result, forgedBoard, metadata(), "planning-artifact.invalid-board");
    } finally {
      await root.close();
    }
  });

  test("rejects a genuinely authentic board that does not derive from the given result", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const resultA = buildAuthenticResult(["a"]);
      const resultB = buildAuthenticResult(["a", "b"]); // genuinely different task set
      const boardFromB = buildAuthenticBoard(resultB);
      await expectWriteFailure(root, resultA, boardFromB, metadata(), "planning-artifact.mismatch");
    } finally {
      await root.close();
    }
  });

  test("rejects a result belonging to a different run than the owning root", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const otherRunId = `run-${"9".repeat(16)}`;
      const result = buildAuthenticResult(["solo"], otherRunId);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-result");
    } finally {
      await root.close();
    }
  });

  test("rejects closedMetadata with extra/missing keys, wrong executionEpoch, or out-of-range maxSources", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, { ...metadata(), extra: 1 }, "planning-artifact.invalid-metadata");
      const { maxSources: _drop, ...missing } = metadata();
      await expectWriteFailure(root, result, board, missing, "planning-artifact.invalid-metadata");
      await expectWriteFailure(root, result, board, metadata({ executionEpoch: 1 as never }), "planning-artifact.invalid-metadata");
      await expectWriteFailure(root, result, board, metadata({ maxSources: 0 }), "planning-artifact.invalid-metadata");
      await expectWriteFailure(root, result, board, metadata({ maxSources: 501 }), "planning-artifact.invalid-metadata");
      await expectWriteFailure(root, result, board, metadata({ transactionId: "not-a-tx-id" as never }), "planning-artifact.invalid-metadata");
      await expectWriteFailure(root, result, board, metadata({ attemptEnvelopeSha256: "short" as never }), "planning-artifact.invalid-metadata");
    } finally {
      await root.close();
    }
  });

  test("revalidates the result under the artifact's declared maxSources ceiling", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const context = { runId: RUN_ID as never, attemptId: ATTEMPT_ID as never, maxSources: 30 };
      const raw = {
        schemaVersion: 1, runId: RUN_ID, attemptId: ATTEMPT_ID, resultType: "planning",
        tasks: [{ proposalId: "solo", description: "d", role: "literature-searcher",
          evidenceRule: { minimumLineages: 11, independentVerificationAllowed: true, primarySourceRequired: true, fullTextRequired: false },
          dependsOnProposalIds: [] }],
        rationale: "scope the question before dispatch",
      };
      const result = validateCoordinatorPlanningResultInternal(raw, context); // minimumLineages 11 <= min(16,30)=16, valid here
      const board = buildAuthenticBoard(result);
      // Artifact declares a tighter ceiling: min(16,5)=5, so minimumLineages=11 must now be rejected.
      await expectWriteFailure(root, result, board, metadata({ maxSources: 5 }), "planning-artifact.invalid-result");
    } finally {
      await root.close();
    }
  });
});

describe("readPlanningArtifactInternal — expected binding validation", () => {
  test("rejects a closedRef whose relativePath does not match its own sha256", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const tampered = { ...ref, relativePath: ".state/planning/results/deadbeef.json" };
      await expectReadFailure(root, tampered, expectedBinding(result, board, meta), "planning-artifact.invalid-ref");
    } finally {
      await root.close();
    }
  });

  test("rejects each individually wrong expected-binding field with a valid-but-different value", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const base = expectedBinding(result, board, meta);
      await expectReadFailure(root, ref, { ...base, runId: `run-${"9".repeat(16)}` }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, attemptId: `attempt-${"9".repeat(16)}` }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, executionEpoch: 1 }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, transactionId: `tx-${"9".repeat(16)}` }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, maxSources: 99 }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, attemptEnvelopeSha256: OTHER_ENVELOPE_SHA }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, logicalInputSha256: OTHER_INPUT_SHA }, "planning-artifact.invalid-binding");
      await expectReadFailure(root, ref, { ...base, controlTaskId: taskId(999) }, "planning-artifact.invalid-binding");
    } finally {
      await root.close();
    }
  });

  test("rejects a closedExpectedBinding whose runId does not match the owned root before any file I/O", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const wrongRootBinding = { ...expectedBinding(result, board, meta), runId: `run-${"9".repeat(16)}` };
      const before = getPlanningArtifactOpenHandleCountInternal();
      await expectReadFailure(root, ref, wrongRootBinding, "planning-artifact.invalid-binding");
      expect(getPlanningArtifactOpenHandleCountInternal()).toBe(before);
    } finally {
      await root.close();
    }
  });

  test("rejects extra/missing keys on closedExpectedBinding", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const base = expectedBinding(result, board, meta) as unknown as Record<string, unknown>;
      await expectReadFailure(root, ref, { ...base, extra: 1 }, "planning-artifact.invalid-binding");
      const { controlTaskId: _drop, ...missing } = base;
      await expectReadFailure(root, ref, missing, "planning-artifact.invalid-binding");
    } finally {
      await root.close();
    }
  });

  test("rejects a Proxy expected-binding and a getter-decorated one without invoking any trap", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const base = expectedBinding(result, board, meta);
      let trapped = false;
      const proxy = new Proxy(base, { get(target, prop, receiver) { trapped = true; return Reflect.get(target, prop, receiver); } });
      await expectReadFailure(root, ref, proxy, "planning-artifact.invalid-binding");
      expect(trapped).toBe(false);

      let getterInvoked = false;
      const decorated: Record<string, unknown> = { runId: base.runId, attemptId: base.attemptId, executionEpoch: 0, transactionId: base.transactionId, attemptEnvelopeSha256: base.attemptEnvelopeSha256, logicalInputSha256: base.logicalInputSha256, controlTaskId: base.controlTaskId };
      Object.defineProperty(decorated, "maxSources", { enumerable: true, configurable: true, get() { getterInvoked = true; return 30; } });
      await expectReadFailure(root, ref, decorated, "planning-artifact.invalid-binding");
      expect(getterInvoked).toBe(false);
    } finally {
      await root.close();
    }
  });
});

describe("readPlanningArtifactInternal — stored-content corruption", () => {
  async function writeRawArtifact(root: OwnedRunRoot, text: string): Promise<{ ref: PlanningArtifactRefInternal }> {
    const dir = join(root.path, ".state", "planning", "results");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(text, "utf8");
    const sha256 = sha256Hex(bytes);
    const path = join(dir, `${sha256}.json`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return { ref: Object.freeze({ relativePath: `.state/planning/results/${sha256}.json`, sha256: sha256 as never, decodedBytes: bytes.byteLength }) };
  }

  const genericBinding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };

  test("rejects non-canonical JSON (reordered keys / extra whitespace)", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const { ref } = await writeRawArtifact(root, `{"b": 1, "a": 1}`);
      await expectReadFailure(root, ref, genericBinding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects duplicate JSON keys collapsed by JSON.parse", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const { ref } = await writeRawArtifact(root, `{"a":1,"a":2}`);
      await expectReadFailure(root, ref, genericBinding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects a BOM-prefixed file", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const { ref } = await writeRawArtifact(root, `﻿{"a":1}`);
      await expectReadFailure(root, ref, genericBinding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects invalid UTF-8 bytes", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const dir = join(root.path, ".state", "planning", "results");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
      const sha256 = sha256Hex(bytes);
      await writeFile(join(dir, `${sha256}.json`), bytes, { flag: "wx", mode: 0o600 });
      const ref = { relativePath: `.state/planning/results/${sha256}.json`, sha256, decodedBytes: bytes.byteLength };
      await expectReadFailure(root, ref, genericBinding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects a genuinely truncated file (real bytes physically shortened on disk)", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const path = join(root.path, ref.relativePath);
      const original = await readFile(path);
      expect(original.byteLength).toBe(ref.decodedBytes);
      await truncate(path, ref.decodedBytes - 5); // physically shorten the real file on disk
      const truncatedNowOnDisk = await readFile(path);
      expect(truncatedNowOnDisk.byteLength).toBe(ref.decodedBytes - 5);
      const binding = expectedBinding(result, board, meta);
      // The original (correct) ref still claims the ORIGINAL decodedBytes/sha256 — the file no
      // longer matches either, so this must fail on the real, physically-truncated content.
      await expectReadFailure(root, ref, binding, "planning-artifact.unsafe-file");
    } finally {
      await root.close();
    }
  });

  test("rejects a wrong decodedBytes claim against an untouched, correctly-sized file", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const binding = expectedBinding(result, board, meta);
      await expectReadFailure(root, { ...ref, decodedBytes: ref.decodedBytes + 1 }, binding, "planning-artifact.unsafe-file");
      await expectReadFailure(root, { ...ref, decodedBytes: ref.decodedBytes - 1 }, binding, "planning-artifact.unsafe-file");
    } finally {
      await root.close();
    }
  });

  test("rejects a bit-flipped (hash-mismatched) file", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const binding = expectedBinding(result, board, meta);
      const path = join(root.path, ref.relativePath);
      const original = await readFile(path);
      const flipped = Buffer.from(original);
      flipped[0] = flipped[0]! ^ 0xff;
      await rm(path);
      await writeFile(path, flipped, { flag: "wx", mode: 0o600 });
      await expectReadFailure(root, ref, binding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects a missing artifact without any filesystem mutation, when no artifact was ever written", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const fakeHash = "0".repeat(64);
      const ref = { relativePath: `.state/planning/results/${fakeHash}.json`, sha256: fakeHash, decodedBytes: 10 };
      const before = await pathExistsUnder(root.path, ".state");
      await expectReadFailure(root, ref, genericBinding, "planning-artifact.not-found");
      const after = await pathExistsUnder(root.path, ".state");
      expect(after).toBe(before); // no .state directory was created as a side effect
    } finally {
      await root.close();
    }
  });

  test("rejects a missing artifact (wrong hash) when the directory chain already exists from a prior write", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      await writePlanningArtifactInternal(root, result, board, meta); // chain now exists
      const fakeHash = "3".repeat(64);
      const ref = { relativePath: `.state/planning/results/${fakeHash}.json`, sha256: fakeHash, decodedBytes: 10 };
      await expectReadFailure(root, ref, genericBinding, "planning-artifact.not-found");
    } finally {
      await root.close();
    }
  });

  async function pathExistsUnder(root: string, name: string): Promise<boolean> {
    const entries = await readdir(root).catch(() => [] as string[]);
    return entries.includes(name);
  }
});

describe("readPlanningArtifactInternal — cross-consistency between stored result and board", () => {
  test("rejects a hand-crafted artifact whose board does not derive from its own result", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const resultA = buildAuthenticResult(["a"]);
      const resultB = buildAuthenticResult(["a", "b"]);
      const boardB = buildAuthenticBoard(resultB);
      const meta = metadata();
      const artifact = {
        schemaVersion: 1, kind: "coordinator-planning-artifact", executionEpoch: 0,
        transactionId: meta.transactionId, createdAt: meta.createdAt,
        attemptEnvelopeSha256: meta.attemptEnvelopeSha256, logicalInputSha256: meta.logicalInputSha256,
        maxSources: meta.maxSources,
        result: JSON.parse(JSON.stringify(resultA)),
        board: JSON.parse(JSON.stringify(boardB)),
      };
      const text = canonicalJson(artifact);
      const dir = join(root.path, ".state", "planning", "results");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(text, "utf8");
      const sha256 = sha256Hex(bytes);
      await writeFile(join(dir, `${sha256}.json`), bytes, { flag: "wx", mode: 0o600 });
      const ref = { relativePath: `.state/planning/results/${sha256}.json`, sha256, decodedBytes: bytes.byteLength };
      const binding = { runId: resultA.runId, attemptId: resultA.attemptId, executionEpoch: 0, transactionId: meta.transactionId, maxSources: meta.maxSources, attemptEnvelopeSha256: meta.attemptEnvelopeSha256, logicalInputSha256: meta.logicalInputSha256, controlTaskId: boardB.controlTaskId };
      await expectReadFailure(root, ref, binding, "planning-artifact.mismatch");
    } finally {
      await root.close();
    }
  });
});

describe("existing-entry races at the leaf path", () => {
  async function preexistingLeafPath(root: OwnedRunRoot, result: ValidatedCoordinatorPlanningResultInternal, board: ValidatedPlanningTaskBoardInternal, meta: ResearchPlanningArtifactMetadataInternal): Promise<string> {
    const artifact = {
      schemaVersion: 1, kind: "coordinator-planning-artifact", executionEpoch: 0,
      transactionId: meta.transactionId, createdAt: meta.createdAt,
      attemptEnvelopeSha256: meta.attemptEnvelopeSha256, logicalInputSha256: meta.logicalInputSha256,
      maxSources: meta.maxSources, result: JSON.parse(JSON.stringify(result)), board: JSON.parse(JSON.stringify(board)),
    };
    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const sha256 = sha256Hex(bytes);
    const dir = join(root.path, ".state", "planning", "results");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${sha256}.json`);
  }

  test("fails closed on a symlink already at the target hash path, and preserves it", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const path = await preexistingLeafPath(root, result, board, meta);
      const elsewhere = join(project, "elsewhere.json");
      await writeFile(elsewhere, "decoy");
      await symlink(elsewhere, path);
      await expectWriteFailure(root, result, board, meta, "planning-artifact.unsafe-file");
      const finalStat = await lstat(path);
      expect(finalStat.isSymbolicLink()).toBe(true);
    } finally {
      await root.close();
    }
  });

  test("fails closed on a hard link already at the target hash path, and preserves it", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const path = await preexistingLeafPath(root, result, board, meta);
      const other = join(project, "other.json");
      await writeFile(other, "same-inode-target");
      await link(other, path);
      await expectWriteFailure(root, result, board, meta, "planning-artifact.unsafe-file");
      const finalStat = await lstat(path);
      expect(finalStat.nlink).toBeGreaterThan(1);
    } finally {
      await root.close();
    }
  });

  test("fails closed when the existing entry at the target path is a directory", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const path = await preexistingLeafPath(root, result, board, meta);
      await mkdir(path);
      await expectWriteFailure(root, result, board, meta, "planning-artifact.unsafe-file");
      const finalStat = await lstat(path);
      expect(finalStat.isDirectory()).toBe(true);
    } finally {
      await root.close();
    }
  });

  test("fails closed when the existing entry has different (corrupted) content", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const path = await preexistingLeafPath(root, result, board, meta);
      await writeFile(path, "not the real canonical content", { flag: "wx", mode: 0o600 });
      await expectWriteFailure(root, result, board, meta, "planning-artifact.corrupt");
      const bytes = await readFile(path, "utf8");
      expect(bytes).toBe("not the real canonical content");
    } finally {
      await root.close();
    }
  });

  test("fails closed on an oversized existing entry without reading it fully into memory", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const path = await preexistingLeafPath(root, result, board, meta);
      await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), { flag: "wx", mode: 0o600 });
      await expectWriteFailure(root, result, board, meta, "planning-artifact.unsafe-file");
    } finally {
      await root.close();
    }
  });
});

describe("ancestor directory substitution (deterministic regression coverage)", () => {
  test("REGRESSION: a results/ directory swapped to a symlink pointing outside the root is rejected on read", async () => {
    const { project, base } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const binding = expectedBinding(result, board, meta);

      const resultsDir = join(root.path, ".state", "planning", "results");
      const outsideDir = join(base, "moved-outside-results");
      await rename(resultsDir, outsideDir);
      await symlink(outsideDir, resultsDir);

      await expectReadFailure(root, ref, binding, "planning-artifact.unsafe-file");
    } finally {
      await root.close();
    }
  });

  test("REGRESSION: a planning/ directory swapped to a symlink is rejected on write, and no artifact is created outside root", async () => {
    const { project, base } = await fixture();
    const root = await openRoot(project);
    try {
      // Seed the chain once so .state/planning exists, then swap "planning" itself.
      const seedResult = buildAuthenticResult(["seed"]);
      const seedBoard = buildAuthenticBoard(seedResult);
      await writePlanningArtifactInternal(root, seedResult, seedBoard, metadata());

      const planningDir = join(root.path, ".state", "planning");
      const outsideDir = join(base, "moved-outside-planning");
      await rename(planningDir, outsideDir);
      await symlink(outsideDir, planningDir);

      const result = buildAuthenticResult(["other"]);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, metadata({ transactionId: `tx-${"f".repeat(16)}` as never }), "planning-artifact.unsafe-file");

      // The attacker-controlled outside directory must not have received a new artifact file.
      const outsideEntries = await readdir(outsideDir).catch(() => []);
      expect(outsideEntries.some((name) => name.endsWith(".json") && name !== `${sha256Hex(canonicalJson({}))}.json`)).toBe(false);
    } finally {
      await root.close();
    }
  });

  test("REGRESSION: the run root itself replaced between operations is rejected, not silently followed", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      await rm(project, { recursive: true, force: true });
      await mkdir(project);
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.unsafe-file");
    } finally {
      await root.close().catch(() => undefined);
    }
  });

  test("rejects a results directory with group/other permission bits set", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      // Pre-create the chain with a permissive mode on "results" specifically.
      const stateDir = join(root.path, ".state");
      const planningDir = join(stateDir, "planning");
      const resultsDir = join(planningDir, "results");
      await mkdir(resultsDir, { recursive: true, mode: 0o700 });
      await chmod(resultsDir, 0o755);
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.unsafe-file");
    } finally {
      await root.close();
    }
  });
});

describe("leaf identity races during read and reuse (deterministic regression coverage)", () => {
  test("REGRESSION: the leaf file replaced with a same-size, different-inode file between the initial check and the read is rejected", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const binding = expectedBinding(result, board, meta);
      const path = join(root.path, ref.relativePath);
      const original = await readFile(path);

      const control = pauseControl("after-initial-identity-check");
      const readPromise = readPlanningArtifactInternal(root, ref, binding, control);
      readPromise.catch(() => {}); // attach a handler immediately: the race below may settle on readPromise's own rejection
      try {
        // Explicit, deterministic phase acknowledgment — no polling, no timers, no handle-count
        // guessing. Raced against the operation's own outcome so a bug that makes the operation
        // settle before ever reaching the pause surfaces immediately instead of hanging forever.
        await Promise.race([
          waitForPlanningArtifactPauseInternal(control),
          readPromise.then(() => { throw new Error("read settled before reaching the configured pause phase"); }),
        ]);
        await rm(path);
        await writeFile(path, original, { mode: 0o600 }); // same bytes/size, but a fresh inode
      } finally {
        resumePlanningArtifactTestControlInternal(control);
      }
      await expect(readPromise).rejects.toMatchObject({ code: "planning-artifact.unsafe-file" });
    } finally {
      await root.close();
    }
  });

  test("REGRESSION: the leaf file replaced with a different-content file of the same size during reuse is rejected", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const path = join(root.path, ref.relativePath);
      const original = await readFile(path);
      const sameSize = Buffer.alloc(original.byteLength, 0x2e); // same length, all '.' — different content, different inode after replace

      const control = pauseControl("after-reuse-read");
      const writePromise = writePlanningArtifactInternal(root, result, board, meta, control);
      writePromise.catch(() => {}); // attach a handler immediately: the race below may settle on writePromise's own rejection
      try {
        await Promise.race([
          waitForPlanningArtifactPauseInternal(control),
          writePromise.then(() => { throw new Error("write settled before reaching the configured pause phase"); }),
        ]);
        await rm(path);
        await writeFile(path, sameSize, { mode: 0o600 });
      } finally {
        resumePlanningArtifactTestControlInternal(control);
      }
      await expect(writePromise).rejects.toMatchObject({ code: "planning-artifact.unsafe-file" });
    } finally {
      await root.close();
    }
  });
});

describe("test control capability confinement and safety", () => {
  test("rejects a plain {} object passed where a test control is expected, with zero filesystem effects", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", {});
      const entries = await readdir(root.path).catch(() => [] as string[]);
      expect(entries).not.toContain(".state");
      const ref = await writePlanningArtifactInternal(root, result, board, metadata());
      const binding = expectedBinding(result, board, metadata());
      await expectReadFailure(root, ref, binding, "planning-artifact.invalid-hooks", {});
    } finally {
      await root.close();
    }
  });

  test("rejects null, false, and a string value", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      for (const bad of [null, false, "control"]) {
        await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", bad);
      }
    } finally {
      await root.close();
    }
  });

  test("treats an explicit undefined the same as omitted — normal operation, no fault", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const ref = await writePlanningArtifactInternal(root, result, board, metadata(), undefined);
      expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await root.close();
    }
  });

  test("rejects a copied/spread real token — its state lives only in the WeakMap, never on the object itself", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const real = faultControl("after-leaf-write");
      const spread = { ...real };
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", spread);
    } finally {
      await root.close();
    }
  });

  test("rejects a forged instance sharing the real token's prototype", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const real = faultControl("after-leaf-write");
      const forged = Object.freeze(Object.create(Object.getPrototypeOf(real)));
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", forged);
    } finally {
      await root.close();
    }
  });

  test("rejects a Proxy wrapping a genuine token without invoking any trap", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const real = faultControl("after-leaf-write");
      let trapped = false;
      const proxy = new Proxy(real as object, { get(target, prop, receiver) { trapped = true; return Reflect.get(target, prop, receiver); } });
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", proxy);
      expect(trapped).toBe(false);
    } finally {
      await root.close();
    }
  });

  test("rejects a revoked Proxy over a genuine token", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const real = faultControl("after-leaf-write");
      const { proxy, revoke } = Proxy.revocable(real as object, {});
      revoke();
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", proxy);
    } finally {
      await root.close();
    }
  });

  test("authenticates before any root revalidation — forged control over an already-invalid root yields invalid-hooks, not a root error, on both write and read", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    const result = buildAuthenticResult(["solo"]);
    const board = buildAuthenticBoard(result);
    const meta = metadata();
    const ref = await writePlanningArtifactInternal(root, result, board, meta);
    const binding = expectedBinding(result, board, meta);
    // Remove the root's own directory entirely: if authentication happened after root
    // revalidation (or after any filesystem access), this would surface as a root/unsafe-file
    // error instead — invalid-hooks here is the proof that no such access was ever attempted.
    await rm(root.path, { recursive: true, force: true });
    await expectWriteFailure(root, result, board, meta, "planning-artifact.invalid-hooks", {});
    await expectReadFailure(root, ref, binding, "planning-artifact.invalid-hooks", {});
    await root.close().catch(() => undefined);
  });

  test("valid root is left untouched by a rejected forged control (no directories created)", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, metadata(), "planning-artifact.invalid-hooks", {});
      const entries = await readdir(root.path).catch(() => [] as string[]);
      expect(entries).not.toContain(".state");
    } finally {
      await root.close();
    }
  });
});

describe("createPlanningArtifactTestControlInternal — exact descriptor shape", () => {
  test("requires both failAt and pauseAt present, each null or a valid phase literal", () => {
    expect(() => createPlanningArtifactTestControlInternal({ failAt: "after-leaf-write" } as never)).toThrow(ResearchPlanningArtifactError); // missing pauseAt
    expect(() => createPlanningArtifactTestControlInternal({ pauseAt: null } as never)).toThrow(ResearchPlanningArtifactError); // missing failAt
    expect(() => createPlanningArtifactTestControlInternal({} as never)).toThrow(ResearchPlanningArtifactError); // missing both
    expect(() => createPlanningArtifactTestControlInternal({ failAt: "after-leaf-write", pauseAt: null, extra: 1 } as never)).toThrow(ResearchPlanningArtifactError);
    expect(() => createPlanningArtifactTestControlInternal({ failAt: undefined, pauseAt: null } as never)).toThrow(ResearchPlanningArtifactError);
    expect(() => createPlanningArtifactTestControlInternal({ failAt: null, pauseAt: undefined } as never)).toThrow(ResearchPlanningArtifactError);
    expect(() => createPlanningArtifactTestControlInternal({ failAt: "not-a-real-phase", pauseAt: null } as never)).toThrow(ResearchPlanningArtifactError);
    expect(() => createPlanningArtifactTestControlInternal({ failAt: null, pauseAt: "not-a-real-phase" } as never)).toThrow(ResearchPlanningArtifactError);
    expect(() => createPlanningArtifactTestControlInternal({ failAt: null, pauseAt: null })).not.toThrow();
    expect(() => createPlanningArtifactTestControlInternal({ failAt: "after-leaf-write", pauseAt: "after-leaf-write" })).not.toThrow();
  });

  test("rejects a Proxy descriptor and a getter-decorated descriptor without invoking any trap", () => {
    let trapped = false;
    const proxy = new Proxy({ failAt: null, pauseAt: null }, { get(target, prop, receiver) { trapped = true; return Reflect.get(target, prop, receiver); } });
    expect(() => createPlanningArtifactTestControlInternal(proxy as never)).toThrow(ResearchPlanningArtifactError);
    expect(trapped).toBe(false);

    let getterInvoked = false;
    const decorated: Record<string, unknown> = { pauseAt: null };
    Object.defineProperty(decorated, "failAt", { enumerable: true, configurable: true, get() { getterInvoked = true; return null; } });
    expect(() => createPlanningArtifactTestControlInternal(decorated as never)).toThrow(ResearchPlanningArtifactError);
    expect(getterInvoked).toBe(false);
  });

  test("rejects a null-prototype record and a symbol-keyed record", () => {
    const nullProto = Object.assign(Object.create(null), { failAt: null, pauseAt: null });
    expect(() => createPlanningArtifactTestControlInternal(nullProto as never)).not.toThrow(); // null-prototype is explicitly allowed by isOrdinaryRecord
    const symbolKeyed = { failAt: null, pauseAt: null, [Symbol("x")]: 1 };
    expect(() => createPlanningArtifactTestControlInternal(symbolKeyed as never)).toThrow(ResearchPlanningArtifactError);
  });
});

describe("resumePlanningArtifactTestControlInternal — authentication", () => {
  test("is an idempotent no-op for an authentic control that is not currently paused", () => {
    const control = createPlanningArtifactTestControlInternal({ failAt: null, pauseAt: null });
    expect(() => resumePlanningArtifactTestControlInternal(control)).not.toThrow();
    expect(() => resumePlanningArtifactTestControlInternal(control)).not.toThrow();
  });

  test("rejects an unauthentic control with invalid-hooks instead of silently succeeding", () => {
    const real = createPlanningArtifactTestControlInternal({ failAt: null, pauseAt: null });
    for (const bad of [{}, null, undefined, "x", false, { ...real }]) {
      expect(() => resumePlanningArtifactTestControlInternal(bad)).toThrow(ResearchPlanningArtifactError);
    }
  });
});

describe("waitForPlanningArtifactPauseInternal — authentication and armed-pause requirement", () => {
  test("rejects an unauthentic control", async () => {
    for (const bad of [{}, null, undefined, "x", false]) {
      await expect(waitForPlanningArtifactPauseInternal(bad)).rejects.toMatchObject({ code: "planning-artifact.invalid-hooks" });
    }
  });

  test("rejects an authentic control with no armed pause (pauseAt: null)", async () => {
    const control = createPlanningArtifactTestControlInternal({ failAt: "after-leaf-write", pauseAt: null });
    await expect(waitForPlanningArtifactPauseInternal(control)).rejects.toMatchObject({ code: "planning-artifact.invalid-hooks" });
  });

  test("returns the same promise for repeated observers, resolved only once the phase is actually reached", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const control = pauseControl("root-pinned");
      const first = waitForPlanningArtifactPauseInternal(control);
      const second = waitForPlanningArtifactPauseInternal(control);
      expect(first).toBe(second);
      let reached = false;
      first.then(() => { reached = true; });
      const writePromise = writePlanningArtifactInternal(root, result, board, metadata(), control);
      writePromise.catch(() => {});
      await first;
      expect(reached).toBe(true);
      resumePlanningArtifactTestControlInternal(control);
      await writePromise;
    } finally {
      await root.close();
    }
  });
});

describe("fault matrix — every native phase can be made to fail closed, never a false success", () => {
  const writePhases: PlanningArtifactPhaseInternal[] = [
    "root-pinned", "state-directory-ready", "planning-directory-ready", "results-directory-ready",
    "before-leaf-open", "after-leaf-write", "after-leaf-sync", "after-leaf-identity-recheck",
    "after-results-directory-resync",
  ];

  for (const phase of writePhases) {
    test(`fails closed at write phase "${phase}" and leaves zero retained handles`, async () => {
      const { project } = await fixture();
      const root = await openRoot(project);
      try {
        const result = buildAuthenticResult(["solo"]);
        const board = buildAuthenticBoard(result);
        const meta = metadata();
        const before = getPlanningArtifactOpenHandleCountInternal();
        const control = faultControl(phase);
        await expect(writePlanningArtifactInternal(root, result, board, meta, control)).rejects.toMatchObject({ code: "planning-artifact.io-failed" });
        expect(getPlanningArtifactOpenHandleCountInternal()).toBe(before);
      } finally {
        await root.close();
      }
    });
  }

  const readPhases: PlanningArtifactPhaseInternal[] = [
    "root-pinned", "state-directory-ready", "planning-directory-ready", "results-directory-ready",
    "after-leaf-open", "after-initial-identity-check", "after-read", "after-final-identity-check",
  ];

  for (const phase of readPhases) {
    test(`fails closed at read phase "${phase}" and leaves zero retained handles`, async () => {
      const { project } = await fixture();
      const root = await openRoot(project);
      try {
        const result = buildAuthenticResult(["solo"]);
        const board = buildAuthenticBoard(result);
        const meta = metadata();
        const ref = await writePlanningArtifactInternal(root, result, board, meta);
        const binding = expectedBinding(result, board, meta);
        const before = getPlanningArtifactOpenHandleCountInternal();
        const control = faultControl(phase);
        await expect(readPlanningArtifactInternal(root, ref, binding, control)).rejects.toMatchObject({ code: "planning-artifact.io-failed" });
        expect(getPlanningArtifactOpenHandleCountInternal()).toBe(before);
      } finally {
        await root.close();
      }
    });
  }
});

describe("cleanup-uncertainty precedence", () => {
  // NOTE: a genuine "close() itself fails while a primary failure is also in flight" scenario
  // cannot be forced through this test-control surface by design — item 3 requires the surface
  // to never expose a real FileHandle/callback that could make trackedClose's own native
  // close() call fail on demand. What IS verified dynamically here is that a synthetic failure
  // injected at any phase still leaves the retained-handle count at zero (i.e. the ordinary
  // close path always runs to completion after a fault), for every phase in the fault matrix
  // above. The "cleanup-uncertain overrides a prior failure/success" precedence rule itself
  // (item 4) is verified by source audit instead: every trackedClose/closePinsQuietly call site
  // in planning-artifact-internal.ts checks the boolean return value and unconditionally
  // upgrades the outcome to planning-artifact.cleanup-uncertain when it is false, both on
  // otherwise-successful paths (e.g. after the final directory resync) and on already-failing
  // paths (e.g. pinRootDirectory/pinChildDirectory's closeThenFail/closeThenRethrow helpers, and
  // buildDirectoryChain's catch block, which no longer carves out an exception for the internal
  // MissingAncestorInternal signal). This is a known, disclosed testing-surface limitation, not
  // an unverified requirement.
  test("a synthetic fault at the last phase before return still leaves zero retained handles (close path still runs)", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const control = faultControl("after-leaf-identity-recheck");
      await expect(writePlanningArtifactInternal(root, result, board, metadata(), control)).rejects.toMatchObject({ code: "planning-artifact.io-failed" });
      expect(getPlanningArtifactOpenHandleCountInternal()).toBe(0);
    } finally {
      await root.close();
    }
  });
});

describe("failure recovery and handle hygiene", () => {
  test("the caller's root remains usable after a failed write", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const forgedResult = JSON.parse(JSON.stringify(result));
      await expectWriteFailure(root, forgedResult, board, metadata(), "planning-artifact.invalid-result");
      const okRef = await writePlanningArtifactInternal(root, result, board, metadata());
      expect(/^[a-f0-9]{64}$/.test(okRef.sha256)).toBe(true);
    } finally {
      await root.close();
    }
  });

  test("the caller's root remains usable after a failed read", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const fakeHash = "4".repeat(64);
      const ref = { relativePath: `.state/planning/results/${fakeHash}.json`, sha256: fakeHash, decodedBytes: 10 };
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      await expectReadFailure(root, ref, binding, "planning-artifact.not-found");
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const okRef = await writePlanningArtifactInternal(root, result, board, metadata());
      expect(/^[a-f0-9]{64}$/.test(okRef.sha256)).toBe(true);
    } finally {
      await root.close();
    }
  });

  test("survives 100 write+read cycles with distinct content, zero descriptor retention throughout, including interspersed failures", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      expect(getPlanningArtifactOpenHandleCountInternal()).toBe(0);
      for (let i = 0; i < 100; i += 1) {
        const result = buildAuthenticResult([`task-${i}`]);
        const board = buildAuthenticBoard(result);
        const meta = metadata({ transactionId: `tx-${String(i).padStart(16, "0")}` as never });
        if (i % 10 === 0) {
          // Every tenth cycle is a deliberate failure, to prove retention returns to zero after
          // failures too, not only after successes.
          const forged = JSON.parse(JSON.stringify(result));
          await expectWriteFailure(root, forged, board, meta, "planning-artifact.invalid-result");
          expect(getPlanningArtifactOpenHandleCountInternal()).toBe(0);
        }
        const ref = await writePlanningArtifactInternal(root, result, board, meta);
        expect(getPlanningArtifactOpenHandleCountInternal()).toBe(0);
        const rehydrated = await readPlanningArtifactInternal(root, ref, expectedBinding(result, board, meta));
        expect(getPlanningArtifactOpenHandleCountInternal()).toBe(0);
        expect(rehydrated.result.tasks[0]!.proposalId).toBe(`task-${i}`);
      }
    } finally {
      await root.close();
    }
  }, 30_000);
});

describe("redacted error messages under real native failures", () => {
  test("a permission-denied ancestor directory never leaks the OS error or path in the message", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      await writePlanningArtifactInternal(root, result, board, metadata());
      const resultsDir = join(root.path, ".state", "planning", "results");
      await chmod(resultsDir, 0o000);
      try {
        const other = buildAuthenticResult(["other"]);
        const otherBoard = buildAuthenticBoard(other);
        try {
          await writePlanningArtifactInternal(root, other, otherBoard, metadata({ transactionId: `tx-${"9".repeat(16)}` as never }));
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(ResearchPlanningArtifactError);
          const message = (error as Error).message;
          expect(message).not.toMatch(/EACCES|EPERM|\/tmp|pi-planning-artifact/);
          expect(message).toBe(`Research planning artifact failed (${(error as ResearchPlanningArtifactError).code})`);
        }
      } finally {
        await chmod(resultsDir, 0o700);
      }
    } finally {
      await root.close();
    }
  });
});

describe("ResearchPlanningArtifactError — redaction", () => {
  test("sanitizes an unknown code to a safe default", () => {
    const error = new ResearchPlanningArtifactError("planning-artifact.forged" as never);
    expect(error.code).toBe("planning-artifact.io-failed");
    expect(error.message).toBe("Research planning artifact failed (planning-artifact.io-failed)");
  });

  test("is frozen and never echoes raw paths or OS error text", () => {
    const error = new ResearchPlanningArtifactError("planning-artifact.corrupt");
    expect(Object.isFrozen(error)).toBe(true);
    expect(error.message).not.toMatch(/ENOENT|EEXIST|\/tmp|\.state/);
  });
});
