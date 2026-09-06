import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";
import { canonicalJson, canonicalJsonBytes, CanonicalJsonError } from "../crypto/canonical-json.js";
import { ID_PATTERNS, type AttemptId, type RunId } from "../domain/ids.js";

const MAX_TASKS = 64;
const MAX_DESCRIPTION_BYTES = 4096;
const MAX_RATIONALE_BYTES = 16384;
const MAX_DEPS_PER_TASK = 63;
const MAX_DEPS_TOTAL = 256;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_SOURCES_CEILING = 500;
const MAX_MINIMUM_LINEAGES_CEILING = 16;

const PROPOSAL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TASK_ROLES = [
  "literature-searcher",
  "primary-source-reader",
  "methodology-reviewer",
  "data-verifier",
] as const;

const RUN_ID_PATTERN = ID_PATTERNS.run;
const ATTEMPT_ID_PATTERN = ID_PATTERNS.attempt;

const STRUCTURAL_LIMITS = {
  maxDepth: 12,
  maxNodes: 20_000,
  maxKeys: 20_000,
  maxArrayLength: MAX_TASKS,
  maxStringBytes: MAX_RATIONALE_BYTES,
  maxScalarBytes: MAX_RESULT_BYTES * 2,
};

export type TaskProposalRole = (typeof TASK_ROLES)[number];

export interface TaskProposalEvidenceRuleShape {
  readonly minimumLineages: number;
  readonly independentVerificationAllowed: boolean;
  readonly primarySourceRequired: boolean;
  readonly fullTextRequired: boolean;
}

export interface TaskProposal {
  readonly proposalId: string;
  readonly description: string;
  readonly role: TaskProposalRole;
  readonly evidenceRule: TaskProposalEvidenceRuleShape;
  readonly dependsOnProposalIds: readonly string[];
}

export interface ValidatedCoordinatorPlanningResultInternal {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly resultType: "planning";
  readonly tasks: readonly TaskProposal[];
  readonly rationale: string;
}

export interface ResearchPlanningValidationContextInternal {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly maxSources: number;
}

export type ResearchPlanningContractErrorCode =
  | "planning-contract.invalid-context"
  | "planning-contract.invalid-result";

const KNOWN_CODES: readonly ResearchPlanningContractErrorCode[] = [
  "planning-contract.invalid-context",
  "planning-contract.invalid-result",
];

export class ResearchPlanningContractError extends Error {
  readonly code: ResearchPlanningContractErrorCode;

  constructor(code: ResearchPlanningContractErrorCode) {
    const safeCode: ResearchPlanningContractErrorCode = (KNOWN_CODES as readonly string[]).includes(code)
      ? code
      : "planning-contract.invalid-result";
    super(`Research planning contract failed (${safeCode})`);
    this.name = "ResearchPlanningContractError";
    this.code = safeCode;
    Object.freeze(this);
  }
}

function failContext(): never {
  throw new ResearchPlanningContractError("planning-contract.invalid-context");
}

function failResult(): never {
  throw new ResearchPlanningContractError("planning-contract.invalid-result");
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

/** Rejects malformed UTF-16 (via the existing canonical-JSON well-formedness check), forbidden
 * control characters, whitespace-only content, and oversized values — in that order, so byte
 * measurement never runs against a string whose length would be meaningless. */
function assertBoundedText(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== "string") failResult();
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) failResult();
    throw error;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) failResult();
  }
  if (!/\S/u.test(value)) failResult();
  if (Buffer.byteLength(value, "utf8") > maxBytes) failResult();
}

function validateContextInternal(context: unknown): ResearchPlanningValidationContextInternal {
  try {
    assertBoundedStructure(context, STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) failContext();
    throw error;
  }
  if (!isOrdinaryRecord(context)) failContext();
  if (!exactKeys(context, ["runId", "attemptId", "maxSources"])) failContext();
  const { runId, attemptId, maxSources } = context;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) failContext();
  if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) failContext();
  if (typeof maxSources !== "number" || !Number.isSafeInteger(maxSources)) failContext();
  if (maxSources < 1 || maxSources > MAX_SOURCES_CEILING) failContext();
  return Object.freeze({ runId: runId as RunId, attemptId: attemptId as AttemptId, maxSources });
}

function validateEvidenceRuleInternal(value: unknown, maxSources: number): TaskProposalEvidenceRuleShape {
  if (!isOrdinaryRecord(value)) failResult();
  if (!exactKeys(value, ["minimumLineages", "independentVerificationAllowed", "primarySourceRequired", "fullTextRequired"])) {
    failResult();
  }
  const { minimumLineages, independentVerificationAllowed, primarySourceRequired, fullTextRequired } = value;
  if (typeof minimumLineages !== "number" || !Number.isSafeInteger(minimumLineages)) failResult();
  const ceiling = Math.min(MAX_MINIMUM_LINEAGES_CEILING, maxSources);
  if (minimumLineages < 0 || minimumLineages > ceiling) failResult();
  if (typeof independentVerificationAllowed !== "boolean") failResult();
  if (typeof primarySourceRequired !== "boolean") failResult();
  if (typeof fullTextRequired !== "boolean") failResult();
  return Object.freeze({
    minimumLineages,
    independentVerificationAllowed,
    primarySourceRequired,
    fullTextRequired,
  });
}

