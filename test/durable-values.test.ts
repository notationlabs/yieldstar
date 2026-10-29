import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Logger } from "pino";
import {
  ExecutionDispatcher,
  ReadOnlyMap,
  StoreNotFoundError,
  StoreValidationError,
  WorkflowRunner,
} from "@yieldstar/core";
import { createRoutes } from "@yieldstar/http-server";
import { createWorkflowInvoker } from "@yieldstar/test-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { createTestSdkFactory, testSchema } from "@yieldstar/test-utils";
import {
  ExecutionAdmissionError,
  RetryableError,
  WORKFLOW_RESULT_STEP_KEY,
  WorkflowStartError,
  WorkflowValueError,
  createHttpSdkFactory,
  defineStore,
  registerErrorClass,
  workflow,
  type StandardSchemaV1,
  type WorkflowEvent,
  type WorkflowFn,
} from "yieldstar";

type Step = Parameters<WorkflowFn<any, any, any>>[0];
type Observation = { value: unknown } | { thrown: unknown };

const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;

let executions = 0;

/**
 * Runs `body` on a first run, then suspends on a delay and replays it, and
 * returns what workflow code saw each time along with the step record of the
 * step keyed "value". The runtime clock is advanced by hand, so the replay is
 * deterministic.
 */
async function acrossReplay(body: (step: Step) => AsyncGenerator<any, unknown, any>) {
  const seen: Observation[] = [];
  let now = 1_000_000;
  const sdk = createTestSdkFactory({ runtime: { clock: () => now } })({
    workflow: workflow(async function* (step) {
      try {
        seen.push({ value: yield* body(step) });
      } catch (thrown) {
        seen.push({ thrown });
      }
      yield* step.delay("restart", 1_000);
      return null;
    }),
  });
  const executionId = `replay-${++executions}`;
  const done = sdk.triggerAndWait({ workflowId: "workflow", executionId });
  await vi.waitFor(
    async () => {
      const delay = await sdk.heapClient.readStep({ executionId, stepKey: "restart" });
      if (!delay) throw new Error("not suspended yet");
    },
    { timeout: 2_000, interval: 1 }
  );
  now += 1_000;
  await done;
  expect(seen).toHaveLength(2);
  const record = await sdk.heapClient.readStep({ executionId, stepKey: "value" });
  return {
    first: seen[0]!,
    replay: seen[1]!,
    record: record ? JSON.parse(record.stepResponseJson) : null,
    sdk,
  };
}

function valueOf(observation: Observation) {
  if (!("value" in observation)) {
    throw new Error(`expected a value, got thrown ${String(observation.thrown)}`);
  }
  return observation.value;
}

function thrownBy(observation: Observation) {
  if (!("thrown" in observation)) throw new Error("expected a thrown value");
  return observation.thrown;
}

const nonDurable = (value: unknown) => value as any;

class Point {
  constructor(public x: number) {}
}

/** Reads an ISO string and outputs a Date. */
const isoDate: StandardSchemaV1<string, Date> = {
  "~standard": {
    version: 1,
    vendor: "yieldstar-test",
    validate(value) {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        return { issues: [{ message: "expected an ISO date string" }] };
      }
      return { value: new Date(value) };
    },
  },
};

let courierConstructions = 0;

class CourierError extends Error {
  code = "COURIER_DOWN";
  courier: string;
  constructor(courier: string, options?: ErrorOptions) {
    courierConstructions++;
    if (typeof courier !== "string") throw new Error("courier is required");
    super(`${courier} is down`, options);
    this.name = "CourierError";
    this.courier = courier;
  }
}
registerErrorClass("CourierError", CourierError);

class UnregisteredError extends Error {
  code = "UNREGISTERED";
  constructor(message: string) {
    super(message);
    this.name = "UnregisteredError";
  }
}

