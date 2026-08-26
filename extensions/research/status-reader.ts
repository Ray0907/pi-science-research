import { join, resolve } from "node:path";

import { recoveryDecisionFor, reduceLedgerEvents } from "../../src/domain/reducer.js";
import { readVerifiedLedgerSnapshot } from "../../src/storage/event-ledger.js";
import { inspectOwnedRunRootIntegrity } from "../../src/storage/run-root.js";
import { recoverRetryState } from "../../src/storage/retry-store.js";
import { inspectCanonicalTransactionsReadOnly } from "../../src/storage/transaction-store.js";

import type { FoundationStatus, FoundationStatusRequest } from "./commands/status.js";

const TASK_STATES = ["open", "ready", "running", "blocked", "resolved", "cancelled"] as const;

export class FoundationStatusReadError extends Error {
  readonly code = "status.unavailable";
  constructor() { super("Research status unavailable."); this.name = "FoundationStatusReadError"; }
}

export interface FoundationStatusReaderDependencies {
  inspectOwnedRunRootIntegrity: typeof inspectOwnedRunRootIntegrity;
  readVerifiedLedgerSnapshot: typeof readVerifiedLedgerSnapshot;
  inspectCanonicalTransactionsReadOnly: typeof inspectCanonicalTransactionsReadOnly;
}

const DEFAULT_DEPENDENCIES: FoundationStatusReaderDependencies = {
  inspectOwnedRunRootIntegrity,
  readVerifiedLedgerSnapshot,
  inspectCanonicalTransactionsReadOnly,
};

export async function readFoundationStatus(
  request: FoundationStatusRequest,
  dependencies: FoundationStatusReaderDependencies = DEFAULT_DEPENDENCIES,
): Promise<FoundationStatus | null> {
  if (request.rootPath === null) return null;
  const rootPath = resolve(request.cwd, request.rootPath);
  const inspected = await dependencies.inspectOwnedRunRootIntegrity(rootPath);
  let result: FoundationStatus | undefined;
  let failure: unknown;
  try {
    const events = await dependencies.readVerifiedLedgerSnapshot(join(inspected.path, ".state", "events.jsonl"), { trustedRoot: inspected.path });
    await inspected.revalidate();
    const reduced = reduceLedgerEvents(events);
    const runEvents = events.filter((event) => event.type === "run_created");
    if (runEvents.length !== 1 || runEvents[0]!.payload.run.runId !== inspected.runId || reduced.runState === null) {
      throw new Error("status integrity failure");
    }
    const transactions = await dependencies.inspectCanonicalTransactionsReadOnly(inspected.path, events);
    await inspected.revalidate();

    const latestTasks = new Map<string, (typeof events)[number] & { type: "task_upserted" }>();
    const attempts = new Set<string>();
    for (const event of events) {
      if (event.type === "task_upserted") latestTasks.set(event.payload.task.taskId, event as typeof event & { type: "task_upserted" });
      if (event.type === "dispatch_intent") attempts.add(event.payload.attempt.attemptId);
    }
    const tasksByState = { open: 0, ready: 0, running: 0, blocked: 0, resolved: 0, cancelled: 0 };
    for (const event of latestTasks.values()) tasksByState[event.payload.task.state]++;

    let uncertainNeverBlockers = 0;
    for (const logicalOperationId of Object.keys(reduced.operations)) {
      if (recoveryDecisionFor(reduced, logicalOperationId).kind === "block-never") uncertainNeverBlockers++;
    }
    const retry = recoverRetryState(events);
    const pending = Object.values(retry.schedules).filter((schedule) => schedule.status === "pending");
    const earliestNotBeforeAt = pending.length === 0
      ? null
      : pending.map((schedule) => schedule.notBeforeAt).sort()[0]!;

    result = Object.freeze({
      runId: inspected.runId,
      state: reduced.runState,
      tasksByState: Object.freeze(tasksByState),
      taskTotal: latestTasks.size,
      attemptTotal: attempts.size,
      pendingSafeReadSchedules: pending.length,
      earliestNotBeforeAt,
      uncertainNeverBlockers,
      pendingTransactions: transactions.pendingCount,
      unmaterializedResults: transactions.unmaterializedResultCount,
      committedTransactions: transactions.committedCount,
      executionEpoch: reduced.currentEpoch,
      integrity: "verified",
    });
  } catch (error) {
    failure = error;
  }
  try { await inspected.close(); }
  catch { failure ??= new FoundationStatusReadError(); }
  if (failure) throw failure;
  return result!;
}
