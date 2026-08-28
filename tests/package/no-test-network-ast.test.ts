import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { Capability, createCapabilityAnalysis, isFullyErasedTypeOnlyExport, isFullyErasedTypeOnlyImport, moduleCapabilityKind, unwrapExpression } from "./test-capability-analysis.js";
const root = path.resolve(import.meta.dirname, "../..");
const setupRelative = "tests/setup/no-network.ts";
const setupPath = path.join(root, setupRelative);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const networkModules = new Set(["http", "https", "http2", "net", "tls", "dns", "dns/promises", "dgram", "undici", "node-fetch", "cross-fetch", "ws", "axios", "got", "superagent", "openai", "@aws-sdk"]);
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
function specifierKind(value: string): "network" | "child" | null { const bare = value.startsWith("node:") ? value.slice(5) : value; if (bare === "child_process" || bare.startsWith("child_process/"))
    return "child"; for (const name of networkModules)
    if (bare === name || bare.startsWith(`${name}/`))
        return "network"; return null; }
function staticString(expression: ts.Expression): string | undefined { const value = unwrapExpression(expression); if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    return value.text; if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(value.left), right = staticString(value.right);
    return left === undefined || right === undefined ? undefined : left + right;
} return undefined; }
function findingSet(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort()); }
function auditSetupSource(file: ts.SourceFile, relative: string): readonly string[] {
    const errors: string[] = [];
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
    if(analysis.operations.some(operation=>directGlobal(operation.source)&&!ts.isIdentifier(operation.pattern)))potential=true;const hasNetworkSyntax=(node:ts.Node):boolean=>{let found=false;const visit=(item:ts.Node):void=>{if(found)return;if(ts.isPropertyAccessExpression(item)&&["fetch","WebSocket"].includes(item.name.text)&&directGlobal(item.expression))found=true;if(ts.isElementAccessExpression(item)&&directGlobal(item.expression))found=true;if(ts.isIdentifier(item)&&["fetch","WebSocket"].includes(item.text)){const parent=item.parent;if((ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.expression===item)found=true;}ts.forEachChild(item,visit);};visit(node);return found;};const dangerous=(node:ts.Node,value:ReturnType<typeof analysis.value>):boolean=>analysis.contains(value,Capability.network)&&(value.flags!==31||hasNetworkSyntax(node));
    const detect = (node: ts.Node): void => { if (ts.isImportEqualsDeclaration(node)) potential = true; if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && moduleCapabilityKind(node.moduleSpecifier.text) === "network") potential = true; if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyImport(node) && moduleCapabilityKind(node.moduleSpecifier.text) === "network") potential = true; if(ts.isIdentifier(node)&&["fetch","WebSocket"].includes(node.text)){const parent=node.parent;if((ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.expression===node)potential=true;}if(ts.isPropertyAccessExpression(node)&&["fetch","WebSocket"].includes(node.name.text)&&directGlobal(node.expression))potential=true;if(ts.isElementAccessExpression(node)&&directGlobal(node.expression))potential=true;if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&directGlobal(node.right)&&ts.isObjectLiteralExpression(unwrapExpression(node.left as ts.Expression)))potential=true;if(ts.isIdentifier(node)&&node.text==="require")potential=true;if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isPropertyAccessExpression(node.expression)&&["importActual","importMock"].includes(node.expression.name.text)))){const argument=node.arguments[0];if(!argument||!ts.isStringLiteral(argument)||moduleCapabilityKind(argument.text)==="network")potential=true;} ts.forEachChild(node, detect); };
    detect(analysis.file);
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
            if (dangerous(node.expression,analysis.value(node.expression)))
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
function exactNpmExecutable(expression: ts.Expression | undefined): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); if (!ts.isConditionalExpression(value) || !ts.isBinaryExpression(value.condition) || value.condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return false; return exactProcessMember(value.condition.left, "platform") && ts.isStringLiteral(value.condition.right) && value.condition.right.text === "win32" && ts.isStringLiteral(value.whenTrue) && value.whenTrue.text === "npm.cmd" && ts.isStringLiteral(value.whenFalse) && value.whenFalse.text === "npm"; }
function exactImportMetaDirname(expression: ts.Expression | undefined): boolean { if (!expression)
    return false; const value = unwrapExpression(expression); return ts.isPropertyAccessExpression(value) && value.name.text === "dirname" && ts.isMetaProperty(value.expression) && value.expression.keywordToken === ts.SyntaxKind.ImportKeyword && value.expression.name.text === "meta"; }
