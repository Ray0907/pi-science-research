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
  return normalizeDoiWithLimit(input, scalarLimit(options));
}

export function canonicalDoiUrl(doi: unknown, options?: ScholarlyScalarOptions): string {
  const limit = scalarLimit(options);
  const normalized = normalizeDoiWithLimit(doi, limit);
  const slash = normalized.indexOf("/");
  const encodedPrefixBytes = percentEncodedComponentBytes(normalized, 0, slash);
  const encodedSuffixBytes = percentEncodedComponentBytes(normalized, slash + 1, normalized.length);
  assertResolverOutputBound(limit, Buffer.byteLength("https://doi.org/", "utf8"), encodedPrefixBytes, 1, encodedSuffixBytes);
  return `https://doi.org/${encodeURIComponent(normalized.slice(0, slash))}/${encodeURIComponent(normalized.slice(slash + 1))}`;
}

export function normalizePmid(input: unknown, options?: ScholarlyScalarOptions): string {
  return normalizePmidWithLimit(input, scalarLimit(options));
}

export function canonicalPmidUrl(pmid: unknown, options?: ScholarlyScalarOptions): string {
  const limit = scalarLimit(options);
  const normalized = normalizePmidWithLimit(pmid, limit);
  assertResolverOutputBound(limit, Buffer.byteLength("https://pubmed.ncbi.nlm.nih.gov/", "utf8"), normalized.length, 1);
  return `https://pubmed.ncbi.nlm.nih.gov/${normalized}/`;
}

export function normalizePmcid(input: unknown, options?: ScholarlyScalarOptions): string {
  return normalizePmcidWithLimit(input, scalarLimit(options));
}

export function canonicalPmcidUrl(pmcid: unknown, options?: ScholarlyScalarOptions): string {
  const limit = scalarLimit(options);
  const normalized = normalizePmcidWithLimit(pmcid, limit);
  assertResolverOutputBound(limit, Buffer.byteLength("https://pmc.ncbi.nlm.nih.gov/articles/", "utf8"), normalized.length, 1);
  return `https://pmc.ncbi.nlm.nih.gov/articles/${normalized}/`;
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
  const raw = preflightAbsoluteUrl(trimmed);
  if (raw.scheme !== "https" && !(raw.scheme === "http" && normalizedOptions.allowHttp === true)) fail("url.unsupported-scheme");
  let url: URL;
  try { url = new URL(trimmed); }
  catch { return fail("url.invalid"); }
  if (url.protocol !== `${raw.scheme}:`) fail("url.invalid");
  if (url.username !== "" || url.password !== "") fail("url.credentials-forbidden");
  if (url.hash !== "" || raw.hasFragmentDelimiter) fail("url.fragment-forbidden");
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

function normalizeDoiWithLimit(input: unknown, limit: number): string {
  const value = boundedScalar(input, limit, "identifier.too-long");
  if (CONTROL_OR_BIDI.test(value) || value.includes("\\")) fail("identifier.invalid-doi");
  const trimmed = trimAsciiSpaces(value);
  const encodedCandidate = /^https?:\/\//i.test(trimmed)
    ? doiFromResolver(trimmed)
    : trimmed.replace(/^doi:/i, "");
  if (MALFORMED_PERCENT.test(encodedCandidate) || encodedCandidate.includes("?") || encodedCandidate.includes("#"))
    fail("identifier.invalid-doi");
  let candidate: string;
  try { candidate = decodeURIComponent(encodedCandidate); }
  catch { return fail("identifier.invalid-doi"); }
  if (CONTROL_OR_BIDI.test(candidate) || candidate.includes("\\") || /[^\x21-\x7e]/u.test(candidate)) fail("identifier.invalid-doi");
  const match = /^(10\.[0-9]{4,9})\/(.+)$/u.exec(candidate);
  if (!match) fail("identifier.invalid-doi");
  const canonicalPrefix = match[1]!.toLowerCase();
  const canonicalSuffix = match[2]!.replaceAll("%", "%25").toLowerCase();
  const canonicalDoi = `${canonicalPrefix}/${canonicalSuffix}`;
  if (Buffer.byteLength(canonicalJson(canonicalDoi), "utf8") > 512) fail("identifier.invalid-doi");
  return canonicalDoi;
}

function normalizePmidWithLimit(input: unknown, limit: number): string {
  const value = boundedScalar(input, limit, "identifier.too-long");
  if (CONTROL_OR_BIDI.test(value)) fail("identifier.invalid-pmid");
  const match = /^(?:pmid:)?([0-9]{1,12})$/iu.exec(trimAsciiSpaces(value));
  if (!match) fail("identifier.invalid-pmid");
  const normalized = match[1]!.replace(/^0+/u, "");
  if (normalized.length === 0) fail("identifier.invalid-pmid");
  return normalized;
}

function normalizePmcidWithLimit(input: unknown, limit: number): string {
  const value = boundedScalar(input, limit, "identifier.too-long");
  if (CONTROL_OR_BIDI.test(value)) fail("identifier.invalid-pmcid");
  const match = /^(?:pmcid:)?pmc([0-9]{1,12})$/iu.exec(trimAsciiSpaces(value));
  if (!match) fail("identifier.invalid-pmcid");
  const digits = match[1]!.replace(/^0+/u, "");
  if (digits.length === 0) fail("identifier.invalid-pmcid");
  return `PMC${digits}`;
}

function preflightAbsoluteUrl(value: string): { scheme: string; hasFragmentDelimiter: boolean } {
  if (/\s|\\/u.test(value)) fail("url.invalid");
  const schemePrefix = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value);
  if (!schemePrefix) fail("url.invalid");
  const normalizedScheme = schemePrefix[1]!.toLowerCase();
  if (normalizedScheme !== "http" && normalizedScheme !== "https")
    return { scheme: normalizedScheme, hasFragmentDelimiter: value.includes("#") };
  const absolute = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value);
  if (!absolute) fail("url.invalid");
  const authorityStart = absolute[0].length;
  let authorityEnd = value.length;
  for (const delimiter of ["/", "?", "#"] as const) {
    const index = value.indexOf(delimiter, authorityStart);
    if (index >= 0 && index < authorityEnd) authorityEnd = index;
  }
  if (authorityEnd === authorityStart) fail("url.invalid");
  const authority = value.slice(authorityStart, authorityEnd);
  if (authority.includes("@")) fail("url.credentials-forbidden");
  if (/[^\x00-\x7f]/u.test(authority) || authority.includes("%") || !hasValidRawHostPort(authority)) fail("url.invalid");
  return { scheme: normalizedScheme, hasFragmentDelimiter: value.includes("#") };
}

