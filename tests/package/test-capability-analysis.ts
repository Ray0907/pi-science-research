import ts from "typescript";

export const Capability = {
  globalRoot: 1 << 0,
  processRoot: 1 << 1,
  network: 1 << 2,
  child: 1 << 3,
  fixture: 1 << 4,
  processObject: 1 << 5,
} as const;
export const ALL_CAPABILITY_FLAGS = Capability.globalRoot | Capability.processRoot | Capability.network | Capability.child | Capability.fixture | Capability.processObject;

export interface AbstractValue {
  readonly flags: number;
  readonly strings: ReadonlySet<string>;
  readonly unknownString: boolean;
  readonly properties: ReadonlyMap<string, AbstractValue>;
  readonly unknownProperty: AbstractValue | null;
}

export interface AnalysisOperation {
  readonly pattern: ts.Node;
  readonly source: ts.Expression;
  readonly node: ts.Node;
}

export interface CapabilityAnalysis {
  readonly file: ts.SourceFile;
  readonly bindings: ReadonlyMap<string, AbstractValue>;
  readonly operations: readonly AnalysisOperation[];
  value(expression: ts.Expression): AbstractValue;
  contains(value: AbstractValue, flag: number): boolean;
  location(node: ts.Node, category: string): string;
}

const EMPTY: AbstractValue = Object.freeze({
  flags: 0,
  strings: Object.freeze(new Set<string>()),
  unknownString: false,
  properties: Object.freeze(new Map<string, AbstractValue>()),
  unknownProperty: null,
});
const MAX_DEPTH = 8;
const MAX_NODES = 4_096;
const MAX_PASSES = 64;
const MAX_STRINGS = 32;
const ALL_CAPABILITIES = ALL_CAPABILITY_FLAGS;
const TOP_LEAF: AbstractValue = Object.freeze({flags: ALL_CAPABILITIES, strings: Object.freeze(new Set<string>()), unknownString: true, properties: Object.freeze(new Map<string, AbstractValue>()), unknownProperty: null});
const TOP: AbstractValue = Object.freeze({flags: ALL_CAPABILITIES, strings: Object.freeze(new Set<string>()), unknownString: true, properties: Object.freeze(new Map<string, AbstractValue>()), unknownProperty: TOP_LEAF});

export function isFullyErasedTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((item) => item.isTypeOnly);
}

export function isFullyErasedTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  return !!node.exportClause && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((item) => item.isTypeOnly);
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value)
    || ts.isAsExpression(value)
    || ts.isNonNullExpression(value)
    || ts.isTypeAssertionExpression(value)
    || ts.isSatisfiesExpression(value)
  ) value = value.expression;
  return value;
}

function valueOf(
  flags = 0,
  strings: Iterable<string> = [],
  unknownString = false,
  properties: ReadonlyMap<string, AbstractValue> = new Map(),
  unknownProperty: AbstractValue | null = null,
): AbstractValue {
  return {flags, strings: new Set(strings), unknownString, properties: new Map(properties), unknownProperty};
}

function sameValue(left: AbstractValue, right: AbstractValue): boolean {
  if (left.flags !== right.flags || left.unknownString !== right.unknownString || left.strings.size !== right.strings.size || left.properties.size !== right.properties.size) return false;
  for (const item of left.strings) if (!right.strings.has(item)) return false;
  for (const [key, item] of left.properties) {
    const other = right.properties.get(key);
    if (!other || !sameValue(item, other)) return false;
  }
  if (left.unknownProperty === null || right.unknownProperty === null) return left.unknownProperty === right.unknownProperty;
  return sameValue(left.unknownProperty, right.unknownProperty);
}

