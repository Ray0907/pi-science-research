import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const projectRoot = new URL("../", import.meta.url);

const healthyStatus = {
  runId: "run-1234567890abcdef",
  state: "researching" as const,
  tasksByState: { open: 0, ready: 1, running: 0, blocked: 0, resolved: 0, cancelled: 0 },
  taskTotal: 1,
  attemptTotal: 1,
  pendingSafeReadSchedules: 0,
  earliestNotBeforeAt: null,
  uncertainNeverBlockers: 0,
  pendingTransactions: 0,
  unmaterializedResults: 0,
  committedTransactions: 0,
  executionEpoch: 0,
  integrity: "verified" as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Pi package manifest", () => {
  it("exports the scholarly evidence core from the package root", async () => {
    const api = await import("../src/index.js");
    for (const name of ["normalizeDoi", "buildRequestProvenanceIndex", "buildLineageGraph", "buildBoundedValidatedEvidenceSnapshot", "evaluateEvidenceRule", "buildEvidenceIndex", "assignCitationMappings", "ScholarlyIdentifierError", "SourceIdentityError", "LineageError", "EvidenceAdmissionError", "EvidenceQueryError", "CitationError", "EvidenceRuleSchema", "CitationMapRecordSchema"]) expect(api).toHaveProperty(name);
  });

  it("does not export validated snapshot internal accessors from the package root", async () => {
    const api = await import("../src/index.js");
    for (const name of ["getValidatedSnapshotIndexes", "buildBoundedValidatedEvidenceSnapshotInternal", "validatedProvenanceRecordsForSnapshot", "buildLineageGraphFromValidatedSources", "getLineageDependencyComponentKey", "getLineageRelationComponentKeyInternal", "prepareProspectiveSourceCanonicalInternal", "validatePreparedSourceSemanticsInternal", "EvidenceSnapshotDiagnostics", "EvidenceQueryDiagnostics", "buildEvidenceIndexWithDiagnosticsInternal", "EvidenceSnapshotBuildFailureInternal", "isEvidenceSnapshotSourceSemanticError", "stableSortByCodeUnitKeyInternal", "encodeNonNegativeSafeIntegerInternal"]) expect(api).not.toHaveProperty(name);
  });

  it("advertises only the extension resource that exists", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")) as {
      keywords?: string[];
      pi?: unknown;
    };

    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({ extensions: ["./extensions/research/index.ts"] });
  });

  it("publishes only runtime sources and license files", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")) as {
      files?: string[];
    };
    expect(manifest.files).toEqual(["extensions", "src", "LICENSE"]);

    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: projectRoot },
    );
    const packed = JSON.parse(stdout) as [{ files: Array<{ path: string }> }];
    const paths = packed[0]!.files.map(({ path }) => path);
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^docs\//),
      expect.stringMatching(/^tests\//),
      "tsconfig.json",
      "vitest.config.ts",
    ]));
    expect(paths).toEqual(expect.arrayContaining([
      "LICENSE",
      "package.json",
      "extensions/research/index.ts",
      "src/index.ts",
      "src/scholarly/identifiers.ts",
      "src/scholarly/source-identity.ts",
      "src/evidence/lineage.ts",
      "src/evidence/admission.ts",
      "src/evidence/query.ts",
      "src/evidence/citations.ts",
    ]));
  });
});

