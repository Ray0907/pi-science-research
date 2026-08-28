import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import {syncBuiltinESMExports} from "node:module";
import {Duplex} from "node:stream";
import {afterAll} from "vitest";

const installed = Object.freeze([
  "global.fetch", "global.WebSocket",
  "http.request", "http.get", "https.request", "https.get",
  "http2.connect", "http2.session.request", "http2.session.ping", "http2.session.settings",
  "net.connect", "net.createConnection", "tls.connect",
  "dgram.createSocket", "dgram.Socket.bind", "dgram.Socket.connect", "dgram.Socket.send",
  "dns.lookup", "dns.promises.lookup", "dns.lookupService", "dns.promises.lookupService",
  "dns.resolve", "dns.promises.resolve", "dns.resolve4", "dns.promises.resolve4",
  "dns.resolve6", "dns.promises.resolve6", "dns.resolveAny", "dns.promises.resolveAny",
  "dns.resolveCaa", "dns.promises.resolveCaa", "dns.resolveCname", "dns.promises.resolveCname",
  "dns.resolveMx", "dns.promises.resolveMx", "dns.resolveNaptr", "dns.promises.resolveNaptr",
  "dns.resolveNs", "dns.promises.resolveNs", "dns.resolvePtr", "dns.promises.resolvePtr",
  "dns.resolveSoa", "dns.promises.resolveSoa", "dns.resolveSrv", "dns.promises.resolveSrv",
  "dns.resolveTxt", "dns.promises.resolveTxt", "dns.reverse", "dns.promises.reverse",
  "dns.Resolver.resolve*", "dns.Resolver.reverse",
  "dns.promises.Resolver.resolve*", "dns.promises.Resolver.reverse",
] as const);

type ForbiddenStub = (...arguments_: unknown[]) => never;
type Http2Methods = Readonly<{request: Function; ping: Function; settings: Function}>;
type Guard = Readonly<{installed: readonly string[]; stubs: Readonly<Record<string, Function>>}>;
type State = Readonly<{
  forbidden: ForbiddenStub;
  guard: Guard;
  attemptsAreZero: () => boolean;
  http2Methods: Http2Methods;
}>;

const stateKey = Symbol.for("pi-science-research.test-network-state");
const globalRecord = globalThis as typeof globalThis & {
  [stateKey]?: State;
  __PI_SCIENCE_TEST_NETWORK_GUARD__?: Guard;
};
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnPropertyNames = Object.getOwnPropertyNames;
const getPrototypeOf = Object.getPrototypeOf;
const reflectApply = Reflect.apply;

export function createIsolatedNetworkStubInternal(): Readonly<{stub: ForbiddenStub; attempts: () => number}> {
  let attempts = 0;
  const stub = function (..._arguments: unknown[]): never {
    if (!Number.isSafeInteger(attempts) || attempts >= Number.MAX_SAFE_INTEGER) throw new Error("TEST_NETWORK_FORBIDDEN");
    attempts += 1;
    throw new Error("TEST_NETWORK_FORBIDDEN");
  };
  return freeze({stub, attempts: () => attempts});
}

export function getInstalledHttp2ClientSessionMethodsInternal(): Http2Methods {
  const state = globalRecord[stateKey];
  if (!state) throw new Error("TEST_NETWORK_SETUP_INVALID");
  return state.http2Methods;
}

function installMethod(target: object, name: string, stub: Function): void {
  const descriptor = getOwnPropertyDescriptor(target, name);
  if (!descriptor || typeof descriptor.value !== "function") throw new Error("TEST_NETWORK_SETUP_INVALID");
  defineProperty(target, name, {...descriptor, value: stub, writable: false, configurable: false});
}