describe("step values", () => {
  test("an error-shaped plain object stays a plain object", async () => {
    const report = { name: "launch", message: "Ship it", stack: "web" };
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => report)
    );
    for (const run of [first, replay]) {
      expect(valueOf(run)).not.toBeInstanceOf(Error);
      expect(valueOf(run)).toEqual(report);
    }
  });

  test.each([
    ["a Date", () => new Date(0)],
    ["a Map", () => new Map([["a", 1]])],
    ["a Set", () => new Set([1])],
    ["a BigInt", () => 1n],
    ["a class instance", () => new Point(1)],
    ["a nested Date", () => ({ at: new Date(0) })],
  ])("%s throws INVALID_STEP_VALUE on the first run and replay", async (_label, make) => {
    let calls = 0;
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        calls++;
        return nonDurable(make());
      })
    );
    expect(calls).toBe(1);
    for (const run of [first, replay]) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(WorkflowValueError);
      expect(error).toMatchObject({ code: "INVALID_STEP_VALUE", stepKey: "value" });
    }
    expect(thrownBy(replay)).toEqual(thrownBy(first));
  });

  test.each([
    ["undefined", undefined],
    ["{ a: undefined }", { a: undefined }],
    ["[1, undefined]", [1, undefined]],
  ])("%s returns the same value on both runs", async (_label, value) => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => value)
    );
    expect(valueOf(first)).toEqual(value);
    expect(valueOf(replay)).toEqual(value);
    if (value && !Array.isArray(value)) {
      expect(Object.keys(valueOf(first) as object)).toEqual(["a"]);
      expect(Object.keys(valueOf(replay) as object)).toEqual(["a"]);
    }
  });

  test("a plain object with tag-like keys reads back as written", async () => {
    const value = {
      $type: "undefined",
      nested: { $type: "error", name: "Error", message: "m" },
      wrapped: { $type: "object", value: {} },
    };
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => value)
    );
    expect(valueOf(first)).toEqual(value);
    expect(valueOf(replay)).toEqual(value);
  });

  test("the first run returns a decoded copy, equal to the replayed value", async () => {
    const value = { order: { id: 42, lines: [{ sku: "mug" }] } };
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => value)
    );
    expect(valueOf(first)).not.toBe(value);
    expect((valueOf(first) as typeof value).order).not.toBe(value.order);
    expect(valueOf(first)).toEqual(valueOf(replay));
  });

  test("step.run results are typed as durable values", () => {
    workflow(async function* (step) {
      // @ts-expect-error a Date is not a durable value
      yield* step.run("now", async () => new Date());
      // @ts-expect-error a Map is not a durable value
      yield* step.run("map", () => new Map<string, number>());
      interface Reservation {
        id: string;
        note?: string;
      }
      const reservation: Reservation = yield* step.run(
        "reserve",
        async (): Promise<Reservation> => ({ id: "r" })
      );
      const count: number = yield* step.run("count", () => 1);
      const nothing: void = yield* step.run("nothing", async () => {});
      return { reservation, count, nothing };
    });
  });
});

