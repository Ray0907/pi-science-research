import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { TOP_CAPABILITY_FLAGS, Capability, createCapabilityAnalysis, isFullyErasedTypeOnlyExport, isFullyErasedTypeOnlyImport, moduleCapabilityKind, unwrapExpression } from "./test-capability-analysis.js";
const root = path.resolve(import.meta.dirname, "../..");
const setupRelative = "tests/setup/no-network.ts";
const setupPath = path.join(root, setupRelative);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const exactStubNames = Object.freeze([
    "global.fetch", "global.WebSocket", "http.request", "http.get", "https.request", "https.get", "http2.connect", "http2.session.request", "http2.session.ping", "http2.session.settings", "net.connect", "net.createConnection", "tls.connect", "dgram.createSocket", "dgram.Socket.bind", "dgram.Socket.connect", "dgram.Socket.send",
    ...["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"].flatMap((name) => [`dns.${name}`, `dns.promises.${name}`]),
    "dns.Resolver.resolve*", "dns.Resolver.reverse", "dns.promises.Resolver.resolve*", "dns.promises.Resolver.reverse",
]);
function enumerate(directory: string): readonly string[] { const base = path.resolve(directory), output: string[] = []; const walk = (entry: string): void => { const resolved = path.resolve(entry), relative = path.relative(base, resolved); if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("audit path escape"); const stat = fs.lstatSync(resolved); if (stat.isSymbolicLink())
    throw new Error("audit symlink denied"); if (stat.isDirectory()) {
    for (const name of fs.readdirSync(resolved).sort())
        walk(path.join(resolved, name));
}
else if (stat.isFile() && sourceExtensions.has(path.extname(resolved)))
    output.push(resolved); }; walk(base); return Object.freeze(output); }
function enumerateRepositorySources(): readonly string[] { const output: string[] = [], excluded = new Set([".git", "node_modules", "worktrees", ".worktrees", "build", "dist", "coverage", "temp", "tmp"]); const walk = (entry: string): void => { if (entry !== root && excluded.has(path.basename(entry)))
    return; const stat = fs.lstatSync(entry); if (stat.isSymbolicLink())
    throw new Error("audit symlink denied"); if (stat.isDirectory()) {
    for (const name of fs.readdirSync(entry).sort())
        walk(path.join(entry, name));
}
else if (stat.isFile() && sourceExtensions.has(path.extname(entry)))
    output.push(entry); }; walk(root); return Object.freeze(output); }
