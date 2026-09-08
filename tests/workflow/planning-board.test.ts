import { describe, expect, it } from "vitest";

import {
  assertValidatedPlanningTaskBoardInternal,
  buildPlanningTaskBoardInternal,
  ResearchPlanningBoardError,
  type ResearchPlanningTaskBindingsInternal,
} from "../../src/workflow/planning-board-internal.js";
import {
  validateCoordinatorPlanningResultInternal,
  type ResearchPlanningValidationContextInternal,
} from "../../src/workflow/planning-contract-internal.js";
import { canonicalJsonBytes } from "../../src/crypto/canonical-json.js";
import { parse } from "../../src/domain/schema.js";
import { TaskRecordSchema } from "../../src/domain/records.js";

const RUN_ID = `run-${"a".repeat(16)}`;
const ATTEMPT_ID = `attempt-${"b".repeat(16)}`;
const CONTROL_TASK_ID = `task-${"c".repeat(16)}`;

function context(overrides: Partial<Record<string, unknown>> = {}): ResearchPlanningValidationContextInternal {
  return { runId: RUN_ID, attemptId: ATTEMPT_ID, maxSources: 30, ...overrides } as ResearchPlanningValidationContextInternal;
}

function taskId(n: number): string {
  return `task-${String(n).padStart(16, "0")}`;
}

interface RawTaskSpec {
  proposalId: string;
  dependsOnProposalIds?: string[];
  description?: string;
  role?: string;
}

function evidenceRule() {
  return {
    minimumLineages: 1,
    independentVerificationAllowed: true,
    primarySourceRequired: true,
    fullTextRequired: false,
  };
}

function buildAuthenticResult(specs: RawTaskSpec[], contextOverrides: Partial<Record<string, unknown>> = {}) {
  const ctx = context(contextOverrides);
  const rawTasks = specs.map((spec) => ({
    proposalId: spec.proposalId,
    description: spec.description ?? `describe ${spec.proposalId}`,
    role: spec.role ?? "literature-searcher",
    evidenceRule: evidenceRule(),
    dependsOnProposalIds: spec.dependsOnProposalIds ?? [],
  }));
  const raw = {
    schemaVersion: 1,
    runId: ctx.runId,
    attemptId: ctx.attemptId,
    resultType: "planning",
    tasks: rawTasks,
    rationale: "scope the question before dispatch",
  };
  return validateCoordinatorPlanningResultInternal(raw, ctx);
}

function bindingsFor(count: number, controlTaskId: string = CONTROL_TASK_ID): ResearchPlanningTaskBindingsInternal {
  return {
    controlTaskId: controlTaskId as never,
    taskIds: Array.from({ length: count }, (_, i) => taskId(i)) as never,
  };
}

function expectBoardFailure(result: unknown, bindings: unknown, code: string): void {
  try {
    buildPlanningTaskBoardInternal(result as never, bindings as never);
    expect.unreachable("expected ResearchPlanningBoardError");
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanningBoardError);
    expect((error as ResearchPlanningBoardError).code).toBe(code);
    expect((error as Error).message).toBe(`Research planning board failed (${code})`);
  }
}

