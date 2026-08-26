import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonBytes,
} from "../../src/crypto/canonical-json.js";
import { hashLedgerEvent, sha256Hex } from "../../src/crypto/hash.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalJson({ z: { beta: 2, alpha: 1 }, a: [3, 2, 1] }),
    ).toBe('{"a":[3,2,1],"z":{"alpha":1,"beta":2}}');
  });

  it("uses ECMAScript JSON escaping and produces UTF-8 bytes", () => {
    const value = { text: '雪\n"\\', emoji: "😀" };
    const expected = '{"emoji":"😀","text":"雪\\n\\"\\\\"}';

    expect(canonicalJson(value)).toBe(expected);
    expect(canonicalJsonBytes(value)).toEqual(Buffer.from(expected, "utf8"));
  });

  it("normalizes negative zero to zero", () => {
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
  });

  it("orders property names by UTF-16 code units", () => {
    expect(canonicalJson({ "€": 1, "\r": 2, "😀": 3, "1": 4 })).toBe(
      '{"\\r":2,"1":4,"€":1,"😀":3}',
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["bigint", 1n],
    ["undefined", undefined],
    ["symbol", Symbol("secret-value")],
    ["function", () => "secret-value"],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["Set", new Set()],
    ["class instance", new (class RecordValue {})()],
  ])("rejects unsupported %s values without echoing them", (_label, value) => {
    expectCanonicalFailure(value);
  });

  it("rejects unsupported values when nested", () => {
    expectCanonicalFailure({ nested: undefined });
    expectCanonicalFailure([null, Number.NaN]);
  });

  it("accepts normal dense arrays", () => {
    expect(canonicalJson([1, "two", null])).toBe('[1,"two",null]');
  });

  it("rejects Array subclasses", () => {
    class DerivedArray extends Array<number> {}
    expectCanonicalFailure(new DerivedArray(1, 2));
  });

  it("rejects arrays whose prototype differs without invoking prototype getters", () => {
    let getterCalls = 0;
    const changedPrototype = Object.create(Array.prototype, {
      secret: {
        get: () => {
          getterCalls += 1;
          return "secret-value";
        },
      },
    });
    const value = [1, 2];
    Object.setPrototypeOf(value, changedPrototype);

    expectCanonicalFailure(value);
    expect(getterCalls).toBe(0);
  });

  it("rejects sparse arrays and arrays with extra properties", () => {
    const sparse = new Array(2);
    sparse[1] = "value";
    expectCanonicalFailure(sparse);

    const extended = [1, 2] as number[] & { extra?: string };
    extended.extra = "secret-value";
    expectCanonicalFailure(extended);
  });

  it("rejects cycles", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expectCanonicalFailure(value);
  });

  it("rejects accessor, symbol-keyed, and non-enumerable properties", () => {
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "secret-value",
    });
    expectCanonicalFailure(accessor);

    const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("secret-key")] = "secret-value";
    expectCanonicalFailure(symbolKeyed);

    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "secret", {
      enumerable: false,
      value: "secret-value",
    });
    expectCanonicalFailure(nonEnumerable);
  });

  it("rejects accessor array elements", () => {
    const array = [1];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get: () => 1,
    });
    expectCanonicalFailure(array);
  });

  it.each(["\ud800", "\udfff", `valid${"\ud800"}tail`])(
    "rejects strings containing lone surrogates",
    (value) => {
      expectCanonicalFailure(value);
    },
  );

  it("accepts null-prototype plain objects", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.b = 2;
    value.a = 1;
    expect(canonicalJson(value)).toBe('{"a":1,"b":2}');
  });

  it("produces identical bytes for equivalent object key orders", () => {
    expect(canonicalJsonBytes({ b: 2, a: { y: 2, x: 1 } })).toEqual(
      canonicalJsonBytes({ a: { x: 1, y: 2 }, b: 2 }),
    );
  });
});

describe("SHA-256 helpers", () => {
  it("matches the known SHA-256 vector for abc", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes equivalent object key orders identically", () => {
    expect(sha256Hex(canonicalJsonBytes({ b: 2, a: 1 }))).toBe(
      sha256Hex(canonicalJsonBytes({ a: 1, b: 2 })),
    );
  });

  it("omits only root entrySha256 and hashes canonical UTF-8 plus one LF", () => {
    const event = {
      type: "example",
      payload: { entrySha256: "nested-kept", text: "雪" },
      entrySha256: "root-omitted",
      seq: 1,
    };
    const framed = Buffer.concat([
      canonicalJsonBytes({
        type: "example",
        payload: { entrySha256: "nested-kept", text: "雪" },
        seq: 1,
      }),
      Buffer.from("\n", "utf8"),
    ]);

    expect(hashLedgerEvent(event)).toBe(sha256Hex(framed));
    expect(hashLedgerEvent(event)).not.toBe(
      sha256Hex(Buffer.concat([canonicalJsonBytes(event), Buffer.from("\n")])),
    );
  });
});

function expectCanonicalFailure(value: unknown): void {
  let error: unknown;
  try {
    canonicalJson(value);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(CanonicalJsonError);
  expect((error as CanonicalJsonError).message).not.toContain("secret-value");
  expect((error as CanonicalJsonError).message).not.toContain("secret-key");
}
