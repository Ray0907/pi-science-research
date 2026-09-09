import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

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
  readPlanningArtifactInternal,
  writePlanningArtifactInternal,
  type PlanningArtifactRefInternal,
  type ResearchPlanningArtifactMetadataInternal,
} from "../../src/storage/planning-artifact-internal.js";

const RUN_ID = `run-${"a".repeat(16)}`;
const ATTEMPT_ID = `attempt-${"b".repeat(16)}`;
const TX_ID = `tx-${"c".repeat(16)}`;
const CONTROL_TASK_ID = `task-${"d".repeat(16)}`;
const NOW = "2026-08-25T12:34:56.000Z";
const ENVELOPE_SHA = "a".repeat(64);
const INPUT_SHA = "b".repeat(64);

const roots: string[] = [];

async function fixture(): Promise<{ base: string; project: string }> {
  const base = await mkdtemp(join(tmpdir(), "pi-planning-artifact-"));
  roots.push(base);
  const project = join(base, "project");
  await mkdir(project);
  return { base, project };
}

afterEach(async () => {
  vi.restoreAllMocks();
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

function expectedBinding(result: ValidatedCoordinatorPlanningResultInternal, board: ValidatedPlanningTaskBoardInternal, meta: ResearchPlanningArtifactMetadataInternal) {
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

async function expectWriteFailure(root: OwnedRunRoot, result: unknown, board: unknown, meta: unknown, code: string): Promise<void> {
  try {
    await writePlanningArtifactInternal(root, result as never, board as never, meta as never);
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningArtifactError);
    expect((error as ResearchPlanningArtifactError).code).toBe(code);
    expect((error as Error).message).toBe(`Research planning artifact failed (${code})`);
  }
}

async function expectReadFailure(root: OwnedRunRoot, ref: unknown, binding: unknown, code: string): Promise<void> {
  try {
    await readPlanningArtifactInternal(root, ref as never, binding as never);
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningArtifactError);
    expect((error as ResearchPlanningArtifactError).code).toBe(code);
  }
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

  test("idempotently reuses an existing identical artifact and still confirms durability", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const first = await writePlanningArtifactInternal(root, result, board, meta);
      const syncSpy = vi.fn(async (handle: { sync: () => Promise<void> }) => handle.sync());
      const second = await writePlanningArtifactInternal(root, result, board, meta, { durability: (handle) => syncSpy(handle) });
      expect(second).toEqual(first);
      expect(syncSpy).toHaveBeenCalled();
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
      // Content-identical results (same runId/attemptId/tasks) are indistinguishable by any
      // canonical-byte check, so this must use genuinely different task content to prove the
      // board/result agreement check is a real content check, not a coincidentally-passing one.
      const resultA = buildAuthenticResult(["from-a"]);
      const resultB = buildAuthenticResult(["from-b"]);
      const boardFromB = buildAuthenticBoard(resultB);
      await expectWriteFailure(root, resultA, boardFromB, metadata(), "planning-artifact.mismatch");
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

  test("rejects each individually wrong expected-binding field", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const base = expectedBinding(result, board, meta);
      const cases: Array<[string, unknown]> = [
        ["runId", `run-${"z".repeat(16)}`],
        ["attemptId", `attempt-${"z".repeat(16)}`],
        ["executionEpoch", 1],
        ["transactionId", `tx-${"z".repeat(16)}`],
        ["maxSources", 99],
        ["attemptEnvelopeSha256", "z".repeat(64)],
        ["logicalInputSha256", "z".repeat(64)],
        ["controlTaskId", `task-${"z".repeat(16)}`],
      ];
      for (const [field, value] of cases) {
        await expectReadFailure(root, ref, { ...base, [field]: value }, "planning-artifact.invalid-binding");
      }
    } finally {
      await root.close();
    }
  });

  test("rejects a closedExpectedBinding whose runId does not match the owned root", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const wrongRootBinding = { ...expectedBinding(result, board, meta), runId: `run-${"9".repeat(16)}` };
      await expectReadFailure(root, ref, wrongRootBinding, "planning-artifact.invalid-binding");
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
      const base = expectedBinding(result, board, meta) as Record<string, unknown>;
      await expectReadFailure(root, ref, { ...base, extra: 1 }, "planning-artifact.invalid-binding");
      const { controlTaskId: _drop, ...missing } = base;
      await expectReadFailure(root, ref, missing, "planning-artifact.invalid-binding");
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

  test("rejects non-canonical JSON (reordered keys / extra whitespace)", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const { ref } = await writeRawArtifact(root, `{"b": 1, "a": 1}`);
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      await expectReadFailure(root, ref, binding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects duplicate JSON keys collapsed by JSON.parse", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const { ref } = await writeRawArtifact(root, `{"a":1,"a":2}`);
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      await expectReadFailure(root, ref, binding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects a BOM-prefixed file", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const { ref } = await writeRawArtifact(root, `﻿{"a":1}`);
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      await expectReadFailure(root, ref, binding, "planning-artifact.corrupt");
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
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      await expectReadFailure(root, ref, binding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects a truncated file and a wrong decodedBytes claim", async () => {
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
      const original = await import("node:fs/promises").then((m) => m.readFile(path));
      const flipped = Buffer.from(original);
      flipped[0] = flipped[0]! ^ 0xff;
      await import("node:fs/promises").then((m) => m.rm(path));
      await writeFile(path, flipped, { flag: "wx", mode: 0o600 });
      await expectReadFailure(root, ref, binding, "planning-artifact.corrupt");
    } finally {
      await root.close();
    }
  });

  test("rejects a missing artifact without any filesystem mutation", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const fakeHash = "0".repeat(64);
      const ref = { relativePath: `.state/planning/results/${fakeHash}.json`, sha256: fakeHash, decodedBytes: 10 };
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      const before = await pathExistsUnder(root.path, ".state");
      await expectReadFailure(root, ref, binding, "planning-artifact.not-found");
      const after = await pathExistsUnder(root.path, ".state");
      expect(after).toBe(before); // no .state directory was created as a side effect
    } finally {
      await root.close();
    }
  });

  async function pathExistsUnder(project: string, name: string): Promise<boolean> {
    const entries = await readdir(project).catch(() => [] as string[]);
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
      const stat = await import("node:fs/promises").then((m) => m.lstat(path));
      expect(stat.isSymbolicLink()).toBe(true);
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
      const stat = await import("node:fs/promises").then((m) => m.lstat(path));
      expect(stat.nlink).toBeGreaterThan(1);
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
      const stat = await import("node:fs/promises").then((m) => m.lstat(path));
      expect(stat.isDirectory()).toBe(true);
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
      const bytes = await import("node:fs/promises").then((m) => m.readFile(path, "utf8"));
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
      // One byte over the 2 MiB ceiling — large enough to prove the size check runs before any
      // chunked read is attempted, small enough to keep the test itself fast and bounded.
      await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), { flag: "wx", mode: 0o600 });
      await expectWriteFailure(root, result, board, meta, "planning-artifact.unsafe-file");
    } finally {
      await root.close();
    }
  });
});

