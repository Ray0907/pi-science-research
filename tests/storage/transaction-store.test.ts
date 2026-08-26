import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import type { FoundationEventPayload, FoundationEventType, FoundationLedgerEvent } from "../../src/domain/events.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import {
  commitTransaction,
  listCommittedTransactions,
  prepareTransaction,
  reconcileCanonicalTransactions,
  reconstructCanonicalRecords,
  TransactionStoreError,
  verifyTransaction,
  type CanonicalTransactionInput,
  type TransactionProtocolStep,
} from "../../src/storage/transaction-store.js";

const AT = "2026-08-25T12:00:00.000Z";
const RUN = "run-0000000000000001";
const TASK = "task-0000000000000001";
const ATTEMPT = "attempt-0000000000000001";
const TX = "tx-0000000000000001";
const HASH = "a".repeat(64);
const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-research-transactions-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function request(id = "request-0000000000000001") {
  return {
    schemaVersion: 1,
    requestId: id,
    attemptId: ATTEMPT,
    executionEpoch: 0,
    logicalRequestId: "logical-request",
    physicalAttemptOrdinal: 1,
    retryOfRequestId: null,
    replayPolicy: "safe-read",
    provider: "openalex",
    operation: "search",
    normalizedInput: { query: "query", identifier: null, url: null, parameters: [] },
    accessPolicySha256: HASH,
    startedAt: AT,
    endedAt: AT,
    status: "success",
    httpStatus: 200,
    requestedUrl: "https://api.openalex.org/works",
    finalUrl: "https://api.openalex.org/works",
    redirectUrls: [],
    responseSha256: HASH,
    responseFile: { relativePath: "payloads/a", mediaType: "application/json", decodedBytes: 2, sha256: HASH },
    encodedBytes: 2,
    decodedBytes: 2,
    resultSourceIds: ["src-openalex.w1"],
    errorClass: null,
  } as const;
}

function input(overrides: Partial<CanonicalTransactionInput> = {}): CanonicalTransactionInput {
  return {
    schemaVersion: 1,
    transactionId: TX,
    runId: RUN,
    attemptId: ATTEMPT,
    sourceResultSeq: 7,
    createdAt: AT,
    sources: [
      { schemaVersion: 1, sourceId: "src-openalex.w2", revision: 2, title: "B" },
      { schemaVersion: 1, sourceId: "src-openalex.w1", revision: 1, title: "A" },
    ],
    claims: [{ schemaVersion: 1, claimId: "claim-0000000000000001", revision: 1, statement: "claim" }],
    evidence: [{ schemaVersion: 1, evidenceId: "ev-0000000000000001", revision: 1, quote: "evidence" }],
    verifications: [{ schemaVersion: 1, verificationId: "verify-0000000000000001", revision: 1, result: "accepted" }],
    requests: [request()],
    calculations: [{ schemaVersion: 1, calculationId: "calc-0000000000000001", status: "success" }],
    ...overrides,
  };
}

async function committed(runRoot: string, value = input()) {
  const prepared = await prepareTransaction(runRoot, value);
  return commitTransaction(runRoot, value.transactionId);
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: "TransactionStoreError", code });
}

