import { describe, expect, expectTypeOf, test } from "vitest";
import { type Durable, durableValueCodec } from "./durable-value";

function canonical(value: unknown) {
  const encoding = durableValueCodec.encode(value);
  if (encoding.status !== "encoded") {
    throw new Error(`expected encoded, got: ${encoding.message}`);
  }
  return encoding.canonical;
}

function invalidMessage(value: unknown) {
  const encoding = durableValueCodec.encode(value);
  if (encoding.status !== "invalid") {
    throw new Error(`expected invalid, got: ${encoding.canonical}`);
  }
  return encoding.message;
}

describe("durableValueCodec.encode accepts", () => {
  test.each([
    [null, "null"],
    [true, "true"],
    [false, "false"],
    [0, "0"],
    [1.5, "1.5"],
    [-12, "-12"],
    [1e21, "1e+21"],
    ["", '""'],
    ['quote " and \n newline', JSON.stringify('quote " and \n newline')],
    [[], "[]"],
    [{}, "{}"],
  ])("%j", (value, expected) => {
    expect(canonical(value)).toBe(expected);
  });

  test("nested arrays and objects", () => {
    expect(canonical({ a: [1, { b: null }], c: "x" })).toBe(
      '{"a":[1,{"b":null}],"c":"x"}'
    );
  });

  test("objects with a null prototype", () => {
    const value = Object.create(null);
    value.a = 1;
    expect(canonical(value)).toBe('{"a":1}');
  });

  test("the same object in sibling branches", () => {
    const shared = { x: 1 };
    expect(canonical({ a: shared, b: [shared, shared] })).toBe(
      '{"a":{"x":1},"b":[{"x":1},{"x":1}]}'
    );
  });

  test("an own __proto__ data property", () => {
    const value = JSON.parse('{"__proto__":1}');
    expect(canonical(value)).toBe('{"__proto__":1}');
  });
});

