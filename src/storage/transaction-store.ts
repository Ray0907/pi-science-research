import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
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
import { join, resolve, sep } from "node:path";
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
const READ_CHUNK_BYTES = 64 * 1024;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const rootQueues = new Map<string, Promise<void>>();

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
  | "lock-owner-synced"
  | "lock-directory-synced"
  | "lock-parent-synced"
  | "lock-released";

export interface TransactionStoreOptions {
  maxFileBytes?: number;
  maxLineBytes?: number;
  maxRecords?: number;
  maxTotalRecords?: number;
  maxReferences?: number;
  maxTransactionBytes?: number;
  readChunk?: (handle: FileHandle, buffer: Buffer, position: number) => Promise<number>;
  durability?: (handle: FileHandle, step: TransactionProtocolStep) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  close?: (handle: FileHandle) => Promise<void>;
  onStep?: (step: TransactionProtocolStep) => Promise<void>;
  pid?: number;
  now?: () => Date;
  randomToken?: () => string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  onAncestorCheck?: (phase: string) => void | Promise<void>;
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
  const snapshot = snapshotTransactionInput(transaction, limits);
  const root = await initializeRoot(runRoot, options);
  return withMutationLock(root, options, async () => {
    const catalog = await loadReferenceCatalog(root, limits, snapshot.transactionId);
    const built = buildTransaction(snapshot, limits, catalog);
    const committedPath = transactionDirectory(root, "committed", built.manifest.transactionId);
    if (await pathExists(committedPath)) {
      const verified = await verifyDirectory(root, "committed", built.manifest.transactionId, limits);
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
          verified = await verifyDirectory(root, ".staging", built.manifest.transactionId, limits);
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
      const existing = await verifyDirectory(root, "committed", transactionId, limits);
      const stagePath = transactionDirectory(root, ".staging", transactionId);
      if (await pathExists(stagePath)) {
        await cleanupMatchingStaging(root, transactionId, existing, limits, options);
        await syncCleanupParents(root, options);
      } else {
        await syncRenameParents(root, options);
      }
      return manifestRef(existing.manifest, existing.manifestSha256);
    }

    const staged = await verifyDirectory(root, ".staging", transactionId, limits).catch((error) => {
      if (error instanceof TransactionStoreError && error.code === "transaction.missing-object") fail("transaction.not-prepared");
      throw error;
    });
    const catalog = await loadReferenceCatalog(root, limits, transactionId);
    validateCatalogAndReferences(staged.records, catalog, limits);
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
    const verified = await verifyDirectory(root, "committed", transactionId, limits);
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
    const verified = await verifyDirectory(root, "committed", snapshot.transactionId, limitsFrom(options));
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
    for (const transactionId of names) output.push(await verifyDirectory(root, "committed", transactionId, limitsFrom(options)));
    return output;
  });
}

