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
  if (issues.length === 0) issues.push(...(refinements.get(schema)?.(value) ?? []));
  return issues.length === 0
    ? { success: true, value: value as Static<S> }
    : { success: false, issues };
}

export function issue(path: string, code: string): ValidationIssue {
  return { path, code };
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
