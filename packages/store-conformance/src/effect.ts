import {
  DEFAULT_LEASE_DURATION,
  EffectClientInvariantError,
  redeliveryDelay,
  registerErrorClass,
  type DurableObject,
  type DurableValue,
  type EffectBeginResult,
  type ExecutionLease,
  type Runtime,
} from "@yieldstar/core";
import { describe, expect, test } from "vitest";

export type EffectConformanceHarnessOptions = {
  /** The suite's clock. Construct the runtime with it. */
  clock: () => number;
};

/** A clean runtime under test, built on the suite's clock. */
export type EffectConformanceHarness = {
  runtime: Runtime;
  /**
   * Creates another runtime sharing the same backend, as another process
   * would. Race cases fall back to `runtime` when it is absent.
   */
  createPeer?(): Runtime | Promise<Runtime>;
  /** Opens the same durable backend in a new runtime, as after a restart. */
  restart?(): Runtime | Promise<Runtime>;
  /**
   * Makes every `watch` on `runtime` fail after it begins writing but before
   * it commits, until the returned function is called. Without it, the case
   * for a failure before a watch commits is skipped.
   */
  failEffectWatches?():
    | (() => void | Promise<void>)
    | Promise<() => void | Promise<void>>;
  dispose?(): void | Promise<void>;
};

export type EffectConformanceOptions = {
  name: string;
  create(
    options: EffectConformanceHarnessOptions
  ): EffectConformanceHarness | Promise<EffectConformanceHarness>;
};

const START = 1_000_000;

const LEASE = DEFAULT_LEASE_DURATION;

/** How long after a claim an unacknowledged lease's execution is claimable again. */
const REDELIVER_AFTER = LEASE + redeliveryDelay(1);

const OPERATION = "charge-v1";

type TestContext = {
  runtime: Runtime;
  peer: Runtime;
  harness: EffectConformanceHarness;
  clock: { now: number };
  advance(ms: number): void;
};

class CardDeclinedError extends Error {
  code = "CARD_DECLINED";
  declineCode: string;
  constructor(declineCode: string) {
    super(`Card declined: ${declineCode}`);
    this.name = "ConformanceCardDeclinedError";
    this.declineCode = declineCode;
  }
}
registerErrorClass("ConformanceCardDeclinedError", CardDeclinedError);

/**
 * Registers the runtime-adapter suite for `EffectClient` and the wakes it
 * requests (RFC 005).
 */
