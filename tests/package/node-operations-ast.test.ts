import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const root=path.resolve(import.meta.dirname,"../..");
const adapterPath=path.join(root,"src/acquisition/node-pinned-hop-internal.ts");
const allowedNodeImports=new Set(["node:dns/promises","node:http","node:https","node:tls","node:timers","node:perf_hooks","node:util"]);
const requiredNetworkImports=new Set(["node:dns/promises","node:http","node:https","node:tls","node:timers","node:perf_hooks"]);
const requestOptionKeys=new Set(["agent","headers","setHost","servername","ca","rejectUnauthorized","maxHeaderSize","insecureHTTPParser","joinDuplicateHeaders","lookup","checkServerIdentity"]);
const exactImportBindings=new Map<string,readonly string[]>([
  ["node:dns/promises",["Resolver"]],["node:http",["http"]],["node:https",["https"]],["node:tls",["tls"]],
  ["node:timers",["nodeClearTimeout","nodeSetTimeout"]],["node:perf_hooks",["nodePerformance"]],["node:util",["utilTypes"]],
]);
const exactImportedMembers=new Map<string,readonly string[]>([
  ["http",["Agent","request"]],["https",["Agent","request"]],
  ["tls",["checkServerIdentity","rootCertificates"]],["nodePerformance",["now"]],
]);

function auditAdapter(source:string):string[]{
  const file=ts.createSourceFile("adapter.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const errors:string[]=[];let strictHeaders=false;let exactCa=false;let sharedDestroy=false;let constructsResolver=false;const realResolverMembers=new Set<string>();const imports=new Set<string>();const importCounts=new Map<string,number>();const importedMembers=new Map<string,Set<string>>();const dangerousAliases=new Set(["require","fetch"]);
  const visit=(node:ts.Node):void=>{
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const specifier=node.moduleSpecifier.text;
      if(specifier.startsWith("node:")){
        imports.add(specifier);importCounts.set(specifier,(importCounts.get(specifier)??0)+1);if(!allowedNodeImports.has(specifier))errors.push(`forbidden import ${specifier}`);
        const actual:string[]=[];const clause=node.importClause;if(clause?.name)actual.push(clause.name.text);const bindings=clause?.namedBindings;if(bindings&&ts.isNamedImports(bindings))for(const element of bindings.elements)actual.push(element.name.text);
        const expected=exactImportBindings.get(specifier);if(expected&&JSON.stringify(actual.sort())!==JSON.stringify([...expected].sort()))errors.push(`import binding ${specifier}`);
      }
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer){
      if(ts.isIdentifier(node.initializer)&&dangerousAliases.has(node.initializer.text))dangerousAliases.add(node.name.text);
      if(ts.isPropertyAccessExpression(node.initializer)&&ts.isIdentifier(node.initializer.expression)&&node.initializer.expression.text==="globalThis"&&node.initializer.name.text==="fetch")dangerousAliases.add(node.name.text);
      if(ts.isElementAccessExpression(node.initializer)&&ts.isIdentifier(node.initializer.expression)&&node.initializer.expression.text==="globalThis"&&ts.isStringLiteral(node.initializer.argumentExpression)&&node.initializer.argumentExpression.text==="fetch")dangerousAliases.add(node.name.text);
    }
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&exactImportedMembers.has(node.expression.text)){
      const members=importedMembers.get(node.expression.text)??new Set<string>();members.add(node.name.text);importedMembers.set(node.expression.text,members);
    }
    if(ts.isIdentifier(node)&&["globalAgent","createConnection","WebSocket","EventSource","eval","Function","process"].includes(node.text))errors.push(`forbidden identifier ${node.text}`);
    if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push("dynamic import");
      if(ts.isIdentifier(node.expression)&&dangerousAliases.has(node.expression.text))errors.push(`forbidden call ${node.expression.text}`);
      if(ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="globalThis"&&node.expression.name.text==="fetch")errors.push("forbidden call fetch");
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="realNodeOperations"&&node.initializer){const inspect=(child:ts.Node):void=>{if(ts.isNewExpression(child)&&ts.isIdentifier(child.expression)&&child.expression.text==="Resolver")constructsResolver=true;if(ts.isPropertyAccessExpression(child)&&ts.isIdentifier(child.expression)&&child.expression.text==="resolver")realResolverMembers.add(child.name.text);ts.forEachChild(child,inspect);};inspect(node.initializer);}
    if(ts.isReturnStatement(node)&&node.expression&&ts.isObjectLiteralExpression(node.expression)){const methods=new Map<string,string>();for(const property of node.expression.properties){if(ts.isPropertyAssignment(property)&&ts.isIdentifier(property.name)&&ts.isIdentifier(property.initializer))methods.set(property.name.text,property.initializer.text);}if(methods.get("abort")==="destroyOnce"&&methods.get("destroy")==="destroyOnce")sharedDestroy=true;}
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="requestOptions"&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)){
      const keys=new Set(node.initializer.properties.flatMap((property)=>{
        if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property)&&!ts.isMethodDeclaration(property))return [];
        const name=property.name;return ts.isIdentifier(name)||ts.isStringLiteral(name)?[name.text]:[];
      }));
      if(node.initializer.properties.length!==requestOptionKeys.size||keys.size!==requestOptionKeys.size||[...requestOptionKeys].some((key)=>!keys.has(key)))errors.push("request option shape");
      for(const property of node.initializer.properties){if(!ts.isPropertyAssignment(property)||!ts.isIdentifier(property.name))continue;if(property.name.text==="ca")exactCa=ts.isPropertyAccessExpression(property.initializer)&&ts.isIdentifier(property.initializer.expression)&&property.initializer.expression.text==="options"&&property.initializer.name.text==="ca";if(property.name.text==="headers"&&ts.isArrayLiteralExpression(property.initializer)){const elements=property.initializer.elements;const hostTuple=ts.isAsExpression(elements[1]!)?elements[1]!.expression:elements[1]!;strictHeaders=elements.length===2&&ts.isSpreadElement(elements[0]!)&&ts.isArrayLiteralExpression(hostTuple)&&hostTuple.elements.length===2&&ts.isStringLiteral(hostTuple.elements[0]!)&&hostTuple.elements[0]!.text==="Host"&&ts.isPropertyAccessExpression(hostTuple.elements[1]!)&&hostTuple.elements[1]!.name.text==="hostHeader";}}
      if(!strictHeaders)errors.push("strict Host injection");if(!exactCa)errors.push("exact CA identity");
    }
    ts.forEachChild(node,visit);
  };
  visit(file);
  for(const required of requiredNetworkImports){if(!imports.has(required))errors.push(`missing import ${required}`);if((importCounts.get(required)??0)!==1)errors.push(`import count ${required}`);}
  for(const [binding,expected] of exactImportedMembers){const actual=[...(importedMembers.get(binding)??new Set())].sort();if(JSON.stringify(actual)!==JSON.stringify([...expected].sort()))errors.push(`member use ${binding}`);}
  if(!sharedDestroy)errors.push("request destroy path");
  if(!constructsResolver||JSON.stringify([...realResolverMembers].sort())!==JSON.stringify(["cancel","resolve4","resolve6"]))errors.push("resolver adapter usage");
  if(source.includes("Object.fromEntries"))errors.push("header map override");
  if(/ca\s*:\s*\[\.\.\./u.test(source))errors.push("CA clone");
  for(const [code,mapping] of [["HPE_HEADER_OVERFLOW","header-overflow"],["HPE_UNEXPECTED_CONTENT_LENGTH","unexpected-content-length"],["HPE_INVALID_CONTENT_LENGTH","unexpected-content-length"],["HPE_INVALID_TRANSFER_ENCODING","unexpected-content-length"],["HPE_INVALID_HEADER_TOKEN","invalid-header-token"],["HPE_INVALID_CHUNK_SIZE","invalid-chunk"],["HPE_INVALID_VERSION","invalid-version"],["HPE_INVALID_STATUS","invalid-status"]] as const){if(!source.includes(code)||!source.includes(mapping))errors.push(`missing parser map ${code}`);}
  if(!source.includes('startsWith("HPE_")'))errors.push("missing HPE fallback");
  return errors;
}

