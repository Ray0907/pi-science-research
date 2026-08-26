import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Type, type Static, type TSchema } from "typebox";

import { ID_PATTERNS, isTimestamp } from "./ids.js";
import {
  AttemptRecordSchema,
  RunSnapshotSchema,
  TaskRecordSchema,
} from "./records.js";
import { issue, registerRefinement } from "./schema.js";

const closed = { additionalProperties: false } as const;
const id = (pattern: string) => Type.String({ pattern });
const AttemptIdSchema = id("^attempt-[a-z0-9]{16,64}$");
const TaskIdSchema = id("^task-[a-z0-9]{16,64}$");
const SourceIdSchema = id("^src-[a-z0-9][a-z0-9._-]{7,127}$");
const ClaimIdSchema = id("^claim-[a-z0-9]{16,64}$");
const EvidenceIdSchema = id("^ev-[a-z0-9]{16,64}$");
const VerificationIdSchema = id("^verify-[a-z0-9]{16,64}$");
const RequestIdSchema = id("^request-[a-z0-9]{16,64}$");
const CalculationIdSchema = id("^calc-[a-z0-9]{16,64}$");
const RetryScheduleIdSchema = id("^retry-[a-z0-9]{16,64}$");
const TransactionIdSchema = id("^tx-[a-z0-9]{16,64}$");
const RevisionIdSchema = id("^rev-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$");
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const TimestampSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });

export const ReservedIdentityKindSchema = StringEnum([
  "attempt",
  "request",
  "retry-schedule",
  "transaction",
  "revision",
] as const);
export type ReservedIdentityKind = Static<typeof ReservedIdentityKindSchema>;

export const ReservedIdentityOriginSchema = StringEnum(["parent-generated", "child-import"] as const);
export type ReservedIdentityOrigin = Static<typeof ReservedIdentityOriginSchema>;

const BlockerSchema = Type.Object({ code: Type.String(), message: Type.String() }, closed);
const RevisionRef = (property: string, schema: TSchema) => Type.Object({ [property]: schema, revision: PositiveIntegerSchema }, closed);
const SourceRefSchema = RevisionRef("sourceId", SourceIdSchema);
const ClaimRefSchema = RevisionRef("claimId", ClaimIdSchema);
const EvidenceRefSchema = RevisionRef("evidenceId", EvidenceIdSchema);
const VerificationRefSchema = RevisionRef("verificationId", VerificationIdSchema);

const AttemptUsageRecordSchema = Type.Object({
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheReadTokens: NonNegativeIntegerSchema,
  cacheWriteTokens: NonNegativeIntegerSchema,
  reasoningTokens: NonNegativeIntegerSchema,
  cost: Type.Union([NonNegativeNumberSchema, Type.Null()]),
  currency: Type.Union([Type.String(), Type.Null()]),
}, closed);

const BudgetRecordSchema = Type.Object({
  activeTimeLimitMs: NonNegativeNumberSchema,
  activeTimeUsedMs: NonNegativeNumberSchema,
  finalizationReserveMs: NonNegativeNumberSchema,
  maxSources: NonNegativeIntegerSchema,
  admittedSources: NonNegativeIntegerSchema,
  maxWaves: NonNegativeIntegerSchema,
  waveOrdinal: NonNegativeIntegerSchema,
}, closed);

const RunStateSchema = StringEnum([
  "created", "planning", "researching", "verifying", "synthesizing", "recovering", "paused", "failed", "cancelled", "completed",
] as const);
const CheckpointStageSchema = StringEnum(["planning", "researching", "verifying", "synthesizing"] as const);

export const CalculationFileRecordSchema = Type.Object({
  relativePath: Type.String({ minLength: 1 }),
  mediaType: Type.String(),
  decodedBytes: NonNegativeIntegerSchema,
  sha256: Sha256Schema,
}, closed);
export type CalculationFileRecord = Static<typeof CalculationFileRecordSchema>;

const RequestParameterSchema = Type.Object({ name: Type.String(), value: Type.String() }, closed);
const NormalizedRequestInputSchema = Type.Object({
  query: Type.Union([Type.String(), Type.Null()]),
  identifier: Type.Union([Type.String(), Type.Null()]),
  url: Type.Union([Type.String(), Type.Null()]),
  parameters: Type.Array(RequestParameterSchema),
}, closed);
const RequestProviderSchema = StringEnum(["openalex", "crossref", "pubmed", "pmc", "semantic-scholar", "unpaywall", "web"] as const);
const RequestOperationSchema = StringEnum(["search", "fetch", "resolve"] as const);
const RequestReplayPolicySchema = StringEnum(["safe-read", "never"] as const);