function join(left: AbstractValue, right: AbstractValue, depth = 0): AbstractValue {
  if ((left.flags === ALL_CAPABILITIES && left.unknownString) || (right.flags === ALL_CAPABILITIES && right.unknownString)) return TOP;
  if (sameValue(left, right)) return left;
  if (depth >= MAX_DEPTH) return TOP;
  const strings = new Set(left.strings);
  let unknownString = left.unknownString || right.unknownString;
  for (const item of right.strings) {
    if (strings.size >= MAX_STRINGS) return TOP;
    strings.add(item);
  }
  const properties = new Map(left.properties);
  for (const [key, item] of right.properties) properties.set(key, join(properties.get(key) ?? EMPTY, item, depth + 1));
  const unknownProperty = left.unknownProperty === null ? right.unknownProperty
    : right.unknownProperty === null ? left.unknownProperty
      : join(left.unknownProperty, right.unknownProperty, depth + 1);
  return valueOf(left.flags | right.flags, strings, unknownString, properties, unknownProperty);
}

function moduleKind(specifier: string): "network" | "child" | "fixture" | "safe" {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const network = ["http", "https", "http2", "net", "tls", "dns", "dns/promises", "dgram", "undici", "node-fetch", "cross-fetch", "ws", "axios", "got", "superagent", "openai", "@aws-sdk", "proxy-agent", "http-proxy-agent", "https-proxy-agent", "socks-proxy-agent"];
  if (network.some((name) => bare === name || bare.startsWith(`${name}/`))) return "network";
  if (["child_process", "worker_threads", "cluster", "module"].some((name) => bare === name || bare.startsWith(`${name}/`))) return "child";
  if (/\/(?:acquisition\/)?contracts\.(?:js|ts)$/u.test(specifier)) return "fixture";
  return "safe";
}

function moduleValue(specifier: string): AbstractValue {
  const kind = moduleKind(specifier);
  if (kind === "network") return valueOf(Capability.network, [], false, new Map(), valueOf(Capability.network));
  if (kind === "child") return valueOf(Capability.child, [], false, new Map(), valueOf(Capability.child));
  if (kind === "fixture") return valueOf(0, [], false, new Map([["createProviderRequestPartitionFixtureInternal", valueOf(Capability.fixture)]]));
  return EMPTY;
}

function staticPropertyName(name: ts.PropertyName, evaluate: (expression: ts.Expression) => AbstractValue): {values: readonly string[]; unknown: boolean} {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return {values: [name.text], unknown: false};
  if (ts.isComputedPropertyName(name)) {
    const value = evaluate(name.expression);
    return {values: [...value.strings], unknown: value.unknownString || value.strings.size === 0};
  }
  return {values: [], unknown: true};
}

