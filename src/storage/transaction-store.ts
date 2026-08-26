import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename as nodeRename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { RequestRecordSchema, type FoundationLedgerEvent } from "../domain/events.js";
import { ID_PATTERNS, isTimestamp, type TransactionId } from "../domain/ids.js";
import {
  CanonicalTransactionManifestSchema,
  type AttemptRecord,
  type CanonicalTransactionManifest,
} from "../domain/records.js";
import { recoveryDecisionFor, reduceLedgerEvents } from "../domain/reducer.js";
import { parseResearchRecord } from "../domain/research-records.js";
import { parse } from "../domain/schema.js";
import { assertBoundedStructure, StructuralLimitError, type StructuralLimits } from "./bounded-structure.js";

const KINDS = ["sources", "claims", "evidence", "verifications", "requests", "calculations"] as const;
export type CanonicalRecordKind = typeof KINDS[number];
type JsonRecord = Readonly<Record<string, unknown>>;

const KIND_ID: Record<CanonicalRecordKind, { field: string; pattern: RegExp; revision: boolean }> = {
  sources: { field: "sourceId", pattern: ID_PATTERNS.source, revision: true },
  claims: { field: "claimId", pattern: ID_PATTERNS.claim, revision: true },
  evidence: { field: "evidenceId", pattern: ID_PATTERNS.evidence, revision: true },
  verifications: { field: "verificationId", pattern: ID_PATTERNS.verification, revision: true },
  requests: { field: "requestId", pattern: ID_PATTERNS.request, revision: false },
  calculations: { field: "calculationId", pattern: ID_PATTERNS.calculation, revision: false },
};
const ALL_ID_FIELDS = new Set(Object.values(KIND_ID).map(({ field }) => field));
const INPUT_KEYS = new Set(["schemaVersion", "transactionId", "runId", "attemptId", "sourceResultSeq", "createdAt", ...KINDS]);
const MANIFEST_FILE = "manifest.json";
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_TOTAL_RECORDS = 300_000;
const DEFAULT_MAX_REFERENCES = 300_000;
const DEFAULT_MAX_TRANSACTION_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 500_000;
const DEFAULT_MAX_KEYS = 500_000;
const DEFAULT_LOCK_TRASH_MIN_AGE_MS = 5 * 60 * 1000;
const READ_CHUNK_BYTES = 64 * 1024;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const rootQueues = new Map<string, Promise<void>>();
const releasedHandles = new WeakSet<FileHandle>();

export interface CanonicalTransactionInput {
  schemaVersion: 1;
  transactionId: TransactionId;
  runId: `run-${string}`;
  attemptId: `attempt-${string}`;
  sourceResultSeq: number;
  createdAt: string;
  sources: readonly JsonRecord[];
  claims: readonly JsonRecord[];
  evidence: readonly JsonRecord[];
  verifications: readonly JsonRecord[];
  requests: readonly JsonRecord[];
  calculations: readonly JsonRecord[];
}

export type TransactionProtocolStep =
  | `${CanonicalRecordKind}-synced`
  | "records-directory-synced"
  | "manifest-synced"
  | "manifest-directory-synced"
  | "before-rename"
  | "renamed"
  | "staging-parent-synced"
  | "committed-parent-synced"
  | `mkdir-${"state" | "transactions" | "staging" | "committed" | "transaction"}-${"directory" | "parent"}-synced`
  | "staging-cleaned"
  | "staging-quarantined"
  | "quarantine-source-parent-synced"
  | "quarantine-destination-parent-synced"
  | "lock-owner-synced"
  | "lock-directory-synced"
  | "lock-active-renamed"
  | "lock-parent-synced"
  | "lock-release-renamed"
  | "lock-release-parent-synced"
  | "lock-owner-removed"
  | "lock-trash-cleaned"
  | "lock-released";

export interface RequestIndexDiagnostics {
  eventVisits: number;
  requestRecordsValidated: number;
  catalogRecordVisits?: number;
  catalogReferenceVisits?: number;
  catalogRevisionScans?: number;
}

export interface TransactionStoreOptions {
  maxFileBytes?: number;
  maxLineBytes?: number;
  maxRecords?: number;
  maxTotalRecords?: number;
  maxReferences?: number;
  maxTransactionBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxKeys?: number;
  maxArrayLength?: number;
  maxStringBytes?: number;
  maxScalarBytes?: number;
  canonicalize?: (value: unknown) => string;
  readChunk?: (handle: FileHandle, buffer: Buffer, position: number) => Promise<number>;
  durability?: (handle: FileHandle, step: TransactionProtocolStep) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  close?: (handle: FileHandle) => Promise<void>;
  isHandleReleased?: (handle: FileHandle) => boolean | Promise<boolean>;
  onStep?: (step: TransactionProtocolStep) => Promise<void>;
  pid?: number;
  now?: () => Date;
  randomToken?: () => string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  lockTrashMinAgeMs?: number;
  onAncestorCheck?: (phase: string) => void | Promise<void>;
  onReadOnlyCheck?: (phase: string, path: string) => void | Promise<void>;
  onHandleOpened?: (kind: "read-only-hierarchy" | "mutation-hierarchy" | "transaction-directory" | "transaction-file", path: string, handle: FileHandle) => void | Promise<void>;
  requestIndexDiagnostics?: RequestIndexDiagnostics;
}

export interface TransactionManifestRef {
  transactionId: TransactionId;
  relativePath: string;
  sha256: string;
}

export interface PreparedTransaction {
  manifest: CanonicalTransactionManifest;
  manifestSha256: string;
  manifestPath: string;
}

export interface VerifiedTransaction extends PreparedTransaction {
  records: Record<CanonicalRecordKind, JsonRecord[]>;
}

export type TransactionReconciliationDecision = Readonly<{
  kind: "finish-transaction";
  transactionId: TransactionId;
}>;

export interface ReadOnlyTransactionIntegrity {
  readonly committedCount: number;
  readonly pendingCount: number;
  readonly unmaterializedResultCount: number;
}

export type TransactionStoreErrorCode =
  | "transaction.invalid-input"
  | "transaction.invalid-record"
  | "transaction.cross-kind-id"
  | "transaction.duplicate-record"
  | "transaction.invalid-reference"
  | "transaction.file-too-large"
  | "transaction.too-many-records"
  | "transaction.id-conflict"
  | "transaction.staging-corrupt"
  | "transaction.not-prepared"
  | "transaction.missing-object"
  | "transaction.corrupt"
  | "transaction.unsafe-root"
  | "transaction.unsafe-file"
  | "transaction.suspicious-entry"
  | "transaction.io-failed"
  | "transaction.locked"
  | "transaction.lock-corrupt";

export class TransactionStoreError extends Error {
  readonly code: TransactionStoreErrorCode;

  constructor(code: TransactionStoreErrorCode) {
    super(`Canonical transaction operation failed (${code})`);
    this.name = "TransactionStoreError";
    this.code = code;
  }
}

export async function prepareTransaction(
  runRoot: string,
  transaction: CanonicalTransactionInput,
  options: TransactionStoreOptions = {},
): Promise<PreparedTransaction> {
  const limits = limitsFrom(options);
  preflightTransactionInput(transaction, limits);
  const snapshot = snapshotTransactionInput(transaction, limits, options);
  const root = await initializeRoot(runRoot, options);
  return withMutationLock(root, options, async () => {
    const catalog = await loadReferenceCatalog(root, limits, snapshot.transactionId, options.requestIndexDiagnostics);
    const built = buildTransaction(snapshot, limits, catalog, options.requestIndexDiagnostics);
    const committedPath = transactionDirectory(root, "committed", built.manifest.transactionId);
    if (await pathExists(committedPath)) {
      const verified = await verifyDirectory(root, "committed", built.manifest.transactionId, limits, options);
      if (verified.manifestSha256 !== built.manifestSha256) fail("transaction.id-conflict");
      return preparedResult(built.manifest, built.manifestSha256, "committed");
    }

    const stagePath = transactionDirectory(root, ".staging", built.manifest.transactionId);
    if (await pathExists(stagePath)) {
      const stageEntries = await readdir(stagePath, { withFileTypes: true }).catch(() => fail("transaction.staging-corrupt"));
      if (stageEntries.length === 0) {
        await rmdir(stagePath).catch(() => fail("transaction.staging-corrupt"));
        await syncDirectory(join(root, ".state/transactions/.staging"), "staging-parent-synced", options);
      } else {
        let verified: VerifiedTransaction;
        try {
          verified = await verifyDirectory(root, ".staging", built.manifest.transactionId, limits, options);
        } catch {
          fail("transaction.staging-corrupt");
        }
        if (verified.manifestSha256 !== built.manifestSha256) fail("transaction.id-conflict");
        return preparedResult(built.manifest, built.manifestSha256, ".staging");
      }
    }

    try {
      await createDurableDirectory(stagePath, join(root, ".state/transactions/.staging"), "transaction", options);
      for (const kind of KINDS) {
        await writeRecordFile(join(stagePath, `${kind}.jsonl`), built.records[kind], `${kind}-synced`, options, limits);
      }
      await syncDirectory(stagePath, "records-directory-synced", options);
      await writeExclusiveFile(join(stagePath, MANIFEST_FILE), built.manifestBytes, "manifest-synced", options);
      await syncDirectory(stagePath, "manifest-directory-synced", options);
    } catch (error) {
      throw normalize(error);
    }
    return preparedResult(built.manifest, built.manifestSha256, ".staging");
  });
}

export async function commitTransaction(
  runRoot: string,
  transactionId: TransactionId,
  options: TransactionStoreOptions = {},
): Promise<TransactionManifestRef> {
  const root = await initializeRoot(runRoot, options);
  assertId(transactionId, ID_PATTERNS.transaction, "transaction.invalid-input");
  return withMutationLock(root, options, async (guard) => {
    const limits = limitsFrom(options);
    const committedPath = transactionDirectory(root, "committed", transactionId);
    if (await pathExists(committedPath)) {
      const existing = await verifyDirectory(root, "committed", transactionId, limits, options);
      const stagePath = transactionDirectory(root, ".staging", transactionId);
      if (await pathExists(stagePath)) {
        await cleanupMatchingStaging(root, transactionId, existing, limits, options, guard);
        await syncCleanupParents(root, options);
      } else {
        await syncRenameParents(root, options);
      }
      return manifestRef(existing.manifest, existing.manifestSha256);
    }

    const staged = await verifyDirectory(root, ".staging", transactionId, limits, options).catch((error) => {
      if (error instanceof TransactionStoreError && error.code === "transaction.missing-object") fail("transaction.not-prepared");
      throw error;
    });
    const catalog = await loadReferenceCatalog(root, limits, transactionId, options.requestIndexDiagnostics);
    validateCatalogAndReferences(staged.records, catalog, limits, options.requestIndexDiagnostics);
    const stagePath = transactionDirectory(root, ".staging", transactionId);
    await protocolStep("before-rename", options);
    await assertPinnedHierarchy(guard, "before-rename", options);
    try {
      await (options.rename ?? nodeRename)(stagePath, committedPath);
    } catch {
      fail("transaction.io-failed");
    }
    await assertPinnedHierarchy(guard, "after-rename", options);
    await protocolStep("renamed", options);
    await syncRenameParents(root, options);
    const verified = await verifyDirectory(root, "committed", transactionId, limits, options);
    if (verified.manifestSha256 !== staged.manifestSha256) fail("transaction.corrupt");
    return manifestRef(verified.manifest, verified.manifestSha256);
  });
}

