import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { hashLedgerEvent } from "../crypto/hash.js";
import {
  FOUNDATION_EVENT_TYPES,
  FoundationLedgerEventSchema,
  type FoundationEventOfType,
  type FoundationEventPayload,
  type FoundationEventType,
  type FoundationLedgerEvent,
  type ReservedIdentityKind,
  type ReservedIdentityOrigin,
} from "../domain/events.js";
import { ID_PATTERNS, isTimestamp } from "../domain/ids.js";
import { reduceLedgerEvents } from "../domain/reducer.js";
import { parse } from "../domain/schema.js";
import {
  appendFully,
  AtomicFileError,
  defaultDurability,
  openAppendOnlyLeaf,
  type DurabilityHook,
  type DurabilityReason,
} from "./atomic.js";

export { FOUNDATION_EVENT_TYPES } from "../domain/events.js";
export type { DurabilityReason } from "./atomic.js";

const ZERO_HASH = "0".repeat(64);
export const DEFAULT_MAX_LEDGER_LINE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const openPaths = new Set<string>();
const openPhysicalFiles = new Set<string>();
let registryQueue: Promise<void> = Promise.resolve();

export interface LedgerDescriptorStat {
  dev: bigint | number;
  ino: bigint | number;
  isFile(): boolean;
}

export interface EventLedgerIo {
  stat(handle: FileHandle): Promise<LedgerDescriptorStat>;
  append(handle: FileHandle, bytes: Uint8Array): Promise<void>;
  truncate(handle: FileHandle, size: number): Promise<void>;
  close(handle: FileHandle): Promise<void>;
}

export interface VerifiedLedgerSnapshotOptions {
  maxLineBytes?: number;
  trustedRoot?: string;
  onCheck?: (phase: "before-final-path-check") => void | Promise<void>;
}

export interface EventLedgerOptions {
  now?: () => Date;
  eventId?: () => string;
  durability?: DurabilityHook;
  maxLineBytes?: number;
  io?: Partial<EventLedgerIo>;
}

export interface EventLedger {
  append<T extends FoundationEventType>(type: T, payload: FoundationEventPayload<T>): Promise<FoundationEventOfType<T>>;
  reserveIdentity(kind: ReservedIdentityKind, id: string, origin: ReservedIdentityOrigin): Promise<FoundationEventOfType<"identity_reserved">>;
  readAll(): Promise<FoundationLedgerEvent[]>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export type EventLedgerErrorCode =
  | "ledger.already-open"
  | "ledger.closed"
  | "ledger.unavailable"
  | "ledger.symlink"
  | "ledger.open-failed"
  | "ledger.read-failed"
  | "ledger.invalid-utf8"
  | "ledger.not-file"
  | "ledger.write-failed"
  | "ledger.truncate-failed"
  | "ledger.close-failed"
  | "ledger.durability-failed"
  | "ledger.concurrent-mutation"
  | "ledger.line-too-large"
  | "ledger.empty-line"
  | "ledger.torn-tail"
  | "ledger.invalid-json"
  | "ledger.noncanonical-line"
  | "ledger.schema-invalid"
  | "ledger.sequence-mismatch"
  | "ledger.previous-hash-mismatch"
  | "ledger.hash-mismatch"
  | "ledger.duplicate-event-id"
  | "event.schema-invalid"
  | "event.duplicate-id"
  | "identity.kind-mismatch"
  | "identity.already-reserved"
  | "identity.not-reserved";

export class EventLedgerError extends Error {
  readonly code: EventLedgerErrorCode;