export async function reconcileCanonicalTransactions(
  runRoot: string,
  events: readonly FoundationLedgerEvent[],
  options: TransactionStoreOptions = {},
): Promise<TransactionReconciliationDecision[]> {
  const reduced = reduceLedgerEvents(events);
  const ledger = canonicalLedgerLinks(events);
  const root = await initializeRoot(runRoot, options);
  return withMutationLock(root, options, async () => {
    const results = new Map<string, Extract<FoundationLedgerEvent, { type: "result_recorded" }>>();
    const commits = new Map<string, Extract<FoundationLedgerEvent, { type: "records_committed" }>>();
    for (const event of events) {
      if (event.type === "result_recorded") results.set(event.payload.transactionId, event);
      if (event.type === "records_committed") commits.set(event.payload.transactionId, event);
    }
    let ledgerCatalog = emptyCatalog();
    for (const event of events) {
      if (event.type !== "records_committed") continue;
      const verified = await verifyCommittedEvent(root, event, limitsFrom(options));
      ledgerCatalog = validateCatalogAndReferences(verified.records, ledgerCatalog, limitsFrom(options));
    }
    const decisions: TransactionReconciliationDecision[] = [];
    for (const [transactionId, result] of results) {
      const commit = commits.get(transactionId);
      const attempt = ledger.attempts.get(result.payload.attemptId);
      if (!attempt) fail("transaction.corrupt");
      if (commit) {
        const verified = await verifyCommittedEvent(root, commit, limitsFrom(options));
        assertResultManifestLink(result, verified.manifest, ledger.runId, attempt);
      } else {
        const directory = transactionDirectory(root, "committed", transactionId as TransactionId);
        if (await pathExists(directory)) {
          const verified = await verifyDirectory(root, "committed", transactionId as TransactionId, limitsFrom(options));
          assertResultManifestLink(result, verified.manifest, ledger.runId, attempt);
          validateCatalogAndReferences(verified.records, ledgerCatalog, limitsFrom(options));
          const decision = recoveryDecisionFor(reduced, attempt.logicalOperationId);
          if (decision.kind === "finish-transaction" && decision.transactionId === transactionId) {
            decisions.push(Object.freeze({ kind: "finish-transaction", transactionId: transactionId as TransactionId }));
          }
        }
      }
    }
    for (const commit of commits.values()) {
      if (!results.has(commit.payload.transactionId)) fail("transaction.corrupt");
      await verifyCommittedEvent(root, commit, limitsFrom(options));
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
      const verified = await verifyCommittedEvent(root, event, limitsFrom(options));
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

interface Limits {
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
}

function snapshotTransactionInput(input: CanonicalTransactionInput, limits: Limits): CanonicalTransactionInput {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ["schemaVersion", "transactionId", "runId", "attemptId", "sourceResultSeq", "createdAt"] as const) {
      snapshot[key] = JSON.parse(canonicalJson(descriptors[key]!.value));
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
        const canonical = canonicalJson(descriptor.value);
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

function buildTransaction(input: CanonicalTransactionInput, limits: Limits, catalog: ReferenceCatalog): BuiltTransaction {
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
  validateCatalogAndReferences(recordsByKind, catalog, limits);
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
    if (!parsedRecord.success) fail("transaction.invalid-record");
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

type ReferenceCatalog = Record<CanonicalRecordKind, Map<string, Map<number, string>>>;

function emptyCatalog(): ReferenceCatalog {
  return Object.fromEntries(KINDS.map((kind) => [kind, new Map()])) as ReferenceCatalog;
}

async function loadReferenceCatalog(root: string, limits: Limits, excludeTransactionId: string): Promise<ReferenceCatalog> {
  const directory = join(root, ".state/transactions/committed");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("transaction.io-failed"));
  const transactions: VerifiedTransaction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERNS.transaction.test(entry.name)) fail("transaction.suspicious-entry");
    if (entry.name !== excludeTransactionId) transactions.push(await verifyDirectory(root, "committed", entry.name, limits));
  }
  transactions.sort((left, right) => left.manifest.sourceResultSeq - right.manifest.sourceResultSeq);
  let catalog = emptyCatalog();
  for (const transaction of transactions) catalog = validateCatalogAndReferences(transaction.records, catalog, limits);
  return catalog;
}

function validateCatalogAndReferences(records: Record<CanonicalRecordKind, JsonRecord[]>, prior: ReferenceCatalog, limits: Limits): ReferenceCatalog {
  const catalog = emptyCatalog();
  for (const kind of KINDS) {
    for (const [id, revisions] of prior[kind]) catalog[kind].set(id, new Map(revisions));
  }
  addRecordsToCatalog(records, catalog, true);
  let referenceCount = 0;
  const countReference = () => { if (++referenceCount > limits.maxReferences) fail("transaction.too-many-records"); };
  const exact = (kind: CanonicalRecordKind, id: unknown, revision = 0) => {
    countReference();
    if (typeof id !== "string" || !catalog[kind].get(id)?.has(revision)) fail("transaction.invalid-reference");
  };
  const stable = (kind: CanonicalRecordKind, id: unknown) => {
    countReference();
    if (typeof id !== "string" || !catalog[kind].has(id)) fail("transaction.invalid-reference");
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
  for (const verification of records.verifications) {
    for (const ref of verification.checkedClaims as { claimId: string; revision: number }[]) exact("claims", ref.claimId, ref.revision);
    for (const ref of verification.checkedEvidence as { evidenceId: string; revision: number }[]) exact("evidence", ref.evidenceId, ref.revision);
    for (const id of verification.requestIds as string[]) stable("requests", id);
    for (const id of verification.calculationIds as string[]) stable("calculations", id);
    for (const item of verification.corrections as { claimId: string }[]) stable("claims", item.claimId);
    for (const id of verification.independentEvidenceIds as string[]) stable("evidence", id);
  }
  return catalog;
}

function addRecordsToCatalog(records: Record<CanonicalRecordKind, JsonRecord[]>, catalog: ReferenceCatalog, enforceProgression: boolean): void {
  for (const kind of KINDS) {
    const metadata = KIND_ID[kind];
    for (const record of records[kind]) {
      const id = String(record[metadata.field]);
      const revision = metadata.revision ? Number(record.revision) : 0;
      let revisions = catalog[kind].get(id);
      if (!revisions) { revisions = new Map(); catalog[kind].set(id, revisions); }
      if (revisions.has(revision)) fail("transaction.duplicate-record");
      if (enforceProgression && metadata.revision) {
        let highest = 0;
        for (const priorRevision of revisions.keys()) if (priorRevision > highest) highest = priorRevision;
        if (revision !== highest + 1) fail("transaction.invalid-reference");
      }
      if (enforceProgression && !metadata.revision && revisions.size > 0) fail("transaction.duplicate-record");
      revisions.set(revision, canonicalJson(record));
    }
  }
}

async function verifyDirectory(root: string, location: ".staging" | "committed", transactionId: string, limits: Limits): Promise<VerifiedTransaction> {
  const directory = transactionDirectory(root, location, transactionId);
  if (!(await pathExists(directory))) fail("transaction.missing-object");
  await assertOwnedDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("transaction.corrupt"));
  const expected = new Set([...KINDS.map((kind) => `${kind}.jsonl`), MANIFEST_FILE]);
  if (entries.some((entry) => entry.isSymbolicLink())) fail("transaction.unsafe-file");
  if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || !expected.has(entry.name))) fail("transaction.corrupt");
  const manifestBytes = await readSafeFile(join(directory, MANIFEST_FILE), Math.min(limits.maxFileBytes, limits.maxLineBytes), limits);
  let transactionBytes = manifestBytes.byteLength;
  const manifestInput = parseCanonicalSingleJson(manifestBytes);
  const parsed = parse(CanonicalTransactionManifestSchema, manifestInput);
  if (!parsed.success) fail("transaction.corrupt");
  const manifest = parsed.value;
  if (manifest.transactionId !== transactionId || manifest.files.length !== KINDS.length
    || manifest.files.some((file, index) => file.kind !== KINDS[index] || file.relativePath !== `${file.kind}.jsonl`)) fail("transaction.corrupt");
  const records = Object.create(null) as Record<CanonicalRecordKind, JsonRecord[]>;
  for (const [index, kind] of KINDS.entries()) {
    const file = manifest.files[index]!;
    const bytes = await readSafeFile(join(directory, file.relativePath), limits.maxFileBytes, limits);
    transactionBytes += bytes.byteLength;
    if (transactionBytes > limits.maxTransactionBytes) fail("transaction.file-too-large");
    if (bytes.byteLength !== file.decodedBytes || sha256Hex(bytes) !== file.sha256) fail("transaction.corrupt");
    const parsedRecords = parseJsonLines(bytes, limits);
    if (parsedRecords.length !== file.recordCount) fail("transaction.corrupt");
    records[kind] = validateAndSortRecords(kind, parsedRecords, manifest.attemptId, limits);
    if (!Buffer.from(records[kind].map((record) => `${canonicalJson(record)}\n`).join(""), "utf8").equals(bytes)) fail("transaction.corrupt");
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
  return {
    manifest: structuredClone(manifest),
    manifestSha256: sha256Hex(manifestBytes),
    manifestPath: relativeManifestPath(location, transactionId),
    records,
  };
}

function parseCanonicalSingleJson(bytes: Buffer): unknown {
  let text: string;
  try { text = fatalUtf8.decode(bytes); } catch { fail("transaction.corrupt"); }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("transaction.corrupt");
  const body = text.slice(0, -1);
  let value: unknown;
  try { value = JSON.parse(body); } catch { fail("transaction.corrupt"); }
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
    try { if (canonicalJson(value) !== line) fail("transaction.corrupt"); } catch { fail("transaction.corrupt"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("transaction.corrupt");
    return value as JsonRecord;
  });
}

async function verifyCommittedEvent(root: string, event: Extract<FoundationLedgerEvent, { type: "records_committed" }>, limits: Limits): Promise<VerifiedTransaction> {
  const verified = await verifyDirectory(root, "committed", event.payload.transactionId, limits).catch((error) => {
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

async function cleanupMatchingStaging(root: string, transactionId: string, committed: VerifiedTransaction, limits: Limits, options: TransactionStoreOptions): Promise<void> {
  const stage = transactionDirectory(root, ".staging", transactionId);
  const destination = transactionDirectory(root, "committed", transactionId);
  const entries = await readdir(stage, { withFileTypes: true }).catch(() => fail("transaction.id-conflict"));
  const expected = new Set([...KINDS.map((kind) => `${kind}.jsonl`), MANIFEST_FILE]);
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))) fail("transaction.id-conflict");
  for (const entry of entries) {
    const stagedBytes = await readSafeFile(join(stage, entry.name), limits.maxFileBytes, limits);
    const committedBytes = await readSafeFile(join(destination, entry.name), limits.maxFileBytes, limits);
    if (!stagedBytes.equals(committedBytes)) fail("transaction.id-conflict");
  }
  if (entries.some((entry) => entry.name === MANIFEST_FILE)) {
    const stagedManifest = await verifyDirectory(root, ".staging", transactionId, limits).catch(() => fail("transaction.id-conflict"));
    if (stagedManifest.manifestSha256 !== committed.manifestSha256) fail("transaction.id-conflict");
  }
  const removalOrder = [...entries].sort((left, right) => Number(right.name === MANIFEST_FILE) - Number(left.name === MANIFEST_FILE));
  for (const entry of removalOrder) {
    try { await unlink(join(stage, entry.name)); } catch { fail("transaction.io-failed"); }
    await protocolStep("staging-cleaned", options);
  }
  try { await rmdir(stage); } catch { fail("transaction.io-failed"); }
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
  try {
    await (options.close ?? ((file) => file.close()))(handle);
    return priorFailure;
  } catch {
    await handle.close().catch(() => undefined);
    return priorFailure ?? new TransactionStoreError("transaction.io-failed");
  }
}

async function durability(handle: FileHandle, step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  try { await (options.durability ?? ((file) => file.sync()))(handle, step); } catch { fail("transaction.io-failed"); }
}

async function protocolStep(step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  try { await options.onStep?.(step); } catch { fail("transaction.io-failed"); }
}

async function readSafeFile(path: string, maxBytes: number, limits: Limits): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let initial: Awaited<ReturnType<FileHandle["stat"]>> | undefined;
  const parts: Buffer[] = [];
  let total = 0;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1) fail("transaction.unsafe-file");
    if (initial.size > maxBytes) fail("transaction.file-too-large");
    for (;;) {
      const remainingProbe = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remainingProbe));
      const bytesRead = await limits.readChunk(handle, buffer, total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) fail("transaction.unsafe-file");
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail("transaction.file-too-large");
      parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== initial.dev || after.ino !== initial.ino
      || after.size !== total || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) fail("transaction.unsafe-file");
    return Buffer.concat(parts, total);
  } catch (error) {
    throw normalize(error, "transaction.unsafe-file");
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
  const readChunk = options.readChunk ?? (async (handle: FileHandle, buffer: Buffer, position: number) => {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    return bytesRead;
  });
  return { maxFileBytes, maxLineBytes: Math.min(maxLineBytes, maxFileBytes), maxRecords, readChunk, maxTotalRecords, maxReferences, maxTransactionBytes };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) fail("transaction.invalid-input");
  return value;
}

