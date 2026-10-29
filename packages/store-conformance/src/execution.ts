import {
  DEFAULT_LEASE_DURATION,
  defineStore,
  redeliveryDelay,
  type ExecutionLease,
  type Runtime,
  type StandardSchemaV1,
  type StoreWaiter,
} from "@yieldstar/core";
import { describe, expect, test } from "vitest";

/**
 * Runtime-adapter conformance for `ExecutionClient` and fenced heap writes
 * (RFC 001 and RFC 002). Time comes from the clock the suite passes to
 * `create`, so due times, lease expiry and redelivery delays are
 * deterministic. Construct the runtime with that clock.
 */

export type ExecutionConformanceHarnessOptions = {
  clock: () => number;
};

/** A clean runtime under test, built on the suite's clock. */
export type ExecutionConformanceHarness = {
  runtime: Runtime;
  /**
   * Creates another runtime sharing the same backend, as another process
   * would. Cases that need one fall back to `runtime` when it is absent.
   */
  createPeer?(): Runtime | Promise<Runtime>;
  /** Opens the same durable backend in a new runtime, as after a restart. */
  restart?(): Runtime | Promise<Runtime>;
  dispose?(): void | Promise<void>;
};

export type ExecutionConformanceOptions = {
  name: string;
  create(
    options: ExecutionConformanceHarnessOptions
  ): ExecutionConformanceHarness | Promise<ExecutionConformanceHarness>;
};

const START = 1_000_000;

/** The lease duration the suite claims with. */
const LEASE = DEFAULT_LEASE_DURATION;

/**
 * How long after a claim an unrenewed, unacknowledged lease leaves its
 * execution claimable again: the lease expires, then the first redelivery
 * delay passes.
 */
const REDELIVER_AFTER = LEASE + redeliveryDelay(1);