function hasValidRawHostPort(authority: string): boolean {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close <= 1) return false;
    const remainder = authority.slice(close + 1);
    return remainder === "" || /^:[0-9]+$/u.test(remainder);
  }
  const firstColon = authority.indexOf(":");
  if (firstColon < 0) return authority.length > 0;
  if (firstColon !== authority.lastIndexOf(":")) return false;
  return firstColon > 0 && /^:[0-9]+$/u.test(authority.slice(firstColon));
}

function doiFromResolver(value: string): string {
  if (CONTROL_OR_BIDI.test(value) || value.includes("\\") || MALFORMED_PERCENT.test(value) || value.includes("?") || value.includes("#")
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
function percentEncodedComponentBytes(value: string, start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end;) {
    const point = value.codePointAt(index);
    if (point === undefined) fail("identifier.invalid-doi");
    const width = point > 0xffff ? 2 : 1;
    const utf8Bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    const unescaped = point <= 0x7f && /[A-Za-z0-9_.!~*'()-]/u.test(String.fromCharCode(point));
    total = checkedAdd(total, unescaped ? 1 : checkedMultiply(utf8Bytes, 3));
    index += width;
  }
  return total;
}
function assertResolverOutputBound(limit: number, ...contentParts: readonly number[]): void {
  let canonicalBytes = 2;
  for (const part of contentParts) canonicalBytes = checkedAdd(canonicalBytes, part);
  if (canonicalBytes > limit) fail("identifier.too-long");
}
function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(result))
    fail("identifier.too-long");
  return result;
}
function checkedMultiply(value: number, multiplier: number): number {
  const result = value * multiplier;
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(multiplier) || value < 0 || multiplier < 0 || !Number.isSafeInteger(result))
    fail("identifier.too-long");
  return result;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function fail(code: ScholarlyIdentifierErrorCode): never { throw new ScholarlyIdentifierError(code); }
