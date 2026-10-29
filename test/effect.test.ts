import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Logger } from "pino";
import {
  DEFAULT_LEASE_DURATION,
  EffectClientInvariantError,
  EffectDeliveryError,
  InfrastructureError,
  LeaseLostError,
  WorkflowRunner,
  type ExecutionLease,
  type WorkflowRouter,
} from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/test-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import {
  WorkflowEffectError,
  registerErrorClass,
  workflow,
  type EffectDescriptor,
  type EffectLookup,
} from "yieldstar";

afterEach(() => {
  vi.restoreAllMocks();
});

type Descriptor = EffectDescriptor<any, any>;

const EFFECT_ID = "acct-1:charge:order-42";

/**
 * A payment provider that keeps the external system contract: one charge per
 * effect ID, `not-found` only when no charge exists, and a stable result.
 */
function fakeProvider(log: string[]) {
  const charges = new Map<string, unknown>();
  return {
    charges,
    lookup: vi.fn(async (effectId: string): Promise<EffectLookup<any>> => {
      log.push("lookup");
      return charges.has(effectId)
        ? { status: "settled", result: charges.get(effectId) }
        : { status: "not-found" };
    }),
    perform: vi.fn(async (effectId: string): Promise<any> => {
      log.push("perform");
      if (!charges.has(effectId)) {
        charges.set(effectId, { chargeId: `ch-${charges.size + 1}`, amount: 4999 });
      }
      return charges.get(effectId);
    }),
  };
}

/**
 * One `charge-order` workflow whose effect step is keyed "charge", over a
 * memory runtime with a hand-driven clock. `log` records every client call,
 * callback and heap write in order; `effect` can be replaced per test.
 */
