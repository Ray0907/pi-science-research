import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export type DurabilityReason = "append" | "truncate";
export type DurabilityHook = (handle: FileHandle, reason: DurabilityReason) => Promise<void>;

/** Opens a ledger leaf without following a symlink when the platform supports O_NOFOLLOW. */
export async function openAppendOnlyLeaf(path: string): Promise<FileHandle> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new AtomicFileError("symlink");
    if (!stat.isFile()) throw new AtomicFileError("not-file");
  } catch (error) {
    if (error instanceof AtomicFileError) throw error;
    if (!isNodeError(error, "ENOENT")) throw new AtomicFileError("open-failed");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    return await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | noFollow, 0o600);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) throw new AtomicFileError("symlink");
    throw new AtomicFileError("open-failed");
  }
}

export async function appendFully(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new AtomicFileError("write-failed");
    offset += bytesWritten;
  }
}

export async function truncateDurably(
  handle: FileHandle,
  size: number,
  durability: DurabilityHook,
): Promise<void> {
  await handle.truncate(size);
  await durability(handle, "truncate");
}

export const defaultDurability: DurabilityHook = async (handle) => {
  await handle.sync();
};

export class AtomicFileError extends Error {
  readonly code: "symlink" | "not-file" | "open-failed" | "write-failed";

  constructor(code: AtomicFileError["code"]) {
    super(`Atomic file operation failed (${code})`);
    this.name = "AtomicFileError";
    this.code = code;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
