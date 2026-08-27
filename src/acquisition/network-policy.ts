import { types as utilTypes } from "node:util";

import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";

export type AcquisitionNetworkTarget = "crossref" | "openalex" | "ncbi";
export type NetworkPolicyErrorCode =
  | "network.invalid-options" | "network.invalid-input" | "network.url-too-large"
  | "network.scheme-forbidden" | "network.origin-forbidden" | "network.credentials-forbidden"
  | "network.fragment-forbidden" | "network.ip-literal-forbidden" | "network.dns-empty"
  | "network.dns-nxdomain" | "network.dns-temporary"
  | "network.dns-too-many-addresses" | "network.dns-invalid-address"
  | "network.dns-address-forbidden" | "network.dns-mixed-addresses"
  | "network.cancelled";
export class NetworkPolicyError extends Error {
  readonly code: NetworkPolicyErrorCode;
  constructor(code: NetworkPolicyErrorCode) { super(`Network policy rejected (${code})`);this.name="NetworkPolicyError";this.code=code; }
}
export interface AcquisitionDnsAddress { readonly address: string; readonly family: 4 | 6; }
export interface AcquisitionDnsResolverDescriptor {
  readonly resolveAll: (hostname: string, signal: AbortSignal) => Promise<readonly AcquisitionDnsAddress[]>;
  readonly close: () => void;
}
export interface AcquisitionDnsResolver { readonly capabilityKind: "acquisition-dns-resolver"; }
export interface NetworkPolicyOptions {
  readonly maxDnsAddresses?: number; readonly maxCanonicalUrlBytes?: number;
  readonly maxStructureDepth?: number; readonly maxStructureNodes?: number;
  readonly maxStructureKeys?: number; readonly maxStringCanonicalBytes?: number;
  readonly maxScalarCanonicalBytes?: number;
}
export interface ValidatedProviderUrl {
  readonly target: AcquisitionNetworkTarget; readonly url: string; readonly origin: string;
  readonly hostname: string; readonly port: 443; readonly hostHeader: string;
}
export interface SafeProviderAddressSetInternal {
  readonly addresses:readonly AcquisitionDnsAddress[]; readonly allAddressesSha256:string;
}

type ResolverState = Readonly<{resolveAll:AcquisitionDnsResolverDescriptor["resolveAll"];close:AcquisitionDnsResolverDescriptor["close"]}>;
type NormalizedOptions = Required<NetworkPolicyOptions>;
type ParsedAddress = { readonly family:4|6;readonly bytes:Uint8Array;readonly address:string;readonly classification:"public"|"forbidden" };
const resolverRegistry = new WeakMap<object,ResolverState>();
const TARGET_HOSTS:Readonly<Record<AcquisitionNetworkTarget,readonly string[]>> = Object.freeze({
  crossref:Object.freeze(["api.crossref.org"]),openalex:Object.freeze(["api.openalex.org"]),
  ncbi:Object.freeze(["eutils.ncbi.nlm.nih.gov","www.ncbi.nlm.nih.gov"]),
});
const OPTION_KEYS = ["maxDnsAddresses","maxCanonicalUrlBytes","maxStructureDepth","maxStructureNodes","maxStructureKeys","maxStringCanonicalBytes","maxScalarCanonicalBytes"] as const;
const OPTION_DEFAULTS:NormalizedOptions = Object.freeze({maxDnsAddresses:16,maxCanonicalUrlBytes:4_096,maxStructureDepth:16,maxStructureNodes:10_000,maxStructureKeys:10_000,maxStringCanonicalBytes:262_144,maxScalarCanonicalBytes:1_048_576});
const OPTION_HARD:NormalizedOptions = Object.freeze({maxDnsAddresses:64,maxCanonicalUrlBytes:16_384,maxStructureDepth:64,maxStructureNodes:100_000,maxStructureKeys:100_000,maxStringCanonicalBytes:1_048_576,maxScalarCanonicalBytes:8_388_608});

