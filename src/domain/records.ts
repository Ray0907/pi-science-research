import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Type, type Static } from "typebox";
import { ID_PATTERNS, isTimestamp } from "./ids.js";
import { issue, parse, registerRefinement, type ParseResult, type ValidationIssue } from "./schema.js";

const closed = { additionalProperties: false } as const;
const id = (kind: keyof typeof ID_PATTERNS) => Type.String({ pattern: ID_PATTERNS[kind].source });
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const TimestampSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const RevisionSchema = Type.Integer({ minimum: 1 });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });
const BlockerSchema = Type.Object({ code: Type.String(), message: Type.String() }, closed);
const ErrorSchema = Type.Object({ class: Type.String(), message: Type.String() }, closed);
const TaskRefSchema = Type.Object({ taskId: id("task"), revision: RevisionSchema }, closed);
const AttemptRefSchema = Type.Object({ attemptId: id("attempt"), revision: RevisionSchema }, closed);
const SourceRefSchema = Type.Object({ sourceId: id("source"), revision: RevisionSchema }, closed);
const ClaimRefSchema = Type.Object({ claimId: id("claim"), revision: RevisionSchema }, closed);
const EvidenceRefSchema = Type.Object({ evidenceId: id("evidence"), revision: RevisionSchema }, closed);
const VerificationRefSchema = Type.Object({ verificationId: id("verification"), revision: RevisionSchema }, closed);

export const TaskRoleSchema = StringEnum([
  "literature-searcher",
  "primary-source-reader",
  "methodology-reviewer",
  "data-verifier",
  "adversarial-verifier",
  "coordinator",
] as const);
export const TaskStateSchema = StringEnum(["open", "ready", "running", "blocked", "resolved", "cancelled"] as const);
export const AttemptKindSchema = StringEnum([
  "coordinator-planning",
  "coordinator-gap",
  "coordinator-routing",
  "coordinator-synthesis",
  "research",
  "verification",
  "calculation",
] as const);
export const ReplayPolicySchema = StringEnum(["safe-read", "never"] as const);
export const AttemptStateSchema = StringEnum([
  "intent-recorded",
  "dispatching",
  "running",
  "result-recorded",
  "committed",
  "retryable-failed",
  "terminal-failed",
  "cancelled",
  "superseded",
] as const);
export const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export const BillingStatusSchema = StringEnum(["reported", "unknown", "not-applicable"] as const);
export const RunDepthSchema = StringEnum(["quick", "standard", "deep"] as const);
export const RunStateSchema = StringEnum(["created", "planning", "researching", "verifying", "synthesizing", "recovering", "paused", "failed", "cancelled", "completed"] as const);
export const CheckpointStageSchema = StringEnum(["planning", "researching", "verifying", "synthesizing"] as const);
export const ManifestFileKindSchema = StringEnum(["sources", "claims", "evidence", "verifications", "requests", "calculations"] as const);

const EvidenceRuleSchema = Type.Object({
  minSources: NonNegativeIntegerSchema,
  requirePrimary: Type.Boolean(),
  requireIndependentLineages: NonNegativeIntegerSchema,
}, closed);

export const TaskRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  taskId: id("task"),
  revision: RevisionSchema,
  description: Type.String(),
  evidenceRule: EvidenceRuleSchema,
  role: TaskRoleSchema,
  state: TaskStateSchema,
  attemptIds: Type.Array(id("attempt")),
  blocker: Type.Union([BlockerSchema, Type.Null()]),
  resolution: Type.Union([Type.String(), Type.Null()]),
}, closed);
export type TaskRecord = Static<typeof TaskRecordSchema>;

const AttemptUsageRecordSchema = Type.Object({
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheReadTokens: NonNegativeIntegerSchema,
  cacheWriteTokens: NonNegativeIntegerSchema,
  reasoningTokens: NonNegativeIntegerSchema,
  cost: Type.Union([NonNegativeNumberSchema, Type.Null()]),
  currency: Type.Union([Type.String(), Type.Null()]),
}, closed);

