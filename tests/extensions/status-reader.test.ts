import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { FoundationStatusReadError, readFoundationStatus } from "../../extensions/research/status-reader.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import { openEventLedger, readVerifiedLedgerSnapshot, type EventLedger } from "../../src/storage/event-ledger.js";
import { createOwnedRunRoot, inspectOwnedRunRootIntegrity } from "../../src/storage/run-root.js";
import { commitTransaction, inspectCanonicalTransactionsReadOnly, prepareTransaction } from "../../src/storage/transaction-store.js";

const RUN = "run-0123456789abcdef" as const;
const TASK = "task-0123456789abcdef" as const;
const ATTEMPT = "attempt-0123456789abcdef" as const;
const ATTEMPT_2 = "attempt-fedcba9876543210" as const;
const TX = "tx-0123456789abcdef" as const;
const RETRY = "retry-0123456789abcdef" as const;
const HASH = "a".repeat(64);
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
function task(): TaskRecord {
  return { schemaVersion: 1, taskId: TASK, revision: 1, description: "task", evidenceRule: { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: false, fullTextRequired: false }, role: "literature-searcher", state: "running", attemptIds: [], blocker: null, resolution: null };
}
function attempt(kind: "research" | "calculation" = "research"): AttemptRecord {
  return {
    schemaVersion: 1, attemptId: ATTEMPT, revision: 1, runId: RUN, taskId: TASK, executionEpoch: 0,
    logicalOperationId: "operation-1", attemptOrdinal: 1, retryOfAttemptId: null, attemptKind: kind,
    replayPolicy: kind === "calculation" ? "never" : "safe-read", state: "intent-recorded", providerModel: "p/m",
    thinkingLevel: "medium", promptTemplateSha256: HASH, renderedPromptSha256: "b".repeat(64), logicalInputSha256: "c".repeat(64),
    attemptEnvelopeSha256: "d".repeat(64), toolAllowlist: [], deadlineAt: "2026-08-25T13:34:56.000Z", capabilityId: "CAPABILITY_SECRET_SENTINEL",
    resultSha256: null, billingStatus: kind === "calculation" ? "not-applicable" : "unknown", reportedUsage: null, error: null,
    createdAt: AT, updatedAt: AT,
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "pi-status-reader-")); roots.push(base);
  const project = join(base, "project"); await mkdir(project);
  const owned = await createOwnedRunRoot({ trustedProject: project, repositoryRoot: project, topic: "status", runId: RUN, ownershipToken: "a".repeat(64), now: () => new Date(AT) });
  const root = owned.path; await owned.close();
  await mkdir(join(root, ".state"), { recursive: true, mode: 0o700 });
  let eventId = 0;
  const ledger = await openEventLedger(join(root, ".state/events.jsonl"), { now: () => new Date(AT), eventId: () => `event-${++eventId}` });
  await ledger.append("run_created", { run: runSnapshot() });
  return { base, project, root, ledger };
}

async function addAttempt(ledger: EventLedger, kind: "research" | "calculation") {
  await ledger.append("task_upserted", { task: task() });
  await ledger.reserveIdentity("attempt", ATTEMPT, "parent-generated");
  await ledger.append("dispatch_intent", { attempt: attempt(kind) });
  await ledger.append("dispatch_started", { attemptId: ATTEMPT, pid: null, requestCorrelation: null });
}