function fail(code:NetworkPolicyErrorCode):never { throw new NetworkPolicyError(code); }
function isPlain(value:unknown):value is Record<string,unknown> { if(value===null||typeof value!=="object"||utilTypes.isProxy(value))return false;const prototype=Object.getPrototypeOf(value);return prototype===Object.prototype||prototype===null; }
function dataDescriptors(value:unknown,allowed:readonly string[],code:NetworkPolicyErrorCode):PropertyDescriptorMap {
  if(!isPlain(value))fail(code);let descriptors:PropertyDescriptorMap;try{descriptors=Object.getOwnPropertyDescriptors(value);}catch{return fail(code);}const keys=Reflect.ownKeys(descriptors);if(keys.some((key)=>typeof key!=="string"||!allowed.includes(key)))fail(code);for(const key of keys as string[]){const descriptor=descriptors[key]!;if(!descriptor.enumerable||!("value" in descriptor))fail(code);}return descriptors;
}
function normalizeOptions(value:NetworkPolicyOptions|undefined):NormalizedOptions {
  if(value===undefined)return OPTION_DEFAULTS;const descriptors=dataDescriptors(value,OPTION_KEYS,"network.invalid-options");const output={} as Record<typeof OPTION_KEYS[number],number>;
  for(const key of OPTION_KEYS){const raw=descriptors[key]?.value;const normalized=raw===undefined?OPTION_DEFAULTS[key]:raw;if(typeof normalized!=="number"||!Number.isSafeInteger(normalized)||normalized<1||normalized>OPTION_HARD[key])fail("network.invalid-options");output[key]=normalized;}
  return Object.freeze(output) as unknown as NormalizedOptions;
}
function canonicalStringBytes(value:string):number { if(value.length>16_384)return 16_385;return Buffer.byteLength(canonicalJson(value),"utf8"); }

export function createAcquisitionDnsResolver(descriptor:AcquisitionDnsResolverDescriptor):AcquisitionDnsResolver {
  const descriptors=dataDescriptors(descriptor,["resolveAll","close"],"network.invalid-input");if(!descriptors.resolveAll||!descriptors.close||typeof descriptors.resolveAll.value!=="function"||typeof descriptors.close.value!=="function")fail("network.invalid-input");
  const output=Object.freeze({capabilityKind:"acquisition-dns-resolver" as const});resolverRegistry.set(output,{resolveAll:descriptors.resolveAll.value as AcquisitionDnsResolverDescriptor["resolveAll"],close:descriptors.close.value as AcquisitionDnsResolverDescriptor["close"]});return output;
}

function rawAuthority(input:string):string|null { const start=input.indexOf("//");if(start<0)return null;const authorityStart=start+2;let end=input.length;for(const delimiter of ["/","?","#"]){const index=input.indexOf(delimiter,authorityStart);if(index>=0&&index<end)end=index;}return input.slice(authorityStart,end); }
export function validateFixedProviderUrl(target:AcquisitionNetworkTarget,input:unknown):ValidatedProviderUrl {
  if(target!=="crossref"&&target!=="openalex"&&target!=="ncbi")fail("network.invalid-input");if(typeof input!=="string")fail("network.invalid-input");if(input.length>16_384||canonicalStringBytes(input)>16_384)fail("network.url-too-large");
  if(input.includes("\\"))fail("network.origin-forbidden");if(input.includes("#"))fail("network.fragment-forbidden");if(!input.startsWith("https://"))fail("network.scheme-forbidden");if(/[\u0000-\u0020\u007f]/u.test(input))fail("network.origin-forbidden");
  const authority=rawAuthority(input);if(authority===null||authority.length===0)fail("network.origin-forbidden");if(authority.includes("@"))fail("network.credentials-forbidden");if(authority.includes("%")||/[^\x00-\x7f]/u.test(authority))fail("network.origin-forbidden");
  const authorityHost=authority.startsWith("[")?authority.slice(0,authority.indexOf("]")+1):authority.split(":",1)[0]!;if(authorityHost.startsWith("[")||parseIpv4(authorityHost)!==null)fail("network.ip-literal-forbidden");
  let parsed:URL;try{parsed=new URL(input);}catch{return fail("network.origin-forbidden");}if(parsed.protocol!=="https:")fail("network.scheme-forbidden");if(parsed.username!==""||parsed.password!=="")fail("network.credentials-forbidden");if(parsed.hash!=="")fail("network.fragment-forbidden");if(parseIpv4(parsed.hostname)!==null||parsed.hostname.includes(":"))fail("network.ip-literal-forbidden");
  const allowed=TARGET_HOSTS[target];if(!allowed.includes(parsed.hostname)||!(authority===parsed.hostname||authority===`${parsed.hostname}:443`))fail("network.origin-forbidden");if(parsed.port!=="")fail("network.origin-forbidden");
  const origin=`https://${parsed.hostname}`;return Object.freeze({target,url:input,origin,hostname:parsed.hostname,port:443 as const,hostHeader:parsed.hostname});
}