const requestIdentityProperties = {
  schemaVersion: Type.Literal(1),
  requestId: RequestIdSchema,
  attemptId: AttemptIdSchema,
  executionEpoch: NonNegativeIntegerSchema,
  logicalRequestId: Type.String(),
  physicalAttemptOrdinal: PositiveIntegerSchema,
  retryOfRequestId: Type.Union([RequestIdSchema, Type.Null()]),
  replayPolicy: RequestReplayPolicySchema,
  provider: RequestProviderSchema,
  operation: RequestOperationSchema,
  normalizedInput: NormalizedRequestInputSchema,
  accessPolicySha256: Sha256Schema,
} as const;

export const RequestIntentRecordSchema = Type.Object({
  ...requestIdentityProperties,
  deadlineAt: TimestampSchema,
  createdAt: TimestampSchema,
}, closed);
export type RequestIntentRecord = Static<typeof RequestIntentRecordSchema>;

export const RequestRecordSchema = Type.Object({
  ...requestIdentityProperties,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  status: StringEnum(["success", "partial", "retryable-error", "terminal-error", "cancelled"] as const),
  httpStatus: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
  requestedUrl: Type.Union([Type.String(), Type.Null()]),
  finalUrl: Type.Union([Type.String(), Type.Null()]),
  redirectUrls: Type.Array(Type.String()),
  responseSha256: Type.Union([Sha256Schema, Type.Null()]),
  responseFile: Type.Union([CalculationFileRecordSchema, Type.Null()]),
  encodedBytes: NonNegativeIntegerSchema,
  decodedBytes: NonNegativeIntegerSchema,
  resultSourceIds: Type.Array(SourceIdSchema),
  errorClass: Type.Union([Type.String(), Type.Null()]),
}, closed);
export type RequestRecord = Static<typeof RequestRecordSchema>;

