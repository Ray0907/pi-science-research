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
const forbiddenMemberNames=new Set(["globalAgent","createConnection","createRequire","fetch","require","eval","exec","execFile","spawn","fork","sendBeacon","WebSocket","EventSource","XMLHttpRequest"]);
const globalObjectIdentifiers=new Set(["globalThis","window","self","global","navigator"]);
const forbiddenExecutionIdentifiers=new Set(["child_process","exec","execFile","spawn","fork","worker_threads","Worker","vm","eval","Function","WebSocket","EventSource","XMLHttpRequest","navigator","window","self","fetch","require","createRequire"]);
const forbiddenPackages=["node-fetch","cross-fetch","undici","http-proxy-agent","https-proxy-agent","socks-proxy-agent","ws"] as const;
function isRelativeSpecifier(specifier:string):boolean{return specifier.startsWith("./")||specifier.startsWith("../");}
function isForbiddenPackage(specifier:string):boolean{return forbiddenPackages.some((name)=>specifier===name||specifier.startsWith(`${name}/`));}

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
function outerTransparent(node:ts.Node):ts.Node{
  let current=node;
  while((ts.isParenthesizedExpression(current.parent)||ts.isAsExpression(current.parent)||ts.isNonNullExpression(current.parent))&&current.parent.expression===current)current=current.parent;
  return current;
}
function insideNamedFunction(node:ts.Node,name:string):boolean{
  for(let current:ts.Node|undefined=node.parent;current;current=current.parent){if(ts.isFunctionDeclaration(current))return current.name?.text===name;if(ts.isSourceFile(current))return false;}
  return false;
}
function insideVariableInitializer(node:ts.Node,name:string):boolean{
  for(let current:ts.Node|undefined=node.parent;current;current=current.parent){if(ts.isVariableDeclaration(current)&&ts.isIdentifier(current.name)&&current.name.text===name)return true;if(ts.isSourceFile(current))return false;}
  return false;
}
function isPropertyName(node:ts.Identifier):boolean{const parent=node.parent;return(ts.isPropertyAccessExpression(parent)&&parent.name===node)||(ts.isPropertyAssignment(parent)&&parent.name===node)||(ts.isPropertyDeclaration(parent)&&parent.name===node)||(ts.isPropertySignature(parent)&&parent.name===node)||(ts.isMethodDeclaration(parent)&&parent.name===node)||(ts.isMethodSignature(parent)&&parent.name===node)||(ts.isBindingElement(parent)&&parent.propertyName===node);}
function isExactTestGlobalUrl(node:ts.Identifier):boolean{const access=node.parent;return node.text==="globalThis"&&ts.isPropertyAccessExpression(access)&&!access.questionDotToken&&access.expression===node&&access.name.text==="URL"&&ts.isNewExpression(access.parent)&&access.parent.expression===access;}
function isObjectCall(call:ts.CallExpression,name:string):boolean{
  const expression=call.expression;return ts.isPropertyAccessExpression(expression)&&!expression.questionDotToken&&ts.isIdentifier(expression.expression)&&expression.expression.text==="Object"&&expression.name.text===name;
}
type TrackedNodeBinding={readonly module:string;readonly imported:string};
function trackedNodeImports(file:ts.SourceFile):Map<string,TrackedNodeBinding>{
  const output=new Map<string,TrackedNodeBinding>();
  for(const statement of file.statements){
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)||!allowedNodeImports.has(statement.moduleSpecifier.text))continue;
    const clause=statement.importClause;if(clause?.name)output.set(clause.name.text,{module:statement.moduleSpecifier.text,imported:"default"});
    const bindings=clause?.namedBindings;if(bindings&&ts.isNamedImports(bindings))for(const element of bindings.elements)output.set(element.name.text,{module:statement.moduleSpecifier.text,imported:element.propertyName?.text??element.name.text});
    if(bindings&&ts.isNamespaceImport(bindings))output.set(bindings.name.text,{module:statement.moduleSpecifier.text,imported:"*"});
  }
  return output;
}
function auditAdapter(source:string):string[]{
  const file=ts.createSourceFile("adapter.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const trackedBindings=trackedNodeImports(file);
  const errors:string[]=[];
  const imports=new Set<string>();const importCounts=new Map<string,number>();const importedMembers=new Map<string,Set<string>>();
  const dangerousAliases=new Set(["require","fetch","eval","Function"]);
  let strictHeaders=false;let exactCa=false;let caClone=false;let headerMapOverride=false;let sharedDestroy=false;let constructsResolver=false;
  const realResolverMembers=new Set<string>();let realOperationsDeclarations=0;const adapterFunctionCounts=new Map<string,number>();const productionFeatureKeys=new Set<string>();const productionIdentifiers=new Set<string>();
  let productionUsesOwnDescriptors=false;let productionUsesPrototype=false;let unsupportedBranch=false;
  const visitProduction=(node:ts.Node):void=>{
    if(ts.isStringLiteral(node))productionFeatureKeys.add(node.text);
    if(ts.isIdentifier(node))productionIdentifiers.add(node.text);
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="Object"&&node.name.text==="getOwnPropertyDescriptor")productionUsesOwnDescriptors=true;
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="Object"&&node.name.text==="getPrototypeOf")productionUsesPrototype=true;
    ts.forEachChild(node,visitProduction);
  };
  const auditTrackedNodeUse=(node:ts.Identifier,binding:TrackedNodeBinding):void=>{
    const parent=node.parent;if(ts.isImportClause(parent)||ts.isImportSpecifier(parent)||ts.isNamespaceImport(parent))return;
    if(ts.isQualifiedName(parent)&&parent.left===node){const allowedTypes:Record<string,readonly string[]>={"node:http":["Agent","ClientRequest","IncomingMessage"],"node:https":["Agent"],"node:tls":["PeerCertificate","TLSSocket"]};if(allowedTypes[binding.module]?.includes(parent.right.text))return;errors.push("node type context");return;}
    const outer=outerTransparent(node);
    if(binding.module==="node:dns/promises"&&binding.imported==="Resolver"){
      if(ts.isNewExpression(outer.parent)&&outer.parent.expression===outer&&insideVariableInitializer(outer,"realNodeOperations"))return;
      if(ts.isTypeOfExpression(outer.parent)&&insideNamedFunction(outer,"productionFeaturesAvailable"))return;
      if(ts.isCallExpression(outer.parent)&&outer.parent.arguments[0]===outer&&isObjectCall(outer.parent,"getOwnPropertyDescriptor")&&ts.isStringLiteral(outer.parent.arguments[1])&&outer.parent.arguments[1].text==="prototype"&&insideNamedFunction(outer,"productionFeaturesAvailable"))return;
      errors.push("node constructor context");return;
    }
    if(binding.module==="node:timers"){
      if(ts.isCallExpression(outer.parent)&&outer.parent.expression===outer&&insideVariableInitializer(outer,"realNodeOperations"))return;
      if((ts.isTypeOfExpression(outer.parent)||ts.isTypeQueryNode(outer.parent))&&insideNamedFunction(outer,"productionFeaturesAvailable"))return;
      if(ts.isTypeQueryNode(outer.parent))return;
      errors.push("node function context");return;
    }
    if(ts.isPropertyAccessExpression(parent)&&parent.expression===node){
      if(parent.questionDotToken){errors.push("node member context");return;}
      const member=parent.name.text;const memberOuter=outerTransparent(parent);
      const directCall=ts.isCallExpression(memberOuter.parent)&&memberOuter.parent.expression===memberOuter;
      const directNew=ts.isNewExpression(memberOuter.parent)&&memberOuter.parent.expression===memberOuter;
      if((binding.module==="node:http"||binding.module==="node:https")&&member==="request"&&directCall&&insideNamedFunction(memberOuter,"adaptNodeRequest"))return;
      if((binding.module==="node:http"||binding.module==="node:https")&&member==="Agent"&&directNew&&insideVariableInitializer(memberOuter,"realNodeOperations"))return;
      if(binding.module==="node:tls"&&member==="checkServerIdentity"&&directCall&&insideVariableInitializer(memberOuter,"realNodeOperations"))return;
      if(binding.module==="node:tls"&&member==="rootCertificates"&&ts.isReturnStatement(memberOuter.parent)&&insideNamedFunction(memberOuter,"readProductionBundledRoots"))return;
      if(binding.module==="node:perf_hooks"&&member==="now"&&directCall&&insideVariableInitializer(memberOuter,"realNodeOperations"))return;
      if(binding.module==="node:util"&&member==="types"){errors.push("node member context");return;}
      if(binding.module==="node:util"&&member==="isProxy"&&directCall)return;
      errors.push("node member context");return;
    }
    if(ts.isElementAccessExpression(parent)&&parent.expression===node){errors.push("node member context");return;}
    if(insideNamedFunction(outer,"productionFeaturesAvailable")){
      if(ts.isCallExpression(outer.parent)&&outer.parent.arguments[0]===outer&&isObjectCall(outer.parent,"getOwnPropertyDescriptor")&&ts.isStringLiteral(outer.parent.arguments[1])){const allowedFeatures:Record<string,readonly string[]>={"node:http":["Agent","request"],"node:https":["Agent","request"],"node:tls":["checkServerIdentity","rootCertificates"]};if(allowedFeatures[binding.module]?.includes(outer.parent.arguments[1].text))return;errors.push("node feature context");return;}
      if(binding.module==="node:perf_hooks"&&ts.isCallExpression(outer.parent)&&outer.parent.arguments[0]===outer&&isObjectCall(outer.parent,"getPrototypeOf"))return;
      if(binding.module==="node:perf_hooks"&&(ts.isTypeOfExpression(outer.parent)||ts.isBinaryExpression(outer.parent)))return;
    }
    errors.push("node binding context");
  };
  const visit=(node:ts.Node):void=>{
    if(ts.isIdentifier(node)){const tracked=trackedBindings.get(node.text);if(tracked)auditTrackedNodeUse(node,tracked);}
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const specifier=node.moduleSpecifier.text;
      if(!isRelativeSpecifier(specifier)&&!allowedNodeImports.has(specifier))errors.push(`forbidden import ${specifier}`);
      if(specifier.startsWith("node:")){
        imports.add(specifier);importCounts.set(specifier,(importCounts.get(specifier)??0)+1);
        if(!allowedNodeImports.has(specifier))errors.push(`forbidden import ${specifier}`);
        const expected=exactImportBindings.get(specifier);const actual=importedNames(node.importClause).sort();
        if(expected&&JSON.stringify(actual)!==JSON.stringify([...expected].sort()))errors.push(`import binding ${specifier}`);
      }
    }
    if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&!isRelativeSpecifier(node.moduleSpecifier.text))errors.push(`forbidden import ${node.moduleSpecifier.text}`);
    if(ts.isImportEqualsDeclaration(node))errors.push("forbidden import equals");
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
    if(ts.isIdentifier(node)&&globalObjectIdentifiers.has(node.text)&&!isPropertyName(node))errors.push("forbidden global object");
    if(ts.isIdentifier(node)&&(forbiddenExecutionIdentifiers.has(node.text)||node.text==="globalAgent"||node.text==="createConnection"||node.text==="process")&&!isPropertyName(node))errors.push(`forbidden identifier ${node.text}`);
    if(ts.isCallExpression(node)){
      if(ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="Object"&&node.expression.name.text==="fromEntries")headerMapOverride=true;
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push("dynamic import");
      if(ts.isIdentifier(node.expression)&&dangerousAliases.has(node.expression.text))errors.push(`forbidden call ${node.expression.text}`);
      if(ts.isPropertyAccessExpression(node.expression)&&forbiddenMemberNames.has(node.expression.name.text))errors.push(`forbidden call ${node.expression.name.text}`);
      if(ts.isElementAccessExpression(node.expression)){const argument=node.expression.argumentExpression;if(argument&&ts.isStringLiteral(argument)&&forbiddenMemberNames.has(argument.text))errors.push(`forbidden call ${argument.text}`);}
    }
    if(ts.isFunctionDeclaration(node)&&node.name){if(["adaptNodeRequest","readProductionBundledRoots","productionFeaturesAvailable"].includes(node.name.text))adapterFunctionCounts.set(node.name.text,(adapterFunctionCounts.get(node.name.text)??0)+1);if(node.name.text==="productionFeaturesAvailable")visitProduction(node);}
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="productionFeaturesAvailable"){
      const parent=node.parent;if(ts.isPrefixUnaryExpression(parent)&&parent.operator===ts.SyntaxKind.ExclamationToken){let ancestor:ts.Node|undefined=parent.parent;while(ancestor&&!ts.isIfStatement(ancestor))ancestor=ancestor.parent;if(ancestor)unsupportedBranch=source.slice(ancestor.pos,ancestor.end).includes("transport.unsupported-runtime");}
    }
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="realNodeOperations"&&node.initializer){realOperationsDeclarations+=1;
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
  if(realOperationsDeclarations!==1||["adaptNodeRequest","readProductionBundledRoots","productionFeaturesAvailable"].some((name)=>(adapterFunctionCounts.get(name)??0)!==1))errors.push("adapter declaration context");
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

function isNetworkCapableSpecifier(specifier:string):boolean{const normalized=specifier.startsWith("node:")?specifier.slice(5):specifier;return["http","https","http2","net","tls","dgram","dns","child_process","worker_threads","vm","undici"].some((base)=>normalized===base||normalized.startsWith(`${base}/`))||isForbiddenPackage(normalized);}
function exactUtilImport(node:ts.ImportDeclaration):boolean{return ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==="node:util"&&JSON.stringify(importedNames(node.importClause).sort())===JSON.stringify(["utilTypes"]);}
function auditNonAdapterSource(source:string):string[]{
  const file=ts.createSourceFile("non-adapter.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const errors:string[]=[];let utilImports=0;
  for(const statement of file.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==="node:util"&&exactUtilImport(statement))utilImports+=1;
  if(utilImports>1)errors.push("duplicate util import");
  const visit=(node:ts.Node):void=>{
    if(ts.isIdentifier(node)&&node.text==="utilTypes"&&!ts.isImportSpecifier(node.parent)){const outer=outerTransparent(node);if(!(ts.isPropertyAccessExpression(outer.parent)&&outer.parent.expression===outer&&["isProxy","isNativeError"].includes(outer.parent.name.text)&&ts.isCallExpression(outer.parent.parent)&&outer.parent.parent.expression===outer.parent))errors.push("util binding context");}
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&!isRelativeSpecifier(node.moduleSpecifier.text)&&!exactUtilImport(node))errors.push("production import denied");
    if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&!isRelativeSpecifier(node.moduleSpecifier.text))errors.push("production export denied");
    if(ts.isImportEqualsDeclaration(node))errors.push("production import equals denied");
    if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push("production dynamic import denied");
      if(ts.isIdentifier(node.expression)&&forbiddenExecutionIdentifiers.has(node.expression.text))errors.push("production execution denied");
      if(ts.isPropertyAccessExpression(node.expression)&&(forbiddenMemberNames.has(node.expression.name.text)||node.expression.name.text==="createRequire"))errors.push("production member call denied");
      if(ts.isElementAccessExpression(node.expression)){const argument=node.expression.argumentExpression;if(!argument||!ts.isStringLiteral(argument)||forbiddenMemberNames.has(argument.text)||["WebSocket","EventSource","XMLHttpRequest"].includes(argument.text))errors.push("production computed call denied");}
    }
    if(ts.isIdentifier(node)&&globalObjectIdentifiers.has(node.text)&&!isPropertyName(node))errors.push("production global object denied");
    if(ts.isIdentifier(node)&&(forbiddenExecutionIdentifiers.has(node.text)||node.text==="process"||node.text==="module")&&!isPropertyName(node))errors.push("production execution binding denied");
    if(ts.isPropertyAccessExpression(node)){const root=rootIdentifier(node.expression);if((root==="globalThis"||root==="window"||root==="self")&&["fetch","WebSocket","EventSource","XMLHttpRequest"].includes(node.name.text))errors.push("production global denied");if(root==="navigator"&&node.name.text==="sendBeacon")errors.push("production beacon denied");}
    if(ts.isElementAccessExpression(node)){const root=rootIdentifier(node.expression);if(root==="globalThis"||root==="window"||root==="self"){const argument=node.argumentExpression;if(!argument||!ts.isStringLiteral(argument)||["fetch","WebSocket","EventSource","XMLHttpRequest"].includes(argument.text))errors.push("production computed global denied");}}
    ts.forEachChild(node,visit);
  };visit(file);return errors;
}
function auditTestNetworkSource(source:string):string[]{
  const file=ts.createSourceFile("unit.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const errors:string[]=[];
  const visit=(node:ts.Node):void=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&isNetworkCapableSpecifier(node.moduleSpecifier.text))errors.push("test network import denied");
    if(ts.isImportEqualsDeclaration(node))errors.push("test import equals denied");
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){const argument=node.arguments[0];if(!argument||!ts.isStringLiteral(argument)||isNetworkCapableSpecifier(argument.text))errors.push("test dynamic network import denied");}
    if(ts.isIdentifier(node)&&globalObjectIdentifiers.has(node.text)&&!isPropertyName(node)&&!isExactTestGlobalUrl(node))errors.push("test global object denied");
    if(ts.isIdentifier(node)&&forbiddenExecutionIdentifiers.has(node.text)&&!isPropertyName(node))errors.push("test network execution denied");
    if(ts.isPropertyAccessExpression(node)){const root=rootIdentifier(node.expression);if((root==="globalThis"||root==="window"||root==="self")&&["fetch","WebSocket","EventSource","XMLHttpRequest"].includes(node.name.text))errors.push("test network global denied");if(node.name.text==="createRequire"||node.name.text==="require")errors.push("test require denied");}
    if(ts.isElementAccessExpression(node)){const root=rootIdentifier(node.expression);if(root==="globalThis"||root==="window"||root==="self")errors.push("test computed global denied");}
    ts.forEachChild(node,visit);
  };visit(file);return errors;
}