export const AttemptRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: id("attempt"),
  revision: RevisionSchema,
  runId: id("run"),
  taskId: id("task"),
  executionEpoch: NonNegativeIntegerSchema,
  logicalOperationId: Type.String({ minLength: 1 }),
  attemptOrdinal: PositiveIntegerSchema,
  retryOfAttemptId: Type.Union([id("attempt"), Type.Null()]),
  attemptKind: AttemptKindSchema,
  replayPolicy: ReplayPolicySchema,
  state: AttemptStateSchema,
  providerModel: Type.String({ minLength: 1 }),
  thinkingLevel: ThinkingLevelSchema,
  promptTemplateSha256: Sha256Schema,
  renderedPromptSha256: Sha256Schema,
  logicalInputSha256: Sha256Schema,
  attemptEnvelopeSha256: Sha256Schema,
  toolAllowlist: Type.Array(Type.String()),
  deadlineAt: TimestampSchema,
  capabilityId: Type.String({ minLength: 1 }),
  resultSha256: Type.Union([Sha256Schema, Type.Null()]),
  billingStatus: BillingStatusSchema,
  reportedUsage: Type.Union([AttemptUsageRecordSchema, Type.Null()]),
  error: Type.Union([ErrorSchema, Type.Null()]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, closed);
export type AttemptRecord = Static<typeof AttemptRecordSchema>;

const BudgetRecordSchema = Type.Object({
  activeTimeLimitMs: NonNegativeNumberSchema,
  activeTimeUsedMs: NonNegativeNumberSchema,
  finalizationReserveMs: NonNegativeNumberSchema,
  maxSources: NonNegativeIntegerSchema,
  admittedSources: NonNegativeIntegerSchema,
  maxWaves: NonNegativeIntegerSchema,
  waveOrdinal: NonNegativeIntegerSchema,
}, closed);
const RoleModelsSchema = Type.Object({ coordinator: Type.String(), researcher: Type.String(), verifier: Type.String() }, closed);
const RoleThinkingSchema = Type.Object({ coordinator: ThinkingLevelSchema, researcher: ThinkingLevelSchema, verifier: ThinkingLevelSchema }, closed);

export const RunSnapshotSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  runId: id("run"),
  revision: RevisionSchema,
  question: Type.String(),
  language: Type.String(),
  depth: RunDepthSchema,
  reproducible: Type.Boolean(),
  allowCalculations: Type.Boolean(),
  calculationPolicySha256: Type.Union([Sha256Schema, Type.Null()]),
  state: RunStateSchema,
  checkpointStage: Type.Union([CheckpointStageSchema, Type.Null()]),
  executionEpoch: NonNegativeIntegerSchema,
  outputRoot: Type.String(),
  roleModels: RoleModelsSchema,
  roleThinking: RoleThinkingSchema,
  budget: BudgetRecordSchema,
  taskRefs: Type.Array(TaskRefSchema),
  attemptRefs: Type.Array(AttemptRefSchema),
  acceptedVerificationRef: Type.Union([VerificationRefSchema, Type.Null()]),
  currentRevisionId: Type.Union([id("revision"), Type.Null()]),
  blocker: Type.Union([BlockerSchema, Type.Null()]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: Type.Union([TimestampSchema, Type.Null()]),
}, closed);
export type RunSnapshot = Static<typeof RunSnapshotSchema>;

export const RetryScheduleSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  scheduleId: id("retry"),
  logicalOperationId: Type.String({ minLength: 1 }),
  failedAttemptId: id("attempt"),
  nextAttemptOrdinal: PositiveIntegerSchema,
  notBeforeAt: TimestampSchema,
  delayMs: NonNegativeNumberSchema,
  reasonClass: Type.String({ minLength: 1 }),
  replayPolicy: Type.Literal("safe-read"),
}, closed);
export type RetrySchedule = Static<typeof RetryScheduleSchema>;

const ManifestFileSchema = Type.Object({
  kind: ManifestFileKindSchema,
  relativePath: Type.String({ minLength: 1 }),
  recordCount: NonNegativeIntegerSchema,
  decodedBytes: NonNegativeIntegerSchema,
  sha256: Sha256Schema,
}, closed);