export async function verifyTransaction(
  runRoot: string,
  reference: TransactionManifestRef,
  options: TransactionStoreOptions = {},
): Promise<VerifiedTransaction> {
  const snapshot = snapshotManifestRef(reference);
  const root = await initializeRoot(runRoot, options);
  assertManifestRef(snapshot);
  return withRootLock(root, async () => {
    const verified = await verifyDirectory(root, "committed", snapshot.transactionId, limitsFrom(options), options);
    if (snapshot.relativePath !== manifestRef(verified.manifest, verified.manifestSha256).relativePath
      || snapshot.sha256 !== verified.manifestSha256) fail("transaction.corrupt");
    return verified;
  });
}

export async function listCommittedTransactions(
  runRoot: string,
  options: TransactionStoreOptions = {},
): Promise<VerifiedTransaction[]> {
  const root = await initializeRoot(runRoot, options);
  return withRootLock(root, async () => {
    const directory = join(root, ".state/transactions/committed");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("transaction.io-failed"));
    const names = entries.map((entry) => {
      if (!entry.isDirectory() || !ID_PATTERNS.transaction.test(entry.name)) fail("transaction.suspicious-entry");
      return entry.name as TransactionId;
    }).sort();
    const output: VerifiedTransaction[] = [];
    for (const transactionId of names) output.push(await verifyDirectory(root, "committed", transactionId, limitsFrom(options), options));
    return output;
  });
}

/**
 * Verifies canonical transaction objects without creating directories, lock
 * files, cleanup entries, or materialized state. The caller must already hold
 * a pinned integrity view of the run root.
 */
export async function inspectCanonicalTransactionsReadOnly(
  runRoot: string,
  events: readonly FoundationLedgerEvent[],
  options: TransactionStoreOptions = {},
): Promise<ReadOnlyTransactionIntegrity> {
  const reduced = reduceLedgerEvents(events);
  const ledger = canonicalLedgerLinks(events);
  const requestIndex = buildCanonicalRequestIndex(events, options.requestIndexDiagnostics);
  const root = resolve(runRoot);
  await assertSafeDirectory(root);
  const stateDirectory = join(root, ".state");
  if (await pathExists(stateDirectory)) await assertOwnedDirectory(stateDirectory);
  const transactionsDirectory = join(stateDirectory, "transactions");
  if (await pathExists(transactionsDirectory)) await assertOwnedDirectory(transactionsDirectory);
  const committedRoot = join(transactionsDirectory, "committed");
  if (await pathExists(committedRoot)) await assertOwnedDirectory(committedRoot);
  const limits = limitsFrom(options);
  const guard = await pinReadOnlyHierarchy(root, options);
  let result: ReadOnlyTransactionIntegrity | undefined;
  let failure: unknown;
  try {
    await assertPinnedHierarchy(guard, "read-only-before", options);
    const results = new Map<string, Extract<FoundationLedgerEvent, { type: "result_recorded" }>>();
    const recordCommits = new Map<string, Extract<FoundationLedgerEvent, { type: "records_committed" }>>();
    const attemptCommits = new Set<string>();
    for (const event of events) {
      if (event.type === "result_recorded") results.set(event.payload.transactionId, event);
      if (event.type === "records_committed") recordCommits.set(event.payload.transactionId, event);
      if (event.type === "attempt_committed") attemptCommits.add(event.payload.transactionId);
    }
    const verifiedByTransaction = new Map<string, VerifiedTransaction>();
    const acceptedVerified: VerifiedTransaction[] = [];
    const catalog = emptyCatalog();
    for (const event of events) {
      if (event.type === "records_committed") {
        const result = results.get(event.payload.transactionId);
        const attempt = result ? ledger.attempts.get(result.payload.attemptId) : undefined;
        if (!result || !attempt) fail("transaction.corrupt");
        const verified = await verifyCommittedEvent(root, event, limits, options);
        assertResultManifestLink(result, verified.manifest, ledger.runId, attempt);
        assertCanonicalRequestRecords(verified.records.requests, requestIndex, options.requestIndexDiagnostics);
        verifiedByTransaction.set(event.payload.transactionId, verified);
      }
      if (event.type === "attempt_committed") {
        const verified = verifiedByTransaction.get(event.payload.transactionId);
        if (!verified) fail("transaction.corrupt");
        acceptedVerified.push(verified);
      }
    }
    acceptedVerified.sort((left, right) => left.manifest.sourceResultSeq - right.manifest.sourceResultSeq);
    for (const verified of acceptedVerified) {
      validateCatalogAndReferences(verified.records, catalog, limits, options.requestIndexDiagnostics);
    }
    let pendingCount = 0;
    let unmaterializedResultCount = 0;
    for (const [transactionId, result] of results) {
      if (recordCommits.has(transactionId)) {
        if (!attemptCommits.has(transactionId)) {
          const attempt = ledger.attempts.get(result.payload.attemptId);
          if (!attempt) fail("transaction.corrupt");
          const decision = recoveryDecisionFor(reduced, attempt.logicalOperationId);
          if (decision.kind === "finish-transaction" && decision.transactionId === transactionId) pendingCount++;
        }
        continue;
      }
      const attempt = ledger.attempts.get(result.payload.attemptId);
      if (!attempt) fail("transaction.corrupt");
      const directory = transactionDirectory(root, "committed", transactionId as TransactionId);
      const materialized = await pathExists(directory);
      if (materialized) {
        const verified = await verifyDirectory(root, "committed", transactionId as TransactionId, limits, options);
        assertResultManifestLink(result, verified.manifest, ledger.runId, attempt);
        const decision = recoveryDecisionFor(reduced, attempt.logicalOperationId);
        if (decision.kind === "finish-transaction" && decision.transactionId === transactionId) {
          validateCatalogAndReferences(verified.records, catalog, limits, options.requestIndexDiagnostics, false);
          assertCanonicalRequestRecords(verified.records.requests, requestIndex, options.requestIndexDiagnostics);
          pendingCount++;
        }
      } else {
        unmaterializedResultCount++;
      }
    }
    const committedDirectory = join(root, ".state/transactions/committed");
    if (await pathExists(committedDirectory)) {
      await assertOwnedDirectory(committedDirectory);
      const entries = await readdir(committedDirectory, { withFileTypes: true }).catch(() => fail("transaction.io-failed"));
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !ID_PATTERNS.transaction.test(entry.name)) fail("transaction.suspicious-entry");
        if (!results.has(entry.name)) fail("transaction.corrupt");
      }
    } else if (recordCommits.size > 0) {
      fail("transaction.missing-object");
    }
    await assertPinnedHierarchy(guard, "read-only-after", options);
    result = Object.freeze({ committedCount: attemptCommits.size, pendingCount, unmaterializedResultCount });
  } catch (error) {
    failure = error;
  }
  for (const item of [...guard].reverse()) failure = await closeForOperation(item.handle, options, failure);
  if (failure) throw failure;
  return result!;
}

export async function reconcileCanonicalTransactions(
  runRoot: string,
  events: readonly FoundationLedgerEvent[],
  options: TransactionStoreOptions = {},
): Promise<TransactionReconciliationDecision[]> {
  const reduced = reduceLedgerEvents(events);
  const ledger = canonicalLedgerLinks(events);
  const requestIndex = buildCanonicalRequestIndex(events, options.requestIndexDiagnostics);
  const root = await initializeRoot(runRoot, options);
  return withMutationLock(root, options, async () => {
    const results = new Map<string, Extract<FoundationLedgerEvent, { type: "result_recorded" }>>();
    const commits = new Map<string, Extract<FoundationLedgerEvent, { type: "records_committed" }>>();
    for (const event of events) {
      if (event.type === "result_recorded") results.set(event.payload.transactionId, event);
      if (event.type === "records_committed") commits.set(event.payload.transactionId, event);
    }
    const ledgerCatalog = emptyCatalog();
    const accepted = new Set(events.filter((event) => event.type === "attempt_committed").map((event) => event.payload.transactionId));
    const committedObjects: VerifiedTransaction[] = [];
    for (const event of events) {
      if (event.type !== "records_committed") continue;
      const verified = await verifyCommittedEvent(root, event, limitsFrom(options), options);
      assertCanonicalRequestRecords(verified.records.requests, requestIndex, options.requestIndexDiagnostics);
      if (accepted.has(event.payload.transactionId)) committedObjects.push(verified);
    }
    committedObjects.sort((left, right) => left.manifest.sourceResultSeq - right.manifest.sourceResultSeq);
    for (const verified of committedObjects) {
      validateCatalogAndReferences(verified.records, ledgerCatalog, limitsFrom(options), options.requestIndexDiagnostics);
    }
    const decisions: TransactionReconciliationDecision[] = [];
    for (const [transactionId, result] of results) {
      const commit = commits.get(transactionId);
      const attempt = ledger.attempts.get(result.payload.attemptId);
      if (!attempt) fail("transaction.corrupt");
      if (commit) {
        const verified = await verifyCommittedEvent(root, commit, limitsFrom(options), options);
        assertResultManifestLink(result, verified.manifest, ledger.runId, attempt);
      } else {
        const directory = transactionDirectory(root, "committed", transactionId as TransactionId);
        if (await pathExists(directory)) {
          const verified = await verifyDirectory(root, "committed", transactionId as TransactionId, limitsFrom(options), options);
          assertResultManifestLink(result, verified.manifest, ledger.runId, attempt);
          const decision = recoveryDecisionFor(reduced, attempt.logicalOperationId);
          if (decision.kind === "finish-transaction" && decision.transactionId === transactionId) {
            validateCatalogAndReferences(verified.records, ledgerCatalog, limitsFrom(options), options.requestIndexDiagnostics, false);
            assertCanonicalRequestRecords(verified.records.requests, requestIndex, options.requestIndexDiagnostics);
            decisions.push(Object.freeze({ kind: "finish-transaction", transactionId: transactionId as TransactionId }));
          }
        }
      }
    }
    for (const commit of commits.values()) {
      if (!results.has(commit.payload.transactionId)) fail("transaction.corrupt");
      await verifyCommittedEvent(root, commit, limitsFrom(options), options);
    }
    const committedEntries = await readdir(join(root, ".state/transactions/committed"), { withFileTypes: true })
      .catch(() => fail("transaction.io-failed"));
    for (const entry of committedEntries) {
      if (!entry.isDirectory() || !ID_PATTERNS.transaction.test(entry.name)) fail("transaction.suspicious-entry");
      if (!results.has(entry.name)) fail("transaction.corrupt");
    }
    return decisions;
  });
}

