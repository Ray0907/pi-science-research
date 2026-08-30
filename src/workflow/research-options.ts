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

function invocationMode(context: unknown): ResearchInvocationMode {
  if (context === null || typeof context !== "object" || utilTypes.isProxy(context)) {
    fail("research-options.invalid-mode");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(context, "mode");
  } catch {
    return fail("research-options.invalid-mode");
  }
  if (!descriptor || !("value" in descriptor)) fail("research-options.invalid-mode");
  const mode = descriptor.value as unknown;
  if (mode !== "tui" && mode !== "rpc" && mode !== "json" && mode !== "print") fail("research-options.invalid-mode");
  return mode;
}

function durationMilliseconds(value: string): number {
  const unit = value.endsWith("ms") ? "ms" : value.endsWith("s") ? "s" : value.endsWith("m") ? "m" : value.endsWith("h") ? "h" : null;
  if (unit === null) fail("research-options.invalid-option-value");
  const numeric = value.slice(0, -unit.length);
  if (numeric.length === 0) fail("research-options.invalid-option-value");
  const amount = Number(numeric);
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) fail("research-options.invalid-option-value");
  return milliseconds;
}

function sourceCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count)) fail("research-options.invalid-option-value");
  return count;
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
  return [role, value.slice(separator + 1)];
}

/** Parses arguments following /research without performing shell expansion. */
export function parseResearchInvocationInternal(
  rawArgs: string,
  context: { readonly mode: ResearchInvocationMode },
): NormalizedResearchInvocationInternal {
  invocationMode(context);
  if (typeof rawArgs !== "string") fail("research-options.invalid-input");
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
      case "--output": requestedOutput = token.value; break;
      case "--language": language = token.value; break;
      case "--model-role": {
        const [role, model] = modelAssignment(token.value);
        if (mutableModels[role] !== null) fail("research-options.duplicate-model-role");
        mutableModels[role] = model;
        break;
      }
      case "--max-time": activeTimeLimitMs = durationMilliseconds(token.value); break;
      case "--max-sources": maxSourcesOverride = sourceCount(token.value); break;
      case "--calculation-policy": calculationPolicyPath = token.value; break;
    }
  }

  const question = rawArgs.slice(questionStart).trim();
  if (question.length === 0) fail("research-options.empty-question");
  if (/^\/research(?:$|\s)/u.test(question)) fail("research-options.command-token");
  if (Buffer.byteLength(question, "utf8") > MAXIMUM_QUESTION_BYTES) fail("research-options.question-too-large");

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