  constructor(code: EventLedgerErrorCode) {
    super(`Event ledger operation failed (${code})`);
    this.name = "EventLedgerError";
    this.code = code;
  }
}

export async function readVerifiedLedgerSnapshot(
  path: string,
  options: VerifiedLedgerSnapshotOptions = {},
): Promise<FoundationLedgerEvent[]> {
  const canonicalPath = resolve(path);
  const maxLineBytes = validateMaxLineBytes(options.maxLineBytes ?? DEFAULT_MAX_LEDGER_LINE_BYTES);
  let handle: FileHandle | undefined;
  let parentGuard: SnapshotParent[] = [];
  try {
    if (options.trustedRoot !== undefined) parentGuard = await pinSnapshotParents(options.trustedRoot, canonicalPath);
    const beforePath = await lstat(canonicalPath, { bigint: true });
    if (beforePath.isSymbolicLink()) throw new EventLedgerError("ledger.symlink");
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new EventLedgerError("ledger.not-file");
    if (!sameStableFile(before, beforePath)) throw new EventLedgerError("ledger.concurrent-mutation");
    const events = await scanLedger(handle, maxLineBytes, false, defaultDurability, defaultIo);
    reduceLedgerEvents(events);
    await options.onCheck?.("before-final-path-check");
    const [after, afterPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(canonicalPath, { bigint: true }),
    ]);
    if (afterPath.isSymbolicLink() || !sameStableFile(before, after) || !sameStableFile(before, afterPath)) {
      throw new EventLedgerError("ledger.concurrent-mutation");
    }
    await assertSnapshotParents(parentGuard);
    return events;
  } catch (error) {
    if (error instanceof EventLedgerError || error instanceof Error && error.name === "LedgerReducerCorruptionError") throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") throw new EventLedgerError("ledger.symlink");
    throw new EventLedgerError("ledger.open-failed");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await Promise.all(parentGuard.map(({ handle: parent }) => parent.close().catch(() => undefined)));
  }
}

interface SnapshotParent {
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function pinSnapshotParents(trustedRoot: string, target: string): Promise<SnapshotParent[]> {
  const root = resolve(trustedRoot);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new EventLedgerError("ledger.open-failed");
  }
  const paths = [root];
  let current = root;
  for (const segment of rel.split(sep).slice(0, -1)) {
    current = join(current, segment);
    paths.push(current);
  }
  const pinned: SnapshotParent[] = [];
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directory = constants.O_DIRECTORY ?? 0;
  try {
    for (const parentPath of paths) {
      const before = await lstat(parentPath, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory()) throw new EventLedgerError("ledger.symlink");
      const parent = await open(parentPath, constants.O_RDONLY | noFollow | directory);
      const descriptor = await parent.stat({ bigint: true });
      const pathname = await lstat(parentPath, { bigint: true });
      if (!descriptor.isDirectory() || pathname.isSymbolicLink() || !sameStableDirectory(descriptor, pathname)) {
        await parent.close().catch(() => undefined);
        throw new EventLedgerError("ledger.symlink");
      }
      pinned.push({ path: parentPath, handle: parent, dev: descriptor.dev, ino: descriptor.ino, mtimeNs: descriptor.mtimeNs, ctimeNs: descriptor.ctimeNs });
    }
    return pinned;
  } catch (error) {
    await Promise.all(pinned.map(({ handle: parent }) => parent.close().catch(() => undefined)));
    if (error instanceof EventLedgerError) throw error;
    throw new EventLedgerError("ledger.open-failed");
  }
}

async function assertSnapshotParents(parents: readonly SnapshotParent[]): Promise<void> {
  for (const parent of parents) {
    const [descriptor, pathname] = await Promise.all([
      parent.handle.stat({ bigint: true }),
      lstat(parent.path, { bigint: true }),
    ]).catch(() => { throw new EventLedgerError("ledger.concurrent-mutation"); });
    if (pathname.isSymbolicLink() || !descriptor.isDirectory() || !sameStableDirectory(descriptor, pathname)
      || descriptor.dev !== parent.dev || descriptor.ino !== parent.ino
      || descriptor.mtimeNs !== parent.mtimeNs || descriptor.ctimeNs !== parent.ctimeNs) {
      throw new EventLedgerError("ledger.concurrent-mutation");
    }
  }
}