export async function reconstructCanonicalRecords(
  runRoot: string,
  events: readonly FoundationLedgerEvent[],
  options: TransactionStoreOptions = {},
): Promise<Record<CanonicalRecordKind, JsonRecord[]>> {
  reduceLedgerEvents(events);
  await reconcileCanonicalTransactions(runRoot, events, options);
  const root = await initializeRoot(runRoot, options);
  return withRootLock(root, async () => {
    const accepted = new Set(events.filter((event) => event.type === "attempt_committed").map((event) => event.payload.transactionId));
    const output: Record<CanonicalRecordKind, JsonRecord[]> = {
      sources: [], claims: [], evidence: [], verifications: [], requests: [], calculations: [],
    };
    const identities = new Set<string>();
    for (const event of events) {
      if (event.type !== "records_committed" || !accepted.has(event.payload.transactionId)) continue;
      const verified = await verifyCommittedEvent(root, event, limitsFrom(options), options);
      for (const kind of KINDS) {
        const metadata = KIND_ID[kind];
        for (const record of verified.records[kind]) {
          const key = recordKey(kind, record, metadata);
          const global = `${kind}\0${key}`;
          if (identities.has(global)) fail("transaction.duplicate-record");
          identities.add(global);
          output[kind].push(structuredClone(record));
        }
      }
    }
    return output;
  });
}

interface Limits extends StructuralLimits {
  maxFileBytes: number;
  maxLineBytes: number;
  maxRecords: number;
  readChunk: (handle: FileHandle, buffer: Buffer, position: number) => Promise<number>;
  maxTotalRecords: number;
  maxReferences: number;
  maxTransactionBytes: number;
}
interface BuiltTransaction {
  manifest: CanonicalTransactionManifest;
  manifestBytes: Buffer;
  manifestSha256: string;
  records: Record<CanonicalRecordKind, JsonRecord[]>;
}

function preflightTransactionInput(input: CanonicalTransactionInput, limits: Limits): void {
  if (utilTypes.isProxy(input) || input === null || typeof input !== "object" || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) fail("transaction.invalid-input");
  const rootDescriptors = Object.getOwnPropertyDescriptors(input);
  const rootKeys = Reflect.ownKeys(rootDescriptors);
  if (rootKeys.length !== INPUT_KEYS.size || rootKeys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))) fail("transaction.invalid-input");
  for (const key of INPUT_KEYS) {
    const descriptor = rootDescriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("transaction.invalid-input");
  }
  let total = 0;
  for (const kind of KINDS) {
    const descriptor = rootDescriptors[kind];
    if (!descriptor || !("value" in descriptor) || utilTypes.isProxy(descriptor.value)
      || !Array.isArray(descriptor.value) || Object.getPrototypeOf(descriptor.value) !== Array.prototype) fail("transaction.invalid-input");
    const length = descriptor.value.length;
    if (!Number.isSafeInteger(length) || length > limits.maxRecords) fail("transaction.too-many-records");
    total += length;
    if (total > limits.maxTotalRecords) fail("transaction.too-many-records");
  }
  try { assertBoundedStructure(input, limits); }
  catch (error) { if (error instanceof StructuralLimitError) fail(error.reason === "unsafe" ? "transaction.invalid-input" : "transaction.file-too-large"); throw error; }
}

function snapshotTransactionInput(input: CanonicalTransactionInput, limits: Limits, options: TransactionStoreOptions): CanonicalTransactionInput {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot = Object.create(null) as Record<string, unknown>;
    const encode = options.canonicalize ?? canonicalJson;
    for (const key of ["schemaVersion", "transactionId", "runId", "attemptId", "sourceResultSeq", "createdAt"] as const) {
      snapshot[key] = JSON.parse(encode(descriptors[key]!.value));
    }
    let totalBytes = 0;
    for (const kind of KINDS) {
      const values = descriptors[kind]!.value as unknown[];
      const records: unknown[] = [];
      const keys = Reflect.ownKeys(values);
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= values.length)))) fail("transaction.invalid-input");
      for (let index = 0; index < values.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("transaction.invalid-input");
        const canonical = encode(descriptor.value);
        const bytes = Buffer.byteLength(canonical) + 1;
        if (bytes > limits.maxLineBytes) fail("transaction.file-too-large");
        totalBytes += bytes;
        if (totalBytes > limits.maxTransactionBytes) fail("transaction.file-too-large");
        records.push(JSON.parse(canonical));
      }
      snapshot[kind] = records;
    }
    return snapshot as unknown as CanonicalTransactionInput;
  } catch (error) {
    if (error instanceof TransactionStoreError) throw error;
    fail("transaction.invalid-input");
  }
}

function buildTransaction(input: CanonicalTransactionInput, limits: Limits, catalog: ReferenceCatalog, diagnostics?: RequestIndexDiagnostics): BuiltTransaction {
  validateInputRoot(input);
  const manifestFiles: CanonicalTransactionManifest["files"] = [];
  const recordsByKind = Object.create(null) as Record<CanonicalRecordKind, JsonRecord[]>;
  let transactionBytes = 0;
  for (const kind of KINDS) {
    const records = validateAndSortRecords(kind, input[kind], input.attemptId, limits);
    recordsByKind[kind] = records;
    const hash = createHash("sha256");
    let decodedBytes = 0;
    for (const record of records) {
      const line = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
      if (line.byteLength > limits.maxLineBytes) fail("transaction.file-too-large");
      decodedBytes += line.byteLength;
      if (decodedBytes > limits.maxFileBytes) fail("transaction.file-too-large");
      hash.update(line);
    }
    transactionBytes += decodedBytes;
    if (transactionBytes > limits.maxTransactionBytes) fail("transaction.file-too-large");
    manifestFiles.push({ kind, relativePath: `${kind}.jsonl`, recordCount: records.length, decodedBytes, sha256: hash.digest("hex") });
  }
  validateCatalogAndReferences(recordsByKind, catalog, limits, diagnostics);
  const refs = referencesFrom(recordsByKind);
  const manifest: CanonicalTransactionManifest = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    runId: input.runId,
    attemptId: input.attemptId,
    sourceResultSeq: input.sourceResultSeq,
    createdAt: input.createdAt,
    files: manifestFiles,
    ...refs,
  };
  const parsed = parse(CanonicalTransactionManifestSchema, manifest);
  if (!parsed.success) fail("transaction.invalid-input");
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  if (manifestBytes.byteLength > limits.maxLineBytes || transactionBytes + manifestBytes.byteLength > limits.maxTransactionBytes) fail("transaction.file-too-large");
  return { manifest: structuredClone(manifest), manifestBytes, manifestSha256: sha256Hex(manifestBytes), records: recordsByKind };
}

function validateInputRoot(input: CanonicalTransactionInput): void {
  if (utilTypes.isProxy(input) || input === null || typeof input !== "object" || Array.isArray(input)) fail("transaction.invalid-input");
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) fail("transaction.invalid-input");
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key)) || keys.length !== INPUT_KEYS.size) fail("transaction.invalid-input");
  if (input.schemaVersion !== 1 || !ID_PATTERNS.transaction.test(input.transactionId)
    || !ID_PATTERNS.run.test(input.runId) || !ID_PATTERNS.attempt.test(input.attemptId)
    || !Number.isSafeInteger(input.sourceResultSeq) || input.sourceResultSeq < 1 || !isTimestamp(input.createdAt)
    || KINDS.some((kind) => !Array.isArray(input[kind]) || Object.getPrototypeOf(input[kind]) !== Array.prototype)) fail("transaction.invalid-input");
}

function validateAndSortRecords(kind: CanonicalRecordKind, values: readonly JsonRecord[], attemptId: string, limits: Limits): JsonRecord[] {
  if (values.length > limits.maxRecords) fail("transaction.too-many-records");
  const metadata = KIND_ID[kind];
  const seen = new Set<string>();
  const output = values.map((inputRecord) => {
    const record = inputRecord as JsonRecord;
    for (const field of ALL_ID_FIELDS) {
      if (field !== metadata.field && Object.prototype.hasOwnProperty.call(record, field)
        && !(kind === "evidence" && field === "calculationId")) fail("transaction.cross-kind-id");
    }
    const parsedRecord = parseResearchRecord(kind, inputRecord);
    if (!parsedRecord.success) fail(kind === "requests" && parsedRecord.issues.some((item) => item.code.startsWith("request."))
      ? "transaction.invalid-reference" : "transaction.invalid-record");
    const validatedRecord = parsedRecord.value as JsonRecord;
    const id = validatedRecord[metadata.field];
    if (typeof id !== "string" || !metadata.pattern.test(id)) fail("transaction.invalid-record");
    if (metadata.revision && (!Number.isSafeInteger(validatedRecord.revision) || (validatedRecord.revision as number) < 1)) fail("transaction.invalid-record");
    if (!metadata.revision && Object.prototype.hasOwnProperty.call(validatedRecord, "revision")) fail("transaction.invalid-record");
    if (kind === "requests") {
      const parsed = parse(RequestRecordSchema, validatedRecord);
      if (!parsed.success || parsed.value.attemptId !== attemptId) fail("transaction.invalid-record");
    }
    const cloned = JSON.parse(canonicalJson(validatedRecord)) as JsonRecord;
    const stableId = String(cloned[metadata.field]);
    if (seen.has(stableId)) fail("transaction.duplicate-record");
    seen.add(stableId);
    const lineBytes = Buffer.byteLength(canonicalJson(cloned)) + 1;
    if (lineBytes > limits.maxLineBytes) fail("transaction.file-too-large");
    return cloned;
  });
  output.sort((left, right) => {
    const leftId = left[metadata.field] as string;
    const rightId = right[metadata.field] as string;
    return compareCodeUnits(leftId, rightId) || Number(left.revision ?? 0) - Number(right.revision ?? 0);
  });
  return output;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordKey(kind: CanonicalRecordKind, record: JsonRecord, metadata = KIND_ID[kind]): string {
  return metadata.revision ? `${String(record[metadata.field])}\0${String(record.revision)}` : String(record[metadata.field]);
}

function referencesFrom(records: Record<CanonicalRecordKind, JsonRecord[]>): Pick<CanonicalTransactionManifest,
  "sourceRefs" | "claimRefs" | "evidenceRefs" | "verificationRefs" | "requestIds" | "calculationIds"> {
  return {
    sourceRefs: records.sources.map((record) => ({ sourceId: record.sourceId as `src-${string}`, revision: record.revision as number })),
    claimRefs: records.claims.map((record) => ({ claimId: record.claimId as `claim-${string}`, revision: record.revision as number })),
    evidenceRefs: records.evidence.map((record) => ({ evidenceId: record.evidenceId as `ev-${string}`, revision: record.revision as number })),
    verificationRefs: records.verifications.map((record) => ({ verificationId: record.verificationId as `verify-${string}`, revision: record.revision as number })),
    requestIds: records.requests.map((record) => record.requestId as `request-${string}`),
    calculationIds: records.calculations.map((record) => record.calculationId as `calc-${string}`),
  };
}

interface ReferenceCatalog {
  readonly revisions: Record<CanonicalRecordKind, Map<string, Map<number, string>>>;
  readonly highestRevision: Record<CanonicalRecordKind, Map<string, number>>;
  readonly requestById: Map<string, JsonRecord>;
  readonly requestSeriesOrdinal: Map<string, string>;
}

function emptyCatalog(): ReferenceCatalog {
  return {
    revisions: Object.fromEntries(KINDS.map((kind) => [kind, new Map()])) as ReferenceCatalog["revisions"],
    highestRevision: Object.fromEntries(KINDS.map((kind) => [kind, new Map()])) as ReferenceCatalog["highestRevision"],
    requestById: new Map(),
    requestSeriesOrdinal: new Map(),
  };
}

async function loadReferenceCatalog(
  root: string,
  limits: Limits,
  excludeTransactionId: string,
  diagnostics?: RequestIndexDiagnostics,
): Promise<ReferenceCatalog> {
  const directory = join(root, ".state/transactions/committed");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("transaction.io-failed"));
  const transactions: VerifiedTransaction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERNS.transaction.test(entry.name)) fail("transaction.suspicious-entry");
    if (entry.name !== excludeTransactionId) transactions.push(await verifyDirectory(root, "committed", entry.name, limits));
  }
  transactions.sort((left, right) => left.manifest.sourceResultSeq - right.manifest.sourceResultSeq);
  const catalog = emptyCatalog();
  for (const transaction of transactions) validateCatalogAndReferences(transaction.records, catalog, limits, diagnostics);
  return catalog;
}