export function registerEffectClientConformance({
  name,
  create,
}: EffectConformanceOptions): void {
  async function setup(): Promise<TestContext> {
    const clock = { now: START };
    const harness = await create({ clock: () => clock.now });
    const peer = (await harness.createPeer?.()) ?? harness.runtime;
    return {
      runtime: harness.runtime,
      peer,
      harness,
      clock,
      advance(ms) {
        clock.now += ms;
      },
    };
  }

  function it(
    title: string,
    fn: (ctx: TestContext, testContext: { skip(): void }) => Promise<void>
  ) {
    test(title, async (testContext) => {
      const ctx = await setup();
      try {
        await fn(ctx, testContext);
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

  function claim(runtime: Runtime) {
    return runtime.executions.claimDue({ limit: 100, duration: LEASE });
  }

  async function claimOne(runtime: Runtime, executionId: string) {
    const leases = await claim(runtime);
    expect(leases.map((lease) => lease.executionId)).toEqual([executionId]);
    return leases[0];
  }

  async function claimedIds(runtime: Runtime) {
    return (await claim(runtime)).map((lease) => lease.executionId).sort();
  }

  /** Admits an execution and acknowledges its admission delivery as suspended. */
  async function admitSuspended(runtime: Runtime, executionId: string) {
    const admitted = await runtime.executions.admit({
      executionId,
      workflowId: "charge-order",
      params: { executionId },
      context: new Map(),
    });
    expect(admitted).toEqual({ status: "accepted", executionId });
    const lease = await claimOne(runtime, executionId);
    await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
    return executionId;
  }

  /** Claims, lets the lease expire, and claims again: returns both leases. */
  async function reclaim(ctx: TestContext, executionId: string) {
    const stale = await claimOne(ctx.runtime, executionId);
    ctx.advance(REDELIVER_AFTER);
    const current = await claimOne(ctx.peer, executionId);
    expect(current.token).toBeGreaterThan(stale.token);
    return { stale, current };
  }

  function begin(
    runtime: Runtime,
    effectId: string,
    options: {
      operation?: string;
      input?: DurableObject;
      executionId?: string;
      stepKey?: string;
    } = {}
  ) {
    return runtime.effects.begin({
      effectId,
      operation: options.operation ?? OPERATION,
      input: "input" in options ? options.input! : { amount: 4999, currency: "usd" },
      executionId: options.executionId ?? "order-42",
      stepKey: options.stepKey ?? "charge",
    });
  }

  function settle(
    runtime: Runtime,
    effectId: string,
    result: DurableValue,
    operation = OPERATION
  ) {
    return runtime.effects.settle({ effectId, operation, result });
  }

  function watch(runtime: Runtime, effectId: string, executionId: string, stepKey = "charge") {
    return runtime.effects.watch({ effectId, executionId, stepKey });
  }

  /** Records the step's result under `lease`, as the driver does. */
  function recordStep(
    runtime: Runtime,
    lease: ExecutionLease,
    options: { stepKey?: string; attempt?: number; done?: boolean } = {}
  ) {
    return runtime.heap.writeStep({
      lease,
      stepKey: options.stepKey ?? "charge",
      stepAttempt: options.attempt ?? 1,
      done: options.done ?? true,
      stepResponseJson: JSON.stringify({ paymentId: "pay_1" }),
    });
  }

  async function expectInvariant(promise: Promise<unknown>) {
    const error = await promise.then(
      () => {
        throw new Error("expected an EffectClientInvariantError");
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(EffectClientInvariantError);
    expect((error as EffectClientInvariantError).code).toBe("EFFECT_RUNTIME_INVARIANT");
  }

  describe(`${name} effect client conformance`, () => {
    describe("begin", () => {
      it("creates one pending effect and returns its current state to repeated matching calls", async ({
        runtime,
        peer,
      }) => {
        expect(await runtime.effects.getEffect("pay:42")).toBeUndefined();
        expect(await begin(runtime, "pay:42")).toEqual({ status: "new" });
        expect(await runtime.effects.getEffect("pay:42")).toEqual({
          effectId: "pay:42",
          operation: OPERATION,
          input: { amount: 4999, currency: "usd" },
          status: "pending",
          conflicts: [],
        });

        expect(await begin(runtime, "pay:42")).toEqual({ status: "pending" });
        expect(await begin(peer, "pay:42")).toEqual({ status: "pending" });
        // The effect ID, not the caller, identifies the effect.
        expect(
          await begin(runtime, "pay:42", { executionId: "support", stepKey: "check" })
        ).toEqual({ status: "pending" });

        await settle(runtime, "pay:42", { paymentId: "pay_1" });
        expect(await begin(peer, "pay:42")).toEqual({
          status: "settled",
          result: { paymentId: "pay_1" },
        });
      });

      it("creates one effect for concurrent begins with one effect ID", async ({
        runtime,
        peer,
      }) => {
        const results = await Promise.all([
          begin(runtime, "pay:race"),
          begin(peer, "pay:race"),
          begin(runtime, "pay:race"),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual([
          "new",
          "pending",
          "pending",
        ]);
        expect(await runtime.effects.getEffect("pay:race")).toMatchObject({
          status: "pending",
        });
      });

      it("matches input whose keys are in a different order", async ({ runtime }) => {
        await begin(runtime, "pay:keys", { input: { a: 1, b: { c: 2, d: 3 } } });
        expect(
          await begin(runtime, "pay:keys", { input: { b: { d: 3, c: 2 }, a: 1 } })
        ).toEqual({ status: "pending" });
      });

      it("rejects a changed operation or input without changing the effect", async ({
        runtime,
        peer,
      }) => {
        const mismatch: EffectBeginResult = {
          status: "rejected",
          code: "EFFECT_REQUEST_MISMATCH",
        };
        await begin(runtime, "pay:changed");
        const before = await runtime.effects.getEffect("pay:changed");

        expect(await begin(runtime, "pay:changed", { operation: "charge-v2" })).toEqual(
          mismatch
        );
        expect(
          await begin(peer, "pay:changed", { input: { amount: 5999, currency: "usd" } })
        ).toEqual(mismatch);
        // An undefined property is part of the canonical input.
        expect(
          await begin(runtime, "pay:changed", {
            input: { amount: 4999, currency: "usd", note: undefined },
          })
        ).toEqual(mismatch);
        expect(await runtime.effects.getEffect("pay:changed")).toEqual(before);

        await settle(runtime, "pay:changed", { paymentId: "pay_1" });
        const settled = await runtime.effects.getEffect("pay:changed");
        expect(await begin(runtime, "pay:changed", { operation: "charge-v2" })).toEqual(
          mismatch
        );
        expect(await runtime.effects.getEffect("pay:changed")).toEqual(settled);
      });

      test.each([
        ["an empty effect ID", { effectId: "" }],
        ["an empty operation", { operation: "" }],
        ["array input", { input: [] }],
        ["a Date in the input", { input: { at: new Date(0) } }],
        ["a non-finite number in the input", { input: { amount: Number.NaN } }],
        ["an empty execution ID", { executionId: "" }],
        ["an empty step key", { stepKey: "" }],
      ] as const)(
        "throws EffectClientInvariantError for %s and creates nothing",
        async (_label, override) => {
          const ctx = await setup();
          try {
            const request = {
              effectId: "pay:invalid",
              operation: OPERATION,
              input: { amount: 4999 },
              executionId: "order-42",
              stepKey: "charge",
              ...override,
            };
            await expectInvariant(ctx.runtime.effects.begin(request as never));
            expect(await ctx.runtime.effects.getEffect("pay:invalid")).toBeUndefined();
          } finally {
            await ctx.harness.dispose?.();
          }
        }
      );
    });

    describe("settle", () => {
      it("settles a pending effect and returns its result", async ({ runtime }) => {
        await begin(runtime, "pay:settle");
        expect(await settle(runtime, "pay:settle", { paymentId: "pay_1" })).toEqual({
          status: "settled",
          result: { paymentId: "pay_1" },
        });
        expect(await runtime.effects.getEffect("pay:settle")).toEqual({
          effectId: "pay:settle",
          operation: OPERATION,
          input: { amount: 4999, currency: "usd" },
          status: "settled",
          result: { paymentId: "pay_1" },
          conflicts: [],
        });
      });

      it("keeps one settled result when equal results settle concurrently", async ({
        runtime,
        peer,
      }) => {
        await begin(runtime, "pay:equal");
        const results = await Promise.all([
          settle(runtime, "pay:equal", { paymentId: "pay_1", fee: 30 }),
          settle(peer, "pay:equal", { fee: 30, paymentId: "pay_1" }),
          settle(runtime, "pay:equal", { paymentId: "pay_1", fee: 30 }),
        ]);
        for (const result of results) {
          expect(result).toEqual({
            status: "settled",
            result: { paymentId: "pay_1", fee: 30 },
          });
        }
        expect(await runtime.effects.getEffect("pay:equal")).toMatchObject({
          status: "settled",
          result: { paymentId: "pay_1", fee: 30 },
          conflicts: [],
        });
      });

      it("keeps the first result and one conflict report when a different result settles", async ({
        runtime,
        peer,
        clock,
        advance,
      }) => {
        await begin(runtime, "pay:conflict");
        await settle(runtime, "pay:conflict", { paymentId: "pay_1" });
        advance(10);
        const reportedAt = clock.now;
        const conflict = {
          status: "conflict",
          result: { paymentId: "pay_1" },
          conflictingResult: { paymentId: "pay_2" },
        };
        expect(await settle(peer, "pay:conflict", { paymentId: "pay_2" })).toEqual(conflict);

        // A conflicting settlement repeated after a lost response adds no report.
        advance(10);
        expect(await settle(runtime, "pay:conflict", { paymentId: "pay_2" })).toEqual(
          conflict
        );
        expect(await settle(runtime, "pay:conflict", { paymentId: "pay_1" })).toEqual({
          status: "settled",
          result: { paymentId: "pay_1" },
        });
        expect(await begin(runtime, "pay:conflict")).toEqual({
          status: "settled",
          result: { paymentId: "pay_1" },
        });
        expect(await runtime.effects.getEffect("pay:conflict")).toMatchObject({
          status: "settled",
          result: { paymentId: "pay_1" },
          conflicts: [
            {
              result: { paymentId: "pay_1" },
              conflictingResult: { paymentId: "pay_2" },
              reportedAt,
            },
          ],
        });
      });

      it("settles once when different results settle concurrently", async ({
        runtime,
        peer,
      }) => {
        await begin(runtime, "pay:race");
        const results = await Promise.all([
          settle(runtime, "pay:race", "first"),
          settle(peer, "pay:race", "second"),
        ]);
        const settled = results.filter((result) => result.status === "settled");
        const conflicts = results.filter((result) => result.status === "conflict");
        expect(settled).toHaveLength(1);
        expect(conflicts).toHaveLength(1);
        const winner = settled[0].result;
        const loser = winner === "first" ? "second" : "first";
        expect(conflicts[0]).toEqual({
          status: "conflict",
          result: winner,
          conflictingResult: loser,
        });
        const record = await runtime.effects.getEffect("pay:race");
        expect(record?.result).toBe(winner);
        expect(record?.conflicts).toEqual([
          { result: winner, conflictingResult: loser, reportedAt: START },
        ]);
      });

      it("stores undefined, errors and error-shaped objects without changing their type", async ({
        runtime,
      }) => {
        await begin(runtime, "delete:1");
        expect(await settle(runtime, "delete:1", undefined)).toEqual({
          status: "settled",
          result: undefined,
        });
        const deleted = await runtime.effects.getEffect("delete:1");
        expect(deleted?.status).toBe("settled");
        expect("result" in deleted!).toBe(true);
        expect(deleted?.result).toBeUndefined();
        expect(await begin(runtime, "delete:1")).toEqual({
          status: "settled",
          result: undefined,
        });

        const result = {
          declined: new CardDeclinedError("insufficient_funds"),
          report: { name: "Error", message: "not an error" },
          tagged: { $type: "undefined" },
          missing: undefined,
        };
        await begin(runtime, "pay:values", {
          input: { amount: 4999, note: undefined, shaped: { name: "E", message: "m" } },
        });
        await settle(runtime, "pay:values", result);

        const begun = await begin(runtime, "pay:values", {
          input: { amount: 4999, note: undefined, shaped: { name: "E", message: "m" } },
        });
        const record = await runtime.effects.getEffect("pay:values");
        for (const stored of [
          (begun as unknown as { result: typeof result }).result,
          record!.result as typeof result,
        ]) {
          expect(stored.declined).toBeInstanceOf(CardDeclinedError);
          expect(stored.declined.message).toBe("Card declined: insufficient_funds");
          expect(stored.declined.code).toBe("CARD_DECLINED");
          expect(stored.declined.declineCode).toBe("insufficient_funds");
          expect(stored.report).not.toBeInstanceOf(Error);
          expect(stored.report).toEqual({ name: "Error", message: "not an error" });
          expect(stored.tagged).toEqual({ $type: "undefined" });
          expect(Object.keys(stored)).toContain("missing");
        }
        expect(record!.input.shaped).not.toBeInstanceOf(Error);
        expect(Object.keys(record!.input)).toContain("note");
      });

      it("throws EffectClientInvariantError for an unknown effect, a changed operation or an invalid result", async ({
        runtime,
      }) => {
        await expectInvariant(settle(runtime, "pay:unknown", "result"));
        expect(await runtime.effects.getEffect("pay:unknown")).toBeUndefined();

        await begin(runtime, "pay:invariant");
        await expectInvariant(settle(runtime, "pay:invariant", "result", "charge-v2"));
        await expectInvariant(
          settle(runtime, "pay:invariant", { at: new Date(0) } as never)
        );
        expect(await runtime.effects.getEffect("pay:invariant")).toMatchObject({
          status: "pending",
        });
      });
    });

    describe("watch and wakes", () => {
      it("wakes every watching execution when the settlement commits", async ({
        runtime,
        peer,
      }) => {
        await admitSuspended(runtime, "order-42");
        await admitSuspended(runtime, "support");
        await begin(runtime, "pay:watched");
        await watch(runtime, "pay:watched", "order-42");
        await watch(peer, "pay:watched", "support", "check");

        // A watch requests no wake of its own.
        expect(await claim(runtime)).toEqual([]);
        await settle(peer, "pay:watched", { paymentId: "pay_1" });
        expect(await claimedIds(runtime)).toEqual(["order-42", "support"]);
      });

      it("registers nothing when a watch fails before it commits, and a repeat succeeds as a first call", async (
        { runtime, harness },
        testContext
      ) => {
        if (!harness.failEffectWatches) {
          testContext.skip();
          return;
        }
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:failed");
        await begin(runtime, "pay:retried");
        const restore = await harness.failEffectWatches();
        try {
          await expect(watch(runtime, "pay:failed", "order-42")).rejects.toThrow();
          await expect(watch(runtime, "pay:retried", "order-42")).rejects.toThrow();
        } finally {
          await restore();
        }

        await settle(runtime, "pay:failed", "done");
        expect(await claim(runtime)).toEqual([]);

        await watch(runtime, "pay:retried", "order-42");
        expect(await claim(runtime)).toEqual([]);
        await settle(runtime, "pay:retried", "done");
        expect(await claimedIds(runtime)).toEqual(["order-42"]);
      });

      it("keeps one registration when a watch is repeated after a lost response", async ({
        runtime,
        peer,
      }) => {
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:repeated");
        await watch(runtime, "pay:repeated", "order-42");
        await watch(peer, "pay:repeated", "order-42");
        await watch(runtime, "pay:repeated", "order-42");

        // Recording the step's result deletes the one registration.
        await runtime.executions.requestWake({
          executionId: "order-42",
          wakeAt: START,
        });
        const lease = await claimOne(runtime, "order-42");
        await recordStep(runtime, lease);
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });

        await settle(runtime, "pay:repeated", "done");
        expect(await claim(runtime)).toEqual([]);
      });

      it("wakes the execution at once when the effect is already settled, on every watch", async ({
        runtime,
      }) => {
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:settled");
        await settle(runtime, "pay:settled", "done");

        await watch(runtime, "pay:settled", "order-42");
        const lease = await claimOne(runtime, "order-42");
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
        expect(await claim(runtime)).toEqual([]);

        // A repeated watch is never skipped as a duplicate.
        await watch(runtime, "pay:settled", "order-42");
        expect(await claimedIds(runtime)).toEqual(["order-42"]);
      });

      it("wakes the watching execution when settlement races with watch", async ({
        runtime,
        peer,
      }) => {
        for (let i = 0; i < 10; i++) {
          const executionId = `racer-${i}`;
          const effectId = `pay:race-${i}`;
          await admitSuspended(runtime, executionId);
          await begin(runtime, effectId);
          const watching = watch(i % 2 ? runtime : peer, effectId, executionId);
          const settling = settle(i % 2 ? peer : runtime, effectId, "done");
          await Promise.all(i % 4 < 2 ? [watching, settling] : [settling, watching]);
          expect(await claimedIds(runtime)).toEqual([executionId]);
        }
      });

      it("deletes a waiter in the write that records its step's result, so a later settlement does not wake", async ({
        runtime,
      }) => {
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:recorded");
        await begin(runtime, "pay:other");
        await watch(runtime, "pay:recorded", "order-42", "charge");
        await watch(runtime, "pay:other", "order-42", "refund");

        // An unfinished attempt keeps the waiter.
        await runtime.executions.requestWake({ executionId: "order-42", wakeAt: START });
        const unfinished = await claimOne(runtime, "order-42");
        await recordStep(runtime, unfinished, { attempt: 1, done: false });
        await runtime.executions.acknowledge({
          lease: unfinished,
          outcome: { status: "suspended" },
        });

        await runtime.executions.requestWake({ executionId: "order-42", wakeAt: START });
        const lease = await claimOne(runtime, "order-42");
        await recordStep(runtime, lease, { attempt: 2 });
        await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });

        await settle(runtime, "pay:recorded", "done");
        expect(await claim(runtime)).toEqual([]);

        // Another step's waiter is unaffected.
        await settle(runtime, "pay:other", "done");
        expect(await claimedIds(runtime)).toEqual(["order-42"]);
      });

      it("keeps the waiter when a stale holder's step result is rejected", async (ctx) => {
        const { runtime } = ctx;
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:stale");
        await watch(runtime, "pay:stale", "order-42");
        await runtime.executions.requestWake({ executionId: "order-42", wakeAt: START });
        const { stale, current } = await reclaim(ctx, "order-42");

        expect(await recordStep(runtime, stale)).toEqual({ status: "lost" });
        await ctx.peer.executions.acknowledge({
          lease: current,
          outcome: { status: "suspended" },
        });

        await settle(runtime, "pay:stale", "done");
        expect(await claimedIds(runtime)).toEqual(["order-42"]);
      });

      it("settles without waking a terminal execution", async ({ runtime }) => {
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:terminal");
        await watch(runtime, "pay:terminal", "order-42");
        await runtime.executions.requestWake({ executionId: "order-42", wakeAt: START });
        const lease = await claimOne(runtime, "order-42");
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "completed", result: null },
        });

        expect(await settle(runtime, "pay:terminal", "done")).toEqual({
          status: "settled",
          result: "done",
        });
        expect(await claim(runtime)).toEqual([]);
        expect(await runtime.executions.get("order-42")).toMatchObject({
          status: "completed",
        });
      });

      it("throws EffectClientInvariantError when watching an unknown effect", async ({
        runtime,
      }) => {
        await admitSuspended(runtime, "order-42");
        await expectInvariant(watch(runtime, "pay:unknown", "order-42"));
        await begin(runtime, "pay:unknown");
        await settle(runtime, "pay:unknown", "done");
        expect(await claim(runtime)).toEqual([]);
      });
    });

    describe("getEffect", () => {
      it("returns the first result and the conflict report after a conflicting settlement", async ({
        runtime,
        peer,
      }) => {
        await begin(runtime, "pay:report");
        await settle(runtime, "pay:report", { paymentId: "pay_1" });
        await settle(runtime, "pay:report", { paymentId: "pay_2" });
        await settle(runtime, "pay:report", { paymentId: "pay_3" });
        expect(await peer.effects.getEffect("pay:report")).toEqual({
          effectId: "pay:report",
          operation: OPERATION,
          input: { amount: 4999, currency: "usd" },
          status: "settled",
          result: { paymentId: "pay_1" },
          conflicts: [
            {
              result: { paymentId: "pay_1" },
              conflictingResult: { paymentId: "pay_2" },
              reportedAt: START,
            },
            {
              result: { paymentId: "pay_1" },
              conflictingResult: { paymentId: "pay_3" },
              reportedAt: START,
            },
          ],
        });
      });

      it("returns a copy that callers cannot use to change the record", async ({
        runtime,
      }) => {
        const input = { amount: 4999, nested: { currency: "usd" } };
        await begin(runtime, "pay:copy", { input });
        input.nested.currency = "eur";
        const record = await runtime.effects.getEffect("pay:copy");
        (record!.input.nested as { currency: string }).currency = "gbp";
        expect((await runtime.effects.getEffect("pay:copy"))!.input).toEqual({
          amount: 4999,
          nested: { currency: "usd" },
        });
      });
    });

    describe("durability", () => {
      itAfterRestart("resumes delivery of stored wakes after a restart", async ({
        runtime,
        restart,
      }) => {
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:wake");
        await watch(runtime, "pay:wake", "order-42");
        await settle(runtime, "pay:wake", "done");

        const restarted = await restart();
        expect(await claimedIds(restarted)).toEqual(["order-42"]);
      });

      itAfterRestart("keeps effects, conflict reports and waiters across a restart", async ({
        runtime,
        restart,
      }) => {
        await admitSuspended(runtime, "order-42");
        await begin(runtime, "pay:pending");
        await watch(runtime, "pay:pending", "order-42");
        await begin(runtime, "pay:conflict");
        await settle(runtime, "pay:conflict", "first");
        await settle(runtime, "pay:conflict", "second");
        const conflicted = await runtime.effects.getEffect("pay:conflict");

        const restarted = await restart();
        expect(await restarted.effects.getEffect("pay:conflict")).toEqual(conflicted);
        expect(await begin(restarted, "pay:pending")).toEqual({ status: "pending" });
        expect(await claim(restarted)).toEqual([]);
        await settle(restarted, "pay:pending", "done");
        expect(await claimedIds(restarted)).toEqual(["order-42"]);
      });
    });
  });
}
