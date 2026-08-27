import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const root=path.resolve(import.meta.dirname,"../..");
const adapterPath=path.join(root,"src/acquisition/node-pinned-hop-internal.ts");
const networkNodeImports=new Set(["node:dns/promises","node:http","node:https","node:tls","node:timers","node:perf_hooks"]);
const allowedNodeImports=new Set([...networkNodeImports,"node:util"]);
const requestOptionKeys=new Set(["agent","headers","setHost","servername","ca","rejectUnauthorized","maxHeaderSize","insecureHTTPParser","joinDuplicateHeaders","lookup","checkServerIdentity"]);
const exactImportBindings=new Map<string,readonly string[]>([
  ["node:dns/promises",["Resolver"]],["node:http",["http"]],["node:https",["https"]],["node:tls",["tls"]],
  ["node:timers",["nodeClearTimeout","nodeSetTimeout"]],["node:perf_hooks",["nodePerformance"]],["node:util",["utilTypes"]],
]);
const exactImportedMembers=new Map<string,readonly string[]>([
  ["http",["Agent","request"]],["https",["Agent","request"]],
  ["tls",["checkServerIdentity","rootCertificates"]],["nodePerformance",["now"]],["utilTypes",["isProxy"]],
]);
const moduleBindings=new Set(["Resolver","http","https","tls","nodePerformance","utilTypes"]);
const directFunctionBindings=new Set(["nodeSetTimeout","nodeClearTimeout"]);
const forbiddenMemberNames=new Set(["globalAgent","createConnection","fetch","require","eval"]);