function validateCatalogAndReferences(
  records: Record<CanonicalRecordKind, JsonRecord[]>,
  catalog: ReferenceCatalog,
  limits: Limits,
  diagnostics?: RequestIndexDiagnostics,
  apply = true,
): void {
  const staged = emptyCatalog();
  for (const kind of KINDS) {
    const metadata = KIND_ID[kind];
    for (const record of records[kind]) {
      if (diagnostics) diagnostics.catalogRecordVisits = (diagnostics.catalogRecordVisits ?? 0) + 1;
      const id = String(record[metadata.field]);
      const revision = metadata.revision ? Number(record.revision) : 0;
      if (catalog.revisions[kind].get(id)?.has(revision) || staged.revisions[kind].get(id)?.has(revision)) fail("transaction.duplicate-record");
      const priorHighest = staged.highestRevision[kind].get(id) ?? catalog.highestRevision[kind].get(id) ?? 0;
      if (metadata.revision && revision !== priorHighest + 1) fail("transaction.invalid-reference");
      if (!metadata.revision && (catalog.revisions[kind].has(id) || staged.revisions[kind].has(id))) fail("transaction.duplicate-record");
      let revisions = staged.revisions[kind].get(id);
      if (!revisions) { revisions = new Map(); staged.revisions[kind].set(id, revisions); }
      revisions.set(revision, canonicalJson(record));
      staged.highestRevision[kind].set(id, revision);
      if (kind === "requests") {
        const seriesOrdinal = `${String(record.logicalRequestId)}\0${String(record.physicalAttemptOrdinal)}`;
        if (catalog.requestSeriesOrdinal.has(seriesOrdinal) || staged.requestSeriesOrdinal.has(seriesOrdinal)) fail("transaction.invalid-reference");
        staged.requestById.set(id, record);
        staged.requestSeriesOrdinal.set(seriesOrdinal, id);
      }
    }
  }
  let referenceCount = 0;
  const countReference = () => {
    referenceCount += 1;
    if (diagnostics) diagnostics.catalogReferenceVisits = (diagnostics.catalogReferenceVisits ?? 0) + 1;
    if (referenceCount > limits.maxReferences) fail("transaction.too-many-records");
  };
  const exact = (kind: CanonicalRecordKind, id: unknown, revision = 0) => {
    countReference();
    if (typeof id !== "string" || !(staged.revisions[kind].get(id)?.has(revision) || catalog.revisions[kind].get(id)?.has(revision))) fail("transaction.invalid-reference");
  };
  const stable = (kind: CanonicalRecordKind, id: unknown) => {
    countReference();
    if (typeof id !== "string" || !(staged.revisions[kind].has(id) || catalog.revisions[kind].has(id))) fail("transaction.invalid-reference");
  };
  for (const source of records.sources) {
    for (const id of source.retrievalRequestIds as string[]) stable("requests", id);
    for (const step of source.metadataProvenance as { requestId: string }[]) stable("requests", step.requestId);
    for (const id of (source.lineage as { relatedSourceIds: string[] }).relatedSourceIds) stable("sources", id);
  }
  for (const claim of records.claims) {
    for (const ref of claim.evidenceRefs as { evidenceId: string; revision: number }[]) exact("evidence", ref.evidenceId, ref.revision);
    for (const id of claim.conflictClaimIds as string[]) stable("claims", id);
  }
  for (const evidence of records.evidence) {
    const claimRef = evidence.claimRef as { claimId: string; revision: number };
    exact("claims", claimRef.claimId, claimRef.revision);
    const sourceRef = evidence.sourceRef as { sourceId: string; revision: number } | null;
    if (sourceRef) exact("sources", sourceRef.sourceId, sourceRef.revision);
    if (evidence.calculationId !== null) stable("calculations", evidence.calculationId);
    for (const id of evidence.conflictsWith as string[]) stable("evidence", id);
  }
  for (const request of records.requests) {
    for (const sourceId of request.resultSourceIds as string[]) stable("sources", sourceId);
    const ordinal = request.physicalAttemptOrdinal as number;
    const predecessorId = request.retryOfRequestId as string | null;
    if (ordinal === 1) {
      if (predecessorId !== null) fail("transaction.invalid-reference");
      continue;
    }
    if (predecessorId === null || predecessorId === request.requestId) fail("transaction.invalid-reference");
    countReference();
    const predecessor = staged.requestById.get(predecessorId) ?? catalog.requestById.get(predecessorId);
    if (!predecessor || predecessor.logicalRequestId !== request.logicalRequestId
      || predecessor.physicalAttemptOrdinal !== ordinal - 1
      || !sameRequestSeriesIdentity(predecessor, request)) fail("transaction.invalid-reference");
  }
  for (const verification of records.verifications) {
    for (const ref of verification.checkedClaims as { claimId: string; revision: number }[]) exact("claims", ref.claimId, ref.revision);
    for (const ref of verification.checkedEvidence as { evidenceId: string; revision: number }[]) exact("evidence", ref.evidenceId, ref.revision);
    for (const id of verification.requestIds as string[]) stable("requests", id);
    for (const id of verification.calculationIds as string[]) stable("calculations", id);
    for (const item of verification.corrections as { claimId: string }[]) stable("claims", item.claimId);
    for (const id of verification.independentEvidenceIds as string[]) stable("evidence", id);
  }
  if (apply) applyCatalogAdditions(catalog, staged);
}

function applyCatalogAdditions(catalog: ReferenceCatalog, staged: ReferenceCatalog): void {
  for (const kind of KINDS) {
    for (const [id, additions] of staged.revisions[kind]) {
      let revisions = catalog.revisions[kind].get(id);
      if (!revisions) { revisions = new Map(); catalog.revisions[kind].set(id, revisions); }
      for (const [revision, encoded] of additions) revisions.set(revision, encoded);
      catalog.highestRevision[kind].set(id, staged.highestRevision[kind].get(id)!);
    }
  }
  for (const [id, record] of staged.requestById) catalog.requestById.set(id, record);
  for (const [key, id] of staged.requestSeriesOrdinal) catalog.requestSeriesOrdinal.set(key, id);
}

interface CanonicalRequestIndex {
  readonly result: (requestId: string) => JsonRecord | undefined;
  readonly start: (requestId: string) => Extract<FoundationLedgerEvent, { type: "request_retry_started" }> | undefined;
  readonly schedule: (scheduleId: string) => Extract<FoundationLedgerEvent, { type: "request_retry_scheduled" }> | undefined;
}

function buildCanonicalRequestIndex(
  events: readonly FoundationLedgerEvent[],
  diagnostics?: RequestIndexDiagnostics,
): CanonicalRequestIndex {
  const results = new Map<string, JsonRecord>();
  const starts = new Map<string, Extract<FoundationLedgerEvent, { type: "request_retry_started" }>>();
  const schedules = new Map<string, Extract<FoundationLedgerEvent, { type: "request_retry_scheduled" }>>();
  for (const event of events) {
    if (diagnostics) diagnostics.eventVisits += 1;
    if (event.type === "request_result_recorded") {
      if (results.has(event.payload.request.requestId)) fail("transaction.invalid-reference");
      results.set(event.payload.request.requestId, event.payload.request as unknown as JsonRecord);
    } else if (event.type === "request_retry_started") {
      if (starts.has(event.payload.requestId)) fail("transaction.invalid-reference");
      starts.set(event.payload.requestId, event);
    } else if (event.type === "request_retry_scheduled") {
      if (schedules.has(event.payload.scheduleId)) fail("transaction.invalid-reference");
      schedules.set(event.payload.scheduleId, event);
    }
  }
  return Object.freeze({
    result: (requestId: string) => results.get(requestId),
    start: (requestId: string) => starts.get(requestId),
    schedule: (scheduleId: string) => schedules.get(scheduleId),
  });
}

function assertCanonicalRequestRecords(
  records: readonly JsonRecord[],
  index: CanonicalRequestIndex,
  diagnostics?: RequestIndexDiagnostics,
): void {
  for (const record of records) {
    if (diagnostics) diagnostics.requestRecordsValidated += 1;
    const requestId = String(record.requestId);
    const canonical = index.result(requestId);
    if (!canonical || canonicalJson(canonical) !== canonicalJson(record)) fail("transaction.invalid-reference");
    if (Number(record.physicalAttemptOrdinal) > 1) {
      const start = index.start(requestId);
      const schedule = start ? index.schedule(start.payload.scheduleId) : undefined;
      if (!start || !schedule || start.payload.scheduledFromLedgerSeq !== schedule.seq
        || start.payload.attemptId !== record.attemptId
        || start.payload.physicalAttemptOrdinal !== record.physicalAttemptOrdinal
        || schedule.payload.failedRequestId !== record.retryOfRequestId
        || schedule.payload.nextPhysicalAttemptOrdinal !== record.physicalAttemptOrdinal) fail("transaction.invalid-reference");
      const predecessor = index.result(schedule.payload.failedRequestId);
      if (!predecessor || predecessor.status !== "retryable-error") fail("transaction.invalid-reference");
    }
  }
}

function sameRequestSeriesIdentity(left: JsonRecord, right: JsonRecord): boolean {
  return canonicalJson({ logicalRequestId: left.logicalRequestId, replayPolicy: left.replayPolicy,
    provider: left.provider, operation: left.operation, normalizedInput: left.normalizedInput, accessPolicySha256: left.accessPolicySha256 })
    === canonicalJson({ logicalRequestId: right.logicalRequestId, replayPolicy: right.replayPolicy,
      provider: right.provider, operation: right.operation, normalizedInput: right.normalizedInput, accessPolicySha256: right.accessPolicySha256 });
}

