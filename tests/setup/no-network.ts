import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import {syncBuiltinESMExports} from "node:module";
import {afterAll} from "vitest";

const installed=Object.freeze([
 "global.fetch","global.WebSocket","http.request","http.get","https.request","https.get","http2.connect","http2.session.request","http2.session.ping","http2.session.settings","net.connect","net.createConnection","tls.connect","dgram.createSocket","dgram.Socket.bind","dgram.Socket.connect","dgram.Socket.send","dns.lookup","dns.promises.lookup","dns.lookupService","dns.promises.lookupService","dns.resolve","dns.promises.resolve","dns.resolve4","dns.promises.resolve4","dns.resolve6","dns.promises.resolve6","dns.resolveAny","dns.promises.resolveAny","dns.resolveCaa","dns.promises.resolveCaa","dns.resolveCname","dns.promises.resolveCname","dns.resolveMx","dns.promises.resolveMx","dns.resolveNaptr","dns.promises.resolveNaptr","dns.resolveNs","dns.promises.resolveNs","dns.resolvePtr","dns.promises.resolvePtr","dns.resolveSoa","dns.promises.resolveSoa","dns.resolveSrv","dns.promises.resolveSrv","dns.resolveTxt","dns.promises.resolveTxt","dns.reverse","dns.promises.reverse","dns.Resolver.resolve*","dns.Resolver.reverse","dns.promises.Resolver.resolve*","dns.promises.Resolver.reverse",
] as const);
type Guard=Readonly<{installed:readonly string[];stubs:Readonly<Record<string,Function>>}>;
type State=Readonly<{forbidden:(...arguments_:unknown[])=>never;guard:Guard;attemptsAreZero:()=>boolean}>;
const stateKey=Symbol.for("pi-science-research.test-network-state");
const globalRecord=globalThis as typeof globalThis&{[stateKey]?:State;__PI_SCIENCE_TEST_NETWORK_GUARD__?:Guard};
const defineProperty=Object.defineProperty;const freeze=Object.freeze;const getOwnPropertyNames=Object.getOwnPropertyNames;
let state=globalRecord[stateKey];
if(state===undefined){
 let attempts=0;const forbidden=function(..._arguments:unknown[]):never{if(!Number.isSafeInteger(attempts)||attempts>=Number.MAX_SAFE_INTEGER)throw new Error("TEST_NETWORK_FORBIDDEN");attempts+=1;throw new Error("TEST_NETWORK_FORBIDDEN");};
 const stubRecord:Record<string,Function>=Object.create(null) as Record<string,Function>;for(const name of installed)stubRecord[name]=forbidden;
 const guard=freeze({installed,stubs:freeze(stubRecord)}),next=freeze({forbidden,guard,attemptsAreZero:()=>attempts===0});
 defineProperty(globalRecord,stateKey,{value:next,writable:false,enumerable:false,configurable:false});defineProperty(globalRecord,"__PI_SCIENCE_TEST_NETWORK_GUARD__",{value:guard,writable:false,enumerable:false,configurable:false});state=next;
 const install=(target:object,name:string):void=>{defineProperty(target,name,{value:forbidden,writable:false,enumerable:true,configurable:false});};
 install(globalThis,"fetch");install(globalThis,"WebSocket");install(http,"request");install(http,"get");install(https,"request");install(https,"get");install(http2,"connect");install(net,"connect");install(net,"createConnection");install(tls,"connect");install(dgram,"createSocket");
 for(const name of ["bind","connect","send"] as const)install(dgram.Socket.prototype,name);
 const dnsNames=["lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTxt","reverse"] as const;
 for(const name of dnsNames){install(dns,name);install(dnsPromises,name);}
 for(const prototype of [dns.Resolver.prototype,dnsPromises.Resolver.prototype])for(const name of getOwnPropertyNames(prototype))if(name==="reverse"||name.startsWith("resolve"))install(prototype,name);
 syncBuiltinESMExports();
}
afterAll(()=>{if(!state.attemptsAreZero())throw new Error("TEST_NETWORK_FORBIDDEN");process.stdout.write("network-attempts=0\n");});