describe("workflow results", () => {
  test("a workflow that returns a Date fails with INVALID_STEP_VALUE", async () => {
    const sdk = createTestSdkFactory()({
      workflow: workflow(async function* () {
        return nonDurable(new Date(0));
      }),
    });
    const error = await sdk
      .triggerAndWait({ workflowId: "workflow", executionId: "returns-date" })
      .catch((err) => err);
    expect(error).toBeInstanceOf(WorkflowValueError);
    expect(error).toMatchObject({
      code: "INVALID_STEP_VALUE",
      stepKey: WORKFLOW_RESULT_STEP_KEY,
    });
    expect(await sdk.runtime.executions.get("returns-date")).toMatchObject({
      status: "failed",
      outcome: { status: "failed", error: { code: "INVALID_STEP_VALUE" } },
    });
  });

  test("a workflow result is the decoded value", async () => {
    const sdk = createTestSdkFactory()({
      workflow: workflow(async function* () {
        return { a: undefined, list: [1, undefined] };
      }),
    });
    const result = await sdk.triggerAndWait({ workflowId: "workflow" });
    expect(result).toEqual({ a: undefined, list: [1, undefined] });
    expect(Object.keys(result)).toEqual(["a", "list"]);
  });

  test("workflow results are typed as durable values", () => {
    // @ts-expect-error a Date is not a durable value
    workflow(async function* () {
      return new Date();
    });
    // @ts-expect-error a Map is not a durable value
    workflow(async function* () {
      return { totals: new Map<string, number>() };
    });
    interface Receipt {
      id: string;
      note?: string;
    }
    const receipt = workflow(async function* (_step, event: WorkflowEvent<{ id?: string }>) {
      const receipt: Receipt | undefined = event.params.id ? { id: event.params.id } : undefined;
      return receipt;
    });
    const counted = workflow(async function* () {
      return { count: 1 };
    });
    const nothing = workflow(async function* () {});
    const sdk = createTestSdkFactory()({ receipt, counted, nothing });
    type ResultOf<K extends "receipt" | "counted" | "nothing"> = Awaited<
      ReturnType<typeof sdk.triggerAndWait<K>>
    >;
    expectTypeOf<ResultOf<"receipt">>().toEqualTypeOf<Receipt | undefined>();
    expectTypeOf<ResultOf<"counted">>().toEqualTypeOf<{ count: number }>();
    expectTypeOf<ResultOf<"nothing">>().toEqualTypeOf<void>();
  });
});

describe("params and context", () => {
  test("admission with a Date in params or context is rejected with INVALID_EXECUTION_EVENT", async () => {
    const sdk = createTestSdkFactory()({
      workflow: workflow(async function* () {
        return null;
      }),
    });
    for (const event of [
      { workflowId: "workflow" as const, params: { at: new Date(0) } },
      { workflowId: "workflow" as const, params: {}, context: { at: new Date(0) } },
    ]) {
      const error = await sdk.trigger(event as any).catch((err) => err);
      expect(error).toBeInstanceOf(ExecutionAdmissionError);
      expect(error.code).toBe("INVALID_EXECUTION_EVENT");
    }
  });

  test("workflow and step.start params are typed as durable values", () => {
    // @ts-expect-error a Date is not a durable value
    workflow(async function* (_step, _event: WorkflowEvent<{ at: Date }>) {
      return null;
    });
    // @ts-expect-error a Set is not a durable value
    workflow<{ tags: Set<string> }, null, ReadonlyMap<any, any>>(async function* () {
      return null;
    });
    interface Order {
      id: string;
      note?: string;
      lines: { sku: string }[];
    }
    workflow(async function* (step, event: WorkflowEvent<Order>) {
      // @ts-expect-error a Date is not a durable value
      yield* step.start("bad", { workflowId: "ship", params: { at: new Date() } });
      const order: Order = event.params;
      return yield* step.start("ship", { workflowId: "ship", params: order });
    });
  });

  test("every delivery receives the context as a ReadonlyMap with equal entries", async () => {
    const contexts: ReadonlyMap<any, any>[] = [];
    let now = 1_000_000;
    const sdk = createTestSdkFactory({ runtime: { clock: () => now } })({
      workflow: workflow(async function* (step, event) {
        contexts.push(event.context);
        yield* step.delay("restart", 1_000);
        return null;
      }),
    });
    const done = sdk.triggerAndWait({
      workflowId: "workflow",
      executionId: "context-round-trip",
      context: { tenant: "acme", missing: undefined, nested: { list: [1] } },
    });
    await vi.waitFor(() => expect(contexts).toHaveLength(1), { interval: 1 });
    await vi.waitFor(
      async () =>
        expect(
          await sdk.heapClient.readStep({
            executionId: "context-round-trip",
            stepKey: "restart",
          })
        ).not.toBeNull(),
      { interval: 1 }
    );
    now += 1_000;
    await done;
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context).toBeInstanceOf(ReadOnlyMap);
      expect([...context.entries()]).toEqual([
        ["tenant", "acme"],
        ["missing", undefined],
        ["nested", { list: [1] }],
      ]);
    }
  });
});