interface PinnedTransactionDirectory {
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

async function verifyDirectory(
  root: string,
  location: ".staging" | "committed",
  transactionId: string,
  limits: Limits,
  options: TransactionStoreOptions = {},
): Promise<VerifiedTransaction> {
  const directory = transactionDirectory(root, location, transactionId);
  if (!(await pathExists(directory))) fail("transaction.missing-object");
  let container: PinnedTransactionDirectory | undefined;
  let pinned: PinnedTransactionDirectory | undefined;
  const children: PinnedReadFile[] = [];
  let result: VerifiedTransaction | undefined;
  let failure: unknown;
  try {
    container = await pinTransactionDirectory(dirname(directory), options);
    pinned = await pinTransactionDirectory(directory, options);
    await assertPinnedTransactionDirectory(container);
    await invokeReadOnlyCheck(options, "transaction-directory-pinned", directory);
    await assertPinnedTransactionDirectory(container);
    await assertPinnedTransactionDirectory(pinned);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("transaction.corrupt"));
    await assertPinnedTransactionDirectory(container);
    await assertPinnedTransactionDirectory(pinned);
    const expected = new Set([...KINDS.map((kind) => `${kind}.jsonl`), MANIFEST_FILE]);
    if (entries.some((entry) => entry.isSymbolicLink())) fail("transaction.unsafe-file");
    if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || !expected.has(entry.name))) fail("transaction.corrupt");

    const manifestFile = await openAndReadPinnedFile(join(directory, MANIFEST_FILE), Math.min(limits.maxFileBytes, limits.maxLineBytes), limits, pinned, options);
    children.push(manifestFile);
    const manifestBytes = manifestFile.bytes;
    let transactionBytes = manifestBytes.byteLength;
    const manifestInput = parseCanonicalSingleJson(manifestBytes, limits);
    const parsed = parse(CanonicalTransactionManifestSchema, manifestInput);
    if (!parsed.success) fail("transaction.corrupt");
    const manifest = parsed.value;
    if (manifest.transactionId !== transactionId || manifest.files.length !== KINDS.length
      || manifest.files.some((file, index) => file.kind !== KINDS[index] || file.relativePath !== `${file.kind}.jsonl`)) fail("transaction.corrupt");
    const records = Object.create(null) as Record<CanonicalRecordKind, JsonRecord[]>;
    for (const [index, kind] of KINDS.entries()) {
      const file = manifest.files[index]!;
      const pinnedFile = await openAndReadPinnedFile(join(directory, file.relativePath), limits.maxFileBytes, limits, pinned, options);
      children.push(pinnedFile);
      const bytes = pinnedFile.bytes;
      transactionBytes += bytes.byteLength;
      if (transactionBytes > limits.maxTransactionBytes) fail("transaction.file-too-large");
      if (bytes.byteLength !== file.decodedBytes || sha256Hex(bytes) !== file.sha256) fail("transaction.corrupt");
      const parsedRecords = parseJsonLines(bytes, limits);
      if (parsedRecords.length !== file.recordCount) fail("transaction.corrupt");
      records[kind] = validateAndSortRecords(kind, parsedRecords, manifest.attemptId, limits);
      if (!Buffer.from(records[kind].map((record) => `${canonicalJson(record)}\n`).join(""), "utf8").equals(bytes)) fail("transaction.corrupt");
      await assertPinnedTransactionDirectory(container);
      await assertPinnedTransactionDirectory(pinned);
    }
    const expectedRefs = referencesFrom(records);
    if (canonicalJson(expectedRefs) !== canonicalJson({
      sourceRefs: manifest.sourceRefs,
      claimRefs: manifest.claimRefs,
      evidenceRefs: manifest.evidenceRefs,
      verificationRefs: manifest.verificationRefs,
      requestIds: manifest.requestIds,
      calculationIds: manifest.calculationIds,
    })) fail("transaction.corrupt");

    await invokeReadOnlyCheck(options, "transaction-directory-final", directory);
    for (const child of children) await assertRetainedReadFile(child, pinned);
    await assertPinnedTransactionDirectory(container);
    await assertPinnedTransactionDirectory(pinned);
    result = immutableVerifiedTransaction(manifest, manifestBytes, location, transactionId, records);
  } catch (error) {
    failure = normalize(error, "transaction.unsafe-file");
  }
  for (const child of children.reverse()) failure = await closeForOperation(child.handle, options, failure);
  if (pinned) failure = await closeForOperation(pinned.handle, options, failure);
  if (container) failure = await closeForOperation(container.handle, options, failure);
  if (failure) throw failure;
  return result!;
}

async function pinTransactionDirectory(path: string, options: TransactionStoreOptions): Promise<PinnedTransactionDirectory> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | directoryFlag);
    await invokeHandleOpened(options, "transaction-directory", path, handle);
    const descriptor = await handle.stat({ bigint: true });
    const pathname = await lstat(path, { bigint: true });
    if (!descriptor.isDirectory() || pathname.isSymbolicLink() || !pathname.isDirectory()
      || descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino || descriptor.ctimeNs !== pathname.ctimeNs) fail("transaction.unsafe-file");
    return { path, handle, dev: descriptor.dev, ino: descriptor.ino, ctimeNs: descriptor.ctimeNs };
  } catch (error) {
    let failure: unknown = normalize(error, "transaction.unsafe-file");
    if (handle) failure = await closeForOperation(handle, options, failure);
    throw failure;
  }
}

async function assertPinnedTransactionDirectory(pinned: PinnedTransactionDirectory): Promise<void> {
  try {
    const [descriptor, pathname] = await Promise.all([
      pinned.handle.stat({ bigint: true }),
      lstat(pinned.path, { bigint: true }),
    ]);
    if (!descriptor.isDirectory() || pathname.isSymbolicLink() || !pathname.isDirectory()
      || descriptor.dev !== pinned.dev || descriptor.ino !== pinned.ino || descriptor.ctimeNs !== pinned.ctimeNs
      || pathname.dev !== pinned.dev || pathname.ino !== pinned.ino || pathname.ctimeNs !== pinned.ctimeNs) fail("transaction.unsafe-file");
  } catch (error) {
    throw normalize(error, "transaction.unsafe-file");
  }
}

async function invokeReadOnlyCheck(options: TransactionStoreOptions, phase: string, path: string): Promise<void> {
  try { await options.onReadOnlyCheck?.(phase, path); } catch { fail("transaction.unsafe-file"); }
}

async function invokeHandleOpened(
  options: TransactionStoreOptions,
  kind: "read-only-hierarchy" | "mutation-hierarchy" | "transaction-directory" | "transaction-file",
  path: string,
  handle: FileHandle,
): Promise<void> {
  await options.onHandleOpened?.(kind, path, handle);
}

function parseCanonicalSingleJson(bytes: Buffer, limits: Limits): unknown {
  let text: string;
  try { text = fatalUtf8.decode(bytes); } catch { fail("transaction.corrupt"); }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("transaction.corrupt");
  const body = text.slice(0, -1);
  let value: unknown;
  try { value = JSON.parse(body); } catch { fail("transaction.corrupt"); }
  try { assertBoundedStructure(value, limits); } catch { fail("transaction.corrupt"); }
  try { if (canonicalJson(value) !== body) fail("transaction.corrupt"); } catch { fail("transaction.corrupt"); }
  return value;
}

function parseJsonLines(bytes: Buffer, limits: Limits): JsonRecord[] {
  if (bytes.byteLength === 0) return [];
  let text: string;
  try { text = fatalUtf8.decode(bytes); } catch { fail("transaction.corrupt"); }
  if (!text.endsWith("\n")) fail("transaction.corrupt");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > limits.maxRecords || lines.some((line) => line.length === 0 || Buffer.byteLength(line) + 1 > limits.maxLineBytes)) fail("transaction.corrupt");
  return lines.map((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail("transaction.corrupt"); }
    try { assertBoundedStructure(value, limits); } catch { fail("transaction.corrupt"); }
    try { if (canonicalJson(value) !== line) fail("transaction.corrupt"); } catch { fail("transaction.corrupt"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("transaction.corrupt");
    return value as JsonRecord;
  });
}

async function verifyCommittedEvent(
  root: string,
  event: Extract<FoundationLedgerEvent, { type: "records_committed" }>,
  limits: Limits,
  options: TransactionStoreOptions = {},
): Promise<VerifiedTransaction> {
  const verified = await verifyDirectory(root, "committed", event.payload.transactionId, limits, options).catch((error) => {
    if (error instanceof TransactionStoreError && error.code === "transaction.missing-object") fail("transaction.missing-object");
    throw error;
  });
  const expectedRef = manifestRef(verified.manifest, verified.manifestSha256);
  if (event.payload.transactionManifestPath !== expectedRef.relativePath
    || event.payload.transactionManifestSha256 !== expectedRef.sha256
    || event.payload.sourceResultSeq !== verified.manifest.sourceResultSeq
    || canonicalJson({
      sourceRefs: event.payload.sourceRefs,
      claimRefs: event.payload.claimRefs,
      evidenceRefs: event.payload.evidenceRefs,
      verificationRefs: event.payload.verificationRefs,
      requestIds: event.payload.requestIds,
      calculationIds: event.payload.calculationIds,
    }) !== canonicalJson({
      sourceRefs: verified.manifest.sourceRefs,
      claimRefs: verified.manifest.claimRefs,
      evidenceRefs: verified.manifest.evidenceRefs,
      verificationRefs: verified.manifest.verificationRefs,
      requestIds: verified.manifest.requestIds,
      calculationIds: verified.manifest.calculationIds,
    })) fail("transaction.corrupt");
  return verified;
}

function canonicalLedgerLinks(events: readonly FoundationLedgerEvent[]): { runId: string; attempts: Map<string, AttemptRecord> } {
  const runs = events.filter((event) => event.type === "run_created");
  if (runs.length !== 1) fail("transaction.corrupt");
  const attempts = new Map<string, AttemptRecord>();
  for (const event of events) {
    if (event.type !== "dispatch_intent") continue;
    if (attempts.has(event.payload.attempt.attemptId)) fail("transaction.corrupt");
    attempts.set(event.payload.attempt.attemptId, event.payload.attempt);
  }
  return { runId: runs[0]!.payload.run.runId, attempts };
}

function assertResultManifestLink(
  event: Extract<FoundationLedgerEvent, { type: "result_recorded" }>,
  manifest: CanonicalTransactionManifest,
  runId: string,
  attempt: AttemptRecord,
): void {
  if (manifest.runId !== runId || attempt.runId !== runId
    || event.payload.transactionId !== manifest.transactionId
    || event.payload.attemptId !== attempt.attemptId
    || event.payload.attemptId !== manifest.attemptId
    || event.seq !== manifest.sourceResultSeq) fail("transaction.corrupt");
}

async function initializeRoot(runRoot: string, options: TransactionStoreOptions): Promise<string> {
  const root = resolve(runRoot);
  await assertSafeDirectory(root);
  let current = root;
  const hierarchy = [[".state", "state"], ["transactions", "transactions"], [".staging", "staging"]] as const;
  for (const [segment, label] of hierarchy) {
    const parent = current;
    current = join(current, segment);
    await ensureDurableDirectory(current, parent, label, options);
  }
  await ensureDurableDirectory(join(root, ".state/transactions/committed"), join(root, ".state/transactions"), "committed", options);
  return root;
}