function sameStableDirectory(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function openEventLedger(path: string, options: EventLedgerOptions = {}): Promise<EventLedger> {
  const canonicalPath = resolve(path);
  const io = resolveIo(options.io);
  let pathRegistered = false;
  let physicalIdentity: string | undefined;
  let physicalRegistered = false;
  let handle: FileHandle | undefined;

  try {
    await withRegistry(() => {
      if (openPaths.has(canonicalPath)) throw new EventLedgerError("ledger.already-open");
      openPaths.add(canonicalPath);
      pathRegistered = true;
    });
    const maxLineBytes = validateMaxLineBytes(options.maxLineBytes ?? DEFAULT_MAX_LEDGER_LINE_BYTES);
    const durability = options.durability ?? defaultDurability;
    handle = await openLeaf(canonicalPath);
    const stat = await descriptorStat(io, handle);
    if (!stat.isFile()) throw new EventLedgerError("ledger.not-file");
    physicalIdentity = descriptorIdentity(stat);
    await withRegistry(() => {
      if (openPhysicalFiles.has(physicalIdentity!)) throw new EventLedgerError("ledger.already-open");
      openPhysicalFiles.add(physicalIdentity!);
      physicalRegistered = true;
    });
    const events = await scanLedger(handle, maxLineBytes, true, durability, io);
    return createLedger(handle, events, {
      now: options.now ?? (() => new Date()),
      eventId: options.eventId ?? (() => `event-${randomUUID()}`),
      durability,
      maxLineBytes,
      io,
    }, async () => releaseRegistry(canonicalPath, physicalRegistered ? physicalIdentity : undefined));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (pathRegistered) await releaseRegistry(canonicalPath, physicalRegistered ? physicalIdentity : undefined);
    throw normalizeOpenError(error);
  }
}

interface ResolvedOptions {
  now: () => Date;
  eventId: () => string;
  durability: DurabilityHook;
  maxLineBytes: number;
  io: EventLedgerIo;
}

function createLedger(
  handle: FileHandle,
  initialEvents: FoundationLedgerEvent[],
  options: ResolvedOptions,
  releaseOpenRegistration: () => Promise<void>,
): EventLedger {
  const events = initialEvents.map(cloneEvent);
  const eventIds = new Set(events.map((event) => event.eventId));
  const reservations = new Set(
    events
      .filter((event): event is FoundationEventOfType<"identity_reserved"> => event.type === "identity_reserved")
      .map((event) => reservationKey(event.payload.kind, event.payload.id)),
  );
  let queue: Promise<void> = Promise.resolve();
  let closeRequested = false;
  let closePromise: Promise<void> | undefined;
  let fatal = false;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertWritable(): void {
    if (closeRequested) throw new EventLedgerError("ledger.closed");
    if (fatal) throw new EventLedgerError("ledger.unavailable");
  }

  async function appendInternal<T extends FoundationEventType>(
    type: T,
    payload: FoundationEventPayload<T>,
  ): Promise<FoundationEventOfType<T>> {
    if (fatal) throw new EventLedgerError("ledger.unavailable");
    const previous = events.at(-1);
    const eventWithoutHash = {
      schemaVersion: 1,
      seq: (previous?.seq ?? 0) + 1,
      occurredAt: safeTimestamp(options.now),
      eventId: safeEventId(options.eventId),
      type,
      payload,
      prevSha256: previous?.entrySha256 ?? ZERO_HASH,
    };
    const candidate = {
      ...eventWithoutHash,
      entrySha256: hashLedgerEvent(eventWithoutHash),
    };
    const parsed = parse(FoundationLedgerEventSchema, candidate);
    if (!parsed.success) throw new EventLedgerError("event.schema-invalid");
    const event = parsed.value as FoundationEventOfType<T>;
    if (eventIds.has(event.eventId)) throw new EventLedgerError("event.duplicate-id");
    validateReservationEvent(event, reservations, "append");
    validateReservedReferences(event, reservations, "append");

    const encoded = Buffer.from(`${canonicalJson(event)}\n`, "utf8");
    if (encoded.byteLength - 1 > options.maxLineBytes) throw new EventLedgerError("ledger.line-too-large");
    try {
      await options.io.append(handle, encoded);
    } catch {
      // A failed or partial write makes the live writer uncertain; it remains
      // readable for diagnostics but all subsequent writes fail closed.
      fatal = true;
      throw new EventLedgerError("ledger.write-failed");
    }
    try {
      await options.durability(handle, "append");
    } catch {
      fatal = true;
      throw new EventLedgerError("ledger.durability-failed");
    }

    events.push(cloneEvent(event));
    eventIds.add(event.eventId);
    if (event.type === "identity_reserved") {
      const reservation = event as FoundationEventOfType<"identity_reserved">;
      reservations.add(reservationKey(reservation.payload.kind, reservation.payload.id));
    }
    return cloneEvent(event) as FoundationEventOfType<T>;
  }

  return {
    append(type, payload) {
      try {
        assertWritable();
        const snapshot = snapshotAppendPayload(payload);
        return enqueue(() => appendInternal(type, snapshot));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    reserveIdentity(kind, id, origin) {
      try {
        assertWritable();
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(async () => {
        validateIdentity(kind, id);
        return appendInternal("identity_reserved", { kind, id, origin });
      });
    },
    readAll() {
      return enqueue(async () => events.map(cloneEvent));
    },
    verify() {
      return enqueue(async () => {
        let scanned: FoundationLedgerEvent[];
        try {
          scanned = await scanLedger(handle, options.maxLineBytes, false, options.durability, options.io);
        } catch (error) {
          throw normalizeReadError(error);
        }
        if (scanned.length !== events.length || scanned.some((event, index) => event.entrySha256 !== events[index]?.entrySha256)) {
          throw new EventLedgerError("ledger.hash-mismatch");
        }
      });
    },
    close() {
      if (closePromise) return closePromise;
      closeRequested = true;
      closePromise = enqueue(async () => {
        try {
          await closeLedgerHandle(handle, options.io.close);
        } finally {
          await releaseOpenRegistration();
        }
      });
      return closePromise;
    },
  };
}

async function scanLedger(
  handle: FileHandle,
  maxLineBytes: number,
  recoverTornTail: boolean,
  durability: DurabilityHook,
  io: EventLedgerIo,
): Promise<FoundationLedgerEvent[]> {
  const events: FoundationLedgerEvent[] = [];
  const eventIds = new Set<string>();
  const reservations = new Set<string>();
  const parts: Buffer[] = [];
  let partsLength = 0;
  let lineOverflow = false;
  let position = 0;
  let committedBoundary = 0;
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);

  for (;;) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position));
    } catch {
      throw new EventLedgerError("ledger.read-failed");
    }
    if (bytesRead === 0) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline < 0 || newline >= bytesRead) {
        addLinePart(chunk.subarray(cursor, bytesRead));
        break;
      }
      addLinePart(chunk.subarray(cursor, newline));
      if (lineOverflow) throw new EventLedgerError("ledger.line-too-large");
      if (partsLength === 0) throw new EventLedgerError("ledger.empty-line");
      const line = Buffer.concat(parts, partsLength);
      const event = parseLedgerLine(line, events.at(-1), eventIds, reservations);
      events.push(event);
      eventIds.add(event.eventId);
      if (event.type === "identity_reserved") reservations.add(reservationKey(event.payload.kind, event.payload.id));
      parts.length = 0;
      partsLength = 0;
      committedBoundary = position + newline + 1;
      cursor = newline + 1;
    }
    position += bytesRead;
  }

  if (partsLength > 0 || lineOverflow) {
    if (!recoverTornTail) throw new EventLedgerError("ledger.torn-tail");
    try {
      await io.truncate(handle, committedBoundary);
    } catch {
      throw new EventLedgerError("ledger.truncate-failed");
    }
    try {
      await durability(handle, "truncate");
    } catch {
      throw new EventLedgerError("ledger.durability-failed");
    }
  }
  return events;

  function addLinePart(part: Buffer): void {
    if (part.byteLength === 0) return;
    if (lineOverflow || partsLength + part.byteLength > maxLineBytes) {
      lineOverflow = true;
      parts.length = 0;
      partsLength = 0;
      return;
    }
    parts.push(Buffer.from(part));
    partsLength += part.byteLength;
  }
}