describe("step schemas", () => {
  test("a schema transforms an ISO string into a Date on both runs", async () => {
    const at = "2026-10-29T12:00:00.000Z";
    const { first, replay, record } = await acrossReplay((step) =>
      step.run("value", async () => at, { schema: isoDate })
    );
    for (const run of [first, replay]) {
      expect(valueOf(run)).toBeInstanceOf(Date);
      expect((valueOf(run) as Date).toISOString()).toBe(at);
    }
    expect(record).toMatchObject({ type: "step-result", result: at, schema: "accepted" });
  });

  test("a rejected value is recorded raw, and both runs throw STEP_SCHEMA_INVALID", async () => {
    const { first, replay, record } = await acrossReplay((step) =>
      step.run("value", async () => "not a date", { schema: isoDate })
    );
    for (const run of [first, replay]) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(WorkflowValueError);
      expect(error).toMatchObject({ code: "STEP_SCHEMA_INVALID", stepKey: "value" });
    }
    expect(record).toMatchObject({
      type: "step-result",
      result: "not a date",
      schema: "rejected",
    });
  });

  test("a step without a schema records no schema verdict", async () => {
    const { record } = await acrossReplay((step) => step.run("value", async () => 1));
    expect(record).not.toHaveProperty("schema");
  });

  test("a schema's result type is its output", () => {
    workflow(async function* (step) {
      const at: Date = yield* step.run("at", async () => "2026-01-01", { schema: isoDate });
      // @ts-expect-error the step function must return the schema's input
      yield* step.run("bad", async () => 1, { schema: isoDate });
      return at.toISOString();
    });
  });
});