async function ensureDurableDirectory(path: string, parent: string, label: "state" | "transactions" | "staging" | "committed", options: TransactionStoreOptions): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!isNodeError(error, "EEXIST")) fail("transaction.io-failed");
  }
  await assertOwnedDirectory(path);
  await syncDirectory(path, `mkdir-${label}-directory-synced`, options);
  await syncDirectory(parent, `mkdir-${label}-parent-synced`, options);
}

async function createDurableDirectory(path: string, parent: string, label: "transaction", options: TransactionStoreOptions): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch { fail("transaction.io-failed"); }
  await assertOwnedDirectory(path);
  await syncDirectory(path, `mkdir-${label}-directory-synced`, options);
  await syncDirectory(parent, `mkdir-${label}-parent-synced`, options);
}

async function assertSafeDirectory(path: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch { fail("transaction.unsafe-root"); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("transaction.unsafe-root");
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => fail("transaction.unsafe-root"));
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) fail("transaction.unsafe-root");
}

async function writeRecordFile(path: string, records: readonly JsonRecord[], step: TransactionProtocolStep, options: TransactionStoreOptions, limits: Limits): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let failure: unknown;
  let total = 0;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("transaction.unsafe-file");
    for (const record of records) {
      const line = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
      total += line.byteLength;
      if (line.byteLength > limits.maxLineBytes || total > limits.maxFileBytes) fail("transaction.file-too-large");
      await writeFully(handle, line, total - line.byteLength);
    }
    await durability(handle, step, options);
  } catch (error) { failure = error; }
  if (handle) failure = await closeForOperation(handle, options, failure);
  if (failure) throw normalize(failure);
  await protocolStep(step, options);
}

async function writeExclusiveFile(path: string, bytes: Buffer, step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("transaction.unsafe-file");
    await writeFully(handle, bytes, 0);
    await durability(handle, step, options);
  } catch (error) {
    failure = error;
  }
  if (handle) failure = await closeForOperation(handle, options, failure);
  if (failure) throw normalize(failure);
  await protocolStep(step, options);
}

async function cleanupMatchingStaging(root: string, transactionId: string, committed: VerifiedTransaction, limits: Limits, options: TransactionStoreOptions, guard: PinnedHierarchy): Promise<void> {
  const stage = transactionDirectory(root, ".staging", transactionId);
  const destination = transactionDirectory(root, "committed", transactionId);
  await assertPinnedHierarchy(guard, "before-staging-cleanup", options);
  const before = await lstat(stage).catch(() => fail("transaction.id-conflict"));
  if (!before.isDirectory() || before.isSymbolicLink()) fail("transaction.unsafe-file");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    const acquired = await open(stage, constants.O_RDONLY | noFollow | directoryFlag).catch(() => fail("transaction.unsafe-file"));
    handle = acquired;
    await invokeHandleOpened(options, "transaction-directory", stage, acquired);
    const pinned = await acquired.stat();
    if (!pinned.isDirectory() || pinned.dev !== before.dev || pinned.ino !== before.ino) fail("transaction.unsafe-file");
    const assertStage = async () => {
      await assertPinnedHierarchy(guard, "during-staging-cleanup", options);
      const current = await lstat(stage).catch(() => fail("transaction.unsafe-file"));
      const descriptor = await acquired.stat().catch(() => fail("transaction.unsafe-file"));
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== pinned.dev || current.ino !== pinned.ino
        || descriptor.dev !== pinned.dev || descriptor.ino !== pinned.ino) fail("transaction.unsafe-file");
    };
    await assertStage();
    const entries = await readdir(stage, { withFileTypes: true }).catch(() => fail("transaction.id-conflict"));
    const expected = new Set([...KINDS.map((kind) => `${kind}.jsonl`), MANIFEST_FILE]);
    const suspicious = entries.find((entry) => entry.isSymbolicLink() || !entry.isFile() || !expected.has(entry.name));
    if (suspicious) fail("transaction.unsafe-file");
    if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.name))) fail("transaction.id-conflict");
    for (const entry of entries) {
      await assertStage();
      const stagedBytes = await readSafeFile(join(stage, entry.name), limits.maxFileBytes, limits);
      const committedBytes = await readSafeFile(join(destination, entry.name), limits.maxFileBytes, limits);
      if (!stagedBytes.equals(committedBytes)) fail("transaction.id-conflict");
    }
    const stagedManifest = await verifyDirectory(root, ".staging", transactionId, limits).catch(() => fail("transaction.id-conflict"));
    if (stagedManifest.manifestSha256 !== committed.manifestSha256) fail("transaction.id-conflict");
    await assertStage();
    await assertPinnedHierarchy(guard, "before-quarantine-rename", options);
    const token = options.randomToken?.() ?? randomBytes(32).toString("hex");
    if (!/^[a-f0-9]{64}$/.test(token)) fail("transaction.invalid-input");
    const quarantine = join(root, ".state/transactions/.staging", `.quarantine-${transactionId}-${token}`);
    if (await pathExists(quarantine)) fail("transaction.id-conflict");
    await (options.rename ?? nodeRename)(stage, quarantine).catch((error) => { throw normalize(error); });
    await protocolStep("staging-quarantined", options);
    const stagingPin = guard.find((item) => item.path === join(root, ".state/transactions/.staging"));
    if (!stagingPin) fail("transaction.unsafe-root");
    await durability(stagingPin.handle, "quarantine-source-parent-synced", options);
    await protocolStep("quarantine-source-parent-synced", options);
    await durability(stagingPin.handle, "quarantine-destination-parent-synced", options);
    await protocolStep("quarantine-destination-parent-synced", options);
    await assertPinnedHierarchy(guard, "after-quarantine-rename", options);
    const quarantined = await lstat(quarantine).catch(() => fail("transaction.unsafe-file"));
    const descriptor = await acquired.stat().catch(() => fail("transaction.unsafe-file"));
    if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || quarantined.dev !== pinned.dev || quarantined.ino !== pinned.ino
      || descriptor.dev !== pinned.dev || descriptor.ino !== pinned.ino) fail("transaction.unsafe-file");
  } catch (error) {
    failure = error;
  }
  if (handle) failure = await closeForOperation(handle, options, failure);
  if (failure) throw normalize(failure, "transaction.unsafe-file");
}

/**
 * A renamed directory is roll-forward state. Persist the destination name
 * first, then removal of the source name. Retries repeat both fsyncs.
 */
async function writeFully(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (bytesWritten < 1) fail("transaction.io-failed");
    offset += bytesWritten;
  }
}

async function syncCleanupParents(root: string, options: TransactionStoreOptions): Promise<void> {
  await syncDirectory(join(root, ".state/transactions/.staging"), "staging-parent-synced", options);
  await syncDirectory(join(root, ".state/transactions/committed"), "committed-parent-synced", options);
}

async function syncRenameParents(root: string, options: TransactionStoreOptions): Promise<void> {
  await syncDirectory(join(root, ".state/transactions/committed"), "committed-parent-synced", options);
  await syncDirectory(join(root, ".state/transactions/.staging"), "staging-parent-synced", options);
}

async function syncDirectory(path: string, step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | directoryFlag);
    const stat = await handle.stat();
    if (!stat.isDirectory()) fail("transaction.unsafe-root");
    await durability(handle, step, options);
  } catch (error) {
    failure = error;
  }
  if (handle) failure = await closeForOperation(handle, options, failure);
  if (failure) throw normalize(failure);
  await protocolStep(step, options);
}

async function closeForOperation(handle: FileHandle, options: TransactionStoreOptions, priorFailure: unknown): Promise<unknown> {
  if (releasedHandles.has(handle)) return priorFailure;
  try {
    await (options.close ?? ((file) => file.close()))(handle);
    releasedHandles.add(handle);
    return priorFailure;
  } catch {
    if (await isHandleReleased(handle, options)) {
      releasedHandles.add(handle);
    } else {
      try {
        await handle.close();
        releasedHandles.add(handle);
      } catch {
        if (await isHandleReleased(handle, options)) releasedHandles.add(handle);
      }
    }
    return priorFailure ?? new TransactionStoreError("transaction.io-failed");
  }
}

async function isHandleReleased(handle: FileHandle, options: TransactionStoreOptions): Promise<boolean> {
  try {
    if (options.isHandleReleased) return await options.isHandleReleased(handle);
    await handle.stat();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EBADF";
  }
}

async function durability(handle: FileHandle, step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  try { await (options.durability ?? ((file) => file.sync()))(handle, step); } catch { fail("transaction.io-failed"); }
}

async function protocolStep(step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  try { await options.onStep?.(step); } catch { fail("transaction.io-failed"); }
}

interface PinnedReadFile {
  path: string;
  handle: FileHandle;
  initial: BigIntStats;
  bytes: Buffer;
}

async function openAndReadPinnedFile(
  path: string,
  maxBytes: number,
  limits: Limits,
  parent: PinnedTransactionDirectory,
  options: TransactionStoreOptions,
): Promise<PinnedReadFile> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    await assertPinnedTransactionDirectory(parent);
    // Darwin/Node has no openat for child reads; the read-only pathname open
    // remains bracketed by pinned-parent and descriptor/path checks.
    handle = await open(path, constants.O_RDONLY | noFollow);
    await invokeHandleOpened(options, "transaction-file", path, handle);
    await assertPinnedTransactionDirectory(parent);
    const initial = await handle.stat({ bigint: true });
    const initialPath = await lstat(path, { bigint: true });
    assertStablePinnedFile(initial, initialPath);
    if (initial.size > BigInt(maxBytes)) fail("transaction.file-too-large");
    await invokeReadOnlyCheck(options, "file-pinned", path);
    await assertStablePinnedFilePath(handle, path, initial, parent);
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remainingProbe = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remainingProbe));
      const bytesRead = await limits.readChunk(handle, buffer, total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) fail("transaction.unsafe-file");
      await invokeReadOnlyCheck(options, "file-chunk-read", path);
      await assertStablePinnedFilePath(handle, path, initial, parent);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail("transaction.file-too-large");
      parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (initial.size !== BigInt(total)) fail("transaction.unsafe-file");
    return { path, handle, initial, bytes: Buffer.concat(parts, total) };
  } catch (error) {
    failure = normalize(error, "transaction.unsafe-file");
  }
  if (handle) failure = await closeForOperation(handle, options, failure);
  throw failure;
}

async function assertRetainedReadFile(file: PinnedReadFile, parent: PinnedTransactionDirectory): Promise<void> {
  await assertStablePinnedFilePath(file.handle, file.path, file.initial, parent);
}

function immutableVerifiedTransaction(
  manifest: CanonicalTransactionManifest,
  manifestBytes: Buffer,
  location: ".staging" | "committed",
  transactionId: string,
  records: Record<CanonicalRecordKind, JsonRecord[]>,
): VerifiedTransaction {
  const snapshot = {
    manifest: structuredClone(manifest),
    manifestSha256: sha256Hex(manifestBytes),
    manifestPath: relativeManifestPath(location, transactionId),
    records: structuredClone(records),
  } as VerifiedTransaction;
  return deepFreezeSnapshot(snapshot);
}

function deepFreezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