interface PinnedDirectory { path: string; handle: FileHandle; dev: number | bigint; ino: number | bigint }
type PinnedHierarchy = readonly PinnedDirectory[];

function withMutationLock<T>(root: string, options: TransactionStoreOptions, operation: (guard: PinnedHierarchy) => Promise<T>): Promise<T> {
  return withRootLock(root, async () => {
    const guard = await pinHierarchy(root);
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
    await Promise.all(guard.map(({ handle }) => handle.close().catch(() => undefined)));
    if (failure) throw failure;
    return result as T;
  });
}

async function pinHierarchy(root: string): Promise<PinnedHierarchy> {
  const paths = [root, join(root, ".state"), join(root, ".state/transactions"), join(root, ".state/transactions/.staging"), join(root, ".state/transactions/committed")];
  const pinned: PinnedDirectory[] = [];
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  try {
    for (const [index, path] of paths.entries()) {
      const handle = await open(path, constants.O_RDONLY | noFollow | directoryFlag);
      const stat = await handle.stat();
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (!stat.isDirectory() || (index > 0 && ((uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0))) fail("transaction.unsafe-root");
      pinned.push({ path, handle, dev: stat.dev, ino: stat.ino });
    }
    return pinned;
  } catch (error) {
    await Promise.all(pinned.map(({ handle }) => handle.close().catch(() => undefined)));
    throw normalize(error, "transaction.unsafe-root");
  }
}

async function assertPinnedHierarchy(guard: PinnedHierarchy, phase: string, options: TransactionStoreOptions): Promise<void> {
  try { await options.onAncestorCheck?.(phase); } catch { fail("transaction.unsafe-root"); }
  for (const item of guard) {
    const descriptor = await item.handle.stat().catch(() => fail("transaction.unsafe-root"));
    const pathStat = await lstat(item.path).catch(() => fail("transaction.unsafe-root"));
    if (!descriptor.isDirectory() || !pathStat.isDirectory() || pathStat.isSymbolicLink()
      || descriptor.dev !== item.dev || descriptor.ino !== item.ino || pathStat.dev !== item.dev || pathStat.ino !== item.ino) fail("transaction.unsafe-root");
  }
}

interface MutationLock { path: string; dev: number | bigint; ino: number | bigint; token: string }
interface LockOwner { schemaVersion: 1; pid: number; ownerToken: string; createdAt: string; dev: string; ino: string }

async function acquireMutationLock(root: string, options: TransactionStoreOptions): Promise<MutationLock> {
  const path = join(root, ".state/transactions/.mutation-lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("transaction.lock-corrupt");
      const token = options.randomToken?.() ?? randomBytes(32).toString("hex");
      const pid = options.pid ?? process.pid;
      const createdAt = (options.now?.() ?? new Date()).toISOString();
      if (!/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(pid) || pid < 1 || !isTimestamp(createdAt)) fail("transaction.lock-corrupt");
      const owner: LockOwner = { schemaVersion: 1, pid, ownerToken: token, createdAt, dev: String(stat.dev), ino: String(stat.ino) };
      await writeExclusiveFile(join(path, "owner.json"), Buffer.from(`${canonicalJson(owner)}\n`), "lock-owner-synced", options);
      await syncDirectory(path, "lock-directory-synced", options);
      await syncDirectory(join(root, ".state/transactions"), "lock-parent-synced", options);
      return { path, dev: stat.dev, ino: stat.ino, token };
    } catch (error) {
      if (created) {
        await unlink(join(path, "owner.json")).catch((cleanupError) => { if (!isNodeError(cleanupError, "ENOENT")) fail("transaction.lock-corrupt"); });
        await rmdir(path).catch(() => fail("transaction.lock-corrupt"));
        await syncDirectory(join(root, ".state/transactions"), "lock-released", options);
        throw normalize(error);
      }
      if (!isNodeError(error, "EEXIST")) {
        if (error instanceof TransactionStoreError) throw error;
        fail("transaction.io-failed");
      }
      const stat = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("transaction.lock-corrupt");
      const ownerRecord = await readLockOwner(path, options);
      const owner = ownerRecord.owner;
      const alive = await (options.isProcessAlive ?? defaultProcessAlive)(owner.pid);
      if (alive) fail("transaction.locked");
      const current = await lstat(path).catch(() => fail("transaction.lock-corrupt"));
      if (current.dev !== stat.dev || current.ino !== stat.ino || owner.dev !== String(stat.dev) || owner.ino !== String(stat.ino)) fail("transaction.lock-corrupt");
      await assertLockOwnerIdentity(path, ownerRecord);
      await unlink(join(path, "owner.json")).catch(() => fail("transaction.lock-corrupt"));
      await rmdir(path).catch(() => fail("transaction.lock-corrupt"));
      await syncDirectory(join(root, ".state/transactions"), "lock-released", options);
    }
  }
  fail("transaction.locked");
}

