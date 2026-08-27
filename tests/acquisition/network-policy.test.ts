import { types as utilTypes } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { canonicalJson } from "../../src/crypto/canonical-json.js";
import { sha256Hex } from "../../src/crypto/hash.js";
import {
  NetworkPolicyError,
  classifyNetworkAddress,
  createAcquisitionDnsResolver,
  resolveAllSafeProviderAddressesInternal,
  validateFixedProviderUrl,
  type AcquisitionDnsAddress,
  type AcquisitionDnsResolverDescriptor,
  type NetworkPolicyErrorCode,
} from "../../src/acquisition/network-policy.js";

function code(action: () => unknown): NetworkPolicyErrorCode | undefined {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(NetworkPolicyError);
    expect((error as Error).message).toBe(`Network policy rejected (${(error as NetworkPolicyError).code})`);
    expect((error as Error).message).not.toMatch(/SECRET|crossref|openalex|ncbi|8\.8\.8\.8|2606/u);
    return (error as NetworkPolicyError).code;
  }
  return undefined;
}
async function asyncCode(action: () => Promise<unknown>): Promise<NetworkPolicyErrorCode | undefined> {
  try { await action(); }
  catch (error) {
    expect(error).toBeInstanceOf(NetworkPolicyError);
    expect((error as Error).message).toBe(`Network policy rejected (${(error as NetworkPolicyError).code})`);
    expect((error as Error).message).not.toMatch(/SECRET|crossref|openalex|ncbi|8\.8\.8\.8|2606/u);
    return (error as NetworkPolicyError).code;
  }
  return undefined;
}
function resolverWith(value: readonly AcquisitionDnsAddress[] | Error) {
  const resolveAll = vi.fn(async (_hostname: string, _signal: AbortSignal) => {
    if (value instanceof Error) throw value;
    return value;
  });
  const close = vi.fn();
  return { resolver: createAcquisitionDnsResolver({ resolveAll, close }), resolveAll, close };
}
const validated = () => validateFixedProviderUrl("crossref", "https://api.crossref.org/works?query=SECRET");
function resolverError(errorCode: string): Error { return Object.assign(new Error("SECRET resolver detail"), { code: errorCode }); }

function ipv4Number(address: string): number { return address.split(".").reduce((value, part) => value * 256 + Number(part), 0); }
function ipv4Text(value: number): string { return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 255)).join("."); }
const ipv4Ranges = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const;
function expectedIpv4(value: number): "public" | "forbidden" {
  return ipv4Ranges.some(([base, prefix]) => { const size = 2 ** (32 - prefix); const start = ipv4Number(base); return value >= start && value < start + size; }) ? "forbidden" : "public";
}
function ipv6Text(value: bigint): string { return Array.from({ length: 8 }, (_, index) => ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16).padStart(4, "0")).join(":"); }
function ipv6Value(text: string): bigint { return text.split(":").reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n); }
const ipv6Prefixes = [
  [0n, 128], [1n, 128], [0n, 96], [ipv6Value("0064:ff9b:0000:0000:0000:0000:0000:0000"), 96],
  [ipv6Value("0064:ff9b:0001:0000:0000:0000:0000:0000"), 48], [ipv6Value("0100:0000:0000:0000:0000:0000:0000:0000"), 64],
  [ipv6Value("2001:0000:0000:0000:0000:0000:0000:0000"), 23], [ipv6Value("2001:0002:0000:0000:0000:0000:0000:0000"), 48],
  [ipv6Value("2001:0020:0000:0000:0000:0000:0000:0000"), 28], [ipv6Value("2001:0db8:0000:0000:0000:0000:0000:0000"), 32],
  [ipv6Value("3fff:0000:0000:0000:0000:0000:0000:0000"), 20], [ipv6Value("2002:0000:0000:0000:0000:0000:0000:0000"), 16],
  [ipv6Value("fc00:0000:0000:0000:0000:0000:0000:0000"), 7], [ipv6Value("fec0:0000:0000:0000:0000:0000:0000:0000"), 10],
  [ipv6Value("fe80:0000:0000:0000:0000:0000:0000:0000"), 10], [ipv6Value("ff00:0000:0000:0000:0000:0000:0000:0000"), 8],
] as const;
function expectedIpv6(value: bigint): "public" | "forbidden" {
  return ipv6Prefixes.some(([base, prefix]) => { const size = 1n << BigInt(128 - prefix); return value >= base && value < base + size; }) ? "forbidden" : "public";
}