async function snapshotTree(root: string) {
  const output: Record<string, unknown> = {};
  async function walk(path: string) {
    const info = await stat(path);
    const key = relative(root, path) || ".";
    output[key] = { mode: info.mode, mtimeMs: info.mtimeMs, size: info.size, bytes: info.isFile() ? (await readFile(path)).toString("base64") : null };
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  await walk(root); return output;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("readFoundationStatus", () => {
  test("returns an allowlisted healthy status and leaves every file and directory unchanged", async () => {
    const { project, root, ledger } = await fixture(); await ledger.close();
    const before = await snapshotTree(root);
    const status = await readFoundationStatus({ cwd: project, rootPath: root });
    expect(status).toEqual({
      runId: RUN, state: "created", tasksByState: { open: 0, ready: 0, running: 0, blocked: 0, resolved: 0, cancelled: 0 },
      taskTotal: 0, attemptTotal: 0, pendingSafeReadSchedules: 0, earliestNotBeforeAt: null,
      uncertainNeverBlockers: 0, pendingTransactions: 0, unmaterializedResults: 0, committedTransactions: 0, executionEpoch: 0, integrity: "verified",
    });
    expect(await snapshotTree(root)).toEqual(before);
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });

  test("counts uncertain never blockers and only pending safe-read schedules", async () => {
    const blocked = await fixture(); await addAttempt(blocked.ledger, "calculation"); await blocked.ledger.close();
    expect((await readFoundationStatus({ cwd: blocked.project, rootPath: blocked.root }))?.uncertainNeverBlockers).toBe(1);

    const pending = await fixture(); await addAttempt(pending.ledger, "research");
    await pending.ledger.append("attempt_failed", { attemptId: ATTEMPT, state: "retryable-failed", errorClass: "transient", message: "CHILD_SECRET_SENTINEL" });
    await pending.ledger.reserveIdentity("retry-schedule", RETRY, "parent-generated");
    await pending.ledger.append("retry_scheduled", { scheduleId: RETRY, logicalOperationId: "operation-1", failedAttemptId: ATTEMPT, nextAttemptOrdinal: 2, notBeforeAt: "2026-08-25T12:35:56.000Z", delayMs: 60_000, reasonClass: "transient" });
    await pending.ledger.close();
    const status = await readFoundationStatus({ cwd: pending.project, rootPath: pending.root });
    expect(status?.pendingSafeReadSchedules).toBe(1);
    expect(status?.earliestNotBeforeAt).toBe("2026-08-25T12:35:56.000Z");
    expect(JSON.stringify(status)).not.toContain("CHILD_SECRET_SENTINEL");

    const started = await fixture(); await addAttempt(started.ledger, "research");
    await started.ledger.append("attempt_failed", { attemptId: ATTEMPT, state: "retryable-failed", errorClass: "transient", message: "x" });
    await started.ledger.reserveIdentity("retry-schedule", RETRY, "parent-generated");
    const startedSchedule = await started.ledger.append("retry_scheduled", { scheduleId: RETRY, logicalOperationId: "operation-1", failedAttemptId: ATTEMPT, nextAttemptOrdinal: 2, notBeforeAt: AT, delayMs: 0, reasonClass: "transient" });
    await started.ledger.reserveIdentity("attempt", ATTEMPT_2, "parent-generated");
    await started.ledger.append("retry_started", { scheduleId: RETRY, logicalOperationId: "operation-1", attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: startedSchedule.seq });
    await started.ledger.close();
    expect((await readFoundationStatus({ cwd: started.project, rootPath: started.root }))?.pendingSafeReadSchedules).toBe(0);

    const cancelled = await fixture(); await addAttempt(cancelled.ledger, "research");
    await cancelled.ledger.append("attempt_failed", { attemptId: ATTEMPT, state: "retryable-failed", errorClass: "transient", message: "x" });
    await cancelled.ledger.reserveIdentity("retry-schedule", RETRY, "parent-generated");
    await cancelled.ledger.append("retry_scheduled", { scheduleId: RETRY, logicalOperationId: "operation-1", failedAttemptId: ATTEMPT, nextAttemptOrdinal: 2, notBeforeAt: AT, delayMs: 0, reasonClass: "transient" });
    await cancelled.ledger.append("cancel_requested", { executionEpoch: 0, reason: "user-pause" });
    await cancelled.ledger.close();
    expect((await readFoundationStatus({ cwd: cancelled.project, rootPath: cancelled.root }))?.pendingSafeReadSchedules).toBe(0);
  });

  test("separates absent and staging-only results from pending-finish committed objects", async () => {
    const absent = await fixture(); await addAttempt(absent.ledger, "research");
    await absent.ledger.reserveIdentity("transaction", TX, "parent-generated");
    await absent.ledger.append("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX });
    await absent.ledger.close();
    const absentStatus = await readFoundationStatus({ cwd: absent.project, rootPath: absent.root });
    expect(absentStatus?.pendingTransactions).toBe(0);
    expect(absentStatus?.unmaterializedResults).toBe(1);

    const staging = await fixture(); await addAttempt(staging.ledger, "research");
    await staging.ledger.reserveIdentity("transaction", TX, "parent-generated");
    const stagingResult = await staging.ledger.append("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX });
    await staging.ledger.close();
    await prepareTransaction(staging.root, { schemaVersion: 1, transactionId: TX, runId: RUN, attemptId: ATTEMPT, sourceResultSeq: stagingResult.seq, createdAt: AT, sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] });
    const stagingBefore = await snapshotTree(staging.root);
    const stagingStatus = await readFoundationStatus({ cwd: staging.project, rootPath: staging.root });
    expect(await snapshotTree(staging.root)).toEqual(stagingBefore);
    expect(stagingStatus?.pendingTransactions).toBe(0);
    expect(stagingStatus?.unmaterializedResults).toBe(1);

    const pending = await fixture(); await addAttempt(pending.ledger, "research");
    await pending.ledger.reserveIdentity("transaction", TX, "parent-generated");
    const result = await pending.ledger.append("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX });
    await pending.ledger.close();
    const prepared = await prepareTransaction(pending.root, { schemaVersion: 1, transactionId: TX, runId: RUN, attemptId: ATTEMPT, sourceResultSeq: result.seq, createdAt: AT, sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] });
    const ref = await commitTransaction(pending.root, TX);
    const pendingBefore = await snapshotTree(pending.root);
    const pendingStatus = await readFoundationStatus({ cwd: pending.project, rootPath: pending.root });
    expect(pendingStatus?.pendingTransactions).toBe(1);
    expect(pendingStatus?.unmaterializedResults).toBe(0);
    expect(await snapshotTree(pending.root)).toEqual(pendingBefore);
    await writeFile(join(pending.root, ref.relativePath), "{}\n", "utf8");
    await expect(readFoundationStatus({ cwd: pending.project, rootPath: pending.root }))
      .rejects.toMatchObject({ code: "transaction.corrupt" });

    const committed = await fixture(); await addAttempt(committed.ledger, "research");
    await committed.ledger.reserveIdentity("transaction", TX, "parent-generated");
    const committedResult = await committed.ledger.append("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX });
    const committedPrepared = await prepareTransaction(committed.root, { schemaVersion: 1, transactionId: TX, runId: RUN, attemptId: ATTEMPT, sourceResultSeq: committedResult.seq, createdAt: AT, sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] });
    const committedRef = await commitTransaction(committed.root, TX);
    const records = await committed.ledger.append("records_committed", { transactionId: TX, sourceResultSeq: committedResult.seq, transactionManifestPath: committedRef.relativePath, transactionManifestSha256: committedRef.sha256, sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [] });
    expect(records.seq).toBeGreaterThan(committedResult.seq);
    const recordsOnlyStatus = await readFoundationStatus({ cwd: committed.project, rootPath: committed.root });
    expect(recordsOnlyStatus?.pendingTransactions).toBe(1);
    expect(recordsOnlyStatus?.committedTransactions).toBe(0);
    await committed.ledger.append("attempt_committed", { attemptId: ATTEMPT, transactionId: TX, taskId: TASK, sourceResultSeq: committedResult.seq });
    await committed.ledger.close();
    const status = await readFoundationStatus({ cwd: committed.project, rootPath: committed.root });
    expect(status?.committedTransactions).toBe(1);
    expect(status?.pendingTransactions).toBe(0);
    expect(status?.unmaterializedResults).toBe(0);
    expect(prepared.manifestSha256).toBe(ref.sha256);
    expect(committedPrepared.manifestSha256).toBe(committedRef.sha256);
  });

  test("preserves a primary status error when root cleanup also fails and redacts cleanup-only failure", async () => {
    const value = await fixture(); await value.ledger.close();
    const primary = new Error("PRIMARY_STATUS_SENTINEL");
    let closeAttempts = 0;
    const inspectWithFailingClose = async (path: string) => {
      const inspected = await inspectOwnedRunRootIntegrity(path);
      return { ...inspected, close: async () => { closeAttempts++; await inspected.close(); throw new Error("CLOSE_SECRET_SENTINEL"); } };
    };
    const primaryFailure = readFoundationStatus({ cwd: value.project, rootPath: value.root }, {
      inspectOwnedRunRootIntegrity: inspectWithFailingClose,
      readVerifiedLedgerSnapshot,
      inspectCanonicalTransactionsReadOnly: async () => { throw primary; },
    });
    await expect(primaryFailure.catch((error) => error)).resolves.toBe(primary);
    expect(closeAttempts).toBe(1);

    closeAttempts = 0;
    const cleanupFailure = readFoundationStatus({ cwd: value.project, rootPath: value.root }, {
      inspectOwnedRunRootIntegrity: inspectWithFailingClose,
      readVerifiedLedgerSnapshot,
      inspectCanonicalTransactionsReadOnly,
    });
    await expect(cleanupFailure).rejects.toBeInstanceOf(FoundationStatusReadError);
    await expect(cleanupFailure.catch((error: Error) => error.message)).resolves.not.toContain("CLOSE_SECRET_SENTINEL");
    expect(closeAttempts).toBe(1);
  });

  test("fails closed for missing or tampered transaction objects and closes descriptors", async () => {
    const value = await fixture(); await addAttempt(value.ledger, "research");
    await value.ledger.reserveIdentity("transaction", TX, "parent-generated");
    const result = await value.ledger.append("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX });
    await value.ledger.append("records_committed", { transactionId: TX, sourceResultSeq: result.seq, transactionManifestPath: `.state/transactions/committed/${TX}/manifest.json`, transactionManifestSha256: HASH, sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [] });
    await value.ledger.close();
    await expect(readFoundationStatus({ cwd: value.project, rootPath: value.root })).rejects.toMatchObject({ code: "transaction.missing-object" });

    const marker = join(value.root, ".pi-science-research-owner.json");
    await writeFile(marker, "{}\n");
    await expect(readFoundationStatus({ cwd: value.project, rootPath: value.root })).rejects.toMatchObject({ code: "run-root.marker-invalid" });
  });
});