describe("buildPlanningTaskBoardInternal — topological ordering", () => {
  it("keeps original per-index ID bindings after a reverse-submitted DAG is reordered", () => {
    // Submitted C(deps:[B]), B(deps:[A]), A(deps:[]) — reverse of dependency order.
    const result = buildAuthenticResult([
      { proposalId: "c", dependsOnProposalIds: ["b"] },
      { proposalId: "b", dependsOnProposalIds: ["a"] },
      { proposalId: "a", dependsOnProposalIds: [] },
    ]);
    const bindings = bindingsFor(3); // taskIds[0]=C's id, [1]=B's id, [2]=A's id
    const board = buildPlanningTaskBoardInternal(result, bindings);
    expect(board.tasks.map((m) => m.proposalId)).toEqual(["a", "b", "c"]);
    expect(board.tasks[0]!.task.taskId).toBe(taskId(2)); // a bound to original index 2
    expect(board.tasks[1]!.task.taskId).toBe(taskId(1)); // b bound to original index 1
    expect(board.tasks[2]!.task.taskId).toBe(taskId(0)); // c bound to original index 0
  });

  it("breaks ties among simultaneously-ready nodes by smallest original index, not proposalId text", () => {
    // Submitted zzz, yyy, xxx — all independent (ready from the start). Lexical order would be
    // xxx,yyy,zzz; correct behavior preserves submission order exactly.
    const result = buildAuthenticResult([
      { proposalId: "zzz" },
      { proposalId: "yyy" },
      { proposalId: "xxx" },
    ]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(3));
    expect(board.tasks.map((m) => m.proposalId)).toEqual(["zzz", "yyy", "xxx"]);
  });

  it("emits a prerequisite before a dependent even when the dependent was submitted first", () => {
    const result = buildAuthenticResult([
      { proposalId: "b", dependsOnProposalIds: ["a"] },
      { proposalId: "a" },
    ]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(2));
    expect(board.tasks.map((m) => m.proposalId)).toEqual(["a", "b"]);
  });

  it("sorts dependsOnTaskIds by topological rank of the referenced task, not submission order", () => {
    // a (rank 0), b (rank 1), d depends on [b, a] (submitted reversed relative to rank).
    const result = buildAuthenticResult([
      { proposalId: "a" },
      { proposalId: "b" },
      { proposalId: "d", dependsOnProposalIds: ["b", "a"] },
    ]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(3));
    const d = board.tasks.find((m) => m.proposalId === "d")!;
    expect(d.dependsOnTaskIds).toEqual([taskId(0), taskId(1)]); // a's id, then b's id
  });

  it("handles fully disconnected nodes as plain submission order", () => {
    const result = buildAuthenticResult([{ proposalId: "solo-one" }, { proposalId: "solo-two" }]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(2));
    expect(board.tasks.map((m) => m.proposalId)).toEqual(["solo-one", "solo-two"]);
    expect(board.tasks[0]!.dependsOnTaskIds).toEqual([]);
    expect(board.tasks[1]!.dependsOnTaskIds).toEqual([]);
  });

  it("reverses a 64-node linear chain submitted tail-first", () => {
    const specs: RawTaskSpec[] = Array.from({ length: 64 }, (_, i) => ({
      proposalId: `n${63 - i}`, // submitted n63, n62, ..., n0
      dependsOnProposalIds: 63 - i > 0 ? [`n${63 - i - 1}`] : [],
    }));
    const result = buildAuthenticResult(specs);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(64));
    expect(board.tasks.map((m) => m.proposalId)).toEqual(Array.from({ length: 64 }, (_, i) => `n${i}`));
  });

  it("handles a valid graph near the 256-edge ceiling", () => {
    const leaves: RawTaskSpec[] = Array.from({ length: 58 }, (_, i) => ({ proposalId: `leaf${i}` }));
    const leafIds = leaves.map((t) => t.proposalId);
    const hubs: RawTaskSpec[] = Array.from({ length: 5 }, (_, i) => ({
      proposalId: `hub${i}`,
      dependsOnProposalIds: leafIds.slice(0, 51), // 5*51 = 255 <= 256, each <=63 per task
    }));
    const specs = [...leaves, ...hubs];
    const result = buildAuthenticResult(specs);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(specs.length));
    expect(board.tasks).toHaveLength(63);
    for (const hub of board.tasks.filter((m) => m.proposalId.startsWith("hub"))) {
      expect(hub.dependsOnTaskIds).toHaveLength(51);
    }
  });
});

describe("buildPlanningTaskBoardInternal — result/context propagation and V1 conformance", () => {
  it("propagates runId/attemptId from the authenticated result unchanged", () => {
    const customRunId = `run-${"d".repeat(20)}`;
    const customAttemptId = `attempt-${"e".repeat(20)}`;
    const result = buildAuthenticResult([{ proposalId: "solo" }], { runId: customRunId, attemptId: customAttemptId });
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(1));
    expect(board.runId).toBe(customRunId);
    expect(board.attemptId).toBe(customAttemptId);
  });

  it("produces tasks that parse as genuine V1 TaskRecords with state open and empty attemptIds", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(1));
    const mapping = board.tasks[0]!;
    const parsed = parse(TaskRecordSchema, mapping.task);
    expect(parsed.success).toBe(true);
    expect(mapping.task.revision).toBe(1);
    expect(mapping.task.state).toBe("open");
    expect(mapping.task.attemptIds).toEqual([]);
    expect(mapping.task.blocker).toBeNull();
    expect(mapping.task.resolution).toBeNull();
  });

  it("never includes the control task among the tasks list", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(1));
    expect(board.tasks.some((m) => m.task.taskId === board.controlTaskId)).toBe(false);
  });
});

