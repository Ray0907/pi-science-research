import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { hashLedgerEvent } from "../../src/crypto/hash.js";
import {
  EventLedgerError,
  FOUNDATION_EVENT_TYPES,
  openEventLedger,
  type DurabilityReason,
  type EventLedger,
} from "../../src/storage/event-ledger.js";

const TIMESTAMP = "2026-08-25T12:00:00.000Z";
const ZERO_HASH = "0".repeat(64);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ids = {
  attempt: "attempt-0000000000000001",
  request: "request-0000000000000001",
  request2: "request-0000000000000002",
  retry: "retry-0000000000000001",
  transaction: "tx-0000000000000001",
  revision: "rev-20260825T120000000Z-000000000001",
} as const;

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ledgerPath(name = "events.jsonl"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-research-ledger-"));
  roots.push(root);
  return join(root, name);
}

function deterministicOptions(extra: Record<string, unknown> = {}) {
  let ordinal = 0;
  return {
    now: () => new Date(TIMESTAMP),
    eventId: () => `event-${String(++ordinal).padStart(4, "0")}`,
    ...extra,
  };
}

async function expectLedgerCode(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ name: "EventLedgerError", code });
}

describe("append-only event ledger", () => {
  test("starts at sequence 1, frames canonical JSON with LF, and hashes from zero", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());

    const event = await ledger.reserveIdentity("attempt", ids.attempt, "parent-generated");
    await ledger.close();

    expect(event.seq).toBe(1);
    expect(event.prevSha256).toBe(ZERO_HASH);
    expect(event.entrySha256).toBe(hashLedgerEvent(event));
    const bytes = await readFile(path, "utf8");
    expect(bytes).toBe(`${canonicalJson(event)}\n`);
  });

  test("increments exactly once, chains hashes, and verifies after reopen", async () => {
    const path = await ledgerPath();
    const first = await openEventLedger(path, deterministicOptions());
    const one = await first.reserveIdentity("attempt", ids.attempt, "parent-generated");
    const two = await first.reserveIdentity("request", ids.request, "child-import");
    await first.close();

    expect(two.seq).toBe(2);
    expect(two.prevSha256).toBe(one.entrySha256);

    const reopened = await openEventLedger(path, deterministicOptions());
    await expect(reopened.verify()).resolves.toBeUndefined();
    expect((await reopened.readAll()).map((event) => event.seq)).toEqual([1, 2]);
    await reopened.close();
  });

  test("does not resolve an append before the durability hook", async () => {
    const path = await ledgerPath();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reasons: DurabilityReason[] = [];
    const ledger = await openEventLedger(path, deterministicOptions({
      durability: async (_handle: unknown, reason: DurabilityReason) => {
        reasons.push(reason);
        await waiting;
      },
    }));

    let settled = false;
    const append = ledger.reserveIdentity("attempt", ids.attempt, "parent-generated").finally(() => { settled = true; });
    await vi.waitFor(() => expect(reasons).toEqual(["append"]));
    expect(settled).toBe(false);
    release();
    await append;
    expect(settled).toBe(true);
    await ledger.close();
  });

  test("serializes concurrent appends deterministically", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());

    const events = await Promise.all([
      ledger.reserveIdentity("attempt", ids.attempt, "parent-generated"),
      ledger.reserveIdentity("request", ids.request, "parent-generated"),
      ledger.reserveIdentity("retry-schedule", ids.retry, "parent-generated"),
      ledger.reserveIdentity("transaction", ids.transaction, "parent-generated"),
      ledger.reserveIdentity("revision", ids.revision, "parent-generated"),
    ]);

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.slice(1).map((event) => event.prevSha256)).toEqual(events.slice(0, -1).map((event) => event.entrySha256));
    await ledger.close();
  });

  test("reserves all durable identity kinds and both origins with matching prefixes", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    const cases = [
      ["attempt", ids.attempt, "parent-generated"],
      ["request", ids.request, "child-import"],
      ["retry-schedule", ids.retry, "parent-generated"],
      ["transaction", ids.transaction, "child-import"],
      ["revision", ids.revision, "parent-generated"],
    ] as const;

    for (const [kind, id, origin] of cases) {
      const event = await ledger.reserveIdentity(kind, id, origin);
      expect(event.payload).toEqual({ kind, id, origin });
    }
    await expectLedgerCode(ledger.reserveIdentity("attempt", ids.request, "parent-generated"), "identity.kind-mismatch");
    await expectLedgerCode(ledger.reserveIdentity("attempt", ids.attempt, "invalid" as never), "event.schema-invalid");
    await ledger.close();
  });

  test("requires reservation before identity-bearing lifecycle events and permits later references", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    const payload = {
      revisionId: ids.revision,
      sourceLedgerSeq: 1,
      completionCommitId: "completion-1",
    };

    await expectLedgerCode(ledger.append("revision_prepared", payload), "identity.not-reserved");
    await ledger.reserveIdentity("revision", ids.revision, "parent-generated");
    await expect(ledger.append("revision_prepared", payload)).resolves.toMatchObject({ type: "revision_prepared" });
    await expect(ledger.append("revision_failed", {
      revisionId: ids.revision,
      completionCommitId: "completion-1",
      errorClass: "storage",
      message: "failed",
    })).resolves.toMatchObject({ type: "revision_failed" });
    await ledger.close();
  });

  test("keeps rejected-import reservations durable across reopen and scratch deletion", async () => {
    const path = await ledgerPath();
    const scratch = join(path, "..", "scratch-result.json");
    await writeFile(scratch, "untrusted");
    const ledger = await openEventLedger(path, deterministicOptions());
    await ledger.reserveIdentity("request", ids.request, "child-import");
    await ledger.reserveIdentity("attempt", ids.attempt, "child-import");
    await ledger.close();
    await rm(scratch);

    const reopened = await openEventLedger(path, {
      now: () => new Date(TIMESTAMP),
      eventId: () => "reopened-event",
    });
    await expectLedgerCode(reopened.reserveIdentity("request", ids.request, "child-import"), "identity.already-reserved");
    const lifecycle = await reopened.append("attempt_failed", {
      attemptId: ids.attempt,
      state: "terminal-failed",
      errorClass: "import-rejected",
      message: "Rejected imported payload",
    });
    expect(lifecycle.type).toBe("attempt_failed");
    await reopened.close();
  });

  test("rejects duplicate event IDs across reopen without poisoning the append queue", async () => {
    const path = await ledgerPath();
    const first = await openEventLedger(path, { now: () => new Date(TIMESTAMP), eventId: () => "same-event" });
    await first.reserveIdentity("attempt", ids.attempt, "parent-generated");
    await first.close();

    const generated = ["same-event", "new-event"];
    const reopened = await openEventLedger(path, {
      now: () => new Date(TIMESTAMP),
      eventId: () => generated.shift() ?? "fallback-event",
    });
    await expectLedgerCode(reopened.reserveIdentity("request", ids.request, "parent-generated"), "event.duplicate-id");
    const accepted = await reopened.reserveIdentity("request", ids.request, "parent-generated");
    expect(accepted.eventId).toBe("new-event");
    expect(accepted.seq).toBe(2);
    await reopened.close();
  });

  test("rejects unknown event types, root fields, and payload fields without leaking values", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    const secret = "SECRET-API-TOKEN";

    for (const invalid of [
      ledger.append("unknown" as never, { secret } as never),
      ledger.append("identity_reserved", { kind: "attempt", id: ids.attempt, origin: "parent-generated", secret } as never),
    ]) {
      try {
        await invalid;
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(EventLedgerError);
        expect(String(error)).not.toContain(secret);
      }
    }

    const accepted = await ledger.reserveIdentity("attempt", ids.attempt, "parent-generated");
    const rootExtra = { ...accepted, secret };
    await ledger.close();
    await writeFile(path, `${canonicalJson(rootExtra)}\n`);
    await expect(openEventLedger(path, deterministicOptions())).rejects.toMatchObject({ code: "ledger.schema-invalid" });
  });

  test("recovers a torn final non-LF tail and fsyncs truncation", async () => {
    const path = await ledgerPath();
    const first = await openEventLedger(path, deterministicOptions());
    await first.reserveIdentity("attempt", ids.attempt, "parent-generated");
    await first.close();
    const committedSize = (await readFile(path)).byteLength;
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('{"partial":"tail"') ]));

    const reasons: DurabilityReason[] = [];
    const reopened = await openEventLedger(path, deterministicOptions({
      durability: async (handle: { sync(): Promise<void> }, reason: DurabilityReason) => {
        reasons.push(reason);
        await handle.sync();
      },
    }));
    expect(reasons).toContain("truncate");
    expect((await readFile(path)).byteLength).toBe(committedSize);
    expect((await reopened.readAll())).toHaveLength(1);
    await reopened.close();
  });

  test("fails closed for malformed interior JSON, invalid hashes, and schema-invalid complete lines", async () => {
    const path = await ledgerPath();
    const first = await openEventLedger(path, deterministicOptions());
    const event = await first.reserveIdentity("attempt", ids.attempt, "parent-generated");
    await first.close();
    const valid = `${canonicalJson(event)}\n`;

    for (const [bytes, code] of [
      [`${valid}{broken}\n${valid}`, "ledger.invalid-json"],
      [`${canonicalJson({ ...event, entrySha256: "f".repeat(64) })}\n{}\n`, "ledger.hash-mismatch"],
      [`${canonicalJson({ ...event, payload: { kind: "attempt" } })}\n{}\n`, "ledger.schema-invalid"],
    ] as const) {
      await writeFile(path, bytes);
      await expect(openEventLedger(path, deterministicOptions())).rejects.toMatchObject({ code });
    }
  });

  test("rejects empty interior lines and over-limit complete lines before parsing", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    const event = await ledger.reserveIdentity("attempt", ids.attempt, "parent-generated");
    await ledger.close();
    const valid = `${canonicalJson(event)}\n`;
    await writeFile(path, `${valid}\n${valid}`);
    await expect(openEventLedger(path, deterministicOptions())).rejects.toMatchObject({ code: "ledger.empty-line" });

    await writeFile(path, `${"x".repeat(65)}\n`);
    await expect(openEventLedger(path, deterministicOptions({ maxLineBytes: 64 }))).rejects.toMatchObject({ code: "ledger.line-too-large" });
  });

  test("close drains appends that were already accepted into the queue", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    const append = ledger.reserveIdentity("attempt", ids.attempt, "parent-generated");
    const closing = ledger.close();

    await expect(append).resolves.toMatchObject({ seq: 1 });
    await expect(closing).resolves.toBeUndefined();
    const reopened = await openEventLedger(path, deterministicOptions());
    expect(await reopened.readAll()).toHaveLength(1);
    await reopened.close();
  });

  test("rejects writes after close and prevents concurrent opens in one process", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    await expect(openEventLedger(path, deterministicOptions())).rejects.toMatchObject({ code: "ledger.already-open" });
    await ledger.close();
    await expectLedgerCode(ledger.reserveIdentity("attempt", ids.attempt, "parent-generated"), "ledger.closed");

    const reopened = await openEventLedger(path, deterministicOptions());
    await reopened.close();
  });

  test("rejects concurrent opens through hard links and symlinked parent aliases, then releases physical identity", async () => {
    const path = await ledgerPath();
    const root = dirname(path);
    const hardLinkPath = join(root, "hard-link.jsonl");
    const parentAlias = join(root, "parent-alias");
    const parentAliasPath = join(parentAlias, "events.jsonl");
    const first = await openEventLedger(path, deterministicOptions());
    await link(path, hardLinkPath);
    await symlink(root, parentAlias, "dir");

    await expect(openEventLedger(hardLinkPath, deterministicOptions())).rejects.toMatchObject({ code: "ledger.already-open" });
    await expect(openEventLedger(parentAliasPath, deterministicOptions())).rejects.toMatchObject({ code: "ledger.already-open" });
    await first.close();

    const hardReopen = await openEventLedger(hardLinkPath, deterministicOptions());
    await hardReopen.close();
    const parentAliasReopen = await openEventLedger(parentAliasPath, deterministicOptions());
    await parentAliasReopen.close();
  });

  test("does not follow a symlink ledger leaf", async () => {
    const path = await ledgerPath();
    const target = join(path, "..", "target.jsonl");
    await writeFile(target, "");
    await symlink(target, path);
    await expect(openEventLedger(path, deterministicOptions())).rejects.toMatchObject({ code: "ledger.symlink" });
  });

  test("returns copies that cannot mutate internal state", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    await ledger.reserveIdentity("attempt", ids.attempt, "parent-generated");
    const firstRead = await ledger.readAll();
    (firstRead[0] as { seq: number }).seq = 999;
    ((firstRead[0] as { payload: { id: string } }).payload).id = ids.request;
    const secondRead = await ledger.readAll();
    expect(secondRead[0]?.seq).toBe(1);
    expect((secondRead[0]?.payload as { id: string }).id).toBe(ids.attempt);
    await ledger.close();
  });

  test("snapshots nested append input before queue and durability awaits", async () => {
    const path = await ledgerPath();
    const seed = await openEventLedger(path, deterministicOptions());
    await seed.reserveIdentity("attempt", ids.attempt, "parent-generated");
    await seed.reserveIdentity("request", ids.request, "parent-generated");
    await seed.close();

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let durabilityReached = false;
    const ledger = await openEventLedger(path, {
      now: () => new Date(TIMESTAMP),
      eventId: () => "snapshot-event",
      durability: async () => {
        durabilityReached = true;
        await waiting;
      },
    });
    const payload = requestIntentEventPayload();
    const original = structuredClone(payload);
    const append = ledger.append("request_intent_recorded", payload);
    payload.intent.normalizedInput.query = "mutated-before-queue";
    await vi.waitFor(() => expect(durabilityReached).toBe(true));
    payload.intent.normalizedInput.parameters[0]!.value = "mutated-during-durability";
    payload.intent.normalizedInput.parameters.push({ name: "secret", value: "changed" });

    release();
    const returned = await append;
    expect(returned.payload).toEqual(original);
    const readBack = await ledger.readAll();
    expect(readBack.at(-1)?.payload).toEqual(original);
    await expect(ledger.verify()).resolves.toBeUndefined();
    await ledger.close();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(lines.at(-1)!).payload).toEqual(original);
    const reopened = await openEventLedger(path, deterministicOptions());
    expect((await reopened.readAll()).at(-1)?.payload).toEqual(original);
    await reopened.close();
  });

  test("appends and reopens all closed canonical request events", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    await reserveRequestEventIdentities(ledger);

    await ledger.append("request_intent_recorded", requestIntentEventPayload());
    await ledger.append("request_result_recorded", requestResultEventPayload());
    await ledger.append("request_retry_scheduled", requestRetryScheduledPayload());
    await ledger.append("request_retry_started", requestRetryStartedPayload());
    await ledger.close();

    const reopened = await openEventLedger(path, deterministicOptions({ eventId: () => "reopen-unused" }));
    const requestEvents = (await reopened.readAll()).slice(-4);
    expect(requestEvents.map((event) => event.type)).toEqual([
      "request_intent_recorded",
      "request_result_recorded",
      "request_retry_scheduled",
      "request_retry_started",
    ]);
    expect(requestEvents[1]?.type === "request_result_recorded" && requestEvents[1].payload.request.responseFile).toEqual({
      relativePath: "request-payloads/response.json",
      mediaType: "application/json",
      decodedBytes: 128,
      sha256: SHA_B,
    });
    await reopened.close();
  });

  test("rejects unknown, missing, and nested-extra properties for every request event", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    await reserveRequestEventIdentities(ledger);
    const cases = [
      ["request_intent_recorded", requestIntentEventPayload(), "journalLocalSeq"],
      ["request_result_recorded", requestResultEventPayload(), "intentLedgerSeq"],
      ["request_retry_scheduled", requestRetryScheduledPayload(), "delayMs"],
      ["request_retry_started", requestRetryStartedPayload(), "scheduledFromLedgerSeq"],
    ] as const;

    for (const [type, valid, required] of cases) {
      await expectLedgerCode(ledger.append(type, { ...valid, unknown: "SECRET" } as never), "event.schema-invalid");
      const missing = structuredClone(valid) as Record<string, unknown>;
      delete missing[required];
      await expectLedgerCode(ledger.append(type, missing as never), "event.schema-invalid");
    }

    const intentNested = requestIntentEventPayload();
    (intentNested.intent.normalizedInput.parameters[0] as { name: string; value: string; extra?: boolean }).extra = true;
    await expectLedgerCode(ledger.append("request_intent_recorded", intentNested), "event.schema-invalid");
    const resultNested = requestResultEventPayload();
    (resultNested.request.responseFile as { extra?: boolean }).extra = true;
    await expectLedgerCode(ledger.append("request_result_recorded", resultNested), "event.schema-invalid");
    await ledger.close();
  });

  test("rejects invalid request timestamps, numeric values, and response paths", async () => {
    const path = await ledgerPath();
    const ledger = await openEventLedger(path, deterministicOptions());
    await reserveRequestEventIdentities(ledger);

    const invalidTime = requestIntentEventPayload();
    invalidTime.intent.deadlineAt = "2026-02-30T00:00:00.000Z";
    await expectLedgerCode(ledger.append("request_intent_recorded", invalidTime), "event.schema-invalid");
    const invalidBytes = requestResultEventPayload();
    invalidBytes.request.decodedBytes = -1;
    await expectLedgerCode(ledger.append("request_result_recorded", invalidBytes), "event.schema-invalid");
    const invalidPath = requestResultEventPayload();
    invalidPath.request.responseFile!.relativePath = "../secret";
    await expectLedgerCode(ledger.append("request_result_recorded", invalidPath), "event.schema-invalid");
    const invalidDelay = requestRetryScheduledPayload();
    invalidDelay.delayMs = Number.POSITIVE_INFINITY;
    await expectLedgerCode(ledger.append("request_retry_scheduled", invalidDelay), "event.schema-invalid");
    await ledger.close();
  });

  test("exports the exact closed foundation event type set", () => {
    expect(FONDATION_SORTED()).toEqual([
      "active_time_checkpoint", "attempt_committed", "attempt_failed", "attempt_usage_recorded",
      "budget_amended", "cancel_requested", "dispatch_intent", "dispatch_started", "identity_reserved",
      "lock_recovered", "records_committed", "request_intent_recorded", "request_result_recorded",
      "request_retry_scheduled", "request_retry_started", "result_recorded", "resume_epoch_started", "retry_scheduled",
      "retry_started", "revision_committed", "revision_failed", "revision_prepared", "run_completed",
      "run_created", "state_changed", "task_upserted",
    ]);
  });
});

