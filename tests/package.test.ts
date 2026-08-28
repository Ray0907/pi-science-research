import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectRoot = new URL("../", import.meta.url);
let packedRuntimePaths: readonly string[] | null = null;

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
  it("exports only sanitized high-level contracts traces and production client from package root", async () => {
    const api = await import("../src/index.js");
    const preexisting = ["AttemptKindSchema","AttemptRecordSchema","AttemptStateSchema","BillingStatusSchema","CalculationFileRecordSchema","CalculationRecordSchema","CanonicalJsonError","CanonicalTransactionManifestSchema","CheckpointStageSchema","CitationError","CitationMapRecordSchema","ClaimRecordSchema","DEFAULT_MAX_LEDGER_LINE_BYTES","EventLedgerError","EvidenceAdmissionError","EvidenceQueryError","EvidenceRecordSchema","EvidenceRuleSchema","FOUNDATION_EVENT_TYPES","FoundationLedgerEventSchema","ID_PATTERNS","LedgerReducerCorruptionError","LineageError","MAX_CANONICAL_JSON_DEPTH","ManifestFileKindSchema","ProvenanceStepSchema","RUN_ROOT_OWNER_FILE","ReplayPolicySchema","RequestIntentRecordSchema","RequestRecordSchema","ReservedIdentityKindSchema","ReservedIdentityOriginSchema","RetryScheduleSchema","RetryStoreError","RunDepthSchema","RunRootError","RunSnapshotSchema","RunStateSchema","ScholarlyIdentifierError","SourceIdentityError","SourceRecordSchema","TaskRecordSchema","TaskRoleSchema","TaskStateSchema","ThinkingLevelSchema","TransactionStoreError","VerificationRecordSchema","assertContainedWrite","assertRetryContinuation","assignCitationMappings","assignCitationMappingsFromRecords","buildBoundedValidatedEvidenceSnapshot","buildEvidenceIndex","buildEvidenceIndexFromRecords","buildLineageGraph","buildRequestProvenanceIndex","cancelRetryEpoch","canonicalDoiUrl","canonicalJson","canonicalJsonBytes","canonicalPmcidUrl","canonicalPmidUrl","commitTransaction","compareSourceIndependence","createIdGenerator","createOwnedRunRoot","createRetryController","evaluateEvidenceRule","evaluateEvidenceRuleFromRecords","hashLedgerEvent","inspectCanonicalTransactionsReadOnly","inspectOwnedRunRootIntegrity","isSha256","isTimestamp","listCommittedTransactions","mergeSourceRecords","normalizeCanonicalUrl","normalizeDoi","normalizePmcid","normalizePmid","openEventLedger","openOwnedRunRoot","parse","parseResearchRecord","prepareTransaction","readVerifiedLedgerSnapshot","reconcileCanonicalTransactions","reconstructCanonicalRecords","recoverRetryState","recoveryDecisionFor","reduceLedgerEvents","revalidateOwnedRunRoot","scheduleRetry","sha256Hex","sourceIdentityKeys","startNewLogicalOperation","startScheduledRetry","validateCanonicalEvidenceSet","validateProspectiveEvidenceSemantics","validateProspectiveSourceIdentityFields","validateProspectiveSourceSemantics","validateRetrySeries","validateSourceCanonicalUrlProvenance","validateSourceCanonicalUrlProvenanceOnce","verifyTransaction"];
    const acquisition = ["AcquisitionContractError","createAcademicCandidate","createAcademicDocument","createAcquisitionTrace","validateAcademicAcquisitionResult","AcademicAcquisitionError","createAcademicAcquisitionCallCapabilities","createAcademicAcquisitionClient"];
    expect(Object.keys(api).sort()).toEqual([...preexisting,...acquisition].sort());
    let injectedReads=0;const ignored=new Proxy({},{get(){injectedReads++;throw new Error("forged dependency");},ownKeys(){injectedReads++;throw new Error("forged dependency");}}),client=(api.createAcademicAcquisitionClient as (...arguments_:unknown[])=>{close():Promise<void>})(undefined,ignored);expect(injectedReads).toBe(0);await client.close();
  });

  it("does not root-export TransportSettlement transport DNS provider result-registry getter view normalizeAcquisitionOptions normalized options planAcquisitionInvocation planning capability plan snapshots sink factory dependency raw payload socket header or operation seams", async () => {
    const api = await import("../src/index.js");
    const forbidden = ["TransportSettlement", "TransportSettlementBase", "TransportFailureCode", "TransportSettlementPartitionStatusInternal", "publishTransportSettlementInternal", "SecureJsonTransport", "SecureTransportRequest", "SecureTransportOptions", "SecureTransportError", "SecureTransportErrorCode", "SecureTransportCapabilitiesInternal", "SecureTransportRequestHandleInternal", "createSecureJsonTransport", "createSecureTransportCapabilitiesInternal", "createNodeSecureTransportCapabilitiesInternal", "openSecureTransportRequestInternal", "ResponseHeaderProjection", "RedirectWitness", "ConnectedPeer", "AcquisitionDnsAddress", "AcquisitionDnsResolver", "AcquisitionDnsResolverDescriptor", "AcquisitionNetworkTarget", "NetworkPolicyError", "NetworkPolicyErrorCode", "NetworkPolicyOptions", "SafeProviderAddressSetInternal", "ValidatedProviderUrl", "createAcquisitionDnsResolver", "createNodeDnsResolver", "validateFixedProviderUrl", "MetadataProviderAdapter", "PmcProviderAdapter", "PubmedProviderAdapter", "ProviderAdapterError", "ProviderAdapterErrorCode", "ProviderCandidateDraft", "ProviderDocumentDraft", "ProviderPartitionExecutor", "ProviderPartitionExecutorDescriptor", "ProviderPartitionOutcome", "ProviderPartitionOutcomeBase", "ProviderPartitionTransportResult", "ProviderExecutionResult", "ProviderExecutionResultInputInternal", "ProviderExecutionResultViewInternal", "ProviderJsonSettlementLookupInternal", "getProviderExecutionResultInternal", "getProviderJsonSettlementInternal", "createProviderExecutionResultInternal", "createProviderPartitionExecutor", "createProviderPartitionOutcomeInternal", "executeProviderPartitionInternal", "createCrossrefAdapter", "createOpenAlexAdapter", "createPubmedAdapter", "createPmcAdapter", "normalizeAcquisitionOptions", "NormalizedAcquisitionOptionsInternal", "NormalizedAcquisitionInvocationInputInternal", "getAcademicAcquisitionClientNormalizedOptionsInternal", "planAcquisitionInvocation", "AcquisitionPlanningCapabilitiesInternal", "AcquisitionPlanningCapabilitiesDescriptorInternal", "AuthenticatedAcquisitionExecutionPlanInternal", "AcquisitionExecutionPlanSnapshotInternal", "AcquisitionEffectiveProviderLimitInternal", "createAcquisitionPlanningCapabilitiesInternal", "getAcquisitionExecutionPlanSnapshotInternal", "listInvocationConcretePartitionsInternal", "listInvocationConditionalReservationsInternal", "createProviderPartitionKey", "ProviderRequestPartitionInternal", "ProviderRequestPartitionSnapshotInternal", "ProviderPartitionPlanOwnerInternal", "ProviderPartitionRegistryOptionsInternal", "createProviderPartitionPlanOwnerInternal", "registerProviderRequestPartitionInternal", "lookupProviderRequestPartitionInternal", "lookupProviderRequestPartitionOwnerInternal", "createProviderRequestPartitionFixtureInternal", "AcquisitionProvenanceSinkDescriptor", "AcquisitionProvenanceHandle", "createAcquisitionProvenanceSinkInternal", "acquisitionSinkBeforeDispatchInternal", "acquisitionSinkSettledInternal", "AcademicAcquisitionInternalCallCapabilitiesDescriptor", "createAcademicAcquisitionCallCapabilitiesInternal", "AcademicAcquisitionDependencyFactoryInternal", "AcademicAcquisitionDependencyFactoryDescriptorInternal", "createAcademicAcquisitionDependencyFactoryInternal", "createDefaultAcademicAcquisitionDependencyFactoryInternal", "ContentDecodeCapabilitiesInternal", "ContentDecodeOperationsDescriptorInternal", "createContentDecodeCapabilitiesInternal", "createNodeContentDecodeCapabilitiesInternal", "EncodedBytesInternal", "EncodedTransportInternal", "EncodedTransportOutcomeInternal", "EncodedTransportSuccessInternal", "EncodedTransportRequestHandleInternal", "createEncodedTransportInternal", "createEncodedTransportOutcomeInternal", "NodeOperationsInternal", "NodeRuntimeCapabilitiesInternal", "NodeClockInternal", "NodeResolverInternal", "NodeRequestOwnedAgentInternal", "NodeRequestCallbacksInternal", "NodeRequestHandleInternal", "NodeRequestOptionsInternal", "NodePinnedHopCallbacksInternal", "NodePinnedHopHandleInternal", "NodePinnedHopSettlementInternal", "PinnedHopRuntimeInternal", "PinnedProviderTargetInternal", "PinnedHopOpenRequestInternal", "createNodeRuntimeCapabilitiesInternal", "createPinnedHopRuntimeInternal", "realNodeOperations", "RequestDeadlineInternal", "RequestDeadlineSchedulerCapabilitiesInternal", "RequestDeadlineSchedulerDescriptorInternal", "createRequestDeadlineInternal", "createNodeRequestDeadlineSchedulerCapabilitiesInternal", "ProviderJsonRootSnapshotInternal", "ProviderJsonValueInternal", "ProviderJsonScanOptions", "ProviderJsonScanError", "ProviderJsonScanErrorCode", "scanAndParseProviderJsonInternal", "snapshotProviderJsonInternal", "InvocationSchedulerCapabilitiesInternal", "InvocationExecutorCapabilitiesInternal", "InvocationExecutionInternal", "PhysicalRequestOwnerInternal", "createInvocationSchedulerCapabilitiesInternal", "createDefaultInvocationSchedulerCapabilitiesInternal", "createInvocationExecutorCapabilitiesInternal", "executeInvocationPlanInternal", "releaseInvocationPartitionResultInternal", "AcademicSessionManager", "AcademicToolDependencies", "AcademicToolDependenciesDescriptor", "createAcademicSessionManager", "createAcademicToolDependencies", "createDefaultAcademicToolDependencies", "registerAcademicTools", "renderAcademicToolResultInternal"];
    for (const name of forbidden) expect(api).not.toHaveProperty(name);
    const allowed = ["AcquisitionContractError","AcquisitionProvider","AcquisitionOperation","AcquisitionAccessLevel","AcquisitionProvenanceStatus","AcademicAuthor","AcademicCandidate","AcademicCandidateGroup","AcademicDocumentSection","AcademicDocument","AcquisitionTraceUrl","AcquisitionTraceRedirect","AcquisitionTraceSettlement","AcquisitionTraceSettlementCode","AcquisitionTraceWarning","AcquisitionTraceWarningCode","AcquisitionTrace","AcquisitionFailure","AcademicSearchInput","AcademicFetchInput","AcademicPartitionSummary","AcademicAcquisitionResult","AcquisitionProvenanceSink","AcademicAcquisitionOptions","AcademicAcquisitionCallCapabilitiesDescriptor","AcademicAcquisitionCallCapabilities","AcademicAcquisitionClient"];
    const runtime = ["AcquisitionContractError","createAcademicCandidate","createAcademicDocument","createAcquisitionTrace","validateAcademicAcquisitionResult","AcademicAcquisitionError","createAcademicAcquisitionCallCapabilities","createAcademicAcquisitionClient"];
    const typeLines = allowed.filter(name=>!runtime.includes(name)).map(name=>`import type {${name}} from "pi-science-research"; let use${name}!: ${name}; void use${name};`);
    const forbiddenLines = forbidden.map(name=>`// @ts-expect-error forbidden root seam ${name}\nimport {${name}} from "pi-science-research"; void ${name};`);
    const fixture = [`import {${runtime.join(",")}} from "pi-science-research";`,...typeLines,...runtime.map(name=>`void ${name};`),`const client: AcademicAcquisitionClient=createAcademicAcquisitionClient(); const call: AcademicAcquisitionCallCapabilities=createAcademicAcquisitionCallCapabilities(); void client; void call;`,`// @ts-expect-error production wrapper accepts no dependency factory\ncreateAcademicAcquisitionClient(undefined, {});`,...forbiddenLines].join("\n");
    const fixtureName=new URL("root-api-fixture.ts",projectRoot).pathname,options:ts.CompilerOptions={strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true},host=ts.createCompilerHost(options),original=host.getSourceFile.bind(host);host.getSourceFile=(name,language,onError,newFile)=>name===fixtureName?ts.createSourceFile(name,fixture,language,true,ts.ScriptKind.TS):original(name,language,onError,newFile);host.fileExists=name=>name===fixtureName||ts.sys.fileExists(name);host.readFile=name=>name===fixtureName?fixture:ts.sys.readFile(name);const program=ts.createProgram([fixtureName],options,host),diagnostics=ts.getPreEmitDiagnostics(program);expect(diagnostics.map(item=>ts.flattenDiagnosticMessageText(item.messageText,"\n"))).toEqual([]);
  });

  it("exports the scholarly evidence core from the package root", async () => {
    const api = await import("../src/index.js");
    for (const name of ["normalizeDoi", "buildRequestProvenanceIndex", "buildLineageGraph", "buildBoundedValidatedEvidenceSnapshot", "evaluateEvidenceRule", "buildEvidenceIndex", "assignCitationMappings", "ScholarlyIdentifierError", "SourceIdentityError", "LineageError", "EvidenceAdmissionError", "EvidenceQueryError", "CitationError", "EvidenceRuleSchema", "CitationMapRecordSchema"]) expect(api).toHaveProperty(name);
  });

  it("does not export validated snapshot internal accessors from the package root", async () => {
    const api = await import("../src/index.js");
    for (const name of ["getValidatedSnapshotIndexes", "buildBoundedValidatedEvidenceSnapshotInternal", "validatedProvenanceRecordsForSnapshot", "buildLineageGraphFromValidatedSources", "getLineageDependencyComponentKey", "getLineageRelationComponentKeyInternal", "prepareProspectiveSourceCanonicalInternal", "validatePreparedSourceSemanticsInternal", "EvidenceSnapshotDiagnostics", "EvidenceQueryDiagnostics", "buildEvidenceIndexWithDiagnosticsInternal", "EvidenceSnapshotBuildFailureInternal", "isEvidenceSnapshotSourceSemanticError", "stableSortByCodeUnitKeyInternal", "encodeNonNegativeSafeIntegerInternal", "CodeUnitOrderErrorInternal"]) expect(api).not.toHaveProperty(name);
  });

  it("advertises only the extension resource that exists", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")) as {
      keywords?: string[];
      pi?: unknown;
    };

    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({ extensions: ["./extensions/research/index.ts"] });
    expect((manifest as {exports?:unknown}).exports).toEqual({".":"./src/index.ts"});
  });

  it("resolves only the package root through Node self-reference semantics", async () => {
    expect(import.meta.resolve("pi-science-research")).toMatch(/\/src\/index\.ts$/u);
    for (const specifier of [
      "pi-science-research/src/index.ts",
      "pi-science-research/src/scholarly/identifiers.js",
      "pi-science-research/src/acquisition/providers/provider-adapter-friend-internal.ts",
      "pi-science-research/src/acquisition/providers/provider-adapter-friend-internal.js",
      "pi-science-research/src/acquisition/coordinator.ts",
      "pi-science-research/src/acquisition/coordinator.js",
      "pi-science-research/src/acquisition/planner-scheduler-friend-internal.ts",
      "pi-science-research/src/acquisition/planner-scheduler-friend-internal.js",
      "pi-science-research/src/acquisition/transport-settlement-friend-internal.ts",
      "pi-science-research/src/acquisition/transport-settlement-friend-internal.js",
    ]) {
      try { import.meta.resolve(specifier); throw new Error(`unexpected subpath access: ${specifier}`); }
      catch (error) { expect(error).toMatchObject({code:"ERR_PACKAGE_PATH_NOT_EXPORTED"}); }
    }
    for(const action of [
      ()=>vi.importActual("pi-science-research/src/index.ts"),
      ()=>vi.importActual("pi-science-research/src/scholarly/identifiers.js"),
      ()=>vi.importActual("pi-science-research/src/acquisition/providers/provider-adapter-friend-internal.ts"),
      ()=>vi.importActual("pi-science-research/src/acquisition/providers/provider-adapter-friend-internal.js"),
      ()=>vi.importActual("pi-science-research/src/acquisition/coordinator.ts"),
      ()=>vi.importActual("pi-science-research/src/acquisition/coordinator.js"),
      ()=>vi.importActual("pi-science-research/src/acquisition/planner-scheduler-friend-internal.ts"),
      ()=>vi.importActual("pi-science-research/src/acquisition/planner-scheduler-friend-internal.js"),
      ()=>vi.importActual("pi-science-research/src/acquisition/transport-settlement-friend-internal.ts"),
      ()=>vi.importActual("pi-science-research/src/acquisition/transport-settlement-friend-internal.js"),
    ]) try { await action(); throw new Error("unexpected subpath import"); }
    catch(error){expect(String(error)).toMatch(/not exported/u);}
  });

  it("publishes acquisition provider transport and extension runtime files only", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")) as {
      files?: string[];
    };
    expect(manifest.files).toEqual(["extensions", "src", "LICENSE"]);

    const packageTemp=await mkdtemp(join(tmpdir(),"pi-science-research-pack-"));
    const npmCliPath=process.platform==="win32"
      ?resolve(dirname(process.execPath),"node_modules","npm","bin","npm-cli.js")
      :resolve(dirname(process.execPath),"..","lib","node_modules","npm","bin","npm-cli.js");
    const npmCliStatus=await stat(npmCliPath).catch(()=>null);
    if(!npmCliStatus?.isFile())throw new Error("npm CLI unavailable at trusted installation path");
    let stdout:string;
    try { stdout=await new Promise<string>((resolvePromise,reject)=>{execFile(process.execPath,[npmCliPath,"pack","--dry-run","--json","--ignore-scripts"],{cwd:projectRoot,shell:false,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,PATHEXT:process.env.PATHEXT,HOME:packageTemp,TMPDIR:packageTemp,TMP:packageTemp,TEMP:packageTemp}},(error,output)=>{if(error)reject(error);else resolvePromise(output);});}); }
    finally { await rm(packageTemp,{recursive:true,force:true}); }
    const packed = JSON.parse(stdout) as [{ files: Array<{ path: string }> }];
    const paths = packed[0]!.files.map(({ path }) => path);
    packedRuntimePaths=Object.freeze([...paths]);
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
      "src/acquisition/providers/pubmed.ts",
      "src/acquisition/providers/pmc.ts",
      "src/acquisition/coordinator.ts",
      "src/acquisition/planner-internal.ts",
      "src/acquisition/planner-scheduler-friend-internal.ts",
      "src/acquisition/scheduler-internal.ts",
      "src/acquisition/transport-settlement-friend-internal.ts",
      "src/acquisition/providers/crossref.ts",
      "src/acquisition/providers/openalex.ts",
      "src/acquisition/providers/pubmed.ts",
      "src/acquisition/providers/pmc.ts",
      "src/acquisition/node-pinned-hop-internal.ts",
      "src/acquisition/secure-json-transport-internal.ts",
      "src/acquisition/transport.ts",
      "src/acquisition/content-decoding-internal.ts",
      "src/acquisition/json-wire-scanner-internal.ts",
      "src/acquisition/providers/shared.ts",
      "extensions/research/tools/academic.ts",
      "extensions/research/acquisition-session.ts",
      "src/scholarly/source-identity.ts",
      "src/evidence/lineage.ts",
      "src/evidence/admission.ts",
      "src/evidence/query.ts",
      "src/evidence/citations.ts",
    ]));
  });

  it("preserves Node engine greater-than-or-equal-to 22.19.0 and feature-gates cross-platform transport", async()=>{
    const manifest=JSON.parse(await readFile(new URL("package.json",projectRoot),"utf8")) as {engines?:{node?:string};dependencies?:Record<string,string>};expect(manifest.engines?.node).toBe(">=22.19.0");expect(manifest.dependencies??{}).toEqual({});const [major,minor]=process.versions.node.split(".").map(Number);expect(major!>22||(major===22&&minor!>=19)).toBe(true);const verifiedNpmCliPath=process.platform==="win32"?resolve(dirname(process.execPath),"node_modules","npm","bin","npm-cli.js"):resolve(dirname(process.execPath),"..","lib","node_modules","npm","bin","npm-cli.js");expect((await stat(verifiedNpmCliPath)).isFile()).toBe(true);
  });

  it("keeps local plans tests fixtures and configs out of the tarball",()=>{expect(packedRuntimePaths).not.toBeNull();const forbidden=packedRuntimePaths!.filter(item=>item.startsWith("docs/")||item.startsWith("tests/")||item.includes("fixtures/")||item==="tsconfig.json"||item==="vitest.config.ts"||item.endsWith(".tmp"));expect(forbidden).toEqual([]);});
});

describe("research-status command", () => {
  async function loadCommand(readStatus: (request: { cwd: string; rootPath: string | null }) => Promise<unknown>) {
    const { default: registerResearchExtension } = await import("../extensions/research/index.js");
    const {createAcademicToolDependencies}=await import("../extensions/research/tools/academic.js");
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
    registerResearchExtension(api as never, { readStatus,academicTools:createAcademicToolDependencies({enabled:false}) } as never);
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
