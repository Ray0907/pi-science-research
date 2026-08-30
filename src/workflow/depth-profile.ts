import { types as utilTypes } from "node:util";

export type ResearchDepth = "quick" | "standard" | "deep";

export type DepthProfileErrorCode =
  | "depth-profile.invalid-depth"
  | "depth-profile.invalid-overrides"
  | "depth-profile.arithmetic-overflow";

export class DepthProfileError extends Error {
  readonly code: DepthProfileErrorCode;

  constructor(code: DepthProfileErrorCode) {
    super(`Depth profile rejected (${code})`);
    this.name = "DepthProfileError";
    this.code = code;
  }
}

export interface InitialDepthBudgetOverridesInternal {
  readonly activeTimeLimitMs: number | null;
  readonly maxSources: number | null;
}

export interface NormalizedDepthBudgetInternal {
  readonly activeTimeLimitMs: number;
  readonly activeTimeUsedMs: 0;
  readonly finalizationReserveMs: number;
  readonly maxSources: number;
  readonly admittedSources: 0;
  readonly maxWaves: number;
  readonly waveOrdinal: 0;
}

interface DepthProfileDefinition {
  readonly defaultActiveMinutes: number;
  readonly minimumActiveMinutes: number;
  readonly defaultMaxSources: number;
  readonly defaultMaxWaves: number;
}

const HARD_MAXIMUM_ACTIVE_TIME_MS = 24 * 60 * 60_000;
const HARD_MAXIMUM_SOURCES = 500;
const HARD_MAXIMUM_FUTURE_WAVES = 16;
const OVERRIDE_KEYS = ["activeTimeLimitMs", "maxSources"] as const;
const DEPTH_PROFILES: Readonly<Record<ResearchDepth, DepthProfileDefinition>> = Object.freeze({
  quick: Object.freeze({ defaultActiveMinutes: 15, minimumActiveMinutes: 5, defaultMaxSources: 12, defaultMaxWaves: 1 }),
  standard: Object.freeze({ defaultActiveMinutes: 45, minimumActiveMinutes: 10, defaultMaxSources: 30, defaultMaxWaves: 2 }),
  deep: Object.freeze({ defaultActiveMinutes: 120, minimumActiveMinutes: 20, defaultMaxSources: 80, defaultMaxWaves: 4 }),
});

function fail(code: DepthProfileErrorCode): never {
  throw new DepthProfileError(code);
}

function checkedMultiply(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) fail("depth-profile.arithmetic-overflow");
  const product = left * right;
  if (!Number.isSafeInteger(product)) fail("depth-profile.arithmetic-overflow");
  return product;
}

function milliseconds(minutes: number): number {
  return checkedMultiply(minutes, 60_000);
}

function depthProfile(depth: unknown): DepthProfileDefinition {
  if (depth !== "quick" && depth !== "standard" && depth !== "deep") fail("depth-profile.invalid-depth");
  return DEPTH_PROFILES[depth];
}

function overrideDescriptors(value: unknown): PropertyDescriptorMap {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) fail("depth-profile.invalid-overrides");
  let prototype: object | null;
  try {
    if (Array.isArray(value)) fail("depth-profile.invalid-overrides");
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail("depth-profile.invalid-overrides");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("depth-profile.invalid-overrides");

  let keys: PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch { return fail("depth-profile.invalid-overrides"); }
  if (keys.length !== OVERRIDE_KEYS.length || keys.some((key) => typeof key !== "string" || !OVERRIDE_KEYS.includes(key as typeof OVERRIDE_KEYS[number]))) {
    fail("depth-profile.invalid-overrides");
  }

  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return fail("depth-profile.invalid-overrides"); }
  for (const key of OVERRIDE_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("depth-profile.invalid-overrides");
  }
  return descriptors;
}

function positiveSafeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/** Normalizes the only two overrides allowed when an initial research budget is created. */
export function normalizeDepthBudgetInternal(
  depth: ResearchDepth,
  overrides: InitialDepthBudgetOverridesInternal,
): NormalizedDepthBudgetInternal {
  const profile = depthProfile(depth);
  const descriptors = overrideDescriptors(overrides);
  const activeOverride = descriptors.activeTimeLimitMs!.value as unknown;
  const sourcesOverride = descriptors.maxSources!.value as unknown;
  const minimumActiveTimeMs = milliseconds(profile.minimumActiveMinutes);
  const defaultActiveTimeLimitMs = milliseconds(profile.defaultActiveMinutes);
  const activeTimeLimitMs = activeOverride === null ? defaultActiveTimeLimitMs : activeOverride;
  const maxSources = sourcesOverride === null ? profile.defaultMaxSources : sourcesOverride;

  if (!positiveSafeInteger(activeTimeLimitMs, HARD_MAXIMUM_ACTIVE_TIME_MS) || activeTimeLimitMs < minimumActiveTimeMs) {
    fail("depth-profile.invalid-overrides");
  }
  if (!positiveSafeInteger(maxSources, HARD_MAXIMUM_SOURCES)) fail("depth-profile.invalid-overrides");
  if (!positiveSafeInteger(profile.defaultMaxWaves, HARD_MAXIMUM_FUTURE_WAVES)) fail("depth-profile.arithmetic-overflow");

  const finalizationReserveMs = Math.min(
    600_000,
    Math.max(60_000, 0.2 * activeTimeLimitMs),
    0.5 * activeTimeLimitMs,
  );
  if (!Number.isFinite(finalizationReserveMs) || !Number.isSafeInteger(Math.ceil(finalizationReserveMs))) {
    fail("depth-profile.arithmetic-overflow");
  }

  return Object.freeze({
    activeTimeLimitMs,
    activeTimeUsedMs: 0,
    finalizationReserveMs,
    maxSources,
    admittedSources: 0,
    maxWaves: profile.defaultMaxWaves,
    waveOrdinal: 0,
  });
}