export const CanonicalTransactionManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  transactionId: id("transaction"),
  runId: id("run"),
  attemptId: id("attempt"),
  sourceResultSeq: PositiveIntegerSchema,
  createdAt: TimestampSchema,
  files: Type.Array(ManifestFileSchema),
  sourceRefs: Type.Array(SourceRefSchema),
  claimRefs: Type.Array(ClaimRefSchema),
  evidenceRefs: Type.Array(EvidenceRefSchema),
  verificationRefs: Type.Array(VerificationRefSchema),
  requestIds: Type.Array(id("request")),
  calculationIds: Type.Array(id("calculation")),
}, closed);
export type CanonicalTransactionManifest = Static<typeof CanonicalTransactionManifestSchema>;

registerRefinement(TaskRecordSchema, (input) => {
  const value = input as TaskRecord;
  const blockerRequired = value.state === "blocked";
  const resolutionRequired = value.state === "resolved";
  return [
    ...(blockerRequired !== (value.blocker !== null) ? [issue("/blocker", "task.blocker-state")] : []),
    ...(resolutionRequired !== (value.resolution !== null) ? [issue("/resolution", "task.resolution-state")] : []),
  ];
});

registerRefinement(AttemptRecordSchema, (input) => {
  const value = input as AttemptRecord;
  const issues: ValidationIssue[] = [];
  issues.push(...timestampIssues(value, ["deadlineAt", "createdAt", "updatedAt"]));
  if ((value.attemptOrdinal === 1) !== (value.retryOfAttemptId === null)) issues.push(issue("/retryOfAttemptId", "attempt.retry-backlink"));
  if (value.retryOfAttemptId === value.attemptId && value.retryOfAttemptId !== null) issues.push(issue("/retryOfAttemptId", "attempt.self-retry"));
  const calculation = value.attemptKind === "calculation";
  if (value.replayPolicy !== (calculation ? "never" : "safe-read")) issues.push(issue("/replayPolicy", "attempt.kind-policy"));
  if (calculation !== (value.billingStatus === "not-applicable")) issues.push(issue("/billingStatus", "attempt.kind-billing"));

  const resultRequired = value.state === "result-recorded" || value.state === "committed";
  const failureRequired = value.state === "retryable-failed" || value.state === "terminal-failed" || value.state === "cancelled";
  if (value.state !== "superseded") {
    if (resultRequired !== (value.resultSha256 !== null)) issues.push(issue("/resultSha256", "attempt.state-result"));
    if (failureRequired !== (value.error !== null)) issues.push(issue("/error", "attempt.state-error"));
  }
  if ((value.billingStatus === "reported") !== (value.reportedUsage !== null)) issues.push(issue("/reportedUsage", "attempt.billing-usage"));
  if (value.reportedUsage && ((value.reportedUsage.cost === null) !== (value.reportedUsage.currency === null))) {
    issues.push(issue("/reportedUsage/currency", "attempt.usage-currency"));
  }
  return issues;
});

registerRefinement(RunSnapshotSchema, (input) => {
  const value = input as RunSnapshot;
  const issues: ValidationIssue[] = [];
  issues.push(...timestampIssues(value, ["createdAt", "updatedAt", "completedAt"]));
  const budget = value.budget;
  const reserve = Math.min(600_000, Math.max(60_000, 0.2 * budget.activeTimeLimitMs), 0.5 * budget.activeTimeLimitMs);
  if (budget.finalizationReserveMs !== reserve || budget.finalizationReserveMs >= budget.activeTimeLimitMs) issues.push(issue("/budget/finalizationReserveMs", "run.finalization-reserve"));
  if (budget.activeTimeUsedMs > budget.activeTimeLimitMs) issues.push(issue("/budget/activeTimeUsedMs", "run.active-time-used"));
  if (budget.admittedSources > budget.maxSources) issues.push(issue("/budget/admittedSources", "run.admitted-sources"));
  if (budget.waveOrdinal > budget.maxWaves) issues.push(issue("/budget/waveOrdinal", "run.wave-ordinal"));
  if (value.allowCalculations !== (value.calculationPolicySha256 !== null)) issues.push(issue("/calculationPolicySha256", "run.calculation-policy"));

  const checkpoint = value.checkpointStage;
  const matchingStage = value.state === "planning" || value.state === "researching" || value.state === "verifying" || value.state === "synthesizing";
  if (value.state === "created" && checkpoint !== null) issues.push(issue("/checkpointStage", "run.created-checkpoint"));
  if (matchingStage && checkpoint !== value.state) issues.push(issue("/checkpointStage", "run.stage-checkpoint"));
  if (value.state === "recovering" && checkpoint === null) issues.push(issue("/checkpointStage", "run.recovery-checkpoint"));
  if (value.state === "completed" && checkpoint !== "synthesizing") issues.push(issue("/checkpointStage", "run.completed-checkpoint"));

  if (value.state === "failed" ? value.blocker === null : value.state !== "paused" && value.blocker !== null) issues.push(issue("/blocker", "run.state-blocker"));
  const completed = value.state === "completed";
  if (completed !== (value.completedAt !== null)) issues.push(issue("/completedAt", "run.completed-at"));
  if (completed !== (value.currentRevisionId !== null)) issues.push(issue("/currentRevisionId", "run.current-revision"));
  return issues;
});