function parseLedgerLine(
  line: Buffer,
  previous: FoundationLedgerEvent | undefined,
  eventIds: Set<string>,
  reservations: Set<string>,
): FoundationLedgerEvent {
  let decoded: string;
  try {
    decoded = fatalUtf8Decoder.decode(line);
  } catch {
    throw new EventLedgerError("ledger.invalid-utf8");
  }

  let input: unknown;
  try {
    input = JSON.parse(decoded);
  } catch {
    throw new EventLedgerError("ledger.invalid-json");
  }

  let canonical: string;
  try {
    canonical = canonicalJson(input);
  } catch {
    throw new EventLedgerError("ledger.schema-invalid");
  }
  if (!Buffer.from(canonical, "utf8").equals(line)) throw new EventLedgerError("ledger.noncanonical-line");
  const parsed = parse(FoundationLedgerEventSchema, input);
  if (!parsed.success) throw new EventLedgerError("ledger.schema-invalid");
  const event = parsed.value as unknown as FoundationLedgerEvent;
  if (event.seq !== (previous?.seq ?? 0) + 1) throw new EventLedgerError("ledger.sequence-mismatch");
  if (event.prevSha256 !== (previous?.entrySha256 ?? ZERO_HASH)) throw new EventLedgerError("ledger.previous-hash-mismatch");
  if (event.entrySha256 !== hashLedgerEvent(event)) throw new EventLedgerError("ledger.hash-mismatch");
  if (eventIds.has(event.eventId)) throw new EventLedgerError("ledger.duplicate-event-id");
  validateReservationEvent(event, reservations, "replay");
  validateReservedReferences(event, reservations, "replay");
  return cloneEvent(event);
}