function bootstrapHttp2ClientSession(connect: Function, stub: ForbiddenStub): Http2Methods {
  class NoIoDuplex extends Duplex {
    override _read(): void {}
    override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(); }
  }
  const ignoreError = (): void => {};
  let fakeDuplex: NoIoDuplex | undefined;
  let session: ReturnType<typeof http2.connect> | undefined;
  let capturedConnect: Function | undefined = connect;
  let createConnectionCalls = 0;
  try {
    fakeDuplex = new NoIoDuplex();
    fakeDuplex.on("error", ignoreError);
    session = reflectApply(capturedConnect, http2, ["https://no-network.invalid", {
      createConnection: () => { createConnectionCalls += 1; return fakeDuplex!; },
    }]) as ReturnType<typeof http2.connect>;
    session.on("error", ignoreError);
    if (createConnectionCalls !== 1) throw new Error("TEST_NETWORK_SETUP_INVALID");
    const found = new Map<string, object>();
    for (let prototype: object | null = getPrototypeOf(session); prototype; prototype = getPrototypeOf(prototype)) {
      for (const name of ["request", "ping", "settings"] as const) {
        if (getOwnPropertyDescriptor(prototype, name)?.value !== undefined) {
          if (found.has(name)) throw new Error("TEST_NETWORK_SETUP_INVALID");
          found.set(name, prototype);
        }
      }
    }
    for (const name of ["request", "ping", "settings"] as const) {
      const prototype = found.get(name);
      if (!prototype) throw new Error("TEST_NETWORK_SETUP_INVALID");
      installMethod(prototype, name, stub);
      if (getOwnPropertyDescriptor(prototype, name)?.value !== stub) throw new Error("TEST_NETWORK_SETUP_INVALID");
    }
    return freeze({
      request: getOwnPropertyDescriptor(found.get("request")!, "request")!.value as Function,
      ping: getOwnPropertyDescriptor(found.get("ping")!, "ping")!.value as Function,
      settings: getOwnPropertyDescriptor(found.get("settings")!, "settings")!.value as Function,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TEST_NETWORK_SETUP_INVALID") throw error;
    throw new Error("TEST_NETWORK_SETUP_INVALID");
  } finally {
    try { session?.destroy(); } catch {}
    try { fakeDuplex?.destroy(); } catch {}
    session = undefined;
    fakeDuplex = undefined;
    capturedConnect = undefined;
  }
}

let state = globalRecord[stateKey];
if (!state) {
  const isolated = createIsolatedNetworkStubInternal();
  const forbidden = isolated.stub;
  let originalConnect: Function | undefined = getOwnPropertyDescriptor(http2, "connect")?.value as Function | undefined;
  if (typeof originalConnect !== "function") throw new Error("TEST_NETWORK_SETUP_INVALID");
  const http2Methods = bootstrapHttp2ClientSession(originalConnect, forbidden);
  originalConnect = undefined;
  const install = (target: object, name: string): void => {
    defineProperty(target, name, {value: forbidden, writable: false, enumerable: true, configurable: false});
  };
  install(globalThis, "fetch");
  install(globalThis, "WebSocket");
  install(http, "request"); install(http, "get");
  install(https, "request"); install(https, "get");
  install(http2, "connect");
  install(net, "connect"); install(net, "createConnection");
  install(tls, "connect");
  install(dgram, "createSocket");
  for (const name of ["bind", "connect", "send"] as const) install(dgram.Socket.prototype, name);
  const dnsNames = [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa",
    "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa",
    "resolveSrv", "resolveTxt", "reverse",
  ] as const;
  for (const name of dnsNames) { install(dns, name); install(dnsPromises, name); }
  for (const prototype of [dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
    for (const name of getOwnPropertyNames(prototype)) if (name === "reverse" || name.startsWith("resolve")) install(prototype, name);
  }
  syncBuiltinESMExports();
  const stubs: Record<string, Function> = Object.create(null) as Record<string, Function>;
  for (const name of installed) stubs[name] = forbidden;
  const guard = freeze({installed, stubs: freeze(stubs)});
  state = freeze({forbidden, guard, attemptsAreZero: () => isolated.attempts() === 0, http2Methods});
  defineProperty(globalRecord, stateKey, {value: state, writable: false, enumerable: false, configurable: false});
  defineProperty(globalRecord, "__PI_SCIENCE_TEST_NETWORK_GUARD__", {value: guard, writable: false, enumerable: false, configurable: false});
}

afterAll(() => {
  if (!state!.attemptsAreZero()) throw new Error("TEST_NETWORK_FORBIDDEN");
  process.stdout.write("network-attempts=0\n");
});
