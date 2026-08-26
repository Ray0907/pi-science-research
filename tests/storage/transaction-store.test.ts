import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import type { FoundationEventPayload, FoundationEventType, FoundationLedgerEvent } from "../../src/domain/events.js";
import type { AttemptRecord, RunSnapshot, TaskRecord } from "../../src/domain/records.js";
import {
  commitTransaction,
  inspectCanonicalTransactionsReadOnly,
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
const ATTEMPT_2 = "attempt-0000000000000002";
const TX = "tx-0000000000000001";
const RETRY = "retry-0000000000000001";
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

function source(id: string, revision: number, title: string) {
  return { schemaVersion: 1, sourceId: id, revision, identifiers: { doi: null, pmid: null, pmcid: null }, canonicalUrl: `https://example.org/${id}`, title,
    authors: [], containerTitle: null, publisher: null, volume: null, issue: null, pages: null, published: { date: null, precision: "unknown" },
    publicationType: "journal-article", peerReviewStatus: "unknown", accessLevel: "full-text", retrievedAt: AT,
    retrievalRequestIds: ["request-0000000000000001"], metadataProvenance: [{ field: "title", provider: "openalex", requestId: "request-0000000000000001" }],
    lineage: { studyId: null, cohortIds: [], datasetIds: [], relatedSourceIds: [], relationTypes: [] } } as const;
}
function claim(revision = 1) {
  return { schemaVersion: 1, claimId: "claim-0000000000000001", revision, statement: "claim", kind: "externally-verifiable-fact", materiality: "load-bearing",
    scopeQualifiers: { population: null, intervention: null, comparator: null, outcome: null, timeRange: null }, evidenceRule: { minimumLineages: 1, independentVerificationAllowed: true, primarySourceRequired: false, fullTextRequired: false },
    status: "supported", confidence: 0.8, evidenceRefs: [{ evidenceId: "ev-0000000000000001", revision: 1 }], conflictClaimIds: [], createdByAttemptId: ATTEMPT } as const;
}
function evidence() {
  return { schemaVersion: 1, evidenceId: "ev-0000000000000001", revision: 1, claimRef: { claimId: "claim-0000000000000001", revision: 1 }, evidenceType: "retrieved",
    sourceRef: { sourceId: "src-openalex.w1", revision: 1 }, calculationId: null, stance: "supporting", quotes: ["evidence"], locators: [], extractedValues: [], method: null,
    quality: "primary-peer-reviewed", confidence: 0.8, recordedByAttemptId: ATTEMPT, verificationStatus: "verified", conflictsWith: [] } as const;
}
function verification() {
  return { schemaVersion: 1, verificationId: "verify-0000000000000001", revision: 1, attemptId: ATTEMPT, method: "independent-source",
    checkedClaims: [{ claimId: "claim-0000000000000001", revision: 1 }], checkedEvidence: [{ evidenceId: "ev-0000000000000001", revision: 1 }], requestIds: ["request-0000000000000001"],
    calculationIds: ["calc-0000000000000001"], result: "accepted", corrections: [], independentEvidenceIds: ["ev-0000000000000001"], notes: "ok" } as const;
}
function calculation() {
  return { schemaVersion: 1, calculationId: "calc-0000000000000001", attemptId: ATTEMPT, sandboxPolicySha256: HASH, runtime: "node", command: "calc", environment: [], inputs: [], sourceFiles: [], outputs: [], networkEnabled: false, startedAt: AT, endedAt: AT, exitCode: 0, status: "success" } as const;
}

function input(overrides: Partial<CanonicalTransactionInput> = {}): CanonicalTransactionInput {
  return {
    schemaVersion: 1,
    transactionId: TX,
    runId: RUN,
    attemptId: ATTEMPT,
    sourceResultSeq: 7,
    createdAt: AT,
    sources: [source("src-openalex.w2", 1, "B"), source("src-openalex.w1", 1, "A")],
    claims: [claim()], evidence: [evidence()], verifications: [verification()], requests: [request()], calculations: [calculation()],
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
      canonicalJson(source("src-openalex.w1", 1, "A")),
      canonicalJson(source("src-openalex.w2", 1, "B")),
      "",
    ].join("\n"));
    expect(prepared.manifest.files[0]).toMatchObject({
      relativePath: "sources.jsonl",
      recordCount: 2,
      decodedBytes: Buffer.byteLength(sourceBytes),
      sha256: sha256Hex(sourceBytes),
    });
    const prepareSteps = steps.filter((step) => step === "manifest-synced" || step === "manifest-directory-synced");
    expect(prepareSteps).toEqual(["manifest-synced", "manifest-directory-synced"]);
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

  test("fsyncs committed then staging parent after rename and roll-forwards either failure on retry", async () => {
    for (const failAt of ["committed-parent-synced", "staging-parent-synced"] as const) {
      const runRoot = await root();
      const prepared = await prepareTransaction(runRoot, input());
      const firstSteps: TransactionProtocolStep[] = [];
      await expectCode(commitTransaction(runRoot, TX, {
        durability: async (handle, step) => {
          firstSteps.push(step);
          await handle.sync();
          if (step === failAt) throw new Error("parent-fsync-secret");
        },
      }), "transaction.io-failed");
      const parentSteps = firstSteps.filter((step) => step === "committed-parent-synced" || step === "staging-parent-synced");
      expect(parentSteps).toEqual(failAt === "committed-parent-synced"
        ? ["committed-parent-synced"]
        : ["committed-parent-synced", "staging-parent-synced"]);
      const retrySteps: TransactionProtocolStep[] = [];
      await expect(commitTransaction(runRoot, TX, {
        durability: async (handle, step) => { retrySteps.push(step); await handle.sync(); },
      })).resolves.toMatchObject({ sha256: prepared.manifestSha256 });
      expect(retrySteps.filter((step) => step === "committed-parent-synced" || step === "staging-parent-synced"))
        .toEqual(["committed-parent-synced", "staging-parent-synced"]);
    }
  });

  test("quarantines exact duplicate staging atomically and idempotently", async () => {
    const runRoot = await root();
    const ref = await committed(runRoot);
    const committedDir = join(runRoot, ".state/transactions/committed", TX);
    const stageDir = join(runRoot, ".state/transactions/.staging", TX);
    await cp(committedDir, stageDir, { recursive: true });
    const steps: TransactionProtocolStep[] = [];
    await expect(commitTransaction(runRoot, TX, { randomToken: () => "d".repeat(64), onStep: async (step) => { steps.push(step); } })).resolves.toEqual(ref);
    expect(steps.filter((step) => step === "staging-quarantined" || step.startsWith("quarantine-"))).toEqual([
      "staging-quarantined", "quarantine-source-parent-synced", "quarantine-destination-parent-synced",
    ]);
    await expect(lstat(stageDir)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = join(runRoot, ".state/transactions/.staging", `.quarantine-${TX}-${"d".repeat(64)}`);
    expect(await readFile(join(quarantine, "manifest.json"))).toEqual(await readFile(join(committedDir, "manifest.json")));
    await expect(commitTransaction(runRoot, TX)).resolves.toEqual(ref);
    expect(await lstat(quarantine)).toMatchObject({ isDirectory: expect.any(Function) });
    const conflictRoot = await root();
    await committed(conflictRoot);
    const conflictCommittedDir = join(conflictRoot, ".state/transactions/committed", TX);
    const conflictStageDir = join(conflictRoot, ".state/transactions/.staging", TX);
    await cp(conflictCommittedDir, conflictStageDir, { recursive: true });
    await writeFile(join(conflictStageDir, "claims.jsonl"), "{}\n");
    await expectCode(commitTransaction(conflictRoot, TX), "transaction.id-conflict");
  });

  test("never follows staging transaction or child symlinks during dual cleanup", async () => {
    const transactionSymlinkRoot = await root();
    await committed(transactionSymlinkRoot);
    const outsideDirectory = await root();
    await cp(join(transactionSymlinkRoot, ".state/transactions/committed", TX), outsideDirectory, { recursive: true });
    const outsideManifest = await readFile(join(outsideDirectory, "manifest.json"));
    await symlink(outsideDirectory, join(transactionSymlinkRoot, ".state/transactions/.staging", TX), "dir");
    await expectCode(commitTransaction(transactionSymlinkRoot, TX), "transaction.unsafe-file");
    expect(await readFile(join(outsideDirectory, "manifest.json"))).toEqual(outsideManifest);

    const childSymlinkRoot = await root();
    await committed(childSymlinkRoot);
    const stage = join(childSymlinkRoot, ".state/transactions/.staging", TX);
    await cp(join(childSymlinkRoot, ".state/transactions/committed", TX), stage, { recursive: true });
    const outsideFile = join(await root(), "claims.jsonl");
    const matching = await readFile(join(stage, "claims.jsonl"));
    await writeFile(outsideFile, matching);
    await rm(join(stage, "claims.jsonl"));
    await symlink(outsideFile, join(stage, "claims.jsonl"));
    await expectCode(commitTransaction(childSymlinkRoot, TX), "transaction.unsafe-file");
    expect(await readFile(outsideFile)).toEqual(matching);
    expect(await lstat(join(stage, "claims.jsonl"))).toMatchObject({ isSymbolicLink: expect.any(Function) });
  });

  test("moves a concurrently swapped staging symlink only and fails closed on parent swaps", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const stage = join(runRoot, ".state/transactions/.staging", TX);
    const original = join(runRoot, ".state/transactions/.staging", `${TX}-original`);
    await cp(join(runRoot, ".state/transactions/committed", TX), stage, { recursive: true });
    const outside = await root();
    const outsideFile = join(outside, "untouched");
    await writeFile(outsideFile, "outside");
    await expectCode(commitTransaction(runRoot, TX, {
      randomToken: () => "c".repeat(64),
      rename: async (from, to) => {
        if (from === stage) {
          await rename(from, original);
          await symlink(outside, from, "dir");
        }
        await rename(from, to);
      },
    }), "transaction.unsafe-file");
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
    const movedLink = join(runRoot, ".state/transactions/.staging", `.quarantine-${TX}-${"c".repeat(64)}`);
    expect((await lstat(movedLink)).isSymbolicLink()).toBe(true);

    const parentRoot = await root();
    await committed(parentRoot);
    await cp(join(parentRoot, ".state/transactions/committed", TX), join(parentRoot, ".state/transactions/.staging", TX), { recursive: true });
    const staging = join(parentRoot, ".state/transactions/.staging");
    const displaced = join(parentRoot, ".state/transactions/.staging-displaced");
    await expectCode(commitTransaction(parentRoot, TX, { rename: async (from, to) => {
      await rename(from, to);
      await rename(staging, displaced);
      await mkdir(staging, { mode: 0o700 });
    } }), "transaction.unsafe-root");
    expect((await readdir(displaced)).some((entry) => entry.startsWith(`.quarantine-${TX}-`))).toBe(true);
  });

  test("rolls forward every atomic lock acquire and release crash prefix", async () => {
    const acquireSteps: TransactionProtocolStep[] = ["lock-owner-synced", "lock-directory-synced", "lock-active-renamed", "lock-parent-synced"];
    const releaseSteps: TransactionProtocolStep[] = ["lock-release-renamed", "lock-release-parent-synced", "lock-owner-removed", "lock-trash-cleaned", "lock-released"];
    for (const failAt of [...acquireSteps, ...releaseSteps]) {
      const runRoot = await root();
      await prepareTransaction(runRoot, input());
      let failed = false;
      let token = 1;
      await expectCode(commitTransaction(runRoot, TX, {
        randomToken: () => (token++).toString(16).padStart(64, "0"),
        onStep: async (step) => { if (step === failAt && !failed) { failed = true; throw new Error("lock-crash"); } },
      }), "transaction.io-failed");
      const crashedEntries = await (await import("node:fs/promises")).readdir(join(runRoot, ".state/transactions"));
      const lockEntries = crashedEntries.filter((entry) => entry.startsWith(".mutation-lock"));
      if (failAt === "lock-owner-synced" || failAt === "lock-directory-synced") expect(lockEntries[0]).toMatch(/^\.mutation-lock\.acquire-/);
      else if (failAt === "lock-active-renamed" || failAt === "lock-parent-synced") expect(lockEntries).toContain(".mutation-lock");
      else if (failAt === "lock-release-renamed" || failAt === "lock-release-parent-synced" || failAt === "lock-owner-removed") expect(lockEntries[0]).toMatch(/^\.mutation-lock\.release-/);
      else expect(lockEntries).toEqual([]);
      await expect(commitTransaction(runRoot, TX, {
        randomToken: () => "f".repeat(64), isProcessAlive: () => false,
        now: () => new Date(Date.now() + 10_000), lockTrashMinAgeMs: 1,
      })).resolves.toBeDefined();
      const entries = await (await import("node:fs/promises")).readdir(join(runRoot, ".state/transactions"));
      expect(entries.filter((entry) => entry.startsWith(".mutation-lock"))).toEqual([]);
    }
  });

  test("durably initializes hierarchy and recovers every mkdir sync crash", async () => {
    const phases = [
      "mkdir-state-directory-synced", "mkdir-state-parent-synced", "mkdir-transactions-directory-synced", "mkdir-transactions-parent-synced",
      "mkdir-staging-directory-synced", "mkdir-staging-parent-synced", "mkdir-committed-directory-synced", "mkdir-committed-parent-synced",
      "mkdir-transaction-directory-synced", "mkdir-transaction-parent-synced",
    ] as const;
    for (const phase of phases) {
      const runRoot = await root();
      let failed = false;
      await expectCode(prepareTransaction(runRoot, input(), { onStep: async (step) => {
        if (step === phase && !failed) { failed = true; throw new Error("mkdir-crash"); }
      } }), "transaction.io-failed");
      await expect(prepareTransaction(runRoot, input())).resolves.toBeDefined();
      await expect(lstat(join(runRoot, ".state/transactions/committed", TX))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("recovers deterministic stale mutation locks and rejects live owners", async () => {
    const runRoot = await root();
    await prepareTransaction(runRoot, input());
    const lockPath = join(runRoot, ".state/transactions/.mutation-lock");
    await mkdir(lockPath, { mode: 0o700 });
    const stat = await lstat(lockPath);
    const owner = { schemaVersion: 1, pid: 424242, ownerToken: "f".repeat(64), createdAt: AT, dev: String(stat.dev), ino: String(stat.ino) };
    await writeFile(join(lockPath, "owner.json"), `${canonicalJson(owner)}\n`);
    await expectCode(commitTransaction(runRoot, TX, { isProcessAlive: () => true }), "transaction.locked");
    await expect(commitTransaction(runRoot, TX, { isProcessAlive: () => false, randomToken: () => "e".repeat(64), pid: 123 })).resolves.toBeDefined();
  });

  test("ages ownerless lock trash and fails closed on malicious contents", async () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const makeTrash = async (runRoot: string, kind: "acquire" | "release", token: string, ageMs: number, content: "empty" | "partial" | "symlink" | "unknown") => {
      const path = join(runRoot, ".state/transactions", `.mutation-lock.${kind}-${token}`);
      await mkdir(path, { mode: 0o700 });
      if (content === "partial") await writeFile(join(path, "owner.json"), "{\n", { mode: 0o600 });
      if (content === "unknown") await writeFile(join(path, "unexpected"), "x");
      if (content === "symlink") await symlink(join(runRoot, "outside"), join(path, "owner.json"));
      const then = new Date(now.getTime() - ageMs);
      await utimes(path, then, then);
      return path;
    };

    for (const kind of ["acquire", "release"] as const) {
      const recentRoot = await root();
      await prepareTransaction(recentRoot, input());
      const recent = await makeTrash(recentRoot, kind, kind === "acquire" ? "1".repeat(64) : "7".repeat(64), 30_000, "empty");
      await commitTransaction(recentRoot, TX, { now: () => now, lockTrashMinAgeMs: 60_000 });
      expect((await lstat(recent)).isDirectory()).toBe(true);
    }

    for (const kind of ["acquire", "release"] as const) {
      for (const content of ["empty", "partial"] as const) {
        const runRoot = await root();
        await prepareTransaction(runRoot, input());
        const digit = kind === "acquire" ? (content === "empty" ? "2" : "3") : (content === "empty" ? "8" : "9");
        const stale = await makeTrash(runRoot, kind, digit.repeat(64), 120_000, content);
        await commitTransaction(runRoot, TX, { now: () => now, lockTrashMinAgeMs: 60_000 });
        await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }

    const liveRoot = await root();
    await prepareTransaction(liveRoot, input());
    const liveToken = "4".repeat(64);
    const livePath = await makeTrash(liveRoot, "acquire", liveToken, 120_000, "empty");
    const liveStat = await lstat(livePath);
    const liveOwner = { schemaVersion: 1, pid: 4242, ownerToken: liveToken, createdAt: AT, dev: String(liveStat.dev), ino: String(liveStat.ino) };
    await writeFile(join(livePath, "owner.json"), `${canonicalJson(liveOwner)}\n`, { mode: 0o600 });
    await commitTransaction(liveRoot, TX, { now: () => now, lockTrashMinAgeMs: 60_000, isProcessAlive: () => true });
    expect((await lstat(livePath)).isDirectory()).toBe(true);

    for (const content of ["symlink", "unknown"] as const) {
      const runRoot = await root();
      await writeFile(join(runRoot, "outside"), "outside");
      await prepareTransaction(runRoot, input());
      await makeTrash(runRoot, "release", content === "symlink" ? "5".repeat(64) : "6".repeat(64), 120_000, content);
      await expectCode(commitTransaction(runRoot, TX, { now: () => now, lockTrashMinAgeMs: 60_000 }), "transaction.lock-corrupt");
      expect(await readFile(join(runRoot, "outside"), "utf8")).toBe("outside");
    }
  });

  test("excludes independent module instances racing the same transaction root", async () => {
    const runRoot = await root();
    vi.resetModules();
    const moduleA = await import("../../src/storage/transaction-store.js");
    vi.resetModules();
    const moduleB = await import("../../src/storage/transaction-store.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const first = moduleA.prepareTransaction(runRoot, input(), { onStep: async (step: TransactionProtocolStep) => {
      if (step === "lock-parent-synced" && !held) { held = true; await gate; }
    } });
    await vi.waitFor(() => expect(held).toBe(true));
    const second = moduleB.prepareTransaction(runRoot, input());
    await expectCode(second, "transaction.locked");
    release();
    await expect(first).resolves.toBeDefined();
    await expect(moduleB.prepareTransaction(runRoot, input())).resolves.toBeDefined();

    const otherRoot = await root();
    let releaseOther!: () => void;
    const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
    let otherHeld = false;
    const empty = { sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] } as const;
    const tx2 = input({ ...empty, transactionId: "tx-0000000000000002", sourceResultSeq: 8 });
    const tx3 = input({ ...empty, transactionId: "tx-0000000000000003", sourceResultSeq: 9 });
    const otherFirst = moduleA.prepareTransaction(otherRoot, tx2, { onStep: async (step: TransactionProtocolStep) => {
      if (step === "lock-parent-synced" && !otherHeld) { otherHeld = true; await otherGate; }
    } });
    await vi.waitFor(() => expect(otherHeld).toBe(true));
    await expectCode(moduleB.prepareTransaction(otherRoot, tx3), "transaction.locked");
    releaseOther();
    await expect(otherFirst).resolves.toBeDefined();
    await expect(moduleB.prepareTransaction(otherRoot, tx3)).resolves.toBeDefined();
  });

  test("fails closed when a pinned ancestor is swapped before rename", async () => {
    const runRoot = await root();
    await prepareTransaction(runRoot, input());
    const transactions = join(runRoot, ".state/transactions");
    const moved = join(runRoot, ".state/transactions-moved");
    let swapped = false;
    await expectCode(commitTransaction(runRoot, TX, { onAncestorCheck: async (phase) => {
      if (phase === "before-rename" && !swapped) {
        swapped = true;
        await rename(transactions, moved);
        await mkdir(transactions);
        await mkdir(join(transactions, ".staging"));
        await mkdir(join(transactions, "committed"));
      }
    } }), "transaction.unsafe-root");
    await expect(lstat(join(transactions, "committed", TX))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("enforces record, total and transaction byte bounds before writing", async () => {
    const runRoot = await root();
    await expectCode(prepareTransaction(runRoot, input(), { maxRecords: 1, maxTotalRecords: 2 }), "transaction.too-many-records");
    await expectCode(prepareTransaction(runRoot, input(), { maxTransactionBytes: 128 }), "transaction.file-too-large");
    await expectCode(prepareTransaction(runRoot, input(), { maxReferences: 1 }), "transaction.too-many-records");
  });

  test("rejects structurally hostile records before canonicalization", async () => {
    const runRoot = await root();
    for (const [record, options] of [
      [{ ...claim(), statement: "x".repeat(1024) }, { maxStringBytes: 128 }],
      [Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key${index}`, index])), { maxKeys: 64 }],
      [{ ...claim(), scopeQualifiers: { population: [[[[["deep"]]]]], intervention: null, comparator: null, outcome: null, timeRange: null } }, { maxDepth: 4 }],
      [{ ...claim(), evidenceRefs: Array.from({ length: 20 }, () => ({ evidenceId: "ev-0000000000000001", revision: 1 })) }, { maxArrayLength: 10 }],
    ] as const) {
      let canonicalCalls = 0;
      const rejection = prepareTransaction(runRoot, input({ claims: [record as never] }), {
        ...options, canonicalize: (value) => { canonicalCalls += 1; return canonicalJson(value); },
      });
      await expectCode(rejection, "transaction.file-too-large");
      expect(canonicalCalls).toBe(0);
    }
    let getterCalls = 0;
    const hostile = { ...claim() } as Record<string, unknown>;
    Object.defineProperty(hostile, "statement", { enumerable: true, get: () => { getterCalls += 1; return "secret"; } });
    await expectCode(prepareTransaction(runRoot, input({ claims: [hostile] })), "transaction.invalid-input");
    expect(getterCalls).toBe(0);
    const proxy = new Proxy(claim(), { ownKeys: () => { throw new Error("proxy trap"); } });
    await expectCode(prepareTransaction(runRoot, input({ claims: [proxy] })), "transaction.invalid-input");
    const cycle = { ...claim() } as Record<string, unknown>;
    cycle.loop = cycle;
    const symbolKeyed = { ...claim(), [Symbol("secret")]: true };
    const nonPlain = Object.assign(Object.create({ inherited: true }), claim());
    for (const record of [cycle, symbolKeyed, nonPlain]) {
      let canonicalCalls = 0;
      await expectCode(prepareTransaction(runRoot, input({ claims: [record] }), {
        canonicalize: (value) => { canonicalCalls += 1; return canonicalJson(value); },
      }), "transaction.invalid-input");
      expect(canonicalCalls).toBe(0);
    }
  });

  test("bounds persisted manifests structurally before canonical verification", async () => {
    const runRoot = await root();
    const ref = await committed(runRoot);
    const manifestPath = join(runRoot, ref.relativePath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.sourceRefs[0].nested = [[[[[["too-deep"]]]]]];
    const bytes = `${canonicalJson(manifest)}\n`;
    await writeFile(manifestPath, bytes);
    await expectCode(verifyTransaction(runRoot, { ...ref, sha256: sha256Hex(bytes) }, { maxDepth: 5 }), "transaction.corrupt");
  });

  test("validates canonical request sources and immediate retry predecessors", async () => {
    const unresolvedRoot = await root();
    await expectCode(prepareTransaction(unresolvedRoot, input({ requests: [{ ...request(), resultSourceIds: ["src-missing00"] }] })), "transaction.invalid-reference");
    const firstRoot = await root();
    await committed(firstRoot);
    const retry = (overrides: Record<string, unknown> = {}) => ({ ...request("request-0000000000000002"), physicalAttemptOrdinal: 2,
      retryOfRequestId: "request-0000000000000001", resultSourceIds: ["src-openalex.w1"], ...overrides });
    const retryInput = input({ transactionId: "tx-0000000000000002", sourceResultSeq: 8, sources: [], claims: [], evidence: [], verifications: [], calculations: [], requests: [retry()] });
    await expect(prepareTransaction(firstRoot, retryInput)).resolves.toBeDefined();
    for (const mutation of [
      { retryOfRequestId: "request-0000000000009999" },
      { retryOfRequestId: "request-0000000000000002" },
      { logicalRequestId: "other-series" },
      { physicalAttemptOrdinal: 3 },
      { provider: "crossref" },
    ]) {
      const runRoot = await root();
      await committed(runRoot);
      await expectCode(prepareTransaction(runRoot, { ...retryInput, requests: [retry(mutation)] }), "transaction.invalid-reference");
    }
    const cycleRoot = await root();
    await committed(cycleRoot);
    const cycleA = retry({ requestId: "request-0000000000000002", retryOfRequestId: "request-0000000000000003" });
    const cycleB = retry({ requestId: "request-0000000000000003", retryOfRequestId: "request-0000000000000002" });
    await expectCode(prepareTransaction(cycleRoot, { ...retryInput, requests: [cycleA, cycleB] }), "transaction.invalid-reference");
  });

  test("makes duplicate matching commit harmless and different content corruption", async () => {
    const runRoot = await root();
    const first = await committed(runRoot);
    const before = await readFile(join(runRoot, first.relativePath));
    await expect(commitTransaction(runRoot, TX)).resolves.toEqual(first);
    expect(await readFile(join(runRoot, first.relativePath))).toEqual(before);
    await expectCode(prepareTransaction(runRoot, input({ claims: [{ ...claim(), statement: "changed" }] })), "transaction.id-conflict");
  });

  test("resolves exact refs across transactions and enforces revision progression", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const revisionTwo = input({
      transactionId: "tx-0000000000000002", sourceResultSeq: 8,
      sources: [source("src-openalex.w1", 2, "A2")], claims: [], evidence: [], verifications: [], requests: [], calculations: [],
    });
    await expect(prepareTransaction(runRoot, revisionTwo)).resolves.toMatchObject({ manifest: { sourceRefs: [{ sourceId: "src-openalex.w1", revision: 2 }] } });

    const staleRoot = await root();
    await committed(staleRoot);
    await expectCode(prepareTransaction(staleRoot, { ...revisionTwo, sources: [source("src-openalex.w1", 3, "skip")] }), "transaction.invalid-reference");
    await expectCode(prepareTransaction(staleRoot, { ...revisionTwo, sources: [source("src-openalex.w1", 1, "duplicate")] }), "transaction.duplicate-record");
  });

  test("rejects unresolved, stale and cross-kind exact references", async () => {
    const runRoot = await root();
    await expectCode(prepareTransaction(runRoot, input({ evidence: [{ ...evidence(), sourceRef: { sourceId: "src-missing00", revision: 1 } }] })), "transaction.invalid-reference");
    await expectCode(prepareTransaction(runRoot, input({ evidence: [{ ...evidence(), sourceRef: { sourceId: "src-openalex.w1", revision: 2 } }] })), "transaction.invalid-reference");
    await expectCode(prepareTransaction(runRoot, input({ claims: [{ ...claim(), evidenceRefs: [{ evidenceId: "ev-0000000000009999", revision: 1 }] }] })), "transaction.invalid-reference");
  });

  test("serializes concurrent matching prepare/commit and fails closed for different input", async () => {
    const runRoot = await root();
    const [one, two] = await Promise.all([prepareTransaction(runRoot, input()), prepareTransaction(runRoot, input())]);
    expect(one.manifestSha256).toBe(two.manifestSha256);
    const [commitOne, commitTwo] = await Promise.all([commitTransaction(runRoot, TX), commitTransaction(runRoot, TX)]);
    expect(commitOne).toEqual(commitTwo);

    const otherRoot = await root();
    const changed = input({ claims: [{ ...claim(), statement: "changed" }] });
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
      source("src-openalex.w1", 1, "A"),
      source("src-openalex.w1", 1, "A"),
    ] })), "transaction.duplicate-record");
    await expectCode(prepareTransaction(runRoot, input({ sources: [
      source("src-openalex.w1", 1, "A"),
      source("src-openalex.w1", 2, "B"),
    ] })), "transaction.duplicate-record");
    await expectCode(prepareTransaction(runRoot, input({ sources: [{ ...source("src-openalex.w1", 1, "A"), claimId: "claim-0000000000000001" }] })), "transaction.cross-kind-id");
    await expectCode(prepareTransaction(runRoot, input({ claims: [{ claimId: "claim-0000000000000001", revision: 1 }] })), "transaction.invalid-record");
    await expectCode(prepareTransaction(runRoot, input({ claims: [new Proxy(claim(), {})] })), "transaction.invalid-input");
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

  test("bounds descriptor reads at maxFileBytes plus one", async () => {
    const runRoot = await root();
    const ref = await committed(runRoot);
    const requested: number[] = [];
    await expectCode(verifyTransaction(runRoot, ref, {
      maxFileBytes: 2048,
      readChunk: async (_handle, buffer) => {
        requested.push(buffer.byteLength);
        buffer.fill(0x61);
        return buffer.byteLength;
      },
    }), "transaction.file-too-large");
    expect(requested).toEqual([2049]);
  });

  test("rejects closed-manifest ref extras and secret accessors before property access", async () => {
    const refShapes = [
      ["sourceRefs", "sourceId"], ["claimRefs", "claimId"],
      ["evidenceRefs", "evidenceId"], ["verificationRefs", "verificationId"],
    ] as const;
    for (const [field, idField] of refShapes) {
      for (const mutation of ["extra", "revision", "id"] as const) {
        const runRoot = await root();
        const ref = await committed(runRoot);
        const manifestPath = join(runRoot, ref.relativePath);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (mutation === "extra") manifest[field][0].unexpected = true;
        else if (mutation === "revision") manifest[field][0].revision = 0;
        else manifest[field][0][idField] = "wrong-id";
        const bytes = `${canonicalJson(manifest)}\n`;
        await writeFile(manifestPath, bytes);
        await expectCode(verifyTransaction(runRoot, { ...ref, sha256: sha256Hex(bytes) }), "transaction.corrupt");
      }
    }
    for (const [field, wrong] of [["requestIds", "request-wrong"], ["calculationIds", "calc-wrong"]] as const) {
      const runRoot = await root();
      const ref = await committed(runRoot);
      const manifestPath = join(runRoot, ref.relativePath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest[field][0] = wrong;
      const bytes = `${canonicalJson(manifest)}\n`;
      await writeFile(manifestPath, bytes);
      await expectCode(verifyTransaction(runRoot, { ...ref, sha256: sha256Hex(bytes) }), "transaction.corrupt");
    }

    const refRoot = await root();
    const validRef = await committed(refRoot);
    await expectCode(verifyTransaction(refRoot, { ...validRef, unexpected: true } as never), "transaction.invalid-input");
    const accessorRef = { transactionId: validRef.transactionId, relativePath: validRef.relativePath } as Record<string, unknown>;
    Object.defineProperty(accessorRef, "sha256", { enumerable: true, get: () => { throw new Error("secret-ref-accessor"); } });
    const refFailure = verifyTransaction(refRoot, accessorRef as never);
    await expectCode(refFailure, "transaction.invalid-input");
    await expect(refFailure.catch((error: Error) => error.message)).resolves.not.toContain("secret-ref-accessor");

    const recordKinds = [
      ["sources", "sourceId"], ["claims", "claimId"], ["evidence", "evidenceId"],
      ["verifications", "verificationId"], ["requests", "requestId"], ["calculations", "calculationId"],
    ] as const;
    for (const [kind, idField] of recordKinds) {
      const runRoot = await root();
      const original = input()[kind][0] as Record<string, unknown>;
      const bad = { ...original };
      delete bad[idField];
      Object.defineProperty(bad, idField, { enumerable: true, get: () => { throw new Error(`secret-${kind}`); } });
      const failure = prepareTransaction(runRoot, input({ [kind]: [bad] }));
      await expectCode(failure, "transaction.invalid-input");
      await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain(`secret-${kind}`);
    }
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
    const second = input({ transactionId: "tx-0000000000000002", sourceResultSeq: 8, sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [] });
    await committed(runRoot, second);
    expect((await listCommittedTransactions(runRoot)).map((item) => item.manifest.transactionId)).toEqual([TX, second.transactionId]);
    await writeFile(join(runRoot, ".state/transactions/committed", "unexpected"), "x");
    await expectCode(listCommittedTransactions(runRoot), "transaction.suspicious-entry");
  });

  test("does not promote cancelled, superseded, or late-epoch diagnostic results", async () => {
    const cancelledRoot = await root();
    const cancelled = cancelledResultEvents(false);
    await committed(cancelledRoot, input({ sourceResultSeq: cancelled.at(-1)!.seq }));
    expect(await reconcileCanonicalTransactions(cancelledRoot, cancelled)).toEqual([]);
    expect(await reconstructCanonicalRecords(cancelledRoot, cancelled)).toMatchObject({
      sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [],
    });

    const lateRoot = await root();
    const late = cancelledResultEvents(true);
    await committed(lateRoot, input({ sourceResultSeq: late.at(-1)!.seq }));
    expect(await reconcileCanonicalTransactions(lateRoot, late)).toEqual([]);

    const supersededRoot = await root();
    const superseded = supersededResultEvents();
    await committed(supersededRoot, input({ sourceResultSeq: superseded.at(-1)!.seq }));
    expect(await reconcileCanonicalTransactions(supersededRoot, superseded)).toEqual([]);
  });

  test("rejects cross-run transaction objects during reconcile and reconstruction", async () => {
    const runRoot = await root();
    await committed(runRoot, input({ runId: "run-0000000000000002" }));
    const events = baseEvents();
    await expectCode(reconcileCanonicalTransactions(runRoot, events), "transaction.corrupt");
    await expectCode(reconstructCanonicalRecords(runRoot, events), "transaction.corrupt");
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

describe("read-only transaction race resistance", () => {
  test("rejects committed-directory replacement with identical bytes", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const directory = join(runRoot, `.state/transactions/committed/${TX}`);
    const moved = `${directory}.moved`;
    const manifestBefore = await readFile(join(directory, "manifest.json"));
    let swapped = false;
    await expectCode(inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), {
      onReadOnlyCheck: async (phase) => {
        if (phase === "transaction-directory-pinned" && !swapped) {
          swapped = true;
          await rename(directory, moved);
          await cp(moved, directory, { recursive: true });
        }
      },
    }), "transaction.unsafe-file");
    expect(await readFile(join(directory, "manifest.json"))).toEqual(manifestBefore);
    expect(await readFile(join(moved, "manifest.json"))).toEqual(manifestBefore);
  });

  test("rejects identical file replacement and symlink swap after pinning", async () => {
    for (const swap of ["file", "symlink"] as const) {
      const runRoot = await root();
      await committed(runRoot);
      const manifest = join(runRoot, `.state/transactions/committed/${TX}/manifest.json`);
      const moved = `${manifest}.${swap}`;
      const original = await readFile(manifest);
      let swapped = false;
      await expectCode(inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), {
        onReadOnlyCheck: async (phase, path) => {
          if (phase === "file-pinned" && path === manifest && !swapped) {
            swapped = true;
            await rename(manifest, moved);
            if (swap === "file") await writeFile(manifest, original, { mode: 0o600 });
            else await symlink(moved, manifest);
          }
        },
      }), "transaction.unsafe-file");
      expect(await readFile(moved)).toEqual(original);
      if (swap === "file") expect(await readFile(manifest)).toEqual(original);
    }
  });

  test("rejects in-place mutation restored to identical bytes and mtime", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const manifest = join(runRoot, `.state/transactions/committed/${TX}/manifest.json`);
    const original = await readFile(manifest);
    const before = await lstat(manifest);
    let mutated = false;
    await expectCode(inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), {
      onReadOnlyCheck: async (phase, path) => {
        if (phase === "file-chunk-read" && path === manifest && !mutated) {
          mutated = true;
          const changed = Buffer.from(original);
          changed[0] = changed[0]! ^ 1;
          await writeFile(manifest, changed);
          await writeFile(manifest, original);
          await utimes(manifest, before.atime, before.mtime);
        }
      },
    }), "transaction.unsafe-file");
    expect(await readFile(manifest)).toEqual(original);
    expect((await lstat(manifest)).mtimeMs).toBeCloseTo(before.mtimeMs, 0);
  });

  test.each(["manifest.json", "requests.jsonl"])("keeps %s pinned through the final hook and rejects mutate/restore", async (name) => {
    const runRoot = await root();
    await committed(runRoot);
    const path = join(runRoot, `.state/transactions/committed/${TX}/${name}`);
    const original = await readFile(path);
    const before = await lstat(path);
    let mutated = false;
    await expectCode(inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), {
      onReadOnlyCheck: async (phase) => {
        if (phase === "transaction-directory-final" && !mutated) {
          mutated = true;
          const changed = Buffer.from(original);
          changed[0] = changed[0]! ^ 1;
          await writeFile(path, changed);
          await writeFile(path, original);
          await utimes(path, before.atime, before.mtime);
        }
      },
    }), "transaction.unsafe-file");
    expect(await readFile(path)).toEqual(original);
  });

  test.each(["identical replacement", "symlink swap"])("rejects final-hook %s while preserving source bytes", async (kind) => {
    const runRoot = await root();
    await committed(runRoot);
    const path = join(runRoot, `.state/transactions/committed/${TX}/manifest.json`);
    const moved = `${path}.final`;
    const original = await readFile(path);
    let swapped = false;
    await expectCode(inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), {
      onReadOnlyCheck: async (phase) => {
        if (phase === "transaction-directory-final" && !swapped) {
          swapped = true;
          await rename(path, moved);
          if (kind === "identical replacement") await writeFile(path, original, { mode: 0o600 });
          else await symlink(moved, path);
        }
      },
    }), "transaction.unsafe-file");
    expect(await readFile(moved)).toEqual(original);
    if (kind === "identical replacement") expect(await readFile(path)).toEqual(original);
  });

  test("returns an immutable verified snapshot only after final consistency checks", async () => {
    const runRoot = await root();
    const ref = await committed(runRoot);
    const verified = await verifyTransaction(runRoot, ref);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.manifest)).toBe(true);
    expect(Object.isFrozen(verified.records)).toBe(true);
    expect(Object.isFrozen(verified.records.requests)).toBe(true);
    expect(Object.isFrozen(verified.records.requests[0])).toBe(true);
  });

  test("closes every retained verification handle after an injected close failure", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const handles: FileHandle[] = [];
    const failure = inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), {
      close: async (handle) => {
        handles.push(handle);
        throw new Error("final-close-secret");
      },
    });
    await expectCode(failure, "transaction.io-failed");
    await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain("final-close-secret");
    expect(handles.length).toBeGreaterThanOrEqual(9);
    for (const handle of handles) await expect(handle.stat()).rejects.toBeDefined();
  });

  test.each([
    ["first-stat", 1],
    ["validation", 1],
    ["second-handle", 2],
  ] as const)("cleans the read-only hierarchy registry after %s failure", async (failureKind, expectedHandles) => {
    const runRoot = await root();
    await committed(runRoot);
    const handles: FileHandle[] = [];
    const closes = new Map<FileHandle, number>();
    const options = {
      onHandleOpened: async (kind: string, _path: string, handle: FileHandle) => {
        if (kind !== "read-only-hierarchy") return;
        handles.push(handle);
        if (failureKind === "first-stat" && handles.length === 1) {
          Object.defineProperty(handle, "stat", { configurable: true, value: async () => { throw new Error("first-stat-secret"); } });
        }
        if (failureKind === "validation" && handles.length === 1) throw new Error("validation-secret");
        if (failureKind === "second-handle" && handles.length === 2) throw new Error("second-handle-secret");
      },
      close: async (handle: FileHandle) => {
        closes.set(handle, (closes.get(handle) ?? 0) + 1);
        await handle.close();
      },
    };
    const failure = inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), options);
    await expectCode(failure, "transaction.unsafe-root");
    expect(handles).toHaveLength(expectedHandles);
    for (const handle of handles) {
      expect(closes.get(handle)).toBe(1);
      await expect(handle.stat()).rejects.toBeDefined();
    }
    expect(await inspectCanonicalTransactionsReadOnly(runRoot, baseEvents())).toMatchObject({ pendingCount: 1 });
  });

  test("preserves the primary hierarchy error when injected close also throws", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const handles: FileHandle[] = [];
    const nativeCloses = new Map<FileHandle, number>();
    const options = {
      onHandleOpened: async (kind: string, _path: string, handle: FileHandle) => {
        if (kind !== "read-only-hierarchy") return;
        handles.push(handle);
        const nativeClose = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            nativeCloses.set(handle, (nativeCloses.get(handle) ?? 0) + 1);
            await nativeClose();
          },
        });
        throw new Error("primary-secret");
      },
      close: async () => { throw new Error("close-secret"); },
    };
    const failure = inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), options);
    await expectCode(failure, "transaction.unsafe-root");
    await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain("secret");
    expect(handles).toHaveLength(1);
    expect(nativeCloses.get(handles[0]!)).toBe(1);
    await expect(handles[0]!.stat()).rejects.toBeDefined();
    expect(await inspectCanonicalTransactionsReadOnly(runRoot, baseEvents())).toMatchObject({ pendingCount: 1 });
  });

  test("closes a newly opened mutation-hierarchy handle before ownership transfer", async () => {
    const runRoot = await root();
    await committed(runRoot);
    const handles: FileHandle[] = [];
    const closes = new Map<FileHandle, number>();
    const options = {
      onHandleOpened: async (kind: string, _path: string, handle: FileHandle) => {
        if (kind !== "mutation-hierarchy" || handles.length > 0) return;
        handles.push(handle);
        Object.defineProperty(handle, "stat", { configurable: true, value: async () => { throw new Error("mutation-stat-secret"); } });
      },
      close: async (handle: FileHandle) => {
        closes.set(handle, (closes.get(handle) ?? 0) + 1);
        await handle.close();
      },
    };
    await expectCode(reconcileCanonicalTransactions(runRoot, baseEvents(), options), "transaction.unsafe-root");
    expect(handles).toHaveLength(1);
    expect(closes.get(handles[0]!)).toBe(1);
    expect(await reconcileCanonicalTransactions(runRoot, baseEvents())).toEqual([{ kind: "finish-transaction", transactionId: TX }]);
  });

  test.each(["transaction-directory", "transaction-file"])("closes a newly opened %s handle when its first validation throws", async (targetKind) => {
    const runRoot = await root();
    await committed(runRoot);
    const handles: FileHandle[] = [];
    const closes = new Map<FileHandle, number>();
    const options = {
      onHandleOpened: async (kind: string, _path: string, handle: FileHandle) => {
        if (kind !== targetKind || handles.length > 0) return;
        handles.push(handle);
        Object.defineProperty(handle, "stat", { configurable: true, value: async () => { throw new Error("retained-stat-secret"); } });
      },
      close: async (handle: FileHandle) => {
        closes.set(handle, (closes.get(handle) ?? 0) + 1);
        await handle.close();
      },
    };
    const failure = inspectCanonicalTransactionsReadOnly(runRoot, baseEvents(), options);
    await expectCode(failure, "transaction.unsafe-file");
    expect(handles).toHaveLength(1);
    expect(closes.get(handles[0]!)).toBe(1);
    await expect(handles[0]!.stat()).rejects.toBeDefined();
    expect(await inspectCanonicalTransactionsReadOnly(runRoot, baseEvents())).toMatchObject({ pendingCount: 1 });
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
function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return { schemaVersion: 1, attemptId: ATTEMPT, revision: 1, runId: RUN, taskId: TASK, executionEpoch: 0, logicalOperationId: "op", attemptOrdinal: 1, retryOfAttemptId: null, attemptKind: "research", replayPolicy: "safe-read", state: "intent-recorded", providerModel: "p/m", thinkingLevel: "medium", promptTemplateSha256: HASH, renderedPromptSha256: "b".repeat(64), logicalInputSha256: "c".repeat(64), attemptEnvelopeSha256: "d".repeat(64), toolAllowlist: [], deadlineAt: AT, capabilityId: "cap", resultSha256: null, billingStatus: "unknown", reportedUsage: null, error: null, createdAt: AT, updatedAt: AT, ...overrides };
}
function event<T extends FoundationEventType>(type: T, payload: FoundationEventPayload<T>): FoundationLedgerEvent {
  const seq = eventSeq++;
  return { schemaVersion: 1, seq, occurredAt: AT, eventId: `event-${seq}`, type, payload, prevSha256: "0".repeat(64), entrySha256: HASH } as FoundationLedgerEvent;
}
let eventSeq = 1;

function cancelledResultEvents(resumed: boolean): FoundationLedgerEvent[] {
  const events = baseEvents().slice(0, -1);
  eventSeq = 7;
  events.push(event("cancel_requested", { executionEpoch: 0, reason: "user-pause" }));
  if (resumed) events.push(event("resume_epoch_started", { priorEpoch: 0, executionEpoch: 1, priorCancelSeq: 7, checkpointStage: null, ownerTokenSha256: HASH }));
  events.push(event("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX }));
  return events;
}

function supersededResultEvents(): FoundationLedgerEvent[] {
  const events = baseEvents().slice(0, -1);
  eventSeq = 7;
  events.push(event("attempt_failed", { attemptId: ATTEMPT, state: "retryable-failed", errorClass: "transient", message: "retry" }));
  events.push(event("identity_reserved", { kind: "retry-schedule", id: RETRY, origin: "parent-generated" }));
  events.push(event("retry_scheduled", { scheduleId: RETRY, logicalOperationId: "op", failedAttemptId: ATTEMPT, nextAttemptOrdinal: 2, notBeforeAt: AT, delayMs: 0, reasonClass: "transient" }));
  events.push(event("identity_reserved", { kind: "attempt", id: ATTEMPT_2, origin: "parent-generated" }));
  events.push(event("retry_started", { scheduleId: RETRY, logicalOperationId: "op", attemptId: ATTEMPT_2, attemptOrdinal: 2, scheduledFromSeq: 9 }));
  events.push(event("dispatch_intent", { attempt: attempt({ attemptId: ATTEMPT_2, attemptOrdinal: 2, retryOfAttemptId: ATTEMPT, attemptEnvelopeSha256: "e".repeat(64) }) }));
  events.push(event("attempt_failed", { attemptId: ATTEMPT, state: "superseded", errorClass: "superseded", message: "replacement" }));
  events.push(event("result_recorded", { attemptId: ATTEMPT, resultSha256: HASH, manifestSha256: null, transactionId: TX }));
  return events;
}

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