async function releaseMutationLock(root: string, lock: MutationLock, options: TransactionStoreOptions): Promise<void> {
  const stat = await lstat(lock.path).catch(() => fail("transaction.lock-corrupt"));
  const ownerRecord = await readLockOwner(lock.path, options);
  if (stat.dev !== lock.dev || stat.ino !== lock.ino || ownerRecord.owner.ownerToken !== lock.token) fail("transaction.lock-corrupt");
  await assertLockOwnerIdentity(lock.path, ownerRecord);
  await unlink(join(lock.path, "owner.json")).catch(() => fail("transaction.lock-corrupt"));
  await rmdir(lock.path).catch(() => fail("transaction.lock-corrupt"));
  await syncDirectory(join(root, ".state/transactions"), "lock-released", options);
}

interface ReadLockOwner { owner: LockOwner; dev: number | bigint; ino: number | bigint }

async function readLockOwner(path: string, options: TransactionStoreOptions): Promise<ReadLockOwner> {
  const ownerPath = join(path, "owner.json");
  const before = await lstat(ownerPath).catch(() => fail("transaction.lock-corrupt"));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("transaction.lock-corrupt");
  const limits = limitsFrom({ ...options, maxFileBytes: 4096, maxLineBytes: 4096 });
  const bytes = await readSafeFile(ownerPath, 4096, limits).catch(() => fail("transaction.lock-corrupt"));
  const value = parseCanonicalSingleJson(bytes) as Partial<LockOwner>;
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