function validateDependsOnInternal(value: unknown): string[] {
  if (!Array.isArray(value)) failResult();
  if (value.length > MAX_DEPS_PER_TASK) failResult();
  const seen = new Set<string>();
  const deps: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !PROPOSAL_ID_PATTERN.test(entry)) failResult();
    if (seen.has(entry)) failResult();
    seen.add(entry);
    deps.push(entry);
  }
  return deps;
}

function validateTaskProposalInternal(value: unknown, maxSources: number, seenProposalIds: Set<string>): TaskProposal {
  if (!isOrdinaryRecord(value)) failResult();
  if (!exactKeys(value, ["proposalId", "description", "role", "evidenceRule", "dependsOnProposalIds"])) {
    failResult();
  }
  const { proposalId, description, role, evidenceRule, dependsOnProposalIds } = value;
  if (typeof proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(proposalId)) failResult();
  if (seenProposalIds.has(proposalId)) failResult();
  seenProposalIds.add(proposalId);
  assertBoundedText(description, MAX_DESCRIPTION_BYTES);
  if (typeof role !== "string" || !(TASK_ROLES as readonly string[]).includes(role)) failResult();
  const validatedEvidenceRule = validateEvidenceRuleInternal(evidenceRule, maxSources);
  const deps = validateDependsOnInternal(dependsOnProposalIds);
  if (deps.includes(proposalId)) failResult();

  return Object.freeze({
    proposalId,
    description,
    role: role as TaskProposalRole,
    evidenceRule: validatedEvidenceRule,
    dependsOnProposalIds: Object.freeze(deps),
  });
}

function assertNoUnknownOrCyclicReferences(tasks: readonly TaskProposal[]): void {
  const knownIds = new Set(tasks.map((task) => task.proposalId));
  let totalDeps = 0;
  const dependsOn = new Map<string, readonly string[]>();
  for (const task of tasks) {
    totalDeps += task.dependsOnProposalIds.length;
    for (const dep of task.dependsOnProposalIds) {
      if (!knownIds.has(dep)) failResult();
    }
    dependsOn.set(task.proposalId, task.dependsOnProposalIds);
  }
  if (totalDeps > MAX_DEPS_TOTAL) failResult();

  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 1) failResult();
    if (current === 2) return;
    state.set(id, 1);
    for (const dep of dependsOn.get(id) ?? []) visit(dep);
    state.set(id, 2);
  };
  for (const task of tasks) visit(task.proposalId);
}

const validatedResults = new WeakSet<object>();

export function assertValidatedCoordinatorPlanningResultInternal(
  value: unknown,
): asserts value is ValidatedCoordinatorPlanningResultInternal {
  if (typeof value !== "object" || value === null || !validatedResults.has(value)) {
    failResult();
  }
}

export function validateCoordinatorPlanningResultInternal(
  value: unknown,
  context: ResearchPlanningValidationContextInternal,
): ValidatedCoordinatorPlanningResultInternal {
  const validatedContext = validateContextInternal(context);

  try {
    assertBoundedStructure(value, STRUCTURAL_LIMITS);
  } catch (error) {
    if (error instanceof StructuralLimitError) failResult();
    throw error;
  }

  if (!isOrdinaryRecord(value)) failResult();
  if (!exactKeys(value, ["schemaVersion", "runId", "attemptId", "resultType", "tasks", "rationale"])) failResult();
  const { schemaVersion, runId, attemptId, resultType, tasks, rationale } = value;

  if (schemaVersion !== 1) failResult();
  if (resultType !== "planning") failResult();
  if (typeof runId !== "string" || runId !== validatedContext.runId) failResult();
  if (typeof attemptId !== "string" || attemptId !== validatedContext.attemptId) failResult();
  assertBoundedText(rationale, MAX_RATIONALE_BYTES);
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_TASKS) failResult();

  const seenProposalIds = new Set<string>();
  const validatedTasks = tasks.map((task) => validateTaskProposalInternal(task, validatedContext.maxSources, seenProposalIds));
  assertNoUnknownOrCyclicReferences(validatedTasks);

  const result: ValidatedCoordinatorPlanningResultInternal = Object.freeze({
    schemaVersion: 1,
    runId: validatedContext.runId,
    attemptId: validatedContext.attemptId,
    resultType: "planning",
    tasks: Object.freeze(validatedTasks),
    rationale,
  });

  try {
    if (canonicalJsonBytes(result).length > MAX_RESULT_BYTES) failResult();
  } catch (error) {
    if (error instanceof CanonicalJsonError) failResult();
    throw error;
  }

  validatedResults.add(result);
  return result;
}