describe("research-status command", () => {
  async function loadCommand(readStatus: (request: { cwd: string; rootPath: string | null }) => Promise<unknown>) {
    const { default: registerResearchExtension } = await import("../extensions/research/index.js");
    const registrations: Array<{
      name: string;
      command: { handler: (args: string, context: unknown) => Promise<unknown> };
    }> = [];
    const api = new Proxy(
      {
        registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<unknown> }) {
          registrations.push({ name, command });
        },
      },
      {
        get(target, property, receiver) {
          if (property !== "registerCommand") throw new Error(`Unexpected ExtensionAPI access: ${String(property)}`);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    registerResearchExtension(api as never, { readStatus } as never);
    expect(registrations.map(({ name }) => name)).toEqual(["research-status"]);
    return registrations[0]!.command.handler;
  }

  it("reports no active run without side effects", async () => {
    vi.useFakeTimers();
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-research-status-"));
    const marker = join(cwd, "marker.txt");
    await writeFile(marker, "unchanged", "utf8");
    const before = {
      entries: await readdir(cwd),
      marker: await readFile(marker, "utf8"),
      mtimeMs: (await stat(marker)).mtimeMs,
    };
    const notify = vi.fn();
    const readStatus = vi.fn(async () => null);
    const forbiddenServices = {
      write: vi.fn(() => { throw new Error("write service called"); }),
      spawn: vi.fn(() => { throw new Error("process service called"); }),
      invokeModel: vi.fn(() => { throw new Error("model service called"); }),
    };

    try {
      const handler = await loadCommand(readStatus);
      const result = await handler("", { cwd, hasUI: true, mode: "tui", ui: { notify }, ...forbiddenServices });
      expect(result).toBeUndefined();
      expect(readStatus).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith("No active research run.", "info");
      expect(Object.values(forbiddenServices).every((service) => service.mock.calls.length === 0)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect({
        entries: await readdir(cwd), marker: await readFile(marker, "utf8"), mtimeMs: (await stat(marker)).mtimeMs,
      }).toEqual(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("parses an explicit root, renders allowlisted status, and warns for pending work", async () => {
    const notify = vi.fn();
    const readStatus = vi.fn(async () => ({
      ...healthyStatus,
      state: "paused" as const,
      tasksByState: { ...healthyStatus.tasksByState, ready: 0, blocked: 1 },
      pendingSafeReadSchedules: 1,
      earliestNotBeforeAt: "2026-08-25T00:01:00.000Z",
      uncertainNeverBlockers: 1,
      pendingTransactions: 1,
      unmaterializedResults: 1,
    }));
    const handler = await loadCommand(readStatus);
    await handler('"/tmp/research root"', { cwd: "/project", hasUI: true, mode: "rpc", ui: { notify } });
    expect(readStatus).toHaveBeenCalledExactlyOnceWith({ cwd: "/project", rootPath: "/tmp/research root" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toBe("warning");
    expect(notify.mock.calls[0]![0]).toBe(
      "Research run run-1234567890abcdef: state=paused; tasks=1 (blocked=1); attempts=1; safe-read pending=1 (earliest 2026-08-25T00:01:00.000Z); never blockers=1; transactions=0 committed/1 pending-finish; unmaterialized results=1; epoch=0; integrity=verified.",
    );
  });

  it.each(["--root /tmp/run", "one two", "\"one\" extra", "'unterminated", "-"])(
    "rejects ambiguous arguments without invoking the reader: %s",
    async (args) => {
      const notify = vi.fn();
      const readStatus = vi.fn(async () => healthyStatus);
      const handler = await loadCommand(readStatus);
      await handler(args, { cwd: "/project", hasUI: true, mode: "tui", ui: { notify } });
      expect(readStatus).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith("Research status unavailable: invalid root path.", "error");
    },
  );

  it("redacts all internal failures and no-ops predictably without UI", async () => {
    const secret = "CAPABILITY_SECRET_SENTINEL";
    const notify = vi.fn();
    const readStatus = vi.fn(async (): Promise<unknown> => { throw new Error(`${secret} https://secret.invalid?q=${secret}`); });
    const handler = await loadCommand(readStatus);
    await handler("/tmp/run", { cwd: "/project", hasUI: true, mode: "tui", ui: { notify } });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Research status unavailable: integrity check failed.", "error");
    expect(JSON.stringify(notify.mock.calls)).not.toContain(secret);

    notify.mockClear();
    readStatus.mockResolvedValue({ ...healthyStatus, runId: secret });
    await handler("/tmp/run", { cwd: "/project", hasUI: true, mode: "rpc", ui: { notify } });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Research status unavailable: integrity check failed.", "error");
    expect(JSON.stringify(notify.mock.calls)).not.toContain(secret);

    notify.mockClear();
    readStatus.mockClear();
    await handler("/tmp/run", { cwd: "/project", hasUI: false, mode: "print", ui: { notify } });
    expect(readStatus).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps command and registration layers free of mutating/process/model/timer imports", async () => {
    const [statusSource, extensionSource] = await Promise.all([
      readFile(new URL("../extensions/research/commands/status.ts", import.meta.url), "utf8"),
      readFile(new URL("../extensions/research/index.ts", import.meta.url), "utf8"),
    ]);
    for (const specifier of [
      "node:fs", "node:fs/promises", "node:child_process", "node:timers", "node:timers/promises", "@earendil-works/pi-ai",
    ]) expect(`${statusSource}\n${extensionSource}`).not.toContain(`from \"${specifier}\"`);
  });
});