function setup(overrides: Partial<Descriptor> = {}) {
  let now = 1_000;
  const log: string[] = [];
  const caught: unknown[] = [];
  const warn = vi.fn();
  const logger = { info() {}, error() {}, warn } as unknown as Logger;
  const provider = fakeProvider(log);
  const effect: Descriptor = {
    effectId: EFFECT_ID,
    operation: "charge-v1",
    input: { amount: 4999 },
    retryIn: 60_000,
    lookup: (effectId) => provider.lookup(effectId),
    perform: (effectId) => provider.perform(effectId),
    ...overrides,
  };
  const router = {
    "charge-order": workflow(async function* (step) {
      let payment: unknown;
      try {
        payment = yield* step.effect("charge", effect);
      } catch (err) {
        caught.push(err);
        payment = "caught";
      }
      yield* step.run("ship", () => {
        log.push("ship");
        return "shipped";
      });
      return payment as any;
    }),
  } satisfies WorkflowRouter;

  const runtime = new MemoryRuntime({ clock: () => now });
  const runner = new WorkflowRunner(runtime, { router, logger });
  const invoker = createWorkflowInvoker({ runner, logger });

  const begin = runtime.effects.begin.bind(runtime.effects);
  const settle = runtime.effects.settle.bind(runtime.effects);
  const watch = runtime.effects.watch.bind(runtime.effects);
  const writeStep = runtime.heap.writeStep.bind(runtime.heap);
  const spies = {
    begin: vi.spyOn(runtime.effects, "begin").mockImplementation(async (request) => {
      log.push("begin");
      return begin(request);
    }),
    settle: vi.spyOn(runtime.effects, "settle").mockImplementation(async (request) => {
      log.push("settle");
      return settle(request);
    }),
    watch: vi.spyOn(runtime.effects, "watch").mockImplementation(async (request) => {
      log.push("watch");
      return watch(request);
    }),
    writeStep: vi.spyOn(runtime.heap, "writeStep").mockImplementation(async (request) => {
      log.push(`write:${request.stepKey}:${request.done ? "done" : "unfinished"}`);
      return writeStep(request);
    }),
  };
  const real = { begin, settle, watch, writeStep };

  let lease: ExecutionLease | undefined;
  async function deliver(signal = new AbortController().signal) {
    if (!lease) {
      await runtime.executions.admit({
        workflowId: "charge-order",
        executionId: "order-42",
        params: undefined,
        context: new Map(),
      });
      [lease] = await runtime.executions.claimDue({
        limit: 1,
        duration: DEFAULT_LEASE_DURATION,
      });
    }
    return invoker.deliver(
      {
        workflowId: "charge-order",
        executionId: "order-42",
        params: undefined,
        context: new Map(),
      },
      { lease: lease!, signal }
    );
  }

  const readStep = async (stepKey: string) => {
    const record = await runtime.heap.readStep({ executionId: "order-42", stepKey });
    return record && { ...JSON.parse(record.stepResponseJson), done: record.meta.done };
  };

  /** Creates the effect from another execution, as an earlier attempt would. */
  const beginElsewhere = (input: Descriptor["input"] = effect.input, operation = effect.operation) =>
    real.begin({
      effectId: EFFECT_ID,
      operation,
      input,
      executionId: "support-tool",
      stepKey: "charge",
    });

  return {
    runtime,
    effect,
    provider,
    log,
    caught,
    warn,
    spies,
    real,
    deliver,
    readStep,
    beginElsewhere,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

/** The `EffectDeliveryError` code with which a delivery was rejected. */
async function deliveryCode(delivery: Promise<unknown>) {
  const err = await delivery.then(
    () => {
      throw new Error("expected the delivery to reject");
    },
    (err: unknown) => err
  );
  expect(InfrastructureError.is(err)).toBe(true);
  const cause = (err as Error).cause;
  expect(cause).toBeInstanceOf(EffectDeliveryError);
  return (cause as EffectDeliveryError).code;
}

describe("workflow driver", () => {
  test("a new effect runs begin, perform and settle in order, and replay makes no call", async () => {
    const { deliver, log, readStep, spies, provider } = setup();

    await expect(deliver()).resolves.toEqual({
      status: "completed",
      result: { chargeId: "ch-1", amount: 4999 },
    });
    expect(log).toEqual([
      "begin",
      "perform",
      "settle",
      "write:charge:done",
      "ship",
      "write:ship:done",
      "write:$$workflow-result$$:done",
    ]);
    expect(spies.begin).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      operation: "charge-v1",
      input: { amount: 4999 },
      executionId: "order-42",
      stepKey: "charge",
    });
    expect(provider.perform).toHaveBeenCalledWith(EFFECT_ID);
    expect(await readStep("charge")).toMatchObject({
      type: "step-result",
      result: { chargeId: "ch-1", amount: 4999 },
      done: true,
    });

    log.length = 0;
    await expect(deliver()).resolves.toMatchObject({ status: "completed" });
    expect(log).toEqual([]);
  });

  test("a pending effect with not-found runs begin, lookup, perform and settle in order", async () => {
    const { deliver, log, beginElsewhere } = setup();
    await beginElsewhere();

    await expect(deliver()).resolves.toMatchObject({
      status: "completed",
      result: { chargeId: "ch-1" },
    });
    expect(log.slice(0, 5)).toEqual([
      "begin",
      "lookup",
      "perform",
      "settle",
      "write:charge:done",
    ]);
  });

  test("an already-settled effect runs no callback and records the settled result", async () => {
    const { deliver, log, beginElsewhere, real, readStep } = setup();
    await beginElsewhere();
    await real.settle({
      effectId: EFFECT_ID,
      operation: "charge-v1",
      result: { chargeId: "ch-elsewhere" },
    });

    await expect(deliver()).resolves.toEqual({
      status: "completed",
      result: { chargeId: "ch-elsewhere" },
    });
    expect(log.slice(0, 2)).toEqual(["begin", "write:charge:done"]);
    expect(await readStep("charge")).toMatchObject({ result: { chargeId: "ch-elsewhere" } });
  });

  test.each([
    {
      name: "during perform",
      interrupt: (p: ReturnType<typeof fakeProvider>) =>
        p.perform.mockImplementationOnce(async () => {
          throw new Error("socket hang up");
        }),
      performs: 2,
    },
    {
      name: "after external completion",
      interrupt: (p: ReturnType<typeof fakeProvider>) =>
        p.perform.mockImplementationOnce(async (effectId) => {
          p.charges.set(effectId, { chargeId: "ch-1", amount: 4999 });
          throw new Error("response lost");
        }),
      performs: 1,
    },
  ])("an interruption $name looks up before performing again", async ({ interrupt, performs }) => {
    const { deliver, log, provider, advance, readStep } = setup();
    interrupt(provider);

    await expect(deliver()).resolves.toEqual({ status: "suspended", wakeAt: 61_000 });
    expect(await readStep("charge")).toMatchObject({ type: "effect-wait", done: false });

    advance(60_000);
    log.length = 0;
    await expect(deliver()).resolves.toEqual({
      status: "completed",
      result: { chargeId: "ch-1", amount: 4999 },
    });
    expect(log[1]).toBe("lookup");
    expect(provider.perform).toHaveBeenCalledTimes(performs);
    expect(provider.charges.size).toBe(1);
  });

  test("an interruption after perform's response looks up before performing again", async () => {
    const { deliver, log, provider, spies } = setup();
    spies.settle.mockImplementationOnce(async () => {
      throw new Error("database is locked");
    });

    expect(await deliveryCode(deliver())).toBe("EFFECT_CLIENT_UNAVAILABLE");

    log.length = 0;
    await expect(deliver()).resolves.toMatchObject({
      status: "completed",
      result: { chargeId: "ch-1" },
    });
    expect(log.slice(0, 3)).toEqual(["begin", "lookup", "settle"]);
    expect(provider.perform).toHaveBeenCalledTimes(1);
  });

  test("an interruption after lookup returns not-found looks up again before performing", async () => {
    const { deliver, log, provider, beginElsewhere } = setup();
    await beginElsewhere();
    const controller = new AbortController();
    provider.lookup.mockImplementationOnce(async () => {
      log.push("lookup");
      controller.abort(new LeaseLostError("order-42"));
      return { status: "not-found" };
    });

    await expect(deliver(controller.signal)).rejects.toSatisfy(InfrastructureError.is);
    expect(provider.perform).not.toHaveBeenCalled();

    log.length = 0;
    await expect(deliver()).resolves.toMatchObject({ status: "completed" });
    expect(log.slice(0, 4)).toEqual(["begin", "lookup", "perform", "settle"]);
  });

  test("an interruption after lookup returns settled, before settle, looks up again and stores the same result", async () => {
    const { deliver, log, provider, beginElsewhere, spies, runtime } = setup();
    await beginElsewhere();
    provider.charges.set(EFFECT_ID, { chargeId: "ch-9" });
    spies.settle.mockImplementationOnce(async () => {
      log.push("settle");
      throw new Error("connection reset");
    });

    expect(await deliveryCode(deliver())).toBe("EFFECT_CLIENT_UNAVAILABLE");
    expect((await runtime.effects.getEffect(EFFECT_ID))?.status).toBe("pending");

    log.length = 0;
    await expect(deliver()).resolves.toMatchObject({ result: { chargeId: "ch-9" } });
    expect(log.slice(0, 3)).toEqual(["begin", "lookup", "settle"]);
    expect(await runtime.effects.getEffect(EFFECT_ID)).toMatchObject({
      status: "settled",
      result: { chargeId: "ch-9" },
      conflicts: [],
    });
    expect(provider.perform).not.toHaveBeenCalled();
  });

  test("an interruption after settle, before the step result, reads the result from the effect record", async () => {
    const { deliver, log, provider, spies } = setup();
    spies.writeStep.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    await expect(deliver()).rejects.toSatisfy(InfrastructureError.is);

    log.length = 0;
    await expect(deliver()).resolves.toMatchObject({ result: { chargeId: "ch-1" } });
    expect(log.slice(0, 2)).toEqual(["begin", "write:charge:done"]);
    expect(provider.perform).toHaveBeenCalledTimes(1);
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  test("an interruption after the step result, before the workflow continues, replays the recorded step", async () => {
    const { deliver, log, spies, provider } = setup();
    const writeStep = spies.writeStep.getMockImplementation()!;
    let failed = false;
    spies.writeStep.mockImplementation(async (request) => {
      if (request.stepKey === "ship" && !failed) {
        failed = true;
        throw new Error("disk full");
      }
      return writeStep(request);
    });

    await expect(deliver()).rejects.toSatisfy(InfrastructureError.is);

    log.length = 0;
    await expect(deliver()).resolves.toMatchObject({ result: { chargeId: "ch-1" } });
    expect(log).not.toContain("begin");
    expect(provider.perform).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: "lookup returns unknown",
      overrides: (): Partial<Descriptor> => ({
        lookup: async () => ({ status: "unknown" }),
      }),
      pending: true,
    },
    {
      name: "lookup rejects",
      overrides: (): Partial<Descriptor> => ({
        lookup: async () => {
          throw new Error("provider timeout");
        },
      }),
      pending: true,
    },
    {
      name: "perform rejects",
      overrides: (): Partial<Descriptor> => ({
        perform: async () => {
          throw new Error("provider timeout");
        },
      }),
      pending: false,
    },
  ])("when $name, watch completes before the step suspends with wakeAt = now + retryIn", async ({ overrides, pending }) => {
    const ctx = setup(overrides());
    if (pending) await ctx.beginElsewhere();
    ctx.advance(500);

    await expect(ctx.deliver()).resolves.toEqual({
      status: "suspended",
      wakeAt: 1_500 + 60_000,
    });
    expect(ctx.log.slice(-2)).toEqual(["watch", "write:charge:unfinished"]);
    expect(ctx.spies.watch).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      executionId: "order-42",
      stepKey: "charge",
    });
    expect(await ctx.readStep("charge")).toEqual({
      type: "effect-wait",
      wakeAt: 61_500,
      done: false,
    });
    expect(ctx.caught).toEqual([]);
  });

  test("a suspended effect step begins again on the next delivery", async () => {
    const { deliver, log, provider, advance } = setup();
    provider.perform.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });
    provider.lookup.mockImplementationOnce(async () => ({ status: "unknown" }));

    await expect(deliver()).resolves.toEqual({ status: "suspended", wakeAt: 61_000 });
    advance(60_000);
    await expect(deliver()).resolves.toEqual({ status: "suspended", wakeAt: 121_000 });
    advance(60_000);
    await expect(deliver()).resolves.toMatchObject({ status: "completed" });
    expect(log.filter((entry) => entry === "begin")).toHaveLength(3);
    expect(log.filter((entry) => entry === "watch")).toHaveLength(2);
  });

  test("a retryIn of 0 suspends with wakeAt = now", async () => {
    const { deliver, provider } = setup({ retryIn: 0 });
    provider.perform.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });

    await expect(deliver()).resolves.toEqual({ status: "suspended", wakeAt: 1_000 });
  });

  test("a perform that returns undefined settles the effect with undefined, and the step returns it", async () => {
    const { deliver, runtime, readStep } = setup({ perform: async () => undefined });

    await expect(deliver()).resolves.toEqual({ status: "completed", result: undefined });
    const record = await runtime.effects.getEffect(EFFECT_ID);
    expect(record?.status).toBe("settled");
    expect(record).toHaveProperty("result", undefined);
    expect(await readStep("charge")).toEqual({
      type: "step-result",
      result: { $type: "undefined" },
      done: true,
    });
  });

  test.each([
    { path: "perform", pending: false },
    { path: "lookup", pending: true },
  ])("a lease lost before $path runs neither callback", async ({ pending }) => {
    const { deliver, provider, spies, real, beginElsewhere, readStep } = setup();
    if (pending) await beginElsewhere();
    const controller = new AbortController();
    spies.begin.mockImplementationOnce(async (request) => {
      const begun = await real.begin(request);
      controller.abort(new LeaseLostError("order-42"));
      return begun;
    });

    const err = await deliver(controller.signal).catch((err: unknown) => err);
    expect(InfrastructureError.is(err)).toBe(true);
    expect((err as Error).cause).toBeInstanceOf(LeaseLostError);
    expect(provider.lookup).not.toHaveBeenCalled();
    expect(provider.perform).not.toHaveBeenCalled();
    expect(spies.watch).not.toHaveBeenCalled();
    expect(await readStep("charge")).toBeNull();
  });

  test.each<[string, Partial<Descriptor>, string]>([
    ["an empty effectId", { effectId: "" }, "effectId must be a non-empty string"],
    ["a numeric effectId", { effectId: 42 as never }, "effectId must be a non-empty string"],
    ["an empty operation", { operation: "" }, "operation must be a non-empty string"],
    ["an array input", { input: [1] as never }, "input must be a plain object"],
    ["a non-durable input", { input: { at: new Date() } as never }, "input: "],
    ["a negative retryIn", { retryIn: -1 }, "retryIn must be a finite, non-negative number"],
    ["an infinite retryIn", { retryIn: Infinity }, "retryIn must be a finite, non-negative number"],
    ["a NaN retryIn", { retryIn: NaN }, "retryIn must be a finite, non-negative number"],
    ["a missing lookup", { lookup: undefined as never }, "lookup must be a function"],
    ["a missing perform", { perform: undefined as never }, "perform must be a function"],
  ])("%s records INVALID_EFFECT_REQUEST, which reaches workflow code without a client call", async (_, overrides, message) => {
    const { deliver, caught, spies, readStep, advance } = setup(overrides);

    await expect(deliver()).resolves.toEqual({ status: "completed", result: "caught" });
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(WorkflowEffectError);
    expect(caught[0]).toMatchObject({ code: "INVALID_EFFECT_REQUEST" });
    expect((caught[0] as Error).message).toContain(message);
    expect(spies.begin).not.toHaveBeenCalled();
    expect(await readStep("charge")).toMatchObject({
      type: "step-error",
      err: { name: "WorkflowEffectError", code: "INVALID_EFFECT_REQUEST" },
      done: true,
    });

    advance(1);
    await deliver();
    expect(caught).toHaveLength(2);
    expect(caught[1]).toBeInstanceOf(WorkflowEffectError);
    expect(caught[1]).toMatchObject({ code: "INVALID_EFFECT_REQUEST" });
    expect(spies.begin).not.toHaveBeenCalled();
  });

  test("an empty step key throws in workflow code without a client call", async () => {
    const caught: string[] = [];
    const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;
    const runtime = new MemoryRuntime();
    const begin = vi.spyOn(runtime.effects, "begin");
    const runner = new WorkflowRunner(runtime, {
      router: {
        unkeyed: workflow(async function* (step) {
          try {
            yield* step.effect("", {} as Descriptor);
          } catch (err) {
            caught.push((err as Error).message);
          }
        }),
      },
      logger,
    });
    await runtime.executions.admit({
      workflowId: "unkeyed",
      executionId: "unkeyed",
      params: undefined,
      context: new Map(),
    });
    const [lease] = await runtime.executions.claimDue({ limit: 1, duration: 30_000 });
    await expect(
      runner.run(
        { workflowId: "unkeyed", executionId: "unkeyed", params: undefined, context: new Map() },
        { lease: lease!, signal: new AbortController().signal }
      )
    ).resolves.toMatchObject({ status: "completed" });
    expect(caught).toEqual(["step.effect requires a non-empty step key"]);
    expect(begin).not.toHaveBeenCalled();
  });

  test.each([
    { name: "operation", change: [{ amount: 4999 }, "charge-v0"] as const },
    { name: "input", change: [{ amount: 5999 }, "charge-v1"] as const },
  ])("a changed $name records EFFECT_REQUEST_MISMATCH, which reaches workflow code without a callback", async ({ change }) => {
    const { deliver, caught, provider, beginElsewhere, readStep, runtime, advance } = setup();
    await beginElsewhere(change[0], change[1]);

    await expect(deliver()).resolves.toEqual({ status: "completed", result: "caught" });
    expect(caught[0]).toBeInstanceOf(WorkflowEffectError);
    expect(caught[0]).toMatchObject({ code: "EFFECT_REQUEST_MISMATCH" });
    expect(provider.lookup).not.toHaveBeenCalled();
    expect(provider.perform).not.toHaveBeenCalled();
    expect(await readStep("charge")).toMatchObject({
      type: "step-error",
      err: { name: "WorkflowEffectError", code: "EFFECT_REQUEST_MISMATCH" },
    });
    expect(await runtime.effects.getEffect(EFFECT_ID)).toMatchObject({
      operation: change[1],
      input: change[0],
      status: "pending",
    });

    advance(1);
    await deliver();
    expect(caught[1]).toBeInstanceOf(WorkflowEffectError);
    expect(caught[1]).toMatchObject({ code: "EFFECT_REQUEST_MISMATCH" });
  });

  test.each(["begin", "settle", "watch"] as const)(
    "a %s availability failure records no step, and the delivery retry carries EFFECT_CLIENT_UNAVAILABLE",
    async (method) => {
      const { deliver, spies, provider, readStep, caught, runtime } = setup();
      if (method === "watch") {
        provider.perform.mockImplementationOnce(async () => {
          throw new Error("timeout");
        });
      }
      spies[method].mockImplementationOnce(async () => {
        throw new Error("database is locked");
      });

      expect(await deliveryCode(deliver())).toBe("EFFECT_CLIENT_UNAVAILABLE");
      expect(await readStep("charge")).toBeNull();
      expect(caught).toEqual([]);

      await expect(deliver()).resolves.toMatchObject({ status: "completed" });
      expect((await runtime.effects.getEffect(EFFECT_ID))?.status).toBe("settled");
    }
  );

  test.each<[string, Partial<Descriptor>, boolean]>([
    ["lookup returns a malformed response", { lookup: async () => ({ status: "maybe" }) as never }, true],
    ["lookup returns undefined", { lookup: async () => undefined as never }, true],
    ["lookup returns settled without a result", { lookup: async () => ({ status: "settled" }) as never }, true],
    ["lookup returns a non-durable result", { lookup: async () => ({ status: "settled", result: new Date() }) }, true],
    ["perform returns a non-durable result", { perform: async () => new Map() }, false],
  ])("when %s, no step is recorded, the effect stays pending and the retry carries EFFECT_HANDLER_INVALID", async (_, overrides, pending) => {
    const { deliver, readStep, runtime, spies, beginElsewhere, caught } = setup(overrides);
    if (pending) await beginElsewhere();

    expect(await deliveryCode(deliver())).toBe("EFFECT_HANDLER_INVALID");
    expect(await readStep("charge")).toBeNull();
    expect((await runtime.effects.getEffect(EFFECT_ID))?.status).toBe("pending");
    expect(spies.settle).not.toHaveBeenCalled();
    expect(caught).toEqual([]);
  });

  test.each<[string, (spies: ReturnType<typeof setup>["spies"]) => void]>([
    [
      "begin throws EffectClientInvariantError",
      (spies) =>
        spies.begin.mockRejectedValueOnce(new EffectClientInvariantError("stored input is corrupt")),
    ],
    [
      "settle throws an error with code EFFECT_RUNTIME_INVARIANT",
      (spies) =>
        spies.settle.mockRejectedValueOnce(
          Object.assign(new Error("revived elsewhere"), { code: "EFFECT_RUNTIME_INVARIANT" })
        ),
    ],
    [
      "begin returns a malformed response",
      (spies) => spies.begin.mockResolvedValueOnce({ status: "gone" } as never),
    ],
    [
      "settle returns a malformed response",
      (spies) => spies.settle.mockResolvedValueOnce(undefined as never),
    ],
  ])("when %s, no step is recorded and the retry carries EFFECT_RUNTIME_INVARIANT", async (_, fault) => {
    const { deliver, readStep, spies, caught } = setup();
    fault(spies);

    expect(await deliveryCode(deliver())).toBe("EFFECT_RUNTIME_INVARIANT");
    expect(await readStep("charge")).toBeNull();
    expect(caught).toEqual([]);
  });

  test("a conflicting settlement is reported, and the first result is recorded and returned", async () => {
    const { deliver, beginElsewhere, real, warn, readStep, runtime } = setup({
      lookup: async () => {
        // Another runtime settles the effect while this lookup is running.
        await real.settle({ effectId: EFFECT_ID, operation: "charge-v1", result: { chargeId: "ch-1" } });
        return { status: "settled", result: { chargeId: "ch-2" } };
      },
    });
    await beginElsewhere();

    await expect(deliver()).resolves.toEqual({
      status: "completed",
      result: { chargeId: "ch-1" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      effectId: EFFECT_ID,
      result: { chargeId: "ch-1" },
      conflictingResult: { chargeId: "ch-2" },
    });
    expect(await readStep("charge")).toMatchObject({ result: { chargeId: "ch-1" } });
    expect(await runtime.effects.getEffect(EFFECT_ID)).toMatchObject({
      result: { chargeId: "ch-1" },
      conflicts: [{ result: { chargeId: "ch-1" }, conflictingResult: { chargeId: "ch-2" } }],
    });
  });

  test("a recorded effect step replays without calling the client or a callback", async () => {
    const { deliver, spies, provider, advance } = setup();
    await deliver();
    spies.begin.mockClear();
    provider.perform.mockClear();
    advance(1);

    await deliver();
    expect(spies.begin).not.toHaveBeenCalled();
    expect(provider.perform).not.toHaveBeenCalled();
    expect(provider.lookup).not.toHaveBeenCalled();
  });
});