function parse(source: string, file = "fixture.ts"): ts.SourceFile { return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function specifierKind(value: string): "network" | "child" | null { const kind = moduleCapabilityKind(value); return kind === "network" || kind === "child" ? kind : null; }
function staticString(expression: ts.Expression): string | undefined { const value = unwrapExpression(expression); if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    return value.text; if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(value.left), right = staticString(value.right);
    return left === undefined || right === undefined ? undefined : left + right;
} return undefined; }
function findingSet(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort()); }
function auditSetupSource(file: ts.SourceFile, relative: string): readonly string[] {
    const errors: string[] = [];
    let syncBuiltinImport: ts.Identifier | null = null, syncBuiltinCallCount = 0;
    const defaults = new Map([["node:http", "http"], ["node:https", "https"], ["node:http2", "http2"], ["node:net", "net"], ["node:tls", "tls"], ["node:dgram", "dgram"], ["node:dns", "dns"], ["node:dns/promises", "dnsPromises"]]);
    const named = new Map([["node:module", "syncBuiltinESMExports"], ["node:stream", "Duplex"], ["vitest", "afterAll"]]);
    const seen = new Set<string>();
    for (const statement of file.statements) {
        if (ts.isExportAssignment(statement))
            errors.push(`${relative}:1:1: setup export assignment denied`);
        if (ts.isExportDeclaration(statement))
            errors.push(`${relative}:1:1: setup export declaration denied`);
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        if (modifiers?.some(item => item.kind === ts.SyntaxKind.DefaultKeyword)) errors.push(`${relative}:1:1: setup default export denied`);
        if (modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
            const exactHelper = ts.isFunctionDeclaration(statement) && ["createIsolatedNetworkStubInternal", "getInstalledHttp2ClientSessionMethodsInternal"].includes(statement.name?.text ?? "");
            if (!exactHelper) errors.push(`${relative}:1:1: setup local export denied`);
        }
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
        const specifier = statement.moduleSpecifier.text;
        if (seen.has(specifier))
            errors.push(`${relative}:1:1: duplicate setup import`);
        seen.add(specifier);
        const defaultName = defaults.get(specifier), namedName = named.get(specifier), clause = statement.importClause;
        if (defaultName) {
            if (clause?.name?.text !== defaultName || clause.namedBindings || clause.isTypeOnly)
                errors.push(`${relative}:1:1: setup default import shape`);
        }
        else if (namedName) {
            const bindings = clause?.namedBindings;
            const valid = clause && !clause.name && !clause.isTypeOnly && bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 && !bindings.elements[0]!.isTypeOnly && !bindings.elements[0]!.propertyName && bindings.elements[0]!.name.text === namedName;
            if (!valid)
                errors.push(`${relative}:1:1: setup named import shape`);
            else if (specifier === "node:module") syncBuiltinImport = bindings.elements[0]!.name;
        }
        else
            errors.push(`${relative}:1:1: setup import denied`);
    }
    for (const specifier of [...defaults.keys(), ...named.keys()])
        if (!seen.has(specifier))
            errors.push(`${relative}:1:1: setup import missing ${specifier}`);
    const runtimeRoots = new Set(defaults.values());
    const insideType = (node: ts.Node): boolean => { for (let current: ts.Node | undefined = node.parent; current; current = current.parent) { if (ts.isTypeNode(current)) return true; if (ts.isStatement(current)) return false; } return false; };
    const visitSetup = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === "syncBuiltinESMExports") { const parent = node.parent, exactImport = node === syncBuiltinImport, exactCall = ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length === 0; if (exactCall) syncBuiltinCallCount += 1; if (!exactImport && !exactCall) errors.push(`${relative}:1:1: setup module binding escape denied`); }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && runtimeRoots.has(node.expression.text) && !insideType(node)) {
            const prototypeRoot = (node.expression.text === "dgram" && node.name.text === "Socket") || ((node.expression.text === "dns" || node.expression.text === "dnsPromises") && node.name.text === "Resolver");
            if (!prototypeRoot) errors.push(`${relative}:1:1: setup runtime member escape`);
        }
        if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && runtimeRoots.has(node.expression.text) && !insideType(node)) errors.push(`${relative}:1:1: setup computed runtime member denied`);
        if (ts.isCallExpression(node)) {
            const target = unwrapExpression(node.expression);
            if (ts.isIdentifier(target) && runtimeRoots.has(target.text)) errors.push(`${relative}:1:1: setup builtin call denied`);
            if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && runtimeRoots.has(target.expression.text)) errors.push(`${relative}:1:1: setup builtin member call denied`);
        }
        if (ts.isIdentifier(node) && runtimeRoots.has(node.text) && !insideType(node)) {
            const parent = node.parent;
            const imported = ts.isImportClause(parent) && parent.name === node;
            const memberRoot = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
            const argument = ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression) && ts.isIdentifier(parent.expression) && ["install", "getOwnPropertyDescriptor", "reflectApply"].includes(parent.expression.text);
            if (!imported && !memberRoot && !argument) errors.push(`${relative}:1:1: setup builtin alias or capture denied`);
        }
        ts.forEachChild(node, visitSetup);
    };
    visitSetup(file);
    if (syncBuiltinImport === null || syncBuiltinCallCount !== 1) errors.push(`${relative}:1:1: setup syncBuiltinESMExports call cardinality`);
    const source = file.text;
    const required = ["class NoIoDuplex extends Duplex", "override _read(): void {}", "createConnection: () =>", "createConnectionCalls !== 1", "getPrototypeOf(session)", '["request", "ping", "settings"]', "installMethod(prototype, name, stub)", "session?.destroy()", "fakeDuplex?.destroy()", "syncBuiltinESMExports()", "attempts += 1", "attemptsAreZero()", "network-attempts=0"];
    for (const snippet of required)
        if (!source.includes(snippet))
            errors.push(`${relative}:1:1: setup bootstrap missing ${snippet}`);
    const connectCalls = [...source.matchAll(/reflectApply\(capturedConnect/gu)].length;
    if (connectCalls !== 1)
        errors.push(`${relative}:1:1: setup HTTP2 connect cardinality`);
    return findingSet(errors);
}
function auditNetworkSource(source: string, relative = "tests/fixture.test.ts", allowSetup = false): readonly string[] {
    const analysis = createCapabilityAnalysis(source, relative);
    if (allowSetup)
        return auditSetupSource(analysis.file, relative);
    const errors: string[] = [];
    let potential = false;
    const globalRoots=new Set(["globalThis","global"]);for(let pass=0;pass<Math.min(64,analysis.operations.length+1);pass+=1){let changed=false;for(const operation of analysis.operations){const pattern=unwrapExpression(operation.pattern as ts.Expression),value=unwrapExpression(operation.source);if(ts.isIdentifier(pattern)&&ts.isIdentifier(value)&&globalRoots.has(value.text)&&!globalRoots.has(pattern.text)){globalRoots.add(pattern.text);changed=true;}}if(!changed)break;}
    const directGlobal=(expression:ts.Expression):boolean=>{const value=unwrapExpression(expression);return ts.isIdentifier(value)&&globalRoots.has(value.text);};
    if(analysis.operations.some(operation=>directGlobal(operation.source)&&!ts.isIdentifier(operation.pattern)))potential=true;const hasNetworkSyntax=(node:ts.Node):boolean=>{let found=false;const visit=(item:ts.Node):void=>{if(found)return;if(ts.isPropertyAccessExpression(item)&&["fetch","WebSocket"].includes(item.name.text)&&directGlobal(item.expression))found=true;if(ts.isElementAccessExpression(item)&&directGlobal(item.expression))found=true;if(ts.isIdentifier(item)&&["fetch","WebSocket"].includes(item.text)){const parent=item.parent;if((ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.expression===item)found=true;}ts.forEachChild(item,visit);};visit(node);return found;};const dangerous=(node:ts.Node,value:ReturnType<typeof analysis.value>):boolean=>analysis.contains(value,Capability.network)&&(value.flags!==TOP_CAPABILITY_FLAGS||hasNetworkSyntax(node));
    const detect = (node: ts.Node): void => { if (ts.isImportEqualsDeclaration(node)) potential = true; if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && moduleCapabilityKind(node.moduleSpecifier.text) === "network") potential = true; if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyImport(node) && moduleCapabilityKind(node.moduleSpecifier.text) === "network") potential = true; if(ts.isIdentifier(node)&&["fetch","WebSocket"].includes(node.text)){const parent=node.parent;if((ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.expression===node)potential=true;}if(ts.isPropertyAccessExpression(node)&&["fetch","WebSocket"].includes(node.name.text)&&directGlobal(node.expression))potential=true;if(ts.isElementAccessExpression(node)&&directGlobal(node.expression))potential=true;if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&directGlobal(node.right)&&ts.isObjectLiteralExpression(unwrapExpression(node.left as ts.Expression)))potential=true;if(ts.isIdentifier(node)&&node.text==="require")potential=true;if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isPropertyAccessExpression(node.expression)&&["importActual","importMock"].includes(node.expression.name.text)))){const argument=node.arguments[0];if(!argument||!ts.isStringLiteral(argument)||moduleCapabilityKind(argument.text)==="network")potential=true;} ts.forEachChild(node, detect); };
    detect(analysis.file);
    const assertionChain = (expression: ts.Expression): boolean => { const value = unwrapExpression(expression); if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return assertionChain(value.expression); if (ts.isCallExpression(value)) return (ts.isIdentifier(value.expression) && value.expression.text === "expect") || assertionChain(value.expression); return false; };
    const visit = (node: ts.Node): void => {
        if(ts.isElementAccessExpression(node)&&directGlobal(node.expression))errors.push(analysis.location(node,"computed global capability"));
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyImport(node) && moduleCapabilityKind(node.moduleSpecifier.text) === "network")
            errors.push(analysis.location(node, "runtime network import"));
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyExport(node) && moduleCapabilityKind(node.moduleSpecifier.text) === "network")
            errors.push(analysis.location(node, "runtime network export"));
        if (ts.isImportEqualsDeclaration(node))
            errors.push(analysis.location(node, "runtime import-equals denied"));
        if (ts.isCallExpression(node)) {
            if((node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isPropertyAccessExpression(node.expression)&&["importActual","importMock"].includes(node.expression.name.text)))&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&moduleCapabilityKind(node.arguments[0].text)==="network")errors.push(analysis.location(node,"runtime network importer"));
            if (!assertionChain(node.expression) && dangerous(node.expression,analysis.value(node.expression)))
                errors.push(analysis.location(node, "network call"));
            for (const argument of node.arguments)
                if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument) && !(ts.isIdentifier(unwrapExpression(node.expression)) && (unwrapExpression(node.expression) as ts.Identifier).text === "expect") && dangerous(argument,analysis.value(argument)))
                    errors.push(analysis.location(argument, "network capability escape"));
        }
        if (ts.isNewExpression(node) && dangerous(node.expression,analysis.value(node.expression)))
            errors.push(analysis.location(node, "network construct"));
        if (ts.isReturnStatement(node) && node.expression && dangerous(node.expression,analysis.value(node.expression)))
            errors.push(analysis.location(node, "network return"));
        ts.forEachChild(node, visit);
    };
    if (potential) visit(analysis.file);
    if (potential) for (const operation of analysis.operations)
        if (dangerous(operation.source,analysis.value(operation.source)))
            errors.push(analysis.location(operation.node, "network capability storage"));
    return findingSet(errors);
}
function auditNetworkTree(): readonly string[] { const errors: string[] = []; for (const file of [...enumerate(path.join(root, "tests")), path.join(root, "vitest.config.ts")]) {
    if (fs.lstatSync(file).isSymbolicLink())
        throw new Error("audit symlink denied");
    const relative = path.relative(root, file).replaceAll("\\", "/"), source = fs.readFileSync(file, "utf8");
    errors.push(...auditNetworkSource(source, relative, relative === setupRelative));
} return Object.freeze(errors.sort()); }
type ChildAudit = Readonly<{
    errors: readonly string[];
    sites: readonly string[];
}>;
function propertyName(node: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined { return node.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && ((ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)); }
function exactIdentifier(expression: ts.Expression | undefined, name: string): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); return ts.isIdentifier(value) && value.text === name; }
function exactProcessMember(expression: ts.Expression | undefined, name: string): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); return ts.isPropertyAccessExpression(value) && value.name.text === name && ts.isIdentifier(value.expression) && value.expression.text === "process"; }
function exactProcessEnvMember(expression: ts.Expression | undefined, name: string): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); return ts.isPropertyAccessExpression(value) && value.name.text === name && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "env" && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "process"; }
function exactObjectMember(expression: ts.Expression | undefined, rootName: string, name: string): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); return ts.isPropertyAccessExpression(value) && value.name.text === name && ts.isIdentifier(value.expression) && value.expression.text === rootName; }
function hasExactNamedImports(file: ts.SourceFile, moduleName: string, names: readonly string[]): boolean { const matches = file.statements.filter((item): item is ts.ImportDeclaration => ts.isImportDeclaration(item) && ts.isStringLiteral(item.moduleSpecifier) && item.moduleSpecifier.text === moduleName); if (matches.length !== 1) return false; const clause = matches[0]!.importClause, bindings = clause?.namedBindings; if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings)) return false; const actual = bindings.elements.map((item) => item.isTypeOnly || item.propertyName ? "<invalid>" : item.name.text).sort(); return names.every((name) => actual.includes(name)); }
function exactNpmCliStatus(expression: ts.Expression | undefined): boolean { if (!expression) return false; const value = unwrapExpression(expression); if (!ts.isAwaitExpression(value)) return false; const caught = unwrapExpression(value.expression); if (!ts.isCallExpression(caught) || !ts.isPropertyAccessExpression(caught.expression) || caught.expression.name.text !== "catch" || caught.arguments.length !== 1) return false; const fallback = caught.arguments[0]; if (!fallback || !ts.isArrowFunction(fallback) || fallback.parameters.length !== 0 || fallback.body.kind !== ts.SyntaxKind.NullKeyword) return false; const statCall = unwrapExpression(caught.expression.expression); return ts.isCallExpression(statCall) && ts.isIdentifier(statCall.expression) && statCall.expression.text === "stat" && statCall.arguments.length === 1 && exactIdentifier(statCall.arguments[0], "npmCliPath"); }
function hasNpmCliClosedGuard(file: ts.SourceFile): boolean { let found = false; const visit = (node: ts.Node): void => { if (ts.isIfStatement(node) && ts.isPrefixUnaryExpression(node.expression) && node.expression.operator === ts.SyntaxKind.ExclamationToken) { const call = unwrapExpression(node.expression.operand); const target = ts.isCallExpression(call) ? unwrapExpression(call.expression) : null; const closed = target && ts.isPropertyAccessExpression(target) && target.name.text === "isFile" && exactIdentifier(target.expression, "npmCliStatus") && ts.isThrowStatement(node.thenStatement) && ts.isNewExpression(node.thenStatement.expression) && ts.isIdentifier(node.thenStatement.expression.expression) && node.thenStatement.expression.expression.text === "Error" && node.thenStatement.expression.arguments?.length === 1 && ts.isStringLiteral(node.thenStatement.expression.arguments[0]!) && node.thenStatement.expression.arguments[0]!.text === "npm CLI unavailable at trusted installation path"; if (closed) found = true; } ts.forEachChild(node, visit); }; visit(file); return found; }
function exactNpmCliPath(expression: ts.Expression | undefined): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); if (!ts.isConditionalExpression(value) || !ts.isBinaryExpression(value.condition) || value.condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken || !exactProcessMember(value.condition.left, "platform") || !ts.isStringLiteral(value.condition.right) || value.condition.right.text !== "win32") return false;
    const branch = (node: ts.Expression, expected: readonly string[]): boolean => { const call = unwrapExpression(node); if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "resolve" || call.arguments.length !== expected.length + 1) return false; const first = unwrapExpression(call.arguments[0]!); if (!ts.isCallExpression(first) || !ts.isIdentifier(first.expression) || first.expression.text !== "dirname" || first.arguments.length !== 1 || !exactProcessMember(first.arguments[0], "execPath")) return false; return call.arguments.slice(1).every((item, index) => ts.isStringLiteral(item) && item.text === expected[index]); };
    return branch(value.whenTrue, ["node_modules", "npm", "bin", "npm-cli.js"]) && branch(value.whenFalse, ["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"]); }