function FONDATION_SORTED(): string[] {
  return [...FOUNDATION_EVENT_TYPES].sort();
}

function requestIntent() {
  return {
    schemaVersion: 1 as const,
    requestId: ids.request,
    attemptId: ids.attempt,
    executionEpoch: 0,
    logicalRequestId: "literature-search-1",
    physicalAttemptOrdinal: 1,
    retryOfRequestId: null,
    replayPolicy: "safe-read" as const,
    provider: "openalex" as const,
    operation: "search" as const,
    normalizedInput: {
      query: "durable ledgers",
      identifier: null,
      url: null,
      parameters: [{ name: "per-page", value: "25" }],
    },
    accessPolicySha256: SHA_A,
    deadlineAt: "2026-08-25T12:05:00.000Z",
    createdAt: TIMESTAMP,
  };
}

function requestRecord() {
  return {
    schemaVersion: 1 as const,
    requestId: ids.request,
    attemptId: ids.attempt,
    executionEpoch: 0,
    logicalRequestId: "literature-search-1",
    physicalAttemptOrdinal: 1,
    retryOfRequestId: null,
    replayPolicy: "safe-read" as const,
    provider: "openalex" as const,
    operation: "search" as const,
    normalizedInput: {
      query: "durable ledgers",
      identifier: null,
      url: null,
      parameters: [{ name: "per-page", value: "25" }],
    },
    accessPolicySha256: SHA_A,
    startedAt: TIMESTAMP,
    endedAt: "2026-08-25T12:00:01.000Z",
    status: "success" as const,
    httpStatus: 200,
    requestedUrl: "https://api.openalex.org/works",
    finalUrl: "https://api.openalex.org/works",
    redirectUrls: [],
    responseSha256: SHA_B,
    responseFile: {
      relativePath: "request-payloads/response.json",
      mediaType: "application/json",
      decodedBytes: 128,
      sha256: SHA_B,
    },
    encodedBytes: 96,
    decodedBytes: 128,
    resultSourceIds: ["src-00000001"],
    errorClass: null,
  };
}