describe("step errors", () => {
  test("a registered custom error keeps its class, code, cause and fields", async () => {
    const before = courierConstructions;
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw new CourierError("dhl", { cause: new TypeError("socket closed") });
      })
    );
    // Revival does not call the constructor, which requires an argument.
    expect(courierConstructions - before).toBe(1);
    for (const run of [first, replay]) {
      const error = thrownBy(run) as CourierError;
      expect(error).toBeInstanceOf(CourierError);
      expect(error.message).toBe("dhl is down");
      expect(error.code).toBe("COURIER_DOWN");
      expect(error.courier).toBe("dhl");
      expect(error.cause).toBeInstanceOf(TypeError);
      expect((error.cause as Error).message).toBe("socket closed");
    }
  });

  test("an unregistered custom error is revived as an Error with the same name, message and code", async () => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw new UnregisteredError("nope");
      })
    );
    for (const run of [first, replay]) {
      const error = thrownBy(run) as UnregisteredError;
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect(error).toMatchObject({ name: "UnregisteredError", message: "nope", code: "UNREGISTERED" });
    }
  });

  test("a non-durable property is absent on the first run and on replay", async () => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw Object.assign(new Error("boom"), { at: new Date(0), attempts: 2 });
      })
    );
    for (const run of [first, replay]) {
      const error = thrownBy(run) as Error & Record<string, unknown>;
      expect(error).not.toHaveProperty("at");
      expect(error.attempts).toBe(2);
    }
  });

  test("an error keeps its stack", async () => {
    let stack: string | undefined;
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        const error = new Error("boom");
        stack = error.stack;
        throw error;
      })
    );
    expect((thrownBy(first) as Error).stack).toBe(stack);
    expect((thrownBy(replay) as Error).stack).toBe(stack);
  });

  test.each([
    ["a string", "boom"],
    ["a plain object", { code: "E_BOOM", detail: [1, 2] }],
    ["an error-shaped plain object", { name: "Error", message: "m", stack: "s" }],
  ])("%s is rethrown as thrown", async (_label, value) => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw value;
      })
    );
    for (const run of [first, replay]) {
      expect(thrownBy(run)).toEqual(value);
      expect(thrownBy(run)).not.toBeInstanceOf(Error);
    }
  });

  test("a non-durable thrown value is thrown as Error(String(value)) on both runs", async () => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw new Point(1);
      })
    );
    for (const run of [first, replay]) {
      const error = thrownBy(run);
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect((error as Error).message).toBe(String(new Point(1)));
    }
  });

  test("a TypeError is rethrown as a TypeError", async () => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw new TypeError("bad type");
      })
    );
    expect(thrownBy(first)).toBeInstanceOf(TypeError);
    expect(thrownBy(replay)).toBeInstanceOf(TypeError);
  });

  test.each([
    ["RetryableError", () => new RetryableError("try again", { maxAttempts: 1, retryInterval: 5 }), RetryableError],
    ["WorkflowStartError", () => new WorkflowStartError("START_REQUEST_MISMATCH", "m"), WorkflowStartError],
    ["WorkflowValueError", () => new WorkflowValueError("INVALID_STEP_VALUE", "k", "m"), WorkflowValueError],
    ["StoreValidationError", () => new StoreValidationError("m"), StoreValidationError],
    ["StoreNotFoundError", () => new StoreNotFoundError("s", "id"), StoreNotFoundError],
  ] as const)("%s is rethrown with its class", async (_name, make, errorClass) => {
    const { first, replay } = await acrossReplay((step) =>
      step.run("value", async () => {
        throw make();
      })
    );
    for (const run of [first, replay]) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(errorClass);
      expect(error).toEqual(make());
    }
  });

  test("a returned { ok: false, error } keeps the error's class in the outcome", async () => {
    const sdk = createTestSdkFactory()({
      workflow: workflow(async function* (step) {
        try {
          yield* step.run("ship", async () => {
            throw new CourierError("ups");
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error as Error };
        }
      }),
    });
    const result = (await sdk.triggerAndWait({ workflowId: "workflow" })) as {
      ok: boolean;
      error: CourierError;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(CourierError);
    expect(result.error.courier).toBe("ups");
  });

  test("an AggregateError escaping the workflow keeps each error in the failed outcome", async () => {
    const sdk = createTestSdkFactory()({
      workflow: workflow(async function* () {
        throw new AggregateError([new CourierError("dhl"), new TypeError("t")], "all failed");
      }),
    });
    const error = (await sdk
      .triggerAndWait({ workflowId: "workflow" })
      .catch((err) => err)) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toBeInstanceOf(CourierError);
    expect(error.errors[1]).toBeInstanceOf(TypeError);
  });

  test("a failed execution read through the local SDK keeps its class, code and cause", async () => {
    const sdk = createTestSdkFactory()({
      workflow: workflow(async function* () {
        throw new CourierError("dpd", { cause: new RangeError("weight") });
      }),
    });
    const error = await sdk.triggerAndWait({ workflowId: "workflow" }).catch((err) => err);
    expect(error).toBeInstanceOf(CourierError);
    expect(error.code).toBe("COURIER_DOWN");
    expect(error.cause).toBeInstanceOf(RangeError);
  });
});

