import { describe, expect, test } from "vitest";
import {
  defineStore,
  type Runtime,
  type StandardSchemaV1,
  type StoreWaiter,
} from "@yieldstar/core";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";

const isBun = "Bun" in globalThis;
const { createSqliteDb } = isBun
  ? await import("@yieldstar/sqlite-runtime/bun")
  : await import("@yieldstar/sqlite-runtime/node");

/**
 * Runtime-adapter conformance for `ExecutionClient` (RFC 001). Time comes from
 * an injected clock so due times and redelivery timeouts are deterministic.
 */

type ExecutionHarnessOptions = {
  clock: () => number;
  redeliveryTimeout: number;
};

type ExecutionHarness = {
  runtime: Runtime;
  /** Opens the same durable backend in a new runtime, as after a restart. */
  restart?(): Runtime;
  dispose?(): void;
};

type ExecutionConformanceOptions = {
  name: string;
  create(options: ExecutionHarnessOptions): ExecutionHarness;
};

const START = 1_000_000;
const REDELIVERY_TIMEOUT = 1_000;

type TestContext = {
  runtime: Runtime;
  harness: ExecutionHarness;
  clock: { now: number };
  advance(ms: number): void;
};

type MessagesState = { messages: { id: string }[] };

function schema<T>(): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "yieldstar-execution-conformance",
      validate(value) {
        return { value: value as T };
      },
    },
  };
}

class Point {
  constructor(public x: number) {}
}

class PaymentDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentDeclinedError";
  }
}

