import { isIP } from "node:net";

import { canonicalJson } from "../crypto/canonical-json.js";
import { SourceRecordSchema, type SourceRecord } from "../domain/research-records.js";
import { parse } from "../domain/schema.js";
import { assertBoundedStructure, StructuralLimitError } from "../storage/bounded-structure.js";

export type ScholarlyIdentifierKind = "doi" | "pmid" | "pmcid";

export type ScholarlyIdentifierErrorCode =
  | "identifier.invalid-options"
  | "identifier.invalid-type"
  | "identifier.too-long"
  | "identifier.record-too-large"
  | "identifier.invalid-doi"
  | "identifier.invalid-pmid"
  | "identifier.invalid-pmcid"
  | "url.invalid"
  | "url.unsupported-scheme"
  | "url.credentials-forbidden"
  | "url.fragment-forbidden"
  | "url.too-long"
  | "url.http-context-invalid"
  | "url.http-host-not-approved";

export class ScholarlyIdentifierError extends Error {
  readonly code: ScholarlyIdentifierErrorCode;
  constructor(code: ScholarlyIdentifierErrorCode) {
    super(`Scholarly identifier rejected (${code})`);
    this.name = "ScholarlyIdentifierError";
    this.code = code;
  }
}

export interface ScholarlyScalarOptions { readonly maxCanonicalScalarBytes?: number }
export interface ProspectiveSourceIdentityOptions extends ScholarlyScalarOptions {
  readonly maxSourceRecordCanonicalBytes?: number;
}
export interface SourceUrlPolicyContext {
  readonly allowHttp?: boolean;
  readonly approvedHttpHosts?: readonly string[];
  readonly accessPolicySha256?: string;
  readonly maxApprovedHttpHosts?: number;
}

