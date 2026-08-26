export * from "./crypto/canonical-json.js";
export * from "./crypto/hash.js";
export * from "./domain/events.js";
export * from "./domain/ids.js";
export * from "./domain/records.js";
export * from "./domain/reducer.js";
export {
  SourceRecordSchema, ClaimRecordSchema, EvidenceRecordSchema, VerificationRecordSchema,
  CalculationRecordSchema, ProvenanceStepSchema, EvidenceRuleSchema, CitationMapRecordSchema, parseResearchRecord,
} from "./domain/research-records.js";
export type {
  SourceRecord, ClaimRecord, EvidenceRecord, VerificationRecord, CalculationRecord, ProvenanceStep, EvidenceRule, CitationMapRecord,
} from "./domain/research-records.js";
export type { ParseResult, ValidationIssue } from "./domain/schema.js";
export * from "./storage/event-ledger.js";
export * from "./storage/retry-store.js";
export * from "./storage/run-root.js";
export * from "./storage/transaction-store.js";

export {
  ScholarlyIdentifierError, normalizeDoi, canonicalDoiUrl, normalizePmid, canonicalPmidUrl,
  normalizePmcid, canonicalPmcidUrl, normalizeCanonicalUrl, validateProspectiveSourceIdentityFields,
} from "./scholarly/identifiers.js";
export type {
  ScholarlyIdentifierKind, ScholarlyIdentifierErrorCode, ScholarlyScalarOptions,
  ProspectiveSourceIdentityOptions, SourceUrlPolicyContext,
} from "./scholarly/identifiers.js";
export {
  SourceIdentityError, validateProspectiveSourceSemantics, sourceIdentityKeys, buildRequestProvenanceIndex,
  validateSourceCanonicalUrlProvenance, validateSourceCanonicalUrlProvenanceOnce, mergeSourceRecords,
} from "./scholarly/source-identity.js";
export type {
  SourceIdentityErrorCode, SourceIdentityKey, SourceMergeConflict, SourceMergeResult,
  SourceUrlProvenance, RequestProvenanceIndex, SourceIdentityOptions,
} from "./scholarly/source-identity.js";
export {
  LineageError, buildLineageGraph, compareSourceIndependence,
} from "./evidence/lineage.js";
export type { LineageErrorCode, IndependenceDecision, LineageGraph, LineageOptions } from "./evidence/lineage.js";
export {
  EvidenceAdmissionError, buildBoundedValidatedEvidenceSnapshot, validateCanonicalEvidenceSet,
  evaluateEvidenceRuleFromRecords, validateProspectiveEvidenceSemantics, evaluateEvidenceRule,
} from "./evidence/admission.js";
export type {
  EvidenceAdmissionErrorCode, CanonicalEvidenceSet, EvidenceSetLimits, EvidenceSnapshotView,
  EvidenceSnapshotOptions, BoundedValidatedEvidenceSnapshot, EvidenceGateDecision,
} from "./evidence/admission.js";
export { EvidenceQueryError, buildEvidenceIndex, buildEvidenceIndexFromRecords } from "./evidence/query.js";
export type {
  EvidenceQueryErrorCode, EvidenceIndexInput, EvidenceQuery, EvidenceSelection, EvidenceIndex, EvidenceIndexOptions,
} from "./evidence/query.js";
export { CitationError, assignCitationMappings, assignCitationMappingsFromRecords } from "./evidence/citations.js";
export type {
  CitationErrorCode, CitationBinding, BibliographyMetadataProjection, CitationOptions,
} from "./evidence/citations.js";