type TestContext = {
  runtime: Runtime;
  harness: ExecutionConformanceHarness;
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

/** Registers the RFC 001 `ExecutionClient` runtime-adapter suite. */
export function registerExecutionClientConformance({
  name,
  create,
}: ExecutionConformanceOptions): void {
  const Store = defineStore(`${name}-execution-conformance`, schema<MessagesState>());

  async function setup(): Promise<TestContext> {
    const clock = { now: START };
    const harness = await create({
      clock: () => clock.now,
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

  /** Runs `fn` against a fresh runtime and always disposes it. */
  function it(title: string, fn: (ctx: TestContext) => Promise<void>) {
    test(title, async () => {
      const ctx = await setup();
      try {
        await fn(ctx);
      } finally {
        await ctx.harness.dispose?.();
      }
    });
  }

  /** Like `it`, for adapters whose backend can be reopened after a crash. */
  function itAfterRestart(
    title: string,
    fn: (ctx: TestContext & { restart(): Promise<Runtime> }) => Promise<void>
  ) {
    test(title, async (testContext) => {
      const ctx = await setup();
      try {
        if (!ctx.harness.restart) {
          testContext.skip();
          return;
        }
        await fn({ ...ctx, restart: async () => ctx.harness.restart!() });
      } finally {
        await ctx.harness.dispose?.();
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

  /** Claims every due execution with the suite's lease duration. */
  function claim(runtime: Runtime, limit = 100) {
    return runtime.executions.claimDue({ limit, duration: LEASE });
  }

  async function claimOne(runtime: Runtime, executionId: string) {
    const leases = await claim(runtime);
    expect(leases.map((d) => d.executionId)).toEqual([executionId]);
    return leases[0];
  }

  async function claimedIds(runtime: Runtime) {
    return (await claim(runtime)).map((d) => d.executionId).sort();
  }

  /** Claims every due execution and acknowledges each as suspended. */
  async function drain(runtime: Runtime) {
    const leases = await claim(runtime);
    for (const lease of leases) {
      await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
    }
    return leases.map((d) => d.executionId).sort();
  }

  /** Admits an execution and acknowledges its admission delivery as suspended. */
  async function admitSuspended(runtime: Runtime, executionId: string) {
    await admit(runtime, executionId);
    const lease = await claimOne(runtime, executionId);
    expect(
      await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } })
    ).toEqual({ status: "suspended" });
    return executionId;
  }

  async function admitCompleted(runtime: Runtime, executionId: string, result: unknown) {
    await admit(runtime, executionId);
    const lease = await claimOne(runtime, executionId);
    await runtime.executions.acknowledge({
      lease,
      outcome: { status: "completed", result },
    });
    return lease;
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
        const lease = await claimOne(runtime, "fails");
        await runtime.executions.acknowledge({
          lease,
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
        advance(REDELIVER_AFTER);
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

      it("hands out leases that name the execution, not a copy of its event", async ({
        runtime,
        clock,
      }) => {
        await runtime.executions.admit({
          executionId: "delivery",
          workflowId: "charge-order",
          params: { orderId: 42 },
          context: new Map([["tenant", "acme"]]),
        });
        const [lease] = await claim(runtime);
        expect(Object.keys(lease).sort()).toEqual(["executionId", "expiresAt", "token"]);
        expect(lease.executionId).toBe("delivery");
        expect(typeof lease.token).toBe("number");
        expect(lease.expiresAt).toBe(clock.now + LEASE);

        // The worker reads the event from the record.
        const record = await runtime.executions.get(lease.executionId);
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
          expect(await claim(runtime)).toEqual([]);
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
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["earliest"]);
      });

      it("keeps a wake requested during a delivery after it acknowledges", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "during");
        const lease = await claimOne(runtime, "during");
        await runtime.executions.requestWake({ executionId: "during", wakeAt: clock.now + 50 });
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        advance(49);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["during"]);
      });

      it("makes a suspended delivery due at its wakeAt", async ({ runtime, clock, advance }) => {
        await admit(runtime, "delay");
        const lease = await claimOne(runtime, "delay");
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "suspended", wakeAt: clock.now + 500 },
        });
        advance(499);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["delay"]);
      });

      it("prefers an earlier wake requested during a delivery over its wakeAt", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "race");
        const lease = await claimOne(runtime, "race");
        await runtime.executions.requestWake({ executionId: "race", wakeAt: clock.now + 100 });
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "suspended", wakeAt: clock.now + 500 },
        });
        advance(99);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["race"]);
      });

      it("does not make a suspended delivery due without wakeAt or a new wake", async ({
        runtime,
        advance,
      }) => {
        await admitSuspended(runtime, "idle");
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
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
          lease: first,
          outcome: { status: "suspended", wakeAt: clock.now + 100 },
        });
        advance(100);
        const second = await claimOne(runtime, "paused");
        // The worker crashes: no acknowledgement.
        advance(REDELIVER_AFTER - 1);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        const third = await claimOne(runtime, "paused");
        expect(third.token).toBeGreaterThan(second.token);
        expect(
          await runtime.executions.acknowledge({
            lease: third,
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
        const lease = await claimOne(runtime, "past-due");
        await runtime.executions.requestWake({ executionId: "past-due", wakeAt: clock.now + 300 });
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        expect(await claim(runtime)).toEqual([]);
        advance(299);
        expect(await claim(runtime)).toEqual([]);
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
        expect(await claim(runtime)).toEqual([]);
        await admit(runtime, "ghost");
      });

      it("does not return a leased execution again before its lease expires", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "claimed");
        await claimOne(runtime, "claimed");
        expect(await claim(runtime)).toEqual([]);
        // New wakes do not bypass the claim either.
        await runtime.executions.requestWake({ executionId: "claimed", wakeAt: clock.now });
        advance(REDELIVER_AFTER - 1);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        expect(await claimedIds(runtime)).toEqual(["claimed"]);
      });

      it("keeps the wakes of a never-acknowledged delivery pending and redelivers it", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "lost");
        const first = await claimOne(runtime, "lost");
        advance(REDELIVER_AFTER);
        expect(await runtime.executions.get("lost")).toMatchObject({ status: "admitted" });
        const second = await claimOne(runtime, "lost");
        expect(second.token).toBeGreaterThan(first.token);
        await runtime.executions.acknowledge({
          lease: second,
          outcome: { status: "suspended" },
        });
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
      });

      it("ignores a wake for a terminal execution", async ({ runtime, clock, advance }) => {
        await admitCompleted(runtime, "done", 1);
        await admit(runtime, "failed");
        const lease = await claimOne(runtime, "failed");
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "failed", error: new Error("boom") },
        });
        for (const executionId of ["done", "failed"]) {
          expect(
            await runtime.executions.requestWake({ executionId, wakeAt: clock.now })
          ).toEqual({ status: "ignored" });
        }
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
      });

      it("clears pending wakes when an execution reaches a terminal status", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "finishing");
        const lease = await claimOne(runtime, "finishing");
        await runtime.executions.requestWake({ executionId: "finishing", wakeAt: clock.now });
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "completed", result: null },
        });
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
      });

      it("returns each due execution at most once per claim", async ({ runtime, clock }) => {
        for (const id of ["a", "b", "c"]) await admit(runtime, id);
        await runtime.executions.requestWake({ executionId: "b", wakeAt: clock.now - 1 });
        await runtime.executions.requestWake({ executionId: "b", wakeAt: clock.now });
        expect(await claimedIds(runtime)).toEqual(["a", "b", "c"]);
        expect(await claim(runtime)).toEqual([]);
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
        expect(await claim(runtime)).toEqual([]);
        await appendMessage(runtime, "consumer", "m1");
        expect(await claimedIds(runtime)).toEqual(["consumer"]);
      });

      it("deletes a waiter with the write that records its step's result", async ({
        runtime,
        clock,
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
        await runtime.executions.requestWake({ executionId: "recorded", wakeAt: clock.now });
        const waiting = await claimOne(runtime, "recorded");
        await runtime.heap.writeStep({
          lease: waiting,
          stepKey: registered.stepKey,
          stepAttempt: 1,
          done: false,
          stepResponseJson: JSON.stringify({ waiting: true }),
        });
        await runtime.executions.acknowledge({
          lease: waiting,
          outcome: { status: "suspended" },
        });
        await appendMessage(runtime, "recorded", "m1");
        const lease = await claimOne(runtime, "recorded");

        // The step records its result: the waiter goes with it.
        await runtime.heap.writeStep({
          lease,
          stepKey: registered.stepKey,
          stepAttempt: 2,
          done: true,
          stepResponseJson: JSON.stringify({ id: "m1" }),
        });
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        await appendMessage(runtime, "recorded", "m2");
        expect(await claim(runtime)).toEqual([]);
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
        const lease = await claimOne(runtime, "clocked");
        advance(7);
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "suspended", wakeAt: Date.now() },
        });
        expect(await runtime.executions.get("clocked")).toMatchObject({
          status: "suspended",
          updatedAt: 5_007,
        });
        // A wall-clock wake time is in the far future for this runtime.
        expect(await claim(runtime)).toEqual([]);
        await runtime.executions.requestWake({ executionId: "clocked", wakeAt: 5_100 });
        advance(92);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        await claimOne(runtime, "clocked");
        // Lease expiry and the redelivery delay are measured on the same clock.
        advance(REDELIVER_AFTER - 1);
        expect(await claim(runtime)).toEqual([]);
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
        const lease = await claimOne(runtime, "suspends");
        advance(5);
        expect(
          await runtime.executions.acknowledge({
            lease,
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
        const lease = await claimOne(runtime, "completes");
        expect(
          await runtime.executions.acknowledge({
            lease,
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
        const lease = await claimOne(runtime, "fails");
        const acknowledged = await runtime.executions.acknowledge({
          lease,
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

      it("keeps the first terminal outcome: a later acknowledgement under the ended lease is lost", async ({
        runtime,
        clock,
        advance,
      }) => {
        const lease = await admitCompleted(runtime, "first-wins", "first");
        const recorded = await runtime.executions.get("first-wins");
        advance(10);
        for (const outcome of [
          { status: "failed", error: new Error("second") },
          { status: "completed", result: "second" },
          { status: "suspended", wakeAt: clock.now },
        ] as const) {
          expect(await runtime.executions.acknowledge({ lease, outcome })).toEqual({
            status: "lost",
          });
        }
        expect(await runtime.executions.get("first-wins")).toEqual(recorded);
        // A terminal execution is never handed out again.
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
      });

      it("keeps a terminal outcome when a stale lease acknowledges after a reclaim", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "duplicate");
        const slow = await claimOne(runtime, "duplicate");
        advance(REDELIVER_AFTER);
        const redelivered = await claimOne(runtime, "duplicate");
        expect(
          await runtime.executions.acknowledge({
            lease: redelivered,
            outcome: { status: "completed", result: "fast" },
          })
        ).toEqual({ status: "completed", result: "fast" });
        const recorded = await runtime.executions.get("duplicate");
        // The slow delivery reports late and is fenced off.
        expect(
          await runtime.executions.acknowledge({
            lease: slow,
            outcome: { status: "completed", result: "slow" },
          })
        ).toEqual({ status: "lost" });
        expect(await runtime.executions.get("duplicate")).toEqual(recorded);
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
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
        advance(REDELIVER_AFTER);
        expect(await runtime.executions.get("infra")).toMatchObject({
          status: "suspended",
          updatedAt: before!.updatedAt,
        });
        expect((await runtime.executions.get("infra"))!.outcome).toBeUndefined();
        await claimOne(runtime, "infra");
      });
    });

    describe("leases", () => {
      it("grants exactly one lease when two clients claim one due execution concurrently", async ({
        runtime,
        harness,
      }) => {
        await admit(runtime, "contended");
        const peer = (await harness.createPeer?.()) ?? runtime;
        const claims = await Promise.all([claim(runtime), claim(peer), claim(runtime)]);
        const leases = claims.flat();
        expect(leases.map((lease) => lease.executionId)).toEqual(["contended"]);
      });

      it("never grants a second live lease to concurrent claimers of many executions", async ({
        runtime,
        harness,
      }) => {
        const ids = Array.from({ length: 20 }, (_, i) => `many-${String(i).padStart(2, "0")}`);
        for (const id of ids) await admit(runtime, id);
        const peer = (await harness.createPeer?.()) ?? runtime;
        const claims = await Promise.all(
          Array.from({ length: 6 }, (_, i) => claim(i % 2 ? peer : runtime, 4))
        );
        const claimed = claims.flat().map((lease) => lease.executionId).sort();
        expect(new Set(claimed).size).toBe(claimed.length);
        expect(claimed).toEqual(ids);
      });

      it("returns at most `limit` leases, earliest due first", async ({
        runtime,
        clock,
        advance,
      }) => {
        for (const id of ["late", "early", "middle"]) await admitSuspended(runtime, id);
        await runtime.executions.requestWake({ executionId: "late", wakeAt: clock.now + 30 });
        await runtime.executions.requestWake({ executionId: "early", wakeAt: clock.now + 10 });
        await runtime.executions.requestWake({ executionId: "middle", wakeAt: clock.now + 20 });
        advance(30);
        expect(await claim(runtime, 0)).toEqual([]);
        expect((await claim(runtime, 2)).map((lease) => lease.executionId)).toEqual([
          "early",
          "middle",
        ]);
        expect((await claim(runtime, 2)).map((lease) => lease.executionId)).toEqual(["late"]);
      });

      it("marks a claimed execution running", async ({ runtime }) => {
        await admit(runtime, "running");
        expect(await runtime.executions.get("running")).toMatchObject({ status: "admitted" });
        await claimOne(runtime, "running");
        expect(await runtime.executions.get("running")).toMatchObject({
          status: "running",
          unacknowledgedDeliveries: 0,
        });
      });

      it("makes an execution claimable with a higher token once its lease expires", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "expires");
        const first = await claimOne(runtime, "expires");
        advance(LEASE - 1);
        expect(await claim(runtime)).toEqual([]);
        expect(await runtime.executions.get("expires")).toMatchObject({ status: "running" });
        advance(REDELIVER_AFTER - LEASE + 1);
        const second = await claimOne(runtime, "expires");
        expect(second.token).toBeGreaterThan(first.token);
        // A worker that exits without replying leaves its lease to expire;
        // the execution is delivered again, and the expiry counts.
        expect(await runtime.executions.get("expires")).toMatchObject({
          status: "running",
          unacknowledgedDeliveries: 1,
        });
      });

      it("returns an expired lease's execution to admitted before any acknowledgement", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "never-acked");
        await claimOne(runtime, "never-acked");
        advance(LEASE);
        expect(await runtime.executions.get("never-acked")).toMatchObject({
          status: "admitted",
          unacknowledgedDeliveries: 1,
        });
      });

      it("returns an expired lease's execution to suspended after an earlier suspended delivery", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admitSuspended(runtime, "was-suspended");
        await runtime.executions.requestWake({ executionId: "was-suspended", wakeAt: clock.now });
        await claimOne(runtime, "was-suspended");
        advance(LEASE);
        expect(await runtime.executions.get("was-suspended")).toMatchObject({
          status: "suspended",
          unacknowledgedDeliveries: 1,
        });
      });

      it("keeps a renewed lease past its original expiry with one claim", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "long");
        let lease = await claimOne(runtime, "long");
        for (let i = 0; i < 5; i++) {
          advance(LEASE - 1);
          const renewed = await runtime.executions.renew({ lease, duration: LEASE });
          expect(renewed).toEqual({
            status: "renewed",
            lease: { executionId: "long", token: lease.token, expiresAt: clock.now + LEASE },
          });
          if (renewed.status !== "renewed") throw new Error("renewal lost");
          lease = renewed.lease;
          expect(await claim(runtime)).toEqual([]);
          expect(await runtime.executions.get("long")).toMatchObject({ status: "running" });
        }
        // Five lease periods later, the original claim still acknowledges.
        expect(
          await runtime.executions.acknowledge({
            lease,
            outcome: { status: "completed", result: "done" },
          })
        ).toEqual({ status: "completed", result: "done" });
        expect(await runtime.executions.get("long")).toMatchObject({
          status: "completed",
          unacknowledgedDeliveries: 0,
        });
      });

      it("returns lost when renewing with a stale token", async ({ runtime, advance }) => {
        await admit(runtime, "stale-renew");
        const stale = await claimOne(runtime, "stale-renew");
        advance(REDELIVER_AFTER);
        const current = await claimOne(runtime, "stale-renew");
        expect(await runtime.executions.renew({ lease: stale, duration: LEASE })).toEqual({
          status: "lost",
        });
        // The stale renewal did not extend the current lease.
        advance(LEASE);
        expect(await runtime.executions.get("stale-renew")).toMatchObject({
          status: "admitted",
        });
        expect(await runtime.executions.renew({ lease: current, duration: LEASE })).toMatchObject({
          status: "renewed",
        });
      });

      it("keeps an expired lease current until another claim issues a higher token", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "expired-unclaimed");
        const lease = await claimOne(runtime, "expired-unclaimed");
        advance(REDELIVER_AFTER * 3);
        expect(
          await runtime.heap.writeStep({
            lease,
            stepKey: "step",
            stepAttempt: 0,
            done: true,
            stepResponseJson: JSON.stringify({ value: 1 }),
          })
        ).toEqual({ stepResponseJson: JSON.stringify({ value: 1 }), meta: { attempt: 0, done: true } });
        const renewed = await runtime.executions.renew({ lease, duration: LEASE });
        expect(renewed).toEqual({
          status: "renewed",
          lease: { ...lease, expiresAt: clock.now + LEASE },
        });
        expect(await runtime.executions.get("expired-unclaimed")).toMatchObject({
          status: "running",
          unacknowledgedDeliveries: 0,
        });
        expect(await claim(runtime)).toEqual([]);
        expect(
          await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } })
        ).toEqual({ status: "suspended" });
      });

      it("makes a released execution claimable after the redelivery delay with a higher token", async ({
        runtime,
        advance,
      }) => {
        await admitSuspended(runtime, "released");
        const before = await runtime.executions.get("released");
        await runtime.executions.requestWake({ executionId: "released", wakeAt: START });
        const first = await claimOne(runtime, "released");
        expect(await runtime.executions.release({ lease: first })).toEqual({
          status: "released",
        });
        // Releasing acknowledges nothing: the status and outcome are unchanged.
        const released = await runtime.executions.get("released");
        expect(released).toMatchObject({ status: "suspended", unacknowledgedDeliveries: 1 });
        expect(released!.outcome).toBeUndefined();
        expect(released!.updatedAt).toBe(before!.updatedAt);
        // The released lease is no longer current.
        expect(await runtime.executions.release({ lease: first })).toEqual({ status: "lost" });
        expect(await runtime.executions.renew({ lease: first, duration: LEASE })).toEqual({
          status: "lost",
        });
        expect(
          await runtime.executions.acknowledge({ lease: first, outcome: { status: "suspended" } })
        ).toEqual({ status: "lost" });

        advance(redeliveryDelay(1) - 1);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        const second = await claimOne(runtime, "released");
        expect(second.token).toBeGreaterThan(first.token);
      });

      it("ends the lease on a suspended acknowledgement and makes the execution due at a wake requested during it", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "woken-during");
        const lease = await claimOne(runtime, "woken-during");
        await runtime.executions.requestWake({ executionId: "woken-during", wakeAt: clock.now + 50 });
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        expect(await runtime.executions.get("woken-during")).toMatchObject({
          status: "suspended",
        });
        expect(await runtime.executions.renew({ lease, duration: LEASE })).toEqual({
          status: "lost",
        });
        advance(49);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        const next = await claimOne(runtime, "woken-during");
        expect(next.token).toBeGreaterThan(lease.token);
      });

      it("ends the lease on a suspended acknowledgement and makes the execution due at wakeAt", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "wake-at");
        const lease = await claimOne(runtime, "wake-at");
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "suspended", wakeAt: clock.now + 70 },
        });
        expect(await runtime.executions.renew({ lease, duration: LEASE })).toEqual({
          status: "lost",
        });
        advance(69);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        await claimOne(runtime, "wake-at");
      });

      it("ends the lease on a suspended acknowledgement and leaves the execution not due without a wake", async ({
        runtime,
        advance,
      }) => {
        await admit(runtime, "not-due");
        const lease = await claimOne(runtime, "not-due");
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        expect(await runtime.executions.release({ lease })).toEqual({ status: "lost" });
        advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
        expect(await runtime.executions.get("not-due")).toMatchObject({
          status: "suspended",
          unacknowledgedDeliveries: 0,
        });
      });

      it("returns lost for a lease on an unknown execution", async ({ runtime }) => {
        const ghost: ExecutionLease = { executionId: "ghost", token: 1, expiresAt: START + LEASE };
        expect(await runtime.executions.renew({ lease: ghost, duration: LEASE })).toEqual({
          status: "lost",
        });
        expect(await runtime.executions.release({ lease: ghost })).toEqual({ status: "lost" });
        expect(
          await runtime.executions.acknowledge({ lease: ghost, outcome: { status: "suspended" } })
        ).toEqual({ status: "lost" });
        expect(
          await runtime.heap.writeStep({
            lease: ghost,
            stepKey: "step",
            stepAttempt: 0,
            done: true,
            stepResponseJson: "{}",
          })
        ).toEqual({ status: "lost" });
        expect(await runtime.executions.get("ghost")).toBeUndefined();
      });

      itAfterRestart("keeps leases and tokens across a restart", async ({
        runtime,
        advance,
        restart,
      }) => {
        await admit(runtime, "held");
        const held = await claimOne(runtime, "held");
        const restarted = await restart();
        expect(await restarted.executions.get("held")).toMatchObject({ status: "running" });
        expect(await claim(restarted)).toEqual([]);
        expect(await restarted.executions.renew({ lease: held, duration: LEASE })).toMatchObject({
          status: "renewed",
        });
        advance(REDELIVER_AFTER);
        const next = await claimOne(restarted, "held");
        expect(next.token).toBeGreaterThan(held.token);
        expect(await restarted.executions.release({ lease: held })).toEqual({ status: "lost" });
      });
    });

    describe("redelivery delay", () => {
      it("delays each redelivery after a release by a non-zero delay no shorter than the last", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "retrying");
        let lease = await claimOne(runtime, "retrying");
        let previousDelay = 0;
        for (let attempt = 1; attempt <= 6; attempt++) {
          await runtime.executions.release({ lease });
          expect(await runtime.executions.get("retrying")).toMatchObject({
            unacknowledgedDeliveries: attempt,
          });
          // Find when the execution becomes claimable again.
          const releasedAt = clock.now;
          let next: ExecutionLease[];
          while ((next = await claim(runtime)).length === 0) {
            advance(100);
            if (clock.now - releasedAt > 60 * 60_000) throw new Error("never redelivered");
          }
          const delay = clock.now - releasedAt;
          expect(delay).toBeGreaterThan(0);
          expect(delay).toBeGreaterThanOrEqual(previousDelay);
          previousDelay = delay;
          lease = next[0];
        }
      });

      it("counts both a release and a later expiry", async ({ runtime, advance }) => {
        await admit(runtime, "both");
        const released = await claimOne(runtime, "both");
        await runtime.executions.release({ lease: released });
        advance(redeliveryDelay(1));
        await claimOne(runtime, "both");
        advance(LEASE);
        expect(await runtime.executions.get("both")).toMatchObject({
          unacknowledgedDeliveries: 2,
        });
        // The expired lease's redelivery waits the second delay after expiry.
        advance(redeliveryDelay(2) - 1);
        expect(await claim(runtime)).toEqual([]);
        advance(1);
        await claimOne(runtime, "both");
        expect(await runtime.executions.get("both")).toMatchObject({
          unacknowledgedDeliveries: 2,
        });
      });

      it("resets the count on acknowledgement, so the next wake is not delayed", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "recovers");
        for (let i = 1; i <= 3; i++) {
          const lease = await claimOne(runtime, "recovers");
          await runtime.executions.release({ lease });
          advance(redeliveryDelay(i));
        }
        expect(await runtime.executions.get("recovers")).toMatchObject({
          unacknowledgedDeliveries: 3,
        });
        const lease = await claimOne(runtime, "recovers");
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        expect(await runtime.executions.get("recovers")).toMatchObject({
          status: "suspended",
          unacknowledgedDeliveries: 0,
        });
        await runtime.executions.requestWake({ executionId: "recovers", wakeAt: clock.now });
        await claimOne(runtime, "recovers");
      });

      it("holds wakes requested during the delay until it passes", async ({
        runtime,
        clock,
        advance,
      }) => {
        await admit(runtime, "held-back");
        const lease = await claimOne(runtime, "held-back");
        await runtime.executions.release({ lease });
        await runtime.executions.requestWake({ executionId: "held-back", wakeAt: clock.now });
        expect(await claim(runtime)).toEqual([]);
        advance(redeliveryDelay(1));
        await claimOne(runtime, "held-back");
      });
    });

    describe("fencing", () => {
      /** Claims, lets the lease expire, and claims again: returns both leases. */
      async function reclaim(
        ctx: { runtime: Runtime; advance(ms: number): void },
        executionId: string
      ) {
        const stale = await claimOne(ctx.runtime, executionId);
        ctx.advance(REDELIVER_AFTER);
        const current = await claimOne(ctx.runtime, executionId);
        expect(current.token).toBeGreaterThan(stale.token);
        return { stale, current };
      }

      function write(
        runtime: Runtime,
        lease: ExecutionLease,
        stepKey: string,
        value: unknown,
        options: { attempt?: number; done?: boolean } = {}
      ) {
        return runtime.heap.writeStep({
          lease,
          stepKey,
          stepAttempt: options.attempt ?? 0,
          done: options.done ?? true,
          stepResponseJson: JSON.stringify(value),
        });
      }

      it("rejects a stale holder's heap write after a reclaim and keeps the current records", async (ctx) => {
        const { runtime } = ctx;
        await admit(runtime, "stale-write");
        const { stale, current } = await reclaim(ctx, "stale-write");
        expect(await write(runtime, current, "charge", "current")).toMatchObject({
          stepResponseJson: JSON.stringify("current"),
        });
        expect(await write(runtime, stale, "charge", "stale")).toEqual({ status: "lost" });
        expect(await write(runtime, stale, "charge", "stale", { attempt: 1 })).toEqual({
          status: "lost",
        });
        expect(await write(runtime, stale, "other", "stale")).toEqual({ status: "lost" });
        expect(await runtime.heap.readStep({ executionId: "stale-write", stepKey: "charge" })).toEqual({
          stepResponseJson: JSON.stringify("current"),
          meta: { attempt: 0, done: true },
        });
        expect(
          await runtime.heap.readStep({ executionId: "stale-write", stepKey: "other" })
        ).toBeNull();
      });

      it("rejects a stale holder's acknowledgement after a reclaim and leaves the record unchanged", async (ctx) => {
        const { runtime } = ctx;
        await admitSuspended(runtime, "stale-ack");
        await runtime.executions.requestWake({ executionId: "stale-ack", wakeAt: ctx.clock.now });
        const { stale, current } = await reclaim(ctx, "stale-ack");
        const before = await runtime.executions.get("stale-ack");
        for (const outcome of [
          { status: "completed", result: "stale" },
          { status: "failed", error: new Error("stale") },
          { status: "suspended", wakeAt: ctx.clock.now },
        ] as const) {
          expect(await runtime.executions.acknowledge({ lease: stale, outcome })).toEqual({
            status: "lost",
          });
        }
        expect(await runtime.executions.get("stale-ack")).toEqual(before);
        expect(before).toMatchObject({ status: "running" });
        // The current holder's lease is intact.
        expect(
          await runtime.executions.acknowledge({
            lease: current,
            outcome: { status: "completed", result: "current" },
          })
        ).toEqual({ status: "completed", result: "current" });
      });

      it("rejects every fenced write from a holder that pauses past expiry after another claims", async (ctx) => {
        const { runtime } = ctx;
        await admit(runtime, "paused");
        const paused = await claimOne(runtime, "paused");
        expect(await write(runtime, paused, "before-pause", 1)).toMatchObject({
          meta: { attempt: 0, done: true },
        });
        ctx.advance(REDELIVER_AFTER);
        const peer = (await ctx.harness.createPeer?.()) ?? runtime;
        const current = await claimOne(peer, "paused");
        // The first holder resumes, unaware that time has passed.
        expect(await write(runtime, paused, "after-pause", 2)).toEqual({ status: "lost" });
        expect(await runtime.executions.renew({ lease: paused, duration: LEASE })).toEqual({
          status: "lost",
        });
        expect(await runtime.executions.release({ lease: paused })).toEqual({ status: "lost" });
        expect(
          await runtime.executions.acknowledge({
            lease: paused,
            outcome: { status: "completed", result: "paused" },
          })
        ).toEqual({ status: "lost" });
        // None of it disturbed the current holder.
        expect(await write(peer, current, "after-pause", 3)).toMatchObject({
          stepResponseJson: "3",
        });
        expect(await peer.executions.get("paused")).toMatchObject({ status: "running" });
      });

      it("accepts the current holder's rewrite of an existing step record without changing it", async ({
        runtime,
      }) => {
        await admit(runtime, "rewrite");
        const lease = await claimOne(runtime, "rewrite");
        const first = await write(runtime, lease, "charge", { receipt: "r-1" });
        const again = await write(runtime, lease, "charge", { receipt: "r-1" });
        expect(again).toEqual(first);
        expect(await runtime.heap.readStep({ executionId: "rewrite", stepKey: "charge" })).toEqual(
          first
        );
      });

      it("stores scalar step values as the exact JSON written, so rewrites match and falsy values replay", async ({
        runtime,
      }) => {
        await admit(runtime, "scalars");
        const lease = await claimOne(runtime, "scalars");
        for (const [stepKey, value] of [
          ["zero", 0],
          ["one", 1],
          ["float", 1.5],
          ["false", false],
          ["null", null],
          ["numeric-string", "1"],
        ] as const) {
          const record = {
            stepResponseJson: JSON.stringify(value),
            meta: { attempt: 0, done: true },
          };
          expect(await write(runtime, lease, stepKey, value)).toEqual(record);
          expect(await write(runtime, lease, stepKey, value)).toEqual(record);
          expect(await runtime.heap.readStep({ executionId: "scalars", stepKey })).toEqual(record);
        }
      });

      it("keeps an existing step record when the current holder writes a different value, and returns the recorded one", async ({
        runtime,
      }) => {
        await admit(runtime, "conflict");
        const lease = await claimOne(runtime, "conflict");
        await write(runtime, lease, "charge", { receipt: "r-1" });
        // The returned record holds the recorded value, so the caller can see
        // the conflict and end the delivery as a retry.
        expect(
          await write(runtime, lease, "charge", { receipt: "r-2" }, { done: false })
        ).toEqual({
          stepResponseJson: JSON.stringify({ receipt: "r-1" }),
          meta: { attempt: 0, done: true },
        });
        expect(await runtime.heap.readStep({ executionId: "conflict", stepKey: "charge" })).toEqual({
          stepResponseJson: JSON.stringify({ receipt: "r-1" }),
          meta: { attempt: 0, done: true },
        });
        // The next delivery replays the recorded value.
        await runtime.executions.release({ lease });
        expect(await runtime.heap.readStep({ executionId: "conflict", stepKey: "charge" })).toEqual({
          stepResponseJson: JSON.stringify({ receipt: "r-1" }),
          meta: { attempt: 0, done: true },
        });
      });

      it("keeps a waiter when a stale holder's step result would delete it", async (ctx) => {
        const { runtime } = ctx;
        await admitSuspended(runtime, "stale-waiter");
        const snapshot = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "stale-waiter",
          initial: { messages: [] },
        });
        const registered = waiter("stale-waiter", snapshot.instanceId, snapshot.version);
        await runtime.stores.registerWaiter(registered);
        await runtime.executions.requestWake({ executionId: "stale-waiter", wakeAt: ctx.clock.now });
        const { stale, current } = await reclaim(ctx, "stale-waiter");
        expect(
          await write(runtime, stale, registered.stepKey, { id: "m1" }, { attempt: 1 })
        ).toEqual({ status: "lost" });
        await runtime.executions.acknowledge({ lease: current, outcome: { status: "suspended" } });
        // The waiter survived, so a commit still wakes the execution.
        await appendMessage(runtime, "stale-waiter", "m1");
        expect(await claimedIds(runtime)).toEqual(["stale-waiter"]);
      });

      it("applies a stale holder's idempotent store update once and returns the recorded result to the current holder", async (ctx) => {
        const { runtime } = ctx;
        await admit(runtime, "store-receipt");
        await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "store-receipt",
          initial: { messages: [] },
        });
        const { stale, current } = await reclaim(ctx, "store-receipt");
        const stepId = { executionId: "store-receipt", stepKey: "append" };
        // Store updates are not fenced: the stale holder's commit applies.
        const staleResult = await runtime.stores.updateStore({
          definition: Store,
          id: "store-receipt",
          stepId,
          updater(draft) {
            draft.messages.push({ id: "stale" });
          },
        });
        const currentResult = await runtime.stores.updateStore({
          definition: Store,
          id: "store-receipt",
          stepId,
          updater(draft) {
            draft.messages.push({ id: "current" });
          },
        });
        expect(currentResult).toEqual(staleResult);
        expect(
          await runtime.stores.getStore({ definition: Store, id: "store-receipt" })
        ).toMatchObject({ state: { messages: [{ id: "stale" }] }, version: 1 });
        // Only the current holder records the step that returns the receipt.
        expect(await write(runtime, stale, "append", staleResult)).toEqual({ status: "lost" });
        expect(await write(runtime, current, "append", currentResult)).toMatchObject({
          meta: { done: true },
        });
      });

      it("lets a stale holder's wake cause at most one extra delivery and leaves the outcome unchanged", async (ctx) => {
        const { runtime } = ctx;
        await admit(runtime, "stale-wake");
        const { current } = await reclaim(ctx, "stale-wake");
        await runtime.executions.acknowledge({ lease: current, outcome: { status: "suspended" } });
        // The stale holder requests a wake (unfenced).
        await runtime.executions.requestWake({ executionId: "stale-wake", wakeAt: ctx.clock.now });
        const extra = await claimOne(runtime, "stale-wake");
        // Replay absorbs it: the extra delivery suspends again.
        await runtime.executions.acknowledge({ lease: extra, outcome: { status: "suspended" } });
        ctx.advance(REDELIVER_AFTER * 10);
        expect(await claim(runtime)).toEqual([]);
        expect(await runtime.executions.get("stale-wake")).toMatchObject({
          status: "suspended",
          unacknowledgedDeliveries: 0,
        });

        // Against a terminal execution, a stale wake is ignored.
        await admit(runtime, "stale-wake-done");
        const done = await reclaim(ctx, "stale-wake-done");
        await runtime.executions.acknowledge({
          lease: done.current,
          outcome: { status: "completed", result: "ok" },
        });
        expect(
          await runtime.executions.requestWake({
            executionId: "stale-wake-done",
            wakeAt: ctx.clock.now,
          })
        ).toEqual({ status: "ignored" });
        expect(await claim(runtime)).toEqual([]);
      });
    });

    describe("durability", () => {
      itAfterRestart("preserves admitted and suspended records and their pending wakes across a restart", async ({ runtime, clock, advance, restart }) => {
        await admit(runtime, "delayed");
        const delayed = await claimOne(runtime, "delayed");
        await runtime.executions.acknowledge({
          lease: delayed,
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

        const restarted = await restart();
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

        // Restarting does not lose a lease: the in-flight delivery's execution
        // is claimable only once its lease expires and the delay passes.
        expect(await drain(restarted)).toEqual(["admitted"]);
        advance(200);
        expect(await drain(restarted)).toEqual(["woken"]);
        advance(300);
        expect(await drain(restarted)).toEqual(["delayed"]);
        advance(REDELIVER_AFTER - 500 - 1);
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
        const restarted = await restart();
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
        const restarted = await restart();
        await appendMessage(restarted, "durable-waiter", "m1");
        expect(await claimedIds(restarted)).toEqual(["durable-waiter"]);
      });
    });
  });
}
