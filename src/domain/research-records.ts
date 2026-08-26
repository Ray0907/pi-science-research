import { StringEnum } from "@earendil-works/pi-ai/compat";
import { canonicalJson } from "../crypto/canonical-json.js";
import { Type, type Static, type TSchema } from "typebox";

import { RequestRecordSchema } from "./events.js";
import { ID_PATTERNS, isTimestamp } from "./ids.js";
import { issue, parse, registerRefinement, type ParseResult } from "./schema.js";

const closed = { additionalProperties: false } as const;
const id = (pattern: RegExp) => Type.String({ pattern: pattern.source });
const revision = Type.Integer({ minimum: 1 });
const nonNegativeInteger = Type.Integer({ minimum: 0 });
const nonNegativeNumber = Type.Number({ minimum: 0 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const ref = (name: string, pattern: RegExp) => Type.Object({ [name]: id(pattern), revision }, closed);

export const SourceRefSchema = ref("sourceId", ID_PATTERNS.source);
export const ClaimRefSchema = ref("claimId", ID_PATTERNS.claim);
export const EvidenceRefSchema = ref("evidenceId", ID_PATTERNS.evidence);
export const VerificationRefSchema = ref("verificationId", ID_PATTERNS.verification);

const AuthorRecordSchema = Type.Object({ family: nullableString, given: nullableString, literal: nullableString, orcid: nullableString }, closed);
const PublishedSchema = Type.Object({ date: nullableString, precision: StringEnum(["day", "month", "year", "unknown"] as const) }, closed);
export const ProvenanceStepSchema = Type.Object({ field: Type.String(), provider: Type.String(), requestId: id(ID_PATTERNS.request) }, closed);
export type ProvenanceStep = Static<typeof ProvenanceStepSchema>;
const LineageSchema = Type.Object({
  studyId: nullableString,
  cohortIds: Type.Array(Type.String()),
  datasetIds: Type.Array(Type.String()),
  relatedSourceIds: Type.Array(id(ID_PATTERNS.source)),
  relationTypes: Type.Array(StringEnum(["version-of", "correction-of", "reanalysis-of", "reports", "shares-cohort", "shares-dataset"] as const)),
}, closed);

export const SourceRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1), sourceId: id(ID_PATTERNS.source), revision,
  identifiers: Type.Object({ doi: nullableString, pmid: nullableString, pmcid: nullableString }, closed),
  canonicalUrl: Type.String(), title: Type.String(), authors: Type.Array(AuthorRecordSchema),
  containerTitle: nullableString, publisher: nullableString, volume: nullableString, issue: nullableString, pages: nullableString,
  published: PublishedSchema,
  publicationType: StringEnum(["journal-article", "preprint", "review", "dataset", "registry", "standard", "web", "other"] as const),
  peerReviewStatus: StringEnum(["yes", "no", "unknown", "not-applicable"] as const),
  accessLevel: StringEnum(["metadata-only", "abstract-only", "partial-text", "full-text"] as const),
  retrievedAt: timestamp,
  retrievalRequestIds: Type.Array(id(ID_PATTERNS.request)),
  metadataProvenance: Type.Array(ProvenanceStepSchema),
  lineage: LineageSchema,
}, closed);
export type SourceRecord = Static<typeof SourceRecordSchema>;

export const EvidenceRuleSchema = Type.Object({
  minimumLineages: nonNegativeInteger, independentVerificationAllowed: Type.Boolean(),
  primarySourceRequired: Type.Boolean(), fullTextRequired: Type.Boolean(),
}, closed);
export type EvidenceRule = Static<typeof EvidenceRuleSchema>;

export const CitationMapRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  citationNumber: Type.Integer({ minimum: 1 }),
  sourceRef: SourceRefSchema,
  claimRefs: Type.Array(ClaimRefSchema),
  evidenceRefs: Type.Array(EvidenceRefSchema),
}, closed);
export type CitationMapRecord = Static<typeof CitationMapRecordSchema>;
const ScopeQualifiersSchema = Type.Object({ population: nullableString, intervention: nullableString, comparator: nullableString, outcome: nullableString, timeRange: nullableString }, closed);
export const ClaimRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1), claimId: id(ID_PATTERNS.claim), revision, statement: Type.String(),
  kind: StringEnum(["externally-verifiable-fact", "derived-result", "synthesis", "non-factual-framing"] as const),
  materiality: StringEnum(["load-bearing", "contextual"] as const), scopeQualifiers: ScopeQualifiersSchema,
  evidenceRule: EvidenceRuleSchema,
  status: StringEnum(["proposed", "supported", "disputed", "rejected", "unresolved"] as const),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  evidenceRefs: Type.Array(EvidenceRefSchema), conflictClaimIds: Type.Array(id(ID_PATTERNS.claim)),
  createdByAttemptId: id(ID_PATTERNS.attempt),
}, closed);
export type ClaimRecord = Static<typeof ClaimRecordSchema>;

