import { describe, expect, it } from "vitest";

import {
  assertValidatedCoordinatorPlanningResultInternal,
  ResearchPlanningContractError,
  validateCoordinatorPlanningResultInternal,
  type ResearchPlanningValidationContextInternal,
} from "../../src/workflow/planning-contract-internal.js";

const RUN_ID = `run-${"a".repeat(16)}`;
const ATTEMPT_ID = `attempt-${"b".repeat(16)}`;

// Declared as the closed context type so direct (happy-path) call sites typecheck without a
// cast; overrides still let negative tests build a runtime-malformed context (the cast below
// does not add any real compile-time shape checking to *this* helper's overrides — that's
// intentional, since validateCoordinatorPlanningResultInternal validates the shape at runtime
// regardless of what static type a caller claims).
function baseContext(overrides: Partial<Record<string, unknown>> = {}): ResearchPlanningValidationContextInternal {
  return { runId: RUN_ID, attemptId: ATTEMPT_ID, maxSources: 30, ...overrides } as ResearchPlanningValidationContextInternal;
}

function baseEvidenceRule(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    minimumLineages: 1,
    independentVerificationAllowed: true,
    primarySourceRequired: true,
    fullTextRequired: false,
    ...overrides,
  };
}

function baseTask(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    proposalId: "search-literature",
    description: "search literature for the question",
    role: "literature-searcher",
    evidenceRule: baseEvidenceRule(),
    dependsOnProposalIds: [],
    ...overrides,
  };
}

function baseResult(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    resultType: "planning",
    tasks: [baseTask()],
    rationale: "scope the question before dispatch",
    ...overrides,
  };
}

function expectContractFailure(value: unknown, context: unknown, code: string): void {
  try {
    validateCoordinatorPlanningResultInternal(value, context as ResearchPlanningValidationContextInternal);
    expect.unreachable("expected ResearchPlanningContractError");
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningContractError);
    expect((error as ResearchPlanningContractError).code).toBe(code);
    expect((error as Error).message).toBe(`Research planning contract failed (${code})`);
  }
}

describe("validateCoordinatorPlanningResultInternal — happy path", () => {
  it("accepts a minimal valid plan and returns a frozen result", () => {
    const result = validateCoordinatorPlanningResultInternal(baseResult(), baseContext());
    expect(result.tasks).toHaveLength(1);
    expect(result.runId).toBe(RUN_ID);
    expect(result.attemptId).toBe(ATTEMPT_ID);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tasks)).toBe(true);
    expect(Object.isFrozen(result.tasks[0])).toBe(true);
    expect(Object.isFrozen(result.tasks[0]!.evidenceRule)).toBe(true);
    expect(Object.isFrozen(result.tasks[0]!.dependsOnProposalIds)).toBe(true);
  });

  it("accepts null-prototype records at every layer, not just Object.prototype-rooted ones", () => {
    const nullProtoEvidenceRule = Object.assign(Object.create(null), baseEvidenceRule());
    const nullProtoTask = Object.assign(Object.create(null), baseTask({ evidenceRule: nullProtoEvidenceRule }));
    const nullProtoResult = Object.assign(Object.create(null), baseResult({ tasks: [nullProtoTask] }));
    const nullProtoContext = Object.assign(Object.create(null), baseContext()) as ResearchPlanningValidationContextInternal;
    const result = validateCoordinatorPlanningResultInternal(nullProtoResult, nullProtoContext);
    expect(result.tasks).toHaveLength(1);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("accepts dependency references between tasks and preserves submitted order", () => {
    const value = baseResult({
      tasks: [
        baseTask({ proposalId: "a", dependsOnProposalIds: [] }),
        baseTask({ proposalId: "b", dependsOnProposalIds: ["a"] }),
        baseTask({ proposalId: "c", dependsOnProposalIds: ["a", "b"] }),
      ],
    });
    const result = validateCoordinatorPlanningResultInternal(value, baseContext());
    expect(result.tasks.map((t) => t.proposalId)).toEqual(["a", "b", "c"]);
    expect(result.tasks[2]!.dependsOnProposalIds).toEqual(["a", "b"]);
  });

  it("accepts the maximum task count and per-task/aggregate dependency counts", () => {
    const tasks = Array.from({ length: 64 }, (_, i) => baseTask({ proposalId: `t${i}`, dependsOnProposalIds: [] }));
    const result = validateCoordinatorPlanningResultInternal(baseResult({ tasks }), baseContext());
    expect(result.tasks).toHaveLength(64);
  });
});

