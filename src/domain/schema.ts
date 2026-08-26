import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export interface ValidationIssue {
  path: string;
  code: string;
}

export type ParseResult<T> =
  | { success: true; value: T }
  | { success: false; issues: ValidationIssue[] };

type Refinement = (value: unknown) => ValidationIssue[];
const refinements = new WeakMap<object, Refinement>();

export function registerRefinement(schema: TSchema, refinement: Refinement): void {
  refinements.set(schema, refinement);
}

export function parse<S extends TSchema>(schema: S, value: unknown): ParseResult<Static<S>> {
  const issues: ValidationIssue[] = [];
  for (const rawError of Value.Errors(schema, value)) {
    const error = rawError as unknown as {
      keyword: string;
      instancePath: string;
      params?: { requiredProperties?: string[]; additionalProperties?: string[] };
    };
    const base = error.instancePath || "";
    const properties = error.keyword === "required"
      ? error.params?.requiredProperties
      : error.keyword === "additionalProperties"
        ? error.params?.additionalProperties
        : undefined;
    if (properties?.length) {
      issues.push(...properties.map((property) => ({ path: `${base}/${escapePointer(property)}`, code: `schema.${error.keyword}` })));
    } else {
      issues.push({ path: base || "/", code: `schema.${error.keyword}` });
    }
  }
  if (issues.length === 0) collectRefinementIssues(schema, value, "", issues);
  const uniqueIssues = deduplicateIssues(issues);
  return uniqueIssues.length === 0
    ? { success: true, value: value as Static<S> }
    : { success: false, issues: uniqueIssues };
}

export function issue(path: string, code: string): ValidationIssue {
  return { path, code };
}

function collectRefinementIssues(schema: TSchema, value: unknown, basePath: string, issues: ValidationIssue[]): void {
  for (const refinementIssue of refinements.get(schema)?.(value) ?? []) {
    issues.push({
      path: prefixPath(basePath, refinementIssue.path),
      code: refinementIssue.code,
    });
  }

  const traversable = schema as TSchema & {
    type?: string;
    properties?: Record<string, TSchema>;
    items?: TSchema;
    anyOf?: TSchema[];
    allOf?: TSchema[];
  };
  if (traversable.type === "object" && traversable.properties && isObject(value)) {
    for (const [property, propertySchema] of Object.entries(traversable.properties)) {
      if (Object.hasOwn(value, property)) collectRefinementIssues(propertySchema, value[property], `${basePath}/${escapePointer(property)}`, issues);
    }
  } else if (traversable.type === "array" && traversable.items && Array.isArray(value)) {
    value.forEach((item, index) => collectRefinementIssues(traversable.items!, item, `${basePath}/${index}`, issues));
  }

  const matchingUnion = traversable.anyOf?.find((candidate) => Value.Check(candidate, value));
  if (matchingUnion) collectRefinementIssues(matchingUnion, value, basePath, issues);
  for (const member of traversable.allOf ?? []) collectRefinementIssues(member, value, basePath, issues);
}

function prefixPath(basePath: string, childPath: string): string {
  if (basePath === "") return childPath;
  if (childPath === "/") return basePath;
  return `${basePath}${childPath}`;
}

function deduplicateIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter(({ path, code }) => {
    const key = `${path}\u0000${code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