class ChargeDeclined extends Error {
  code = "CARD_DECLINED";
  constructor(message: string) {
    super(message);
    this.name = "ChargeDeclined";
  }
}
registerErrorClass("ChargeDeclined", ChargeDeclined);

class Receipt {
  constructor(public id: string) {}
}

describe("serialization", () => {
  const values: [string, unknown][] = [
    ["null", null],
    ["true", true],
    ["a number", 49.99],
    ["a string", "ch-1"],
    ["undefined", undefined],
    ["an array", [1, "two", null, undefined]],
    ["a nested object", { charge: { id: "ch-1", note: undefined, lines: [{ qty: 1 }] } }],
    ["an error", new ChargeDeclined("insufficient funds")],
    ["an error-shaped object", { name: "Error", message: "not an error", stack: "at nowhere" }],
    ["an object with a $type key", { $type: "undefined" }],
  ];

  test.each(values)("%s round-trips through the effect and step records unchanged", async (_, value) => {
    const { deliver, runtime, advance, caught } = setup({ perform: async () => value });
    const first = await deliver();
    advance(1);
    const replay = await deliver();

    for (const outcome of [first, replay]) {
      expect(outcome.status).toBe("completed");
      const result = outcome.status === "completed" ? outcome.result : null;
      expect(result).toEqual(value);
      if (value instanceof Error) {
        expect(result).toBeInstanceOf(ChargeDeclined);
        expect(result).toMatchObject({ code: "CARD_DECLINED", message: "insufficient funds" });
      } else {
        expect(result).not.toBeInstanceOf(Error);
      }
      if (value === undefined) expect(result).toBeUndefined();
    }
    const record = await runtime.effects.getEffect(EFFECT_ID);
    expect(record).toHaveProperty("result");
    expect(record!.result).toEqual(value);
    if (value instanceof Error) expect(record!.result).toBeInstanceOf(ChargeDeclined);
    expect(caught).toEqual([]);
  });

  test("a lookup's settled value round-trips like a performed one", async () => {
    const value = { id: "ch-1", note: undefined, error: new RangeError("partial") };
    const { deliver, beginElsewhere } = setup({
      lookup: async () => ({ status: "settled", result: value }),
    });
    await beginElsewhere();

    const outcome = await deliver();
    expect(outcome).toEqual({ status: "completed", result: value });
    const result = (outcome as { result: typeof value }).result;
    expect(result).toHaveProperty("note", undefined);
    expect(result.error).toBeInstanceOf(RangeError);
  });

  test.each<[string, unknown]>([
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a class instance", new Receipt("r-1")],
    ["a sparse array", [, 1]],
    ["a symbol-keyed object", { [Symbol("s")]: 1 }],
  ])("%s is rejected as a result and as an input", async (_, value) => {
    const asResult = setup({ perform: async () => value });
    expect(await deliveryCode(asResult.deliver())).toBe("EFFECT_HANDLER_INVALID");
    expect(asResult.spies.settle).not.toHaveBeenCalled();

    const asInput = setup({ input: { value } as never });
    await expect(asInput.deliver()).resolves.toMatchObject({ result: "caught" });
    expect(asInput.caught[0]).toMatchObject({ code: "INVALID_EFFECT_REQUEST" });
    expect(asInput.spies.begin).not.toHaveBeenCalled();
  });

  test("a suspended effect step stays unfinished through its record", async () => {
    const { deliver, provider, runtime, readStep, advance, log } = setup();
    provider.perform.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });

    await deliver();
    const record = await runtime.heap.readStep({ executionId: "order-42", stepKey: "charge" });
    expect(record?.meta).toEqual({ attempt: 0, done: false });
    expect(await readStep("charge")).toEqual({ type: "effect-wait", wakeAt: 61_000, done: false });

    advance(60_000);
    log.length = 0;
    await deliver();
    expect(log.slice(0, 2)).toEqual(["begin", "lookup"]);
    const finished = await runtime.heap.readStep({ executionId: "order-42", stepKey: "charge" });
    expect(finished?.meta).toEqual({ attempt: 1, done: true });
  });

  test("an effect's error code survives serialization", async () => {
    const { deliver, beginElsewhere, caught, advance } = setup();
    await beginElsewhere({ amount: 1 });
    await deliver();
    advance(1);
    await deliver();
    const codes = caught.map((err) => [
      (err as Error).constructor.name,
      (err as WorkflowEffectError).code,
    ]);
    expect(codes).toEqual([
      ["WorkflowEffectError", "EFFECT_REQUEST_MISMATCH"],
      ["WorkflowEffectError", "EFFECT_REQUEST_MISMATCH"],
    ]);
  });
});

