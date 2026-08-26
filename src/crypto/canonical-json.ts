export type CanonicalJsonErrorCode =
  | "unsupported-type"
  | "non-finite-number"
  | "ill-formed-unicode"
  | "sparse-array"
  | "non-plain-object"
  | "unsupported-property"
  | "cyclic-value";

/**
 * Indicates that a value is outside the closed JSON data model accepted by the
 * research ledger. Messages intentionally omit values, keys, and paths.
 */
export class CanonicalJsonError extends TypeError {
  readonly code: CanonicalJsonErrorCode;

  constructor(code: CanonicalJsonErrorCode) {
    super(`Canonical JSON rejected input (${code})`);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}

/**
 * Serializes the schema-supported RFC 8785/JCS subset. Inputs are restricted to
 * null, booleans, finite numbers, well-formed strings, dense arrays, and plain
 * data objects; arbitrary JavaScript values are deliberately unsupported.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) fail("non-finite-number");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
      assertWellFormedUnicode(value);
      return JSON.stringify(value);
    case "object":
      return serializeObject(value, ancestors);
    default:
      return fail("unsupported-type");
  }
}

function serializeObject(value: object, ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) fail("cyclic-value");
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, ancestors)
      : serializePlainObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], ancestors: WeakSet<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !isCanonicalArrayIndex(key, value.length)),
    )
  ) {
    fail("unsupported-property");
  }

  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) fail("sparse-array");
    assertEnumerableDataProperty(descriptor);
    parts.push(serialize(descriptor.value, ancestors));
  }

  return `[${parts.join(",")}]`;
}

function serializePlainObject(
  value: object,
  ancestors: WeakSet<object>,
): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("non-plain-object");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail("unsupported-property");
  }

  const stringKeys = keys as string[];
  for (const key of stringKeys) assertWellFormedUnicode(key);
  stringKeys.sort();

  const parts: string[] = [];
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) fail("unsupported-property");
    assertEnumerableDataProperty(descriptor);
    parts.push(`${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`);
  }

  return `{${parts.join(",")}}`;
}

function assertEnumerableDataProperty(
  descriptor: PropertyDescriptor,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (!descriptor.enumerable || !("value" in descriptor)) {
    fail("unsupported-property");
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        fail("ill-formed-unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("ill-formed-unicode");
    }
  }
}

function fail(code: CanonicalJsonErrorCode): never {
  throw new CanonicalJsonError(code);
}
