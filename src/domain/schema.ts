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
  const issues = deduplicateIssues(evaluateSchema(schema, value, ""));
  return issues.length === 0
    ? { success: true, value: value as Static<S> }
    : { success: false, issues };
}

export function issue(path: string, code: string): ValidationIssue {
  return { path, code };
}

interface TraversableSchema extends TSchema {
  type?: string;
  properties?: Record<string, TSchema>;
  items?: TSchema;
  anyOf?: TSchema[];
  allOf?: TSchema[];
}

function evaluateSchema(schema: TSchema, value: unknown, basePath: string): ValidationIssue[] {
  const traversable = schema as TraversableSchema;
  if (traversable.anyOf) {
    const branchResults = traversable.anyOf.map((branch) => deduplicateIssues(evaluateSchema(branch, value, basePath)));
    if (branchResults.some((branchIssues) => branchIssues.length === 0)) return refinementIssues(schema, value, basePath);
    return [...branchResults].sort(compareIssueSets)[0] ?? [];
  }
  if (traversable.allOf) {
    const branchIssues = traversable.allOf.flatMap((branch) => evaluateSchema(branch, value, basePath));
    return branchIssues.length === 0
      ? refinementIssues(schema, value, basePath)
      : branchIssues;
  }
  if (traversable.type === "object" && traversable.properties) {
    const shallow = { ...schema, properties: Object.fromEntries(Object.keys(traversable.properties).map((key) => [key, {}])) } as TSchema;
    const ownStructuralIssues = structuralIssues(shallow, value, basePath);
    if (ownStructuralIssues.length > 0) return ownStructuralIssues;
    const childIssues: ValidationIssue[] = [];
    const record = value as Record<string, unknown>;
    for (const [property, propertySchema] of Object.entries(traversable.properties)) {
      if (Object.hasOwn(record, property)) childIssues.push(...evaluateSchema(propertySchema, record[property], `${basePath}/${escapePointer(property)}`));
    }
    return childIssues.length === 0
      ? refinementIssues(schema, value, basePath)
      : childIssues;
  }
  if (traversable.type === "array" && traversable.items) {
    const shallow = { ...schema, items: {} } as TSchema;
    const ownStructuralIssues = structuralIssues(shallow, value, basePath);
    if (ownStructuralIssues.length > 0) return ownStructuralIssues;
    const childIssues = (value as unknown[]).flatMap((item, index) => evaluateSchema(traversable.items!, item, `${basePath}/${index}`));
    return childIssues.length === 0
      ? refinementIssues(schema, value, basePath)
      : childIssues;
  }
  const ownStructuralIssues = structuralIssues(schema, value, basePath);
  return ownStructuralIssues.length === 0
    ? refinementIssues(schema, value, basePath)
    : ownStructuralIssues;
}

function structuralIssues(schema: TSchema, value: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const rawError of Value.Errors(schema, value)) {
    const error = rawError as unknown as {
      keyword: string;
      instancePath: string;
      params?: { requiredProperties?: string[]; additionalProperties?: string[] };
    };
    const instancePath = `${basePath}${error.instancePath || ""}`;
    const properties = error.keyword === "required"
      ? error.params?.requiredProperties
      : error.keyword === "additionalProperties"
        ? error.params?.additionalProperties
        : undefined;
    if (properties?.length) issues.push(...properties.map((property) => issue(`${instancePath}/${escapePointer(property)}`, `schema.${error.keyword}`)));
    else issues.push(issue(instancePath || "/", `schema.${error.keyword}`));
  }
  return issues;
}

function refinementIssues(schema: TSchema, value: unknown, basePath: string): ValidationIssue[] {
  return (refinements.get(schema)?.(value) ?? []).map((refinementIssue) => ({
    path: prefixPath(basePath, refinementIssue.path),
    code: refinementIssue.code,
  }));
}

function compareIssueSets(left: ValidationIssue[], right: ValidationIssue[]): number {
  if (left.length !== right.length) return left.length - right.length;
  const typeDifference = countCode(left, "schema.type") - countCode(right, "schema.type");
  if (typeDifference !== 0) return typeDifference;
  const specificityDifference = right.reduce((total, item) => total + item.path.length, 0) - left.reduce((total, item) => total + item.path.length, 0);
  if (specificityDifference !== 0) return specificityDifference;
  return issueSetSignature(left).localeCompare(issueSetSignature(right));
}

function countCode(issues: ValidationIssue[], code: string): number {
  return issues.reduce((count, item) => count + Number(item.code === code), 0);
}

function issueSetSignature(issues: ValidationIssue[]): string {
  return JSON.stringify([...issues].sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)));
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

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