describe("types", () => {
  interface Config {
    region: string;
    size?: number;
  }
  type Charge = { chargeId: string; amount: number };
  const config: Config = { region: "eu" };
  const cloud = {
    lookup: async (_: string): Promise<EffectLookup<Charge>> => ({ status: "not-found" }),
    charge: async (_: string): Promise<Charge> => ({ chargeId: "ch-1", amount: 1 }),
    remove: async (_: string): Promise<void> => {},
  };

  test("step.effect infers its result and checks durability", () => {
    workflow(async function* (step) {
      const charge = yield* step.effect("charge", {
        effectId: "a",
        operation: "charge-v1",
        input: config,
        lookup: (id) => cloud.lookup(id),
        perform: (id) => cloud.charge(id),
        retryIn: 60_000,
      });
      expectTypeOf(charge).toEqualTypeOf<Charge>();

      const removed = yield* step.effect("remove", {
        effectId: "b",
        operation: "remove-v1",
        input: {},
        lookup: async () => ({ status: "not-found" }),
        perform: (id) => cloud.remove(id),
        retryIn: 0,
      });
      expectTypeOf(removed).toEqualTypeOf<void>();

      yield* step.effect("dated", {
        effectId: "c",
        operation: "o",
        input: {},
        lookup: async () => ({ status: "unknown" }),
        // @ts-expect-error a Date is not a durable value
        perform: async () => new Date(),
        retryIn: 0,
      });

      yield* step.effect("dated-input", {
        effectId: "d",
        operation: "o",
        // @ts-expect-error a Date is not a durable value
        input: { at: new Date() },
        lookup: async () => ({ status: "unknown" }),
        perform: async () => 1,
        retryIn: 0,
      });
    });
  });
});