describe("canonical transaction store", () => {
  test("writes six exact sorted JSONL files, hashes exact bytes, and writes manifest last", async () => {
    const runRoot = await root();
    const steps: TransactionProtocolStep[] = [];
    const prepared = await prepareTransaction(runRoot, input(), { onStep: async (step) => { steps.push(step); } });

    expect(prepared.manifest.files.map((file) => file.kind)).toEqual([
      "sources", "claims", "evidence", "verifications", "requests", "calculations",
    ]);
    const sourcePath = join(runRoot, ".state/transactions/.staging", TX, "sources.jsonl");
    const sourceBytes = await readFile(sourcePath, "utf8");
    expect(sourceBytes).toBe([
      canonicalJson({ schemaVersion: 1, sourceId: "src-openalex.w1", revision: 1, title: "A" }),
      canonicalJson({ schemaVersion: 1, sourceId: "src-openalex.w2", revision: 2, title: "B" }),
      "",
    ].join("\n"));
    expect(prepared.manifest.files[0]).toMatchObject({
      relativePath: "sources.jsonl",
      recordCount: 2,
      decodedBytes: Buffer.byteLength(sourceBytes),
      sha256: sha256Hex(sourceBytes),
    });
    expect(steps.at(-1)).toBe("manifest-directory-synced");
    expect(steps.slice(-2)).toEqual(["manifest-synced", "manifest-directory-synced"]);
    const manifestBytes = await readFile(join(runRoot, ".state/transactions/.staging", TX, "manifest.json"), "utf8");
    expect(manifestBytes).toBe(`${canonicalJson(prepared.manifest)}\n`);
    expect(prepared.manifestSha256).toBe(sha256Hex(manifestBytes));
  });

  test("represents every empty record kind as an exact empty file", async () => {
    const runRoot = await root();
    const empty = input({ sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] });
    const prepared = await prepareTransaction(runRoot, empty);
    expect(prepared.manifest.files).toHaveLength(6);
    for (const file of prepared.manifest.files) {
      expect(file).toMatchObject({ recordCount: 0, decodedBytes: 0, sha256: sha256Hex("") });
      expect(await readFile(join(runRoot, ".state/transactions/.staging", TX, file.relativePath))).toHaveLength(0);
    }
  });

  test("publishes by directory rename and verifies immutable committed bytes", async () => {
    const runRoot = await root();
    const prepared = await prepareTransaction(runRoot, input());
    const ref = await commitTransaction(runRoot, TX);
    expect(ref).toEqual({
      transactionId: TX,
      relativePath: `.state/transactions/committed/${TX}/manifest.json`,
      sha256: prepared.manifestSha256,
    });
    await expect(lstat(join(runRoot, ".state/transactions/.staging", TX))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyTransaction(runRoot, ref)).resolves.toMatchObject({ manifest: prepared.manifest });
  });

  test("makes duplicate matching commit harmless and different content corruption", async () => {
    const runRoot = await root();
    const first = await committed(runRoot);
    const before = await readFile(join(runRoot, first.relativePath));
    await expect(commitTransaction(runRoot, TX)).resolves.toEqual(first);
    expect(await readFile(join(runRoot, first.relativePath))).toEqual(before);
    await expectCode(prepareTransaction(runRoot, input({ claims: [{ schemaVersion: 1, claimId: "claim-0000000000000001", revision: 1, statement: "changed" }] })), "transaction.id-conflict");
  });

  test("serializes concurrent matching prepare/commit and fails closed for different input", async () => {
    const runRoot = await root();
    const [one, two] = await Promise.all([prepareTransaction(runRoot, input()), prepareTransaction(runRoot, input())]);
    expect(one.manifestSha256).toBe(two.manifestSha256);
    const [commitOne, commitTwo] = await Promise.all([commitTransaction(runRoot, TX), commitTransaction(runRoot, TX)]);
    expect(commitOne).toEqual(commitTwo);

    const otherRoot = await root();
    const changed = input({ claims: [{ schemaVersion: 1, claimId: "claim-0000000000000001", revision: 1, statement: "changed" }] });
    const results = await Promise.allSettled([prepareTransaction(otherRoot, input()), prepareTransaction(otherRoot, changed)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("snapshots caller input before the first await and keeps durable bytes immutable", async () => {
    const runRoot = await root();
    const value = input();
    const preparing = prepareTransaction(runRoot, value);
    (value.claims[0] as Record<string, unknown>).statement = "mutated-after-call";
    await preparing;
    const line = await readFile(join(runRoot, ".state/transactions/.staging", TX, "claims.jsonl"), "utf8");
    expect(line).toContain('"statement":"claim"');
    expect(line).not.toContain("mutated-after-call");
  });

  test("rejects duplicate identities, cross-kind keys, proxies, malformed requests, and bounded-size overflow", async () => {
    const runRoot = await root();
    await expectCode(prepareTransaction(runRoot, input({ sources: [
      { schemaVersion: 1, sourceId: "src-openalex.w1", revision: 1 },
      { schemaVersion: 1, sourceId: "src-openalex.w1", revision: 1 },
    ] })), "transaction.duplicate-record");
    await expectCode(prepareTransaction(runRoot, input({ sources: [
      { schemaVersion: 1, sourceId: "src-openalex.w1", revision: 1 },
      { schemaVersion: 1, sourceId: "src-openalex.w1", revision: 2 },
    ] })), "transaction.duplicate-record");
    await expectCode(prepareTransaction(runRoot, input({ sources: [{ schemaVersion: 1, sourceId: "src-openalex.w1", claimId: "claim-0000000000000001", revision: 1 }] })), "transaction.cross-kind-id");
    await expectCode(prepareTransaction(runRoot, input({ claims: [{ claimId: "claim-0000000000000001", revision: 1 }] })), "transaction.invalid-record");
    await expectCode(prepareTransaction(runRoot, input({ claims: [new Proxy({ schemaVersion: 1, claimId: "claim-0000000000000001", revision: 1 }, {})] })), "transaction.invalid-input");
    const proxyArray = new Proxy(input().claims, { getPrototypeOf: () => { throw new Error("secret-array-trap"); } });
    const proxyFailure = prepareTransaction(runRoot, input({ claims: proxyArray }));
    await expectCode(proxyFailure, "transaction.invalid-input");
    await expect(proxyFailure.catch((error: Error) => error.message)).resolves.not.toContain("secret-array-trap");
    await expectCode(prepareTransaction(runRoot, input({ requests: [{ ...request(), status: "invented" } as never] })), "transaction.invalid-record");
    await expectCode(prepareTransaction(runRoot, input(), { maxFileBytes: 8 }), "transaction.file-too-large");
  });

  test("leaves every pre-rename crash prefix in staging and makes post-rename prefixes verifiable", async () => {
    const prepareSteps: TransactionProtocolStep[] = [
      "sources-synced", "claims-synced", "evidence-synced", "verifications-synced", "requests-synced",
      "calculations-synced", "records-directory-synced", "manifest-synced", "manifest-directory-synced",
    ];
    for (const failAt of prepareSteps) {
      const runRoot = await root();
      const options = { onStep: async (step: TransactionProtocolStep) => { if (step === failAt) throw new Error("crash-secret-value"); } };
      await expectCode(prepareTransaction(runRoot, input(), options), "transaction.io-failed");
      await expect(lstat(join(runRoot, ".state/transactions/committed", TX))).rejects.toMatchObject({ code: "ENOENT" });
    }

    for (const failAt of ["before-rename", "renamed", "staging-parent-synced", "committed-parent-synced"] as const) {
      const runRoot = await root();
      const prepared = await prepareTransaction(runRoot, input());
      const options = { onStep: async (step: TransactionProtocolStep) => { if (step === failAt) throw new Error("crash-secret-value"); } };
      await expectCode(commitTransaction(runRoot, TX, options), "transaction.io-failed");
      const committedPath = join(runRoot, ".state/transactions/committed", TX);
      if (failAt === "before-rename") {
        await expect(lstat(committedPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(verifyTransaction(runRoot, {
          transactionId: TX,
          relativePath: `.state/transactions/committed/${TX}/manifest.json`,
          sha256: prepared.manifestSha256,
        })).resolves.toMatchObject({ manifestSha256: prepared.manifestSha256 });
      }
    }

    const renameRoot = await root();
    await prepareTransaction(renameRoot, input());
    await expectCode(commitTransaction(renameRoot, TX, { rename: async () => { throw new Error("rename-secret"); } }), "transaction.io-failed");
    await expect(lstat(join(renameRoot, ".state/transactions/committed", TX))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed at every injected fsync boundary without leaking secret errors", async () => {
    for (const failAt of [
      "sources-synced", "claims-synced", "evidence-synced", "verifications-synced", "requests-synced",
      "calculations-synced", "records-directory-synced", "manifest-synced", "manifest-directory-synced",
    ] as const) {
      const runRoot = await root();
      const failure = prepareTransaction(runRoot, input(), {
        durability: async (_handle, step) => { if (step === failAt) throw new Error("fsync-secret"); },
      });
      await expectCode(failure, "transaction.io-failed");
      await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain("fsync-secret");
    }
  });

  test("closes descriptors after an injected close failure and reports a secret-safe error", async () => {
    const runRoot = await root();
    const handles: FileHandle[] = [];
    const failure = prepareTransaction(runRoot, input(), {
      close: async (handle) => { handles.push(handle); throw new Error("close-secret"); },
    });
    await expectCode(failure, "transaction.io-failed");
    await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain("close-secret");
    expect(handles).toHaveLength(1);
    await expect(handles[0]!.stat()).rejects.toBeDefined();
  });

  test("rejects symlink and hardlink substitution, tampered bytes, hashes, counts, and refs", async () => {
    const cases: ((runRoot: string, ref: Awaited<ReturnType<typeof committed>>) => Promise<void>)[] = [
      async (runRoot, ref) => { await writeFile(join(runRoot, ref.relativePath, "..", "sources.jsonl"), "{}\n"); },
      async (runRoot, ref) => {
        const manifestPath = join(runRoot, ref.relativePath);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.files[0].recordCount += 1;
        await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
      },
      async (runRoot, ref) => {
        const manifestPath = join(runRoot, ref.relativePath);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.sourceRefs = [];
        await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
      },
    ];
    for (const mutate of cases) {
      const runRoot = await root();
      const ref = await committed(runRoot);
      await mutate(runRoot, ref);
      await expectCode(verifyTransaction(runRoot, ref), "transaction.corrupt");
    }

    const symlinkRoot = await root();
    const symlinkRef = await committed(symlinkRoot);
    const sourcePath = join(symlinkRoot, symlinkRef.relativePath, "..", "sources.jsonl");
    await rm(sourcePath);
    await symlink("/dev/null", sourcePath);
    await expectCode(verifyTransaction(symlinkRoot, symlinkRef), "transaction.unsafe-file");

    const hardlinkRoot = await root();
    const hardlinkRef = await committed(hardlinkRoot);
    const claimPath = join(hardlinkRoot, hardlinkRef.relativePath, "..", "claims.jsonl");
    const outside = join(hardlinkRoot, "outside");
    await link(claimPath, outside);
    await expectCode(verifyTransaction(hardlinkRoot, hardlinkRef), "transaction.unsafe-file");
  });

  test("lists verified committed manifests in deterministic order and rejects suspicious entries", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const second = input({ transactionId: "tx-0000000000000002", sourceResultSeq: 8 });
    await committed(runRoot, second);
    expect((await listCommittedTransactions(runRoot)).map((item) => item.manifest.transactionId)).toEqual([TX, second.transactionId]);
    await writeFile(join(runRoot, ".state/transactions/committed", "unexpected"), "x");
    await expectCode(listCommittedTransactions(runRoot), "transaction.suspicious-entry");
  });

  test("reconciles committed object without records event and reconstructs only from ledger plus objects", async () => {
    const runRoot = await root();
    const ref = await committed(runRoot);
    const base = baseEvents();
    expect(await reconcileCanonicalTransactions(runRoot, base)).toEqual([{ kind: "finish-transaction", transactionId: TX }]);

    const committedEvents = [...base, event("records_committed", {
      transactionId: TX,
      sourceResultSeq: 7,
      transactionManifestPath: ref.relativePath,
      transactionManifestSha256: ref.sha256,
      sourceRefs: [...input().sources].sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId))).map(({ sourceId, revision }) => ({ sourceId, revision })),
      claimRefs: [{ claimId: "claim-0000000000000001", revision: 1 }],
      evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }],
      verificationRefs: [{ verificationId: "verify-0000000000000001", revision: 1 }],
      requestIds: ["request-0000000000000001"],
      calculationIds: ["calc-0000000000000001"],
    }), event("attempt_committed", { attemptId: ATTEMPT, transactionId: TX, taskId: TASK, sourceResultSeq: 7 })];
    const rebuilt = await reconstructCanonicalRecords(runRoot, committedEvents);
    expect(rebuilt.sources.map((record) => record.sourceId)).toEqual(["src-openalex.w1", "src-openalex.w2"]);
    expect(rebuilt.claims).toEqual(input().claims);
  });

  test("rejects an orphan committed object that has no result_recorded identity", async () => {
    const runRoot = await root();
    await committed(runRoot);
    eventSeq = 1;
    const events = [event("run_created", { run: runSnapshot() })];
    await expectCode(reconcileCanonicalTransactions(runRoot, events), "transaction.corrupt");
  });

  test("fails closed when ledger commit has no hash-matching object or attempt commit lacks records commit", async () => {
    const runRoot = await root();
    const base = baseEvents();
    const badRecords = event("records_committed", {
      transactionId: TX,
      sourceResultSeq: 7,
      transactionManifestPath: `.state/transactions/committed/${TX}/manifest.json`,
      transactionManifestSha256: HASH,
      sourceRefs: [], claimRefs: [], evidenceRefs: [], verificationRefs: [], requestIds: [], calculationIds: [],
    });
    await expectCode(reconcileCanonicalTransactions(runRoot, [...base, badRecords]), "transaction.missing-object");
    const badAttempt = event("attempt_committed", { attemptId: ATTEMPT, transactionId: TX, taskId: TASK, sourceResultSeq: 7 });
    await expect(reconcileCanonicalTransactions(runRoot, [...base, badAttempt])).rejects.toMatchObject({ name: "LedgerReducerCorruptionError" });
  });
});

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
function attempt(): AttemptRecord {
  return { schemaVersion: 1, attemptId: ATTEMPT, revision: 1, runId: RUN, taskId: TASK, executionEpoch: 0, logicalOperationId: "op", attemptOrdinal: 1, retryOfAttemptId: null, attemptKind: "research", replayPolicy: "safe-read", state: "intent-recorded", providerModel: "p/m", thinkingLevel: "medium", promptTemplateSha256: HASH, renderedPromptSha256: "b".repeat(64), logicalInputSha256: "c".repeat(64), attemptEnvelopeSha256: "d".repeat(64), toolAllowlist: [], deadlineAt: AT, capabilityId: "cap", resultSha256: null, billingStatus: "unknown", reportedUsage: null, error: null, createdAt: AT, updatedAt: AT };
}
function event<T extends FoundationEventType>(type: T, payload: FoundationEventPayload<T>): FoundationLedgerEvent {
  const seq = eventSeq++;
  return { schemaVersion: 1, seq, occurredAt: AT, eventId: `event-${seq}`, type, payload, prevSha256: "0".repeat(64), entrySha256: HASH } as FoundationLedgerEvent;
}
let eventSeq = 1;
function baseEvents(): FoundationLedgerEvent[] {
  eventSeq = 1;
  return [
    event("run_created", { run: runSnapshot() }),
    event("task_upserted", { task: task() }),
    event("identity_reserved", { kind: "attempt", id: ATTEMPT, origin: "parent-generated" }),
    event("identity_reserved", { kind: "transaction", id: TX, origin: "parent-generated" }),
    event("dispatch_intent", { attempt: attempt() }),
    event("dispatch_started", { attemptId: ATTEMPT, pid: null, requestCorrelation: null }),
    event("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX }),
  ];
}
