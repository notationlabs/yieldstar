import { describe, expect, test } from "vitest";
import { durableValueCodec, encodeThrownValue } from "./durable-value";
import { WorkflowStartError } from "./execution";
import { WorkflowValueError, registerErrorClass } from "./errors";

function encode(value: unknown) {
  const encoding = durableValueCodec.encode(value);
  if (encoding.status !== "encoded") {
    throw new Error(`expected encoded, got: ${encoding.message}`);
  }
  return encoding.canonical;
}

function decode(canonical: string) {
  const decoding = durableValueCodec.decode(canonical);
  if (decoding.status !== "decoded") {
    throw new Error(`expected decoded, got: ${decoding.message}`);
  }
  return decoding.value;
}

function roundTrip<T>(value: T) {
  return decode(encode(value)) as T;
}

class CourierError extends Error {
  code = "COURIER_DOWN";
  courier: string;
  constructor(courier: string, options?: ErrorOptions) {
    if (typeof courier !== "string") throw new Error("courier is required");
    super(`${courier} is down`, options);
    this.name = "CourierError";
    this.courier = courier;
  }
  describe() {
    return `${this.courier}: ${this.message}`;
  }
}
registerErrorClass("CourierError", CourierError);

class UnregisteredError extends Error {
  code = "NOPE";
  attempts = 3;
  constructor(message: string) {
    super(message);
    this.name = "UnregisteredError";
  }
}

describe("error encoding", () => {
  test("is tagged and canonical", () => {
    const error = new Error("boom");
    error.stack = "stack";
    expect(encode(error)).toBe(
      '{"$type":"error","message":"boom","name":"Error","stack":"stack"}'
    );
  });

  test("keeps name, message, stack, a string code, cause and durable fields", () => {
    const error = new CourierError("dhl", { cause: new TypeError("socket") });
    const revived = roundTrip(error);
    expect(revived).toBeInstanceOf(CourierError);
    expect(revived.name).toBe("CourierError");
    expect(revived.message).toBe("dhl is down");
    expect(revived.stack).toBe(error.stack);
    expect(revived.code).toBe("COURIER_DOWN");
    expect(revived.courier).toBe("dhl");
    expect(revived.describe()).toBe("dhl: dhl is down");
    expect(revived.cause).toBeInstanceOf(TypeError);
    expect((revived.cause as Error).message).toBe("socket");
  });

  test("revives without calling the constructor", () => {
    const revived = roundTrip(new CourierError("ups"));
    expect(revived).toBeInstanceOf(CourierError);
  });

  test("matches the original's own property layout", () => {
    const error = new CourierError("dhl", { cause: "flaky" });
    const revived = roundTrip(error);
    expect(Object.keys(revived).sort()).toEqual(Object.keys(error).sort());
    expect(Object.getOwnPropertyDescriptor(revived, "message")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(revived, "cause")?.enumerable).toBe(false);
    expect(revived).toEqual(error);
  });

  test("revives native errors", () => {
    const revived = roundTrip(new CourierError("dhl"));
    expect(Object.prototype.toString.call(revived)).toBe("[object Error]");
  });

  test("revives an error without a stack without one", () => {
    const error = new Error("boom");
    delete error.stack;
    expect(roundTrip(error).stack).toBeUndefined();
  });

  test("omits non-durable properties", () => {
    const error = Object.assign(new Error("boom"), {
      at: new Date(0),
      handler: () => {},
      ok: 1,
    });
    const revived = roundTrip(error);
    expect(Object.keys(revived)).toEqual(["ok"]);
  });

  test("ignores a non-string code", () => {
    const revived = roundTrip(Object.assign(new Error("boom"), { code: 42 }));
    expect(revived).not.toHaveProperty("code");
  });

  test("keeps a cause of undefined distinct from no cause", () => {
    expect(Object.hasOwn(roundTrip(new Error("a", { cause: undefined })), "cause")).toBe(
      true
    );
    expect(Object.hasOwn(roundTrip(new Error("a")), "cause")).toBe(false);
  });

  test("omits a cause that cycles back to the error", () => {
    const error = new Error("loop");
    error.cause = error;
    expect(Object.hasOwn(roundTrip(error), "cause")).toBe(false);
  });

  test("wraps fields with a $type key", () => {
    const revived = roundTrip(Object.assign(new Error("boom"), { $type: "undefined" }));
    expect((revived as unknown as { $type: string }).$type).toBe("undefined");
  });

  test("keeps AggregateError's errors", () => {
    const revived = roundTrip(new AggregateError([new RangeError("r"), "two"], "all"));
    expect(revived).toBeInstanceOf(AggregateError);
    expect(revived.errors).toHaveLength(2);
    expect(revived.errors[0]).toBeInstanceOf(RangeError);
    expect(revived.errors[1]).toBe("two");
    expect(Object.getOwnPropertyDescriptor(revived, "errors")?.enumerable).toBe(false);
  });

  test("works anywhere a value can appear", () => {
    const revived = roundTrip({ ok: false, errors: [new TypeError("t")] });
    expect(revived.errors[0]).toBeInstanceOf(TypeError);
  });
});