function importedNames(clause:ts.ImportClause|undefined):string[]{
  const names:string[]=[];
  if(clause?.name)names.push(clause.name.text);
  const bindings=clause?.namedBindings;
  if(bindings&&ts.isNamedImports(bindings))for(const element of bindings.elements)names.push(element.name.text);
  if(bindings&&ts.isNamespaceImport(bindings))names.push(bindings.name.text);
  return names;
}
function rootIdentifier(expression:ts.Expression):string|undefined{
  let current=expression;
  while(ts.isParenthesizedExpression(current)||ts.isAsExpression(current)||ts.isNonNullExpression(current))current=current.expression;
  return ts.isIdentifier(current)?current.text:undefined;
}
function auditAdapter(source:string):string[]{
  const file=ts.createSourceFile("adapter.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const errors:string[]=[];
  const imports=new Set<string>();const importCounts=new Map<string,number>();const importedMembers=new Map<string,Set<string>>();
  const dangerousAliases=new Set(["require","fetch","eval","Function"]);
  let strictHeaders=false;let exactCa=false;let caClone=false;let headerMapOverride=false;let sharedDestroy=false;let constructsResolver=false;
  const realResolverMembers=new Set<string>();const productionFeatureKeys=new Set<string>();const productionIdentifiers=new Set<string>();
  let productionUsesOwnDescriptors=false;let productionUsesPrototype=false;let unsupportedBranch=false;
  const visitProduction=(node:ts.Node):void=>{
    if(ts.isStringLiteral(node))productionFeatureKeys.add(node.text);
    if(ts.isIdentifier(node))productionIdentifiers.add(node.text);
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="Object"&&node.name.text==="getOwnPropertyDescriptor")productionUsesOwnDescriptors=true;
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="Object"&&node.name.text==="getPrototypeOf")productionUsesPrototype=true;
    ts.forEachChild(node,visitProduction);
  };
  const visit=(node:ts.Node):void=>{
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const specifier=node.moduleSpecifier.text;
      if(specifier.startsWith("node:")){
        imports.add(specifier);importCounts.set(specifier,(importCounts.get(specifier)??0)+1);
        if(!allowedNodeImports.has(specifier))errors.push(`forbidden import ${specifier}`);
        const expected=exactImportBindings.get(specifier);const actual=importedNames(node.importClause).sort();
        if(expected&&JSON.stringify(actual)!==JSON.stringify([...expected].sort()))errors.push(`import binding ${specifier}`);
      }
    }
    if(ts.isVariableDeclaration(node)&&node.initializer){
      if(ts.isIdentifier(node.name)){
        if(ts.isIdentifier(node.initializer)&&dangerousAliases.has(node.initializer.text))dangerousAliases.add(node.name.text);
        if(ts.isIdentifier(node.initializer)&&moduleBindings.has(node.initializer.text))errors.push("module alias");
        if(ts.isConditionalExpression(node.initializer)&&ts.isIdentifier(node.initializer.whenTrue)&&ts.isIdentifier(node.initializer.whenFalse)&&moduleBindings.has(node.initializer.whenTrue.text)&&moduleBindings.has(node.initializer.whenFalse.text))errors.push("module alias");
        if(ts.isPropertyAccessExpression(node.initializer)){
          const root=rootIdentifier(node.initializer.expression);
          if(root==="globalThis"&&dangerousAliases.has(node.initializer.name.text))dangerousAliases.add(node.name.text);
          if(root&&moduleBindings.has(root))errors.push("member alias");
        }
        if(ts.isElementAccessExpression(node.initializer)){
          const root=rootIdentifier(node.initializer.expression);const argument=node.initializer.argumentExpression;
          if(root==="globalThis"&&argument&&ts.isStringLiteral(argument)&&dangerousAliases.has(argument.text))dangerousAliases.add(node.name.text);
          if(root&&moduleBindings.has(root))errors.push("member alias");
        }
      }else if(ts.isObjectBindingPattern(node.name)){
        const root=rootIdentifier(node.initializer);
        if(root==="globalThis"||(root&&moduleBindings.has(root)))errors.push("destructured alias");
      }
    }
    if(ts.isPropertyAccessExpression(node)){
      const root=rootIdentifier(node.expression);
      if(root&&moduleBindings.has(root)){
        if(node.questionDotToken)errors.push("optional module access");
        const members=importedMembers.get(root)??new Set<string>();members.add(node.name.text);importedMembers.set(root,members);
        const allowed=exactImportedMembers.get(root);if(!allowed?.includes(node.name.text))errors.push(`forbidden member ${root}.${node.name.text}`);
      }
      if(root==="globalThis"&&forbiddenMemberNames.has(node.name.text))errors.push(`forbidden global ${node.name.text}`);
      if(forbiddenMemberNames.has(node.name.text)&&root!==undefined&&!moduleBindings.has(root)&&root!=="Object")errors.push(`forbidden member ${node.name.text}`);
    }
    if(ts.isElementAccessExpression(node)){
      const root=rootIdentifier(node.expression);const argument=node.argumentExpression;
      if(root&&moduleBindings.has(root))errors.push("computed module access");
      if(argument&&ts.isStringLiteral(argument)&&forbiddenMemberNames.has(argument.text))errors.push(`forbidden computed ${argument.text}`);
      if(!argument||!ts.isStringLiteral(argument)){
        if(root&&moduleBindings.has(root))errors.push("dynamic module access");
        if(root==="globalThis")errors.push("dynamic global access");
      }
    }
    if(ts.isIdentifier(node)&&directFunctionBindings.has(node.text)){const parent=node.parent;const allowed=ts.isImportSpecifier(parent)||ts.isTypeOfExpression(parent)||ts.isTypeQueryNode(parent)||(ts.isCallExpression(parent)&&parent.expression===node);if(!allowed)errors.push("function binding escape");}
    if(ts.isIdentifier(node)&&moduleBindings.has(node.text)){
      const parent=node.parent;let allowed=ts.isImportClause(parent)||ts.isImportSpecifier(parent)||(ts.isNewExpression(parent)&&parent.expression===node)||(ts.isPropertyAccessExpression(parent)&&parent.expression===node)||(ts.isQualifiedName(parent)&&parent.left===node)||ts.isTypeOfExpression(parent);
      if(ts.isBinaryExpression(parent)&&node.text==="nodePerformance"&&parent.operatorToken.kind===ts.SyntaxKind.EqualsEqualsEqualsToken)allowed=true;
      if(ts.isCallExpression(parent)&&parent.arguments.includes(node)){const callee=parent.expression;allowed=ts.isPropertyAccessExpression(callee)&&ts.isIdentifier(callee.expression)&&callee.expression.text==="Object"&&(callee.name.text==="getOwnPropertyDescriptor"||callee.name.text==="getPrototypeOf");}
      if(!allowed)errors.push("module binding escape");
    }
    if(ts.isIdentifier(node)&&node.text==="globalThis"&&!((ts.isPropertyAccessExpression(node.parent)||ts.isElementAccessExpression(node.parent))&&node.parent.expression===node)&&!ts.isObjectBindingPattern(node.parent))errors.push("global binding escape");
    if(ts.isIdentifier(node)&&["globalAgent","createConnection","WebSocket","EventSource","eval","Function","process","fetch","require"].includes(node.text))errors.push(`forbidden identifier ${node.text}`);
    if(ts.isCallExpression(node)){
      if(ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="Object"&&node.expression.name.text==="fromEntries")headerMapOverride=true;
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push("dynamic import");
      if(ts.isIdentifier(node.expression)&&dangerousAliases.has(node.expression.text))errors.push(`forbidden call ${node.expression.text}`);
      if(ts.isPropertyAccessExpression(node.expression)&&forbiddenMemberNames.has(node.expression.name.text))errors.push(`forbidden call ${node.expression.name.text}`);
      if(ts.isElementAccessExpression(node.expression)){const argument=node.expression.argumentExpression;if(argument&&ts.isStringLiteral(argument)&&forbiddenMemberNames.has(argument.text))errors.push(`forbidden call ${argument.text}`);}
    }
    if(ts.isFunctionDeclaration(node)&&node.name?.text==="productionFeaturesAvailable"){visitProduction(node);}
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="productionFeaturesAvailable"){
      const parent=node.parent;if(ts.isPrefixUnaryExpression(parent)&&parent.operator===ts.SyntaxKind.ExclamationToken){let ancestor:ts.Node|undefined=parent.parent;while(ancestor&&!ts.isIfStatement(ancestor))ancestor=ancestor.parent;if(ancestor)unsupportedBranch=source.slice(ancestor.pos,ancestor.end).includes("transport.unsupported-runtime");}
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="realNodeOperations"&&node.initializer){
      const inspect=(child:ts.Node):void=>{if(ts.isNewExpression(child)&&ts.isIdentifier(child.expression)&&child.expression.text==="Resolver")constructsResolver=true;if(ts.isPropertyAccessExpression(child)&&ts.isIdentifier(child.expression)&&child.expression.text==="resolver")realResolverMembers.add(child.name.text);ts.forEachChild(child,inspect);};inspect(node.initializer);
    }
    if(ts.isReturnStatement(node)&&node.expression&&ts.isObjectLiteralExpression(node.expression)){
      const methods=new Map<string,string>();for(const property of node.expression.properties){if(ts.isPropertyAssignment(property)&&ts.isIdentifier(property.name)&&ts.isIdentifier(property.initializer))methods.set(property.name.text,property.initializer.text);}
      if(methods.get("abort")==="destroyOnce"&&methods.get("destroy")==="destroyOnce")sharedDestroy=true;
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="requestOptions"&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)){
      const keys=new Set(node.initializer.properties.flatMap((property)=>{if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property)&&!ts.isMethodDeclaration(property))return[];const name=property.name;return ts.isIdentifier(name)||ts.isStringLiteral(name)?[name.text]:[];}));
      if(node.initializer.properties.length!==requestOptionKeys.size||keys.size!==requestOptionKeys.size||[...requestOptionKeys].some((key)=>!keys.has(key)))errors.push("request option shape");
      for(const property of node.initializer.properties){
        if(!ts.isPropertyAssignment(property)||!ts.isIdentifier(property.name))continue;
        if(property.name.text==="ca"){exactCa=ts.isPropertyAccessExpression(property.initializer)&&ts.isIdentifier(property.initializer.expression)&&property.initializer.expression.text==="options"&&property.initializer.name.text==="ca";caClone=ts.isArrayLiteralExpression(property.initializer)&&property.initializer.elements.some(ts.isSpreadElement);}
        if(property.name.text==="headers"&&ts.isArrayLiteralExpression(property.initializer)){const elements=property.initializer.elements;const hostTuple=ts.isAsExpression(elements[1]!)?elements[1]!.expression:elements[1]!;strictHeaders=elements.length===2&&ts.isSpreadElement(elements[0]!)&&ts.isArrayLiteralExpression(hostTuple)&&hostTuple.elements.length===2&&ts.isStringLiteral(hostTuple.elements[0]!)&&hostTuple.elements[0]!.text==="Host"&&ts.isPropertyAccessExpression(hostTuple.elements[1]!)&&hostTuple.elements[1]!.name.text==="hostHeader";}
      }
      if(!strictHeaders)errors.push("strict Host injection");if(!exactCa)errors.push("exact CA identity");
    }
    ts.forEachChild(node,visit);
  };
  visit(file);
  for(const required of networkNodeImports){if(!imports.has(required))errors.push(`missing import ${required}`);if((importCounts.get(required)??0)!==1)errors.push(`import count ${required}`);}
  for(const [binding,expected] of exactImportedMembers){const actual=[...(importedMembers.get(binding)??new Set())].sort();if(JSON.stringify(actual)!==JSON.stringify([...expected].sort()))errors.push(`member use ${binding}`);}
  const requiredFeatureKeys=["prototype","resolve4","resolve6","cancel","Agent","request","checkServerIdentity","rootCertificates","now"];
  const requiredFeatureIdentifiers=["Resolver","http","https","tls","nodeSetTimeout","nodeClearTimeout","nodePerformance"];
  if(requiredFeatureKeys.some((key)=>!productionFeatureKeys.has(key))||requiredFeatureIdentifiers.some((key)=>!productionIdentifiers.has(key))||!productionUsesOwnDescriptors||!productionUsesPrototype||!unsupportedBranch)errors.push("production feature audit");
  if(!sharedDestroy)errors.push("request destroy path");
  if(!constructsResolver||JSON.stringify([...realResolverMembers].sort())!==JSON.stringify(["cancel","resolve4","resolve6"]))errors.push("resolver adapter usage");
  if(headerMapOverride)errors.push("header map override");
  if(caClone)errors.push("CA clone");
  for(const [code,mapping] of [["HPE_HEADER_OVERFLOW","header-overflow"],["HPE_UNEXPECTED_CONTENT_LENGTH","unexpected-content-length"],["HPE_INVALID_CONTENT_LENGTH","unexpected-content-length"],["HPE_INVALID_TRANSFER_ENCODING","unexpected-content-length"],["HPE_INVALID_HEADER_TOKEN","invalid-header-token"],["HPE_INVALID_CHUNK_SIZE","invalid-chunk"],["HPE_INVALID_VERSION","invalid-version"],["HPE_INVALID_STATUS","invalid-status"]] as const){if(!source.includes(code)||!source.includes(mapping))errors.push(`missing parser map ${code}`);}
  if(!source.includes('startsWith("HPE_")'))errors.push("missing HPE fallback");
  return errors;
}