const LocatorRecordSchema = Type.Object({
  type: StringEnum(["page", "section", "paragraph", "figure", "table", "equation", "timestamp", "record", "unknown"] as const), value: Type.String(),
}, closed);
const ExtractedValueSchema = Type.Object({ value: Type.String(), numericValue: Type.Union([Type.Number(), Type.Null()]), unit: nullableString, context: Type.String() }, closed);
export const EvidenceRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1), evidenceId: id(ID_PATTERNS.evidence), revision, claimRef: ClaimRefSchema,
  evidenceType: StringEnum(["retrieved", "derived"] as const), sourceRef: Type.Union([SourceRefSchema, Type.Null()]),
  calculationId: Type.Union([id(ID_PATTERNS.calculation), Type.Null()]),
  stance: StringEnum(["supporting", "contradicting", "neutral"] as const), quotes: Type.Array(Type.String()),
  locators: Type.Array(LocatorRecordSchema), extractedValues: Type.Array(ExtractedValueSchema), method: nullableString,
  quality: StringEnum(["primary-peer-reviewed", "primary-unreviewed", "official", "secondary", "unknown"] as const),
  confidence: Type.Number({ minimum: 0, maximum: 1 }), recordedByAttemptId: id(ID_PATTERNS.attempt),
  verificationStatus: StringEnum(["unverified", "verified", "rejected", "disputed"] as const),
  conflictsWith: Type.Array(id(ID_PATTERNS.evidence)),
}, closed);
export type EvidenceRecord = Static<typeof EvidenceRecordSchema>;

const CorrectionSchema = Type.Object({ claimId: id(ID_PATTERNS.claim), description: Type.String() }, closed);
export const VerificationRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1), verificationId: id(ID_PATTERNS.verification), revision, attemptId: id(ID_PATTERNS.attempt),
  method: StringEnum(["independent-source", "recomputation", "rederivation", "mixed"] as const),
  checkedClaims: Type.Array(ClaimRefSchema), checkedEvidence: Type.Array(EvidenceRefSchema),
  requestIds: Type.Array(id(ID_PATTERNS.request)), calculationIds: Type.Array(id(ID_PATTERNS.calculation)),
  result: StringEnum(["accepted", "rejected", "incomplete"] as const), corrections: Type.Array(CorrectionSchema),
  independentEvidenceIds: Type.Array(id(ID_PATTERNS.evidence)), notes: Type.String(),
}, closed);
export type VerificationRecord = Static<typeof VerificationRecordSchema>;

export const CalculationFileRecordSchema = Type.Object({ relativePath: Type.String(), mediaType: Type.String(), decodedBytes: nonNegativeInteger, sha256 }, closed);
export type CalculationFileRecord = Static<typeof CalculationFileRecordSchema>;
const EnvironmentEntrySchema = Type.Object({ name: Type.String(), value: Type.String() }, closed);
export const CalculationRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1), calculationId: id(ID_PATTERNS.calculation), attemptId: id(ID_PATTERNS.attempt),
  sandboxPolicySha256: sha256, runtime: Type.String(), command: Type.String(), environment: Type.Array(EnvironmentEntrySchema),
  inputs: Type.Array(CalculationFileRecordSchema), sourceFiles: Type.Array(CalculationFileRecordSchema), outputs: Type.Array(CalculationFileRecordSchema),
  networkEnabled: Type.Boolean(), startedAt: timestamp, endedAt: timestamp,
  exitCode: Type.Union([Type.Integer(), Type.Null()]), status: StringEnum(["success", "failed", "cancelled"] as const),
}, closed);
export type CalculationRecord = Static<typeof CalculationRecordSchema>;

registerRefinement(SourceRecordSchema, (input) => isTimestamp((input as SourceRecord).retrievedAt) ? [] : [issue("/retrievedAt", "source.timestamp")]);
registerRefinement(EvidenceRecordSchema, (input) => {
  const value = input as EvidenceRecord;
  if (value.evidenceType === "retrieved") {
    return value.sourceRef !== null && (value.quotes.length > 0 || value.extractedValues.length > 0)
      ? [] : [issue("/sourceRef", "evidence.retrieved-requirements")];
  }
  return value.calculationId !== null || (value.method !== null && value.method.length > 0)
    ? [] : [issue("/calculationId", "evidence.derived-requirements")];
});
registerRefinement(CalculationFileRecordSchema, (input) => portable((input as CalculationFileRecord).relativePath) ? [] : [issue("/relativePath", "calculation.relative-path")]);
registerRefinement(CalculationRecordSchema, (input) => {
  const value = input as CalculationRecord;
  const issues = [value.startedAt, value.endedAt].every(isTimestamp) ? [] : [issue("/startedAt", "calculation.timestamp")];
  if (value.status === "success" && value.exitCode !== 0) issues.push(issue("/exitCode", "calculation.status-exit"));
  if (value.status === "failed" && (value.exitCode === null || value.exitCode === 0)) issues.push(issue("/exitCode", "calculation.status-exit"));
  if (value.status === "cancelled" && value.exitCode !== null) issues.push(issue("/exitCode", "calculation.status-exit"));
  return issues;
});

export const ResearchRecordSchemas = {
  sources: SourceRecordSchema,
  claims: ClaimRecordSchema,
  evidence: EvidenceRecordSchema,
  verifications: VerificationRecordSchema,
  requests: RequestRecordSchema,
  calculations: CalculationRecordSchema,
} as const satisfies Record<string, TSchema>;

export type ResearchRecordKind = keyof typeof ResearchRecordSchemas;
export type ResearchRecord = SourceRecord | ClaimRecord | EvidenceRecord | VerificationRecord | Static<typeof RequestRecordSchema> | CalculationRecord;

export function parseResearchRecord(kind: ResearchRecordKind, value: unknown): ParseResult<ResearchRecord> {
  let snapshot: unknown;
  try { snapshot = JSON.parse(canonicalJson(value)); }
  catch { return { success: false, issues: [issue("/", "record.unsafe-input")] }; }
  return parse(ResearchRecordSchemas[kind], snapshot) as ParseResult<ResearchRecord>;
}

function portable(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[a-z]:/i.test(path) && !path.includes("\\")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
