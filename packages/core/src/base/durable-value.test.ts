import { describe, expect, test } from "vitest";
import { durableValueCodec } from "./durable-value";

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
    ["undefined", undefined],
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

  test("undefined property values", () => {
    expect(invalidMessage({ a: { b: undefined } })).toMatch(/^\$\["a"\]\["b"\]: /);
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
