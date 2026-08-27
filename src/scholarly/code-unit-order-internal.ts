const RADIX = 256;

export type CodeUnitOrderErrorCodeInternal =
  | "code-unit-order.invalid-bound"
  | "code-unit-order.too-many-items"
  | "code-unit-order.invalid-key"
  | "code-unit-order.accounting-overflow";

/** Package-internal closed failure for bounded radix ordering. */
export class CodeUnitOrderErrorInternal extends Error {
  readonly code: CodeUnitOrderErrorCodeInternal;
  constructor(code: CodeUnitOrderErrorCodeInternal) {
    super(`Code-unit ordering rejected (${code})`);
    this.name = "CodeUnitOrderErrorInternal";
    this.code = code;
  }
}

export interface CodeUnitOrderBoundsInternal {
  /** A ceiling already validated by the calling module before this utility allocates. */
  readonly maxItems: number;
}

interface KeyedValue<T> {
  readonly key: string;
  readonly value: T;
}

type Frame<T> =
  | { readonly kind: "high"; readonly items: readonly KeyedValue<T>[]; readonly offset: number }
  | { readonly kind: "low"; readonly items: readonly KeyedValue<T>[]; readonly offset: number }
  | { readonly kind: "emit"; readonly items: readonly KeyedValue<T>[] };

/**
 * Package-internal stable JS UTF-16 code-unit ordering. The iterative MSD
 * partition uses one bounded high-byte or low-byte radix at a time and an
 * explicit terminal bucket, so prefixes precede their extensions.
 */
export function stableSortByCodeUnitKeyInternal<T>(
  values: readonly T[],
  keyForValue: (value: T) => string,
  bounds: CodeUnitOrderBoundsInternal,
): T[] {
  if (!Number.isSafeInteger(bounds.maxItems) || bounds.maxItems < 0) fail("code-unit-order.invalid-bound");
  if (!Number.isSafeInteger(values.length) || values.length > bounds.maxItems) fail("code-unit-order.too-many-items");
  const keyed = new Array<KeyedValue<T>>(values.length);
  let totalKeyCodeUnits = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const key = keyForValue(value);
    if (typeof key !== "string") fail("code-unit-order.invalid-key");
    totalKeyCodeUnits += key.length;
    if (!Number.isSafeInteger(totalKeyCodeUnits)) fail("code-unit-order.accounting-overflow");
    keyed[index] = { key, value };
  }
  if (keyed.length < 2) return keyed.map(({ value }) => value);

  const frameLimit = values.length * 2 + 1;
  if (!Number.isSafeInteger(frameLimit)) fail("code-unit-order.accounting-overflow");
  const stack: Frame<T>[] = [{ kind: "high", items: keyed, offset: 0 }];
  const output = new Array<T>(values.length);
  let outputIndex = 0;
  const push = (frame: Frame<T>): void => {
    if (stack.length >= frameLimit) fail("code-unit-order.accounting-overflow");
    stack.push(frame);
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "emit") {
      for (const item of frame.items) output[outputIndex++] = item.value;
      continue;
    }
    if (frame.items.length < 2) {
      if (frame.kind === "high") output[outputIndex++] = frame.items[0]!.value;
      else push({ kind: "high", items: frame.items, offset: frame.offset + 1 });
      continue;
    }

    const buckets: Array<KeyedValue<T>[] | undefined> = new Array(RADIX);
    let terminal: KeyedValue<T>[] | undefined;
    let minimum = RADIX;
    let maximum = -1;
    for (const item of frame.items) {
      if (frame.kind === "high" && item.key.length === frame.offset) {
        (terminal ??= []).push(item);
        continue;
      }
      const codeUnit = item.key.charCodeAt(frame.offset);
      const bucketIndex = frame.kind === "high" ? codeUnit >>> 8 : codeUnit & 0xff;
      const bucket = buckets[bucketIndex] ?? (buckets[bucketIndex] = []);
      bucket.push(item);
      if (bucketIndex < minimum) minimum = bucketIndex;
      if (bucketIndex > maximum) maximum = bucketIndex;
    }

    for (let index = maximum; index >= minimum; index -= 1) {
      const bucket = buckets[index];
      if (bucket === undefined) continue;
      push(frame.kind === "high"
        ? { kind: "low", items: bucket, offset: frame.offset }
        : { kind: "high", items: bucket, offset: frame.offset + 1 });
    }
    if (terminal !== undefined) push({ kind: "emit", items: terminal });
  }
  if (outputIndex !== output.length) fail("code-unit-order.accounting-overflow");
  return output;
}

/** Fixed-width encoding for non-negative safe integers used in composite radix keys. */
export function encodeNonNegativeSafeIntegerInternal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) fail("code-unit-order.invalid-key");
  return value.toString(10).padStart(16, "0");
}

function fail(code: CodeUnitOrderErrorCodeInternal): never { throw new CodeUnitOrderErrorInternal(code); }