const payloadSchemas = {
  identity_reserved: Type.Object({
    kind: ReservedIdentityKindSchema,
    id: Type.String(),
    origin: ReservedIdentityOriginSchema,
  }, closed),
  run_created: Type.Object({ run: RunSnapshotSchema }, closed),
  state_changed: Type.Object({
    from: RunStateSchema,
    to: RunStateSchema,
    blocker: Type.Union([BlockerSchema, Type.Null()]),
  }, closed),
  resume_epoch_started: Type.Object({
    priorEpoch: NonNegativeIntegerSchema,
    executionEpoch: NonNegativeIntegerSchema,
    priorCancelSeq: PositiveIntegerSchema,
    checkpointStage: Type.Union([CheckpointStageSchema, Type.Null()]),
    ownerTokenSha256: Sha256Schema,
  }, closed),
  active_time_checkpoint: Type.Object({
    ownerTokenSha256: Sha256Schema,
    intervalStartedAt: TimestampSchema,
    intervalEndedAt: TimestampSchema,
    addedMs: NonNegativeNumberSchema,
    totalMs: NonNegativeNumberSchema,
  }, closed),
  budget_amended: Type.Object({
    oldBudget: BudgetRecordSchema,
    newBudget: BudgetRecordSchema,
    operatorSource: StringEnum(["tui", "rpc", "json"] as const),
    reason: Type.String(),
  }, closed),
  task_upserted: Type.Object({ task: TaskRecordSchema }, closed),
  dispatch_intent: Type.Object({ attempt: AttemptRecordSchema }, closed),
  dispatch_started: Type.Object({
    attemptId: AttemptIdSchema,
    pid: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    requestCorrelation: Type.Union([Type.String(), Type.Null()]),
  }, closed),
  attempt_usage_recorded: Type.Object({
    attemptId: AttemptIdSchema,
    usage: AttemptUsageRecordSchema,
    source: StringEnum(["pi-json-stream", "provider-response"] as const),
  }, closed),
  result_recorded: Type.Object({
    attemptId: AttemptIdSchema,
    resultSha256: Sha256Schema,
    manifestSha256: Type.Union([Sha256Schema, Type.Null()]),
    transactionId: TransactionIdSchema,
  }, closed),
  request_intent_recorded: Type.Object({
    attemptId: AttemptIdSchema,
    journalLocalSeq: PositiveIntegerSchema,
    journalEntrySha256: Sha256Schema,
    intent: RequestIntentRecordSchema,
  }, closed),
  request_result_recorded: Type.Object({
    attemptId: AttemptIdSchema,
    journalLocalSeq: PositiveIntegerSchema,
    journalEntrySha256: Sha256Schema,
    intentLedgerSeq: PositiveIntegerSchema,
    request: RequestRecordSchema,
  }, closed),
  request_retry_scheduled: Type.Object({
    scheduleId: RetryScheduleIdSchema,
    attemptId: AttemptIdSchema,
    journalLocalSeq: PositiveIntegerSchema,
    journalEntrySha256: Sha256Schema,
    logicalRequestId: Type.String(),
    failedRequestId: RequestIdSchema,
    nextPhysicalAttemptOrdinal: PositiveIntegerSchema,
    notBeforeAt: TimestampSchema,
    delayMs: NonNegativeNumberSchema,
    reasonClass: Type.String(),
  }, closed),
  request_retry_started: Type.Object({
    scheduleId: RetryScheduleIdSchema,
    attemptId: AttemptIdSchema,
    journalLocalSeq: PositiveIntegerSchema,
    journalEntrySha256: Sha256Schema,
    logicalRequestId: Type.String(),
    requestId: RequestIdSchema,
    physicalAttemptOrdinal: PositiveIntegerSchema,
    scheduledFromLedgerSeq: PositiveIntegerSchema,
  }, closed),
  records_committed: Type.Object({
    transactionId: TransactionIdSchema,
    sourceResultSeq: PositiveIntegerSchema,
    transactionManifestPath: Type.String(),
    transactionManifestSha256: Sha256Schema,
    sourceRefs: Type.Array(SourceRefSchema),
    claimRefs: Type.Array(ClaimRefSchema),
    evidenceRefs: Type.Array(EvidenceRefSchema),
    verificationRefs: Type.Array(VerificationRefSchema),
    requestIds: Type.Array(RequestIdSchema),
    calculationIds: Type.Array(CalculationIdSchema),
  }, closed),
  attempt_committed: Type.Object({
    attemptId: AttemptIdSchema,
    transactionId: TransactionIdSchema,
    taskId: TaskIdSchema,
    sourceResultSeq: PositiveIntegerSchema,
  }, closed),
  attempt_failed: Type.Object({
    attemptId: AttemptIdSchema,
    state: StringEnum(["retryable-failed", "terminal-failed", "cancelled", "superseded"] as const),
    errorClass: Type.String(),
    message: Type.String(),
  }, closed),
  retry_scheduled: Type.Object({
    scheduleId: RetryScheduleIdSchema,
    logicalOperationId: Type.String(),
    failedAttemptId: AttemptIdSchema,
    nextAttemptOrdinal: PositiveIntegerSchema,
    notBeforeAt: TimestampSchema,
    delayMs: NonNegativeNumberSchema,
    reasonClass: Type.String(),
  }, closed),
  retry_started: Type.Object({
    scheduleId: RetryScheduleIdSchema,
    logicalOperationId: Type.String(),
    attemptId: AttemptIdSchema,
    attemptOrdinal: PositiveIntegerSchema,
    scheduledFromSeq: PositiveIntegerSchema,
  }, closed),
  cancel_requested: Type.Object({
    executionEpoch: NonNegativeIntegerSchema,
    reason: StringEnum(["user-abandon", "user-pause", "session-shutdown", "abort-signal"] as const),
  }, closed),
  lock_recovered: Type.Object({
    priorOwnerTokenSha256: Sha256Schema,
    newOwnerTokenSha256: Sha256Schema,
    evidence: Type.String(),
  }, closed),
  revision_prepared: Type.Object({
    revisionId: RevisionIdSchema,
    sourceLedgerSeq: PositiveIntegerSchema,
    completionCommitId: Type.String(),
  }, closed),
  revision_committed: Type.Object({
    revisionId: RevisionIdSchema,
    manifestSha256: Sha256Schema,
    completionCommitId: Type.String(),
  }, closed),
  revision_failed: Type.Object({
    revisionId: RevisionIdSchema,
    completionCommitId: Type.String(),
    errorClass: Type.String(),
    message: Type.String(),
  }, closed),
  run_completed: Type.Object({
    revisionId: RevisionIdSchema,
    manifestSha256: Sha256Schema,
    runSnapshotSha256: Sha256Schema,
    completionCommitId: Type.String(),
    completedAt: TimestampSchema,
  }, closed),
} as const;

export const FOUNDATION_EVENT_TYPES = Object.freeze(Object.keys(payloadSchemas) as (keyof typeof payloadSchemas)[]);
export type FoundationEventType = keyof typeof payloadSchemas;

