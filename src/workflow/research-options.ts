import { types as utilTypes } from "node:util";

import { normalizeDepthBudgetInternal, type ResearchDepth } from "./depth-profile.js";

export type ResearchInvocationMode = "tui" | "rpc" | "json" | "print";
export type ResearchModelRole = "coordinator" | "researcher" | "verifier";

export type ResearchOptionsErrorCode =
  | "research-options.invalid-input"
  | "research-options.invalid-mode"
  | "research-options.command-too-large"
  | "research-options.question-too-large"
  | "research-options.invalid-control"
  | "research-options.invalid-unicode"
  | "research-options.malformed-quote"
  | "research-options.empty-question"
  | "research-options.command-token"
  | "research-options.unknown-option"
  | "research-options.duplicate-option"
  | "research-options.missing-option-value"
  | "research-options.invalid-option-value"
  | "research-options.duplicate-model-role";

export class ResearchOptionsError extends Error {
  readonly code: ResearchOptionsErrorCode;

  constructor(code: ResearchOptionsErrorCode) {
    super(`Research invocation rejected (${code})`);
    this.name = "ResearchOptionsError";
    this.code = code;
  }
}

export interface ResearchModelOverridesInternal {
  readonly coordinator: string | null;
  readonly researcher: string | null;
  readonly verifier: string | null;
}

export interface NormalizedResearchInvocationInternal {
  readonly question: string;
  readonly depth: ResearchDepth;
  readonly requestedOutput: string | null;
  readonly reproducible: boolean;
  readonly language: string;
  readonly modelOverrides: ResearchModelOverridesInternal;
  readonly activeTimeLimitMs: number;
  readonly finalizationReserveMs: number;
  readonly maxSources: number;
  readonly maxWaves: number;
  readonly allowCalculations: boolean;
  readonly calculationPolicyPath: string | null;
}

interface Token {
  readonly value: string;
  readonly end: number;
}

const MAXIMUM_COMMAND_BYTES = 64 * 1024;
const MAXIMUM_QUESTION_BYTES = 16 * 1024;
const MAXIMUM_MODEL_IDENTIFIER_BYTES = 512;
const MAXIMUM_OUTPUT_PATH_BYTES = 4_096;
const MAXIMUM_POLICY_PATH_BYTES = 4_096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const VALUE_OPTIONS = new Set([
  "--depth",
  "--output",
  "--language",
  "--model-role",
  "--max-time",
  "--max-sources",
  "--calculation-policy",
]);
const FLAG_OPTIONS = new Set(["--reproducible", "--allow-calculations"]);
const authenticatedInvocations = new WeakSet<object>();

function fail(code: ResearchOptionsErrorCode): never {
  throw new ResearchOptionsError(code);
}

function skipWhitespace(input: string, start: number): number {
  let position = start;
  while (position < input.length && /\s/u.test(input[position]!)) position += 1;
  return position;
}

function readOptionName(input: string, start: number): Token {
  let end = start;
  while (end < input.length && !/\s/u.test(input[end]!)) end += 1;
  return { value: input.slice(start, end), end };
}

function readOptionValue(input: string, start: number): Token {
  const quote = input[start];
  if (quote !== "'" && quote !== '"') {
    let end = start;
    while (end < input.length && !/\s/u.test(input[end]!)) {
      if (input[end] === "'" || input[end] === '"') fail("research-options.malformed-quote");
      end += 1;
    }
    return { value: input.slice(start, end), end };
  }

  let value = "";
  let position = start + 1;
  while (position < input.length) {
    const character = input[position]!;
    if (character === quote) {
      const end = position + 1;
      if (end < input.length && !/\s/u.test(input[end]!)) fail("research-options.malformed-quote");
      return { value, end };
    }
    if (quote === '"' && character === "\\") {
      const escaped = input[position + 1];
      if (escaped !== '"' && escaped !== "\\") fail("research-options.malformed-quote");
      value += escaped;
      position += 2;
      continue;
    }
    value += character;
    position += 1;
  }
  return fail("research-options.malformed-quote");
}