export function createCapabilityAnalysis(source: string, relative: string): CapabilityAnalysis {
  const kind = relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, kind);
  const bindings = new Map<string, AbstractValue>();
  const operations: AnalysisOperation[] = [];
  const functionDeclarations = new Map<string, ts.FunctionDeclaration>();

  const seedImport = (node: ts.ImportDeclaration): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier) || isFullyErasedTypeOnlyImport(node)) return;
    const module = moduleValue(node.moduleSpecifier.text);
    const clause = node.importClause;
    if (clause?.name) bindings.set(clause.name.text, join(bindings.get(clause.name.text) ?? EMPTY, module));
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, join(bindings.get(named.name.text) ?? EMPTY, module));
    if (named && ts.isNamedImports(named)) for (const item of named.elements) {
      if (item.isTypeOnly) continue;
      const imported = (item.propertyName ?? item.name).text;
      const extracted = module.properties.get(imported) ?? module.unknownProperty ?? module;
      bindings.set(item.name.text, join(bindings.get(item.name.text) ?? EMPTY, extracted));
    }
  };
  for (const statement of file.statements) if (ts.isImportDeclaration(statement)) seedImport(statement);

  const seedPatternNames = (pattern: ts.Node): void => {if (ts.isIdentifier(pattern)) {if (!bindings.has(pattern.text)) bindings.set(pattern.text, EMPTY); return;} ts.forEachChild(pattern, seedPatternNames);};
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functionDeclarations.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) seedPatternNames(node.name);
    if (ts.isVariableDeclaration(node) && node.initializer) operations.push({pattern: node.name, source: node.initializer, node});
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) operations.push({pattern: unwrapExpression(node.left as ts.Expression), source: node.right, node});
    ts.forEachChild(node, collect);
  };
  collect(file);

  let evaluate: (expression: ts.Expression, depth?: number) => AbstractValue;
  const evaluateDescendants = (node: ts.Node, depth: number): AbstractValue => {
    let result = EMPTY;
    const visit = (child: ts.Node): void => {
      if (ts.isExpression(child)) { result = join(result, evaluate(child, depth + 1), depth + 1); return; }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return result;
  };
  const evaluateExpressionList = (expressions: readonly ts.Expression[], depth: number): AbstractValue => {
    let result = EMPTY;
    for (const expression of expressions) result = join(result, evaluate(expression, depth + 1), depth + 1);
    return result;
  };
  const evaluateFunctionResult = (node: ts.FunctionLikeDeclaration, depth: number): AbstractValue => {
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return evaluate(node.body, depth + 1);
    let result = EMPTY;
    if (node.body) { const visit = (child: ts.Node): void => { if (ts.isFunctionLike(child) && child !== node) return; if (ts.isReturnStatement(child) && child.expression) { result = join(result, evaluate(child.expression, depth + 1), depth + 1); return; } ts.forEachChild(child, visit); }; ts.forEachChild(node.body, visit); }
    return result;
  };
  const derivedUnknown = (value: AbstractValue): AbstractValue => valueOf(value.flags, [], true, new Map(), value.flags === 0 ? EMPTY : valueOf(value.flags));

  evaluate = (expression: ts.Expression, depth = 0): AbstractValue => {
    if (depth >= MAX_DEPTH) return TOP;
    if (depth === 0) { let nodes = 0, exceeded = false; const stack: Array<readonly [ts.Node, number]> = [[expression, 0]]; while (stack.length > 0 && !exceeded) { const [node, nodeDepth] = stack.pop()!; if (!Number.isSafeInteger(nodes) || nodes >= MAX_NODES || nodeDepth >= MAX_DEPTH) { exceeded = true; break; } nodes += 1; ts.forEachChild(node, child => { stack.push([child, nodeDepth + 1]); }); } if (exceeded) return TOP; }
    const value = unwrapExpression(expression);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return valueOf(0, [value.text]);
    if (ts.isNumericLiteral(value)) return valueOf(0, [value.text]);
    if (ts.isIdentifier(value)) {
      if (value.text === "globalThis" || value.text === "global") return valueOf(Capability.globalRoot);
      if (value.text === "process") return valueOf(Capability.processRoot | Capability.processObject);
      if (value.text === "module") return bindings.has(value.text) ? bindings.get(value.text)! : valueOf(Capability.child);
      if (value.text === "fetch" || value.text === "WebSocket") return bindings.has(value.text) ? bindings.get(value.text)! : valueOf(Capability.network);
      if (value.text === "require" || value.text === "getBuiltinModule" || value.text === "createRequire") return valueOf(Capability.child);
      if (value.text === "Worker") return bindings.has(value.text) ? bindings.get(value.text)! : valueOf(Capability.child);
      if (["setTimeout", "setInterval"].includes(value.text)) return valueOf(Capability.processRoot);
      const declaration = functionDeclarations.get(value.text);
      if (declaration?.body) return derivedUnknown(evaluateFunctionResult(declaration, depth + 1));
      return bindings.get(value.text) ?? EMPTY;
    }
    if (ts.isConditionalExpression(value)) return join(evaluate(value.condition, depth + 1), join(evaluate(value.whenTrue, depth + 1), evaluate(value.whenFalse, depth + 1), depth + 1), depth + 1);
    if (ts.isBinaryExpression(value) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(value.operatorToken.kind)) return join(evaluate(value.left, depth + 1), evaluate(value.right, depth + 1), depth + 1);
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(value.left, depth + 1), right = evaluate(value.right, depth + 1), strings: string[] = [];
      let unknown = left.unknownString || right.unknownString;
      for (const a of left.strings) for (const b of right.strings) {
        if (strings.length >= MAX_STRINGS) { unknown = true; break; }
        strings.push(a + b);
      }
      return valueOf(left.flags | right.flags, strings, unknown || strings.length === 0, new Map(), join(left.unknownProperty ?? EMPTY, right.unknownProperty ?? EMPTY));
    }
    if (ts.isTemplateExpression(value)) {
      let result = valueOf(0, [value.head.text]);
      for (const span of value.templateSpans) {
        const part = evaluate(span.expression, depth + 1), strings: string[] = [];
        let unknown = result.unknownString || part.unknownString;
        for (const a of result.strings) for (const b of part.strings) {
          if (strings.length >= MAX_STRINGS) { unknown = true; break; }
          strings.push(a + b + span.literal.text);
        }
        result = valueOf(result.flags | part.flags, strings, unknown || strings.length === 0);
      }
      return result;
    }
    if (ts.isObjectLiteralExpression(value)) {
      const properties = new Map<string, AbstractValue>();
      let unknownProperty: AbstractValue | null = null, flags = 0;
      for (const property of value.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, depth + 1); flags |= spread.flags;
          for (const [key, item] of spread.properties) properties.set(key, join(properties.get(key) ?? EMPTY, item));
          unknownProperty = join(unknownProperty ?? EMPTY, spread.unknownProperty ?? spread);
          continue;
        }
        if (ts.isPropertyAssignment(property)) {
          const key = staticPropertyName(property.name, (item) => evaluate(item, depth + 1)), item = evaluate(property.initializer, depth + 1); flags |= item.flags;
          for (const name of key.values) properties.set(name, join(properties.get(name) ?? EMPTY, item));
          if (key.unknown) unknownProperty = join(unknownProperty ?? EMPTY, item);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const item = evaluate(property.name, depth + 1); flags |= item.flags; properties.set(property.name.text, join(properties.get(property.name.text) ?? EMPTY, item));
        } else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          const key = staticPropertyName(property.name, (item) => evaluate(item, depth + 1));
          for (const name of key.values) properties.set(name, EMPTY);
          if (key.unknown) unknownProperty = join(unknownProperty ?? EMPTY, EMPTY);
        }
      }
      return valueOf(flags, [], false, properties, unknownProperty);
    }
    if (ts.isArrayLiteralExpression(value)) {
      const properties = new Map<string, AbstractValue>(); let flags = 0, unknownProperty: AbstractValue | null = null;
      value.elements.forEach((item, index) => {if (ts.isSpreadElement(item)) {const spread = evaluate(item.expression, depth + 1); flags |= spread.flags; unknownProperty = join(unknownProperty ?? EMPTY, spread);} else {const entry = evaluate(item, depth + 1); flags |= entry.flags; properties.set(String(index), entry);}});
      return valueOf(flags, [], false, properties, unknownProperty);
    }
    const extract = (base: AbstractValue, keys: readonly string[], unknownKey: boolean): AbstractValue => {
      let result = EMPTY;
      for (const key of keys) {
        result = join(result, base.properties.get(key) ?? base.unknownProperty ?? EMPTY);
        if ((base.flags & Capability.globalRoot) !== 0) {
          if (key === "fetch" || key === "WebSocket") result = join(result, valueOf(Capability.network));
          if (key === "process") result = join(result, valueOf(Capability.processRoot | Capability.processObject));
          if (key === "module") result = join(result, valueOf(Capability.child));
        }
        if ((base.flags & Capability.processRoot) !== 0 && key === "getBuiltinModule") result = join(result, valueOf(Capability.child));
        if ((base.flags & (Capability.network | Capability.child | Capability.fixture)) !== 0) result = join(result, valueOf(base.flags & (Capability.network | Capability.child | Capability.fixture)));
        if (["call", "bind", "apply"].includes(key) && (base.flags & (Capability.network | Capability.child | Capability.fixture)) !== 0) result = join(result, valueOf(base.flags));
      }
      if (unknownKey) {
        result = join(result, base.unknownProperty ?? EMPTY);
        if ((base.flags & Capability.globalRoot) !== 0) result = join(result, valueOf(Capability.network | Capability.processRoot | Capability.processObject));
        if ((base.flags & Capability.processRoot) !== 0) result = join(result, valueOf(Capability.child));
        if ((base.flags & (Capability.network | Capability.child | Capability.fixture)) !== 0) result = join(result, valueOf(base.flags));
      }
      return result;
    };
    if (ts.isPropertyAccessExpression(value)) return extract(evaluate(value.expression, depth + 1), [value.name.text], false);
    if (ts.isElementAccessExpression(value)) {
      const key = value.argumentExpression ? evaluate(value.argumentExpression, depth + 1) : valueOf(0, [], true);
      return extract(evaluate(value.expression, depth + 1), [...key.strings], key.unknownString || key.strings.size === 0);
    }
    if (ts.isAwaitExpression(value)) return evaluate(value.expression, depth + 1);
    if (ts.isCallExpression(value)) {
      if (ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "slice") {
        const base = evaluate(value.expression.expression, depth + 1);
        const indexes: number[] = [];
        let exact = !base.unknownString && base.strings.size > 0 && value.arguments.length <= 2;
        for (const argument of value.arguments) {
          const item = unwrapExpression(argument);
          if (!ts.isNumericLiteral(item) || !Number.isSafeInteger(Number(item.text))) { exact = false; break; }
          indexes.push(Number(item.text));
        }
        if (exact) return valueOf(base.flags, [...base.strings].map((item) => item.slice(indexes[0], indexes[1])), false, new Map(), base.unknownProperty);
        return derivedUnknown(join(base, evaluateExpressionList(value.arguments, depth + 1), depth + 1));
      }
      if (ts.isPropertyAccessExpression(value.expression) && ["importActual", "importMock"].includes(value.expression.name.text)) {
        const argument = value.arguments[0] ? evaluate(value.arguments[0]!, depth + 1) : valueOf(0, [], true);
        let result = EMPTY; for (const specifier of argument.strings) result = join(result, moduleValue(specifier));
        return argument.unknownString ? join(result, valueOf(Capability.network | Capability.child | Capability.fixture)) : result;
      }
      if (value.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = value.arguments[0] ? evaluate(value.arguments[0]!, depth + 1) : valueOf(0, [], true);
        let result = EMPTY;
        for (const specifier of argument.strings) result = join(result, moduleValue(specifier));
        return argument.unknownString ? join(result, valueOf(Capability.network | Capability.child | Capability.fixture)) : result;
      }
      const callee = evaluate(value.expression, depth + 1);
      const descendants = join(callee, evaluateExpressionList(value.arguments, depth + 1), depth + 1);
      if ((callee.flags & Capability.child) !== 0) {
        const argument = value.arguments[0] ? evaluate(value.arguments[0]!, depth + 1) : valueOf(0, [], true);
        let result = join(valueOf(Capability.child), descendants, depth + 1);
        for (const specifier of argument.strings) result = join(result, moduleValue(specifier));
        return argument.unknownString ? join(result, valueOf(Capability.child)) : result;
      }
      return derivedUnknown(descendants);
    }
    if (ts.isNewExpression(value)) return derivedUnknown(join(evaluate(value.expression, depth + 1), evaluateExpressionList(value.arguments ?? [], depth + 1), depth + 1));
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return derivedUnknown(evaluateFunctionResult(value, depth + 1));
    return derivedUnknown(evaluateDescendants(value, depth + 1));
  };

  const patternProperty = (sourceValue: AbstractValue, keys: readonly string[], unknown: boolean): AbstractValue => {
    let item = EMPTY;
    for (const key of keys) {
      item = join(item, sourceValue.properties.get(key) ?? sourceValue.unknownProperty ?? EMPTY);
      if ((sourceValue.flags & Capability.globalRoot) !== 0 && (key === "fetch" || key === "WebSocket")) item = join(item, valueOf(Capability.network));
      if ((sourceValue.flags & Capability.globalRoot) !== 0 && key === "process") item = join(item, valueOf(Capability.processRoot | Capability.processObject));
      if ((sourceValue.flags & Capability.globalRoot) !== 0 && key === "module") item = join(item, valueOf(Capability.child));
      if ((sourceValue.flags & Capability.processRoot) !== 0 && key === "getBuiltinModule") item = join(item, valueOf(Capability.child));
      if ((sourceValue.flags & (Capability.network | Capability.child | Capability.fixture)) !== 0) item = join(item, valueOf(sourceValue.flags));
    }
    if (unknown) {
      item = join(item, sourceValue.unknownProperty ?? EMPTY);
      if ((sourceValue.flags & Capability.globalRoot) !== 0) item = join(item, valueOf(Capability.network | Capability.processRoot | Capability.processObject));
      if ((sourceValue.flags & Capability.processRoot) !== 0) item = join(item, valueOf(Capability.child));
    }
    return item;
  };
  const taintPattern = (pattern: ts.Node): boolean => {let changed = false; const visit = (node: ts.Node): void => {if (ts.isIdentifier(node)) {const previous = bindings.get(node.text) ?? EMPTY, next = join(previous, TOP); if (!sameValue(previous, next)) {bindings.set(node.text, next); changed = true;} return;} ts.forEachChild(node, visit);}; visit(pattern); return changed;};
  const extractPattern = (pattern: ts.Node, sourceValue: AbstractValue, depth = 0): boolean => {
    if (depth >= MAX_DEPTH) return taintPattern(pattern);
    if (ts.isIdentifier(pattern)) {
      const previous = bindings.get(pattern.text) ?? EMPTY, next = join(previous, sourceValue);
      if (sameValue(previous, next)) return false;
      bindings.set(pattern.text, next); return true;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      let changed = false;
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) { changed = extractPattern(element.name, sourceValue.unknownProperty ?? sourceValue, depth + 1) || changed; continue; }
        const key = element.propertyName ? staticPropertyName(element.propertyName, (item) => evaluate(item, depth + 1)) : ts.isIdentifier(element.name) ? {values: [element.name.text], unknown: false} : {values: [], unknown: true};
        const item = patternProperty(sourceValue, key.values, key.unknown);
        changed = extractPattern(element.name, item, depth + 1) || changed;
      }
      return changed;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      let changed = false; pattern.elements.forEach((element, index) => {if (!ts.isOmittedExpression(element)) changed = extractPattern(element, sourceValue.properties.get(String(index)) ?? sourceValue.unknownProperty ?? EMPTY, depth + 1) || changed;}); return changed;
    }
    const expression = ts.isExpression(pattern) ? unwrapExpression(pattern) : pattern;
    if (ts.isObjectLiteralExpression(expression)) {
      let changed = false;
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {changed = extractPattern(property.expression, sourceValue.unknownProperty ?? sourceValue, depth + 1) || changed; continue;}
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const name = property.name, target = ts.isPropertyAssignment(property) ? property.initializer : property.name, key = staticPropertyName(name, (item) => evaluate(item, depth + 1));
        const item = patternProperty(sourceValue, key.values, key.unknown);
        changed = extractPattern(target, item, depth + 1) || changed;
      }
      return changed;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      let changed = false; expression.elements.forEach((element, index) => {if (!ts.isOmittedExpression(element)) changed = extractPattern(ts.isSpreadElement(element) ? element.expression : element, sourceValue.properties.get(String(index)) ?? sourceValue.unknownProperty ?? EMPTY, depth + 1) || changed;}); return changed;
    }
    return false;
  };

  const passCountSafe = operations.length <= Number.MAX_SAFE_INTEGER - bindings.size - 1;
  const requestedPasses = passCountSafe ? operations.length + bindings.size + 1 : MAX_PASSES;
  const passLimit = Math.min(MAX_PASSES, requestedPasses);
  let stabilized = false;
  for (let pass = 0; pass < passLimit; pass += 1) {
    let changed = false;
    for (const operation of operations) changed = extractPattern(operation.pattern, evaluate(operation.source), 0) || changed;
    if (!changed) {stabilized = true; break;}
  }
  if (!stabilized) for (const operation of operations) taintPattern(operation.pattern);

  const contains = (value: AbstractValue, flag: number): boolean => (value.flags & flag) !== 0;
  const location = (node: ts.Node, category: string): string => {const point = file.getLineAndCharacterOfPosition(node.getStart(file));return `${relative}:${point.line + 1}:${point.character + 1}: ${category}`;};
  return {file, bindings, operations: Object.freeze(operations), value: (expression) => evaluate(expression), contains, location};
}

export function moduleCapabilityKind(specifier: string): "network" | "child" | "fixture" | "safe" { return moduleKind(specifier); }
