const RADIX = 256;
const MAX_ITEMS_INTERNAL = 1_000_000;
const MAX_TOTAL_KEY_CODE_UNITS_INTERNAL = 134_217_728;

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
): T[] {
  if (!Number.isSafeInteger(values.length) || values.length > MAX_ITEMS_INTERNAL) throw new RangeError("Code-unit ordering input exceeds internal bounds");
  const keyed = new Array<KeyedValue<T>>(values.length);
  let totalKeyCodeUnits = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const key = keyForValue(value);
    if (typeof key !== "string") throw new TypeError("Code-unit ordering key must be a string");
    totalKeyCodeUnits += key.length;
    if (!Number.isSafeInteger(totalKeyCodeUnits) || totalKeyCodeUnits > MAX_TOTAL_KEY_CODE_UNITS_INTERNAL)
      throw new RangeError("Code-unit ordering keys exceed internal bounds");
    keyed[index] = { key, value };
  }
  if (keyed.length < 2) return keyed.map(({ value }) => value);

  const frameLimit = values.length * 2 + 1;
  if (!Number.isSafeInteger(frameLimit)) throw new RangeError("Code-unit ordering work exceeds internal bounds");
  const stack: Frame<T>[] = [{ kind: "high", items: keyed, offset: 0 }];
  const output = new Array<T>(values.length);
  let outputIndex = 0;
  const push = (frame: Frame<T>): void => {
    if (stack.length >= frameLimit) throw new RangeError("Code-unit ordering work exceeds internal bounds");
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
  if (outputIndex !== output.length) throw new RangeError("Code-unit ordering work was incomplete");
  return output;
}

/** Fixed-width encoding for non-negative safe integers used in composite radix keys. */
export function encodeNonNegativeSafeIntegerInternal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Code-unit ordering integer is invalid");
  return value.toString(10).padStart(16, "0");
}
