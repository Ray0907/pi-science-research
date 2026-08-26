import { types as utilTypes } from "node:util";

export interface StructuralLimits {
  maxDepth: number;
  maxNodes: number;
  maxKeys: number;
  maxArrayLength: number;
  maxStringBytes: number;
  maxScalarBytes: number;
}

export class StructuralLimitError extends Error {
  readonly reason: "unsafe" | "limit";
  constructor(reason: "unsafe" | "limit" = "limit") {
    super("Untrusted value exceeds structural limits");
    this.name = "StructuralLimitError";
    this.reason = reason;
  }
}

/** Validates shape and scalar budgets without invoking user code or copying scalar values. */
export function assertBoundedStructure(value: unknown, limits: StructuralLimits): void {
  const descriptorCache = new WeakMap<object, PropertyDescriptorMap>();
  const active = new WeakSet<object>();
  let nodes = 0;
  let keys = 0;
  let scalarBytes = 0;
  const addBytes = (bytes: number) => {
    scalarBytes += bytes;
    if (bytes > limits.maxStringBytes || scalarBytes > limits.maxScalarBytes) throw new StructuralLimitError("limit");
  };
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) throw new StructuralLimitError("limit");
    if (typeof current === "string") { addBytes(Buffer.byteLength(current)); return; }
    if (current === null || typeof current === "boolean") { scalarBytes += 1; return; }
    if (typeof current === "number") { scalarBytes += 8; return; }
    if (typeof current !== "object" || utilTypes.isProxy(current)) throw new StructuralLimitError("unsafe");
    if (active.has(current)) throw new StructuralLimitError("unsafe");
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) throw new StructuralLimitError("unsafe");
    let descriptors = descriptorCache.get(current);
    if (!descriptors) { descriptors = Object.getOwnPropertyDescriptors(current); descriptorCache.set(current, descriptors); }
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === "symbol")) throw new StructuralLimitError("unsafe");
    const arrayValue = current as unknown[];
    if (array && arrayValue.length > limits.maxArrayLength) throw new StructuralLimitError("limit");
    active.add(current);
    try {
      for (const key of ownKeys as string[]) {
        if (array && key === "length") continue;
        keys += 1;
        if (keys > limits.maxKeys) throw new StructuralLimitError("limit");
        addBytes(Buffer.byteLength(key));
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || !descriptor.enumerable) throw new StructuralLimitError("unsafe");
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= arrayValue.length)) throw new StructuralLimitError("unsafe");
        visit(descriptor.value, depth + 1);
      }
      if (array && ownKeys.length !== arrayValue.length + 1) throw new StructuralLimitError("unsafe");
    } finally { active.delete(current); }
    if (scalarBytes > limits.maxScalarBytes) throw new StructuralLimitError("limit");
  };
  visit(value, 0);
}
