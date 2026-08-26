import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const TASK_STATES = ["open", "ready", "running", "blocked", "resolved", "cancelled"] as const;
type TaskState = typeof TASK_STATES[number];
type RunState = "created" | "planning" | "researching" | "verifying" | "synthesizing" | "recovering" | "paused" | "failed" | "cancelled" | "completed";

export interface FoundationStatusRequest {
  cwd: string;
  rootPath: string | null;
}

export interface FoundationStatus {
  runId: string;
  state: RunState;
  tasksByState: Record<TaskState, number>;
  taskTotal: number;
  attemptTotal: number;
  pendingSafeReadSchedules: number;
  earliestNotBeforeAt: string | null;
  uncertainNeverBlockers: number;
  pendingTransactions: number;
  unmaterializedResults: number;
  committedTransactions: number;
  executionEpoch: number;
  integrity: "verified";
}

export type ResearchStatusReader = (request: FoundationStatusRequest) => Promise<FoundationStatus | null>;

const INVALID_PATH = "Research status unavailable: invalid root path.";
const INTEGRITY_ERROR = "Research status unavailable: integrity check failed.";

export function createResearchStatusHandler(readStatus: ResearchStatusReader) {
  return async (args: string, context: Pick<ExtensionCommandContext, "cwd" | "hasUI" | "mode" | "ui">): Promise<void> => {
    if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
    const parsed = parseRootArgument(args);
    if (parsed.kind === "invalid") {
      context.ui.notify(INVALID_PATH, "error");
      return;
    }
    if (parsed.rootPath === null) {
      context.ui.notify("No active research run.", "info");
      return;
    }
    try {
      const status = await readStatus({ cwd: context.cwd, rootPath: parsed.rootPath });
      if (status === null) {
        context.ui.notify("No active research run.", "info");
        return;
      }
      assertSafeStatus(status);
      const warning = status.pendingSafeReadSchedules > 0 || status.uncertainNeverBlockers > 0
        || status.pendingTransactions > 0 || status.unmaterializedResults > 0 || status.tasksByState.blocked > 0;
      context.ui.notify(renderFoundationStatus(status), warning ? "warning" : "info");
    } catch {
      context.ui.notify(INTEGRITY_ERROR, "error");
    }
  };
}

export function parseRootArgument(args: string): { kind: "valid"; rootPath: string | null } | { kind: "invalid" } {
  const value = args.trim();
  if (value === "") return { kind: "valid", rootPath: null };
  if (value.startsWith("-") || value.includes("\0")) return { kind: "invalid" };
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" && parsed.length > 0 && !parsed.includes("\0")
        ? { kind: "valid", rootPath: parsed }
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }
  if (value.startsWith("'")) {
    if (value.length < 3 || !value.endsWith("'") || value.slice(1, -1).includes("'")) return { kind: "invalid" };
    return { kind: "valid", rootPath: value.slice(1, -1) };
  }
  if (/\s/.test(value) || value.includes('"') || value.includes("'")) return { kind: "invalid" };
  return { kind: "valid", rootPath: value };
}

function assertSafeStatus(status: FoundationStatus): void {
  const runStates = new Set<RunState>(["created", "planning", "researching", "verifying", "synthesizing", "recovering", "paused", "failed", "cancelled", "completed"]);
  if (!/^run-[a-z0-9]{16,64}$/.test(status.runId) || !runStates.has(status.state) || status.integrity !== "verified") throw new Error("invalid status");
  const counts = [status.taskTotal, status.attemptTotal, status.pendingSafeReadSchedules, status.uncertainNeverBlockers,
    status.pendingTransactions, status.unmaterializedResults, status.committedTransactions, status.executionEpoch, ...TASK_STATES.map((state) => status.tasksByState[state])];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || TASK_STATES.reduce((sum, state) => sum + status.tasksByState[state], 0) !== status.taskTotal) throw new Error("invalid status");
  if (status.pendingSafeReadSchedules === 0 ? status.earliestNotBeforeAt !== null
    : status.earliestNotBeforeAt === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(status.earliestNotBeforeAt)) throw new Error("invalid status");
}

export function renderFoundationStatus(status: FoundationStatus): string {
  const tasks = TASK_STATES.flatMap((state) => status.tasksByState[state] > 0 ? [`${state}=${status.tasksByState[state]}`] : []);
  const earliest = status.earliestNotBeforeAt === null ? "" : ` (earliest ${status.earliestNotBeforeAt})`;
  return `Research run ${status.runId}: state=${status.state}; tasks=${status.taskTotal} (${tasks.join(", ")}); attempts=${status.attemptTotal}; safe-read pending=${status.pendingSafeReadSchedules}${earliest}; never blockers=${status.uncertainNeverBlockers}; transactions=${status.committedTransactions} committed/${status.pendingTransactions} pending-finish; unmaterialized results=${status.unmaterializedResults}; epoch=${status.executionEpoch}; integrity=${status.integrity}.`;
}