function parseIpv4(input:string):Uint8Array|null {
  if(input.length>15)return null;const parts=input.split(".");if(parts.length!==4)return null;const bytes=new Uint8Array(4);for(let index=0;index<4;index+=1){const part=parts[index]!;if(!/^(0|[1-9][0-9]{0,2})$/u.test(part))return null;const value=Number(part);if(value>255)return null;bytes[index]=value;}return bytes;
}
function parseIpv6(input:string):Uint8Array|null {
  if(input.length===0||input.length>64||input.includes("%")||/[^0-9a-fA-F:.]/u.test(input))return null;const double=input.indexOf("::");if(double!==-1&&input.indexOf("::",double+2)!==-1)return null;
  let text=input;if(text.includes(".")){const lastColon=text.lastIndexOf(":");if(lastColon<0)return null;const ipv4=parseIpv4(text.slice(lastColon+1));if(!ipv4)return null;text=`${text.slice(0,lastColon)}:${((ipv4[0]!<<8)|ipv4[1]!).toString(16)}:${((ipv4[2]!<<8)|ipv4[3]!).toString(16)}`;}
  const compressed=text.includes("::");const halves=compressed?text.split("::"):[text];if(halves.length>2)return null;const left=halves[0]===""?[]:halves[0]!.split(":");const right=!compressed||halves[1]===""?[]:halves[1]!.split(":");if([...left,...right].some((part)=>!/^[0-9a-fA-F]{1,4}$/u.test(part)))return null;const missing=8-left.length-right.length;if((compressed&&missing<1)||(!compressed&&missing!==0))return null;const groups=[...left.map((part)=>Number.parseInt(part,16)),...Array.from({length:missing},()=>0),...right.map((part)=>Number.parseInt(part,16))];if(groups.length!==8)return null;const bytes=new Uint8Array(16);for(let index=0;index<8;index+=1){bytes[index*2]=groups[index]!>>>8;bytes[index*2+1]=groups[index]!&255;}return bytes;
}
function bytesToIpv4(bytes:Uint8Array):string { return Array.from(bytes).join("."); }
function isMapped(bytes:Uint8Array):boolean { for(let index=0;index<10;index+=1)if(bytes[index]!==0)return false;return bytes[10]===255&&bytes[11]===255; }
function bytesToIpv6(bytes:Uint8Array):string {
  if(isMapped(bytes))return `::ffff:${bytesToIpv4(bytes.slice(12))}`;const groups=Array.from({length:8},(_,index)=>(bytes[index*2]!<<8)|bytes[index*2+1]!);let bestStart=-1;let bestLength=0;for(let index=0;index<8;){if(groups[index]!==0){index+=1;continue;}let end=index;while(end<8&&groups[end]===0)end+=1;if(end-index>bestLength&&end-index>=2){bestStart=index;bestLength=end-index;}index=end;}
  if(bestStart<0)return groups.map((value)=>value.toString(16)).join(":");const left=groups.slice(0,bestStart).map((value)=>value.toString(16)).join(":");const right=groups.slice(bestStart+bestLength).map((value)=>value.toString(16)).join(":");return `${left}::${right}`;
}
function ipv4Integer(bytes:Uint8Array):number { return (((bytes[0]!*256+bytes[1]!)*256+bytes[2]!)*256+bytes[3]!); }
const IPV4_DENIED:readonly Readonly<{start:number;prefix:number}>[] = Object.freeze([
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4],
].map(([address,prefix])=>Object.freeze({start:ipv4Integer(parseIpv4(address as string)!),prefix:prefix as number})));
function classifyIpv4Bytes(bytes:Uint8Array):"public"|"forbidden" { const value=ipv4Integer(bytes);return IPV4_DENIED.some(({start,prefix})=>{const size=2**(32-prefix);return value>=start&&value<start+size;})?"forbidden":"public"; }
function ipv6Integer(bytes:Uint8Array):bigint { let value=0n;for(const byte of bytes)value=(value<<8n)|BigInt(byte);return value; }
function ipv6Constant(input:string):bigint { return ipv6Integer(parseIpv6(input)!); }
const IPV6_DENIED:readonly Readonly<{start:bigint;prefix:number}>[] = Object.freeze([
  ["::",128],["::1",128],["::",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["2001::",23],["2001:2::",48],["2001:20::",28],["2001:db8::",32],["3fff::",20],["2002::",16],["fc00::",7],["fec0::",10],["fe80::",10],["ff00::",8],
].map(([address,prefix])=>{const normalizedPrefix=prefix as number;const raw=ipv6Constant(address as string);const hostBits=BigInt(128-normalizedPrefix);const start=(raw>>hostBits)<<hostBits;return Object.freeze({start,prefix:normalizedPrefix});}));
function classifyIpv6Bytes(bytes:Uint8Array):"public"|"forbidden" { if(isMapped(bytes))return classifyIpv4Bytes(bytes.slice(12));const value=ipv6Integer(bytes);return IPV6_DENIED.some(({start,prefix})=>{const size=1n<<BigInt(128-prefix);return value>=start&&value<start+size;})?"forbidden":"public"; }
export function classifyNetworkAddress(input:unknown):"public"|"forbidden" { if(typeof input!=="string")return"forbidden";const ipv4=parseIpv4(input);if(ipv4)return classifyIpv4Bytes(ipv4);const ipv6=parseIpv6(input);if(ipv6)return classifyIpv6Bytes(ipv6);return"forbidden"; }

function resolverState(value:unknown):ResolverState { if(value===null||typeof value!=="object"||utilTypes.isProxy(value))fail("network.invalid-input");const state=resolverRegistry.get(value);if(!state||!Object.isFrozen(value)||(value as AcquisitionDnsResolver).capabilityKind!=="acquisition-dns-resolver")fail("network.invalid-input");return state; }
function validateSignal(value:AbortSignal|undefined):AbortSignal { if(value===undefined)return new AbortController().signal;if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||!(value instanceof AbortSignal))fail("network.invalid-input");return value; }
function validateProviderUrlSnapshot(value:ValidatedProviderUrl,maximum:number):ValidatedProviderUrl {
  const descriptors=dataDescriptors(value,["target","url","origin","hostname","port","hostHeader"],"network.invalid-input");for(const key of ["target","url","origin","hostname","port","hostHeader"])if(!descriptors[key])fail("network.invalid-input");const url=descriptors.url!.value;if(typeof url!=="string")fail("network.invalid-input");if(url.length>maximum||Buffer.byteLength(canonicalJson(url),"utf8")>maximum)fail("network.url-too-large");const rebuilt=validateFixedProviderUrl(descriptors.target!.value as AcquisitionNetworkTarget,url);for(const key of ["target","url","origin","hostname","port","hostHeader"] as const)if(descriptors[key]!.value!==rebuilt[key])fail("network.invalid-input");return rebuilt;
}
function ownErrorCode(error:unknown):string|undefined { if(error===null||typeof error!=="object"||utilTypes.isProxy(error))return undefined;let descriptor:PropertyDescriptor|undefined;try{descriptor=Object.getOwnPropertyDescriptor(error,"code");}catch{return undefined;}return descriptor&&"value" in descriptor&&typeof descriptor.value==="string"?descriptor.value:undefined; }
function mapResolverError(error:unknown,signal:AbortSignal):never {
  if(signal.aborted)fail("network.cancelled");const errors=error instanceof AggregateError&&Array.isArray(error.errors)?error.errors:[error];const codes=errors.map(ownErrorCode);if(errors.some((value)=>value instanceof DOMException&&value.name==="AbortError")||codes.some((value)=>value==="ABORT_ERR"))fail("network.cancelled");if(codes.some((value)=>value==="ENOTFOUND"||value==="EAI_NONAME"))fail("network.dns-nxdomain");if(codes.some((value)=>["ETIMEOUT","EAI_AGAIN","SERVFAIL","ESERVFAIL"].includes(value??"")))fail("network.dns-temporary");if(codes.length>0&&codes.every((value)=>value==="ENODATA"||value==="EAI_NODATA"))fail("network.dns-empty");fail("network.dns-temporary");
}
function dnsStructureFailure():never { return fail("network.dns-invalid-address"); }
function rawAnswerValues(value:unknown,options:NormalizedOptions):unknown[] {
  if(value===null||typeof value!=="object"||utilTypes.isProxy(value)||!Array.isArray(value))fail("network.dns-invalid-address");let lengthDescriptor:PropertyDescriptor|undefined;try{lengthDescriptor=Object.getOwnPropertyDescriptor(value,"length");}catch{return fail("network.dns-invalid-address");}if(!lengthDescriptor||!("value" in lengthDescriptor)||typeof lengthDescriptor.value!=="number"||!Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0||typeof lengthDescriptor.writable!=="boolean"||lengthDescriptor.enumerable!==false||lengthDescriptor.configurable!==false)fail("network.dns-invalid-address");const length=lengthDescriptor.value;if(length>options.maxDnsAddresses)fail("network.dns-too-many-addresses");const minimumNodes=1+3*length;const minimumKeys=3*length;if(!Number.isSafeInteger(minimumNodes)||minimumNodes>options.maxStructureNodes||!Number.isSafeInteger(minimumKeys)||minimumKeys>options.maxStructureKeys||(length>0&&options.maxStructureDepth<2))dnsStructureFailure();if(Object.getPrototypeOf(value)!==Array.prototype)dnsStructureFailure();let descriptors:PropertyDescriptorMap;try{descriptors=Object.getOwnPropertyDescriptors(value as object) as PropertyDescriptorMap;}catch{return fail("network.dns-invalid-address");}const keys=Reflect.ownKeys(descriptors);if(keys.some((key)=>typeof key!=="string")||keys.length!==length+1)fail("network.dns-invalid-address");const output:unknown[]=[];for(let index=0;index<length;index+=1){const key=String(index);if(key.length>options.maxStringCanonicalBytes||Buffer.byteLength(canonicalJson(key),"utf8")>options.maxStringCanonicalBytes)dnsStructureFailure();const descriptor=descriptors[key];if(!descriptor||!("value" in descriptor)||!descriptor.enumerable)fail("network.dns-invalid-address");output.push(descriptor.value);}return output;
}
function parseDnsAnswer(value:unknown,options:NormalizedOptions,scalarBudget:{bytes:number}):ParsedAddress {
  const descriptors=dataDescriptors(value,["address","family"],"network.dns-invalid-address");if(!descriptors.address||!descriptors.family||typeof descriptors.address.value!=="string"||(descriptors.family.value!==4&&descriptors.family.value!==6))fail("network.dns-invalid-address");for(const key of ["address","family"]){if(key.length>options.maxStringCanonicalBytes||Buffer.byteLength(canonicalJson(key),"utf8")>options.maxStringCanonicalBytes)dnsStructureFailure();}const address=descriptors.address.value as string;if(address.length>options.maxStringCanonicalBytes)dnsStructureFailure();const addressBytes=Buffer.byteLength(canonicalJson(address),"utf8");if(addressBytes>options.maxStringCanonicalBytes)dnsStructureFailure();const familyBytes=Buffer.byteLength(canonicalJson(descriptors.family.value),"utf8");scalarBudget.bytes+=addressBytes+familyBytes;if(!Number.isSafeInteger(scalarBudget.bytes)||scalarBudget.bytes>options.maxScalarCanonicalBytes)dnsStructureFailure();const family=descriptors.family.value as 4|6;const bytes=family===4?parseIpv4(address):parseIpv6(address);if(!bytes)fail("network.dns-invalid-address");if(family===4&&parseIpv6(address)!==null)fail("network.dns-invalid-address");if(family===6&&parseIpv4(address)!==null)fail("network.dns-invalid-address");const classification=family===4?classifyIpv4Bytes(bytes):classifyIpv6Bytes(bytes);return {family,bytes,address:family===4?bytesToIpv4(bytes):bytesToIpv6(bytes),classification};
}
function compareParsed(left:ParsedAddress,right:ParsedAddress):number { if(left.family!==right.family)return left.family===4?-1:1;for(let index=0;index<left.bytes.length;index+=1){if(left.bytes[index]!==right.bytes[index])return left.bytes[index]!-right.bytes[index]!;}return 0; }

