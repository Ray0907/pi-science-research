import { describe, expect, test } from "vitest";
import {
  AttemptKindSchema,
  AttemptRecordSchema,
  AttemptStateSchema,
  BillingStatusSchema,
  CanonicalTransactionManifestSchema,
  CheckpointStageSchema,
  ManifestFileKindSchema,
  ReplayPolicySchema,
  RetryScheduleSchema,
  RunDepthSchema,
  RunSnapshotSchema,
  RunStateSchema,
  TaskRecordSchema,
  TaskRoleSchema,
  TaskStateSchema,
  ThinkingLevelSchema,
  parse,
  validateRetrySeries,
} from "../../src/domain/records.js";
import {
  ID_PATTERNS,
  createIdGenerator,
  isSha256,
  isTimestamp,
} from "../../src/domain/ids.js";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const NOW = "2026-08-25T12:34:56.789Z";
const ids = {
  run: "run-abcdefghijklmnop",
  task: "task-abcdefghijklmnop",
  attempt: "attempt-abcdefghijklmnop",
  attempt2: "attempt-bcdefghijklmnopq",
  source: "src-abcdefghijklmnop",
  claim: "claim-abcdefghijklmnop",
  evidence: "ev-abcdefghijklmnop",
  verification: "verify-abcdefghijklmnop",
  request: "request-abcdefghijklmnop",
  calculation: "calc-abcdefghijklmnop",
  revision: "rev-20260825T123456789Z-abcdef123456",
  retry: "retry-abcdefghijklmnop",
  transaction: "tx-abcdefghijklmnop",
} as const;

const blocker = { code: "blocked", message: "blocked safely" };
const evidenceRule = {
  minSources: 1,
  requirePrimary: true,
  requireIndependentLineages: 2,
};
const usage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  cost: 0.1,
  currency: "USD",
};

function taskFixture() {
  return {
    schemaVersion: 1,
    taskId: ids.task,
    revision: 1,
    description: "Find primary sources",
    evidenceRule,
    role: "literature-searcher",
    state: "open",
    attemptIds: [],
    blocker: null,
    resolution: null,
  };
}

function attemptFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    attemptId: ids.attempt,
    revision: 1,
    runId: ids.run,
    taskId: ids.task,
    executionEpoch: 0,
    logicalOperationId: "logical-1",
    attemptOrdinal: 1,
    retryOfAttemptId: null,
    attemptKind: "research",
    replayPolicy: "safe-read",
    state: "intent-recorded",
    providerModel: "provider/model",
    thinkingLevel: "medium",
    promptTemplateSha256: H,
    renderedPromptSha256: H,
    logicalInputSha256: H,
    attemptEnvelopeSha256: H,
    toolAllowlist: ["research_search"],
    deadlineAt: NOW,
    capabilityId: "capability-1",
    resultSha256: null,
    billingStatus: "unknown",
    reportedUsage: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId: ids.run,
    revision: 1,
    question: "What is known?",
    language: "en",
    depth: "standard",
    reproducible: false,
    allowCalculations: false,
    calculationPolicySha256: null,
    state: "created",
    checkpointStage: null,
    executionEpoch: 0,
    outputRoot: "research/2026-08-25-known",
    roleModels: { coordinator: "p/m", researcher: "p/m", verifier: "p/m" },
    roleThinking: { coordinator: "medium", researcher: "medium", verifier: "high" },
    budget: {
      activeTimeLimitMs: 600_000,
      activeTimeUsedMs: 0,
      finalizationReserveMs: 120_000,
      maxSources: 20,
      admittedSources: 0,
      maxWaves: 3,
      waveOrdinal: 0,
    },
    taskRefs: [],
    attemptRefs: [],
    acceptedVerificationRef: null,
    currentRevisionId: null,
    blocker: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function scheduleFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scheduleId: ids.retry,
    logicalOperationId: "logical-1",
    failedAttemptId: ids.attempt,
    nextAttemptOrdinal: 2,
    notBeforeAt: NOW,
    delayMs: 100,
    reasonClass: "transient",
    replayPolicy: "safe-read",
    ...overrides,
  };
}

function manifestFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    transactionId: ids.transaction,
    runId: ids.run,
    attemptId: ids.attempt,
    sourceResultSeq: 1,
    createdAt: NOW,
    files: [{ kind: "sources", relativePath: "records/sources.jsonl", recordCount: 1, decodedBytes: 10, sha256: H }],
    sourceRefs: [{ sourceId: ids.source, revision: 1 }],
    claimRefs: [{ claimId: ids.claim, revision: 1 }],
    evidenceRefs: [{ evidenceId: ids.evidence, revision: 1 }],
    verificationRefs: [{ verificationId: ids.verification, revision: 1 }],
    requestIds: [ids.request],
    calculationIds: [ids.calculation],
    ...overrides,
  };
}

function expectInvalid(schema: Parameters<typeof parse>[0], value: unknown, path?: string) {
  const result = parse(schema, value);
  expect(result.success).toBe(false);
  if (!result.success && path) expect(result.issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}/`))).toBe(true);
  return result;
}

function expectValid(schema: Parameters<typeof parse>[0], value: unknown) {
  const result = parse(schema, value);
  expect(result.success).toBe(true);
}

describe("durable identity formats", () => {
  test("recognizes every closed ID format, sha256, and millisecond UTC timestamps", () => {
    for (const [kind, value] of Object.entries(ids)) {
      if (kind === "attempt2") continue;
      const pattern = ID_PATTERNS[kind as keyof typeof ID_PATTERNS];
      expect(pattern.test(value)).toBe(true);
      expect(pattern.test(value.toUpperCase())).toBe(false);
      expect(pattern.test(`${value.split("-")[0]}-short`)).toBe(false);
    }
    expect(isSha256(H)).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isTimestamp(NOW)).toBe(true);
    expect(isTimestamp("2026-08-25T12:34:56Z")).toBe(false);
  });

  test("generates all IDs from injected bytes without reuse in one instance", () => {
    let byte = 0;
    const generator = createIdGenerator({ randomBytes: (size) => Buffer.alloc(size, byte++), now: () => new Date(NOW) });
    for (const kind of Object.keys(ID_PATTERNS) as (keyof typeof ID_PATTERNS)[]) {
      const first = generator.next(kind);
      const second = generator.next(kind);
      expect(first).not.toBe(second);
      expect(ID_PATTERNS[kind].test(first)).toBe(true);
      expect(ID_PATTERNS[kind].test(second)).toBe(true);
    }
  });
});

describe("closed record schemas", () => {
  const fixtures = [
    [TaskRecordSchema, taskFixture()],
    [AttemptRecordSchema, attemptFixture()],
    [RunSnapshotSchema, runFixture()],
    [RetryScheduleSchema, scheduleFixture()],
    [CanonicalTransactionManifestSchema, manifestFixture()],
  ] as const;

  test("accepts complete fixtures and rejects every missing or unknown root field", () => {
    for (const [schema, fixture] of fixtures) {
      expectValid(schema, fixture);
      for (const key of Object.keys(fixture)) {
        const copy = structuredClone(fixture) as Record<string, unknown>;
        delete copy[key];
        expectInvalid(schema, copy, `/${key}`);
      }
      expectInvalid(schema, { ...fixture, unknown: true }, "/unknown");
    }
  });

  test("requires and closes nested records and rejects null arrays", () => {
    expectInvalid(TaskRecordSchema, { ...taskFixture(), evidenceRule: { requirePrimary: true, requireIndependentLineages: 2 } }, "/evidenceRule/minSources");
    expectInvalid(TaskRecordSchema, { ...taskFixture(), state: "blocked", blocker: { message: "x" } }, "/blocker/code");
    expectInvalid(AttemptRecordSchema, attemptFixture({ billingStatus: "reported", reportedUsage: { ...usage, outputTokens: undefined } }), "/reportedUsage/outputTokens");
    expectInvalid(AttemptRecordSchema, attemptFixture({ state: "retryable-failed", error: { message: "x" } }), "/error/class");
    expectInvalid(RunSnapshotSchema, runFixture({ roleModels: { coordinator: "p/m", researcher: "p/m" } }), "/roleModels/verifier");
    expectInvalid(RunSnapshotSchema, runFixture({ budget: { ...runFixture().budget, maxSources: undefined } }), "/budget/maxSources");
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: [{ ...manifestFixture().files[0], sha256: undefined }] }, "/files/0/sha256");
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), sourceRefs: [{ sourceId: ids.source }] }, "/sourceRefs/0/revision");
    expectInvalid(TaskRecordSchema, { ...taskFixture(), attemptIds: null }, "/attemptIds");
    expectInvalid(RunSnapshotSchema, { ...runFixture(), taskRefs: null }, "/taskRefs");
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: null }, "/files");
  });

  test("accepts every declared StringEnum value and rejects unknown values", () => {
    const enums = [
      [TaskRoleSchema, ["literature-searcher", "primary-source-reader", "methodology-reviewer", "data-verifier", "adversarial-verifier", "coordinator"]],
      [TaskStateSchema, ["open", "ready", "running", "blocked", "resolved", "cancelled"]],
      [AttemptKindSchema, ["coordinator-planning", "coordinator-gap", "coordinator-routing", "coordinator-synthesis", "research", "verification", "calculation"]],
      [ReplayPolicySchema, ["safe-read", "never"]],
      [AttemptStateSchema, ["intent-recorded", "dispatching", "running", "result-recorded", "committed", "retryable-failed", "terminal-failed", "cancelled", "superseded"]],
      [ThinkingLevelSchema, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
      [BillingStatusSchema, ["reported", "unknown", "not-applicable"]],
      [RunDepthSchema, ["quick", "standard", "deep"]],
      [RunStateSchema, ["created", "planning", "researching", "verifying", "synthesizing", "recovering", "paused", "failed", "cancelled", "completed"]],
      [CheckpointStageSchema, ["planning", "researching", "verifying", "synthesizing"]],
      [ManifestFileKindSchema, ["sources", "claims", "evidence", "verifications", "requests", "calculations"]],
    ] as const;
    for (const [schema, values] of enums) {
      expect((schema as { enum?: readonly string[] }).enum).toEqual(values);
      for (const value of values) expectValid(schema, value);
      expectInvalid(schema, "not-a-declared-value");
    }
  });

  test("closes nested records and uses enum arrays", () => {
    expectInvalid(TaskRecordSchema, { ...taskFixture(), evidenceRule: { ...evidenceRule, secret: true } }, "/evidenceRule/secret");
    expectInvalid(RunSnapshotSchema, { ...runFixture(), roleModels: { ...runFixture().roleModels, extra: "x" } }, "/roleModels/extra");
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: [{ ...manifestFixture().files[0], extra: true }] }, "/files/0/extra");
    expect((TaskRecordSchema.properties.role as { enum?: string[] }).enum).toContain("coordinator");
    expect((AttemptRecordSchema.properties.state as { enum?: string[] }).enum).toContain("superseded");
    expect((RunSnapshotSchema.properties.depth as { enum?: string[] }).enum).toEqual(["quick", "standard", "deep"]);
    expectInvalid(TaskRecordSchema, { ...taskFixture(), role: "invented-role" }, "/role");
    expectInvalid(AttemptRecordSchema, attemptFixture({ thinkingLevel: "extreme" }), "/thinkingLevel");
    expectInvalid(RunSnapshotSchema, runFixture({ depth: "exhaustive" }), "/depth");
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: [{ ...manifestFixture().files[0], kind: "other" }] }, "/files/0/kind");
  });

  test("enforces task state matrix", () => {
    expectValid(TaskRecordSchema, { ...taskFixture(), state: "blocked", blocker });
    expectValid(TaskRecordSchema, { ...taskFixture(), state: "resolved", resolution: "done" });
    expectInvalid(TaskRecordSchema, { ...taskFixture(), state: "blocked" });
    expectInvalid(TaskRecordSchema, { ...taskFixture(), state: "resolved" });
    expectInvalid(TaskRecordSchema, { ...taskFixture(), state: "open", blocker });
  });

  test("rejects syntactically shaped but impossible timestamps", () => {
    const impossible = "2026-02-31T12:34:56.789Z";
    expectInvalid(AttemptRecordSchema, attemptFixture({ deadlineAt: impossible }), "/deadlineAt");
    expectInvalid(RunSnapshotSchema, runFixture({ createdAt: impossible }), "/createdAt");
    expectInvalid(RetryScheduleSchema, scheduleFixture({ notBeforeAt: impossible }), "/notBeforeAt");
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), createdAt: impossible }, "/createdAt");
  });

  test("enforces attempt ordinal, kind, state, and billing matrices", () => {
    expectValid(AttemptRecordSchema, attemptFixture());
    expectValid(AttemptRecordSchema, attemptFixture({ attemptKind: "calculation", replayPolicy: "never", billingStatus: "not-applicable" }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ attemptOrdinal: 2 }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ retryOfAttemptId: ids.attempt }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ attemptKind: "calculation" }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ replayPolicy: "never" }));
    expectValid(AttemptRecordSchema, attemptFixture({ state: "result-recorded", resultSha256: H }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ state: "result-recorded" }));
    expectValid(AttemptRecordSchema, attemptFixture({ state: "retryable-failed", error: { class: "transient", message: "failed" } }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ state: "retryable-failed" }));
    expectValid(AttemptRecordSchema, attemptFixture({ billingStatus: "reported", reportedUsage: usage }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ billingStatus: "reported" }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ reportedUsage: usage }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ billingStatus: "reported", reportedUsage: { ...usage, currency: null } }));
    expectInvalid(AttemptRecordSchema, attemptFixture({ billingStatus: "reported", reportedUsage: { ...usage, inputTokens: -1 } }));
  });

  test("enforces run budget, lifecycle, and calculation matrices", () => {
    for (const [limit, reserve] of [[300_000, 60_000], [600_000, 120_000], [3_600_000, 600_000]]) {
      expectValid(RunSnapshotSchema, runFixture({ budget: { ...runFixture().budget, activeTimeLimitMs: limit, finalizationReserveMs: reserve } }));
    }
    expectInvalid(RunSnapshotSchema, runFixture({ budget: { ...runFixture().budget, finalizationReserveMs: 119_999 } }));
    expectInvalid(RunSnapshotSchema, runFixture({ budget: { ...runFixture().budget, activeTimeUsedMs: 600_001 } }));
    expectInvalid(RunSnapshotSchema, runFixture({ budget: { ...runFixture().budget, admittedSources: 21 } }));
    expectInvalid(RunSnapshotSchema, runFixture({ budget: { ...runFixture().budget, waveOrdinal: 4 } }));
    expectValid(RunSnapshotSchema, runFixture({ state: "paused", blocker: null }));
    expectValid(RunSnapshotSchema, runFixture({ state: "paused", blocker }));
    expectInvalid(RunSnapshotSchema, runFixture({ state: "failed" }));
    expectValid(RunSnapshotSchema, runFixture({ state: "failed", blocker }));
    expectValid(RunSnapshotSchema, runFixture({ state: "researching", checkpointStage: "researching" }));
    expectInvalid(RunSnapshotSchema, runFixture({ state: "researching", checkpointStage: "planning" }));
    expectValid(RunSnapshotSchema, runFixture({ state: "completed", checkpointStage: "synthesizing", completedAt: NOW, currentRevisionId: ids.revision }));
    expectInvalid(RunSnapshotSchema, runFixture({ state: "completed", checkpointStage: "synthesizing" }));
    expectInvalid(RunSnapshotSchema, runFixture({ completedAt: NOW }));
    expectValid(RunSnapshotSchema, runFixture({ allowCalculations: true, calculationPolicySha256: H }));
    expectInvalid(RunSnapshotSchema, runFixture({ allowCalculations: true }));
  });

  test("enforces manifest paths, uniqueness, and numeric constraints", () => {
    for (const path of ["/abs", "C:/secret", "c:/secret", "a\\b", ".", "..", "a//b", "a/./b", "a/../b", "a/", "/a"]) {
      expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: [{ ...manifestFixture().files[0], relativePath: path }] });
    }
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: [manifestFixture().files[0], { ...manifestFixture().files[0] }] });
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), sourceRefs: [manifestFixture().sourceRefs[0], manifestFixture().sourceRefs[0]] });
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), sourceRefs: [manifestFixture().sourceRefs[0], { ...manifestFixture().sourceRefs[0], revision: 2 }] });
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), sourceResultSeq: 0 });
    expectInvalid(CanonicalTransactionManifestSchema, { ...manifestFixture(), files: [{ ...manifestFixture().files[0], decodedBytes: -1 }] });
  });

  test("returns stable redacted validation issues", () => {
    const secret = "sk-super-secret-value";
    const result = expectInvalid(TaskRecordSchema, { ...taskFixture(), taskId: secret }, "/taskId");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("retry series", () => {
  const failed = attemptFixture({ state: "retryable-failed", error: { class: "transient", message: "failed" } });
  const retried = attemptFixture({ attemptId: ids.attempt2, attemptOrdinal: 2, retryOfAttemptId: ids.attempt, attemptEnvelopeSha256: H2 });

  test("accepts one consumed edge and allows physical prompt differences", () => {
    const result = validateRetrySeries([failed, { ...retried, renderedPromptSha256: H2 }], [scheduleFixture()]);
    expect(result.success).toBe(true);
  });

  test("rejects immutable changes, missing schedules, and invalid predecessors", () => {
    expect(validateRetrySeries([failed, { ...retried, logicalInputSha256: H2 }], [scheduleFixture()]).success).toBe(false);
    expect(validateRetrySeries([failed, retried], []).success).toBe(false);
    for (const state of ["running", "result-recorded", "committed", "terminal-failed", "cancelled", "superseded"] as const) {
      const predecessor = attemptFixture({ state, ...(state === "result-recorded" || state === "committed" ? { resultSha256: H } : {}), ...(state === "terminal-failed" || state === "cancelled" ? { error: { class: "x", message: "x" } } : {}) });
      expect(validateRetrySeries([predecessor, retried], [scheduleFixture()]).success).toBe(false);
    }
  });

  test("rejects an attempt ID duplicated across logical-operation groups", () => {
    const otherGroup = attemptFixture({
      logicalOperationId: "logical-2",
      attemptEnvelopeSha256: H2,
    });
    expect(validateRetrySeries([attemptFixture(), otherGroup], []).success).toBe(false);
  });

  test("rejects an envelope hash duplicated across logical-operation groups", () => {
    const distinctIdentity = attemptFixture({
      attemptId: "attempt-cdefghijklmnopqr",
      logicalOperationId: "logical-2",
    });
    expect(validateRetrySeries([attemptFixture(), distinctIdentity], []).success).toBe(false);
  });

  test("rejects duplicate, orphan, non-immediate, and never schedules", () => {
    expect(validateRetrySeries([failed, retried], [scheduleFixture(), scheduleFixture()]).success).toBe(false);
    expect(validateRetrySeries([failed], [scheduleFixture({ failedAttemptId: ids.attempt2 })]).success).toBe(false);
    expect(validateRetrySeries([failed], [scheduleFixture({ nextAttemptOrdinal: 3 })]).success).toBe(false);
    expect(validateRetrySeries([attemptFixture({ attemptKind: "calculation", replayPolicy: "never", billingStatus: "not-applicable", state: "retryable-failed", error: { class: "x", message: "x" } })], [scheduleFixture()]).success).toBe(false);
    expectInvalid(RetryScheduleSchema, scheduleFixture({ delayMs: Number.POSITIVE_INFINITY }));
    expectInvalid(RetryScheduleSchema, scheduleFixture({ delayMs: -1 }));
    expectValid(RetryScheduleSchema, scheduleFixture({ delayMs: 0 }));
  });
});