function invocationMode(context: unknown): Exclude<ResearchInvocationMode, "print"> {
  if (context === null || typeof context !== "object" || utilTypes.isProxy(context)) {
    fail("research-options.invalid-mode");
  }
  let prototype: object | null;
  let keys: PropertyKey[];
  let descriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(context);
    keys = Reflect.ownKeys(context);
    descriptor = Object.getOwnPropertyDescriptor(context, "mode");
  } catch {
    return fail("research-options.invalid-mode");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("research-options.invalid-mode");
  if (keys.length !== 1 || keys[0] !== "mode") fail("research-options.invalid-mode");
  if (!descriptor?.enumerable || !("value" in descriptor)) fail("research-options.invalid-mode");
  const mode = descriptor.value as unknown;
  if (mode !== "tui" && mode !== "rpc" && mode !== "json") fail("research-options.invalid-mode");
  return mode;
}

function durationMilliseconds(value: string): number {
  const match = /^([0-9]+)([mh])$/u.exec(value);
  if (!match) fail("research-options.invalid-option-value");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) fail("research-options.invalid-option-value");
  const multiplier = match[2] === "h" ? 3_600_000 : 60_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) fail("research-options.invalid-option-value");
  return milliseconds;
}

function sourceCount(value: string): number {
  if (!/^[0-9]+$/u.test(value)) fail("research-options.invalid-option-value");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 500) fail("research-options.invalid-option-value");
  return count;
}

function canonicalLanguage(value: string): string {
  let canonical: string[];
  try { canonical = Intl.getCanonicalLocales(value); }
  catch { return fail("research-options.invalid-option-value"); }
  if (canonical.length !== 1) fail("research-options.invalid-option-value");
  return canonical[0]!;
}

function withinUtf8Limit(value: string, maximumBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function modelAssignment(value: string): readonly [ResearchModelRole, string] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf("=", separator + 1) !== -1) {
    fail("research-options.invalid-option-value");
  }
  const role = value.slice(0, separator);
  if (role !== "coordinator" && role !== "researcher" && role !== "verifier") {
    fail("research-options.invalid-option-value");
  }
  const model = value.slice(separator + 1);
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || model.indexOf("/", slash + 1) !== -1
    || !withinUtf8Limit(model, MAXIMUM_MODEL_IDENTIFIER_BYTES)) {
    fail("research-options.invalid-option-value");
  }
  return [role, model];
}