const DEFAULT_SCALAR_BYTES = 4_096;
const HARD_SCALAR_BYTES = 16_384;
const DEFAULT_SOURCE_BYTES = 262_144;
const HARD_SOURCE_BYTES = 1_048_576;
const DEFAULT_HTTP_HOSTS = 64;
const HARD_HTTP_HOSTS = 256;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MALFORMED_PERCENT = /%(?![0-9a-fA-F]{2})/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function normalizeDoi(input: unknown, options?: ScholarlyScalarOptions): string {
  const limit = scalarLimit(options);
  const value = boundedScalar(input, limit, "identifier.too-long");
  if (CONTROL_OR_BIDI.test(value)) fail("identifier.invalid-doi");
  const trimmed = trimAsciiSpaces(value);
  let candidate: string;
  if (/^https?:\/\//i.test(trimmed)) candidate = doiFromResolver(trimmed);
  else {
    candidate = trimmed.replace(/^doi:/i, "");
    if (MALFORMED_PERCENT.test(candidate) || candidate.includes("?") || candidate.includes("#")) fail("identifier.invalid-doi");
    try { candidate = decodeURIComponent(candidate); }
    catch { return fail("identifier.invalid-doi"); }
  }
  if (CONTROL_OR_BIDI.test(candidate) || /[^\x21-\x7e]/u.test(candidate)) fail("identifier.invalid-doi");
  const match = /^(10\.[0-9]{4,9})\/(.+)$/u.exec(candidate);
  if (!match || Buffer.byteLength(candidate, "utf8") > 512) fail("identifier.invalid-doi");
  return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}

export function canonicalDoiUrl(doi: unknown, options?: ScholarlyScalarOptions): string {
  const normalized = normalizeDoi(doi, options);
  const slash = normalized.indexOf("/");
  const prefix = normalized.slice(0, slash);
  const suffix = normalized.slice(slash + 1);
  return checkedConcat("https://doi.org/", `${encodeURIComponent(prefix)}/${encodeURIComponent(suffix)}`, scalarLimit(options));
}

export function normalizePmid(input: unknown, options?: ScholarlyScalarOptions): string {
  const value = boundedScalar(input, scalarLimit(options), "identifier.too-long");
  if (CONTROL_OR_BIDI.test(value)) fail("identifier.invalid-pmid");
  const match = /^(?:pmid:)?([0-9]{1,12})$/iu.exec(trimAsciiSpaces(value));
  if (!match) fail("identifier.invalid-pmid");
  const normalized = match[1]!.replace(/^0+/u, "");
  if (normalized.length === 0) fail("identifier.invalid-pmid");
  return normalized;
}

export function canonicalPmidUrl(pmid: unknown, options?: ScholarlyScalarOptions): string {
  return checkedConcat("https://pubmed.ncbi.nlm.nih.gov/", `${normalizePmid(pmid, options)}/`, scalarLimit(options));
}

export function normalizePmcid(input: unknown, options?: ScholarlyScalarOptions): string {
  const value = boundedScalar(input, scalarLimit(options), "identifier.too-long");
  if (CONTROL_OR_BIDI.test(value)) fail("identifier.invalid-pmcid");
  const match = /^(?:pmcid:)?pmc([0-9]{1,12})$/iu.exec(trimAsciiSpaces(value));
  if (!match) fail("identifier.invalid-pmcid");
  const digits = match[1]!.replace(/^0+/u, "");
  if (digits.length === 0) fail("identifier.invalid-pmcid");
  return `PMC${digits}`;
}

export function canonicalPmcidUrl(pmcid: unknown, options?: ScholarlyScalarOptions): string {
  return checkedConcat("https://pmc.ncbi.nlm.nih.gov/articles/", `${normalizePmcid(pmcid, options)}/`, scalarLimit(options));
}

export function normalizeCanonicalUrl(
  input: unknown,
  options?: Readonly<{ allowHttp?: boolean; maxCanonicalScalarBytes?: number }>,
): string {
  const normalizedOptions = closedOptions(options, ["allowHttp", "maxCanonicalScalarBytes"]);
  if (normalizedOptions.allowHttp !== undefined && typeof normalizedOptions.allowHttp !== "boolean") fail("identifier.invalid-options");
  const limit = positiveLimit(normalizedOptions.maxCanonicalScalarBytes, DEFAULT_SCALAR_BYTES, HARD_SCALAR_BYTES);
  const value = boundedScalar(input, limit, "url.too-long");
  if (CONTROL_OR_BIDI.test(value) || MALFORMED_PERCENT.test(value)) fail("url.invalid");
  const trimmed = trimAsciiSpaces(value);
  if (/\s/u.test(trimmed)) fail("url.invalid");
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(trimmed)?.[1];
  if (authority && /[^\x00-\x7f]/u.test(authority)) fail("url.invalid");
  let url: URL;
  try { url = new URL(trimmed); }
  catch { return fail("url.invalid"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && normalizedOptions.allowHttp === true)) fail("url.unsupported-scheme");
  if (url.username !== "" || url.password !== "") fail("url.credentials-forbidden");
  if (url.hash !== "") fail("url.fragment-forbidden");
  if (url.hostname.length === 0 || /[^\x00-\x7f]/u.test(url.hostname)) fail("url.invalid");
  return url.href;
}

export function validateProspectiveSourceIdentityFields(
  source: SourceRecord,
  policy?: SourceUrlPolicyContext,
  options?: ProspectiveSourceIdentityOptions,
): SourceRecord {
  const normalizedOptions = closedOptions(options, ["maxCanonicalScalarBytes", "maxSourceRecordCanonicalBytes"]);
  const scalarBytes = positiveLimit(normalizedOptions.maxCanonicalScalarBytes, DEFAULT_SCALAR_BYTES, HARD_SCALAR_BYTES);
  const recordBytes = positiveLimit(normalizedOptions.maxSourceRecordCanonicalBytes, DEFAULT_SOURCE_BYTES, HARD_SOURCE_BYTES);
  const normalizedPolicy = validatePolicy(policy);

  let encoded: string;
  try {
    assertBoundedStructure(source, {
      maxDepth: 64, maxNodes: 100_000, maxKeys: 100_000, maxArrayLength: 100_000,
      maxStringBytes: recordBytes, maxScalarBytes: recordBytes,
    });
    encoded = canonicalJson(source);
  } catch (error) {
    if (error instanceof StructuralLimitError) fail("identifier.record-too-large");
    return fail("identifier.invalid-type");
  }
  if (Buffer.byteLength(encoded, "utf8") > recordBytes) fail("identifier.record-too-large");
  const snapshot = JSON.parse(encoded) as unknown;
  const parsed = parse(SourceRecordSchema, snapshot);
  if (!parsed.success) fail("identifier.invalid-type");
  const record = parsed.value;
  const scalarOptions = { maxCanonicalScalarBytes: scalarBytes };

  if (record.identifiers.doi !== null && normalizeDoi(record.identifiers.doi, scalarOptions) !== record.identifiers.doi)
    fail("identifier.invalid-doi");
  if (record.identifiers.pmid !== null && normalizePmid(record.identifiers.pmid, scalarOptions) !== record.identifiers.pmid)
    fail("identifier.invalid-pmid");
  if (record.identifiers.pmcid !== null && normalizePmcid(record.identifiers.pmcid, scalarOptions) !== record.identifiers.pmcid)
    fail("identifier.invalid-pmcid");

  const canonicalUrl = normalizeCanonicalUrl(record.canonicalUrl, {
    allowHttp: normalizedPolicy.allowHttp,
    maxCanonicalScalarBytes: scalarBytes,
  });
  if (canonicalUrl !== record.canonicalUrl) fail("url.invalid");
  if (canonicalUrl.startsWith("http:")) {
    const url = new URL(canonicalUrl);
    if (url.port !== "" || !normalizedPolicy.approvedHttpHosts.includes(url.hostname)) fail("url.http-host-not-approved");
  }
  return deepFreeze(record);
}

function doiFromResolver(value: string): string {
  if (CONTROL_OR_BIDI.test(value) || MALFORMED_PERCENT.test(value)
    || !/^https:\/\/(?:doi\.org|dx\.doi\.org)\//u.test(value)) fail("identifier.invalid-doi");
  const rawPath = /^https:\/\/[^/?#]+(\/[^?#]*)/u.exec(value)?.[1];
  if (!rawPath || rawPath.split("/").some((part) => /^(?:\.|%2e){1,2}$/iu.test(part))) fail("identifier.invalid-doi");
  let url: URL;
  try { url = new URL(value); }
  catch { return fail("identifier.invalid-doi"); }
  if (url.protocol !== "https:" || (url.hostname !== "doi.org" && url.hostname !== "dx.doi.org")
    || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "")
    fail("identifier.invalid-doi");
  const raw = url.pathname.slice(1);
  const separator = raw.indexOf("/");
  if (separator < 0 || /%2f/iu.test(raw.slice(0, separator))) fail("identifier.invalid-doi");
  try { return decodeURIComponent(raw); }
  catch { return fail("identifier.invalid-doi"); }
}

function scalarLimit(options?: ScholarlyScalarOptions): number {
  const normalized = closedOptions(options, ["maxCanonicalScalarBytes"]);
  return positiveLimit(normalized.maxCanonicalScalarBytes, DEFAULT_SCALAR_BYTES, HARD_SCALAR_BYTES);
}

function boundedScalar(input: unknown, limit: number, tooLong: "identifier.too-long" | "url.too-long"): string {
  if (typeof input !== "string") fail("identifier.invalid-type");
  let encoded: string;
  try { encoded = canonicalJson(input); }
  catch { return fail("identifier.invalid-type"); }
  if (Buffer.byteLength(encoded, "utf8") > limit) fail(tooLong);
  return input;
}

function closedOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  try {
    assertBoundedStructure(value, { maxDepth: 3, maxNodes: 1_000, maxKeys: 1_000, maxArrayLength: 300, maxStringBytes: 1_024, maxScalarBytes: 300_000 });
    const snapshot = JSON.parse(canonicalJson(value)) as unknown;
    if (!isPlainRecord(snapshot) || Object.keys(snapshot).some((key) => !allowed.includes(key))) fail("identifier.invalid-options");
    return snapshot;
  } catch (error) {
    if (error instanceof ScholarlyIdentifierError) throw error;
    return fail("identifier.invalid-options");
  }
}

function validatePolicy(policy: SourceUrlPolicyContext | undefined): { allowHttp: boolean; approvedHttpHosts: readonly string[] } {
  const normalized = closedOptions(policy, ["allowHttp", "approvedHttpHosts", "accessPolicySha256", "maxApprovedHttpHosts"]);
  const allowHttp = normalized.allowHttp ?? false;
  if (typeof allowHttp !== "boolean") fail("url.http-context-invalid");
  const hasHttpFields = normalized.approvedHttpHosts !== undefined || normalized.accessPolicySha256 !== undefined
    || normalized.maxApprovedHttpHosts !== undefined;
  if (!allowHttp) {
    if (hasHttpFields) fail("url.http-context-invalid");
    return { allowHttp: false, approvedHttpHosts: Object.freeze([]) };
  }
  const maxHosts = positiveLimit(normalized.maxApprovedHttpHosts, DEFAULT_HTTP_HOSTS, HARD_HTTP_HOSTS);
  if (!Array.isArray(normalized.approvedHttpHosts) || normalized.approvedHttpHosts.length === 0) fail("url.http-context-invalid");
  if (normalized.approvedHttpHosts.length > maxHosts) fail("identifier.invalid-options");
  if (typeof normalized.accessPolicySha256 !== "string" || !SHA256.test(normalized.accessPolicySha256)) fail("url.http-context-invalid");
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const host of normalized.approvedHttpHosts) {
    if (typeof host !== "string") fail("url.http-context-invalid");
    if (Buffer.byteLength(host, "utf8") > 253) fail("identifier.invalid-options");
    if (!validApprovedHost(host) || seen.has(host)) fail("url.http-context-invalid");
    seen.add(host); hosts.push(host);
  }
  return { allowHttp: true, approvedHttpHosts: Object.freeze(hosts) };
}

function validApprovedHost(host: string): boolean {
  if (host.length === 0 || host !== host.toLowerCase() || /[^a-z0-9.-]/u.test(host) || host.includes("*")
    || host.startsWith(".") || host.endsWith(".") || host.includes("..") || isIP(host) !== 0) return false;
  try { return new URL(`http://${host}/`).hostname === host; }
  catch { return false; }
}

function positiveLimit(value: unknown, fallback: number, hard: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > hard) fail("identifier.invalid-options");
  return candidate as number;
}

function trimAsciiSpaces(value: string): string { return value.replace(/^ +| +$/gu, ""); }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function checkedConcat(prefix: string, suffix: string, limit: number): string {
  const bytes = 2 + Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  if (!Number.isSafeInteger(bytes) || bytes > limit) fail("identifier.too-long");
  return prefix + suffix;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function fail(code: ScholarlyIdentifierErrorCode): never { throw new ScholarlyIdentifierError(code); }