function acquisitionUnitIsolationErrors():string[]{
  const errors:string[]=[];const directory=path.join(root,"tests/acquisition");
  const defaultedFactories=new Map([["createNodeRuntimeCapabilitiesInternal",1],["createNodeDnsResolver",1],["createNodeRequestDeadlineSchedulerCapabilitiesInternal",1],["createPinnedHopRuntimeInternal",2]]);
  for(const name of fs.readdirSync(directory).filter((file)=>file.endsWith(".ts"))){
    const file=ts.createSourceFile(name,fs.readFileSync(path.join(directory,name),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const visit=(node:ts.Node):void=>{
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&["node:http","node:https","node:dns","node:dns/promises","node:tls"].includes(node.moduleSpecifier.text))errors.push(`${name}: network builtin import`);
      if(ts.isIdentifier(node)&&node.text==="realNodeOperations")errors.push(`${name}: real adapter reference`);
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){const minimum=defaultedFactories.get(node.expression.text);if(minimum!==undefined&&node.arguments.length<minimum)errors.push(`${name}: default runtime invocation`);}
      ts.forEachChild(node,visit);
    };visit(file);
  }
  return errors;
}

describe("Node operations adapter audit",()=>{
  test("audits sole real Node adapter imports methods production features and approved request options by TypeScript AST",()=>{
    const source=fs.readFileSync(adapterPath,"utf8");expect(auditAdapter(source)).toEqual([]);
    const acquisitionFiles=fs.readdirSync(path.join(root,"src/acquisition")).filter((name)=>name.endsWith(".ts")&&name!==path.basename(adapterPath));
    for(const file of acquisitionFiles){const parsed=ts.createSourceFile(file,fs.readFileSync(path.join(root,"src/acquisition",file),"utf8"),ts.ScriptTarget.Latest,true);const imports:string[]=[];const visit=(node:ts.Node):void=>{if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&networkNodeImports.has(node.moduleSpecifier.text))imports.push(node.moduleSpecifier.text);if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)imports.push("dynamic");ts.forEachChild(node,visit);};visit(parsed);expect(imports,file).toEqual([]);}
    expect(acquisitionUnitIsolationErrors()).toEqual([]);
  });

  test("rejects computed optional aliased and hidden network access using malicious TypeScript snippets",()=>{
    const base=fs.readFileSync(adapterPath,"utf8");
    const cases:Array<readonly[string,string]>=[
      [`${base}\nimport net from "node:net";`,"forbidden import node:net"],
      [`${base}\nimport hiddenHttp from "node:http";void hiddenHttp.request;`,"import binding node:http"],
      [`${base}\nvoid https.globalAgent;`,"forbidden member https.globalAgent"],
      [`${base}\nvoid https["globalAgent"];`,"computed module access"],
      [`${base}\nvoid https["request"];`,"computed module access"],
      [`${base}\nvoid https?.request;`,"optional module access"],
      [`${base}\nconst hiddenHttps=https;void hiddenHttps.request;`,"module alias"],
      [`${base}\nconst hiddenRequest=https.request;void hiddenRequest;`,"member alias"],
      [`${base}\nconst HiddenResolver=Resolver;void HiddenResolver;`,"module alias"],
      [`${base}\nconst hiddenTimer=nodeSetTimeout;void hiddenTimer;`,"function binding escape"],
      [`${base}\nconst {globalAgent:renamed}=https;void renamed;`,"destructured alias"],
      [`${base}\nconst hiddenGlobal=globalThis;void hiddenGlobal;`,"global binding escape"],
      [`${base}\nglobalThis["fetch"]("https://example.invalid");`,"forbidden computed fetch"],
      [`${base}\nvoid globalThis.fetch;`,"forbidden global fetch"],
      [`${base}\nconst spec="node:https";void import(spec);`,"dynamic import"],
      [`${base}\nconst hidden=require;hidden("node:http");`,"forbidden call hidden"],
      [`${base}\nvoid eval("require('node:https')");`,"forbidden call eval"],
      [`${base}\nglobalThis["eval"]("fetch('x')");`,"forbidden computed eval"],
      [base.replace("const requestOptions={","const requestOptions={agent:undefined,"),"request option shape"],
      [base.replace("ca:options.ca","ca:[...options.ca]"),"CA clone"],
      [base.replace("abort:destroyOnce,destroy:destroyOnce","abort:()=>request.destroy(),destroy:()=>request.destroy()"),"request destroy path"],
      [base.replace("new Resolver()","{}"),"resolver adapter usage"],
      [base.replace('Object.getOwnPropertyDescriptor(resolverBase as object,"cancel")','undefined'),"production feature audit"],
    ];
    for(const [source,error] of cases)expect(auditAdapter(source),error).toContain(error);
  });
});
