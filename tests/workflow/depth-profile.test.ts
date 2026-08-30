import { describe, expect, test, vi } from "vitest";

import {
  DepthProfileError,
  normalizeDepthBudgetInternal,
  type DepthProfileErrorCode,
} from "../../src/workflow/depth-profile.js";

function errorCode(action: () => unknown): DepthProfileErrorCode | undefined {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(DepthProfileError);
    const typed = error as DepthProfileError;
    expect(typed.message).toBe(`Depth profile rejected (${typed.code})`);
    expect(typed.message).not.toMatch(/SECRET|activeTimeLimitMs|maxSources|maxWaves/u);
    return typed.code;
  }
  return undefined;
}

describe("research depth profiles", () => {
  test("normalizes the exact quick standard and deep defaults into fresh frozen budgets", () => {
    const cases = [
      ["quick", 15 * 60_000, 12, 1, 3 * 60_000],
      ["standard", 45 * 60_000, 30, 2, 9 * 60_000],
      ["deep", 120 * 60_000, 80, 4, 10 * 60_000],
    ] as const;

    for (const [depth, activeTimeLimitMs, maxSources, maxWaves, finalizationReserveMs] of cases) {
      const first = normalizeDepthBudgetInternal(depth, { activeTimeLimitMs: null, maxSources: null });
      const second = normalizeDepthBudgetInternal(depth, { activeTimeLimitMs: null, maxSources: null });
      expect(first).toEqual({
        activeTimeLimitMs,
        activeTimeUsedMs: 0,
        finalizationReserveMs,
        maxSources,
        admittedSources: 0,
        maxWaves,
        waveOrdinal: 0,
      });
      expect(first).not.toBe(second);
      expect(Object.isFrozen(first)).toBe(true);
    }
  });

  test("enforces depth-specific active minima and the hard active and source maxima", () => {
    const minima = [["quick", 5], ["standard", 10], ["deep", 20]] as const;
    for (const [depth, minutes] of minima) {
      const minimumMs = minutes * 60_000;
      expect(normalizeDepthBudgetInternal(depth, { activeTimeLimitMs: minimumMs, maxSources: 1 }))
        .toMatchObject({ activeTimeLimitMs: minimumMs, maxSources: 1 });
      expect(errorCode(() => normalizeDepthBudgetInternal(depth, { activeTimeLimitMs: minimumMs - 1, maxSources: 1 })))
        .toBe("depth-profile.invalid-overrides");
    }
    expect(normalizeDepthBudgetInternal("deep", { activeTimeLimitMs: 24 * 60 * 60_000, maxSources: 500 }))
      .toMatchObject({ activeTimeLimitMs: 86_400_000, finalizationReserveMs: 600_000, maxSources: 500, maxWaves: 4 });
    expect(errorCode(() => normalizeDepthBudgetInternal("quick", { activeTimeLimitMs: 86_400_001, maxSources: 12 })))
      .toBe("depth-profile.invalid-overrides");
    expect(errorCode(() => normalizeDepthBudgetInternal("quick", { activeTimeLimitMs: 900_000, maxSources: 501 })))
      .toBe("depth-profile.invalid-overrides");
  });

  test("rejects unknown depths and non-positive fractional non-finite or unsafe overrides", () => {
    expect(errorCode(() => normalizeDepthBudgetInternal("SECRET" as never, { activeTimeLimitMs: null, maxSources: null })))
      .toBe("depth-profile.invalid-depth");
    expect(errorCode(() => normalizeDepthBudgetInternal("quick", { activeTimeLimitMs: 300_000.5, maxSources: null })))
      .toBe("depth-profile.invalid-overrides");
    const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalid) {
      expect(errorCode(() => normalizeDepthBudgetInternal("quick", { activeTimeLimitMs: value, maxSources: null })))
        .toBe("depth-profile.invalid-overrides");
      expect(errorCode(() => normalizeDepthBudgetInternal("quick", { activeTimeLimitMs: null, maxSources: value })))
        .toBe("depth-profile.invalid-overrides");
    }
  });

  test("accepts only the two closed nullable initial overrides and never accepts a wave override", () => {
    const normalize = normalizeDepthBudgetInternal as (depth: "quick", overrides: unknown) => unknown;
    for (const overrides of [
      undefined,
      null,
      {},
      { activeTimeLimitMs: null },
      { maxSources: null },
      { activeTimeLimitMs: undefined, maxSources: null },
      { activeTimeLimitMs: null, maxSources: undefined },
      { activeTimeLimitMs: null, maxSources: null, maxWaves: 16 },
      [null, null],
    ]) expect(errorCode(() => normalize("quick", overrides))).toBe("depth-profile.invalid-overrides");

    const manyExtraKeys: Record<string, number | null> = { activeTimeLimitMs: null, maxSources: null };
    for (let index = 0; index < 4_096; index += 1) manyExtraKeys[`extra-${index}`] = index;
    const descriptorSnapshot = vi.spyOn(Object, "getOwnPropertyDescriptors");
    let manyKeysError: unknown;
    try { normalize("quick", manyExtraKeys); } catch (error) { manyKeysError = error; }
    const descriptorSnapshotCalls = descriptorSnapshot.mock.calls.length;
    descriptorSnapshot.mockRestore();
    expect(manyKeysError).toBeInstanceOf(DepthProfileError);
    expect((manyKeysError as DepthProfileError).code).toBe("depth-profile.invalid-overrides");
    expect(descriptorSnapshotCalls).toBe(0);

    let proxyTrapCalls = 0;
    const liveProxy = new Proxy({ activeTimeLimitMs: null, maxSources: null }, {
      getPrototypeOf() { proxyTrapCalls += 1; throw new Error("SECRET getPrototypeOf trap"); },
      ownKeys() { proxyTrapCalls += 1; throw new Error("SECRET ownKeys trap"); },
      getOwnPropertyDescriptor() { proxyTrapCalls += 1; throw new Error("SECRET descriptor trap"); },
    });
    expect(errorCode(() => normalize("quick", liveProxy))).toBe("depth-profile.invalid-overrides");
    expect(proxyTrapCalls).toBe(0);

    const revoked = Proxy.revocable({ activeTimeLimitMs: null, maxSources: null }, {});
    revoked.revoke();
    expect(errorCode(() => normalize("quick", revoked.proxy))).toBe("depth-profile.invalid-overrides");
  });

  test("uses the exact reserve formula at its floor proportional and cap boundaries", () => {
    for (const activeTimeLimitMs of [300_000, 300_001, 3_000_000, 3_000_001]) {
      const budget = normalizeDepthBudgetInternal("quick", { activeTimeLimitMs, maxSources: null });
      expect(budget.finalizationReserveMs).toBe(Math.min(
        600_000,
        Math.max(60_000, 0.2 * activeTimeLimitMs),
        0.5 * activeTimeLimitMs,
      ));
      expect(Number.isFinite(budget.finalizationReserveMs)).toBe(true);
      expect(Number.isSafeInteger(budget.activeTimeLimitMs)).toBe(true);
    }
  });
});
