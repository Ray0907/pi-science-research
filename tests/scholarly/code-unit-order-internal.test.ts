import { describe, expect, test } from "vitest";

import * as rootExports from "../../src/index.js";
import { stableSortByCodeUnitKeyInternal } from "../../src/scholarly/code-unit-order-internal.js";

function shuffled<T>(values: readonly T[]): T[] {
  const output = [...values];
  let state = 0x6d2b79f5;
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x9e3779b9) >>> 0;
    const target = state % (index + 1);
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
}

function withoutComparisonSort<T>(action: () => T): T {
  const original = Array.prototype.sort;
  Array.prototype.sort = function (this: unknown[], compareFn?: (left: unknown, right: unknown) => number): unknown[] {
    if (compareFn !== undefined) throw new Error("comparison sort invoked");
    return original.call(this);
  } as typeof Array.prototype.sort;
  try { return action(); } finally { Array.prototype.sort = original; }
}

describe("package-internal UTF-16 code-unit ordering", () => {
  test("implements prefix-first JS code-unit order for BMP and astral strings without comparison sort", () => {
    const bmp = "\uE000";
    const astral = "\u{10000}";
    const input = [bmp, `${astral}x`, "prefix-long", astral, "prefix", "", `${bmp}x`, "a"];
    expect(withoutComparisonSort(() => stableSortByCodeUnitKeyInternal(input, (value) => value))).toEqual([
      "", "a", "prefix", "prefix-long", astral, `${astral}x`, bmp, `${bmp}x`,
    ]);
  });

  test("preserves input order for equal keys", () => {
    const input = [{ key: "same", ordinal: 3 }, { key: "other", ordinal: 1 }, { key: "same", ordinal: 2 }, { key: "same", ordinal: 1 }];
    const output = stableSortByCodeUnitKeyInternal(input, ({ key }) => key);
    expect(output.map(({ key }) => key)).toEqual(["other", "same", "same", "same"]);
    expect(output.filter(({ key }) => key === "same").map(({ ordinal }) => ordinal)).toEqual([3, 2, 1]);
  });

  test("orders shuffled and reversed 10k inputs deterministically and byte-identically", () => {
    const values = Array.from({ length: 10_000 }, (_, index) => ({
      key: `${index % 7 === 0 ? "prefix" : index % 7 === 1 ? "\u{10000}" : "\uE000"}:${String(index).padStart(5, "0")}`,
      ordinal: index,
    }));
    const expected = stableSortByCodeUnitKeyInternal(values, ({ key }) => key).map(({ key }) => key).join("\n");
    const fromReverse = withoutComparisonSort(() => stableSortByCodeUnitKeyInternal([...values].reverse(), ({ key }) => key).map(({ key }) => key).join("\n"));
    const fromShuffle = withoutComparisonSort(() => stableSortByCodeUnitKeyInternal(shuffled(values), ({ key }) => key).map(({ key }) => key).join("\n"));
    expect(fromReverse).toBe(expected);
    expect(fromShuffle).toBe(expected);
  });

  test("is package-internal and absent from the root", () => {
    expect(rootExports).not.toHaveProperty("stableSortByCodeUnitKeyInternal");
  });
});
