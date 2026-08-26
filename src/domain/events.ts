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
  } else if (event.type === "retry_scheduled" && !isTimestamp(event.payload.notBeforeAt)) {
    issues.push(issue("/payload/notBeforeAt", "ledger.timestamp"));
  } else if (event.type === "run_completed" && !isTimestamp(event.payload.completedAt)) {
    issues.push(issue("/payload/completedAt", "ledger.timestamp"));
  }
  return issues;
});