const eventSchema = <T extends FoundationEventType>(type: T) => Type.Object({
  schemaVersion: Type.Literal(1),
  seq: PositiveIntegerSchema,
  occurredAt: TimestampSchema,
  eventId: Type.String(),
  type: Type.Literal(type),
  payload: payloadSchemas[type],
  prevSha256: Sha256Schema,
  entrySha256: Sha256Schema,
}, closed);

const eventSchemas = FOUNDATION_EVENT_TYPES.map((type) => eventSchema(type));
export const FoundationLedgerEventSchema = Type.Union(eventSchemas);

type FoundationPayloadMap = {
  [T in FoundationEventType]: Static<(typeof payloadSchemas)[T]>;
};

export interface LedgerEventBase<T extends string, P> {
  schemaVersion: 1;
  seq: number;
  occurredAt: string;
  eventId: string;
  type: T;
  payload: P;
  prevSha256: string;
  entrySha256: string;
}

export type FoundationLedgerEvent = {
  [T in FoundationEventType]: LedgerEventBase<T, FoundationPayloadMap[T]>;
}[FoundationEventType];
export type FoundationEventOfType<T extends FoundationEventType> = Extract<FoundationLedgerEvent, { type: T }>;
export type FoundationEventPayload<T extends FoundationEventType> = FoundationPayloadMap[T];

registerRefinement(CalculationFileRecordSchema, (input) => {
  const value = input as CalculationFileRecord;
  return isPortableRelativePath(value.relativePath) ? [] : [issue("/relativePath", "request.relative-path")];
});

registerRefinement(RequestIntentRecordSchema, (input) => requestRecordIssues(input as RequestIntentRecord, ["deadlineAt", "createdAt"]));
registerRefinement(RequestRecordSchema, (input) => requestRecordIssues(input as RequestRecord, ["startedAt", "endedAt"]));

registerRefinement(FoundationLedgerEventSchema, (input) => {
  const event = input as FoundationLedgerEvent;
  const issues = isTimestamp(event.occurredAt) ? [] : [issue("/occurredAt", "ledger.timestamp")];
  if (event.type === "identity_reserved") {
    const patterns: Record<ReservedIdentityKind, RegExp> = {
      attempt: ID_PATTERNS.attempt,
      request: ID_PATTERNS.request,
      "retry-schedule": ID_PATTERNS.retry,
      transaction: ID_PATTERNS.transaction,
      revision: ID_PATTERNS.revision,
    };
    if (!patterns[event.payload.kind].test(event.payload.id)) issues.push(issue("/payload/id", "identity.kind-mismatch"));
  } else if (event.type === "active_time_checkpoint") {
    if (!isTimestamp(event.payload.intervalStartedAt)) issues.push(issue("/payload/intervalStartedAt", "ledger.timestamp"));
    if (!isTimestamp(event.payload.intervalEndedAt)) issues.push(issue("/payload/intervalEndedAt", "ledger.timestamp"));
  } else if ((event.type === "retry_scheduled" || event.type === "request_retry_scheduled") && !isTimestamp(event.payload.notBeforeAt)) {
    issues.push(issue("/payload/notBeforeAt", "ledger.timestamp"));
  } else if (event.type === "request_intent_recorded" && event.payload.attemptId !== event.payload.intent.attemptId) {
    issues.push(issue("/payload/intent/attemptId", "request.attempt-mismatch"));
  } else if (event.type === "request_result_recorded" && event.payload.attemptId !== event.payload.request.attemptId) {
    issues.push(issue("/payload/request/attemptId", "request.attempt-mismatch"));
  } else if (event.type === "run_completed" && !isTimestamp(event.payload.completedAt)) {
    issues.push(issue("/payload/completedAt", "ledger.timestamp"));
  }
  return issues;
});

function requestRecordIssues(
  value: RequestIntentRecord | RequestRecord,
  timestampKeys: readonly ("deadlineAt" | "createdAt" | "startedAt" | "endedAt")[],
) {
  const timestampValues = value as unknown as Record<string, unknown>;
  const issues = timestampKeys.flatMap((key) => isTimestamp(timestampValues[key]) ? [] : [issue(`/${key}`, "request.timestamp")]);
  if ((value.physicalAttemptOrdinal === 1) !== (value.retryOfRequestId === null)) {
    issues.push(issue("/retryOfRequestId", "request.retry-backlink"));
  }
  if (value.retryOfRequestId === value.requestId && value.retryOfRequestId !== null) {
    issues.push(issue("/retryOfRequestId", "request.self-retry"));
  }
  return issues;
}

function isPortableRelativePath(path: string): boolean {
  return !path.startsWith("/")
    && !/^[a-z]:/i.test(path)
    && !path.includes("\\")
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
