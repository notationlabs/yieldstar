import { describe, expect, expectTypeOf, test } from "vitest";
import { type Durable, type DurableValue, durableValueCodec } from "./durable-value";

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
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["invalid Dates", new Date(Number.NaN)],
    ["Date subclasses", new (class Day extends Date {})(0)],
    ["Dates with own properties", Object.assign(new Date(0), { tz: "UTC" })],
    ["Map subclasses", new (class Index extends Map {})()],
    ["Sets with own properties", Object.assign(new Set(), { label: "s" })],
    ["Maps with invalid keys", new Map([[() => 1, 1]])],
    ["Sets with invalid values", new Set([Symbol("s")])],
    ["class instances", new (class Point {})()],
    ["array subclasses", new (class List extends Array {})()],
  ])("%s", (_label, value) => {
    expect(durableValueCodec.encode(value).status).toBe("invalid");
  });

  test("nested invalid values, naming their path", () => {
    expect(invalidMessage({ a: { b: () => 1 } })).toMatch(/^\$\["a"\]\["b"\]: /);
    expect(invalidMessage(new Map([["k", () => 1]]))).toMatch(/^\$\.entries\[0\]\[1\]: /);
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

describe("durableValueCodec tags built-in types", () => {
  test("bigints as decimal strings", () => {
    expect(canonical(-12n)).toBe('{"$type":"bigint","value":"-12"}');
    expect(roundTrip(2n ** 70n)).toBe(2n ** 70n);
  });

  test("Dates as ISO strings", () => {
    const at = new Date("2026-10-29T12:00:00.123Z");
    expect(canonical(at)).toBe('{"$type":"date","value":"2026-10-29T12:00:00.123Z"}');
    const decoded = roundTrip(at);
    expect(decoded).toBeInstanceOf(Date);
    expect(decoded).not.toBe(at);
    expect((decoded as Date).getTime()).toBe(at.getTime());
  });

  test("Dates outside the four-digit year range", () => {
    const far = new Date(8.64e15);
    expect((roundTrip(far) as Date).getTime()).toBe(far.getTime());
  });

  test("Maps as entries in insertion order, with any durable keys", () => {
    const map = new Map<unknown, unknown>([
      ["b", 1],
      [1n, new Date(0)],
      [{ id: 1 }, [undefined]],
    ]);
    expect(canonical(new Map([["a", 1]]))).toBe('{"$type":"map","entries":[["a",1]]}');
    expect(roundTrip(map)).toEqual(map);
    expect([...(roundTrip(map) as Map<unknown, unknown>).keys()][0]).toBe("b");
  });

  test("Sets as values in insertion order", () => {
    const set = new Set([3, 1, "x"]);
    expect(canonical(set)).toBe('{"$type":"set","values":[3,1,"x"]}');
    expect([...(roundTrip(set) as Set<unknown>)]).toEqual([3, 1, "x"]);
  });

  test("Maps and Sets that differ only in order encode differently", () => {
    expect(canonical(new Set([1, 2]))).not.toBe(canonical(new Set([2, 1])));
    expect(canonical(new Map([["a", 1], ["b", 2]]))).not.toBe(
      canonical(new Map([["b", 2], ["a", 1]]))
    );
  });

  test("nested inside objects, arrays and errors", () => {
    const value = { at: new Date(0), tags: [new Set(["a"])], ids: new Map([[1, 2n]]) };
    expect(roundTrip(value)).toEqual(value);
    const error = Object.assign(new Error("boom"), { at: new Date(0) });
    expect((roundTrip(error) as typeof error).at).toEqual(new Date(0));
  });

  test("a Map that contains itself is a reference cycle", () => {
    const map = new Map<string, unknown>();
    map.set("self", map);
    expect(invalidMessage(map)).toMatch(/reference cycle/);
  });

  test("plain objects shaped like the new tags read back as written", () => {
    const value = { $type: "date", value: "2026-10-29T12:00:00.000Z" };
    expect(roundTrip(value)).toEqual(value);
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
    ["an unknown tag", '{"$type":"regexp","value":"a"}'],
    ["a bigint that is not an integer string", '{"$type":"bigint","value":"1.5"}'],
    ["a bigint written as -0", '{"$type":"bigint","value":"-0"}'],
    ["a date that is not a string", '{"$type":"date","value":0}'],
    ["a date that is not in toISOString form", '{"$type":"date","value":"2026-10-29"}'],
    ["a map entry that is not a pair", '{"$type":"map","entries":[["a"]]}'],
    ["a map with duplicate keys", '{"$type":"map","entries":[["a",1],["a",2]]}'],
    ["a set with duplicate values", '{"$type":"set","values":[1,1]}'],
    ["a set without values", '{"$type":"set"}'],
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

  test("accepts interfaces, undefined, errors and built-in types", () => {
    interface Reservation {
      id: string;
      note?: string;
      lines: { sku: string; qty: number }[];
      error: Error | null;
    }
    const reservation: Reservation = { id: "r", lines: [], error: null };
    expectTypeOf(record(reservation)).toEqualTypeOf<Reservation>();
    expectTypeOf(record(undefined)).toEqualTypeOf<undefined>();
    record({ at: new Date(), n: 1n });
    record({ map: new Map<string, { at: Date }>() });
    record(new Set<number>());
    const readonlyMap: ReadonlyMap<string, number> = new Map();
    record({ readonlyMap });
  });

  test("keeps the shape and mutability of arrays and tuples", () => {
    expectTypeOf<Durable<string[]>>().toEqualTypeOf<string[]>();
    expectTypeOf<Durable<readonly string[]>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Durable<[string, Date]>>().toEqualTypeOf<[string, Date]>();
    expectTypeOf<Durable<readonly [string, number]>>().toEqualTypeOf<
      readonly [string, number]
    >();
    expectTypeOf<Durable<{ lines: { qty: number }[] }>>().toEqualTypeOf<{
      lines: { qty: number }[];
    }>();
  });

  test("is assignable to DurableValue for readonly arrays, maps and sets", () => {
    expectTypeOf<Durable<readonly { at: Date }[]>>().toExtend<DurableValue>();
    expectTypeOf<Durable<readonly [string, number]>>().toExtend<DurableValue>();
    expectTypeOf<Durable<ReadonlyMap<string, number[]>>>().toExtend<DurableValue>();
    expectTypeOf<Durable<ReadonlySet<string>>>().toExtend<DurableValue>();
  });

  test("rejects functions, including inside Maps and Sets", () => {
    // @ts-expect-error
    record({ fn: () => 1 });
    // @ts-expect-error
    record(new Map<string, () => number>());
    // @ts-expect-error
    record(new Set<() => number>());
    // @ts-expect-error
    record([() => 1]);
    // @ts-expect-error
    record([{ fn: () => 1 }]);
  });
});