describe("Node operations adapter audit",()=>{
  test("audits sole real Node adapter imports methods and approved request options by TypeScript AST",()=>{
    const source=fs.readFileSync(adapterPath,"utf8");expect(auditAdapter(source)).toEqual([]);
    const acquisitionFiles=fs.readdirSync(path.join(root,"src/acquisition")).filter((name)=>name.endsWith(".ts")&&name!==path.basename(adapterPath));
    for(const file of acquisitionFiles){const parsed=ts.createSourceFile(file,fs.readFileSync(path.join(root,"src/acquisition",file),"utf8"),ts.ScriptTarget.Latest,true);const imports:string[]=[];const visit=(node:ts.Node):void=>{if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&requiredNetworkImports.has(node.moduleSpecifier.text))imports.push(node.moduleSpecifier.text);if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)imports.push("dynamic");ts.forEachChild(node,visit);};visit(parsed);expect(imports,file).toEqual([]);}
  });

  test("rejects malicious hidden imports aliases forbidden identifiers and weakened request options",()=>{
    const base=fs.readFileSync(adapterPath,"utf8");
    expect(auditAdapter(`${base}\nimport net from "node:net";`)).toContain("forbidden import node:net");
    expect(auditAdapter(`${base}\nimport hiddenHttp from "node:http";void hiddenHttp.request;`)).toContain("import binding node:http");
    expect(auditAdapter(`${base}\nvoid import("node:https");`)).toContain("dynamic import");
    expect(auditAdapter(`${base}\nconst hidden=require;hidden("node:http");`)).toContain("forbidden call hidden");
    expect(auditAdapter(`${base}\nconst hiddenFetch=globalThis.fetch;hiddenFetch("https://example.invalid");`)).toContain("forbidden call hiddenFetch");
    expect(auditAdapter(base.replace("const requestOptions={","const requestOptions={agent:undefined,"))).toContain("request option shape");
    expect(auditAdapter(base.replace("ca:options.ca","ca:[...options.ca]"))).toContain("CA clone");
    expect(auditAdapter(base.replace("abort:destroyOnce,destroy:destroyOnce","abort:()=>request.destroy(),destroy:()=>request.destroy()"))).toContain("request destroy path");
    expect(auditAdapter(base.replace("new Resolver()","{}"))).toContain("resolver adapter usage");
  });
});