/** Parses arguments following /research without performing shell expansion. */
export function parseResearchInvocationInternal(
  rawArgs: string,
  context: { readonly mode: ResearchInvocationMode },
): NormalizedResearchInvocationInternal {
  if (typeof rawArgs !== "string") fail("research-options.invalid-input");
  const mode = invocationMode(context);
  if (rawArgs.length > MAXIMUM_COMMAND_BYTES) fail("research-options.command-too-large");
  if (hasUnpairedSurrogate(rawArgs)) fail("research-options.invalid-unicode");
  if (Buffer.byteLength(rawArgs, "utf8") > MAXIMUM_COMMAND_BYTES) fail("research-options.command-too-large");
  if (CONTROL_CHARACTER.test(rawArgs)) fail("research-options.invalid-control");

  let depth: ResearchDepth = "standard";
  let requestedOutput: string | null = null;
  let reproducible = false;
  let language = "en";
  const mutableModels: Record<ResearchModelRole, string | null> = { coordinator: null, researcher: null, verifier: null };
  let activeTimeLimitMs: number | null = null;
  let maxSourcesOverride: number | null = null;
  let allowCalculations = false;
  let calculationPolicyPath: string | null = null;
  const seen = new Set<string>();
  let position = skipWhitespace(rawArgs, 0);
  let questionStart = rawArgs.length;

  while (position < rawArgs.length) {
    if (!rawArgs.startsWith("--", position)) {
      questionStart = position;
      break;
    }
    const option = readOptionName(rawArgs, position);
    position = option.end;
    if (option.value === "--") {
      questionStart = skipWhitespace(rawArgs, position);
      break;
    }
    if (!VALUE_OPTIONS.has(option.value) && !FLAG_OPTIONS.has(option.value)) fail("research-options.unknown-option");

    if (FLAG_OPTIONS.has(option.value)) {
      if (seen.has(option.value)) fail("research-options.duplicate-option");
      seen.add(option.value);
      if (option.value === "--reproducible") reproducible = true;
      else allowCalculations = true;
      position = skipWhitespace(rawArgs, position);
      continue;
    }

    if (option.value !== "--model-role") {
      if (seen.has(option.value)) fail("research-options.duplicate-option");
      seen.add(option.value);
    }
    position = skipWhitespace(rawArgs, position);
    if (position >= rawArgs.length || rawArgs.startsWith("--", position)) {
      fail("research-options.missing-option-value");
    }
    const token = readOptionValue(rawArgs, position);
    if (token.value.length === 0) fail("research-options.invalid-option-value");
    position = skipWhitespace(rawArgs, token.end);

    switch (option.value) {
      case "--depth":
        if (token.value !== "quick" && token.value !== "standard" && token.value !== "deep") fail("research-options.invalid-option-value");
        depth = token.value;
        break;
      case "--output":
        if (!withinUtf8Limit(token.value, MAXIMUM_OUTPUT_PATH_BYTES)) fail("research-options.invalid-option-value");
        requestedOutput = token.value;
        break;
      case "--language": language = canonicalLanguage(token.value); break;
      case "--model-role": {
        const [role, model] = modelAssignment(token.value);
        if (mutableModels[role] !== null) fail("research-options.duplicate-model-role");
        mutableModels[role] = model;
        break;
      }
      case "--max-time": activeTimeLimitMs = durationMilliseconds(token.value); break;
      case "--max-sources": maxSourcesOverride = sourceCount(token.value); break;
      case "--calculation-policy":
        if (!withinUtf8Limit(token.value, MAXIMUM_POLICY_PATH_BYTES)) fail("research-options.invalid-option-value");
        calculationPolicyPath = token.value;
        break;
    }
  }

  const question = rawArgs.slice(questionStart).trim();
  if (question.length === 0) fail("research-options.empty-question");
  if (/^\/research(?:$|\s)/u.test(question)) fail("research-options.command-token");
  if (Buffer.byteLength(question, "utf8") > MAXIMUM_QUESTION_BYTES) fail("research-options.question-too-large");

  if (calculationPolicyPath !== null && (!allowCalculations || mode === "tui")) {
    fail("research-options.invalid-option-value");
  }
  if (allowCalculations && mode !== "tui" && calculationPolicyPath === null) {
    fail("research-options.invalid-option-value");
  }

  let budget: ReturnType<typeof normalizeDepthBudgetInternal>;
  try {
    budget = normalizeDepthBudgetInternal(depth, { activeTimeLimitMs, maxSources: maxSourcesOverride });
  } catch {
    return fail("research-options.invalid-option-value");
  }
  const modelOverrides = Object.freeze({ ...mutableModels });
  const invocation: NormalizedResearchInvocationInternal = Object.freeze({
    question,
    depth,
    requestedOutput,
    reproducible,
    language,
    modelOverrides,
    activeTimeLimitMs: budget.activeTimeLimitMs,
    finalizationReserveMs: budget.finalizationReserveMs,
    maxSources: budget.maxSources,
    maxWaves: budget.maxWaves,
    allowCalculations,
    calculationPolicyPath,
  });
  authenticatedInvocations.add(invocation);
  return invocation;
}

/** Recognizes only values produced by this module instance. */
export function isResearchInvocationInternal(value: unknown): value is NormalizedResearchInvocationInternal {
  return typeof value === "object" && value !== null && authenticatedInvocations.has(value);
}