function auditChildSource(source: string, relative: string): ChildAudit {
    const analysis = createCapabilityAnalysis(source, relative), file = analysis.file, errors: string[] = [], sites: string[] = [], candidateCalls: ts.CallExpression[] = [];
    let childImport: string | null = null, childImportCount = 0;
    const imports = new Set<string>(), initializers = new Map<string, ts.Expression>(), childSources = new Map<string, ts.Expression[]>();
    for (const statement of file.statements)
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !isFullyErasedTypeOnlyImport(statement) && specifierKind(statement.moduleSpecifier.text) === "child") {
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
    const processRoots = new Set(["process"]);
    const resolvesProcess = (value: ts.Expression): boolean => { const current = unwrapExpression(value); if (ts.isIdentifier(current))
        return processRoots.has(current.text); return ts.isPropertyAccessExpression(current) && current.name.text === "process" && ts.isIdentifier(unwrapExpression(current.expression)) && ["globalThis", "global"].includes((unwrapExpression(current.expression) as ts.Identifier).text); };
    for (let pass = 0; pass <= childSources.size; pass += 1) {
        let changed = false;
        for (const [name, values] of childSources)
            if (!processRoots.has(name) && values.some(resolvesProcess)) {
                processRoots.add(name);
                changed = true;
            }
        if (!changed)
            break;
    }
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
        if (ts.isPropertyAccessExpression(node) && ["require", "createRequire", "getBuiltinModule"].includes(node.name.text))
            errors.push(`${relative}: loader property capability denied`);
        if (ts.isElementAccessExpression(node) && node.argumentExpression) {
            const keyValue = analysis.value(node.argumentExpression), base = unwrapExpression(node.expression), dangerousRoot = ts.isIdentifier(base) && (["module", "globalThis", "global"].includes(base.text) || processRoots.has(base.text));
            if ([...keyValue.strings].some((key) => ["require", "createRequire", "getBuiltinModule"].includes(key)) || ((keyValue.unknownString || keyValue.strings.size === 0) && dangerousRoot))
                errors.push(`${relative}: computed loader capability denied`);
        }
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
                    const executable = node.arguments[0], initializer = initializers.get("npmExecutable");
                    if (node.arguments.length !== 4 || !executable || !ts.isIdentifier(executable) || executable.text !== "npmExecutable" || !exactNpmExecutable(initializer) || !ts.isFunctionLike(node.arguments[3]!))
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
                        const expected = ["pack", "--dry-run", "--json", "--ignore-scripts"];
                        if (JSON.stringify(args.elements.map((item) => ts.isStringLiteral(item) ? item.text : "<dynamic>")) !== JSON.stringify(expected))
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
    let capabilityAnalysis = analysis;
    if (errors.length === 0 && candidateCalls.length === 1) {
        const candidate = candidateCalls[0]!, width = candidate.end - candidate.getStart(file);
        const masked = `${source.slice(0, candidate.getStart(file))}undefined${" ".repeat(Math.max(0, width - "undefined".length))}${source.slice(candidate.end)}`;
        capabilityAnalysis = createCapabilityAnalysis(masked, relative);
    }
    let childPotential = false, hasProcessRoot = false, hasComputedPattern = false;
    const detectChild = (node: ts.Node): void => { if(ts.isIdentifier(node)&&node.text==="process")hasProcessRoot=true;if(ts.isComputedPropertyName(node)&&(ts.isPropertyAssignment(node.parent)||ts.isBindingElement(node.parent)))hasComputedPattern=true; if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isFullyErasedTypeOnlyImport(node) && moduleCapabilityKind(node.moduleSpecifier.text) === "child") { const named=node.importClause?.namedBindings;const item=named&&ts.isNamedImports(named)&&named.elements.length===1?named.elements[0]:undefined;const exactApproved=node.moduleSpecifier.text==="node:child_process"&&!node.importClause?.name&&item&&!item.propertyName&&((relative==="tests/package.test.ts"&&item.name.text==="execFile")||(relative==="tests/storage/run-root.test.ts"&&item.name.text==="spawn"));if(!exactApproved)childPotential=true; } if (ts.isIdentifier(node) && ["require", "getBuiltinModule", "createRequire"].includes(node.text)) childPotential = true; if (ts.isPropertyAccessExpression(node) && ["require", "getBuiltinModule", "createRequire"].includes(node.name.text)) childPotential = true; if (ts.isElementAccessExpression(node)) { const base = unwrapExpression(node.expression); if (ts.isIdentifier(base) && (processRoots.has(base.text) || ["module", "globalThis", "global"].includes(base.text))) childPotential = true; } ts.forEachChild(node, detectChild); };
    detectChild(capabilityAnalysis.file);
    childPotential = childPotential || (hasProcessRoot && hasComputedPattern);
    if (childPotential) for (const operation of capabilityAnalysis.operations) if (capabilityAnalysis.contains(capabilityAnalysis.value(operation.source), Capability.child)) errors.push(capabilityAnalysis.location(operation.node, "child capability storage"));
    const capabilityVisit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            if (capabilityAnalysis.contains(capabilityAnalysis.value(node.expression), Capability.child)) errors.push(capabilityAnalysis.location(node, "child capability call"));
            for (const argument of node.arguments) if (capabilityAnalysis.contains(capabilityAnalysis.value(argument), Capability.child)) errors.push(capabilityAnalysis.location(argument, "child capability escape"));
        }
        if (ts.isNewExpression(node) && capabilityAnalysis.contains(capabilityAnalysis.value(node.expression), Capability.child)) errors.push(capabilityAnalysis.location(node, "child capability construct"));
        if (ts.isReturnStatement(node) && node.expression && capabilityAnalysis.contains(capabilityAnalysis.value(node.expression), Capability.child)) errors.push(capabilityAnalysis.location(node, "child capability return"));
        ts.forEachChild(node, capabilityVisit);
    };
    if (childPotential) capabilityVisit(capabilityAnalysis.file);
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
    test("suppresses only the exact canonical allowlisted child call node", () => {
        const bypass = 'const key="getBuiltinModule";const {[key]:load}=process;load("node:child_process").exec("x")';
        for (const relative of ["tests/package.test.ts", "tests/storage/run-root.test.ts"]) expect(auditChildSource(bypass, relative).errors.length, relative).toBeGreaterThan(0);
        for (const source of ['import {execFile} from "node:child_process";execFile.bind(null);', 'import {spawn} from "node:child_process";const box={run:spawn};box.run("x");']) expect(auditChildSource(source, "tests/package.test.ts").errors.length, source).toBeGreaterThan(0);
    });
    test("allows only the two exact setup function declaration exports", () => {
        const setupSource = fs.readFileSync(setupPath, "utf8");
        for (const declaration of ["export const unexpected=1;", "export class Unexpected{}", "export type Unexpected=string;", "export interface Unexpected{}", "export default function unexpected(){}"])
            expect(auditNetworkSource(`${setupSource}\n${declaration}`, setupRelative, true).length, declaration).toBeGreaterThan(0);
    });
});