function registerExecutionClientConformance({
  name,
  create,
}: ExecutionConformanceOptions) {
  const Store = defineStore(`${name}-execution-conformance`, schema<MessagesState>());

  function setup(): TestContext {
    const clock = { now: START };
    const harness = create({
      clock: () => clock.now,
      redeliveryTimeout: REDELIVERY_TIMEOUT,
    });
    return {
      runtime: harness.runtime,
      harness,
      clock,
      advance(ms) {
        clock.now += ms;
      },
    };
  }

  const probe = create({ clock: () => START, redeliveryTimeout: REDELIVERY_TIMEOUT });
  const restartable = typeof probe.restart === "function";
  probe.dispose?.();

  /** Runs `fn` against a fresh runtime and always disposes it. */
  function it(title: string, fn: (ctx: TestContext) => Promise<void>) {
    test(title, async () => {
      const ctx = setup();
      try {
        await fn(ctx);
      } finally {
        ctx.harness.dispose?.();
      }
    });
  }

  /** Like `it`, for adapters whose backend can be reopened after a crash. */
  function itAfterRestart(
    title: string,
    fn: (ctx: TestContext & { restart(): Runtime }) => Promise<void>
  ) {
    test.skipIf(!restartable)(title, async () => {
      const ctx = setup();
      try {
        await fn({ ...ctx, restart: () => ctx.harness.restart!() });
      } finally {
        ctx.harness.dispose?.();
      }
    });
  }

  async function admit(runtime: Runtime, executionId: string, workflowId = "workflow") {
    const admitted = await runtime.executions.admit({
      executionId,
      workflowId,
      params: { executionId },
      context: new Map(),
    });
    expect(admitted).toEqual({ status: "accepted", executionId });
    return executionId;
  }

  async function claimOne(runtime: Runtime, executionId: string) {
    const deliveries = await runtime.executions.claimDue();
    expect(deliveries.map((d) => d.executionId)).toEqual([executionId]);
    return deliveries[0];
  }

  async function claimedIds(runtime: Runtime) {
    return (await runtime.executions.claimDue()).map((d) => d.executionId).sort();
  }

  /** Claims every due execution and acknowledges each as suspended. */
  async function drain(runtime: Runtime) {
    const deliveries = await runtime.executions.claimDue();
    for (const delivery of deliveries) {
      await runtime.executions.acknowledge({ delivery, outcome: { status: "suspended" } });
    }
    return deliveries.map((d) => d.executionId).sort();
  }

  /** Admits an execution and acknowledges its admission delivery as suspended. */
  async function admitSuspended(runtime: Runtime, executionId: string) {
    await admit(runtime, executionId);
    const delivery = await claimOne(runtime, executionId);
    expect(
      await runtime.executions.acknowledge({ delivery, outcome: { status: "suspended" } })
    ).toEqual({ status: "suspended" });
    return executionId;
  }

  async function admitCompleted(runtime: Runtime, executionId: string, result: unknown) {
    await admit(runtime, executionId);
    const delivery = await claimOne(runtime, executionId);
    await runtime.executions.acknowledge({
      delivery,
      outcome: { status: "completed", result },
    });
    return delivery;
  }

  function waiter(executionId: string, instanceId: string, sinceVersion: number): StoreWaiter {
    return {
      workflowId: "workflow",
      executionId,
      stepKey: "wait-for-message",
      storeName: Store.name,
      storeId: executionId,
      instanceId,
      sinceVersion,
      readPaths: [["messages"]],
    };
  }

  async function appendMessage(runtime: Runtime, storeId: string, id: string) {
    return runtime.stores.updateStore({
      definition: Store,
      id: storeId,
      updater(draft) {
        draft.messages.push({ id });
      },
    });
  }

  describe(`${name} execution client conformance`, () => {
    describe("admission", () => {
      it("reserves and returns an unused caller-supplied ID", async ({ runtime }) => {
        expect(
          await runtime.executions.admit({
            executionId: "order-42",
            workflowId: "charge-order",
            params: { orderId: 42 },
            context: new Map(),
          })
        ).toEqual({ status: "accepted", executionId: "order-42" });
        expect(await runtime.executions.get("order-42")).toMatchObject({
          executionId: "order-42",
          workflowId: "charge-order",
        });
      });

      it("rejects an ID in use and leaves the existing record unchanged", async ({
        runtime,
        advance,
      }) => {
        await runtime.executions.admit({
          executionId: "order-42",
          workflowId: "charge-order",
          params: { orderId: 42 },
          context: new Map([["tenant", "acme"]]),
        });
        const before = await runtime.executions.get("order-42");
        advance(10);

        const conflict = await runtime.executions.admit({
          executionId: "order-42",
          workflowId: "refund-order",
          params: { orderId: 43 },
          context: new Map([["tenant", "other"]]),
        });
        expect(conflict).toMatchObject({
          status: "rejected",
          code: "EXECUTION_ID_CONFLICT",
        });
        expect(conflict.status === "rejected" && typeof conflict.message).toBe("string");

        const after = await runtime.executions.get("order-42");
        expect(after).toEqual(before);
        expect([...after!.context.entries()]).toEqual([["tenant", "acme"]]);
        // The rejected admission did not add a second due delivery.
        expect(await claimedIds(runtime)).toEqual(["order-42"]);
      });

      it("keeps the ID reserved after a delivery fails", async ({ runtime, advance }) => {
        await admit(runtime, "fails");
        const delivery = await claimOne(runtime, "fails");
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "failed", error: new Error("boom") },
        });
        expect(
          await runtime.executions.admit({
            executionId: "fails",
            workflowId: "workflow",
            params: undefined,
            context: new Map(),
          })
        ).toMatchObject({ status: "rejected", code: "EXECUTION_ID_CONFLICT" });

        // An unacknowledged delivery (an infrastructure failure) keeps it too.
        await admit(runtime, "crashes");
        await claimOne(runtime, "crashes");
        advance(REDELIVERY_TIMEOUT);
        expect(
          await runtime.executions.admit({
            executionId: "crashes",
            workflowId: "workflow",
            params: undefined,
            context: new Map(),
          })
        ).toMatchObject({ status: "rejected", code: "EXECUTION_ID_CONFLICT" });
      });

      it("chooses a new ID when none is supplied", async ({ runtime }) => {
        await admit(runtime, "existing");
        const ids = new Set(["existing"]);
        for (let i = 0; i < 20; i++) {
          const admitted = await runtime.executions.admit({
            workflowId: "workflow",
            params: { i },
            context: new Map(),
          });
          if (admitted.status !== "accepted") throw new Error("admission rejected");
          expect(typeof admitted.executionId).toBe("string");
          expect(admitted.executionId).not.toBe("");
          expect(ids.has(admitted.executionId)).toBe(false);
          ids.add(admitted.executionId);
          expect(await runtime.executions.get(admitted.executionId)).toMatchObject({
            params: { i },
          });
        }
      });

      it("stores the event once and get returns it exactly as admitted", async ({
        runtime,
      }) => {
        const params = {
          text: "é🚀",
          int: 42,
          float: 1.5,
          negative: -3,
          yes: true,
          no: false,
          nothing: null,
          list: [1, "two", { three: [null] }],
          nested: { a: { b: { c: "d" } } },
          empty: {},
        };
        const context = new Map<string | number, unknown>([
          ["tenant", "acme"],
          ["count", 2],
          [7, { roles: ["admin"] }],
        ]);
        await runtime.executions.admit({
          executionId: "event",
          workflowId: "charge-order",
          params,
          context,
        });

        // Mutating the caller's objects after admission must not reach the record.
        params.nested.a.b.c = "mutated";
        context.set("tenant", "mutated");

        const record = await runtime.executions.get("event");
        expect(record).toBeDefined();
        expect(record!.workflowId).toBe("charge-order");
        expect(record!.params).toEqual({
          ...params,
          nested: { a: { b: { c: "d" } } },
        });
        const ctx = record!.context;
        expect(typeof ctx.get).toBe("function");
        expect(typeof ctx.has).toBe("function");
        expect(ctx.size).toBe(3);
        expect(ctx.get("tenant")).toBe("acme");
        expect(ctx.get(7)).toEqual({ roles: ["admin"] });
        expect([...ctx.entries()]).toEqual([
          ["tenant", "acme"],
          ["count", 2],
          [7, { roles: ["admin"] }],
        ]);

        await runtime.executions.admit({
          executionId: "no-params",
          workflowId: "workflow",
          params: undefined,
          context: new Map(),
        });
        const bare = await runtime.executions.get("no-params");
        expect(bare!.params).toBeUndefined();
        expect(bare!.context.size).toBe(0);
      });

      it("hands out deliveries that name the execution, not a copy of its event", async ({
        runtime,
      }) => {
        await runtime.executions.admit({
          executionId: "delivery",
          workflowId: "charge-order",
          params: { orderId: 42 },
          context: new Map([["tenant", "acme"]]),
        });
        const [delivery] = await runtime.executions.claimDue();
        expect(Object.keys(delivery).sort()).toEqual(["executionId", "token"]);
        expect(delivery.executionId).toBe("delivery");
        expect(typeof delivery.token).toBe("string");

        // The worker reads the event from the record.
        const record = await runtime.executions.get(delivery.executionId);
        expect(record).toMatchObject({
          workflowId: "charge-order",
          params: { orderId: 42 },
        });
        expect(record!.context.get("tenant")).toBe("acme");
      });

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const invalidEvents: [string, { params: any; context: Map<any, any> }][] = [
        ["a Date", { params: { at: new Date(0) }, context: new Map() }],
        ["an undefined property", { params: { missing: undefined }, context: new Map() }],
        ["a class instance", { params: { point: new Point(1) }, context: new Map() }],
        ["NaN", { params: { n: NaN }, context: new Map() }],
        ["Infinity", { params: { n: Infinity }, context: new Map() }],
        ["a bigint", { params: { n: 10n }, context: new Map() }],
        ["a function", { params: { fn: () => 1 }, context: new Map() }],
        ["a Map", { params: { map: new Map([["a", 1]]) }, context: new Map() }],
        ["a sparse array", { params: { list: [1, , 3] }, context: new Map() }],
        ["a cycle", { params: cyclic, context: new Map() }],
        ["a Date in context", { params: {}, context: new Map([["at", new Date(0)]]) }],
        ["an undefined context value", { params: {}, context: new Map([["v", undefined]]) }],
        ["an object context key", { params: {}, context: new Map([[{}, 1]]) }],
      ];
      for (const [label, event] of invalidEvents) {
        it(`rejects ${label} with INVALID_EXECUTION_EVENT and stores nothing`, async ({
          runtime,
        }) => {
          const rejected = await runtime.executions.admit({
            executionId: "invalid",
            workflowId: "workflow",
            ...event,
          });
          expect(rejected).toMatchObject({
            status: "rejected",
            code: "INVALID_EXECUTION_EVENT",
          });
          expect(await runtime.executions.get("invalid")).toBeUndefined();
          expect(await runtime.executions.claimDue()).toEqual([]);
          // The ID was not reserved.
          await admit(runtime, "invalid");
        });
      }

      it("creates an admitted record that claimDue returns", async ({ runtime, clock }) => {
        await admit(runtime, "admitted");
        expect(await runtime.executions.get("admitted")).toMatchObject({
          status: "admitted",
          admittedAt: clock.now,
          updatedAt: clock.now,
        });
        expect((await runtime.executions.get("admitted"))!.outcome).toBeUndefined();
        await claimOne(runtime, "admitted");
      });
    });

    describe("wakes", () => {
      it("returns an execution once when two wakes are requested before a delivery", async ({
        runtime,
        clock,
      }) => {
        await admitSuspended(runtime, "twice");
        expect(
          await runtime.executions.requestWake({ executionId: "twice", wakeAt: clock.now })
        ).toEqual({ status: "requested" });
        expect(
          await runtime.executions.requestWake({ executionId: "twice", wakeAt: clock.now })
        ).toEqual({ status: "requested" });
        expect(await claimedIds(runtime)).toEqual(["twice"]);

        // The admission wake and a requested wake collapse too.
        await admit(runtime, "admitted-and-woken");
        await runtime.executions.requestWake({
          executionId: "admitted-and-woken",
          wakeAt: clock.now,
        });
        expect(await claimedIds(runtime)).toEqual(["admitted-and-woken"]);
      });

      it("merges wakes into the earliest requested time", async ({ runtime, clock, advance }) => {
        await admitSuspended(runtime, "earliest");
        await runtime.executions.requestWake({ executionId: "earliest", wakeAt: clock.now + 200 });
        await runtime.executions.requestWake({ executionId: "earliest", wakeAt: clock.now + 100 });
        await runtime.executions.requestWake({ executionId: "earliest", wakeAt: clock.now + 300 });
        advance(99);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["earliest"]);
      });

      it("keeps a wake requested during a delivery after it acknowledges", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "during");
        const delivery = await claimOne(runtime, "during");
        await runtime.executions.requestWake({ executionId: "during", wakeAt: clock.now + 50 });
        await runtime.executions.acknowledge({ delivery, outcome: { status: "suspended" } });
        advance(49);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["during"]);
      });

      it("makes a suspended delivery due at its wakeAt", async ({ runtime, clock, advance }) => {
        await admit(runtime, "delay");
        const delivery = await claimOne(runtime, "delay");
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "suspended", wakeAt: clock.now + 500 },
        });
        advance(499);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["delay"]);
      });

      it("prefers an earlier wake requested during a delivery over its wakeAt", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "race");
        const delivery = await claimOne(runtime, "race");
        await runtime.executions.requestWake({ executionId: "race", wakeAt: clock.now + 100 });
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "suspended", wakeAt: clock.now + 500 },
        });
        advance(99);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["race"]);
      });

      it("does not make a suspended delivery due without wakeAt or a new wake", async ({
        runtime,
        advance,
      }) => {
        await admitSuspended(runtime, "idle");
        advance(REDELIVERY_TIMEOUT * 10);
        expect(await runtime.executions.claimDue()).toEqual([]);
        expect(await runtime.executions.get("idle")).toMatchObject({ status: "suspended" });
      });

      it("redelivers an unacknowledged delivery whose paused step reached wakeAt", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "paused");
        const first = await claimOne(runtime, "paused");
        await runtime.executions.acknowledge({
          delivery: first,
          outcome: { status: "suspended", wakeAt: clock.now + 100 },
        });
        advance(100);
        const second = await claimOne(runtime, "paused");
        // The worker crashes: no acknowledgement.
        advance(REDELIVERY_TIMEOUT - 1);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        const third = await claimOne(runtime, "paused");
        expect(third.token).not.toBe(second.token);
        expect(
          await runtime.executions.acknowledge({
            delivery: third,
            outcome: { status: "completed", result: "done" },
          })
        ).toEqual({ status: "completed", result: "done" });
      });

      it("does not let a future wake requested during a past-due delivery inherit its due time", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admitSuspended(runtime, "past-due");
        await runtime.executions.requestWake({ executionId: "past-due", wakeAt: clock.now - 500 });
        const delivery = await claimOne(runtime, "past-due");
        await runtime.executions.requestWake({ executionId: "past-due", wakeAt: clock.now + 300 });
        await runtime.executions.acknowledge({ delivery, outcome: { status: "suspended" } });
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(299);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["past-due"]);
      });

      it("rejects a wake for an unknown execution without creating a record", async ({
        runtime,
        clock,
      }) => {
        const result = await runtime.executions.requestWake({
          executionId: "ghost",
          wakeAt: clock.now,
        });
        expect(result).toMatchObject({ status: "rejected", code: "EXECUTION_NOT_FOUND" });
        expect(result.status === "rejected" && typeof result.message).toBe("string");
        expect(await runtime.executions.get("ghost")).toBeUndefined();
        expect(await runtime.executions.claimDue()).toEqual([]);
        await admit(runtime, "ghost");
      });

      it("does not return a claimed delivery again before the redelivery timeout", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "claimed");
        await claimOne(runtime, "claimed");
        expect(await runtime.executions.claimDue()).toEqual([]);
        // New wakes do not bypass the claim either.
        await runtime.executions.requestWake({ executionId: "claimed", wakeAt: clock.now });
        advance(REDELIVERY_TIMEOUT - 1);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["claimed"]);
      });

      it("keeps the wakes of a never-acknowledged delivery pending and redelivers it", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "lost");
        const first = await claimOne(runtime, "lost");
        advance(REDELIVERY_TIMEOUT);
        const second = await claimOne(runtime, "lost");
        expect(second.token).not.toBe(first.token);
        expect(await runtime.executions.get("lost")).toMatchObject({ status: "admitted" });
        await runtime.executions.acknowledge({
          delivery: second,
          outcome: { status: "suspended" },
        });
        advance(REDELIVERY_TIMEOUT * 10);
        expect(await runtime.executions.claimDue()).toEqual([]);
      });

      it("ignores a wake for a terminal execution", async ({ runtime, clock, advance }) => {
        await admitCompleted(runtime, "done", 1);
        await admit(runtime, "failed");
        const delivery = await claimOne(runtime, "failed");
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "failed", error: new Error("boom") },
        });
        for (const executionId of ["done", "failed"]) {
          expect(
            await runtime.executions.requestWake({ executionId, wakeAt: clock.now })
          ).toEqual({ status: "ignored" });
        }
        advance(REDELIVERY_TIMEOUT * 10);
        expect(await runtime.executions.claimDue()).toEqual([]);
      });

      it("clears pending wakes when an execution reaches a terminal status", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "finishing");
        const delivery = await claimOne(runtime, "finishing");
        await runtime.executions.requestWake({ executionId: "finishing", wakeAt: clock.now });
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "completed", result: null },
        });
        advance(REDELIVERY_TIMEOUT * 10);
        expect(await runtime.executions.claimDue()).toEqual([]);
      });

      it("returns each due execution at most once per claim", async ({ runtime, clock }) => {
        for (const id of ["a", "b", "c"]) await admit(runtime, id);
        await runtime.executions.requestWake({ executionId: "b", wakeAt: clock.now - 1 });
        await runtime.executions.requestWake({ executionId: "b", wakeAt: clock.now });
        expect(await claimedIds(runtime)).toEqual(["a", "b", "c"]);
        expect(await runtime.executions.claimDue()).toEqual([]);
      });
    });

    describe("store waiters", () => {
      it("wakes a waiting execution when a store commit satisfies its waiter", async ({
        runtime,
      }) => {
        await admitSuspended(runtime, "consumer");
        const snapshot = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "consumer",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter("consumer", snapshot.instanceId, snapshot.version)
        );
        expect(await runtime.executions.claimDue()).toEqual([]);
        await appendMessage(runtime, "consumer", "m1");
        expect(await claimedIds(runtime)).toEqual(["consumer"]);
      });

      it("deletes a waiter with the write that records its step's result", async ({
        runtime,
      }) => {
        await admitSuspended(runtime, "recorded");
        const snapshot = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "recorded",
          initial: { messages: [] },
        });
        const registered = waiter("recorded", snapshot.instanceId, snapshot.version);
        await runtime.stores.registerWaiter(registered);

        // An unfinished attempt does not delete the waiter.
        await runtime.heap.writeStep({
          executionId: "recorded",
          stepKey: registered.stepKey,
          stepAttempt: 1,
          stepDone: false,
          stepResponseJson: JSON.stringify({ waiting: true }),
        });
        await appendMessage(runtime, "recorded", "m1");
        const delivery = await claimOne(runtime, "recorded");

        // The step records its result: the waiter goes with it.
        await runtime.heap.writeStep({
          executionId: "recorded",
          stepKey: registered.stepKey,
          stepAttempt: 2,
          stepDone: true,
          stepResponseJson: JSON.stringify({ id: "m1" }),
        });
        await runtime.executions.acknowledge({ delivery, outcome: { status: "suspended" } });
        await appendMessage(runtime, "recorded", "m2");
        expect(await runtime.executions.claimDue()).toEqual([]);
      });
    });

    describe("clock", () => {
      it("reads time from the runtime clock, not the wall clock", async ({
        runtime,
        clock,
        advance,
      }) => {
        // The fixed clock is far behind the wall clock.
        clock.now = 5_000;
        await admit(runtime, "clocked");
        expect(await runtime.executions.get("clocked")).toMatchObject({
          admittedAt: 5_000,
          updatedAt: 5_000,
        });
        const delivery = await claimOne(runtime, "clocked");
        advance(7);
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "suspended", wakeAt: Date.now() },
        });
        expect(await runtime.executions.get("clocked")).toMatchObject({
          status: "suspended",
          updatedAt: 5_007,
        });
        // A wall-clock wake time is in the far future for this runtime.
        expect(await runtime.executions.claimDue()).toEqual([]);
        await runtime.executions.requestWake({ executionId: "clocked", wakeAt: 5_100 });
        advance(92);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        await claimOne(runtime, "clocked");
        // The redelivery timeout is measured on the same clock.
        advance(REDELIVERY_TIMEOUT - 1);
        expect(await runtime.executions.claimDue()).toEqual([]);
        advance(1);
        await claimOne(runtime, "clocked");
      });
    });

    describe("outcomes", () => {
      it("records a suspended acknowledgement without an outcome", async ({
        runtime,
        advance,
        clock,
      }) => {
        await admit(runtime, "suspends");
        const delivery = await claimOne(runtime, "suspends");
        advance(5);
        expect(
          await runtime.executions.acknowledge({
            delivery,
            outcome: { status: "suspended", wakeAt: clock.now + 1_000 },
          })
        ).toEqual({ status: "suspended" });
        const record = await runtime.executions.get("suspends");
        expect(record).toMatchObject({
          status: "suspended",
          admittedAt: START,
          updatedAt: START + 5,
        });
        expect(record!.outcome).toBeUndefined();
      });

      it("records a completed acknowledgement and its result", async ({ runtime }) => {
        const result = { receipt: "r-1", amount: 12.5, lines: [{ sku: "a" }] };
        await admit(runtime, "completes");
        const delivery = await claimOne(runtime, "completes");
        expect(
          await runtime.executions.acknowledge({
            delivery,
            outcome: { status: "completed", result },
          })
        ).toEqual({ status: "completed", result });
        expect(await runtime.executions.get("completes")).toMatchObject({
          status: "completed",
          outcome: { status: "completed", result },
        });

        await admitCompleted(runtime, "void", undefined);
        const voidRecord = await runtime.executions.get("void");
        expect(voidRecord!.status).toBe("completed");
        expect(voidRecord!.outcome).toEqual({ status: "completed", result: undefined });
      });

      it("records a failed acknowledgement with the error name and message", async ({
        runtime,
      }) => {
        await admit(runtime, "fails");
        const delivery = await claimOne(runtime, "fails");
        const acknowledged = await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "failed", error: new PaymentDeclinedError("card declined") },
        });
        expect(acknowledged.status).toBe("failed");
        const record = await runtime.executions.get("fails");
        expect(record!.status).toBe("failed");
        for (const outcome of [acknowledged, record!.outcome!]) {
          if (outcome.status !== "failed") throw new Error("expected a failed outcome");
          expect(outcome.error).toBeInstanceOf(Error);
          expect(outcome.error.name).toBe("PaymentDeclinedError");
          expect(outcome.error.message).toBe("card declined");
        }
        // Every later read returns the same recorded error.
        const again = await runtime.executions.get("fails");
        expect(again!.outcome).toMatchObject({ status: "failed" });
        const error = (again!.outcome as { error: Error }).error;
        expect([error.name, error.message]).toEqual(["PaymentDeclinedError", "card declined"]);
      });

      it("keeps the first terminal outcome when a later one differs", async ({ runtime }) => {
        const delivery = await admitCompleted(runtime, "first-wins", "first");
        const recorded = await runtime.executions.get("first-wins");
        expect(
          await runtime.executions.acknowledge({
            delivery,
            outcome: { status: "failed", error: new Error("second") },
          })
        ).toEqual({ status: "completed", result: "first" });
        expect(
          await runtime.executions.acknowledge({
            delivery,
            outcome: { status: "completed", result: "second" },
          })
        ).toEqual({ status: "completed", result: "first" });
        expect(await runtime.executions.get("first-wins")).toEqual(recorded);

        await admit(runtime, "failed-first");
        const failing = await claimOne(runtime, "failed-first");
        await runtime.executions.acknowledge({
          delivery: failing,
          outcome: { status: "failed", error: new TypeError("original") },
        });
        const late = await runtime.executions.acknowledge({
          delivery: failing,
          outcome: { status: "completed", result: "late" },
        });
        expect(late.status).toBe("failed");
        expect((late as { error: Error }).error).toMatchObject({
          name: "TypeError",
          message: "original",
        });
      });

      it("keeps a terminal record when a suspended acknowledgement arrives after it", async ({
        runtime,
        clock,
        advance,
      }) => {
        const delivery = await admitCompleted(runtime, "terminal", { ok: true });
        const recorded = await runtime.executions.get("terminal");
        advance(10);
        expect(
          await runtime.executions.acknowledge({
            delivery,
            outcome: { status: "suspended", wakeAt: clock.now },
          })
        ).toEqual({ status: "completed", result: { ok: true } });
        expect(await runtime.executions.get("terminal")).toEqual(recorded);
        expect(await runtime.executions.claimDue()).toEqual([]);
      });

      it("returns the recorded outcome to a duplicate delivery of a terminal execution", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "duplicate");
        const slow = await claimOne(runtime, "duplicate");
        advance(REDELIVERY_TIMEOUT);
        const redelivered = await claimOne(runtime, "duplicate");
        expect(
          await runtime.executions.acknowledge({
            delivery: redelivered,
            outcome: { status: "completed", result: "fast" },
          })
        ).toEqual({ status: "completed", result: "fast" });
        // The slow delivery reports late and gets the recorded outcome back.
        expect(
          await runtime.executions.acknowledge({
            delivery: slow,
            outcome: { status: "completed", result: "slow" },
          })
        ).toEqual({ status: "completed", result: "fast" });
        // A terminal execution is never handed out again.
        advance(REDELIVERY_TIMEOUT * 10);
        expect(await runtime.executions.claimDue()).toEqual([]);
      });

      it("leaves the status unchanged after an infrastructure error and redelivers", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admitSuspended(runtime, "infra");
        const before = await runtime.executions.get("infra");
        await runtime.executions.requestWake({ executionId: "infra", wakeAt: clock.now });
        await claimOne(runtime, "infra");
        // deliver() rejected: the dispatcher does not acknowledge.
        advance(REDELIVERY_TIMEOUT);
        expect(await runtime.executions.get("infra")).toMatchObject({
          status: "suspended",
          updatedAt: before!.updatedAt,
        });
        expect((await runtime.executions.get("infra"))!.outcome).toBeUndefined();
        await claimOne(runtime, "infra");
      });
    });

    describe("durability", () => {
      itAfterRestart("preserves admitted and suspended records and their pending wakes across a restart", async ({ runtime, clock, advance, restart }) => {
        await admit(runtime, "delayed");
        const delayed = await claimOne(runtime, "delayed");
        await runtime.executions.acknowledge({
          delivery: delayed,
          outcome: { status: "suspended", wakeAt: clock.now + 500 },
        });

        await admitSuspended(runtime, "woken");
        await runtime.executions.requestWake({ executionId: "woken", wakeAt: clock.now + 200 });

        await admitSuspended(runtime, "idle");

        await admit(runtime, "in-flight");
        await claimOne(runtime, "in-flight");

        await admitCompleted(runtime, "finished", { receipt: "r-1" });

        // Admitted last, so earlier claims do not pick it up.
        await runtime.executions.admit({
          executionId: "admitted",
          workflowId: "charge-order",
          params: { orderId: 42 },
          context: new Map([["tenant", "acme"]]),
        });

        const records = await Promise.all(
          ["admitted", "delayed", "woken", "idle", "in-flight", "finished"].map((id) =>
            runtime.executions.get(id)
          )
        );

        const restarted = restart();
        expect(
          await Promise.all(
            ["admitted", "delayed", "woken", "idle", "in-flight", "finished"].map((id) =>
              restarted.executions.get(id)
            )
          )
        ).toEqual(records);
        expect(
          [...(await restarted.executions.get("admitted"))!.context.entries()]
        ).toEqual([["tenant", "acme"]]);

        // Restarting does not lose a claim: the in-flight delivery still waits
        // for its redelivery timeout.
        expect(await drain(restarted)).toEqual(["admitted"]);
        advance(200);
        expect(await drain(restarted)).toEqual(["woken"]);
        advance(300);
        expect(await drain(restarted)).toEqual(["delayed"]);
        advance(REDELIVERY_TIMEOUT - 500 - 1);
        expect(await drain(restarted)).toEqual([]);
        advance(1);
        expect(await drain(restarted)).toEqual(["in-flight"]);
        expect(
          await restarted.executions.admit({
            executionId: "finished",
            workflowId: "workflow",
            params: undefined,
            context: new Map(),
          })
        ).toMatchObject({ status: "rejected", code: "EXECUTION_ID_CONFLICT" });
      });

      itAfterRestart("makes a store commit and the wakes it requires durable together", async ({ runtime, restart }) => {
        await admitSuspended(runtime, "committed");
        const snapshot = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "committed",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter("committed", snapshot.instanceId, snapshot.version)
        );
        await appendMessage(runtime, "committed", "m1");

        // Crash immediately after the commit returns, before anyone claims.
        const restarted = restart();
        expect(
          await restarted.stores.getStore({ definition: Store, id: "committed" })
        ).toMatchObject({ state: { messages: [{ id: "m1" }] }, version: 1 });
        expect(await claimedIds(restarted)).toEqual(["committed"]);
      });

      itAfterRestart("keeps a registered waiter across a restart", async ({ runtime, restart }) => {
        await admitSuspended(runtime, "durable-waiter");
        const snapshot = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "durable-waiter",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter("durable-waiter", snapshot.instanceId, snapshot.version)
        );
        const restarted = restart();
        await appendMessage(restarted, "durable-waiter", "m1");
        expect(await claimedIds(restarted)).toEqual(["durable-waiter"]);
      });
    });
  });
}

registerExecutionClientConformance({
  name: "memory",
  create(options) {
    return { runtime: new MemoryRuntime(options) };
  },
});

registerExecutionClientConformance({
  name: isBun ? "sqlite-bun" : "sqlite-node",
  create(options) {
    const db = createSqliteDb({ path: ":memory:", wal: false });
    return {
      runtime: new SqliteRuntime(db, options),
      restart() {
        return new SqliteRuntime(db, options);
      },
      dispose() {
        db.close();
      },
    };
  },
});