describe("durableValueCodec.encode is canonical", () => {
  test("object keys are sorted, including integer-like keys", () => {
    expect(canonical({ b: 1, a: 2, 10: 3, 2: 4 })).toBe(
      '{"10":3,"2":4,"a":2,"b":1}'
    );
  });

  test("different key order encodes to the same string", () => {
    expect(canonical({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonical({ b: { d: 3, c: 2 }, a: 1 })
    );
  });

  test("-0 is encoded as 0", () => {
    expect(canonical(-0)).toBe("0");
    expect(canonical({ n: -0 })).toBe(canonical({ n: 0 }));
  });

  test("array order is preserved", () => {
    expect(canonical([2, 1])).not.toBe(canonical([1, 2]));
  });
});

describe("durableValueCodec.encode rejects", () => {
  test.each([
    ["functions", () => {}],
    ["symbols", Symbol("s")],
    ["bigints", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["Dates", new Date(0)],
    ["Maps", new Map()],
    ["class instances", new (class Point {})()],
    ["array subclasses", new (class List extends Array {})()],
  ])("%s", (_label, value) => {
    expect(durableValueCodec.encode(value).status).toBe("invalid");
  });

  test("nested invalid values, naming their path", () => {
    expect(invalidMessage({ a: { b: new Date(0) } })).toMatch(/^\$\["a"\]\["b"\]: /);
  });

  test("missing array items", () => {
    expect(invalidMessage([1, , 3])).toMatch(/^\$\[1\]: missing array item/);
    expect(invalidMessage(new Array(2))).toMatch(/missing array item/);
  });

  test("extra array properties", () => {
    const value = Object.assign([1], { extra: true });
    expect(invalidMessage(value)).toMatch(/arrays must only have items/);
  });

  test("accessors, without invoking them", () => {
    let calls = 0;
    const value = {
      get a() {
        calls++;
        return 1;
      },
    };
    expect(invalidMessage(value)).toMatch(/accessor/);
    expect(calls).toBe(0);
  });

  test("non-enumerable properties", () => {
    const value = {};
    Object.defineProperty(value, "hidden", { value: 1, enumerable: false });
    expect(invalidMessage(value)).toMatch(/non-enumerable/);
  });

  test("symbol properties", () => {
    expect(invalidMessage({ [Symbol("s")]: 1 })).toMatch(/symbol/);
    const array = [1];
    Object.defineProperty(array, Symbol("s"), { value: 1 });
    expect(invalidMessage(array)).toMatch(/symbol/);
  });

  test("reference cycles", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    expect(invalidMessage(object)).toMatch(/cycle/);

    const array: unknown[] = [];
    array.push({ back: array });
    expect(invalidMessage(array)).toMatch(/cycle/);
  });
});

function roundTrip(value: unknown) {
  const decoding = durableValueCodec.decode(canonical(value));
  if (decoding.status !== "decoded") {
    throw new Error(`expected decoded, got: ${decoding.message}`);
  }
  return decoding.value;
}

function decodeInvalid(text: string) {
  const decoding = durableValueCodec.decode(text);
  if (decoding.status !== "invalid") {
    throw new Error("expected invalid");
  }
  return decoding.message;
}

describe("durableValueCodec tags undefined", () => {
  test("as a whole value, a property and an array item", () => {
    expect(canonical(undefined)).toBe('{"$type":"undefined"}');
    expect(canonical({ a: undefined })).toBe('{"a":{"$type":"undefined"}}');
    expect(canonical([1, undefined])).toBe('[1,{"$type":"undefined"}]');
  });

  test("keeping { a: undefined } distinct from {}", () => {
    expect(canonical({ a: undefined })).not.toBe(canonical({}));
    const decoded = roundTrip({ a: undefined });
    expect(decoded).toHaveProperty("a");
    expect(Object.keys(decoded as object)).toEqual(["a"]);
  });

  test("round trip", () => {
    expect(roundTrip(undefined)).toBeUndefined();
    const list = roundTrip([1, undefined]) as unknown[];
    expect(list).toEqual([1, undefined]);
    expect(1 in list).toBe(true);
  });
});

describe("durableValueCodec wraps plain objects with a $type key", () => {
  test("so they read back as written", () => {
    const value = { $type: "undefined" };
    expect(canonical(value)).toBe('{"$type":"object","value":{"$type":"undefined"}}');
    expect(roundTrip(value)).toEqual(value);
  });

  test("including tag-shaped objects nested inside values", () => {
    const value = {
      list: [{ $type: "error", name: "E", message: "m" }],
      wrapped: { $type: "object", value: { $type: "undefined" } },
    };
    expect(roundTrip(value)).toEqual(value);
  });

  test("but leaves other objects unwrapped", () => {
    expect(canonical({ type: "x" })).toBe('{"type":"x"}');
  });
});

describe("durableValueCodec.decode", () => {
  test.each([
    null,
    true,
    0,
    1.5,
    "text",
    [],
    {},
    { a: [1, { b: null }], c: "x" },
  ])("round trips %j", (value) => {
    expect(roundTrip(value)).toEqual(value);
  });

  test("returns a copy", () => {
    const value = { nested: { a: 1 } };
    const decoded = roundTrip(value) as typeof value;
    expect(decoded).not.toBe(value);
    expect(decoded.nested).not.toBe(value.nested);
  });

  test("keeps an own __proto__ key as data", () => {
    const decoded = roundTrip(JSON.parse('{"__proto__":{"polluted":true}}')) as object;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.keys(decoded)).toEqual(["__proto__"]);
    expect((decoded as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("leaves error-shaped plain objects as plain objects", () => {
    const report = { name: "launch", message: "Ship it", stack: "web" };
    const decoded = roundTrip(report);
    expect(decoded).not.toBeInstanceOf(Error);
    expect(decoded).toEqual(report);
  });

  test.each([
    ["text that is not JSON", "{"],
    ["an unknown tag", '{"$type":"date","value":0}'],
    ["a tag with extra keys", '{"$type":"undefined","value":1}'],
    ["a wrapped value that is not an object", '{"$type":"object","value":[1]}'],
    ["an error without a message", '{"$type":"error","name":"Error"}'],
    ["an error with a non-string code", '{"$type":"error","name":"E","message":"m","code":1}'],
  ])("rejects %s", (_label, text) => {
    expect(typeof decodeInvalid(text)).toBe("string");
  });
});

describe("Durable<T>", () => {
  function record<T>(value: T & Durable<T>): T {
    return value;
  }

  test("accepts interfaces, undefined and errors", () => {
    interface Reservation {
      id: string;
      note?: string;
      lines: { sku: string; qty: number }[];
      error: Error | null;
    }
    const reservation: Reservation = { id: "r", lines: [], error: null };
    expectTypeOf(record(reservation)).toEqualTypeOf<Reservation>();
    expectTypeOf(record(undefined)).toEqualTypeOf<undefined>();
  });

  test("rejects Dates, Maps, Sets, bigints and functions", () => {
    // @ts-expect-error
    record({ at: new Date() });
    // @ts-expect-error
    record({ map: new Map<string, number>() });
    // @ts-expect-error
    record(new Set<number>());
    // @ts-expect-error
    record(1n);
    // @ts-expect-error
    record({ fn: () => 1 });
  });
});