describe("error revival", () => {
  test("revives an unregistered class as an Error with the same name, message, code and fields", () => {
    const revived = roundTrip(new UnregisteredError("nope"));
    expect(Object.getPrototypeOf(revived)).toBe(Error.prototype);
    expect(revived.name).toBe("UnregisteredError");
    expect(revived.message).toBe("nope");
    expect(revived.code).toBe("NOPE");
    expect(revived.attempts).toBe(3);
  });

  test.each([
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError,
  ])("revives %o by default", (errorClass) => {
    const revived = roundTrip(new errorClass("m"));
    expect(Object.getPrototypeOf(revived)).toBe(errorClass.prototype);
    expect(revived.name).toBe(errorClass.name);
    expect(Object.hasOwn(revived, "name")).toBe(false);
  });

  test("revives the Yieldstar error classes by default", () => {
    const start = roundTrip(new WorkflowStartError("START_REQUEST_MISMATCH", "m"));
    expect(start).toBeInstanceOf(WorkflowStartError);
    expect(start.code).toBe("START_REQUEST_MISMATCH");

    const value = roundTrip(new WorkflowValueError("INVALID_STEP_VALUE", "now", "m"));
    expect(value).toBeInstanceOf(WorkflowValueError);
    expect(value.code).toBe("INVALID_STEP_VALUE");
    expect(value.stepKey).toBe("now");
  });

  test("registration replaces the class for a name", () => {
    class First extends Error {}
    class Second extends Error {}
    registerErrorClass("ReplacedError", First);
    registerErrorClass("ReplacedError", Second);
    const error = new First("m");
    error.name = "ReplacedError";
    expect(roundTrip(error)).toBeInstanceOf(Second);
  });

  test("rejects invalid registrations", () => {
    expect(() => registerErrorClass("", Error)).toThrow(TypeError);
    expect(() => registerErrorClass("Point", class Point {} as never)).toThrow(TypeError);
  });
});

describe("encodeThrownValue", () => {
  test("keeps a durable thrown value as thrown", () => {
    expect(decode(encodeThrownValue("boom"))).toBe("boom");
    expect(decode(encodeThrownValue({ code: 1 }))).toEqual({ code: 1 });
    expect(decode(encodeThrownValue(new RangeError("r")))).toBeInstanceOf(RangeError);
  });

  test("records a non-durable thrown value as Error(String(value))", () => {
    const revived = decode(encodeThrownValue(new Date(0))) as Error;
    expect(Object.getPrototypeOf(revived)).toBe(Error.prototype);
    expect(revived.message).toBe(String(new Date(0)));
    expect((decode(encodeThrownValue(10n)) as Error).message).toBe("10");
  });
});
