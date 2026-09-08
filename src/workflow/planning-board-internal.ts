import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import { canonicalJsonBytes, CanonicalJsonError } from "../crypto/canonical-json.js";
import { ID_PATTERNS, type TaskId } from "../domain/ids.js";
import { parse } from "../domain/schema.js";
import { TaskRecordSchema, type TaskRecord } from "../domain/records.js";
import {
  assertValidatedCoordinatorPlanningResultInternal,
  ResearchPlanningContractError,
  type TaskProposal,
  type ValidatedCoordinatorPlanningResultInternal,
} from "./planning-contract-internal.js";

const TASK_ID_PATTERN = ID_PATTERNS.task;
const MAX_BOARD_BYTES = 1024 * 1024;

export interface ResearchPlanningTaskBindingsInternal {
  readonly controlTaskId: TaskId;
  readonly taskIds: readonly TaskId[];
}

export interface PlanningTaskMappingInternal {
  readonly proposalId: string;
  readonly task: Readonly<TaskRecord>;
  readonly dependsOnTaskIds: readonly TaskId[];
}

export interface ValidatedPlanningTaskBoardInternal {
  readonly schemaVersion: 1;
  readonly runId: ValidatedCoordinatorPlanningResultInternal["runId"];
  readonly attemptId: ValidatedCoordinatorPlanningResultInternal["attemptId"];
  readonly controlTaskId: TaskId;
  readonly tasks: readonly PlanningTaskMappingInternal[];
}

export type ResearchPlanningBoardErrorCode =
  | "planning-board.invalid-result"
  | "planning-board.invalid-bindings"
  | "planning-board.invalid-board";

const KNOWN_CODES: readonly ResearchPlanningBoardErrorCode[] = [
  "planning-board.invalid-result",
  "planning-board.invalid-bindings",
  "planning-board.invalid-board",
];

export class ResearchPlanningBoardError extends Error {
  readonly code: ResearchPlanningBoardErrorCode;

  constructor(code: ResearchPlanningBoardErrorCode) {
    const safeCode: ResearchPlanningBoardErrorCode = (KNOWN_CODES as readonly string[]).includes(code)
      ? code
      : "planning-board.invalid-board";
    super(`Research planning board failed (${safeCode})`);
    this.name = "ResearchPlanningBoardError";
    this.code = safeCode;
    Object.freeze(this);
  }
}

function failResult(): never {
  throw new ResearchPlanningBoardError("planning-board.invalid-result");
}

function failBindings(): never {
  throw new ResearchPlanningBoardError("planning-board.invalid-bindings");
}

function failBoard(): never {
  throw new ResearchPlanningBoardError("planning-board.invalid-board");
}

function isOrdinaryRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return keys.every((key) => expectedSet.has(key));
}

const BINDINGS_STRUCTURAL_LIMITS = {
  maxDepth: 4,
  maxNodes: 1_200,
  maxKeys: 1_200,
  maxArrayLength: 65,
  maxStringBytes: 128,
  maxScalarBytes: 8_192,
};

interface ValidatedBindings {
  readonly controlTaskId: TaskId;
  readonly taskIds: readonly TaskId[];
}

function validateBindingsInternal(bindings: unknown, expectedTaskCount: number): ValidatedBindings {
  try {
    assertBoundedStructure(bindings, BINDINGS_STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) failBindings();
    throw error;
  }
  if (!isOrdinaryRecord(bindings)) failBindings();
  if (!exactKeys(bindings, ["controlTaskId", "taskIds"])) failBindings();

  const { controlTaskId, taskIds } = bindings;
  if (typeof controlTaskId !== "string" || !TASK_ID_PATTERN.test(controlTaskId)) failBindings();
  if (!Array.isArray(taskIds) || taskIds.length !== expectedTaskCount) failBindings();

  const seen = new Set<string>([controlTaskId]);
  const validatedTaskIds: TaskId[] = [];
  for (const entry of taskIds) {
    if (typeof entry !== "string" || !TASK_ID_PATTERN.test(entry)) failBindings();
    if (seen.has(entry)) failBindings();
    seen.add(entry);
    validatedTaskIds.push(entry as TaskId);
  }

  return Object.freeze({
    controlTaskId: controlTaskId as TaskId,
    taskIds: Object.freeze(validatedTaskIds),
  });
}

interface TopologicalOrderInternal {
  readonly order: readonly number[];
  readonly indexByProposalId: ReadonlyMap<string, number>;
}