const defaultFactoryRequiredArguments=new Map<string,readonly number[]>([
  ["createNodeRuntimeCapabilitiesInternal",[0]],
  ["createNodeDnsResolver",[0]],
  ["createNodeRequestDeadlineSchedulerCapabilitiesInternal",[0]],
  ["createPinnedHopRuntimeInternal",[1]],
]);
function hasExplicitNonDefaultArguments(call:ts.CallExpression,positions:readonly number[]):boolean{
  return positions.every((position)=>{const argument=call.arguments[position];if(!argument||ts.isSpreadElement(argument))return false;let current:ts.Expression=argument;while(ts.isParenthesizedExpression(current)||ts.isAsExpression(current)||ts.isNonNullExpression(current))current=current.expression;return !(ts.isIdentifier(current)&&current.text==="undefined")&&!ts.isVoidExpression(current);});
}
function auditAcquisitionUnitSource(source:string,name="fixture.ts"):string[]{
  const file=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const errors:string[]=auditTestNetworkSource(source).map((error)=>`${name}: ${error}`);const factoryBindings=new Map<string,readonly number[]>();const factoryNamespaces=new Set<string>();
  for(const statement of file.statements){
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier))continue;
    if(["node:http","node:https","node:dns","node:dns/promises","node:tls"].includes(statement.moduleSpecifier.text))errors.push(`${name}: network builtin import`);
    const acquisitionModule=statement.moduleSpecifier.text.endsWith("/node-pinned-hop-internal.js")||statement.moduleSpecifier.text.endsWith("/request-deadline-internal.js");
    if(acquisitionModule&&statement.importClause?.name)errors.push(`${name}: default acquisition import`);
    const bindings=statement.importClause?.namedBindings;
    if(bindings&&ts.isNamespaceImport(bindings)&&acquisitionModule){factoryNamespaces.add(bindings.name.text);continue;}
    if(!bindings||!ts.isNamedImports(bindings))continue;
    for(const element of bindings.elements){const imported=element.propertyName?.text??element.name.text;const required=defaultFactoryRequiredArguments.get(imported);if(required!==undefined)factoryBindings.set(element.name.text,required);if(imported==="realNodeOperations")errors.push(`${name}: real adapter reference`);}
  }
  const visit=(node:ts.Node):void=>{
    if(ts.isIdentifier(node)&&factoryNamespaces.has(node.text)){
      const parent=node.parent;
      if(!ts.isNamespaceImport(parent)){
        const outer=outerTransparent(node);
        if(ts.isPropertyAccessExpression(outer.parent)&&outer.parent.expression===outer){const memberOuter=outerTransparent(outer.parent);const required=defaultFactoryRequiredArguments.get(outer.parent.name.text);if(required!==undefined&&ts.isCallExpression(memberOuter.parent)&&memberOuter.parent.expression===memberOuter){if(!hasExplicitNonDefaultArguments(memberOuter.parent,required))errors.push(`${name}: default runtime invocation`);}else errors.push(`${name}: factory namespace escape`);}
        else errors.push(`${name}: factory namespace escape`);
      }
    }
    if(ts.isIdentifier(node)){
      const required=factoryBindings.get(node.text);
      if(required!==undefined){
        const parent=node.parent;
        if(!ts.isImportSpecifier(parent)){
          const outer=outerTransparent(node);
          if(ts.isCallExpression(outer.parent)&&outer.parent.expression===outer){if(!hasExplicitNonDefaultArguments(outer.parent,required))errors.push(`${name}: default runtime invocation`);}
          else errors.push(`${name}: factory binding escape`);
        }
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(file);return errors;
}
function acquisitionUnitIsolationErrors():string[]{
  const errors:string[]=[];
  for(const relativeDirectory of ["tests/acquisition","tests/helpers"]){const directory=path.join(root,relativeDirectory);for(const name of fs.readdirSync(directory).filter((file)=>file.endsWith(".ts")))errors.push(...auditAcquisitionUnitSource(fs.readFileSync(path.join(directory,name),"utf8"),`${relativeDirectory}/${name}`));}
  return errors;
}

describe("Node operations adapter audit",()=>{
  test("audits sole real Node adapter imports methods production features and approved request options by TypeScript AST",()=>{
    const source=fs.readFileSync(adapterPath,"utf8");expect(auditAdapter(source)).toEqual([]);
    const acquisitionFiles=fs.readdirSync(path.join(root,"src/acquisition")).filter((name)=>name.endsWith(".ts")&&name!==path.basename(adapterPath));
    for(const file of acquisitionFiles)expect(auditNonAdapterSource(fs.readFileSync(path.join(root,"src/acquisition",file),"utf8")),file).toEqual([]);
    expect(acquisitionUnitIsolationErrors()).toEqual([]);
  });

  test("rejects computed optional aliased and hidden network access using malicious TypeScript snippets",()=>{
    const base=fs.readFileSync(adapterPath,"utf8");
    const cases:Array<readonly[string,string]>=[
      [`${base}\nimport fs from "node:fs";`,"forbidden import node:fs"],
      [`${base}\nimport child from "node:child_process";`,"forbidden import node:child_process"],
      [`${base}\nimport workers from "node:worker_threads";`,"forbidden import node:worker_threads"],
      [`${base}\nimport vm from "node:vm";`,"forbidden import node:vm"],
      [`${base}\nimport external from "node-fetch";`,"forbidden import node-fetch"],
      [`${base}\nimport net from "node:net";`,"forbidden import node:net"],
      [`${base}\nimport http2 from "node:http2";`,"forbidden import node:http2"],
      [`${base}\nimport bareHttps from "https";`,"forbidden import https"],
      [`${base}\nimport hiddenSubpath from "node:https/subpath";`,"forbidden import node:https/subpath"],
      [`${base}\nimport hiddenHttp from "node:http";void hiddenHttp.request;`,"import binding node:http"],
      [`${base}\nfunction adaptNodeRequest(){void https.request("https://example.invalid");}`,"adapter declaration context"],
      [`${base}\nvoid https.request("https://example.invalid");`,"node member context"],
      [`${base}\nvoid https.globalAgent;`,"forbidden member https.globalAgent"],
      [`${base}\nvoid https["globalAgent"];`,"computed module access"],
      [`${base}\nvoid https["request"];`,"computed module access"],
      [`${base}\nvoid https?.request;`,"optional module access"],
      [`${base}\nconst hiddenHttps=https;void hiddenHttps.request;`,"module alias"],
      [`${base}\nconst hiddenRequest=https.request;void hiddenRequest;`,"member alias"],
      [`${base}\nlet assigned;assigned=https.request;assigned("x");`,"node member context"],
      [`${base}\nlet assigned;assigned=(https.request);assigned("x");`,"node member context"],
      [`${base}\nconsume(https.request);`,"node member context"],
      [`${base}\nhttps.request.call(null,"x");`,"node member context"],
      [`${base}\nhttps.request.bind(null);`,"node member context"],
      [`${base}\nhttps.request.apply(null,[]);`,"node member context"],
      [`${base}\nfunction capture(){return https.request;}void capture;`,"node member context"],
      [`${base}\nnew https.request.constructor();`,"node member context"],
      [`${base}\nconst HiddenResolver=Resolver;void HiddenResolver;`,"module alias"],
      [`${base}\nconst hiddenTimer=nodeSetTimeout;void hiddenTimer;`,"function binding escape"],
      [`${base}\nconst {globalAgent:renamed}=https;void renamed;`,"destructured alias"],
      [`${base}\nconst hiddenGlobal=globalThis;void hiddenGlobal;`,"forbidden global object"],
      [`${base}\nconst hiddenCrypto=globalThis.crypto;void hiddenCrypto;`,"forbidden global object"],
      [`${base}\nlet assignedGlobal;assignedGlobal=(globalThis);void assignedGlobal;`,"forbidden global object"],
      [`${base}\nconst {fetch:renamedFetch}=globalThis;void renamedFetch;`,"forbidden global object"],
      [`${base}\nReflect.get(globalThis,"fetch");`,"forbidden global object"],
      [`${base}\nvoid window.location;void self.location;void global.process;void navigator.userAgent;`,"forbidden global object"],
      [`${base}\nglobalThis["fetch"]("https://example.invalid");`,"forbidden computed fetch"],
      [`${base}\nvoid globalThis.fetch;`,"forbidden global fetch"],
      [`${base}\nconst spec="node:https";void import(spec);`,"dynamic import"],
      [`${base}\nconst hidden=require;hidden("node:http");`,"forbidden call hidden"],
      [`${base}\nvoid eval("require('node:https')");`,"forbidden call eval"],
      [`${base}\nglobalThis["eval"]("fetch('x')");`,"forbidden computed eval"],
      [`${base}\nmodule.createRequire(import.meta.url);`,"forbidden call createRequire"],
      [`${base}\nspawn("secret");`,"forbidden identifier spawn"],
      [`${base}\nnew WebSocket("wss://example.invalid");`,"forbidden identifier WebSocket"],
      [`${base}\nEventSource.call(null,"x");`,"forbidden identifier EventSource"],
      [`${base}\nnew XMLHttpRequest();`,"forbidden identifier XMLHttpRequest"],
      [`${base}\nnavigator.sendBeacon("x");`,"forbidden identifier navigator"],
      [`${base}\nwindow["fetch"]("x");`,"forbidden computed fetch"],
      [`${base}\nself.EventSource.bind(self);`,"forbidden identifier self"],
      [base.replace("const requestOptions={","const requestOptions={agent:undefined,"),"request option shape"],
      [base.replace("ca:options.ca","ca:[...options.ca]"),"CA clone"],
      [base.replace("abort:destroyOnce,destroy:destroyOnce","abort:()=>request.destroy(),destroy:()=>request.destroy()"),"request destroy path"],
      [base.replace("new Resolver()","{}"),"resolver adapter usage"],
      [base.replace('Object.getOwnPropertyDescriptor(resolverBase as object,"cancel")','undefined'),"production feature audit"],
    ];
    for(const [source,error] of cases)expect(auditAdapter(source),error).toContain(error);
    expect(auditAdapter(`${base}\nconst holder={self:1};void holder.self;`)).toEqual([]);
  });

  test("rejects default-denied production imports and network execution escapes outside the sole adapter",()=>{const cases=[
    'import fs from "node:fs";','import child from "node:child_process";','import workers from "node:worker_threads";','import vm from "node:vm";','import external from "node-fetch";','import cross from "cross-fetch";','import undiciClient from "undici";','import httpProxy from "http-proxy-agent";','import httpsProxy from "https-proxy-agent";','import socksProxy from "socks-proxy-agent";','import anything from "some-external-package";',
    'import net from "node:net";','import http2 from "node:http2";','import https from "https";','import dns from "dns";','import promises from "dns/promises";','import hidden from "node:https/subpath";',
    'const spec="node:net";void import(spec);','void import("./relative.js");','void import("http2");','const load=require;load("https");','module.require("dns");','module.createRequire(import.meta.url);','void globalThis.fetch("https://example.invalid");','import undici from "undici";',
    'exec("x");','execFile("x");','spawn("x");','fork("x");','new Worker("x");','vm.runInNewContext("x");','eval("x");','Function("x")();','const g=globalThis;void g;','let g;g=(globalThis);','const {fetch:renamed}=globalThis;void renamed;','function leak(){return globalThis;}','Reflect.get(globalThis,"fetch");','void window.location;','void self.location;','void global.process;','void navigator.userAgent;','new WebSocket("x");','new EventSource("x");','new XMLHttpRequest();','navigator.sendBeacon("x");','globalThis["WebSocket"]("x");','globalThis.EventSource.bind(null);','window["fetch"]("x");','self.EventSource.call(null,"x");',
  ];for(const source of cases)expect(auditNonAdapterSource(source),source).not.toEqual([]);expect(auditNonAdapterSource('const holder={self:1};void holder.self;')).toEqual([]);expect(auditNonAdapterSource('import {types as utilTypes} from "node:util";import value from "./local.js";void utilTypes.isProxy(value);')).toEqual([]);expect(auditNonAdapterSource('import {types as utilTypes} from "node:util";const proxyCheck=utilTypes.isProxy;void proxyCheck;')).not.toEqual([]);});

  test("rejects aliases captures nested calls and implicit defaults for imported unit-test factories",()=>{
    const modulePath='../../src/acquisition/node-pinned-hop-internal.js';
    const cases=[
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";const make=createNodeRuntimeCapabilitiesInternal;make();`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";const make=(createNodeRuntimeCapabilitiesInternal);make();`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";let make;make=createNodeRuntimeCapabilitiesInternal;make();`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";createNodeRuntimeCapabilitiesInternal.call(null,{});`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";createNodeRuntimeCapabilitiesInternal.bind(null);`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";createNodeRuntimeCapabilitiesInternal.apply(null,[{}]);`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";consume(createNodeRuntimeCapabilitiesInternal);`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";new createNodeRuntimeCapabilitiesInternal.constructor();`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";createNodeRuntimeCapabilitiesInternal();`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";createNodeRuntimeCapabilitiesInternal(undefined);`,
      `import {createNodeRuntimeCapabilitiesInternal} from "${modulePath}";createNodeRuntimeCapabilitiesInternal(...[]);`,
      `import {createPinnedHopRuntimeInternal as makePinned} from "${modulePath}";makePinned(undefined);`,
      `import {createPinnedHopRuntimeInternal as makePinned} from "${modulePath}";makePinned(undefined,undefined);`,
      `import * as internals from "${modulePath}";internals.createNodeRuntimeCapabilitiesInternal();`,
      `import * as internals from "${modulePath}";const make=internals.createNodeRuntimeCapabilitiesInternal;make({});`,
    ];
    for(const source of cases)expect(auditAcquisitionUnitSource(source)).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const g=globalThis;const h=(g);Reflect.get(g,"fetch");void h["WebSocket"];')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const URLCtor=globalThis.URL;void URLCtor;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('new (globalThis.URL)("https://example.invalid");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('function leak(){return globalThis;}void leak;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let g;g=globalThis;new g.WebSocket("x");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('Reflect.get(globalThis,"fetch");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const holder={self:1};void holder.self;new globalThis.URL("https://example.invalid");')).toEqual([]);
    expect(auditAcquisitionUnitSource('import fetcher from "node-fetch";void fetcher;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('new WebSocket("wss://example.invalid");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('import {describe} from "vitest";void describe;')).toEqual([]);
    expect(auditAcquisitionUnitSource(`import {createNodeRuntimeCapabilitiesInternal as make} from "${modulePath}";make(fakeOps);`)).toEqual([]);
  });
});