registerRefinement(RetryScheduleSchema, (input) => {
  const value = input as RetrySchedule;
  return isTimestamp(value.notBeforeAt) ? [] : [issue("/notBeforeAt", "schedule.timestamp")];
});

registerRefinement(CanonicalTransactionManifestSchema, (input) => {
  const value = input as CanonicalTransactionManifest;
  const issues: ValidationIssue[] = [...timestampIssues(value, ["createdAt"])];
  const portable = (path: string) => !path.startsWith("/") && !/^[a-z]:\//i.test(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  value.files.forEach((file, index) => {
    if (!portable(file.relativePath)) issues.push(issue(`/files/${index}/relativePath`, "manifest.relative-path"));
  });
  uniqueBy(value.files, (file) => file.kind, "/files", "manifest.duplicate-kind", issues);
  uniqueBy(value.files, (file) => file.relativePath, "/files", "manifest.duplicate-path", issues);
  uniqueBy(value.sourceRefs, (ref) => String(ref.sourceId), "/sourceRefs", "manifest.duplicate-source", issues);
  uniqueBy(value.claimRefs, (ref) => String(ref.claimId), "/claimRefs", "manifest.duplicate-claim", issues);
  uniqueBy(value.evidenceRefs, (ref) => String(ref.evidenceId), "/evidenceRefs", "manifest.duplicate-evidence", issues);
  uniqueBy(value.verificationRefs, (ref) => String(ref.verificationId), "/verificationRefs", "manifest.duplicate-verification", issues);
  uniqueBy(value.requestIds, (value) => value, "/requestIds", "manifest.duplicate-request", issues);
  uniqueBy(value.calculationIds, (value) => value, "/calculationIds", "manifest.duplicate-calculation", issues);
  return issues;
});

function timestampIssues<T extends object>(value: T, keys: readonly (keyof T)[]): ValidationIssue[] {
  return keys.flatMap((key) => {
    const timestamp = value[key];
    return timestamp === null || isTimestamp(timestamp) ? [] : [issue(`/${String(key)}`, "schema.timestamp")];
  });
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, path: string, code: string, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) issues.push(issue(`${path}/${index}`, code));
    seen.add(itemKey);
  });
}

export function validateRetrySeries(attemptInputs: readonly unknown[], scheduleInputs: readonly unknown[]): ParseResult<{ attempts: AttemptRecord[]; schedules: RetrySchedule[] }> {
  const issues: ValidationIssue[] = [];
  const attempts: AttemptRecord[] = [];
  const schedules: RetrySchedule[] = [];
  for (const [index, input] of attemptInputs.entries()) collectParsed(parse(AttemptRecordSchema, input), `/attempts/${index}`, attempts, issues);
  for (const [index, input] of scheduleInputs.entries()) collectParsed(parse(RetryScheduleSchema, input), `/schedules/${index}`, schedules, issues);
  if (issues.length > 0) return { success: false, issues };

  const attemptIds = new Set<string>();
  const attemptEnvelopeHashes = new Set<string>();
  attempts.forEach((attempt, index) => {
    if (attemptIds.has(attempt.attemptId)) issues.push(issue(`/attempts/${index}/attemptId`, "retry.duplicate-attempt-id"));
    if (attemptEnvelopeHashes.has(attempt.attemptEnvelopeSha256)) issues.push(issue(`/attempts/${index}/attemptEnvelopeSha256`, "retry.duplicate-envelope"));
    attemptIds.add(attempt.attemptId);
    attemptEnvelopeHashes.add(attempt.attemptEnvelopeSha256);
  });

  const scheduleIds = new Set<string>();
  schedules.forEach((schedule, index) => {
    if (scheduleIds.has(schedule.scheduleId)) issues.push(issue(`/schedules/${index}/scheduleId`, "retry.duplicate-schedule-id"));
    scheduleIds.add(schedule.scheduleId);
  });

  const groups = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) groups.set(attempt.logicalOperationId, [...(groups.get(attempt.logicalOperationId) ?? []), attempt]);
  for (const [logicalOperationId, group] of groups) validateGroup(logicalOperationId, group, schedules.filter((schedule) => schedule.logicalOperationId === logicalOperationId), issues);
  schedules.forEach((schedule, index) => {
    if (!groups.has(schedule.logicalOperationId)) issues.push(issue(`/schedules/${index}`, "retry.orphan-logical-operation"));
  });
  return issues.length === 0 ? { success: true, value: { attempts, schedules } } : { success: false, issues };
}