function buildTopologicalOrderInternal(tasks: readonly TaskProposal[]): TopologicalOrderInternal {
  const indexByProposalId = new Map<string, number>();
  tasks.forEach((task, index) => indexByProposalId.set(task.proposalId, index));

  const remainingDeps: Set<string>[] = tasks.map((task) => new Set(task.dependsOnProposalIds));
  const dependents: number[][] = tasks.map(() => []);
  tasks.forEach((task, index) => {
    for (const dep of task.dependsOnProposalIds) {
      const depIndex = indexByProposalId.get(dep);
      if (depIndex !== undefined) dependents[depIndex]!.push(index);
    }
  });

  const emitted = new Array<boolean>(tasks.length).fill(false);
  const order: number[] = [];

  for (let step = 0; step < tasks.length; step += 1) {
    let chosen = -1;
    for (let index = 0; index < tasks.length; index += 1) {
      if (emitted[index]) continue;
      if (remainingDeps[index]!.size > 0) continue;
      if (chosen === -1) chosen = index;
    }
    if (chosen === -1) failBoard(); // unreachable given an authenticated DAG input; fail closed, never loop forever.
    emitted[chosen] = true;
    order.push(chosen);
    for (const dependentIndex of dependents[chosen]!) {
      remainingDeps[dependentIndex]!.delete(tasks[chosen]!.proposalId);
    }
  }

  return { order, indexByProposalId };
}

function buildTaskRecordInternal(taskId: TaskId, proposal: TaskProposal): Readonly<TaskRecord> {
  const record = {
    schemaVersion: 1 as const,
    taskId,
    revision: 1,
    description: proposal.description,
    evidenceRule: {
      minimumLineages: proposal.evidenceRule.minimumLineages,
      independentVerificationAllowed: proposal.evidenceRule.independentVerificationAllowed,
      primarySourceRequired: proposal.evidenceRule.primarySourceRequired,
      fullTextRequired: proposal.evidenceRule.fullTextRequired,
    },
    role: proposal.role,
    state: "open" as const,
    attemptIds: [] as string[],
    blocker: null,
    resolution: null,
  };

  const result = parse(TaskRecordSchema, record);
  if (!result.success) failBoard();

  return Object.freeze({
    ...result.value,
    evidenceRule: Object.freeze({ ...result.value.evidenceRule }),
    attemptIds: Object.freeze([...result.value.attemptIds]),
  }) as Readonly<TaskRecord>;
}

const validatedBoards = new WeakSet<object>();

export function assertValidatedPlanningTaskBoardInternal(
  value: unknown,
): asserts value is ValidatedPlanningTaskBoardInternal {
  if (typeof value !== "object" || value === null || !validatedBoards.has(value)) {
    failBoard();
  }
}

export function buildPlanningTaskBoardInternal(
  result: ValidatedCoordinatorPlanningResultInternal,
  bindings: ResearchPlanningTaskBindingsInternal,
): ValidatedPlanningTaskBoardInternal {
  try {
    assertValidatedCoordinatorPlanningResultInternal(result);
  } catch (error) {
    if (error instanceof ResearchPlanningContractError) failResult();
    throw error;
  }

  const validatedBindings = validateBindingsInternal(bindings, result.tasks.length);

  const { order, indexByProposalId } = buildTopologicalOrderInternal(result.tasks);
  const rankByIndex = new Array<number>(result.tasks.length);
  order.forEach((originalIndex, rank) => {
    rankByIndex[originalIndex] = rank;
  });

  const mappings: PlanningTaskMappingInternal[] = order.map((originalIndex) => {
    const proposal = result.tasks[originalIndex]!;
    const taskId = validatedBindings.taskIds[originalIndex]!;
    const task = buildTaskRecordInternal(taskId, proposal);

    const dependsOnTaskIds = [...proposal.dependsOnProposalIds]
      .sort((left, right) => rankByIndex[indexByProposalId.get(left)!]! - rankByIndex[indexByProposalId.get(right)!]!)
      .map((proposalId) => validatedBindings.taskIds[indexByProposalId.get(proposalId)!]!);

    return Object.freeze({
      proposalId: proposal.proposalId,
      task,
      dependsOnTaskIds: Object.freeze(dependsOnTaskIds),
    });
  });

  const board: ValidatedPlanningTaskBoardInternal = Object.freeze({
    schemaVersion: 1,
    runId: result.runId,
    attemptId: result.attemptId,
    controlTaskId: validatedBindings.controlTaskId,
    tasks: Object.freeze(mappings),
  });

  try {
    if (canonicalJsonBytes(board).length > MAX_BOARD_BYTES) failBoard();
  } catch (error) {
    if (error instanceof CanonicalJsonError) failBoard();
    throw error;
  }

  validatedBoards.add(board);
  return board;
}