async function readSafeFile(
  path: string,
  maxBytes: number,
  limits: Limits,
  parent?: PinnedTransactionDirectory,
  options: TransactionStoreOptions = {},
): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let initial: BigIntStats | undefined;
  let initialPath: BigIntStats | undefined;
  const parts: Buffer[] = [];
  let total = 0;
  let result: Buffer | undefined;
  let failure: unknown;
  try {
    if (parent) await assertPinnedTransactionDirectory(parent);
    // Darwin/Node has no openat for child reads; O_NOFOLLOW pathname open is
    // therefore bracketed by pinned-parent and descriptor/path identity checks.
    handle = await open(path, constants.O_RDONLY | noFollow);
    await invokeHandleOpened(options, "transaction-file", path, handle);
    if (parent) await assertPinnedTransactionDirectory(parent);
    initial = await handle.stat({ bigint: true });
    initialPath = await lstat(path, { bigint: true });
    assertStablePinnedFile(initial, initialPath);
    if (initial.size > BigInt(maxBytes)) fail("transaction.file-too-large");
    await invokeReadOnlyCheck(options, "file-pinned", path);
    await assertStablePinnedFilePath(handle, path, initial, parent);
    for (;;) {
      const remainingProbe = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remainingProbe));
      const bytesRead = await limits.readChunk(handle, buffer, total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) fail("transaction.unsafe-file");
      await invokeReadOnlyCheck(options, "file-chunk-read", path);
      await assertStablePinnedFilePath(handle, path, initial, parent);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail("transaction.file-too-large");
      parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    assertStablePinnedFile(after, afterPath);
    if (after.dev !== initial.dev || after.ino !== initial.ino || after.size !== initial.size
      || after.mtimeNs !== initial.mtimeNs || after.ctimeNs !== initial.ctimeNs || after.size !== BigInt(total)) fail("transaction.unsafe-file");
    if (parent) await assertPinnedTransactionDirectory(parent);
    result = Buffer.concat(parts, total);
  } catch (error) {
    failure = normalize(error, "transaction.unsafe-file");
  }
  if (handle) failure = await closeForOperation(handle, options, failure);
  if (failure) throw failure;
  return result!;
}

function assertStablePinnedFile(
  descriptor: BigIntStats,
  pathname: BigIntStats,
): void {
  if (!descriptor.isFile() || !pathname.isFile() || pathname.isSymbolicLink()
    || descriptor.nlink !== 1n || pathname.nlink !== 1n
    || descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino || descriptor.size !== pathname.size
    || descriptor.mtimeNs !== pathname.mtimeNs || descriptor.ctimeNs !== pathname.ctimeNs) fail("transaction.unsafe-file");
}

async function assertStablePinnedFilePath(
  handle: FileHandle,
  path: string,
  initial: BigIntStats,
  parent?: PinnedTransactionDirectory,
): Promise<void> {
  const descriptor = await handle.stat({ bigint: true });
  const pathname = await lstat(path, { bigint: true });
  assertStablePinnedFile(descriptor, pathname);
  if (descriptor.dev !== initial.dev || descriptor.ino !== initial.ino || descriptor.size !== initial.size
    || descriptor.mtimeNs !== initial.mtimeNs || descriptor.ctimeNs !== initial.ctimeNs) fail("transaction.unsafe-file");
  if (parent) await assertPinnedTransactionDirectory(parent);
}

function preparedResult(manifest: CanonicalTransactionManifest, sha256: string, location: ".staging" | "committed"): PreparedTransaction {
  return { manifest: structuredClone(manifest), manifestSha256: sha256, manifestPath: relativeManifestPath(location, manifest.transactionId) };
}

function manifestRef(manifest: CanonicalTransactionManifest, sha256: string): TransactionManifestRef {
  return { transactionId: manifest.transactionId as TransactionId, relativePath: relativeManifestPath("committed", manifest.transactionId), sha256 };
}

function relativeManifestPath(location: ".staging" | "committed", transactionId: string): string {
  return `.state/transactions/${location}/${transactionId}/manifest.json`;
}

function transactionDirectory(root: string, location: ".staging" | "committed", transactionId: string): string {
  const directory = resolve(root, ".state", "transactions", location, transactionId);
  const parent = resolve(root, ".state", "transactions", location);
  if (!directory.startsWith(`${parent}${sep}`)) fail("transaction.invalid-input");
  return directory;
}

function snapshotManifestRef(reference: TransactionManifestRef): TransactionManifestRef {
  try {
    return JSON.parse(canonicalJson(reference)) as TransactionManifestRef;
  } catch {
    fail("transaction.invalid-input");
  }
}

function assertManifestRef(reference: TransactionManifestRef): void {
  const keys = Reflect.ownKeys(reference);
  if (utilTypes.isProxy(reference) || keys.length !== 3
    || keys.some((key) => typeof key !== "string" || !["transactionId", "relativePath", "sha256"].includes(key))
    || !ID_PATTERNS.transaction.test(reference.transactionId)
    || reference.relativePath !== relativeManifestPath("committed", reference.transactionId)
    || !/^[a-f0-9]{64}$/.test(reference.sha256)) fail("transaction.invalid-input");
}

function assertId(value: string, pattern: RegExp, code: TransactionStoreErrorCode): void {
  if (!pattern.test(value)) fail(code);
}

function limitsFrom(options: TransactionStoreOptions): Limits {
  const maxFileBytes = positiveLimit(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const maxLineBytes = positiveLimit(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  const maxRecords = positiveLimit(options.maxRecords ?? DEFAULT_MAX_RECORDS);
  const maxTotalRecords = positiveLimit(options.maxTotalRecords ?? DEFAULT_MAX_TOTAL_RECORDS);
  const maxReferences = positiveLimit(options.maxReferences ?? DEFAULT_MAX_REFERENCES);
  const maxTransactionBytes = positiveLimit(options.maxTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES);
  const maxDepth = positiveLimit(options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxNodes = positiveLimit(options.maxNodes ?? DEFAULT_MAX_NODES);
  const maxKeys = positiveLimit(options.maxKeys ?? DEFAULT_MAX_KEYS);
  const maxArrayLength = positiveLimit(options.maxArrayLength ?? maxRecords);
  const maxStringBytes = positiveLimit(options.maxStringBytes ?? maxLineBytes);
  const maxScalarBytes = positiveLimit(options.maxScalarBytes ?? maxTransactionBytes);
  const readChunk = options.readChunk ?? (async (handle: FileHandle, buffer: Buffer, position: number) => {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    return bytesRead;
  });
  return { maxFileBytes, maxLineBytes: Math.min(maxLineBytes, maxFileBytes), maxRecords, readChunk, maxTotalRecords, maxReferences, maxTransactionBytes,
    maxDepth, maxNodes, maxKeys, maxArrayLength, maxStringBytes, maxScalarBytes };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) fail("transaction.invalid-input");
  return value;
}

interface PinnedDirectory {
  path: string;
  handle: FileHandle;
  dev: number | bigint;
  ino: number | bigint;
  readOnlyMtimeMs?: number;
  readOnlyCtimeMs?: number;
}
type PinnedHierarchy = readonly PinnedDirectory[];

function withMutationLock<T>(root: string, options: TransactionStoreOptions, operation: (guard: PinnedHierarchy) => Promise<T>): Promise<T> {
  return withRootLock(root, async () => {
    const guard = await pinHierarchy(root, options);
    let lock: MutationLock | undefined;
    let result: T | undefined;
    let failure: unknown;
    try {
      await assertPinnedHierarchy(guard, "before-lock", options);
      lock = await acquireMutationLock(root, options);
      await assertPinnedHierarchy(guard, "after-lock", options);
      result = await operation(guard);
      await assertPinnedHierarchy(guard, "after-operation", options);
    } catch (error) {
      failure = error;
    }
    if (lock) {
      try { await releaseMutationLock(root, lock, options); }
      catch (error) { if (!failure) failure = error; }
    }
    for (const item of [...guard].reverse()) failure = await closeForOperation(item.handle, options, failure);
    if (failure) throw failure;
    return result as T;
  });
}

async function pinReadOnlyHierarchy(root: string, options: TransactionStoreOptions): Promise<PinnedHierarchy> {
  const candidates = [root, join(root, ".state"), join(root, ".state/transactions"), join(root, ".state/transactions/committed")];
  const existing: string[] = [];
  for (const path of candidates) {
    if (await pathExists(path)) existing.push(path);
    else if (path === root) fail("transaction.unsafe-root");
  }
  const pinned: PinnedDirectory[] = [];
  const opened: FileHandle[] = [];
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  try {
    for (const [index, path] of existing.entries()) {
      const handle = await open(path, constants.O_RDONLY | noFollow | directoryFlag);
      opened.push(handle);
      await invokeHandleOpened(options, "read-only-hierarchy", path, handle);
      const stat = await handle.stat();
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (!stat.isDirectory() || (index > 0 && ((uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0))) fail("transaction.unsafe-root");
      pinned.push({ path, handle, dev: stat.dev, ino: stat.ino, readOnlyMtimeMs: stat.mtimeMs, readOnlyCtimeMs: stat.ctimeMs });
    }
    return pinned;
  } catch (error) {
    let failure: unknown = normalize(error, "transaction.unsafe-root");
    for (const handle of opened.reverse()) failure = await closeForOperation(handle, options, failure);
    throw failure;
  }
}

async function pinHierarchy(root: string, options: TransactionStoreOptions): Promise<PinnedHierarchy> {
  const paths = [root, join(root, ".state"), join(root, ".state/transactions"), join(root, ".state/transactions/.staging"), join(root, ".state/transactions/committed")];
  const pinned: PinnedDirectory[] = [];
  const opened: FileHandle[] = [];
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  try {
    for (const [index, path] of paths.entries()) {
      const handle = await open(path, constants.O_RDONLY | noFollow | directoryFlag);
      opened.push(handle);
      await invokeHandleOpened(options, "mutation-hierarchy", path, handle);
      const stat = await handle.stat();
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (!stat.isDirectory() || (index > 0 && ((uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0))) fail("transaction.unsafe-root");
      pinned.push({ path, handle, dev: stat.dev, ino: stat.ino });
    }
    return pinned;
  } catch (error) {
    let failure: unknown = normalize(error, "transaction.unsafe-root");
    for (const handle of opened.reverse()) failure = await closeForOperation(handle, options, failure);
    throw failure;
  }
}

async function assertPinnedHierarchy(guard: PinnedHierarchy, phase: string, options: TransactionStoreOptions): Promise<void> {
  try { await options.onAncestorCheck?.(phase); } catch { fail("transaction.unsafe-root"); }
  for (const item of guard) {
    const descriptor = await item.handle.stat().catch(() => fail("transaction.unsafe-root"));
    const pathStat = await lstat(item.path).catch(() => fail("transaction.unsafe-root"));
    if (!descriptor.isDirectory() || !pathStat.isDirectory() || pathStat.isSymbolicLink()
      || descriptor.dev !== item.dev || descriptor.ino !== item.ino || pathStat.dev !== item.dev || pathStat.ino !== item.ino
      || item.readOnlyMtimeMs !== undefined && (descriptor.mtimeMs !== item.readOnlyMtimeMs || pathStat.mtimeMs !== item.readOnlyMtimeMs)
      || item.readOnlyCtimeMs !== undefined && (descriptor.ctimeMs !== item.readOnlyCtimeMs || pathStat.ctimeMs !== item.readOnlyCtimeMs)) fail("transaction.unsafe-root");
  }
}

interface MutationLock { path: string; dev: number | bigint; ino: number | bigint; token: string }
interface LockOwner { schemaVersion: 1; pid: number; ownerToken: string; createdAt: string; dev: string; ino: string }

async function acquireMutationLock(root: string, options: TransactionStoreOptions): Promise<MutationLock> {
  const parent = join(root, ".state/transactions");
  const active = join(parent, ".mutation-lock");
  await recoverLockTrash(parent, options);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await pathExists(active)) {
      const activeStat = await lstat(active).catch(() => fail("transaction.lock-corrupt"));
      if (!activeStat.isDirectory() || activeStat.isSymbolicLink() || (activeStat.mode & 0o077) !== 0) fail("transaction.lock-corrupt");
      const ownerRecord = await readLockOwner(active, options);
      const owner = ownerRecord.owner;
      if (owner.dev !== String(activeStat.dev) || owner.ino !== String(activeStat.ino)) fail("transaction.lock-corrupt");
      if (await (options.isProcessAlive ?? defaultProcessAlive)(owner.pid)) fail("transaction.locked");
      await assertLockOwnerIdentity(active, ownerRecord);
      const stale = join(parent, `.mutation-lock.release-${owner.ownerToken}`);
      await nodeRename(active, stale).catch(() => fail("transaction.lock-corrupt"));
      await syncDirectory(parent, "lock-release-parent-synced", options);
      await deleteLockDirectory(stale, owner.ownerToken, options);
      await syncDirectory(parent, "lock-released", options);
    }
    const token = options.randomToken?.() ?? randomBytes(32).toString("hex");
    const pid = options.pid ?? process.pid;
    const createdAt = (options.now?.() ?? new Date()).toISOString();
    if (!/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(pid) || pid < 1 || !isTimestamp(createdAt)) fail("transaction.lock-corrupt");
    const temporary = join(parent, `.mutation-lock.acquire-${token}`);
    try { await mkdir(temporary, { mode: 0o700 }); }
    catch (error) { if (isNodeError(error, "EEXIST")) continue; throw normalize(error); }
    const stat = await lstat(temporary).catch(() => fail("transaction.lock-corrupt"));
    const owner: LockOwner = { schemaVersion: 1, pid, ownerToken: token, createdAt, dev: String(stat.dev), ino: String(stat.ino) };
    await writeExclusiveFile(join(temporary, "owner.json"), Buffer.from(`${canonicalJson(owner)}\n`), "lock-owner-synced", options);
    await syncDirectory(temporary, "lock-directory-synced", options);
    try { await nodeRename(temporary, active); }
    catch (error) {
      if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) {
        await deleteLockDirectory(temporary, token, options);
        await syncDirectory(parent, "lock-released", options);
        fail("transaction.locked");
      }
      throw normalize(error);
    }
    const activeStat = await lstat(active).catch(() => fail("transaction.lock-corrupt"));
    if (activeStat.dev !== stat.dev || activeStat.ino !== stat.ino) fail("transaction.lock-corrupt");
    await protocolStep("lock-active-renamed", options);
    await syncDirectory(parent, "lock-parent-synced", options);
    return { path: active, dev: stat.dev, ino: stat.ino, token };
  }
  fail("transaction.locked");
}

async function releaseMutationLock(root: string, lock: MutationLock, options: TransactionStoreOptions): Promise<void> {
  const parent = join(root, ".state/transactions");
  const stat = await lstat(lock.path).catch(() => fail("transaction.lock-corrupt"));
  const ownerRecord = await readLockOwner(lock.path, options);
  if (stat.dev !== lock.dev || stat.ino !== lock.ino || ownerRecord.owner.ownerToken !== lock.token) fail("transaction.lock-corrupt");
  await assertLockOwnerIdentity(lock.path, ownerRecord);
  const releasing = join(parent, `.mutation-lock.release-${lock.token}`);
  await nodeRename(lock.path, releasing).catch(() => fail("transaction.lock-corrupt"));
  const releasingStat = await lstat(releasing).catch(() => fail("transaction.lock-corrupt"));
  if (releasingStat.dev !== lock.dev || releasingStat.ino !== lock.ino) fail("transaction.lock-corrupt");
  await protocolStep("lock-release-renamed", options);
  await syncDirectory(parent, "lock-release-parent-synced", options);
  await deleteLockDirectory(releasing, lock.token, options);
  await syncDirectory(parent, "lock-released", options);
}

async function recoverLockTrash(parent: string, options: TransactionStoreOptions): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => fail("transaction.lock-corrupt"));
  const nowMs = (options.now?.() ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) fail("transaction.invalid-input");
  const minimumAgeMs = positiveLimit(options.lockTrashMinAgeMs ?? DEFAULT_LOCK_TRASH_MIN_AGE_MS);
  for (const entry of entries) {
    const match = /^\.mutation-lock\.(?:acquire|release)-([a-f0-9]{64})$/.exec(entry.name);
    if (!match) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("transaction.lock-corrupt");
    const path = join(parent, entry.name);
    const before = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) fail("transaction.lock-corrupt");
    let ownerRecord: ReadLockOwner | undefined;
    try { ownerRecord = await readLockOwner(path, options); } catch { ownerRecord = undefined; }
    if (ownerRecord) {
      if (ownerRecord.owner.ownerToken !== match[1]) fail("transaction.lock-corrupt");
      if (await (options.isProcessAlive ?? defaultProcessAlive)(ownerRecord.owner.pid)) continue;
      await deleteLockDirectory(path, match[1]!, options);
      await syncDirectory(parent, "lock-released", options);
      continue;
    }
    if (nowMs - before.mtimeMs < minimumAgeMs) continue;
    await deleteOwnerlessLockTrash(path, before, options);
    await syncDirectory(parent, "lock-released", options);
  }
}

