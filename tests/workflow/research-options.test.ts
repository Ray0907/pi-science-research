import { describe, expect, test } from "vitest";

import {
  ResearchOptionsError,
  isResearchInvocationInternal,
  parseResearchInvocationInternal,
  type ResearchInvocationMode,
  type ResearchOptionsErrorCode,
} from "../../src/workflow/research-options.js";

function closedError(action: () => unknown): ResearchOptionsError {
  let thrown: unknown;
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ResearchOptionsError);
  const typed = thrown as ResearchOptionsError;
  expect(typed.message).toBe(`Research invocation rejected (${typed.code})`);
  expect(typed.message).not.toMatch(/SECRET|provider\/model|private/u);
  return typed;
}

function errorCode(rawArgs: string, mode: ResearchInvocationMode = "tui"): ResearchOptionsErrorCode | undefined {
  try { parseResearchInvocationInternal(rawArgs, { mode }); }
  catch (error) { return closedError(() => { throw error; }).code; }
  return undefined;
}

describe("closed research invocation grammar", () => {
  test("returns the exact deeply frozen standard defaults in every invocation mode", () => {
    for (const mode of ["tui", "rpc", "json", "print"] as const) {
      const invocation = parseResearchInvocationInternal("  What is known?  ", { mode });
      expect(invocation).toEqual({
        question: "What is known?",
        depth: "standard",
        requestedOutput: null,
        reproducible: false,
        language: "en",
        modelOverrides: { coordinator: null, researcher: null, verifier: null },
        activeTimeLimitMs: 45 * 60_000,
        finalizationReserveMs: 9 * 60_000,
        maxSources: 30,
        maxWaves: 2,
        allowCalculations: false,
        calculationPolicyPath: null,
      });
      expect(Object.isFrozen(invocation)).toBe(true);
      expect(Object.isFrozen(invocation.modelOverrides)).toBe(true);
      expect(isResearchInvocationInternal(invocation)).toBe(true);
      expect(isResearchInvocationInternal({ ...invocation })).toBe(false);
      expect(isResearchInvocationInternal(structuredClone(invocation))).toBe(false);
    }
  });

  test("parses the one closed option spelling inventory before the question", () => {
    const invocation = parseResearchInvocationInternal(
      "--depth deep --output report.md --reproducible --language fr-CA "
      + "--model-role coordinator=vendor/lead --model-role researcher=vendor/search "
      + "--model-role verifier=vendor/check --max-time 3h --max-sources 75 "
      + "--allow-calculations --calculation-policy policy.json Explain the result --depth quick",
      { mode: "rpc" },
    );

    expect(invocation).toEqual({
      question: "Explain the result --depth quick",
      depth: "deep",
      requestedOutput: "report.md",
      reproducible: true,
      language: "fr-CA",
      modelOverrides: {
        coordinator: "vendor/lead",
        researcher: "vendor/search",
        verifier: "vendor/check",
      },
      activeTimeLimitMs: 3 * 60 * 60_000,
      finalizationReserveMs: 10 * 60_000,
      maxSources: 75,
      maxWaves: 4,
      allowCalculations: true,
      calculationPolicyPath: "policy.json",
    });
  });

  test("transports deterministic quoted option values without interpreting question text", () => {
    const invocation = parseResearchInvocationInternal(
      String.raw`--output 'private report.md' --language "en-US" --model-role "coordinator=provider/model\"quoted" --calculation-policy "pol\\icy.json" "question remains \q and 'unterminated"`,
      { mode: "json" },
    );
    expect(invocation.requestedOutput).toBe("private report.md");
    expect(invocation.language).toBe("en-US");
    expect(invocation.modelOverrides.coordinator).toBe('provider/model"quoted');
    expect(invocation.calculationPolicyPath).toBe(String.raw`pol\icy.json`);
    expect(invocation.question).toBe(String.raw`"question remains \q and 'unterminated"`);
  });

  test("uses exact double-quote escapes and treats backslashes literally elsewhere", () => {
    expect(parseResearchInvocationInternal(String.raw`--output 'a\b"c' question`, { mode: "tui" }).requestedOutput)
      .toBe(String.raw`a\b"c`);
    expect(parseResearchInvocationInternal(String.raw`--output a\b question`, { mode: "tui" }).requestedOutput)
      .toBe(String.raw`a\b`);
    expect(errorCode(String.raw`--output "bad\q" question`)).toBe("research-options.malformed-quote");
    expect(errorCode(String.raw`--output "unterminated question`)).toBe("research-options.malformed-quote");
    expect(errorCode(String.raw`--output 'unterminated question`)).toBe("research-options.malformed-quote");
  });

  test("ends options only on exact double dash and preserves the trimmed question remainder", () => {
    expect(parseResearchInvocationInternal("-- --depth deep literal question  ", { mode: "print" }).question)
      .toBe("--depth deep literal question");
    expect(parseResearchInvocationInternal("--depth quick   first  --output later.md  ", { mode: "tui" }))
      .toMatchObject({ depth: "quick", requestedOutput: null, question: "first  --output later.md" });
    expect(errorCode("--- question")).toBe("research-options.unknown-option");
    expect(errorCode("--depth=quick question")).toBe("research-options.unknown-option");
  });

  test("rejects unknown duplicate and incomplete options and duplicate model roles", () => {
    expect(errorCode("--secret value question")).toBe("research-options.unknown-option");
    expect(errorCode("--depth quick --depth deep question")).toBe("research-options.duplicate-option");
    expect(errorCode("--reproducible --reproducible question")).toBe("research-options.duplicate-option");
    expect(errorCode("--model-role coordinator=a/b --model-role coordinator=c/d question"))
      .toBe("research-options.duplicate-model-role");
    expect(errorCode("--depth")).toBe("research-options.missing-option-value");
    for (const rawArgs of [
      "--output --reproducible question",
      "--output --secret question",
      "--output --output report.md question",
      "--output -- question",
      "--calculation-policy --allow-calculations question",
      "--depth --output x question",
    ]) expect(errorCode(rawArgs)).toBe("research-options.missing-option-value");
    expect(parseResearchInvocationInternal('--output "--reproducible" question', { mode: "tui" }))
      .toMatchObject({ requestedOutput: "--reproducible", reproducible: false });
    expect(errorCode("--model-role writer=a/b question")).toBe("research-options.invalid-option-value");
    expect(errorCode("--model-role coordinator question")).toBe("research-options.invalid-option-value");
  });

  test("rejects budget overrides outside depth minima and hard maxima", () => {
    for (const rawArgs of [
      "--depth quick --max-time 0ms question",
      "--depth quick --max-time 1s question",
      "--max-time 25h question",
      "--max-sources 0 question",
      "--max-sources -1 question",
      "--max-sources 501 question",
    ]) expect(errorCode(rawArgs)).toBe("research-options.invalid-option-value");
  });

  test("rejects empty malformed control-bearing ill-formed Unicode and over-limit invocations with closed codes", () => {
    expect(errorCode("   ")).toBe("research-options.empty-question");
    expect(errorCode("--depth quick")).toBe("research-options.empty-question");
    expect(errorCode("question\0SECRET")).toBe("research-options.invalid-control");
    expect(errorCode("question\u0085SECRET")).toBe("research-options.invalid-control");
    expect(errorCode("lone-high-\ud800SECRET")).toBe("research-options.invalid-unicode");
    expect(errorCode("lone-low-\udc00SECRET")).toBe("research-options.invalid-unicode");
    expect(parseResearchInvocationInternal("paired-😀", { mode: "tui" }).question).toBe("paired-😀");
    expect(errorCode("😀".repeat(16_385))).toBe("research-options.command-too-large");
    expect(errorCode(`${"a".repeat(65_536)}\ud800`)).toBe("research-options.command-too-large");
    expect(errorCode(`--output ${"a".repeat(49_100)} ${"q".repeat(16_385)}`))
      .toBe("research-options.question-too-large");
  });

  test("rejects a command token and invalid runtime context without exposing input", () => {
    expect(errorCode("/research question")).toBe("research-options.command-token");
    const parse = parseResearchInvocationInternal as (raw: unknown, context: unknown) => unknown;
    for (const [raw, context, code] of [
      [null, { mode: "tui" }, "research-options.invalid-input"],
      ["question", { mode: "batch" }, "research-options.invalid-mode"],
      ["question", null, "research-options.invalid-mode"],
    ] as const) expect(closedError(() => parse(raw, context)).code).toBe(code);
  });

  test("rejects live and revoked proxy contexts trap-free and never invokes a mode getter", () => {
    const parse = parseResearchInvocationInternal as (raw: unknown, context: unknown) => unknown;
    let proxyTrapCalls = 0;
    const attackerError = new ResearchOptionsError("research-options.invalid-mode");
    attackerError.message = "SECRET attacker-controlled message";
    const liveProxy = new Proxy({ mode: "tui" }, {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw attackerError;
      },
    });
    expect(closedError(() => parse("question", liveProxy)).code).toBe("research-options.invalid-mode");
    expect(proxyTrapCalls).toBe(0);

    const revoked = Proxy.revocable({ mode: "tui" }, {});
    revoked.revoke();
    expect(closedError(() => parse("question", revoked.proxy)).code).toBe("research-options.invalid-mode");

    let getterCalls = 0;
    const accessorContext = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorContext, "mode", {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("SECRET getter"); },
    });
    expect(closedError(() => parse("question", accessorContext)).code).toBe("research-options.invalid-mode");
    expect(getterCalls).toBe(0);
  });
});