function exactImportMetaDirname(expression: ts.Expression | undefined): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); return ts.isPropertyAccessExpression(value) && value.name.text === "dirname" && ts.isMetaProperty(value.expression) && value.expression.keywordToken === ts.SyntaxKind.ImportKeyword && value.expression.name.text === "meta"; }
function exactSetupModuleImport(node: ts.ImportDeclaration, relative: string): boolean { if (relative !== setupRelative || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "node:module") return false; const clause = node.importClause, bindings = clause?.namedBindings; return !!clause && !clause.name && !clause.isTypeOnly && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 && !bindings.elements[0]!.isTypeOnly && !bindings.elements[0]!.propertyName && bindings.elements[0]!.name.text === "syncBuiltinESMExports"; }
function auditChildSource(source: string, relative: string): ChildAudit {
    const analysis = createCapabilityAnalysis(source, relative), file = analysis.file, errors: string[] = [], sites: string[] = [], candidateCalls: ts.CallExpression[] = [];
    let childImport: string | null = null, childImportCount = 0;
    const imports = new Set<string>(), initializers = new Map<string, ts.Expression>(), childSources = new Map<string, ts.Expression[]>();
    for (const statement of file.statements)
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !isFullyErasedTypeOnlyImport(statement) && specifierKind(statement.moduleSpecifier.text) === "child") {
            if (exactSetupModuleImport(statement, relative)) continue;
            childImportCount += 1;
            if (statement.moduleSpecifier.text !== "node:child_process" || !statement.importClause || statement.importClause.name || !statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings) || statement.importClause.namedBindings.elements.length !== 1)
                errors.push(`${relative}: child import shape`);
            else {
                const item = statement.importClause.namedBindings.elements[0]!, imported = (item.propertyName ?? item.name).text, local = item.name.text;
                childImport = `${imported}:${local}`;
                imports.add(local);
            }
        }
    const collectBindings = (node: ts.Node): void => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        initializers.set(node.name.text, node.initializer);
        const values = childSources.get(node.name.text) ?? [];
        values.push(node.initializer);
        childSources.set(node.name.text, values);
    } if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrapExpression(node.left as ts.Expression);
        if (ts.isIdentifier(left)) {
            const values = childSources.get(left.text) ?? [];
            values.push(node.right);
            childSources.set(left.text, values);
        }
    } ts.forEachChild(node, collectBindings); };
    collectBindings(file);
    for (let pass = 0; pass <= childSources.size; pass += 1) {
        let changed = false;
        for (const [name, values] of childSources)
            if (!imports.has(name) && values.some((value) => { const current = unwrapExpression(value); return ts.isIdentifier(current) && imports.has(current.text); })) {
                imports.add(name);
                changed = true;
            }
        if (!changed)
            break;
    }
    const rootMask = Capability.globalRoot | Capability.processObject | Capability.child;
    const abstractRootWitness = (expression: ts.Expression, seen = new Set<ts.Node>(), depth = 0): boolean => { if (depth >= 32 || seen.has(expression)) return false; seen.add(expression); const value = analysis.value(expression); if ((value.flags & rootMask) === 0) return false; if (value.flags !== TOP_CAPABILITY_FLAGS) return true; let found = false; ts.forEachChild(expression, (child) => { if (!found && ts.isExpression(child) && abstractRootWitness(child, seen, depth + 1)) found = true; }); const unwrapped = unwrapExpression(expression); if (!found && ts.isIdentifier(unwrapped)) for (const operation of analysis.operations) { let defines = false; const inspect = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === unwrapped.text) defines = true; else ts.forEachChild(node, inspect); }; inspect(operation.pattern); if (defines && abstractRootWitness(operation.source, seen, depth + 1)) { found = true; break; } } return found; };
    const loaderMemberRoot = (expression: ts.Expression): boolean => { const value = analysis.value(expression); return (value.flags & rootMask) !== 0 && abstractRootWitness(expression); };
    const loaderNames = new Set(["require", "getBuiltinModule", "createRequire", "_load", "register", "registerHooks"]);
    const computedLoaderUse = (node: ts.ElementAccessExpression): boolean => { if (!node.argumentExpression || !loaderMemberRoot(node.expression)) return false; if (relative === setupRelative && exactIdentifier(node.expression, "globalRecord") && exactIdentifier(node.argumentExpression, "stateKey")) return false; const key = analysis.value(node.argumentExpression); return key.unknownString || key.strings.size === 0 || [...key.strings].some((item) => loaderNames.has(item)); };
    const visit = (node: ts.Node): void => {
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyExport(node) && specifierKind(node.moduleSpecifier.text) === "child")
            errors.push(`${relative}: child export-from denied`);
        if (ts.isImportEqualsDeclaration(node))
            errors.push(`${relative}: child import-equals denied`);
        if (ts.isIdentifier(node) && ["require", "getBuiltinModule"].includes(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
            errors.push(`${relative}: loader capability denied`);
        if (ts.isIdentifier(node) && imports.has(node.text) && !ts.isImportSpecifier(node.parent)) {
            const outer = unwrapExpression(node.parent as ts.Expression);
            if (!(ts.isCallExpression(node.parent) && node.parent.expression === node) && !(ts.isCallExpression(outer.parent) && outer.parent.expression === outer))
                errors.push(`${relative}: subprocess binding escape`);
        }
        if (ts.isPropertyAccessExpression(node) && loaderNames.has(node.name.text) && loaderMemberRoot(node.expression))
            errors.push(`${relative}: loader property capability denied`);
        if (ts.isElementAccessExpression(node) && computedLoaderUse(node))
            errors.push(`${relative}: computed loader capability denied`);
        if (ts.isCallExpression(node)) {
            const target = unwrapExpression(node.expression);
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const argument = node.arguments[0], value = argument && staticString(argument);
                if (value === undefined || specifierKind(value) === "child")
                    errors.push(`${relative}: dynamic child denied`);
            }
            if (ts.isPropertyAccessExpression(node.expression) && ["importActual", "importMock"].includes(node.expression.name.text)) {
                const argument = node.arguments[0], value = argument && staticString(argument);
                if (value === undefined || specifierKind(value) === "child")
                    errors.push(`${relative}: runtime importer child denied`);
            }
            if (ts.isIdentifier(target) && imports.has(target.text)) {
                if (relative === "tests/package.test.ts") {
                    const executable = node.arguments[0], initializer = initializers.get("npmCliPath"), statusInitializer = initializers.get("npmCliStatus");
                    if (node.arguments.length !== 4 || !exactProcessMember(executable, "execPath") || !exactNpmCliPath(initializer) || childSources.get("npmCliPath")?.length !== 1 || !hasExactNamedImports(file, "node:path", ["dirname", "resolve"]) || !exactNpmCliStatus(statusInitializer) || !hasNpmCliClosedGuard(file) || !ts.isFunctionLike(node.arguments[3]!))
                        errors.push(`${relative}: npm executable or callback shape`);
                }
                else if (relative === "tests/storage/run-root.test.ts") {
                    const executable = node.arguments[0];
                    if (node.arguments.length !== 3 || !executable || !exactProcessMember(executable, "execPath"))
                        errors.push(`${relative}: Vitest executable shape`);
                }
                const options = node.arguments[2], cwd = options && ts.isObjectLiteralExpression(options) ? propertyName(options, "cwd") : undefined;
                if (!options || !ts.isObjectLiteralExpression(options)) {
                    errors.push(`${relative}: subprocess options shape`);
                }
                else {
                    const shell = propertyName(options, "shell"), env = propertyName(options, "env");
                    const expectedOptionNames = relative === "tests/package.test.ts" ? ["cwd", "env", "shell"] : ["cwd", "env", "shell", "stdio"];
                    const optionNames = options.properties.map((item) => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) ? item.name.text : "<invalid>").sort();
                    if (JSON.stringify(optionNames) !== JSON.stringify(expectedOptionNames)) errors.push(`${relative}: subprocess exact options`);
                    const stdio = propertyName(options, "stdio");
                    if (relative === "tests/storage/run-root.test.ts" && (!stdio || !ts.isArrayLiteralExpression(stdio.initializer) || JSON.stringify(stdio.initializer.elements.map((item) => ts.isStringLiteral(item) ? item.text : "<dynamic>")) !== JSON.stringify(["ignore", "pipe", "pipe"]))) errors.push(`${relative}: subprocess stdio`);
                    if (!shell || shell.initializer.kind !== ts.SyntaxKind.FalseKeyword || !env || !ts.isObjectLiteralExpression(env.initializer) || !cwd)
                        errors.push(`${relative}: subprocess options policy`);
                    else {
                        const envNames: string[] = [];
                        for (const item of env.initializer.properties) {
                            if (!ts.isPropertyAssignment(item) || (!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))) {
                                errors.push(`${relative}: subprocess env spread`);
                                continue;
                            }
                            envNames.push(item.name.text);
                            if (/proxy|ca|cert|key|token|credential|secret|password/i.test(item.name.text) && !["TOKEN"].includes(item.name.text))
                                errors.push(`${relative}: subprocess credential env`);
                        }
                        const base = ["ComSpec", "HOME", "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "TMPDIR"], fixture = ["BARRIER", "PROJECT", "RESULT", "RUN_ID", "TOKEN"], expected = relative === "tests/package.test.ts" ? base : [...base, ...fixture].sort();
                        if (JSON.stringify(envNames.sort()) !== JSON.stringify(expected.sort()))
                            errors.push(`${relative}: subprocess env names`);
                        for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT"])
                            if (!exactProcessEnvMember((env.initializer.properties.find((item) => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name) as ts.PropertyAssignment | undefined)?.initializer, name))
                                errors.push(`${relative}: ambient env selection`);
                        const local = relative === "tests/package.test.ts" ? "packageTemp" : "root";
                        for (const name of ["HOME", "TMPDIR", "TMP", "TEMP"])
                            if (!exactIdentifier((env.initializer.properties.find((item) => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name) as ts.PropertyAssignment | undefined)?.initializer, local))
                                errors.push(`${relative}: temp env root`);
                        if (relative === "tests/storage/run-root.test.ts")
                            for (const name of ["BARRIER", "PROJECT", "RUN_ID", "TOKEN", "RESULT"])
                                if (!exactObjectMember((env.initializer.properties.find((item) => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name) as ts.PropertyAssignment | undefined)?.initializer, "environment", name))
                                    errors.push(`${relative}: fixture env source`);
                    }
                }
                const args = node.arguments[1];
                if (!args || !ts.isArrayLiteralExpression(args) || args.elements.some((item) => ts.isSpreadElement(item))) {
                    errors.push(`${relative}: subprocess args shape`);
                }
                else {
                    for (const item of args.elements) {
                        const literal = ts.isStringLiteral(item) ? item.text : "";
                        if (/^(?:https?|wss?):/i.test(literal))
                            errors.push(`${relative}: subprocess URL argument`);
                    }
                    if (relative === "tests/package.test.ts") {
                        if (!exactIdentifier(cwd?.initializer, "projectRoot"))
                            errors.push(`${relative}: package cwd`);
                        const expected = ["npmCliPath", "pack", "--dry-run", "--json", "--ignore-scripts"];
                        if (JSON.stringify(args.elements.map((item) => ts.isStringLiteral(item) ? item.text : ts.isIdentifier(item) ? item.text : "<dynamic>")) !== JSON.stringify(expected))
                            errors.push(`${relative}: npm args`);
                        sites.push(`${relative}:execFile`); candidateCalls.push(node);
                    }
                    else if (relative === "tests/storage/run-root.test.ts") {
                        if (!exactIdentifier(cwd?.initializer, "root"))
                            errors.push(`${relative}: Vitest cwd`);
                        const elements = args.elements, vitest = elements[0], owner = (() => { for (let current: ts.Node | undefined = node.parent; current; current = current.parent)
                            if (ts.isFunctionDeclaration(current))
                                return current; return undefined; })();
                        const localRoot = owner?.name?.text === "spawnVitestChild" && owner.parameters.length === 2 && ts.isIdentifier(owner.parameters[0]!.name) && owner.parameters[0]!.name.text === "root";
                        const exactVitest = vitest && ts.isCallExpression(vitest) && ts.isIdentifier(vitest.expression) && vitest.expression.text === "resolve" && vitest.arguments.length === 2 && exactImportMetaDirname(vitest.arguments[0]) && ts.isStringLiteral(vitest.arguments[1]!) && vitest.arguments[1]!.text === "../../node_modules/vitest/vitest.mjs";
                        if (elements.length !== 5 || !exactVitest || !ts.isStringLiteral(elements[1]!) || elements[1]!.text !== "run" || !ts.isStringLiteral(elements[2]!) || elements[2]!.text !== "--root" || !ts.isIdentifier(elements[3]!) || elements[3]!.text !== "root" || !ts.isStringLiteral(elements[4]!) || elements[4]!.text !== "child.test.ts" || !localRoot)
                            errors.push(`${relative}: vitest args or local-root provenance`);
                        sites.push(`${relative}:spawn`); candidateCalls.push(node);
                    }
                    else
                        errors.push(`${relative}: subprocess site denied`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (childImport !== null) {
        const expected = relative === "tests/package.test.ts" ? "execFile:execFile" : relative === "tests/storage/run-root.test.ts" ? "spawn:spawn" : null;
        if (childImport !== expected || childImportCount !== 1) errors.push(`${relative}: child binding denied`);
        if (sites.length !== 1) errors.push(`${relative}: subprocess call cardinality`);
    }
    const canonicalCall = errors.length === 0 && candidateCalls.length === 1 ? candidateCalls[0]! : null;
    const canonicalCallee = canonicalCall === null ? null : unwrapExpression(canonicalCall.expression);
    const isCanonicalCalleeUse = (call: ts.CallExpression): boolean => call === canonicalCall && unwrapExpression(call.expression) === canonicalCallee;
    let childPotential = false;
    const detectChild = (node: ts.Node): void => { if(ts.isIdentifier(node)&&node.text==="Worker"&&analysis.contains(analysis.value(node),Capability.child))childPotential=true; if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyImport(node) && moduleCapabilityKind(node.moduleSpecifier.text) === "child") { const named=node.importClause?.namedBindings;const item=named&&ts.isNamedImports(named)&&named.elements.length===1?named.elements[0]:undefined;const exactApproved=exactSetupModuleImport(node,relative)||(node.moduleSpecifier.text==="node:child_process"&&!node.importClause?.name&&item&&!item.propertyName&&((relative==="tests/package.test.ts"&&item.name.text==="execFile")||(relative==="tests/storage/run-root.test.ts"&&item.name.text==="spawn")));if(!exactApproved)childPotential=true; } if (ts.isIdentifier(node) && ["require", "getBuiltinModule", "createRequire"].includes(node.text)) childPotential = true; if (ts.isPropertyAccessExpression(node) && loaderNames.has(node.name.text) && loaderMemberRoot(node.expression)) childPotential = true; if (ts.isElementAccessExpression(node) && computedLoaderUse(node)) childPotential = true; ts.forEachChild(node, detectChild); };
    detectChild(file);
    for (const operation of analysis.operations) { let computed = false; const inspect = (node: ts.Node): void => { if (ts.isComputedPropertyName(node)) computed = true; ts.forEachChild(node, inspect); }; inspect(operation.pattern); if (computed && loaderMemberRoot(operation.source)) childPotential = true; }
    if (childPotential) for (const operation of analysis.operations) if (analysis.contains(analysis.value(operation.source), Capability.child)) errors.push(analysis.location(operation.node, "child capability storage"));
    const capabilityVisit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            if (!isCanonicalCalleeUse(node) && analysis.contains(analysis.value(node.expression), Capability.child)) errors.push(analysis.location(node, "child capability call"));
            for (const argument of node.arguments) if (analysis.contains(analysis.value(argument), Capability.child)) errors.push(analysis.location(argument, "child capability escape"));
        }
        if (ts.isNewExpression(node) && analysis.contains(analysis.value(node.expression), Capability.child)) errors.push(analysis.location(node, "child capability construct"));
        if (ts.isReturnStatement(node) && node.expression && analysis.contains(analysis.value(node.expression), Capability.child)) errors.push(analysis.location(node, "child capability return"));
        ts.forEachChild(node, capabilityVisit);
    };
    if (childPotential) capabilityVisit(file);
    return { errors: Object.freeze([...new Set(errors)]), sites: Object.freeze(sites) };
}
function auditChildTree(): ChildAudit { const errors: string[] = [], sites: string[] = []; for (const file of enumerateRepositorySources()) {
    const relative = path.relative(root, file).replaceAll("\\", "/"), result = auditChildSource(fs.readFileSync(file, "utf8"), relative);
    errors.push(...result.errors);
    sites.push(...result.sites);
} return { errors: Object.freeze(errors.sort()), sites: Object.freeze(sites.sort()) }; }
function auditFixtureConstructor(source: string, relative: string): readonly string[] { const analysis = createCapabilityAnalysis(source, relative), file = analysis.file, errors: string[] = [], allowed = new Set(["tests/acquisition/crossref.test.ts", "tests/acquisition/openalex.test.ts", "tests/acquisition/pubmed.test.ts", "tests/acquisition/pmc.test.ts"]); let imports = 0, calls = 0; const visit = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === "createProviderRequestPartitionFixtureInternal") {
    if (!allowed.has(relative))
        errors.push(`${relative}: fixture constructor denied`);
    if (ts.isImportSpecifier(node.parent)) {
        imports += 1;
        const declaration = node.parent.parent.parent.parent;
        if (node.parent.propertyName || !ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== "../../src/acquisition/contracts.js")
            errors.push(`${relative}: fixture constructor import shape`);
    }
    else if (ts.isCallExpression(node.parent) && node.parent.expression === node)
        calls += 1;
    else
        errors.push(`${relative}: fixture constructor indirect or re-exported`);
} ts.forEachChild(node, visit); }; visit(file); if ((imports > 0 || calls > 0) && (!allowed.has(relative) || imports !== 1 || calls !== 1))
    errors.push(`${relative}: fixture constructor cardinality`); let fixturePotential=imports>0||calls>0;const detectFixture=(node:ts.Node):void=>{if(ts.isIdentifier(node)&&node.text==="createProviderRequestPartitionFixtureInternal")fixturePotential=true;if(ts.isIdentifier(node)&&node.text==="createProviderRequestPartitionFixtureInternal")fixturePotential=true;if(ts.isElementAccessExpression(node)&&node.argumentExpression&&ts.isStringLiteral(node.argumentExpression)&&node.argumentExpression.text==="createProviderRequestPartitionFixtureInternal")fixturePotential=true;if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&moduleCapabilityKind(node.arguments[0].text)==="fixture")fixturePotential=true;ts.forEachChild(node,detectFixture);};detectFixture(file);const exactAllowedFixture=allowed.has(relative)&&imports===1&&calls===1&&errors.length===0;if(exactAllowedFixture)fixturePotential=false; if(fixturePotential) for (const operation of analysis.operations)
    if (analysis.contains(analysis.value(operation.source), Capability.fixture))
        errors.push(analysis.location(operation.node, "fixture capability storage")); const capabilityVisit = (node: ts.Node): void => { if (ts.isCallExpression(node)) {
    const exact = ts.isIdentifier(unwrapExpression(node.expression)) && (unwrapExpression(node.expression) as ts.Identifier).text === "createProviderRequestPartitionFixtureInternal" && allowed.has(relative);
    if (!exact && analysis.contains(analysis.value(node.expression), Capability.fixture))
        errors.push(analysis.location(node, "fixture capability call"));
} if (ts.isReturnStatement(node) && node.expression && !(ts.isCallExpression(unwrapExpression(node.expression)) && ts.isIdentifier(unwrapExpression((unwrapExpression(node.expression) as ts.CallExpression).expression)) && (unwrapExpression((unwrapExpression(node.expression) as ts.CallExpression).expression) as ts.Identifier).text === "createProviderRequestPartitionFixtureInternal" && allowed.has(relative)) && analysis.contains(analysis.value(node.expression), Capability.fixture))
    errors.push(analysis.location(node, "fixture capability return")); ts.forEachChild(node, capabilityVisit); }; if(fixturePotential)capabilityVisit(file); return errors; }