describe("fixed-origin URL, IP, and DNS policy", () => {
  test("accepts only exact fixed HTTPS provider origins", () => {
    const cases = [
      ["crossref", "https://api.crossref.org/works", "api.crossref.org"],
      ["openalex", "https://api.openalex.org/works", "api.openalex.org"],
      ["ncbi", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", "eutils.ncbi.nlm.nih.gov"],
      ["ncbi", "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi", "www.ncbi.nlm.nih.gov"],
    ] as const;
    for (const [target, url, hostname] of cases) {
      const output = validateFixedProviderUrl(target, url);
      expect(output).toEqual({ target, url, origin: `https://${hostname}`, hostname, port: 443, hostHeader: hostname });
      expect(Object.isFrozen(output)).toBe(true);
      expect(validateFixedProviderUrl(target, url)).not.toBe(output);
    }
    expect(validateFixedProviderUrl("crossref", "https://api.crossref.org:443/works").port).toBe(443);
    expect(code(() => validateFixedProviderUrl("crossref", "https://api.openalex.org/works"))).toBe("network.origin-forbidden");
    expect(code(() => validateFixedProviderUrl("openalex", "https://api.crossref.org/works"))).toBe("network.origin-forbidden");
  });

  test("rejects credentials fragments ports IP literals Unicode hosts and URL parser bypasses", () => {
    const cases: readonly [string, NetworkPolicyErrorCode][] = [
      ["http://api.crossref.org/works", "network.scheme-forbidden"], ["//api.crossref.org/works", "network.scheme-forbidden"],
      ["https://user:pass@api.crossref.org/works", "network.credentials-forbidden"], ["https://api.crossref.org/works#", "network.fragment-forbidden"],
      ["https://api.crossref.org:444/works", "network.origin-forbidden"], ["https://127.0.0.1/works", "network.ip-literal-forbidden"],
      ["https://2130706433/works", "network.ip-literal-forbidden"], ["https://0x7f000001/works", "network.ip-literal-forbidden"],
      ["https://[::1]/works", "network.ip-literal-forbidden"], ["https://аpi.crossref.org/works", "network.origin-forbidden"],
      ["https://api%2ecrossref.org/works", "network.origin-forbidden"], ["https://api.crossref.org\\@evil.example/works", "network.origin-forbidden"],
      ["https:\\api.crossref.org/works", "network.origin-forbidden"], ["https://api.crossref.org. /works", "network.origin-forbidden"],
    ];
    for (const [url, expected] of cases) expect(code(() => validateFixedProviderUrl("crossref", url))).toBe(expected);
    expect(code(() => validateFixedProviderUrl("crossref", "x".repeat(16_385)))).toBe("network.url-too-large");
    expect(code(() => validateFixedProviderUrl("other" as never, "https://api.crossref.org"))).toBe("network.invalid-input");
  });

  test("classifies every IPv4 first last predecessor and successor by aggregate table without assuming adjacent public", () => {
    for (const [base, prefix] of ipv4Ranges) {
      const first = ipv4Number(base); const size = 2 ** (32 - prefix); const last = first + size - 1;
      expect(classifyNetworkAddress(ipv4Text(first))).toBe("forbidden");
      expect(classifyNetworkAddress(ipv4Text(last))).toBe("forbidden");
      if (first > 0) expect(classifyNetworkAddress(ipv4Text(first - 1))).toBe(expectedIpv4(first - 1));
      if (last < 0xffffffff) expect(classifyNetworkAddress(ipv4Text(last + 1))).toBe(expectedIpv4(last + 1));
    }
    expect(classifyNetworkAddress("169.254.169.254")).toBe("forbidden");
    expect(classifyNetworkAddress("8.8.8.8")).toBe("public");
    for (const invalid of ["127.1", "0177.0.0.1", "1.2.3.256", "1.2.3.4.5", "1.2.3.-1"]) expect(classifyNetworkAddress(invalid)).toBe("forbidden");
  });

  test("classifies every IPv6 first last predecessor and successor including 2001 2 benchmarking and 2001 20 ORCHIDv2", () => {
    const maximum = (1n << 128n) - 1n;
    for (const [first, prefix] of ipv6Prefixes) {
      const last = first + (1n << BigInt(128 - prefix)) - 1n;
      expect(classifyNetworkAddress(ipv6Text(first))).toBe("forbidden"); expect(classifyNetworkAddress(ipv6Text(last))).toBe("forbidden");
      if (first > 0n) expect(classifyNetworkAddress(ipv6Text(first - 1n))).toBe(expectedIpv6(first - 1n));
      if (last < maximum) expect(classifyNetworkAddress(ipv6Text(last + 1n))).toBe(expectedIpv6(last + 1n));
    }
    expect(classifyNetworkAddress("2606:4700:4700::1111")).toBe("public");
    expect(classifyNetworkAddress("2606:4700:4700:0:0:0:0:1111")).toBe("public");
    expect(classifyNetworkAddress("2001:2::1")).toBe("forbidden"); expect(classifyNetworkAddress("2001:20::1")).toBe("forbidden");
    expect(classifyNetworkAddress("64:ff9b::808:808")).toBe("forbidden"); expect(classifyNetworkAddress("2002:0808:0808::1")).toBe("forbidden");
    expect(classifyNetworkAddress("2001:0000:4136:e378:8000:63bf:3fff:fdd2")).toBe("forbidden");
    expect(classifyNetworkAddress("::ffff:8.8.8.8")).toBe("public"); expect(classifyNetworkAddress("::ffff:127.0.0.1")).toBe("forbidden");
    expect(classifyNetworkAddress("::8.8.8.8")).toBe("forbidden"); expect(classifyNetworkAddress("fe80::1%lo0")).toBe("forbidden");
    expect(classifyNetworkAddress("FC00::1")).toBe("forbidden"); expect(classifyNetworkAddress("3fff:0fff::1")).toBe("forbidden");
  });

  test("counts raw duplicate A and AAAA answers before validation or deduplication", async () => {
    const answers = Array.from({ length: 65 }, () => ({ address: "8.8.8.8", family: 4 as const }));
    const fake = resolverWith(answers);
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), { maxDnsAddresses: 64 }, fake.resolver))).toBe("network.dns-too-many-addresses");
    expect(fake.resolveAll).toHaveBeenCalledOnce();
  });

  test("maps empty temporary SERVFAIL NXDOMAIN invalid family all-unsafe and mixed-unsafe answers exactly", async () => {
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith([]).resolver))).toBe("network.dns-empty");
    for (const errorCode of ["ENODATA", "EAI_NODATA"]) expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(resolverError(errorCode)).resolver))).toBe("network.dns-empty");
    for (const errorCode of ["ETIMEOUT", "EAI_AGAIN", "SERVFAIL", "ESERVFAIL", "UNKNOWN"]) expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(resolverError(errorCode)).resolver))).toBe("network.dns-temporary");
    for (const errorCode of ["ENOTFOUND", "EAI_NONAME"]) expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(resolverError(errorCode)).resolver))).toBe("network.dns-nxdomain");
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(new AggregateError([resolverError("ENODATA"), resolverError("EAI_NODATA")])).resolver))).toBe("network.dns-empty");
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(new AggregateError([resolverError("ENODATA"), resolverError("ENOTFOUND")])).resolver))).toBe("network.dns-nxdomain");
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(new AggregateError([resolverError("ENOTFOUND"), resolverError("SERVFAIL")])).resolver))).toBe("network.dns-nxdomain");
    const cases: readonly [readonly AcquisitionDnsAddress[], NetworkPolicyErrorCode][] = [
      [[{ address: "8.8.8.8", family: 6 }], "network.dns-invalid-address"], [[{ address: "bad", family: 4 }], "network.dns-invalid-address"],
      [[{ address: "127.0.0.1", family: 4 }], "network.dns-address-forbidden"],
      [[{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], "network.dns-mixed-addresses"],
    ];
    for (const [answers, expected] of cases) expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(answers).resolver))).toBe(expected);
  });

  test("orders all safe answers IPv4 bytewise then IPv6 bytewise and hashes canonical set independent of DNS order", async () => {
    const shuffled = [
      { address: "2606:4700:4700::1111", family: 6 as const }, { address: "8.8.8.8", family: 4 as const },
      { address: "1.1.1.1", family: 4 as const }, { address: "2606:4700:4700:0:0:0:0:1001", family: 6 as const },
      { address: "8.8.8.8", family: 4 as const },
    ];
    const first = await resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(shuffled).resolver);
    const reverse = await resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith([...shuffled].reverse()).resolver);
    expect(first.addresses).toEqual([
      { address: "1.1.1.1", family: 4 }, { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1001", family: 6 }, { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(first.allAddressesSha256).toBe(sha256Hex(canonicalJson({ schemaVersion: 1, addresses: first.addresses })));
    expect(reverse).toEqual(first); expect(reverse).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.addresses)).toBe(true); expect(Object.isFrozen(first.addresses[0])).toBe(true);
  });

  test("brands resolver capabilities and rejects getter proxy and forged descriptors without canonicalization", async () => {
    let reads = 0; const getter = Object.defineProperty({}, "resolveAll", { enumerable: true, get() { reads += 1; return async () => []; } });
    expect(code(() => createAcquisitionDnsResolver(getter as AcquisitionDnsResolverDescriptor))).toBe("network.invalid-input"); expect(reads).toBe(0);
    let traps = 0; const proxy = new Proxy({ resolveAll: async () => [], close: () => undefined }, { ownKeys() { traps += 1; throw new Error("SECRET"); } });
    expect(code(() => createAcquisitionDnsResolver(proxy))).toBe("network.invalid-input"); expect(traps).toBe(0);
    const fake = resolverWith([{ address: "8.8.8.8", family: 4 }]);
    expect(Object.keys(fake.resolver)).toEqual(["capabilityKind"]); expect(Object.isFrozen(fake.resolver)).toBe(true);
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, { capabilityKind: "acquisition-dns-resolver" }))).toBe("network.invalid-input");
  });

  test("accepts undefined signal and validates genuine signal only when present while isolating fake resolver cancellation", async () => {
    const seen: AbortSignal[] = [];
    const fake = createAcquisitionDnsResolver({ resolveAll: async (_hostname, signal) => { seen.push(signal); if (signal.aborted) throw Object.assign(new Error("SECRET"), { code: "ABORT_ERR" }); return [{ address: "8.8.8.8", family: 4 }]; }, close: () => undefined });
    await resolveAllSafeProviderAddressesInternal(validated(), undefined, fake);
    await resolveAllSafeProviderAddressesInternal(validated(), undefined, fake);
    expect(seen).toHaveLength(2); expect(seen[0]).not.toBe(seen[1]); expect(seen.every((signal) => signal instanceof AbortSignal)).toBe(true);
    const aborted = new AbortController(); aborted.abort();
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, fake, aborted.signal))).toBe("network.cancelled");
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, fake, { aborted: false } as AbortSignal))).toBe("network.invalid-input");
    expect(utilTypes.isProxy(new Proxy(aborted.signal, {}))).toBe(true);
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, fake, new Proxy(aborted.signal, {})))).toBe("network.invalid-input");
  });

  test("rejects hostile closed options before URL or DNS access", async () => {
    let resolverCalls = 0; const fake = createAcquisitionDnsResolver({ resolveAll: async () => { resolverCalls += 1; return []; }, close: () => undefined });
    let reads = 0; const getter = Object.defineProperty({}, "maxDnsAddresses", { enumerable: true, get() { reads += 1; return 1; } });
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal({ get target() { throw new Error("SECRET URL"); } } as never, getter, fake))).toBe("network.invalid-options");
    expect(reads).toBe(0); expect(resolverCalls).toBe(0);
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), { maxDnsAddresses: 65 }, fake))).toBe("network.invalid-options");
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), { unknown: 1 } as never, fake))).toBe("network.invalid-options");
  });

  test("reports exact redacted NetworkPolicyError codes", async () => {
    const urls = ["network.scheme-forbidden", "network.origin-forbidden", "network.credentials-forbidden", "network.fragment-forbidden", "network.ip-literal-forbidden"] as const;
    const inputs = ["http://api.crossref.org", "https://evil.example", "https://SECRET@api.crossref.org", "https://api.crossref.org/#SECRET", "https://127.0.0.1"];
    for (let index = 0; index < urls.length; index += 1) expect(code(() => validateFixedProviderUrl("crossref", inputs[index]!))).toBe(urls[index]);
    const error = new NetworkPolicyError("network.dns-temporary"); expect(error.code).toBe("network.dns-temporary"); expect(error.message).toBe("Network policy rejected (network.dns-temporary)");
    expect(await asyncCode(() => resolveAllSafeProviderAddressesInternal(validated(), undefined, resolverWith(new Error("SECRET unknown resolver failure")).resolver))).toBe("network.dns-temporary");
  });
});