describe("validateCoordinatorPlanningResultInternal — context validation", () => {
  it("rejects a non-object context", () => {
    expectContractFailure(baseResult(), "not-an-object", "planning-contract.invalid-context");
    expectContractFailure(baseResult(), null, "planning-contract.invalid-context");
    expectContractFailure(baseResult(), [], "planning-contract.invalid-context");
  });

  it("rejects a context missing a required key", () => {
    const { maxSources: _drop, ...rest } = baseContext();
    expectContractFailure(baseResult(), rest, "planning-contract.invalid-context");
  });

  it("rejects a context with an extra key", () => {
    expectContractFailure(baseResult(), baseContext({ extra: true }), "planning-contract.invalid-context");
  });

  it("rejects malformed runId/attemptId syntax in context", () => {
    expectContractFailure(baseResult(), baseContext({ runId: "run-short" }), "planning-contract.invalid-context");
    expectContractFailure(baseResult(), baseContext({ attemptId: "not-an-attempt-id" }), "planning-contract.invalid-context");
  });

  it("rejects maxSources outside 1..500 or non-integer", () => {
    expectContractFailure(baseResult(), baseContext({ maxSources: 0 }), "planning-contract.invalid-context");
    expectContractFailure(baseResult(), baseContext({ maxSources: 501 }), "planning-contract.invalid-context");
    expectContractFailure(baseResult(), baseContext({ maxSources: 1.5 }), "planning-contract.invalid-context");
    expectContractFailure(baseResult(), baseContext({ maxSources: Number.NaN }), "planning-contract.invalid-context");
    expectContractFailure(baseResult(), baseContext({ maxSources: "30" }), "planning-contract.invalid-context");
  });

  it("rejects a Proxy context without invoking any trap", () => {
    let trapped = false;
    const proxy = new Proxy(baseContext(), {
      get(target, prop, receiver) {
        trapped = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    expectContractFailure(baseResult(), proxy, "planning-contract.invalid-context");
    expect(trapped).toBe(false);
  });

  it("rejects a context with an accessor property without invoking the getter", () => {
    let invoked = false;
    const context: Record<string, unknown> = { runId: RUN_ID, attemptId: ATTEMPT_ID };
    Object.defineProperty(context, "maxSources", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return 30;
      },
    });
    expectContractFailure(baseResult(), context, "planning-contract.invalid-context");
    expect(invoked).toBe(false);
  });
});

describe("validateCoordinatorPlanningResultInternal — result structure", () => {
  it("rejects non-object, null, array, and exotic-prototype roots", () => {
    expectContractFailure("nope", baseContext(), "planning-contract.invalid-result");
    expectContractFailure(null, baseContext(), "planning-contract.invalid-result");
    expectContractFailure([], baseContext(), "planning-contract.invalid-result");
    expectContractFailure(Object.create({ evil: true }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects extra or missing keys at every object layer", () => {
    expectContractFailure(baseResult({ extra: 1 }), baseContext(), "planning-contract.invalid-result");
    const { rationale: _drop, ...missingRationale } = baseResult();
    expectContractFailure(missingRationale, baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ tasks: [baseTask({ extra: 1 })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(
      baseResult({ tasks: [baseTask({ evidenceRule: baseEvidenceRule({ extra: 1 }) })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
    const { fullTextRequired: _drop2, ...missingRuleField } = baseEvidenceRule();
    expectContractFailure(baseResult({ tasks: [baseTask({ evidenceRule: missingRuleField })] }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects wrong schemaVersion/resultType literals", () => {
    expectContractFailure(baseResult({ schemaVersion: 2 }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ resultType: "gap-analysis" }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects a runId or attemptId that does not equal the validated context (wrong context binding)", () => {
    expectContractFailure(baseResult({ runId: `run-${"c".repeat(16)}` }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ attemptId: `attempt-${"c".repeat(16)}` }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects a Proxy result value without invoking any trap", () => {
    let trapped = false;
    const proxy = new Proxy(baseResult(), {
      get(target, prop, receiver) {
        trapped = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    expectContractFailure(proxy, baseContext(), "planning-contract.invalid-result");
    expect(trapped).toBe(false);
  });

  it("rejects a result with an accessor property without invoking the getter", () => {
    let invoked = false;
    const value = baseResult();
    Object.defineProperty(value, "rationale", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "scope the question before dispatch";
      },
    });
    expectContractFailure(value, baseContext(), "planning-contract.invalid-result");
    expect(invoked).toBe(false);
  });

  it("rejects symbol-keyed properties, non-plain prototypes, and cyclic structures", () => {
    const withSymbol = baseResult();
    (withSymbol as Record<symbol, unknown>)[Symbol("x")] = 1;
    expectContractFailure(withSymbol, baseContext(), "planning-contract.invalid-result");

    class Exotic {}
    expectContractFailure(Object.assign(new Exotic(), baseResult()), baseContext(), "planning-contract.invalid-result");

    const cyclic: Record<string, unknown> = baseResult();
    (cyclic.tasks as unknown[]).push(cyclic);
    expectContractFailure(cyclic, baseContext(), "planning-contract.invalid-result");
  });

  it("rejects sparse and decorated arrays without executing traps", () => {
    const sparseTasks = [baseTask()];
    // eslint-disable-next-line no-sparse-arrays
    sparseTasks.length = 2;
    expectContractFailure(baseResult({ tasks: sparseTasks }), baseContext(), "planning-contract.invalid-result");

    const decorated = [baseTask()] as unknown[] & { extra?: unknown };
    decorated.extra = "unexpected";
    expectContractFailure(baseResult({ tasks: decorated }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects task count outside 1..64", () => {
    expectContractFailure(baseResult({ tasks: [] }), baseContext(), "planning-contract.invalid-result");
    const tooMany = Array.from({ length: 65 }, (_, i) => baseTask({ proposalId: `t${i}` }));
    expectContractFailure(baseResult({ tasks: tooMany }), baseContext(), "planning-contract.invalid-result");
  });
});

describe("validateCoordinatorPlanningResultInternal — task fields", () => {
  it("rejects malformed proposalId syntax", () => {
    for (const bad of ["Search", "1search", "search literature", "-search", "", "a".repeat(65)]) {
      expectContractFailure(baseResult({ tasks: [baseTask({ proposalId: bad })] }), baseContext(), "planning-contract.invalid-result");
    }
  });

  it("rejects an unknown role", () => {
    expectContractFailure(baseResult({ tasks: [baseTask({ role: "coordinator" })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ tasks: [baseTask({ role: "adversarial-verifier" })] }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects evidenceRule with wrong types or out-of-range minimumLineages", () => {
    expectContractFailure(
      baseResult({ tasks: [baseTask({ evidenceRule: baseEvidenceRule({ minimumLineages: -1 }) })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
    expectContractFailure(
      baseResult({ tasks: [baseTask({ evidenceRule: baseEvidenceRule({ minimumLineages: 1.5 }) })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
    expectContractFailure(
      baseResult({ tasks: [baseTask({ evidenceRule: baseEvidenceRule({ independentVerificationAllowed: "yes" }) })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("clamps the minimumLineages ceiling to min(16, maxSources)", () => {
    // maxSources=10 -> ceiling is 10, so 11 must be rejected even though it is <= 16
    expectContractFailure(
      baseResult({ tasks: [baseTask({ evidenceRule: baseEvidenceRule({ minimumLineages: 11 }) })] }),
      baseContext({ maxSources: 10 }),
      "planning-contract.invalid-result",
    );
    const ok = validateCoordinatorPlanningResultInternal(
      baseResult({ tasks: [baseTask({ evidenceRule: baseEvidenceRule({ minimumLineages: 10 }) })] }),
      baseContext({ maxSources: 10 }),
    );
    expect(ok.tasks[0]!.evidenceRule.minimumLineages).toBe(10);
  });
});

describe("validateCoordinatorPlanningResultInternal — text bounds", () => {
  it("rejects malformed UTF-16 (lone surrogate) before measuring bytes", () => {
    const lone = "\ud800";
    expectContractFailure(baseResult({ tasks: [baseTask({ description: lone })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ rationale: lone }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects forbidden control characters except TAB/LF", () => {
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "bad null" })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "baddel" })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "badcontrol" })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "bad\rcarriage" })] }), baseContext(), "planning-contract.invalid-result");
    const ok = validateCoordinatorPlanningResultInternal(
      baseResult({ tasks: [baseTask({ description: "line one\tand\nline two" })] }),
      baseContext(),
    );
    expect(ok.tasks[0]!.description).toBe("line one\tand\nline two");
  });

  it("rejects empty or whitespace-only description/rationale", () => {
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "" })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "   \t\n  " })] }), baseContext(), "planning-contract.invalid-result");
    expectContractFailure(baseResult({ rationale: "   " }), baseContext(), "planning-contract.invalid-result");
  });

  it("rejects description/rationale over their per-field byte bound", () => {
    expectContractFailure(baseResult({ tasks: [baseTask({ description: "a".repeat(4097) })] }), baseContext(), "planning-contract.invalid-result");
    const okDescription = validateCoordinatorPlanningResultInternal(
      baseResult({ tasks: [baseTask({ description: "a".repeat(4096) })] }),
      baseContext(),
    );
    expect(okDescription.tasks[0]!.description).toHaveLength(4096);

    expectContractFailure(baseResult({ rationale: "a".repeat(16385) }), baseContext(), "planning-contract.invalid-result");
    const okRationale = validateCoordinatorPlanningResultInternal(baseResult({ rationale: "a".repeat(16384) }), baseContext());
    expect(okRationale.rationale).toHaveLength(16384);
  });

  it("rejects the aggregate canonical result over 256 KiB even when raw per-field sums stay under it (escaped growth)", () => {
    // Each description is exactly at the 4096-byte raw cap, but is built entirely from
    // backslashes, which double in size under JSON/canonical-JSON escaping. 64 tasks *
    // 4096 raw bytes = 262144 (== 256 KiB) but the escaped canonical form is ~2x that.
    const tasks = Array.from({ length: 64 }, (_, i) =>
      baseTask({ proposalId: `t${i}`, description: "\\".repeat(4096) }),
    );
    expectContractFailure(baseResult({ tasks }), baseContext(), "planning-contract.invalid-result");
  });
});

describe("validateCoordinatorPlanningResultInternal — dependency graph", () => {
  it("rejects a self-referential dependency", () => {
    expectContractFailure(
      baseResult({ tasks: [baseTask({ proposalId: "a", dependsOnProposalIds: ["a"] })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("rejects a reference to an unknown proposalId", () => {
    expectContractFailure(
      baseResult({ tasks: [baseTask({ proposalId: "a", dependsOnProposalIds: ["missing"] })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("rejects a dependency cycle across two or more tasks", () => {
    expectContractFailure(
      baseResult({
        tasks: [
          baseTask({ proposalId: "a", dependsOnProposalIds: ["b"] }),
          baseTask({ proposalId: "b", dependsOnProposalIds: ["a"] }),
        ],
      }),
      baseContext(),
      "planning-contract.invalid-result",
    );
    expectContractFailure(
      baseResult({
        tasks: [
          baseTask({ proposalId: "a", dependsOnProposalIds: ["b"] }),
          baseTask({ proposalId: "b", dependsOnProposalIds: ["c"] }),
          baseTask({ proposalId: "c", dependsOnProposalIds: ["a"] }),
        ],
      }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("rejects a duplicate proposalId across tasks", () => {
    expectContractFailure(
      baseResult({ tasks: [baseTask({ proposalId: "a" }), baseTask({ proposalId: "a" })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("rejects a duplicate dependency edge within one task", () => {
    expectContractFailure(
      baseResult({
        tasks: [
          baseTask({ proposalId: "a" }),
          baseTask({ proposalId: "b", dependsOnProposalIds: ["a", "a"] }),
        ],
      }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("rejects more than 63 dependencies on one task", () => {
    // The per-task length bound is checked before any existence/duplicate check, so 64
    // syntactically valid (but otherwise arbitrary) IDs are enough to isolate this bound.
    const tooMany = Array.from({ length: 64 }, (_, i) => `dep${i}`);
    expectContractFailure(
      baseResult({ tasks: [baseTask({ proposalId: "dependent", dependsOnProposalIds: tooMany })] }),
      baseContext(),
      "planning-contract.invalid-result",
    );
  });

  it("rejects more than 256 total dependency edges across all tasks", () => {
    // 5 hub tasks each depending on all other 4 * (many) leaf tasks to cross the 256 aggregate cap
    // while staying within the per-task 63 cap and the 64 total-task cap.
    const leaves = Array.from({ length: 58 }, (_, i) => baseTask({ proposalId: `leaf${i}`, dependsOnProposalIds: [] }));
    const leafIds = leaves.map((t) => t.proposalId as string);
    const hubs = Array.from({ length: 5 }, (_, i) =>
      baseTask({ proposalId: `hub${i}`, dependsOnProposalIds: leafIds.slice(0, 53) }),
    ); // 5 * 53 = 265 > 256, each hub's 53 <= 63 per-task cap, total tasks = 58 + 5 = 63 <= 64
    expectContractFailure(baseResult({ tasks: [...leaves, ...hubs] }), baseContext(), "planning-contract.invalid-result");
  });
});

describe("validateCoordinatorPlanningResultInternal — output isolation and identity", () => {
  it("is unaffected by later mutation of the original input", () => {
    const input = baseResult();
    const result = validateCoordinatorPlanningResultInternal(input, baseContext());
    (input.tasks as unknown[])[0] = "mutated";
    (input as Record<string, unknown>).rationale = "mutated";
    expect(result.tasks[0]).not.toBe("mutated");
    expect(result.rationale).toBe("scope the question before dispatch");
  });

  it("rejects mutation attempts on the returned frozen result", () => {
    const result = validateCoordinatorPlanningResultInternal(baseResult(), baseContext());
    expect(() => {
      (result as unknown as Record<string, unknown>).rationale = "changed";
    }).toThrow(TypeError);
    expect(() => {
      (result.tasks as unknown[]).push(baseTask());
    }).toThrow(TypeError);
    expect(() => {
      (result.tasks[0] as unknown as Record<string, unknown>).description = "changed";
    }).toThrow(TypeError);
  });

  it("accepts a genuinely validated result via assertValidatedCoordinatorPlanningResultInternal", () => {
    const result = validateCoordinatorPlanningResultInternal(baseResult(), baseContext());
    expect(() => assertValidatedCoordinatorPlanningResultInternal(result)).not.toThrow();
  });

  it("rejects a forged object with identical shape and values", () => {
    const result = validateCoordinatorPlanningResultInternal(baseResult(), baseContext());
    const forged = JSON.parse(JSON.stringify(result));
    expect(forged).toEqual(JSON.parse(JSON.stringify(result)));
    expect(() => assertValidatedCoordinatorPlanningResultInternal(forged)).toThrow(ResearchPlanningContractError);
    try {
      assertValidatedCoordinatorPlanningResultInternal(forged);
    } catch (error) {
      expect((error as ResearchPlanningContractError).code).toBe("planning-contract.invalid-result");
    }
  });

  it("rejects primitives passed to the assertion", () => {
    expect(() => assertValidatedCoordinatorPlanningResultInternal("not-a-result")).toThrow(ResearchPlanningContractError);
    expect(() => assertValidatedCoordinatorPlanningResultInternal(null)).toThrow(ResearchPlanningContractError);
  });
});

describe("ResearchPlanningContractError — redaction", () => {
  it("sanitizes an unknown code to the safe default", () => {
    const error = new ResearchPlanningContractError("planning-contract.forged" as never);
    expect(error.code).toBe("planning-contract.invalid-result");
    expect(error.message).toBe("Research planning contract failed (planning-contract.invalid-result)");
  });

  it("never echoes raw input values, IDs, or the question in the message", () => {
    try {
      validateCoordinatorPlanningResultInternal(baseResult({ runId: "run-secret-question-leak-0000" }), baseContext());
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("secret-question-leak");
      expect(message).toBe("Research planning contract failed (planning-contract.invalid-result)");
    }
  });

  it("is frozen and carries no enumerable properties beyond name/message/code", () => {
    const error = new ResearchPlanningContractError("planning-contract.invalid-result");
    expect(Object.isFrozen(error)).toBe(true);
    const ownEnumerable = Object.keys(error).sort();
    expect(ownEnumerable).toEqual(["code", "name"]);
  });
});