describe("buildPlanningTaskBoardInternal — bindings validation", () => {
  it("rejects a non-object bindings value", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    expectBoardFailure(result, "not-an-object", "planning-board.invalid-bindings");
    expectBoardFailure(result, null, "planning-board.invalid-bindings");
    expectBoardFailure(result, [], "planning-board.invalid-bindings");
  });

  it("rejects extra or missing keys on bindings", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    expectBoardFailure(result, { ...bindingsFor(1), extra: 1 }, "planning-board.invalid-bindings");
    const { taskIds: _drop, ...missing } = bindingsFor(1) as unknown as Record<string, unknown>;
    expectBoardFailure(result, missing, "planning-board.invalid-bindings");
  });

  it("rejects a taskIds length that does not match result.tasks.length", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    expectBoardFailure(result, bindingsFor(0), "planning-board.invalid-bindings");
    expectBoardFailure(result, bindingsFor(2), "planning-board.invalid-bindings");
  });

  it("rejects malformed task ID syntax", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    expectBoardFailure(result, { controlTaskId: "not-a-task-id", taskIds: [taskId(0)] }, "planning-board.invalid-bindings");
    expectBoardFailure(result, { controlTaskId: CONTROL_TASK_ID, taskIds: ["short"] }, "planning-board.invalid-bindings");
  });

  it("rejects duplicate task IDs within taskIds", () => {
    const result = buildAuthenticResult([{ proposalId: "a" }, { proposalId: "b" }]);
    expectBoardFailure(result, { controlTaskId: CONTROL_TASK_ID, taskIds: [taskId(0), taskId(0)] }, "planning-board.invalid-bindings");
  });

  it("rejects a taskIds entry colliding with controlTaskId", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    expectBoardFailure(result, { controlTaskId: taskId(0), taskIds: [taskId(0)] }, "planning-board.invalid-bindings");
  });

  it("accepts a null-prototype bindings record", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const nullProtoBindings = Object.assign(Object.create(null), bindingsFor(1));
    const board = buildPlanningTaskBoardInternal(result, nullProtoBindings);
    expect(board.tasks).toHaveLength(1);
  });

  it("rejects a Proxy bindings value without invoking any trap", () => {
    let trapped = false;
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const proxy = new Proxy(bindingsFor(1), {
      get(target, prop, receiver) {
        trapped = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    expectBoardFailure(result, proxy, "planning-board.invalid-bindings");
    expect(trapped).toBe(false);
  });

  it("rejects bindings with an accessor property without invoking the getter", () => {
    let invoked = false;
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const bindings: Record<string, unknown> = { controlTaskId: CONTROL_TASK_ID };
    Object.defineProperty(bindings, "taskIds", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return [taskId(0)];
      },
    });
    expectBoardFailure(result, bindings, "planning-board.invalid-bindings");
    expect(invoked).toBe(false);
  });

  it("rejects symbol-keyed properties, sparse arrays, and decorated arrays on bindings without executing traps", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);

    const withSymbol = bindingsFor(1) as unknown as Record<symbol, unknown>;
    (withSymbol as unknown as Record<string, unknown>).controlTaskId = CONTROL_TASK_ID;
    withSymbol[Symbol("x")] = 1;
    expectBoardFailure(result, withSymbol, "planning-board.invalid-bindings");

    const sparse = [taskId(0)];
    sparse.length = 2;
    expectBoardFailure(result, { controlTaskId: CONTROL_TASK_ID, taskIds: sparse }, "planning-board.invalid-bindings");

    const decorated = [taskId(0)] as unknown[] & { extra?: unknown };
    decorated.extra = "unexpected";
    expectBoardFailure(result, { controlTaskId: CONTROL_TASK_ID, taskIds: decorated }, "planning-board.invalid-bindings");
  });
});

describe("buildPlanningTaskBoardInternal — result authenticity", () => {
  it("rejects a same-shape forged result that was never validated", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const forged = JSON.parse(JSON.stringify(result));
    expectBoardFailure(forged, bindingsFor(1), "planning-board.invalid-result");
  });

  it("rejects a Proxy wrapping a genuinely authentic result", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const proxy = new Proxy(result, {});
    expectBoardFailure(proxy, bindingsFor(1), "planning-board.invalid-result");
  });

  it("checks result authenticity before bindings validity", () => {
    const forgedResult = JSON.parse(JSON.stringify(buildAuthenticResult([{ proposalId: "solo" }])));
    expectBoardFailure(forgedResult, "also-invalid", "planning-board.invalid-result");
  });
});

