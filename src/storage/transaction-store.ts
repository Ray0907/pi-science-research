import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename as nodeRename,
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
  | "committed-parent-synced";

export interface TransactionStoreOptions {
  maxFileBytes?: number;
  maxLineBytes?: number;
  maxRecords?: number;
  readChunk?: (handle: FileHandle, buffer: Buffer, position: number) => Promise<number>;
  durability?: (handle: FileHandle, step: TransactionProtocolStep) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  close?: (handle: FileHandle) => Promise<void>;
  onStep?: (step: TransactionProtocolStep) => Promise<void>;
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
  | "transaction.io-failed";

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
  const snapshot = snapshotTransactionInput(transaction);
  const root = await initializeRoot(runRoot);
  return withRootLock(root, async () => {
    const limits = limitsFrom(options);
    const built = buildTransaction(snapshot, limits);
    const committedPath = transactionDirectory(root, "committed", built.manifest.transactionId);
    if (await pathExists(committedPath)) {
      const verified = await verifyDirectory(root, "committed", built.manifest.transactionId, limits);
      if (verified.manifestSha256 !== built.manifestSha256) fail("transaction.id-conflict");
      return preparedResult(built.manifest, built.manifestSha256, "committed");
    }

    const stagePath = transactionDirectory(root, ".staging", built.manifest.transactionId);
    if (await pathExists(stagePath)) {
      let verified: VerifiedTransaction;
      try {
        verified = await verifyDirectory(root, ".staging", built.manifest.transactionId, limits);
      } catch {
        fail("transaction.staging-corrupt");
      }
      if (verified.manifestSha256 !== built.manifestSha256) fail("transaction.id-conflict");
      return preparedResult(built.manifest, built.manifestSha256, ".staging");
    }

    try {
      await mkdir(stagePath, { mode: 0o700 });
      for (const kind of KINDS) {
        await writeExclusiveFile(join(stagePath, `${kind}.jsonl`), built.files[kind], `${kind}-synced`, options);
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
  const root = await initializeRoot(runRoot);
  assertId(transactionId, ID_PATTERNS.transaction, "transaction.invalid-input");
  return withRootLock(root, async () => {
    const limits = limitsFrom(options);
    const committedPath = transactionDirectory(root, "committed", transactionId);
    if (await pathExists(committedPath)) {
      const existing = await verifyDirectory(root, "committed", transactionId, limits);
      const stagePath = transactionDirectory(root, ".staging", transactionId);
      if (await pathExists(stagePath)) {
        const staged = await verifyDirectory(root, ".staging", transactionId, limits).catch(() => fail("transaction.id-conflict"));
        if (staged.manifestSha256 !== existing.manifestSha256) fail("transaction.id-conflict");
      }
      await syncRenameParents(root, options);
      return manifestRef(existing.manifest, existing.manifestSha256);
    }

    const staged = await verifyDirectory(root, ".staging", transactionId, limits).catch((error) => {
      if (error instanceof TransactionStoreError && error.code === "transaction.missing-object") fail("transaction.not-prepared");
      throw error;
    });
    const stagePath = transactionDirectory(root, ".staging", transactionId);
    await protocolStep("before-rename", options);
    try {
      await (options.rename ?? nodeRename)(stagePath, committedPath);
    } catch {
      fail("transaction.io-failed");
    }
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
  const root = await initializeRoot(runRoot);
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
  const root = await initializeRoot(runRoot);
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
  const root = await initializeRoot(runRoot);
  return withRootLock(root, async () => {
    const results = new Map<string, Extract<FoundationLedgerEvent, { type: "result_recorded" }>>();
    const commits = new Map<string, Extract<FoundationLedgerEvent, { type: "records_committed" }>>();
    for (const event of events) {
      if (event.type === "result_recorded") results.set(event.payload.transactionId, event);
      if (event.type === "records_committed") commits.set(event.payload.transactionId, event);
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
  const root = await initializeRoot(runRoot);
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
}
interface BuiltTransaction {
  manifest: CanonicalTransactionManifest;
  manifestBytes: Buffer;
  manifestSha256: string;
  files: Record<CanonicalRecordKind, Buffer>;
}

function snapshotTransactionInput(input: CanonicalTransactionInput): CanonicalTransactionInput {
  try {
    return JSON.parse(canonicalJson(input)) as CanonicalTransactionInput;
  } catch {
    fail("transaction.invalid-input");
  }
}

function buildTransaction(input: CanonicalTransactionInput, limits: Limits): BuiltTransaction {
  validateInputRoot(input);
  const files = Object.create(null) as Record<CanonicalRecordKind, Buffer>;
  const manifestFiles: CanonicalTransactionManifest["files"] = [];
  const recordsByKind = Object.create(null) as Record<CanonicalRecordKind, JsonRecord[]>;
  for (const kind of KINDS) {
    const records = validateAndSortRecords(kind, input[kind], input.attemptId, limits);
    recordsByKind[kind] = records;
    const bytes = Buffer.from(records.map((record) => `${canonicalJson(record)}\n`).join(""), "utf8");
    if (bytes.byteLength > limits.maxFileBytes) fail("transaction.file-too-large");
    files[kind] = bytes;
    manifestFiles.push({ kind, relativePath: `${kind}.jsonl`, recordCount: records.length, decodedBytes: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
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
  if (manifestBytes.byteLength > limits.maxFileBytes) fail("transaction.file-too-large");
  return { manifest: structuredClone(manifest), manifestBytes, manifestSha256: sha256Hex(manifestBytes), files };
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
  const output = values.map((record) => {
    try { canonicalJson(record); } catch { fail("transaction.invalid-record"); }
    if (record === null || typeof record !== "object" || Array.isArray(record) || utilTypes.isProxy(record)) fail("transaction.invalid-record");
    if (record.schemaVersion !== 1) fail("transaction.invalid-record");
    const id = record[metadata.field];
    if (typeof id !== "string" || !metadata.pattern.test(id)) fail("transaction.invalid-record");
    for (const field of ALL_ID_FIELDS) {
      if (field !== metadata.field && Object.prototype.hasOwnProperty.call(record, field)) fail("transaction.cross-kind-id");
    }
    if (metadata.revision && (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1)) fail("transaction.invalid-record");
    if (!metadata.revision && Object.prototype.hasOwnProperty.call(record, "revision")) fail("transaction.invalid-record");
    if (kind === "requests") {
      const parsed = parse(RequestRecordSchema, record);
      if (!parsed.success || parsed.value.attemptId !== attemptId) fail("transaction.invalid-record");
    }
    const cloned = JSON.parse(canonicalJson(record)) as JsonRecord;
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

async function verifyDirectory(root: string, location: ".staging" | "committed", transactionId: string, limits: Limits): Promise<VerifiedTransaction> {
  const directory = transactionDirectory(root, location, transactionId);
  if (!(await pathExists(directory))) fail("transaction.missing-object");
  await assertSafeDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("transaction.corrupt"));
  const expected = new Set([...KINDS.map((kind) => `${kind}.jsonl`), MANIFEST_FILE]);
  if (entries.some((entry) => entry.isSymbolicLink())) fail("transaction.unsafe-file");
  if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || !expected.has(entry.name))) fail("transaction.corrupt");
  const manifestBytes = await readSafeFile(join(directory, MANIFEST_FILE), Math.min(limits.maxFileBytes, limits.maxLineBytes), limits);
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

async function initializeRoot(runRoot: string): Promise<string> {
  const root = resolve(runRoot);
  await assertSafeDirectory(root);
  let current = root;
  for (const segment of [".state", "transactions", ".staging"] as const) {
    current = join(current, segment);
    await ensureDirectory(current);
  }
  await ensureDirectory(join(root, ".state/transactions/committed"));
  return root;
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!isNodeError(error, "EEXIST")) fail("transaction.io-failed");
  }
  await assertSafeDirectory(path);
}

async function assertSafeDirectory(path: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch { fail("transaction.unsafe-root"); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("transaction.unsafe-root");
}

async function writeExclusiveFile(path: string, bytes: Buffer, step: TransactionProtocolStep, options: TransactionStoreOptions): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("transaction.unsafe-file");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesWritten < 1) fail("transaction.io-failed");
      offset += bytesWritten;
    }
    await durability(handle, step, options);
  } catch (error) {
    failure = error;
  }
  if (handle) failure = await closeForOperation(handle, options, failure);
  if (failure) throw normalize(failure);
  await protocolStep(step, options);
}

/**
 * A renamed directory is roll-forward state. Persist the destination name
 * first, then removal of the source name. Retries repeat both fsyncs.
 */
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
  const readChunk = options.readChunk ?? (async (handle: FileHandle, buffer: Buffer, position: number) => {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    return bytesRead;
  });
  return { maxFileBytes, maxLineBytes: Math.min(maxLineBytes, maxFileBytes), maxRecords, readChunk };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) fail("transaction.invalid-input");
  return value;
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