function validateReservationEvent(
  event: FoundationLedgerEvent,
  reservations: Set<string>,
  mode: "append" | "replay",
): void {
  if (event.type !== "identity_reserved") return;
  validateIdentity(event.payload.kind, event.payload.id);
  if (reservations.has(reservationKey(event.payload.kind, event.payload.id))) {
    throw new EventLedgerError(mode === "append" ? "identity.already-reserved" : "ledger.schema-invalid");
  }
}

function validateReservedReferences(
  event: FoundationLedgerEvent,
  reservations: Set<string>,
  mode: "append" | "replay",
): void {
  const references: { kind: ReservedIdentityKind; id: string }[] = [];
  const add = (kind: ReservedIdentityKind, id: string | null) => {
    if (id !== null) references.push({ kind, id });
  };

  switch (event.type) {
    case "identity_reserved":
    case "state_changed":
    case "resume_epoch_started":
    case "active_time_checkpoint":
    case "budget_amended":
    case "cancel_requested":
    case "lock_recovered":
      break;
    case "run_created":
      event.payload.run.attemptRefs.forEach((ref) => add("attempt", ref.attemptId));
      add("revision", event.payload.run.currentRevisionId);
      break;
    case "task_upserted":
      event.payload.task.attemptIds.forEach((id) => add("attempt", id));
      break;
    case "dispatch_intent":
      add("attempt", event.payload.attempt.attemptId);
      if (event.payload.attempt.retryOfAttemptId !== null) add("attempt", event.payload.attempt.retryOfAttemptId);
      break;
    case "dispatch_started":
    case "attempt_usage_recorded":
    case "attempt_failed":
      add("attempt", event.payload.attemptId);
      break;
    case "result_recorded":
      add("attempt", event.payload.attemptId);
      add("transaction", event.payload.transactionId);
      break;
    case "request_intent_recorded":
      add("attempt", event.payload.attemptId);
      add("request", event.payload.intent.requestId);
      if (event.payload.intent.retryOfRequestId !== null) add("request", event.payload.intent.retryOfRequestId);
      break;
    case "request_result_recorded":
      add("attempt", event.payload.attemptId);
      add("request", event.payload.request.requestId);
      if (event.payload.request.retryOfRequestId !== null) add("request", event.payload.request.retryOfRequestId);
      break;
    case "request_retry_scheduled":
      add("retry-schedule", event.payload.scheduleId);
      add("attempt", event.payload.attemptId);
      add("request", event.payload.failedRequestId);
      break;
    case "request_retry_started":
      add("retry-schedule", event.payload.scheduleId);
      add("attempt", event.payload.attemptId);
      add("request", event.payload.requestId);
      break;
    case "records_committed":
      add("transaction", event.payload.transactionId);
      event.payload.requestIds.forEach((id) => add("request", id));
      break;
    case "attempt_committed":
      add("attempt", event.payload.attemptId);
      add("transaction", event.payload.transactionId);
      break;
    case "retry_scheduled":
      add("retry-schedule", event.payload.scheduleId);
      add("attempt", event.payload.failedAttemptId);
      break;
    case "retry_started":
      add("retry-schedule", event.payload.scheduleId);
      add("attempt", event.payload.attemptId);
      break;
    case "revision_prepared":
    case "revision_committed":
    case "revision_failed":
    case "run_completed":
      add("revision", event.payload.revisionId);
      break;
  }

  if (references.some(({ kind, id }) => !reservations.has(reservationKey(kind, id)))) {
    throw new EventLedgerError(mode === "append" ? "identity.not-reserved" : "ledger.schema-invalid");
  }
}