function collectParsed<T>(result: ParseResult<T>, prefix: string, output: T[], issues: ValidationIssue[]): void {
  if (result.success) output.push(result.value);
  else issues.push(...result.issues.map((item) => issue(`${prefix}${item.path === "/" ? "" : item.path}`, item.code)));
}

function validateGroup(logicalOperationId: string, unsorted: AttemptRecord[], schedules: RetrySchedule[], issues: ValidationIssue[]): void {
  const group = [...unsorted].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal);
  const first = group[0];
  if (!first) return;
  const immutable: (keyof AttemptRecord)[] = ["runId", "taskId", "executionEpoch", "attemptKind", "providerModel", "thinkingLevel", "promptTemplateSha256", "logicalInputSha256", "toolAllowlist", "deadlineAt", "replayPolicy"];
  group.forEach((attempt, index) => {
    if (attempt.attemptOrdinal !== index + 1) issues.push(issue(`/attempts/${index}/attemptOrdinal`, "retry.nonconsecutive-ordinal"));
    for (const key of immutable) if (JSON.stringify(attempt[key]) !== JSON.stringify(first[key])) issues.push(issue(`/attempts/${index}/${String(key)}`, "retry.immutable-change"));
    if (index > 0) {
      const predecessor = group[index - 1]!;
      if (attempt.retryOfAttemptId !== predecessor.attemptId) issues.push(issue(`/attempts/${index}/retryOfAttemptId`, "retry.wrong-backlink"));
      if (predecessor.state !== "retryable-failed") issues.push(issue(`/attempts/${index}`, "retry.invalid-predecessor-state"));
      const edge = schedules.filter((schedule) => schedule.failedAttemptId === predecessor.attemptId && schedule.nextAttemptOrdinal === attempt.attemptOrdinal);
      if (edge.length !== 1) issues.push(issue(`/attempts/${index}`, "retry.schedule-edge-count"));
    }
  });
  if (first.replayPolicy === "never" && schedules.length > 0) issues.push(issue("/schedules", "retry.never-scheduled"));

  const consumed = new Set<string>();
  for (let index = 1; index < group.length; index += 1) {
    for (const schedule of schedules.filter((candidate) => candidate.failedAttemptId === group[index - 1]!.attemptId && candidate.nextAttemptOrdinal === group[index]!.attemptOrdinal)) consumed.add(schedule.scheduleId);
  }
  const pending = schedules.filter((schedule) => !consumed.has(schedule.scheduleId));
  if (pending.length > 1) issues.push(issue("/schedules", "retry.multiple-pending"));
  if (pending.length === 1) {
    const schedule = pending[0]!;
    const last = group.at(-1)!;
    if (schedule.failedAttemptId !== last.attemptId || schedule.nextAttemptOrdinal !== last.attemptOrdinal + 1 || last.state !== "retryable-failed") issues.push(issue("/schedules", "retry.non-immediate-pending"));
  }
  for (const schedule of schedules) {
    if (!group.some((attempt) => attempt.attemptId === schedule.failedAttemptId)) issues.push(issue("/schedules", "retry.orphan-failed-attempt"));
  }
  void logicalOperationId;
}

export { parse } from "./schema.js";