describe("store values", () => {
  type Order = { lines: { sku: string }[]; note?: any };
  const Orders = defineStore("durable-orders", testSchema<Order>(), {
    initial: () => ({ lines: [] }),
  });

  test("an update to a non-durable state throws INVALID_STEP_VALUE and leaves the store unchanged", async () => {
    const { first, replay, sdk } = await acrossReplay(async function* (step) {
      const store = step.store(Orders, { id: "o1" });
      return yield* store.update("value", (draft) => {
        draft.lines.push({ sku: "mug" });
        draft.note = new Date(0);
      });
    });
    for (const run of [first, replay]) {
      expect(thrownBy(run)).toBeInstanceOf(WorkflowValueError);
      expect(thrownBy(run)).toMatchObject({ code: "INVALID_STEP_VALUE", stepKey: "value" });
    }
    const snapshot = await sdk.storeClient.getStore({ definition: Orders, id: "o1" });
    expect(snapshot).toMatchObject({ version: 0, state: { lines: [] } });
  });

  test("a non-durable initial state throws INVALID_STEP_VALUE and creates no store", async () => {
    const MappedOrders = defineStore("mapped-orders", testSchema<Order>(), {
      initial: () => ({ lines: [], note: nonDurable(new Map()) }),
    });
    const { first, replay, sdk } = await acrossReplay(async function* (step) {
      return yield* step.store(MappedOrders, { id: "o2" }).update("value", (draft) => {
        draft.lines.push({ sku: "mug" });
      });
    });
    for (const run of [first, replay]) {
      expect(thrownBy(run)).toBeInstanceOf(WorkflowValueError);
      expect(thrownBy(run)).toMatchObject({ code: "INVALID_STEP_VALUE", stepKey: "value" });
    }
    expect(await sdk.storeClient.listStores(MappedOrders)).toEqual([]);
  });

  test("a take whose selection is not durable throws INVALID_STEP_VALUE and claims nothing", async () => {
    const { first, sdk } = await acrossReplay(async function* (step) {
      const store = step.store(Orders, { id: "o3" });
      yield* store.update("seed", (draft) => {
        draft.lines.push({ sku: "mug" });
      });
      return yield* store.take(
        "value",
        (state) => state.lines.length > 0 && nonDurable(new Set(state.lines)),
        (draft) => {
          draft.lines = [];
        }
      );
    });
    expect(thrownBy(first)).toMatchObject({ code: "INVALID_STEP_VALUE", stepKey: "value" });
    const snapshot = await sdk.storeClient.getStore({ definition: Orders, id: "o3" });
    expect(snapshot).toMatchObject({ version: 1, state: { lines: [{ sku: "mug" }] } });
  });

  test("a select result that is not durable throws INVALID_STEP_VALUE", async () => {
    const { first, replay } = await acrossReplay(async function* (step) {
      const store = step.store(Orders, { id: "o4" });
      return yield* store.select("value", () => nonDurable(new Date(0)));
    });
    for (const run of [first, replay]) {
      expect(thrownBy(run)).toMatchObject({ code: "INVALID_STEP_VALUE", stepKey: "value" });
    }
  });

  test("store state and store step results are typed as durable values", () => {
    // @ts-expect-error a Date is not a durable value
    defineStore("dated", testSchema<{ at: Date }>(), { initial: () => ({ at: new Date(0) }) });
    interface Cart {
      id: string;
      note?: string;
      lines: { sku: string; qty: number }[];
    }
    const Carts = defineStore("carts", testSchema<Cart>(), {
      initial: (id) => ({ id, lines: [] }),
    });
    workflow(async function* (step) {
      step.store({
        name: "dated",
        // @ts-expect-error a Date is not a durable value
        schema: testSchema<{ at: Date }>(),
        initial: () => ({ at: new Date(0) }),
      });
      const cart = step.store(Carts);
      // @ts-expect-error a Date is not a durable value
      yield* cart.select("at", () => new Date());
      // @ts-expect-error a Set is not a durable value
      yield* cart.when("skus", (state) => state.lines.length > 0 && new Set(state.lines));
      yield* cart.take(
        "taken",
        // @ts-expect-error a Map is not a durable value
        (state) => state.lines.length > 0 && { bySku: new Map<string, number>() },
        (draft) => {
          draft.lines = [];
        }
      );
      const count = yield* cart.select("count", (state) => state.lines.length);
      const note = yield* cart.select("note", (state) => state.note);
      const lines = yield* cart.when("lines", (state) => state.lines.length > 0 && state.lines);
      const busy = yield* cart.when("busy", (state) => state.lines.length > 1);
      expectTypeOf(count).toEqualTypeOf<number>();
      expectTypeOf(note).toEqualTypeOf<string | undefined>();
      expectTypeOf(lines).toEqualTypeOf<{ sku: string; qty: number }[]>();
      expectTypeOf(busy).toEqualTypeOf<true>();
      return null;
    });
  });

  test("store state keeps undefined properties", async () => {
    const { first, replay } = await acrossReplay(async function* (step) {
      const store = step.store(Orders, { id: "o5" });
      yield* store.update("set-note", (draft) => {
        draft.note = undefined;
      });
      return yield* store.get("value");
    });
    for (const run of [first, replay]) {
      const snapshot = valueOf(run) as { state: Order };
      expect(Object.keys(snapshot.state)).toEqual(["lines", "note"]);
    }
  });
});