async function deleteOwnerlessLockTrash(path: string, before: Awaited<ReturnType<typeof lstat>>, options: TransactionStoreOptions): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => fail("transaction.lock-corrupt"));
  if (entries.length > 1 || (entries.length === 1 && entries[0]!.name !== "owner.json")) fail("transaction.lock-corrupt");
  if (entries.length === 1) {
    const entry = entries[0]!;
    if (!entry.isFile() || entry.isSymbolicLink()) fail("transaction.lock-corrupt");
    const ownerPath = join(path, "owner.json");
    const ownerBefore = await lstat(ownerPath).catch(() => fail("transaction.lock-corrupt"));
    if (!ownerBefore.isFile() || ownerBefore.isSymbolicLink() || ownerBefore.nlink !== 1 || ownerBefore.size > 4096) fail("transaction.lock-corrupt");
    const limits = limitsFrom({ ...options, maxFileBytes: 4096, maxLineBytes: 4096, maxDepth: 8, maxNodes: 32, maxKeys: 16,
      maxArrayLength: 16, maxStringBytes: 4096, maxScalarBytes: 4096 });
    await readSafeFile(ownerPath, 4096, limits).catch(() => fail("transaction.lock-corrupt"));
    const ownerAfter = await lstat(ownerPath).catch(() => fail("transaction.lock-corrupt"));
    const directory = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
    if (ownerAfter.dev !== ownerBefore.dev || ownerAfter.ino !== ownerBefore.ino || ownerAfter.nlink !== 1
      || directory.dev !== before.dev || directory.ino !== before.ino) fail("transaction.lock-corrupt");
    await unlink(ownerPath).catch(() => fail("transaction.lock-corrupt"));
    await protocolStep("lock-owner-removed", options);
  }
  const empty = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
  if (empty.dev !== before.dev || empty.ino !== before.ino) fail("transaction.lock-corrupt");
  await rmdir(path).catch(() => fail("transaction.lock-corrupt"));
  await protocolStep("lock-trash-cleaned", options);
}

async function deleteLockDirectory(path: string, token: string, options: TransactionStoreOptions): Promise<void> {
  const before = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) fail("transaction.lock-corrupt");
  const ownerRecord = await readLockOwner(path, options);
  if (ownerRecord.owner.ownerToken !== token || ownerRecord.owner.dev !== String(before.dev) || ownerRecord.owner.ino !== String(before.ino)) fail("transaction.lock-corrupt");
  await assertLockOwnerIdentity(path, ownerRecord);
  const current = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
  if (current.dev !== before.dev || current.ino !== before.ino) fail("transaction.lock-corrupt");
  await unlink(join(path, "owner.json")).catch(() => fail("transaction.lock-corrupt"));
  await protocolStep("lock-owner-removed", options);
  const empty = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
  if (empty.dev !== before.dev || empty.ino !== before.ino) fail("transaction.lock-corrupt");
  await rmdir(path).catch(() => fail("transaction.lock-corrupt"));
  await protocolStep("lock-trash-cleaned", options);
}

interface ReadLockOwner { owner: LockOwner; dev: number | bigint; ino: number | bigint }

async function readLockOwner(path: string, options: TransactionStoreOptions): Promise<ReadLockOwner> {
  const ownerPath = join(path, "owner.json");
  const before = await lstat(ownerPath).catch(() => fail("transaction.lock-corrupt"));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("transaction.lock-corrupt");
  const limits = limitsFrom({ ...options, maxFileBytes: 4096, maxLineBytes: 4096, maxDepth: 8, maxNodes: 32, maxKeys: 16,
    maxArrayLength: 16, maxStringBytes: 4096, maxScalarBytes: 4096 });
  const bytes = await readSafeFile(ownerPath, 4096, limits).catch(() => fail("transaction.lock-corrupt"));
  const value = parseCanonicalSingleJson(bytes, limits) as Partial<LockOwner>;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || !/^[a-f0-9]{64}$/.test(value.ownerToken ?? "")
    || !isTimestamp(value.createdAt) || typeof value.dev !== "string" || typeof value.ino !== "string"
    || Reflect.ownKeys(value).length !== 6) fail("transaction.lock-corrupt");
  const after = await lstat(ownerPath).catch(() => fail("transaction.lock-corrupt"));
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) fail("transaction.lock-corrupt");
  return { owner: value as LockOwner, dev: after.dev, ino: after.ino };
}

async function assertLockOwnerIdentity(path: string, record: ReadLockOwner): Promise<void> {
  const stat = await lstat(join(path, "owner.json")).catch(() => fail("transaction.lock-corrupt"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== record.dev || stat.ino !== record.ino) fail("transaction.lock-corrupt");
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isNodeError(error, "ESRCH"); }
}

function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const prior = rootQueues.get(root) ?? Promise.resolve();
  const result = prior.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  rootQueues.set(root, tail);
  void tail.finally(() => { if (rootQueues.get(root) === tail) rootQueues.delete(root); });
  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    fail("transaction.io-failed");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function normalize(error: unknown, fallback: TransactionStoreErrorCode = "transaction.io-failed"): TransactionStoreError {
  return error instanceof TransactionStoreError ? error : new TransactionStoreError(fallback);
}

function fail(code: TransactionStoreErrorCode): never {
  throw new TransactionStoreError(code);
}