function auditFixtureTree(): readonly string[] { const errors: string[] = [], expected = new Set(["tests/acquisition/crossref.test.ts", "tests/acquisition/openalex.test.ts", "tests/acquisition/pubmed.test.ts", "tests/acquisition/pmc.test.ts"]), seen = new Set<string>(); for (const file of [...enumerate(path.join(root, "tests")), path.join(root, "vitest.config.ts")]) {
    const relative = path.relative(root, file).replaceAll("\\", "/"), source = fs.readFileSync(file, "utf8");
    errors.push(...auditFixtureConstructor(source, relative));
    const ast = parse(source, relative);
    for (const statement of ast.statements)
        if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some((item) => (item.propertyName ?? item.name).text === "createProviderRequestPartitionFixtureInternal"))
            seen.add(relative);
} if (JSON.stringify([...seen].sort()) !== JSON.stringify([...expected].sort()))
    errors.push("fixture constructor expected-site set"); return errors; }
function auditMockConstructor(source: string): readonly string[] {
    const relative = "tests/helpers/mock-secure-transport.ts", file = parse(source, relative), errors: string[] = [...auditNetworkSource(source, relative), ...auditChildSource(source, relative).errors], outerBindings = new Set<string>();
    for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement) && !isFullyErasedTypeOnlyImport(statement))
            errors.push("mock runtime import denied");
        if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations)
                if (ts.isIdentifier(declaration.name))
                    outerBindings.add(declaration.name.text);
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.name.text !== "createMockSecureTransportCapabilities")
            outerBindings.add(statement.name.text);
    }
    let inside = false;
    const forbidden = new Set(["process", "fetch", "WebSocket", "http", "https", "http2", "net", "tls", "dns", "dgram", "require", "createRequire", "getBuiltinModule", "exec", "execFile", "spawn", "fork", "Worker", "setTimeout", "setInterval"]);
    const visit = (node: ts.Node): void => { if (ts.isFunctionDeclaration(node) && node.name?.text === "createMockSecureTransportCapabilities") {
        inside = true;
        ts.forEachChild(node, visit);
        inside = false;
        return;
    } if (ts.isIdentifier(node) && forbidden.has(node.text) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
        errors.push(`mock module capability ${node.text}`); if (inside && ts.isIdentifier(node) && outerBindings.has(node.text))
        errors.push(`mock constructor outer capture ${node.text}`); ts.forEachChild(node, visit); };
    visit(file);
    return errors;
}
declare global {
    var __PI_SCIENCE_TEST_NETWORK_GUARD__: Readonly<{
        installed: readonly string[];
        stubs: Readonly<Record<string, Function>>;
    }> | undefined;
}
const setupLoadedBeforeFixtureImport = globalThis.__PI_SCIENCE_TEST_NETWORK_GUARD__ !== undefined;
const fixtureModulePromise = import("../helpers/mock-secure-transport.js");
const setupModulePromise = import("../setup/no-network.js");
describe("default-deny test network policy", () => {
    test("loads no-network setup before a fixture module import", async () => { expect(setupLoadedBeforeFixtureImport).toBe(true); expect(await fixtureModulePromise).toHaveProperty("createMockSecureTransportCapabilities"); expect(globalThis.__PI_SCIENCE_TEST_NETWORK_GUARD__).toBeDefined(); });
    test("stubs every fetch WebSocket http https http2 client-session net tls dgram and dns entry", () => { const guard = globalThis.__PI_SCIENCE_TEST_NETWORK_GUARD__; expect(guard).toBeDefined(); expect(Object.isFrozen(guard)).toBe(true); expect(Object.keys(guard ?? {})).toEqual(["installed", "stubs"]); expect(Object.isFrozen(guard?.installed)).toBe(true); expect(Object.isFrozen(guard?.stubs)).toBe(true); expect(guard?.installed).toEqual(exactStubNames); expect(Object.keys(guard?.stubs ?? {}).sort()).toEqual([...exactStubNames].sort()); expect(globalThis.fetch).toBe(guard?.stubs["global.fetch"]); expect(globalThis.WebSocket).toBe(guard?.stubs["global.WebSocket"]); expect(new Set(Object.values(guard?.stubs ?? {})).size).toBe(1); expect(guard?.stubs["global.WebSocket"]?.prototype).toBeDefined(); });
    test("audits every stub to checked-increment then throw and afterAll to require zero", () => { const source = fs.existsSync(setupPath) ? fs.readFileSync(setupPath, "utf8") : ""; for (const name of exactStubNames)
        expect(source, name).toContain(JSON.stringify(name)); expect(source).toMatch(/Number\.isSafeInteger/u); expect(source.indexOf("attempts += 1")).toBeGreaterThanOrEqual(0); expect(source.indexOf("attempts += 1")).toBeLessThan(source.lastIndexOf('throw new Error("TEST_NETWORK_FORBIDDEN")')); expect(source).toContain('network-attempts=0\\n'); expect(auditSetupSource(parse(source, setupRelative), setupRelative)).toEqual([]); expect(source).toContain("syncBuiltinESMExports()"); expect(source).not.toMatch(/restore|ALLOW_NETWORK|NO_NETWORK|localhost|127\.0\.0\.1/u); });
    test("rejects test network imports require dynamic aliases destructuring and calls by AST", () => { for (const source of ['import http from "node:http";http.request({});', 'const h=require("https");h.get("x");', 'const spec="node:net";const n=await import(spec);n.connect();', 'await vi.importActual("node:https");', 'import {request as send} from "node:https";send({});', 'import * as d from "node:dgram";const {createSocket:make}=d;make("udp4");', 'globalThis.fetch("x");', 'const g=globalThis;g[getKey()]("x");', 'const {fetch:send}=globalThis;send("x");', 'new WebSocket("x");'])
        expect(auditNetworkSource(source).length, source).toBeGreaterThan(0); });
    test("rejects acquisition child-process alternate-network imports aliases and calls", () => { for (const source of ['import {spawn as run} from "node:child_process";run("x");', 'import net from "node:net";net.connect(1);', 'const cp=require("node:child_process");cp.exec("x");']) {
        expect(auditNetworkSource(source, "tests/acquisition/escape.test.ts").length + auditChildSource(source, "tests/acquisition/escape.test.ts").errors.length, source).toBeGreaterThan(0);
    } });
    test("rejects node module loader escapes outside the exact setup import and call", () => {
        const reviewer = 'import Module from "node:module";const {Worker}=(Module as any)._load("node:worker_threads");new Worker("void 0",{eval:true});';
        for (const source of [reviewer, 'import * as Module from "node:module";Module.createRequire(import.meta.url);', 'import {createRequire as make} from "module";make(import.meta.url);', 'const Module=await import("node:module");Module["_"+"load"]("node:worker_threads");', 'const Module=require("module/subpath");Module.register("x");', 'export {registerHooks} from "node:module";', 'import Module=require("node:module");new Module();', 'import Module from "node:module";Module._load.bind(null);', 'import * as Module from "node:module";Module.register.apply(null,args);', 'const load=process.getBuiltinModule("node:module")._load;load("node:cluster");', 'const m=false||module;m[unknownKey()]("node:worker_threads");', 'const m=globalThis.module;const load=m[unknownKey()];load("node:cluster");']) expect(auditChildSource(source, "tests/escape.test.ts").errors.length, source).toBeGreaterThan(0);
        expect(auditChildSource('import type Module from "node:module";import {type Module as ModuleType} from "module";', "tests/escape.test.ts").errors).toEqual([]);
        const setupSource = fs.readFileSync(setupPath, "utf8"); expect(auditSetupSource(parse(setupSource, setupRelative), setupRelative)).toEqual([]); expect(auditChildSource(setupSource, setupRelative).errors).toEqual([]);
        for (const malicious of [setupSource.replace('{syncBuiltinESMExports} from "node:module"', '{syncBuiltinESMExports,createRequire} from "node:module"'), setupSource.replace('from "node:module"', 'from "module"'), setupSource.replace('import {syncBuiltinESMExports}', 'import * as Module'), setupSource.replace('syncBuiltinESMExports();', 'const sync=syncBuiltinESMExports;sync();'), setupSource.replace('syncBuiltinESMExports();', 'syncBuiltinESMExports();syncBuiltinESMExports();')]) { expect(malicious).not.toBe(setupSource); expect(auditSetupSource(parse(malicious, setupRelative), setupRelative).length, malicious).toBeGreaterThan(0); }
    });
    test("rejects worker-thread and cluster runtime escapes while preserving erased types and source strings", () => {
        const workerPayload = 'require("node:https").get("https://example.invalid")';
        for (const source of [`import {Worker} from "node:worker_threads";new Worker(${JSON.stringify(workerPayload)},{eval:true});`, 'import {Worker as W} from "worker_threads";new W("void 0",{eval:true});', 'const {Worker:W}=await import("node:worker_threads");new W("void 0",{eval:true});', 'const wt=process.getBuiltinModule("node:worker_threads");wt.receiveMessageOnPort(port);', 'const wt=require("worker_threads/subpath");wt.Worker;', 'import cluster from "node:cluster";cluster.fork();', 'export {Worker} from "node:worker_threads";', 'import wt=require("node:worker_threads");wt.Worker;']) expect(auditChildSource(source, "tests/escape.test.ts").errors.length, source).toBeGreaterThan(0);
        expect(auditChildSource('import type {Worker} from "node:worker_threads";import {type Cluster} from "node:cluster";', "tests/escape.test.ts").errors).toEqual([]);
        expect(workerPayload).toContain("https://example.invalid");
    });
    test("derives loader roots from shared values through global process aliases wrappers and objects", () => {
        const reviewer = 'const key=["get","Builtin","Module"].join("");(globalThis.process as any)[key]("node:child_process").execFileSync("x");';
        const attacks = [reviewer, 'const key=getKey();global["process"][key]("node:child_process");', 'const p=condition?globalThis.process:global["process"];p[unknownKey()]("node:child_process");', 'const box={nested:{p:(globalThis.process as any)}};box.nested.p[unknownKey()]("node:child_process");', 'const p=((globalThis.process as any)!);p.getBuiltinModule("node:child_process");', 'const m=globalThis[unknownKey()];m("node:module");'];
        for (const source of attacks) expect(auditChildSource(source, "tests/escape.test.ts").errors.length, source).toBeGreaterThan(0);
        for (const source of ['void process.platform;', 'void process.env.PATH;', 'void globalThis.process.platform;', 'void global["process"]["platform"];']) expect(auditChildSource(source, "tests/safe.test.ts").errors, source).toEqual([]);
    });
    test("propagates logical computed-key and closure child capabilities without poisoning safe expressions", () => {
        const attacks = ['const p=false||process;const key="xgetBuiltinModule".slice(1);const {[key]:load}=p;load("node:child_process").exec("x");', 'const p=undefined??process;const key=getKey();const {[key]:load}=p;load("node:child_process");', 'const p=(safe,process);const {[unknownKey()]:load}=p;load("node:child_process");', 'const wrap=()=>process;const p=wrap();const key="getBuiltinModule";const {[key]:load}=p;load("node:child_process");', 'function wrap(){return process}const p=wrap();const {[unknownKey()]:load}=p;load("node:child_process");'];
        for (const source of attacks) expect(auditChildSource(source, "tests/escape.test.ts").errors.length, source).toBeGreaterThan(0);
        for (const source of ['const x=false||safe;void x;', 'const key="prefix".slice(1);const box={refix:1};void box[key];', 'const result=ordinaryCall(value);void result;', 'const choose=condition?left:right;void choose;']) expect(auditChildSource(source, "tests/safe.test.ts").errors, source).toEqual([]);
    });
    test("allows only audited setup and type-only erased imports", () => { expect(auditNetworkSource('import type {RequestOptions} from "node:https";import {type Socket} from "node:net";')).toEqual([]); expect(auditNetworkTree()).toEqual([]); });
    test("allows exactly npm-pack and nested-local-Vitest subprocess calls with exact args shell false sanitized env", () => { const audit = auditChildTree(); expect(audit.errors).toEqual([]); expect(audit.sites).toEqual(["tests/package.test.ts:execFile", "tests/storage/run-root.test.ts:spawn"]); });
    test("rejects every other child process shell true URL argument env spread proxy CA key credential forwarding", () => { for (const source of ['import {execFile} from "node:child_process";execFile("npm",["pack"],{shell:true,env:{...process.env}},()=>{});', 'import {spawn} from "node:child_process";spawn("curl",["https://example.invalid"],{shell:false,env:{HTTPS_PROXY:"x"}});', 'const cp=require("child_process");cp.fork("x");', 'await vi.importActual("node:child_process");', 'const p=process,key="getBuiltinModule";p[key]("node:child_process").exec("x");','process.getBuiltinModule("node:child_process").exec("x");','import {execFile} from "node:child_process";execFile(npmExecutable,["pack","--dry-run","--json","--ignore-scripts"],{cwd:projectRoot,shell:false,env:{},...unsafe},()=>{});','import {spawn} from "node:child_process";spawn(process.execPath,[resolve(import.meta.dirname,"../../node_modules/vitest/vitest.mjs"),"run","--root",root,"child.test.ts"],{cwd:root,shell:false,env:{},stdio:["pipe","pipe","pipe"]});'])
        expect(auditChildSource(source, "tests/escape.test.ts").errors.length, source).toBeGreaterThan(0); });
    test("permits partition fixture constructor calls only in four adapter unit-test files", () => { const allowed = ["crossref", "openalex", "pubmed", "pmc"].map((name) => `tests/acquisition/${name}.test.ts`); expect(auditFixtureTree()).toEqual([]); for (const relative of allowed) {
        const source = fs.readFileSync(path.join(root, relative), "utf8");
        expect(auditFixtureConstructor(source, relative)).toEqual([]);
    } expect(auditFixtureConstructor('import {createProviderRequestPartitionFixtureInternal} from "../../src/acquisition/contracts.js";createProviderRequestPartitionFixtureInternal(value);', "tests/helpers/escape.ts").length).toBeGreaterThan(0); expect(auditFixtureConstructor('export {createProviderRequestPartitionFixtureInternal} from "../../src/acquisition/contracts.js";', "tests/acquisition/crossref.test.ts").length).toBeGreaterThan(0); });
    test("proves mock secure transport constructor contains no real socket or process function", () => { const source = fs.readFileSync(path.join(root, "tests/helpers/mock-secure-transport.ts"), "utf8"); expect(auditMockConstructor(source)).toEqual([]); expect(source).not.toMatch(/from\s+["'](?:node:)?(?:http|https|http2|net|tls|dns|dgram|child_process)["']/u); });
    test("regresses reachable HTTP2 session stubs with isolated exact counter behavior", async () => {
        const setup = await setupModulePromise as unknown as {
            createIsolatedNetworkStubInternal: () => {
                stub: Function;
                attempts: () => number;
            };
            getInstalledHttp2ClientSessionMethodsInternal: () => Readonly<{
                request: Function;
                ping: Function;
                settings: Function;
            }>;
        };
        const isolated = setup.createIsolatedNetworkStubInternal();
        for (const invoke of [() => isolated.stub(), () => Reflect.construct(isolated.stub, [])]) {
            const before = isolated.attempts();
            expect(invoke).toThrowError(new Error("TEST_NETWORK_FORBIDDEN"));
            expect(isolated.attempts()).toBe(before + 1);
        }
        const methods = setup.getInstalledHttp2ClientSessionMethodsInternal(), guard = globalThis.__PI_SCIENCE_TEST_NETWORK_GUARD__!;
        expect(methods).toEqual({ request: guard.stubs["http2.session.request"], ping: guard.stubs["http2.session.ping"], settings: guard.stubs["http2.session.settings"] });
    });
    test("regresses setup allowlist exports assignment destructuring and computed network escapes", () => { for (const source of ['const box={fetch:globalThis.fetch};let send;({fetch:send}=box);send("x")','const wrapped={...{nested:{send:globalThis.fetch}}};let send;({nested:{send}}=wrapped);send("x")','let later,box;({fetch:later}=box);box={fetch:globalThis.fetch};later("x")','export {request} from "node:http";', 'let send;({fetch:send}=globalThis);send("x");', 'let g;g=((globalThis as any)!);let send;({fetch:send}=(g));send.call(null,"x");', 'const send=globalThis.fetch;send.bind(null);', 'const g=(globalThis as typeof globalThis);let send;({[getKey()]:send}=g);send("x");'])
        expect(auditNetworkSource(source).length, source).toBeGreaterThan(0); expect(auditNetworkSource('import undici from "undici";void undici;', setupRelative, true).length).toBeGreaterThan(0); });
    test("regresses repository child exports aliases and exact subprocess provenance", () => { expect(auditChildSource('export * from "node:child_process";', "src/escape.ts").errors.length).toBeGreaterThan(0); const source = 'import {spawn} from "node:child_process";spawn(process.execPath,[resolve(import.meta.dirname,"../../node_modules/vitest/vitest.mjs"),"run","--root",root,"child.test.ts","extra"],{cwd:root,shell:false,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,PATHEXT:process.env.PATHEXT,HOME:root,TMPDIR:root,TMP:root,TEMP:root,BARRIER:environment.BARRIER,PROJECT:environment.PROJECT,RUN_ID:environment.RUN_ID,TOKEN:environment.TOKEN,RESULT:environment.RESULT}});'; expect(auditChildSource(source, "tests/storage/run-root.test.ts").errors.length).toBeGreaterThan(0); for (const bypass of ['import {execFile} from "node:child_process";const run=execFile;wrap(run);', 'import * as child from "node:child_process";const {spawn:run}=child;run("x");', 'const p=process,key="getBuiltinModule";p[key]("node:child_process").exec("x");','process.getBuiltinModule("node:child_process").exec("x");','import {execFile} from "node:child_process";execFile(npmExecutable,["pack","--dry-run","--json","--ignore-scripts"],{cwd:projectRoot,shell:false,env:{},...unsafe},()=>{});','import {spawn} from "node:child_process";spawn(process.execPath,[resolve(import.meta.dirname,"../../node_modules/vitest/vitest.mjs"),"run","--root",root,"child.test.ts"],{cwd:root,shell:false,env:{},stdio:["pipe","pipe","pipe"]});'])
        expect(auditChildSource(bypass, "tests/package.test.ts").errors.length, bypass).toBeGreaterThan(0); });
    test("regresses tree-wide fixture confinement and mock outer capability captures", () => { for (const bypass of ['import {createProviderRequestPartitionFixtureInternal as fixture} from "../../src/acquisition/contracts.js";fixture(value);', 'import * as fixtures from "../../src/acquisition/contracts.js";fixtures["createProviderRequestPartitionFixtureInternal"](value);', 'const fixtures=await import("../../src/acquisition/contracts.js");fixtures.createProviderRequestPartitionFixtureInternal(value);', 'import {createProviderRequestPartitionFixtureInternal} from "../../src/acquisition/contracts.js";void createProviderRequestPartitionFixtureInternal;'])
        expect(auditFixtureConstructor(bypass, "tests/acquisition/crossref.test.ts").length, bypass).toBeGreaterThan(0); const captured = 'const box={realFetch:globalThis["fet"+"ch"]};const {realFetch}=box;export function createMockSecureTransportCapabilities(){return {send:()=>realFetch("x")};}'; expect(auditMockConstructor(captured).length).toBeGreaterThan(0); });
    test("regresses fully erased type-only imports consistently across audits", () => { expect(auditChildSource('import type {ChildProcess} from "node:child_process";', "tests/fixture.test.ts").errors).toEqual([]); expect(auditNetworkSource('import type {RequestOptions} from "node:https";import {type Socket} from "node:net";')).toEqual([]); expect(auditNetworkSource('import {type Socket,connect} from "node:net";void connect;').length).toBeGreaterThan(0); expect(auditNetworkSource('export {type Socket} from "node:net";')).toEqual([]); });
    test("fails closed when capability analysis complexity bounds are reached", () => {
        const nested = (leaf: string): string => Array.from({ length: 40 }, (_, index) => `level${index}`).reduceRight((value, key) => `{${key}:${value}}`, leaf);
        const destructure = Array.from({ length: 40 }, (_, index) => `level${index}`).reduceRight((value, key) => `{${key}:${value}}`, "{fetch:send}");
        expect(auditNetworkSource(`const box=${nested("{fetch:globalThis.fetch}")};let send;(${destructure}=box);send(\"x\")`).length).toBeGreaterThan(0);
        expect(auditChildSource(`const box=${nested("{load:process.getBuiltinModule}")};wrap(box);`, "tests/escape.test.ts").errors.length).toBeGreaterThan(0);
        expect(auditFixtureConstructor(`const box=${nested("{fixture:(await import(\"../../src/acquisition/contracts.js\")).createProviderRequestPartitionFixtureInternal}")};wrap(box);`, "tests/escape.test.ts").length).toBeGreaterThan(0);
        expect(auditMockConstructor(`const box=${nested("{send:globalThis.fetch}")};export function createMockSecureTransportCapabilities(){return box;}`).length).toBeGreaterThan(0);
    });
    test("requires the canonical package subprocess to execute a fixed installation-relative npm CLI with Node", () => {
        const relative = "tests/package.test.ts", source = fs.readFileSync(path.join(root, relative), "utf8");
        expect(source).toContain('execFile(process.execPath,[npmCliPath,"pack","--dry-run","--json","--ignore-scripts"]');
        expect(source).not.toMatch(/npmExecutable|"npm\.cmd"|\?\s*"npm"/u); expect(auditChildSource(source, relative).errors).toEqual([]);
        for (const malicious of [source.replace("process.execPath,[npmCliPath", '"npm.cmd",[npmCliPath'), source.replace('"node_modules","npm","bin","npm-cli.js"', '"node_modules","evil","bin","npm-cli.js"'), source.replace("execFile(process.execPath", "execFile(process.env.ComSpec")]) {
            expect(malicious).not.toBe(source); expect(auditChildSource(malicious, relative).errors.length, malicious).toBeGreaterThan(0);
        }
    });
    test("suppresses only the exact canonical allowlisted child callee expression", () => {
        const packageRelative = "tests/package.test.ts", runRootRelative = "tests/storage/run-root.test.ts";
        const packageSource = fs.readFileSync(path.join(root, packageRelative), "utf8"), runRootSource = fs.readFileSync(path.join(root, runRootRelative), "utf8");
        expect(auditChildSource(packageSource, packageRelative).errors).toEqual([]); expect(auditChildSource(runRootSource, runRootRelative).errors).toEqual([]);
        const malicious = 'const key="getBuiltinModule";const {[key]:load}=process;load("node:child_process").exec("x");';
        const maliciousCallback = packageSource.replace("(error,output)=>{if(error)", `(error,output)=>{${malicious}if(error)`);
        expect(maliciousCallback).not.toBe(packageSource); expect(auditChildSource(maliciousCallback, packageRelative).errors.length).toBeGreaterThan(0);
        const maliciousSpawnOption = runRootSource.replace("cwd:root,shell:false,", `cwd:(()=>{${malicious}return root;})(),shell:false,`);
        expect(maliciousSpawnOption).not.toBe(runRootSource); expect(auditChildSource(maliciousSpawnOption, runRootRelative).errors.length).toBeGreaterThan(0);
        for (const source of ['import {execFile} from "node:child_process";execFile.bind(null);', 'import {spawn} from "node:child_process";const box={run:spawn};box.run("x");']) expect(auditChildSource(source, packageRelative).errors.length, source).toBeGreaterThan(0);
    });
    test("confines pinned runtime retention observation to the exact lifecycle test",()=>{const symbol="getPinnedHopRuntimeRetentionCountsInternal",sites:string[]=[];for(const filePath of [...enumerate(path.join(root,"tests")),...enumerate(path.join(root,"src")),...enumerate(path.join(root,"extensions"))]){const relative=path.relative(root,filePath).replaceAll("\\","/"),source=fs.readFileSync(filePath,"utf8"),file=ts.createSourceFile(relative,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);for(const statement of file.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings)&&statement.importClause.namedBindings.elements.some(item=>!item.isTypeOnly&&(item.propertyName??item.name).text===symbol))sites.push(`${relative}:${statement.moduleSpecifier.text}`);}expect(sites).toEqual(["tests/acquisition/node-pinned-hop.test.ts:../../src/acquisition/node-pinned-hop-internal.js"]);});
    test("confines lock retention observation to the exact lifecycle test",()=>{const symbols=new Set(["createResearchRunLockRetentionObserverInternal","getResearchRunLockRetentionCountsInternal"]),sites:string[]=[];for(const filePath of [...enumerate(path.join(root,"tests")),...enumerate(path.join(root,"src")),...enumerate(path.join(root,"extensions"))]){const relative=path.relative(root,filePath).replaceAll("\\","/"),source=fs.readFileSync(filePath,"utf8"),file=ts.createSourceFile(relative,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);for(const statement of file.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings))for(const item of statement.importClause.namedBindings.elements){const name=(item.propertyName??item.name).text;if(!item.isTypeOnly&&symbols.has(name))sites.push(`${name}:${relative}:${statement.moduleSpecifier.text}`);}}expect(sites.sort()).toEqual(["createResearchRunLockRetentionObserverInternal:tests/storage/run-lock.test.ts:../../src/storage/run-lock-internal.js","getResearchRunLockRetentionCountsInternal:tests/storage/run-lock.test.ts:../../src/storage/run-lock-internal.js"]);});
    test("allows only the two exact setup function declaration exports", () => {
        const setupSource = fs.readFileSync(setupPath, "utf8");
        for (const declaration of ["export const unexpected=1;", "export class Unexpected{}", "export type Unexpected=string;", "export interface Unexpected{}", "export default function unexpected(){}"])
            expect(auditNetworkSource(`${setupSource}\n${declaration}`, setupRelative, true).length, declaration).toBeGreaterThan(0);
    });
});