describe("assertValidatedPlanningTaskBoardInternal", () => {
  it("accepts a genuinely built board", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(1));
    expect(() => assertValidatedPlanningTaskBoardInternal(board)).not.toThrow();
  });

  it("rejects a forged same-shape board", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(1));
    const forged = JSON.parse(JSON.stringify(board));
    try {
      assertValidatedPlanningTaskBoardInternal(forged);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchPlanningBoardError);
      expect((error as ResearchPlanningBoardError).code).toBe("planning-board.invalid-board");
    }
  });

  it("rejects primitives", () => {
    expect(() => assertValidatedPlanningTaskBoardInternal("nope")).toThrow(ResearchPlanningBoardError);
    expect(() => assertValidatedPlanningTaskBoardInternal(null)).toThrow(ResearchPlanningBoardError);
  });
});

describe("buildPlanningTaskBoardInternal — freeze, isolation, determinism", () => {
  it("is unaffected by mutation of the original result/bindings after the call", () => {
    const result = buildAuthenticResult([{ proposalId: "solo" }]);
    const bindings = bindingsFor(1);
    const board = buildPlanningTaskBoardInternal(result, bindings);
    (bindings as unknown as Record<string, unknown>).controlTaskId = "mutated";
    expect(board.controlTaskId).toBe(CONTROL_TASK_ID);
  });

  it("rejects mutation attempts on the returned board at every layer", () => {
    const result = buildAuthenticResult([{ proposalId: "a", dependsOnProposalIds: [] }, { proposalId: "b", dependsOnProposalIds: ["a"] }]);
    const board = buildPlanningTaskBoardInternal(result, bindingsFor(2));
    expect(() => {
      (board as unknown as Record<string, unknown>).controlTaskId = "x";
    }).toThrow(TypeError);
    expect(() => {
      (board.tasks as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (board.tasks[0] as unknown as Record<string, unknown>).proposalId = "x";
    }).toThrow(TypeError);
    expect(() => {
      (board.tasks[0]!.task as unknown as Record<string, unknown>).state = "resolved";
    }).toThrow(TypeError);
    expect(() => {
      (board.tasks[0]!.task.evidenceRule as unknown as Record<string, unknown>).minimumLineages = 99;
    }).toThrow(TypeError);
    expect(() => {
      (board.tasks[0]!.task.attemptIds as unknown[]).push("attempt-x");
    }).toThrow(TypeError);
    expect(() => {
      (board.tasks[1]!.dependsOnTaskIds as unknown[]).push("task-x");
    }).toThrow(TypeError);
  });

  it("produces byte-identical canonical output across two equivalent builds", () => {
    const specs: RawTaskSpec[] = [
      { proposalId: "a" },
      { proposalId: "b", dependsOnProposalIds: ["a"] },
    ];
    const resultOne = buildAuthenticResult(specs.map((s) => ({ ...s })));
    const resultTwo = buildAuthenticResult(specs.map((s) => ({ ...s })));
    const boardOne = buildPlanningTaskBoardInternal(resultOne, bindingsFor(2));
    const boardTwo = buildPlanningTaskBoardInternal(resultTwo, bindingsFor(2));
    expect(boardOne).not.toBe(boardTwo);
    expect(canonicalJsonBytes(boardOne)).toEqual(canonicalJsonBytes(boardTwo));
  });
});

describe("ResearchPlanningBoardError — redaction", () => {
  it("sanitizes an unknown code to the safe default", () => {
    const error = new ResearchPlanningBoardError("planning-board.forged" as never);
    expect(error.code).toBe("planning-board.invalid-board");
    expect(error.message).toBe("Research planning board failed (planning-board.invalid-board)");
  });

  it("is frozen and carries no unexpected enumerable properties", () => {
    const error = new ResearchPlanningBoardError("planning-board.invalid-bindings");
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.keys(error).sort()).toEqual(["code", "name"]);
  });

  it("never echoes raw IDs or descriptions in the message", () => {
    const result = buildAuthenticResult([{ proposalId: "solo", description: "top-secret-description-leak" }]);
    try {
      buildPlanningTaskBoardInternal(result, { controlTaskId: "task-secret-leak-attempt-000", taskIds: [taskId(0)] } as never);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("secret");
      expect(message).toBe("Research planning board failed (planning-board.invalid-bindings)");
    }
  });
});
