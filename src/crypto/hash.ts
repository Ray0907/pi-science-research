import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { CanonicalJsonError, canonicalJsonBytes } from "./canonical-json.js";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hashes an event without its root entrySha256 field, framed by one LF byte. */
export function hashLedgerEvent(event: object): string {
  if (utilTypes.isProxy(event)) {
    throw new CanonicalJsonError("proxy-value");
  }

  const prototype = Object.getPrototypeOf(event);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError("non-plain-object");
  }

  const hashInput = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(event)) {
    if (typeof key !== "string") {
      throw new CanonicalJsonError("unsupported-property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new CanonicalJsonError("unsupported-property");
    }
    if (key !== "entrySha256") hashInput[key] = descriptor.value;
  }

  const framed = Buffer.concat([
    canonicalJsonBytes(hashInput),
    Buffer.from("\n", "utf8"),
  ]);
  return sha256Hex(framed);
}
