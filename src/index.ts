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

export {
  AcquisitionContractError, createAcademicCandidate, createAcademicDocument,
  createAcquisitionTrace, validateAcademicAcquisitionResult,
} from "./acquisition/contracts.js";
export type {
  AcquisitionProvider, AcquisitionOperation, AcquisitionAccessLevel, AcquisitionProvenanceStatus,
  AcademicAuthor, AcademicCandidate, AcademicCandidateGroup, AcademicDocumentSection, AcademicDocument,
  AcquisitionTraceUrl, AcquisitionTraceRedirect, AcquisitionTraceSettlement, AcquisitionTraceSettlementCode,
  AcquisitionTraceWarning, AcquisitionTraceWarningCode, AcquisitionTrace, AcquisitionFailure,
  AcademicSearchInput, AcademicFetchInput, AcademicPartitionSummary, AcademicAcquisitionResult,
  AcquisitionProvenanceSink, AcademicAcquisitionOptions,
} from "./acquisition/contracts.js";
export { AcademicAcquisitionError, createAcademicAcquisitionCallCapabilities } from "./acquisition/coordinator.js";
export type {
  AcademicAcquisitionCallCapabilitiesDescriptor, AcademicAcquisitionCallCapabilities, AcademicAcquisitionClient,
} from "./acquisition/coordinator.js";

import type { AcademicAcquisitionOptions } from "./acquisition/contracts.js";
import {
  createAcademicAcquisitionClient as createAcademicAcquisitionClientDirect,
  createDefaultAcademicAcquisitionDependencyFactoryInternal,
  type AcademicAcquisitionClient,
} from "./acquisition/coordinator.js";

/** Creates a production scholarly-acquisition client with the package-owned secure dependency graph. */
export function createAcademicAcquisitionClient(options?: AcademicAcquisitionOptions): AcademicAcquisitionClient {
  return createAcademicAcquisitionClientDirect(options, createDefaultAcademicAcquisitionDependencyFactoryInternal());
}