function requestIntentEventPayload() {
  return {
    attemptId: ids.attempt,
    journalLocalSeq: 1,
    journalEntrySha256: SHA_A,
    intent: requestIntent(),
  };
}

function requestResultEventPayload() {
  return {
    attemptId: ids.attempt,
    journalLocalSeq: 2,
    journalEntrySha256: SHA_B,
    intentLedgerSeq: 5,
    request: requestRecord(),
  };
}

function requestRetryScheduledPayload() {
  return {
    scheduleId: ids.retry,
    attemptId: ids.attempt,
    journalLocalSeq: 3,
    journalEntrySha256: SHA_A,
    logicalRequestId: "literature-search-1",
    failedRequestId: ids.request,
    nextPhysicalAttemptOrdinal: 2,
    notBeforeAt: "2026-08-25T12:00:02.000Z",
    delayMs: 1_000,
    reasonClass: "rate-limit",
  };
}

function requestRetryStartedPayload() {
  return {
    scheduleId: ids.retry,
    attemptId: ids.attempt,
    journalLocalSeq: 4,
    journalEntrySha256: SHA_B,
    logicalRequestId: "literature-search-1",
    requestId: ids.request2,
    physicalAttemptOrdinal: 2,
    scheduledFromLedgerSeq: 7,
  };
}

async function reserveRequestEventIdentities(ledger: EventLedger): Promise<void> {
  await ledger.reserveIdentity("attempt", ids.attempt, "parent-generated");
  await ledger.reserveIdentity("request", ids.request, "child-import");
  await ledger.reserveIdentity("request", ids.request2, "child-import");
  await ledger.reserveIdentity("retry-schedule", ids.retry, "child-import");
}