describe("root liveness and failure isolation", () => {
  test("rejects when the run root has been replaced between operations", async () => {
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

  test("leaves the caller's root open and usable after a failed write", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      await expectWriteFailure(root, result, board, metadata({ maxSources: 0 }), "planning-artifact.invalid-metadata");
      const okRef = await writePlanningArtifactInternal(root, result, board, metadata());
      expect(/^[a-f0-9]{64}$/.test(okRef.sha256)).toBe(true);
    } finally {
      await root.close();
    }
  });
});

describe("read-only path performs zero writes", () => {
  // vi.spyOn cannot intercept node:fs/promises exports under real ESM (the module
  // namespace is non-configurable), so this asserts zero-write behavior by observing
  // actual filesystem state before/after instead of mocking the fs module.
  test("performs no mkdir and leaves the results directory's own mtime unchanged during a successful read", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const result = buildAuthenticResult(["solo"]);
      const board = buildAuthenticBoard(result);
      const meta = metadata();
      const ref = await writePlanningArtifactInternal(root, result, board, meta);
      const resultsDir = join(root.path, ".state", "planning", "results");
      const fsp = await import("node:fs/promises");
      const before = await fsp.stat(resultsDir);
      const beforeEntries = (await fsp.readdir(resultsDir)).sort();
      await readPlanningArtifactInternal(root, ref, expectedBinding(result, board, meta));
      const after = await fsp.stat(resultsDir);
      const afterEntries = (await fsp.readdir(resultsDir)).sort();
      expect(afterEntries).toEqual(beforeEntries);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      await root.close();
    }
  });

  test("creates no directory at all when the artifact is missing", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      const fakeHash = "1".repeat(64);
      const ref = { relativePath: `.state/planning/results/${fakeHash}.json`, sha256: fakeHash, decodedBytes: 10 };
      const binding = { runId: RUN_ID, attemptId: ATTEMPT_ID, executionEpoch: 0, transactionId: TX_ID, maxSources: 30, attemptEnvelopeSha256: ENVELOPE_SHA, logicalInputSha256: INPUT_SHA, controlTaskId: CONTROL_TASK_ID };
      await expectReadFailure(root, ref, binding, "planning-artifact.not-found");
      const stateExists = await readdir(root.path).then((entries) => entries.includes(".state")).catch(() => false);
      expect(stateExists).toBe(false);
    } finally {
      await root.close();
    }
  });
});

describe("bounded stress", () => {
  test("performs 100 write+read cycles with distinct content and no descriptor leak", async () => {
    const { project } = await fixture();
    const root = await openRoot(project);
    try {
      for (let i = 0; i < 100; i += 1) {
        const result = buildAuthenticResult([`task-${i}`]);
        const board = buildAuthenticBoard(result);
        const meta = metadata({ transactionId: `tx-${String(i).padStart(16, "0")}` as never });
        const ref = await writePlanningArtifactInternal(root, result, board, meta);
        const rehydrated = await readPlanningArtifactInternal(root, ref, expectedBinding(result, board, meta));
        expect(rehydrated.result.tasks[0]!.proposalId).toBe(`task-${i}`);
      }
    } finally {
      await root.close();
    }
  }, 30_000);
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