const identityPatterns: Record<ReservedIdentityKind, RegExp> = {
  attempt: ID_PATTERNS.attempt,
  request: ID_PATTERNS.request,
  "retry-schedule": ID_PATTERNS.retry,
  transaction: ID_PATTERNS.transaction,
  revision: ID_PATTERNS.revision,
};

function validateIdentity(kind: ReservedIdentityKind, id: string): void {
  if (!identityPatterns[kind]?.test(id)) throw new EventLedgerError("identity.kind-mismatch");
}

function reservationKey(kind: ReservedIdentityKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function safeTimestamp(now: () => Date): string {
  try {
    const timestamp = now().toISOString();
    if (!isTimestamp(timestamp)) throw new Error("invalid");
    return timestamp;
  } catch {
    throw new EventLedgerError("event.schema-invalid");
  }
}

function safeEventId(generator: () => string): string {
  try {
    const id = generator();
    if (typeof id !== "string") throw new Error("invalid");
    return id;
  } catch {
    throw new EventLedgerError("event.schema-invalid");
  }
}

async function openLeaf(path: string): Promise<FileHandle> {
  try {
    return await openAppendOnlyLeaf(path);
  } catch (error) {
    if (error instanceof AtomicFileError && error.code === "symlink") throw new EventLedgerError("ledger.symlink");
    throw new EventLedgerError("ledger.open-failed");
  }
}

const defaultIo: EventLedgerIo = {
  stat: async (handle) => handle.stat({ bigint: true }),
  append: appendFully,
  truncate: async (handle, size) => handle.truncate(size),
  close: async (handle) => handle.close(),
};

function resolveIo(overrides: Partial<EventLedgerIo> | undefined): EventLedgerIo {
  return { ...defaultIo, ...overrides };
}

async function descriptorStat(io: EventLedgerIo, handle: FileHandle): Promise<LedgerDescriptorStat> {
  try {
    return await io.stat(handle);
  } catch {
    throw new EventLedgerError("ledger.open-failed");
  }
}

function descriptorIdentity(stat: LedgerDescriptorStat): string {
  if (!isDescriptorNumber(stat.dev) || !isDescriptorNumber(stat.ino)) {
    throw new EventLedgerError("ledger.open-failed");
  }
  return `${stat.dev}:${stat.ino}`;
}

function isDescriptorNumber(value: bigint | number): boolean {
  return typeof value === "bigint" ? value >= 0n : Number.isSafeInteger(value) && value >= 0;
}

async function closeLedgerHandle(handle: FileHandle, closeOperation: EventLedgerIo["close"]): Promise<void> {
  try {
    await closeOperation(handle);
  } catch {
    // The injected/primary close may fail before closing. Retry the native close
    // only for cleanup, while preserving a fixed primary failure classification.
    await handle.close().catch(() => undefined);
    throw new EventLedgerError("ledger.close-failed");
  }
}

function snapshotAppendPayload<T extends FoundationEventType>(payload: FoundationEventPayload<T>): FoundationEventPayload<T> {
  try {
    return JSON.parse(canonicalJson(payload)) as FoundationEventPayload<T>;
  } catch {
    throw new EventLedgerError("event.schema-invalid");
  }
}

function withRegistry<T>(operation: () => T): Promise<T> {
  const result = registryQueue.then(operation);
  registryQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function releaseRegistry(canonicalPath: string, physicalIdentity: string | undefined): Promise<void> {
  await withRegistry(() => {
    openPaths.delete(canonicalPath);
    if (physicalIdentity !== undefined) openPhysicalFiles.delete(physicalIdentity);
  });
}

function validateMaxLineBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new EventLedgerError("ledger.open-failed");
  return value;
}

function normalizeOpenError(error: unknown): Error {
  if (error instanceof EventLedgerError) return error;
  return new EventLedgerError("ledger.open-failed");
}

function normalizeReadError(error: unknown): Error {
  if (error instanceof EventLedgerError) return error;
  return new EventLedgerError("ledger.read-failed");
}

function cloneEvent<T extends FoundationLedgerEvent>(event: T): T {
  return structuredClone(event);
}
