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
const constantStringMaxBindings=4_096;const constantStringMaxDepth=32;const constantStringMaxNodes=64;const constantStringMaxLength=256;const constantStringMaxValues=16;
type ConstantStringResult={readonly values:readonly string[];readonly unsafe:boolean};
const constantUnknown:ConstantStringResult=Object.freeze({values:Object.freeze([]),unsafe:false});const constantUnsafe:ConstantStringResult=Object.freeze({values:Object.freeze([]),unsafe:true});
function unwrapAuditExpression(expression:ts.Expression):ts.Expression{let current=expression;while(ts.isParenthesizedExpression(current)||ts.isAsExpression(current)||ts.isNonNullExpression(current))current=current.expression;return current;}
function constructorTaintAuditErrors(file:ts.SourceFile):string[]{
  type Binding={readonly declaration:ts.VariableDeclaration;readonly scope:ts.Node};type Assignment={readonly target:ts.VariableDeclaration|ts.Identifier;readonly expression:ts.Expression};
  const errors:string[]=[];const bindings=new Map<string,Binding[]>();const assignments:Assignment[]=[];const declarationBindings=new Map<ts.VariableDeclaration,Binding>();let bindingCount=0;let assignmentCount=0;
  const boundedUnwrap=(expression:ts.Expression):ts.Expression|null=>{let current=expression;for(let depth=0;depth<=constantStringMaxDepth;depth+=1){if(!ts.isParenthesizedExpression(current)&&!ts.isAsExpression(current)&&!ts.isNonNullExpression(current))return current;current=current.expression;}return null;};
  const lexicalScope=(declaration:ts.VariableDeclaration):ts.Node=>{const declarationList=declaration.parent;const blockScoped=ts.isVariableDeclarationList(declarationList)&&(declarationList.flags&(ts.NodeFlags.Const|ts.NodeFlags.Let))!==0;for(let current:ts.Node|undefined=declaration.parent;current;current=current.parent){if(ts.isSourceFile(current)||ts.isFunctionLike(current))return current;if(blockScoped&&(ts.isBlock(current)||ts.isCaseBlock(current)||ts.isForStatement(current)||ts.isForInStatement(current)||ts.isForOfStatement(current)||ts.isCatchClause(current)))return current;}return file;};
  const collect=(node:ts.Node):void=>{
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)){bindingCount+=1;if(bindingCount<=constantStringMaxBindings){const binding={declaration:node,scope:lexicalScope(node)};const records=bindings.get(node.name.text)??[];records.push(binding);bindings.set(node.name.text,records);declarationBindings.set(node,binding);}if(node.initializer){assignmentCount+=1;if(assignmentCount<=constantStringMaxBindings)assignments.push({target:node,expression:node.initializer});}}
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken){const left=boundedUnwrap(node.left as ts.Expression);if(left===null)errors.push("constructor taint bound");else if(ts.isIdentifier(left)){assignmentCount+=1;if(assignmentCount<=constantStringMaxBindings)assignments.push({target:left,expression:node.right});}}
    ts.forEachChild(node,collect);
  };collect(file);
  const bindingFor=(identifier:ts.Identifier):Binding|ConstantStringResult=>{const candidates=(bindings.get(identifier.text)??[]).filter((binding)=>binding.scope.pos<=identifier.pos&&identifier.end<=binding.scope.end);if(candidates.length===0)return constantUnknown;let span=Number.POSITIVE_INFINITY;for(const candidate of candidates)span=Math.min(span,candidate.scope.end-candidate.scope.pos);const nearest=candidates.filter((candidate)=>candidate.scope.end-candidate.scope.pos===span);return nearest.length===1?nearest[0]!:constantUnsafe;};
  const targetBinding=(target:ts.VariableDeclaration|ts.Identifier):Binding|ConstantStringResult=>ts.isVariableDeclaration(target)?declarationBindings.get(target)??constantUnsafe:bindingFor(target);
  const assignmentsByBinding=new Map<ts.VariableDeclaration,ts.Expression[]>();if(bindingCount>constantStringMaxBindings||assignmentCount>constantStringMaxBindings)errors.push("constructor taint bound");else for(const assignment of assignments){const binding=targetBinding(assignment.target);if("values" in binding){if(binding.unsafe)errors.push("constructor taint bound");continue;}const values=assignmentsByBinding.get(binding.declaration)??[];values.push(assignment.expression);assignmentsByBinding.set(binding.declaration,values);}
  const merge=(left:ConstantStringResult,right:ConstantStringResult):ConstantStringResult=>{const values=[...left.values];let unsafe=left.unsafe||right.unsafe;for(const value of right.values)if(!values.includes(value)){if(values.length>=constantStringMaxValues){unsafe=true;break;}values.push(value);}return{values,unsafe};};
  const literalResult=(value:string):ConstantStringResult=>value.length<=constantStringMaxLength?{values:[value],unsafe:false}:constantUnsafe;
  const concatenate=(left:ConstantStringResult,right:ConstantStringResult):ConstantStringResult=>{if(left.values.length===0||right.values.length===0)return{values:[],unsafe:left.unsafe||right.unsafe};let output:ConstantStringResult={values:[],unsafe:left.unsafe||right.unsafe};for(const leftValue of left.values)for(const rightValue of right.values){const value=leftValue+rightValue;output=merge(output,value.length<=constantStringMaxLength?{values:[value],unsafe:false}:constantUnsafe);}return output;};
  const known=new Map<ts.VariableDeclaration,ConstantStringResult>();
  const evaluateKnown=(expression:ts.Expression,depth:number,budget:{nodes:number}):ConstantStringResult=>{budget.nodes+=1;if(depth>constantStringMaxDepth||budget.nodes>constantStringMaxNodes)return constantUnsafe;const current=expression;if(ts.isParenthesizedExpression(current)||ts.isAsExpression(current)||ts.isNonNullExpression(current))return evaluateKnown(current.expression,depth+1,budget);if(ts.isStringLiteral(current)||ts.isNoSubstitutionTemplateLiteral(current))return literalResult(current.text);if(ts.isIdentifier(current)){const binding=bindingFor(current);return"values" in binding?binding:known.get(binding.declaration)??constantUnknown;}if(ts.isBinaryExpression(current)&&current.operatorToken.kind===ts.SyntaxKind.PlusToken)return concatenate(evaluateKnown(current.left,depth+1,budget),evaluateKnown(current.right,depth+1,budget));return constantUnknown;};
  if(assignmentCount<=constantStringMaxBindings){let changedAtBound=false;for(let pass=0;pass<=assignments.length;pass+=1){let changed=false;for(const assignment of assignments){const binding=targetBinding(assignment.target);if("values" in binding)continue;const prior=known.get(binding.declaration)??constantUnknown;const next=merge(prior,evaluateKnown(assignment.expression,0,{nodes:0}));if(next.unsafe!==prior.unsafe||next.values.length!==prior.values.length){known.set(binding.declaration,next);changed=true;}}if(!changed){changedAtBound=false;break;}changedAtBound=pass===assignments.length;}if(changedAtBound)errors.push("constructor taint iteration");}
  const evaluate=(expression:ts.Expression,stack:Set<ts.VariableDeclaration>,depth:number,budget:{nodes:number}):ConstantStringResult=>{budget.nodes+=1;if(depth>constantStringMaxDepth||budget.nodes>constantStringMaxNodes)return constantUnsafe;const current=expression;if(ts.isParenthesizedExpression(current)||ts.isAsExpression(current)||ts.isNonNullExpression(current))return evaluate(current.expression,stack,depth+1,budget);if(ts.isStringLiteral(current)||ts.isNoSubstitutionTemplateLiteral(current))return literalResult(current.text);if(ts.isIdentifier(current)){const binding=bindingFor(current);if("values" in binding)return binding;if(stack.has(binding.declaration)){const grounded=[...stack,binding.declaration].some((declaration)=>(assignmentsByBinding.get(declaration)??[]).some((source)=>{const unwrapped=boundedUnwrap(source);return unwrapped!==null&&!ts.isIdentifier(unwrapped);}));return grounded?constantUnknown:constantUnsafe;}const sources=assignmentsByBinding.get(binding.declaration);if(!sources||sources.length===0)return constantUnknown;stack.add(binding.declaration);let result:ConstantStringResult=constantUnknown;for(const source of sources)result=merge(result,evaluate(source,stack,depth+1,budget));stack.delete(binding.declaration);return result;}if(ts.isBinaryExpression(current)&&current.operatorToken.kind===ts.SyntaxKind.PlusToken)return concatenate(evaluate(current.left,stack,depth+1,budget),evaluate(current.right,stack,depth+1,budget));return constantUnknown;};
  const evaluatePath=(expression:ts.Expression):ConstantStringResult=>bindingCount>constantStringMaxBindings||assignmentCount>constantStringMaxBindings?constantUnsafe:evaluate(expression,new Set(),0,{nodes:0});
  const constructorAccess=(expression:ts.Expression):boolean=>{const current=boundedUnwrap(expression);if(current===null){errors.push("constructor taint bound");return true;}if(ts.isPropertyAccessExpression(current))return current.name.text==="constructor";if(ts.isElementAccessExpression(current)&&current.argumentExpression)return evaluatePath(current.argumentExpression).values.includes("constructor");return false;};
  const objectTainted=new Set<ts.VariableDeclaration>();if(assignmentCount<=constantStringMaxBindings){let changedAtBound=false;for(let pass=0;pass<=assignments.length;pass+=1){let changed=false;for(const assignment of assignments){const target=targetBinding(assignment.target);if("values" in target)continue;const current=boundedUnwrap(assignment.expression);if(current===null){errors.push("constructor taint bound");continue;}let tainted=constructorAccess(current);if(ts.isIdentifier(current)){const source=bindingFor(current);tainted=tainted||!("values" in source)&&objectTainted.has(source.declaration);}if(tainted&&!objectTainted.has(target.declaration)){objectTainted.add(target.declaration);changed=true;}}if(!changed){changedAtBound=false;break;}changedAtBound=pass===assignments.length;}if(changedAtBound)errors.push("constructor taint iteration");}
  const inspectTaintedUse=(expression:ts.Expression):void=>{const target=boundedUnwrap(expression);if(target===null){errors.push("constructor taint bound");return;}if(!ts.isIdentifier(target))return;const binding=bindingFor(target);if("values" in binding){if(binding.unsafe)errors.push("constructor key resolution");return;}const constant=evaluatePath(target);if(objectTainted.has(binding.declaration)||constant.values.includes("constructor"))errors.push("constructor tainted use");else if(constant.unsafe)errors.push("constructor key resolution");};
  type ExtractorKind="descriptor"|"descriptors";const objectAliases=new Set<ts.VariableDeclaration>();const extractorAliases=new Map<ts.VariableDeclaration,ExtractorKind>();
  const objectBuiltinFor=(expression:ts.Expression):boolean=>{const current=boundedUnwrap(expression);if(current===null||!ts.isIdentifier(current))return false;if(current.text==="Object")return true;const binding=bindingFor(current);return!("values" in binding)&&objectAliases.has(binding.declaration);};
  if(assignmentCount<=constantStringMaxBindings){for(let pass=0;pass<=assignments.length;pass+=1){let changed=false;for(const assignment of assignments){const target=targetBinding(assignment.target);if("values" in target||objectAliases.has(target.declaration))continue;if(objectBuiltinFor(assignment.expression)){objectAliases.add(target.declaration);changed=true;}}if(!changed)break;if(pass===assignments.length)errors.push("property extractor iteration");}}
  const directExtractor=(expression:ts.Expression):ExtractorKind|null=>{const current=boundedUnwrap(expression);if(current===null||!ts.isPropertyAccessExpression(current)||current.questionDotToken)return null;const objectRoot=objectBuiltinFor(current.expression);const reflectRoot=ts.isIdentifier(current.expression)&&current.expression.text==="Reflect";if((objectRoot||reflectRoot)&&current.name.text==="getOwnPropertyDescriptor")return"descriptor";if(objectRoot&&current.name.text==="getOwnPropertyDescriptors")return"descriptors";return null;};
  const extractorFor=(expression:ts.Expression):ExtractorKind|null=>{const direct=directExtractor(expression);if(direct!==null)return direct;const current=boundedUnwrap(expression);if(current===null||!ts.isIdentifier(current))return null;const binding=bindingFor(current);return"values" in binding?null:extractorAliases.get(binding.declaration)??null;};
  if(assignmentCount<=constantStringMaxBindings){for(let pass=0;pass<=assignments.length;pass+=1){let changed=false;for(const assignment of assignments){const target=targetBinding(assignment.target);if("values" in target||extractorAliases.has(target.declaration))continue;const kind=extractorFor(assignment.expression);if(kind!==null){extractorAliases.set(target.declaration,kind);changed=true;}}if(!changed)break;if(pass===assignments.length)errors.push("property extractor iteration");}}
  const inspectExtractorCall=(call:ts.CallExpression):void=>{let kind=extractorFor(call.expression);let keyIndex=1;if(kind===null){const callee=boundedUnwrap(call.expression);if(callee!==null&&ts.isPropertyAccessExpression(callee)){kind=extractorFor(callee.expression);if(kind!==null){if(callee.name.text!=="call"){errors.push("property extractor escape");return;}keyIndex=2;}}}if(kind==="descriptor"){const key=call.arguments[keyIndex];if(key){const result=evaluatePath(key);if(result.values.includes("constructor")||result.unsafe)errors.push("constructor descriptor key");}}};
  const computedSelection=(name:ts.PropertyName):ConstantStringResult=>{if(ts.isIdentifier(name)||ts.isStringLiteral(name)||ts.isNumericLiteral(name))return literalResult(name.text);if(ts.isComputedPropertyName(name))return evaluatePath(name.expression);return constantUnknown;};
  const assignmentDestructuringProperty=(node:ts.PropertyAssignment|ts.ShorthandPropertyAssignment):boolean=>{for(let current:ts.Node|undefined=node.parent;current&&!ts.isStatement(current);current=current.parent)if(ts.isBinaryExpression(current)&&current.operatorToken.kind===ts.SyntaxKind.EqualsToken)return current.left.pos<=node.pos&&node.end<=current.left.end;return false;};
  const declarationNameExpression=(node:ts.Expression):boolean=>{const parent=node.parent;if((ts.isVariableDeclaration(parent)||ts.isParameter(parent)||ts.isBindingElement(parent)||ts.isFunctionDeclaration(parent)||ts.isFunctionExpression(parent)||ts.isClassDeclaration(parent)||ts.isClassExpression(parent)||ts.isMethodDeclaration(parent)||ts.isMethodSignature(parent)||ts.isPropertyDeclaration(parent)||ts.isPropertySignature(parent)||ts.isPropertyAssignment(parent))&&parent.name===node)return true;if(ts.isComputedPropertyName(parent)&&parent.expression===node){const owner=parent.parent;return(ts.isMethodDeclaration(owner)||ts.isMethodSignature(owner))&&owner.name===parent;}return false;};
  const inspect=(node:ts.Node):void=>{
    if(ts.isExpression(node)&&!declarationNameExpression(node)){const constant=evaluatePath(node);if(constant.values.includes("constructor"))errors.push("constructor constant expression");else if(constant.unsafe&&(ts.isReturnStatement(node.parent)||ts.isCallExpression(node.parent)||ts.isNewExpression(node.parent)))errors.push("constructor key resolution");}
    if(ts.isIdentifier(node)&&node.text==="Reflect"&&!isPropertyName(node)){const access=node.parent;const accessOuter=ts.isPropertyAccessExpression(access)?outerTransparent(access):access;const directOwnKeys=ts.isPropertyAccessExpression(access)&&access.expression===node&&!access.questionDotToken&&access.name.text==="ownKeys"&&ts.isCallExpression(accessOuter.parent)&&accessOuter.parent.expression===accessOuter;const descriptorAccess=ts.isPropertyAccessExpression(access)&&access.expression===node&&!access.questionDotToken&&access.name.text==="getOwnPropertyDescriptor";if(!directOwnKeys&&!descriptorAccess)errors.push("reflect method denied");}
    if(ts.isCallExpression(node))inspectExtractorCall(node);
    if(ts.isPropertyAccessExpression(node)&&directExtractor(node)!==null){const outer=outerTransparent(node);const parent=outer.parent;const directCall=ts.isCallExpression(parent)&&parent.expression===outer;const variableAlias=ts.isVariableDeclaration(parent)&&parent.initializer===outer&&ts.isIdentifier(parent.name);const assignmentLeft=ts.isBinaryExpression(parent)?boundedUnwrap(parent.left as ts.Expression):null;const assignmentAlias=ts.isBinaryExpression(parent)&&parent.operatorToken.kind===ts.SyntaxKind.EqualsToken&&parent.right===outer&&assignmentLeft!==null&&ts.isIdentifier(assignmentLeft);const callMember=ts.isPropertyAccessExpression(parent)&&parent.expression===outer&&parent.name.text==="call"&&ts.isCallExpression(parent.parent)&&parent.parent.expression===parent;if(!directCall&&!variableAlias&&!assignmentAlias&&!callMember)errors.push("property extractor escape");}
    if(ts.isElementAccessExpression(node)&&objectBuiltinFor(node.expression)&&node.argumentExpression){const member=evaluatePath(node.argumentExpression);if(member.values.some((value)=>value==="getOwnPropertyDescriptor"||value==="getOwnPropertyDescriptors")||member.unsafe)errors.push("property extractor escape");}
    if(ts.isBindingElement(node)&&!node.dotDotDotToken){const selection=node.propertyName??(ts.isIdentifier(node.name)?node.name:null);if(selection!==null){const result=computedSelection(selection);if(result.values.includes("constructor")||result.unsafe)errors.push("constructor destructuring");else if(result.values.some((value)=>value==="getOwnPropertyDescriptor"||value==="getOwnPropertyDescriptors"))errors.push("property extractor escape");}}
    if((ts.isPropertyAssignment(node)||ts.isShorthandPropertyAssignment(node))&&assignmentDestructuringProperty(node)){const result=computedSelection(node.name);if(result.values.includes("constructor")||result.unsafe)errors.push("constructor destructuring");else if(result.values.some((value)=>value==="getOwnPropertyDescriptor"||value==="getOwnPropertyDescriptors"))errors.push("property extractor escape");}
    if(ts.isElementAccessExpression(node)&&node.argumentExpression){const key=evaluatePath(node.argumentExpression);if(key.values.includes("constructor"))errors.push("constructor access");else if(key.unsafe)errors.push("constructor key resolution");}
    if(ts.isPropertyAccessExpression(node)&&node.name.text==="constructor")errors.push("constructor access");if(ts.isPropertyAccessExpression(node)&&["bind","apply"].includes(node.name.text)&&extractorFor(node.expression)!==null)errors.push("property extractor escape");if(ts.isNewExpression(node)&&extractorFor(node.expression)!==null)errors.push("property extractor escape");if(ts.isCallExpression(node)||ts.isNewExpression(node))inspectTaintedUse(node.expression);if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))inspectTaintedUse(node.expression);ts.forEachChild(node,inspect);
  };inspect(file);return errors;
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
function auditAdapterWireShape(source:string):string[]{
  const file=ts.createSourceFile("adapter-wire.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const errors:string[]=[];
  let rawHeadersDeclared=false;let callerHeaderPush=false;let hostPush=false;let rawHeadersFrozen=false;let requestUsesRawHeaders=false;let pinnedAllShape=false;let readsAll=false;let allCallback=false;let scalarCallback=false;
  const visit=(node:ts.Node):void=>{
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="rawHeaders"&&node.initializer&&ts.isArrayLiteralExpression(node.initializer)&&node.initializer.elements.length===0)rawHeadersDeclared=true;
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="pinnedLookupAll"&&node.initializer&&ts.isCallExpression(node.initializer)&&ts.isPropertyAccessExpression(node.initializer.expression)&&ts.isIdentifier(node.initializer.expression.expression)&&node.initializer.expression.expression.text==="Object"&&node.initializer.expression.name.text==="freeze"){const array=node.initializer.arguments[0];if(array&&ts.isArrayLiteralExpression(array)&&array.elements.length===1){const frozen=array.elements[0];if(ts.isCallExpression(frozen)&&ts.isPropertyAccessExpression(frozen.expression)&&frozen.expression.name.text==="freeze"){const object=frozen.arguments[0];if(object&&ts.isObjectLiteralExpression(object)){const keys=object.properties.flatMap((property)=>ts.isPropertyAssignment(property)&&ts.isIdentifier(property.name)?[property.name.text]:[]);pinnedAllShape=JSON.stringify(keys)===JSON.stringify(["address","family"]);}}}}
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="rawHeaders"&&node.expression.name.text==="push"){if(node.arguments.length===2&&ts.isIdentifier(node.arguments[0])&&node.arguments[0].text==="name"&&ts.isIdentifier(node.arguments[1])&&node.arguments[1].text==="value")callerHeaderPush=true;if(node.arguments.length===2&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==="host"&&ts.isPropertyAccessExpression(node.arguments[1])&&ts.isIdentifier(node.arguments[1].expression)&&node.arguments[1].expression.text==="options"&&node.arguments[1].name.text==="hostHeader")hostPush=true;}
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="Object"&&node.expression.name.text==="freeze"&&node.arguments[0]&&ts.isIdentifier(node.arguments[0])&&node.arguments[0].text==="rawHeaders")rawHeadersFrozen=true;
    if(ts.isPropertyAssignment(node)&&ts.isIdentifier(node.name)&&node.name.text==="headers"&&ts.isIdentifier(node.initializer)&&node.initializer.text==="rawHeaders")requestUsesRawHeaders=true;
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="Object"&&node.expression.name.text==="getOwnPropertyDescriptor"&&node.arguments[1]&&ts.isStringLiteral(node.arguments[1])&&node.arguments[1].text==="all")readsAll=true;
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="callback"){if(node.arguments.length===2&&ts.isIdentifier(node.arguments[1])&&node.arguments[1].text==="pinnedLookupAll")allCallback=true;if(node.arguments.length===3&&ts.isPropertyAccessExpression(node.arguments[1])&&node.arguments[1].name.text==="pinnedAddress"&&ts.isPropertyAccessExpression(node.arguments[2])&&node.arguments[2].name.text==="family")scalarCallback=true;}
    ts.forEachChild(node,visit);
  };visit(file);
  if(!rawHeadersDeclared||!callerHeaderPush||!hostPush||!rawHeadersFrozen||!requestUsesRawHeaders)errors.push("adapter raw headers");
  if(!pinnedAllShape||!readsAll||!allCallback||!scalarCallback)errors.push("adapter lookup all mode");
  return errors;
}
function auditAdapter(source:string):string[]{
  const file=ts.createSourceFile("adapter.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const trackedBindings=trackedNodeImports(file);
  const errors:string[]=constructorTaintAuditErrors(file);
  const imports=new Set<string>();const importCounts=new Map<string,number>();const importedMembers=new Map<string,Set<string>>();
  const dangerousAliases=new Set(["require","fetch","eval","Function"]);
  let strictHeaders=false;let exactCa=false;let caClone=false;let headerMapOverride=false;let sharedDestroy=false;let constructsResolver=false;
  const realResolverMembers=new Set<string>();let realOperationsDeclarations=0;const adapterFunctionCounts=new Map<string,number>();const productionFeatureKeys=new Set<string>();const productionIdentifiers=new Set<string>();
  let productionUsesOwnDescriptors=false;let productionUsesPrototype=false;let unsupportedBranch=false;
  const responseListenerPositions=new Map<string,number>();let removesResponseError=false;let responseFailureGate=false;let responseFailureLatch=false;let responseFailureSocket=false;let responseFailureDestroy=false;
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
    if(ts.isBindingElement(node)){const key=node.propertyName??node.name;if(ts.isIdentifier(key)&&key.text==="constructor")errors.push("constructor access");}
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
      if(node.name.text==="constructor")errors.push("constructor access");
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
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==="response"&&insideNamedFunction(node,"adaptNodeRequest")){const event=node.arguments[0];if(event&&ts.isStringLiteral(event)){if(node.expression.name.text==="on"&&!responseListenerPositions.has(event.text)){const listener=node.arguments[1];if(["aborted","error"].includes(event.text)&&(!listener||!ts.isIdentifier(listener)||listener.text!=="responseSocketFailure"))errors.push(`response ${event.text} listener binding`);responseListenerPositions.set(event.text,node.pos);}if(node.expression.name.text==="removeListener"&&event.text==="error")removesResponseError=true;}}
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==="responseSocketFailure"&&node.initializer&&ts.isArrowFunction(node.initializer)){const inspectFailure=(child:ts.Node):void=>{if(ts.isIfStatement(child)&&ts.isPrefixUnaryExpression(child.expression)&&child.expression.operator===ts.SyntaxKind.ExclamationToken&&ts.isIdentifier(child.expression.operand)&&child.expression.operand.text==="callbackGate"&&ts.isReturnStatement(child.thenStatement))responseFailureGate=true;if(ts.isBinaryExpression(child)&&child.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(child.left)&&child.left.text==="callbackGate"&&child.right.kind===ts.SyntaxKind.FalseKeyword)responseFailureLatch=true;if(ts.isCallExpression(child)&&ts.isPropertyAccessExpression(child.expression)&&ts.isIdentifier(child.expression.expression)&&child.expression.expression.text==="callbacks"&&child.expression.name.text==="onError"&&child.arguments[0]&&ts.isStringLiteral(child.arguments[0])&&child.arguments[0].text==="socket")responseFailureSocket=true;if(ts.isCallExpression(child)&&ts.isIdentifier(child.expression)&&child.expression.text==="destroyOnce")responseFailureDestroy=true;ts.forEachChild(child,inspectFailure);};inspectFailure(node.initializer.body);}
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
        if(property.name.text==="headers")strictHeaders=ts.isIdentifier(property.initializer)&&property.initializer.text==="rawHeaders";
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
  const abortedPosition=responseListenerPositions.get("aborted");const errorPosition=responseListenerPositions.get("error");const dataPosition=responseListenerPositions.get("data");const endPosition=responseListenerPositions.get("end");if(abortedPosition===undefined||errorPosition===undefined||dataPosition===undefined||endPosition===undefined||abortedPosition>dataPosition||abortedPosition>endPosition||errorPosition>dataPosition||errorPosition>endPosition)errors.push("response listener ordering");if(removesResponseError||!responseFailureGate||!responseFailureLatch||!responseFailureSocket||!responseFailureDestroy)errors.push("response socket quarantine");
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
  const file=ts.createSourceFile("non-adapter.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const errors:string[]=constructorTaintAuditErrors(file);let utilImports=0;
  for(const statement of file.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==="node:util"&&exactUtilImport(statement))utilImports+=1;
  if(utilImports>1)errors.push("duplicate util import");
  const visit=(node:ts.Node):void=>{
    if(ts.isIdentifier(node)&&node.text==="utilTypes"&&!ts.isImportSpecifier(node.parent)){const outer=outerTransparent(node);if(!(ts.isPropertyAccessExpression(outer.parent)&&outer.parent.expression===outer&&["isProxy","isNativeError"].includes(outer.parent.name.text)&&ts.isCallExpression(outer.parent.parent)&&outer.parent.parent.expression===outer.parent))errors.push("util binding context");}
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&!isRelativeSpecifier(node.moduleSpecifier.text)&&!exactUtilImport(node))errors.push("production import denied");
    if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&!isRelativeSpecifier(node.moduleSpecifier.text))errors.push("production export denied");
    if(ts.isImportEqualsDeclaration(node))errors.push("production import equals denied");
    if(ts.isBindingElement(node)){const key=node.propertyName??node.name;if(ts.isIdentifier(key)&&key.text==="constructor")errors.push("constructor access");}
    if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push("production dynamic import denied");
      if(ts.isIdentifier(node.expression)&&forbiddenExecutionIdentifiers.has(node.expression.text))errors.push("production execution denied");
      if(ts.isPropertyAccessExpression(node.expression)&&(forbiddenMemberNames.has(node.expression.name.text)||node.expression.name.text==="createRequire"))errors.push("production member call denied");
      if(ts.isElementAccessExpression(node.expression)){const argument=node.expression.argumentExpression;if(!argument||!ts.isStringLiteral(argument)||forbiddenMemberNames.has(argument.text)||["WebSocket","EventSource","XMLHttpRequest"].includes(argument.text))errors.push("production computed call denied");}
    }
    if(ts.isIdentifier(node)&&globalObjectIdentifiers.has(node.text)&&!isPropertyName(node))errors.push("production global object denied");
    if(ts.isIdentifier(node)&&(forbiddenExecutionIdentifiers.has(node.text)||node.text==="process"||node.text==="module")&&!isPropertyName(node))errors.push("production execution binding denied");
    if(ts.isPropertyAccessExpression(node)){if(node.name.text==="constructor")errors.push("constructor access");const root=rootIdentifier(node.expression);if((root==="globalThis"||root==="window"||root==="self")&&["fetch","WebSocket","EventSource","XMLHttpRequest"].includes(node.name.text))errors.push("production global denied");if(root==="navigator"&&node.name.text==="sendBeacon")errors.push("production beacon denied");}
    if(ts.isElementAccessExpression(node)){const root=rootIdentifier(node.expression);if(root==="globalThis"||root==="window"||root==="self"){const argument=node.argumentExpression;if(!argument||!ts.isStringLiteral(argument)||["fetch","WebSocket","EventSource","XMLHttpRequest"].includes(argument.text))errors.push("production computed global denied");}}
    ts.forEachChild(node,visit);
  };visit(file);return errors;
}
function auditTestNetworkSource(source:string):string[]{
  const file=ts.createSourceFile("unit.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const errors:string[]=constructorTaintAuditErrors(file);
  const visit=(node:ts.Node):void=>{
    if(ts.isBindingElement(node)){const key=node.propertyName??node.name;if(ts.isIdentifier(key)&&key.text==="constructor")errors.push("constructor access");}
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&isNetworkCapableSpecifier(node.moduleSpecifier.text))errors.push("test network import denied");
    if(ts.isImportEqualsDeclaration(node))errors.push("test import equals denied");
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){const argument=node.arguments[0];if(!argument||!ts.isStringLiteral(argument)||isNetworkCapableSpecifier(argument.text))errors.push("test dynamic network import denied");}
    if(ts.isIdentifier(node)&&globalObjectIdentifiers.has(node.text)&&!isPropertyName(node)&&!isExactTestGlobalUrl(node))errors.push("test global object denied");
    if(ts.isIdentifier(node)&&forbiddenExecutionIdentifiers.has(node.text)&&!isPropertyName(node))errors.push("test network execution denied");
    if(ts.isPropertyAccessExpression(node)){if(node.name.text==="constructor")errors.push("constructor access");const root=rootIdentifier(node.expression);if((root==="globalThis"||root==="window"||root==="self")&&["fetch","WebSocket","EventSource","XMLHttpRequest"].includes(node.name.text))errors.push("test network global denied");if(node.name.text==="createRequire"||node.name.text==="require")errors.push("test require denied");}
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
const auditedExtensions=new Set([".ts",".tsx",".mts",".cts",".js",".mjs",".cjs"]);
function recursivelyEnumerateAuditFiles(directory:string):readonly string[]{
  const normalizedRoot=path.resolve(directory);const output:string[]=[];
  const walk=(current:string):void=>{const normalized=path.resolve(current);const relative=path.relative(normalizedRoot,normalized);if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("audit path escape");const stat=fs.lstatSync(normalized);if(stat.isSymbolicLink())throw new Error("audit symlink denied");if(stat.isDirectory()){for(const name of fs.readdirSync(normalized).sort())walk(path.join(normalized,name));return;}if(stat.isFile()&&auditedExtensions.has(path.extname(normalized)))output.push(normalized);};
  walk(normalizedRoot);return Object.freeze(output);
}
function auditProductionTree(directory:string,adapterFile?:string):string[]{const normalizedAdapter=adapterFile===undefined?undefined:path.resolve(adapterFile);const errors:string[]=[];for(const file of recursivelyEnumerateAuditFiles(directory)){const source=fs.readFileSync(file,"utf8");const findings=file===normalizedAdapter?[...auditAdapter(source),...auditAdapterWireShape(source)]:auditNonAdapterSource(source);for(const finding of findings)errors.push(`${path.relative(path.resolve(directory),file)}: ${finding}`);}return errors;}
function directModuleExportNames(source:string):readonly string[]{const file=ts.createSourceFile("direct-module.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);const names:string[]=[];for(const statement of file.statements){if(ts.isExportDeclaration(statement)){if(statement.exportClause&&ts.isNamedExports(statement.exportClause))for(const element of statement.exportClause.elements)names.push(element.name.text);else names.push("<non-named-export>");continue;}const modifiers=ts.canHaveModifiers(statement)?ts.getModifiers(statement):undefined;if(!modifiers?.some((modifier)=>modifier.kind===ts.SyntaxKind.ExportKeyword))continue;if(ts.isVariableStatement(statement)){for(const declaration of statement.declarationList.declarations)if(ts.isIdentifier(declaration.name))names.push(declaration.name.text);continue;}if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement)||ts.isInterfaceDeclaration(statement)||ts.isTypeAliasDeclaration(statement)||ts.isEnumDeclaration(statement))&&statement.name)names.push(statement.name.text);}return names.sort();}
function acquisitionUnitIsolationErrors():string[]{
  const errors:string[]=[];
  for(const relativeDirectory of ["tests/acquisition","tests/helpers"]){const directory=path.join(root,relativeDirectory);for(const file of recursivelyEnumerateAuditFiles(directory))errors.push(...auditAcquisitionUnitSource(fs.readFileSync(file,"utf8"),path.relative(root,file)));}
  return errors;
}

describe("Node operations adapter audit",()=>{
  test("audits sole real Node adapter imports methods production features and approved request options by TypeScript AST",()=>{
    expect(auditProductionTree(path.join(root,"src/acquisition"),adapterPath)).toEqual([]);
    expect(acquisitionUnitIsolationErrors()).toEqual([]);
  });

  test("locks the direct pinned-hop module API without exposing the raw adapter",()=>{const source=fs.readFileSync(adapterPath,"utf8");expect(directModuleExportNames(source)).toEqual(["NodeClockInternal","NodeHopProtocolFailureInternal","NodeOperationsInternal","NodePinnedHopCallbacksInternal","NodePinnedHopFailureCodeInternal","NodePinnedHopHandleInternal","NodePinnedHopSettlementInternal","NodeRequestCallbacksInternal","NodeRequestHandleInternal","NodeRequestOptionsInternal","NodeRequestOwnedAgentInternal","NodeResolverInternal","NodeRuntimeCapabilitiesInternal","PinnedHopOpenRequestInternal","PinnedHopRuntimeErrorCodeInternal","PinnedHopRuntimeErrorInternal","PinnedHopRuntimeInternal","PinnedProviderTargetInternal","SecureTransportError","SecureTransportErrorCode","assertPinnedHopRuntimeInternal","createNodeDnsResolver","createNodeRuntimeCapabilitiesInternal","createPinnedHopRuntimeInternal","getNodeRuntimeClockInternal","realNodeOperations"].sort());expect(source).not.toContain("adaptNodeRequestInternal");});

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
      [`${base}\nconst ctor=Object.constructor;void ctor;`,"constructor access"],
      [`${base}\nconst ctor=({}).constructor.constructor;void ctor;`,"constructor access"],
      [`${base}\nconst ctor=value["constructor"];void ctor;`,"constructor access"],
      [`${base}\nconst ctor=value["con"+"structor"];void ctor;`,"constructor access"],
      [`${base}\nconst key="constructor";const F=({})[key][key];F("return fetch('https://example.invalid')")();`,"constructor access"],
      [`${base}\nconst first="con";const second=\`structor\`;const alias=(first+second) as string;const key=(alias)!;void value[key];`,"constructor access"],
      [`${base}\nconst key=\`constructor\`;let F;F=({})[key];new F();`,"constructor access"],
      [`${base}\nlet assignedKey;assignedKey="constructor";const F=({})[assignedKey][assignedKey];F("x")();`,"constructor access"],
      [`${base}\nlet assignedKey;void value[assignedKey];assignedKey=("con"+\`structor\`);`,"constructor access"],
      [`${base}\nvar assignedKey;let alias;alias=assignedKey;assignedKey=("constructor" as string)!;void value[alias];`,"constructor access"],
      [`${base}\nlet assignedKey="safe";assignedKey="constructor";assignedKey=readKey();void value[assignedKey];`,"constructor access"],
      [`${base}\nconst key="constructor";const F=Reflect.get(Object.prototype,key);F("x")();`,"reflect method denied"],
      [`${base}\nconst R=(Reflect);const getter=R["get"];getter.call(null,Object.prototype,"constructor");`,"reflect method denied"],
      [`${base}\nReflect.set(value,"x",1);`,"reflect method denied"],
      [`${base}\n(Reflect.apply).call(null,fn,null,[]);`,"reflect method denied"],
      [`${base}\nReflect["construct"](fn,[]);`,"reflect method denied"],
      [`${base}\nlet key;key="constructor";const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,key);void descriptor?.value;`,"constructor descriptor key"],
      [`${base}\nconst descriptorOf=(Object.getOwnPropertyDescriptor);let key;key="constructor";void descriptorOf(Object.prototype,key);`,"constructor descriptor key"],
      [`${base}\nconst O=(Object);let key;key="constructor";void O.getOwnPropertyDescriptor(Object.prototype,key);`,"constructor descriptor key"],
      [`${base}\nconst {getOwnPropertyDescriptor:descriptorOf}=Object;void descriptorOf;`,"property extractor escape"],
      [`${base}\nfunction get(object,key){return object[key];}const key="constructor";const F=get(Object.prototype,key);F("x")();`,"constructor constant expression"],
      [`${base}\nfunction get(object,key="constructor"){return object[key];}void get;`,"constructor constant expression"],
      [`${base}\nconst keyFactory=function(){return ("con"+"structor");};const key=keyFactory();void key;`,"constructor constant expression"],
      [`${base}\nconst keyFactory=()=>\`constructor\`;void keyFactory;`,"constructor constant expression"],
      [`${base}\nlet first,second;first=second;second="constructor";function get(object,key){return object[key];}void get(Object.prototype,first);`,"constructor constant expression"],
      [`${base}\nlet key;key="constructor";const {[key]:F,...rest}=Object.prototype;void F;void rest;`,"constructor destructuring"],
      [`${base}\nlet key,F;key=("con"+\`structor\`);({[key]:F}=Object.prototype);void F;`,"constructor destructuring"],
      [`${base}\nlet first,second;first=second;second=\`constructor\`;const {[first]:F}=Object.prototype;void F;`,"constructor destructuring"],
      [`${base}\nconst {constructor:ctor}=value;void ctor;`,"constructor access"],
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
    expect(auditAdapterWireShape(base.replace("headers:rawHeaders","headers:[[\"accept\",\"x\"],[\"host\",options.hostHeader]]"))).toContain("adapter raw headers");
    expect(auditAdapterWireShape(base.replace('Object.getOwnPropertyDescriptor(lookupOptions,"all")','undefined'))).toContain("adapter lookup all mode");
    expect(auditAdapter(`${base}\nconst constructor=readKey();class Safe{constructor(){}method(){return "constructors require care";}}const holder={self:1};void holder.self;void constructor;void Safe;`)).toEqual([]);
    expect(auditAdapter(`${base}\nconst key=readKey();const descriptor=Object.getOwnPropertyDescriptor(value,key);void descriptor?.value;const descriptors=Object.getOwnPropertyDescriptors(value);void descriptors[key];const object={[key]:1};void object;void Reflect.ownKeys(value);const safe="ordinary";void value[safe];let assigned;assigned=1;void value[assigned];`)).toEqual([]);
  });

  test("rejects default-denied production imports and network execution escapes outside the sole adapter",()=>{const cases=[
    'import fs from "node:fs";','import child from "node:child_process";','import workers from "node:worker_threads";','import vm from "node:vm";','import external from "node-fetch";','import cross from "cross-fetch";','import undiciClient from "undici";','import httpProxy from "http-proxy-agent";','import httpsProxy from "https-proxy-agent";','import socksProxy from "socks-proxy-agent";','import anything from "some-external-package";',
    'import net from "node:net";','import http2 from "node:http2";','import https from "https";','import dns from "dns";','import promises from "dns/promises";','import hidden from "node:https/subpath";',
    'const spec="node:net";void import(spec);','void import("./relative.js");','void import("http2");','const load=require;load("https");','module.require("dns");','module.createRequire(import.meta.url);','void globalThis.fetch("https://example.invalid");','import undici from "undici";',
    'exec("x");','execFile("x");','spawn("x");','fork("x");','new Worker("x");','vm.runInNewContext("x");','eval("x");','Function("x")();','const ctor=Object.constructor;void ctor;','const ctor=({}).constructor.constructor;void ctor;','const ctor=value["constructor"];void ctor;','const key="constructor";const F=({})[key][key];F("return fetch(\\"https://example.invalid\\")")();','const first="con";const second=`structor`;const alias=(first+second) as string;const key=(alias)!;void value[key];','const key=`constructor`;let F;F=({})[key];new F();','let key;key="constructor";const F=({})[key][key];F("x")();','let key;void value[key];key=("con"+`structor`);','var key;let alias;alias=key;key=("constructor" as string)!;void value[alias];','let key="safe";key="constructor";key=readKey();void value[key];','const key="constructor";const F=Reflect.get(Object.prototype,key);F("x")();','const R=(Reflect);const getter=R["get"];getter.call(null,Object.prototype,"constructor");','Reflect.set(value,"x",1);','(Reflect.apply).call(null,fn,null,[]);','Reflect["construct"](fn,[]);','let key;key="constructor";const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,key);void descriptor?.value;','const descriptorOf=(Object.getOwnPropertyDescriptor);let key;key="constructor";void descriptorOf(Object.prototype,key);','const O=(Object);let key;key="constructor";void O.getOwnPropertyDescriptor(Object.prototype,key);','const {getOwnPropertyDescriptor:descriptorOf}=Object;void descriptorOf;','function get(object,key){return object[key];}const key="constructor";const F=get(Object.prototype,key);F("x")();','function get(object,key="constructor"){return object[key];}void get;','const keyFactory=function(){return ("con"+"structor");};const key=keyFactory();void key;','const keyFactory=()=>`constructor`;void keyFactory;','let first,second;first=second;second="constructor";function get(object,key){return object[key];}void get(Object.prototype,first);','let key;key="constructor";const {[key]:F,...rest}=Object.prototype;void F;void rest;','let key,F;key=("con"+`structor`);({[key]:F}=Object.prototype);void F;','let first,second;first=second;second=`constructor`;const {[first]:F}=Object.prototype;void F;','const {constructor:ctor}=value;void ctor;','const g=globalThis;void g;','let g;g=(globalThis);','const {fetch:renamed}=globalThis;void renamed;','function leak(){return globalThis;}','Reflect.get(globalThis,"fetch");','void window.location;','void self.location;','void global.process;','void navigator.userAgent;','new WebSocket("x");','new EventSource("x");','new XMLHttpRequest();','navigator.sendBeacon("x");','globalThis["WebSocket"]("x");','globalThis.EventSource.bind(null);','window["fetch"]("x");','self.EventSource.call(null,"x");',
  ];for(const source of cases)expect(auditNonAdapterSource(source),source).not.toEqual([]);expect(auditNonAdapterSource('const constructor=readKey();class Safe{constructor(){}method(){return "constructors require care";}}const holder={self:1};void holder.self;void constructor;void Safe;')).toEqual([]);expect(auditNonAdapterSource('const key=readKey();const descriptor=Object.getOwnPropertyDescriptor(value,key);void descriptor?.value;const descriptors=Object.getOwnPropertyDescriptors(value);void descriptors[key];const object={[key]:1};void object;void Reflect.ownKeys(value);const safe="ordinary";void value[safe];let assigned;assigned=1;void value[assigned];')).toEqual([]);expect(auditNonAdapterSource('import {types as utilTypes} from "node:util";import value from "./local.js";void utilTypes.isProxy(value);')).toEqual([]);expect(auditNonAdapterSource('import {types as utilTypes} from "node:util";const proxyCheck=utilTypes.isProxy;void proxyCheck;')).not.toEqual([]);});

  test("bounds constant constructor-key propagation and taints aliases",()=>{const reviewer='const key="constructor";const F=({})[key][key];F("return fetch(\\"https://example.invalid\\")")();';const reviewerErrors=constructorTaintAuditErrors(ts.createSourceFile("reviewer.ts",reviewer,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS));expect(reviewerErrors).toContain("constructor access");expect(reviewerErrors).toContain("constructor tainted use");const assignedReviewer='let key;key="constructor";const F=({})[key][key];F("x")();';const assignedErrors=constructorTaintAuditErrors(ts.createSourceFile("assigned-reviewer.ts",assignedReviewer,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS));expect(assignedErrors).toContain("constructor access");expect(assignedErrors).toContain("constructor tainted use");const assignmentAlias='let a,b;a=b;b="constructor";void value[a];';expect(constructorTaintAuditErrors(ts.createSourceFile("assignment-alias.ts",assignmentAlias,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS))).toContain("constructor access");const transitive='const key="constructor";let F;F=value[key];const G=(F as unknown)!;void G.safe;';expect(constructorTaintAuditErrors(ts.createSourceFile("transitive.ts",transitive,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS))).toContain("constructor tainted use");const cyclic='const first=second;const second=first;void value[first];';expect(constructorTaintAuditErrors(ts.createSourceFile("cycle.ts",cyclic,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS))).toContain("constructor key resolution");const chain=['const key0="constructor";',...Array.from({length:34},(_,index)=>`const key${index+1}=key${index};`),'void value[key34];'].join("");expect(constructorTaintAuditErrors(ts.createSourceFile("depth.ts",chain,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS))).toContain("constructor key resolution");});

  test("recursively audits nested source extensions and rejects symlink entries",()=>{const temporary=fs.mkdtempSync(path.join(process.env.TMPDIR??"/tmp","pi-acquisition-audit-"));try{const nested=path.join(temporary,"nested","deeper");fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(path.join(nested,"escape.mts"),'import net from "node:net";void globalThis.fetch;');const nestedFindings=auditProductionTree(temporary);expect(nestedFindings.some((finding)=>finding.includes("production import denied"))).toBe(true);expect(nestedFindings.some((finding)=>finding.includes("production global object denied"))).toBe(true);const outside=path.join(temporary,"outside.ts");fs.writeFileSync(outside,"export {};\n");fs.symlinkSync(outside,path.join(nested,"linked.ts"));expect(()=>auditProductionTree(temporary)).toThrow(/symlink/u);}finally{fs.rmSync(temporary,{recursive:true,force:true});}});

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
    expect(auditAcquisitionUnitSource('const ctor=Object.constructor;void ctor;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const ctor=value["constructor"];void ctor;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const key="constructor";const F=({})[key][key];F("return fetch(\\"https://example.invalid\\")")();')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const first="con";const second=`structor`;const alias=(first+second) as string;const key=(alias)!;void value[key];')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const key=`constructor`;let F;F=({})[key];new F();')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let key;key="constructor";const F=({})[key][key];F("x")();')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let key;void value[key];key=("con"+`structor`);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('var key;let alias;alias=key;key=("constructor" as string)!;void value[alias];')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let key="safe";key="constructor";key=readKey();void value[key];')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const key="constructor";const F=Reflect.get(Object.prototype,key);F("x")();')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const R=(Reflect);const getter=R["get"];getter.call(null,Object.prototype,"constructor");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('Reflect.set(value,"x",1);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('(Reflect.apply).call(null,fn,null,[]);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('Reflect["construct"](fn,[]);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let key;key="constructor";const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,key);void descriptor?.value;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const descriptorOf=(Object.getOwnPropertyDescriptor);let key;key="constructor";void descriptorOf(Object.prototype,key);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const O=(Object);let key;key="constructor";void O.getOwnPropertyDescriptor(Object.prototype,key);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const {getOwnPropertyDescriptor:descriptorOf}=Object;void descriptorOf;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('function get(object,key){return object[key];}const key="constructor";const F=get(Object.prototype,key);F("x")();')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('function get(object,key="constructor"){return object[key];}void get;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const keyFactory=function(){return ("con"+"structor");};const key=keyFactory();void key;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const keyFactory=()=>`constructor`;void keyFactory;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let first,second;first=second;second="constructor";function get(object,key){return object[key];}void get(Object.prototype,first);')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let key;key="constructor";const {[key]:F,...rest}=Object.prototype;void F;void rest;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let key,F;key=("con"+`structor`);({[key]:F}=Object.prototype);void F;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let first,second;first=second;second=`constructor`;const {[first]:F}=Object.prototype;void F;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const {constructor:ctor}=value;void ctor;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const g=globalThis;const h=(g);Reflect.get(g,"fetch");void h["WebSocket"];')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const URLCtor=globalThis.URL;void URLCtor;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('new (globalThis.URL)("https://example.invalid");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('function leak(){return globalThis;}void leak;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('let g;g=globalThis;new g.WebSocket("x");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('Reflect.get(globalThis,"fetch");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('const constructor=readKey();class Safe{constructor(){}method(){return "constructors require care";}}const holder={self:1};void holder.self;void constructor;void Safe;new globalThis.URL("https://example.invalid");')).toEqual([]);
    expect(auditAcquisitionUnitSource('const key=readKey();const descriptor=Object.getOwnPropertyDescriptor(value,key);void descriptor?.value;const descriptors=Object.getOwnPropertyDescriptors(value);void descriptors[key];const object={[key]:1};void object;void Reflect.ownKeys(value);const safe="ordinary";void value[safe];let assigned;assigned=1;void value[assigned];')).toEqual([]);
    expect(auditAcquisitionUnitSource('import fetcher from "node-fetch";void fetcher;')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('new WebSocket("wss://example.invalid");')).not.toEqual([]);
    expect(auditAcquisitionUnitSource('import {describe} from "vitest";void describe;')).toEqual([]);
    expect(auditAcquisitionUnitSource(`import {createNodeRuntimeCapabilitiesInternal as make} from "${modulePath}";make(fakeOps);`)).toEqual([]);
  });
});
