import { randomBytes as nodeRandomBytes } from "node:crypto";

export const ID_PATTERNS = {
  run: /^run-[a-z0-9]{16,64}$/,
  task: /^task-[a-z0-9]{16,64}$/,
  attempt: /^attempt-[a-z0-9]{16,64}$/,
  source: /^src-[a-z0-9]{16,64}$/,
  claim: /^claim-[a-z0-9]{16,64}$/,
  evidence: /^ev-[a-z0-9]{16,64}$/,
  verification: /^verify-[a-z0-9]{16,64}$/,
  request: /^request-[a-z0-9]{16,64}$/,
  calculation: /^calc-[a-z0-9]{16,64}$/,
  revision: /^rev-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/,
  retry: /^retry-[a-z0-9]{16,64}$/,
  transaction: /^tx-[a-z0-9]{16,64}$/,
} as const;

export type IdKind = keyof typeof ID_PATTERNS;
export type RunId = `run-${string}`;
export type TaskId = `task-${string}`;
export type AttemptId = `attempt-${string}`;
export type SourceId = `src-${string}`;
export type ClaimId = `claim-${string}`;
export type EvidenceId = `ev-${string}`;
export type VerificationId = `verify-${string}`;
export type RequestId = `request-${string}`;
export type CalculationId = `calc-${string}`;
export type RevisionId = `rev-${string}`;
export type RetryScheduleId = `retry-${string}`;
export type TransactionId = `tx-${string}`;
export type Sha256 = string;
export type Timestamp = string;

const PREFIXES: Record<Exclude<IdKind, "revision">, string> = {
  run: "run",
  task: "task",
  attempt: "attempt",
  source: "src",
  claim: "claim",
  evidence: "ev",
  verification: "verify",
  request: "request",
  calculation: "calc",
  retry: "retry",
  transaction: "tx",
};

export interface IdGeneratorOptions {
  randomBytes?: (size: number) => Uint8Array;
  now?: () => Date;
}

export interface IdGenerator {
  next(kind: IdKind): string;
}

export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const now = options.now ?? (() => new Date());
  const emitted = new Set<string>();

  return {
    next(kind) {
      for (let collisions = 0; collisions < 1024; collisions += 1) {
        const bytes = Buffer.from(randomBytes(kind === "revision" ? 6 : 16));
        const suffix = bytes.toString("hex");
        const value = kind === "revision"
          ? `rev-${compactUtc(now())}-${suffix}`
          : `${PREFIXES[kind]}-${suffix}`;
        if (!emitted.has(value)) {
          emitted.add(value);
          return value;
        }
      }
      throw new Error("Unable to generate a unique identity");
    },
  };
}

function compactUtc(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Identity clock returned an invalid date");
  return date.toISOString().replace(/[-:.]/g, "");
}

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isTimestamp(value: unknown): value is Timestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