/** @internal pure policy helper; only PinnedHopRuntimeInternal may supply its owned resolver. */
export async function resolveAllSafeProviderAddressesInternal(validated:ValidatedProviderUrl,options:NetworkPolicyOptions|undefined,resolver:AcquisitionDnsResolver,signal?:AbortSignal):Promise<SafeProviderAddressSetInternal> {
  const normalizedOptions=normalizeOptions(options);const state=resolverState(resolver);const providerUrl=validateProviderUrlSnapshot(validated,normalizedOptions.maxCanonicalUrlBytes);const ownedSignal=validateSignal(signal);if(ownedSignal.aborted)fail("network.cancelled");let raw:unknown;try{raw=await state.resolveAll(providerUrl.hostname,ownedSignal);}catch(error){return mapResolverError(error,ownedSignal);}const values=rawAnswerValues(raw,normalizedOptions);if(values.length===0)fail("network.dns-empty");const scalarBudget={bytes:0};const parsed=values.map((value)=>parseDnsAnswer(value,normalizedOptions,scalarBudget));const hasPublic=parsed.some((item)=>item.classification==="public");const hasForbidden=parsed.some((item)=>item.classification==="forbidden");if(hasPublic&&hasForbidden)fail("network.dns-mixed-addresses");if(hasForbidden)fail("network.dns-address-forbidden");if(ownedSignal.aborted)fail("network.cancelled");const unique=new Map<string,ParsedAddress>();for(const item of parsed){const key=`${item.family}:${Buffer.from(item.bytes).toString("hex")}`;if(!unique.has(key))unique.set(key,item);}const ordered=[...unique.values()].sort(compareParsed);const addresses=Object.freeze(ordered.map((item)=>Object.freeze({address:item.address,family:item.family})));const allAddressesSha256=sha256Hex(canonicalJson({schemaVersion:1,addresses}));return Object.freeze({addresses,allAddressesSha256});
}