describe("HTTP transport", () => {
  function setup() {
    const router = {
      echo: workflow(async function* (_step, event) {
        return { params: event.params, tenant: event.context.get("tenant") };
      }),
      fails: workflow(async function* () {
        throw new CourierError("royal-mail", { cause: "strike" });
      }),
    };
    const runtime = new MemoryRuntime();
    const runner = new WorkflowRunner(runtime, { router, logger });
    const invoker = createWorkflowInvoker({ runner, logger });
    const dispatcher = new ExecutionDispatcher(runtime, {
      invoker,
      logger,
      pollInterval: 1,
      keepAlive: false,
    });
    const routes = createRoutes({ runtime, invoker, logger });
    const fetchMock = vi.fn(async (url: string, init: RequestInit) =>
      routes[new URL(url).pathname]!.POST(new Request(url, init))
    );
    vi.stubGlobal("fetch", fetchMock);
    dispatcher.start();
    const http = createHttpSdkFactory<typeof router>()({ url: "http://yieldstar.test" });
    return { http, fetchMock, dispatcher, runtime };
  }

  test("params, context and results keep undefined values and tag-like keys", async () => {
    const { http, dispatcher } = setup();
    try {
      const params = { a: undefined, $type: "undefined", list: [1, undefined] };
      const execution = await http.trigger({
        workflowId: "echo",
        params,
        context: { tenant: "acme" },
      });
      const result = await execution.waitForResult();
      expect(result).toEqual({ params, tenant: "acme" });
      expect(Object.keys(result.params as object)).toEqual(["$type", "a", "list"]);
    } finally {
      dispatcher.stop();
      vi.unstubAllGlobals();
    }
  });

  test("a failed execution read through waitForResult keeps its class, code and cause", async () => {
    const { http, dispatcher } = setup();
    try {
      const execution = await http.trigger({ workflowId: "fails", params: {} });
      const error = await execution.waitForResult().catch((err) => err);
      expect(error).toBeInstanceOf(CourierError);
      expect(error.code).toBe("COURIER_DOWN");
      expect(error.courier).toBe("royal-mail");
      expect(error.cause).toBe("strike");
    } finally {
      dispatcher.stop();
      vi.unstubAllGlobals();
    }
  });

  test("a Date in params is rejected with INVALID_EXECUTION_EVENT before any request", async () => {
    const { http, fetchMock, dispatcher } = setup();
    try {
      const error = await http
        .trigger({ workflowId: "echo", params: { at: new Date(0) } })
        .catch((err) => err);
      expect(error).toBeInstanceOf(ExecutionAdmissionError);
      expect(error.code).toBe("INVALID_EXECUTION_EVENT");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      dispatcher.stop();
      vi.unstubAllGlobals();
    }
  });

  test("the trigger route still accepts plain JSON", async () => {
    const { dispatcher, runtime } = setup();
    try {
      const response = await fetch("http://yieldstar.test/trigger", {
        method: "POST",
        body: JSON.stringify({ workflowId: "echo", params: { n: 1 }, context: { tenant: "t" } }),
      });
      expect(response.status).toBe(202);
      const { executionId } = (await response.json()) as { executionId: string };
      await vi.waitFor(async () =>
        expect((await runtime.executions.get(executionId))?.outcome).toEqual({
          status: "completed",
          result: { params: { n: 1 }, tenant: "t" },
        })
      );
    } finally {
      dispatcher.stop();
      vi.unstubAllGlobals();
    }
  });

  test("an invalid trigger body is rejected with INVALID_EXECUTION_EVENT", async () => {
    const { dispatcher } = setup();
    try {
      const response = await fetch("http://yieldstar.test/trigger", {
        method: "POST",
        body: JSON.stringify({ workflowId: "echo", params: { $type: "date", value: 0 } }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_EXECUTION_EVENT" });
    } finally {
      dispatcher.stop();
      vi.unstubAllGlobals();
    }
  });
});
