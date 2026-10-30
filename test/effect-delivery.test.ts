import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import {
  DEFAULT_LEASE_DURATION,
  ExecutionDispatcher,
  WorkerExitedError,
  WorkflowRunner,
  redeliveryDelay,
  waitForExecutionOutcome,
  type WorkflowInvoker,
} from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/test-invoker";
import { createWorkflowInvoker as createWorkerInvoker } from "@yieldstar/worker-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";
import { workflow, type EffectLookup } from "yieldstar";

const { createSqliteDb } =
  "Bun" in globalThis
    ? await import("@yieldstar/sqlite-runtime/bun")
    : await import("@yieldstar/sqlite-runtime/node");

const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;
const fixtures = new URL("./fixtures/worker-invoker/", import.meta.url);

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const EFFECT_ID = "acct-1:charge:order-42";
const RETRY_IN = 60_000;

type Charge = { chargeId: string };

/**
 * Executions of `charge-order` share one effect ID, over a memory runtime and
 * a dispatcher driven by hand with a hand-driven clock. `lookups` answers
 * each lookup in turn; once it is empty, lookup reports the provider's state.
 */
function setup() {
  let now = 1_000;
  const charges = new Map<string, Charge>();
  const lookups: EffectLookup<Charge>[] = [];
  const provider = {
    lookup: vi.fn(async (effectId: string): Promise<EffectLookup<Charge>> => {
      const next = lookups.shift();
      if (next) return next;
      const charge = charges.get(effectId);
      return charge ? { status: "settled", result: charge } : { status: "not-found" };
    }),
    perform: vi.fn(async (effectId: string): Promise<Charge> => {
      if (!charges.has(effectId)) charges.set(effectId, { chargeId: `ch-${charges.size + 1}` });
      return charges.get(effectId)!;
    }),
  };

  const runtime = new MemoryRuntime({ clock: () => now });
  const runner = new WorkflowRunner(runtime, {
    router: {
      "charge-order": workflow(async function* (step) {
        return yield* step.effect("charge", {
          effectId: EFFECT_ID,
          operation: "charge-v1",
          input: { amount: 4999 },
          retryIn: RETRY_IN,
          lookup: (id) => provider.lookup(id),
          perform: (id) => provider.perform(id),
        });
      }),
    },
    logger,
  });
  const inProcess = createWorkflowInvoker({ runner, logger });
  const deliveries: string[] = [];
  let exitBeforeReply = 0;
  const invoker: WorkflowInvoker = {
    workflowEndEmitter: inProcess.workflowEndEmitter,
    async deliver(event, options) {
      deliveries.push(event.executionId);
      const outcome = await inProcess.deliver(event, options);
      // The worker finished its writes, then died before replying.
      if (exitBeforeReply > 0) {
        exitBeforeReply--;
        throw new WorkerExitedError("Worker process exited before replying (code 1)");
      }
      return outcome;
    },
  };
  const dispatcher = new ExecutionDispatcher(runtime, {
    invoker,
    logger,
    pollInterval: 1,
    keepAlive: false,
  });
  cleanups.push(() => dispatcher.stop());

  const admit = (executionId = "order-42") =>
    runtime.executions.admit({
      executionId,
      workflowId: "charge-order",
      params: undefined,
      context: new Map(),
    });

  /** Claims every due execution, and waits for their deliveries. */
  const tick = async () => {
    const claimed = await dispatcher.tick();
    await dispatcher.drain();
    return claimed;
  };

  const readStep = async (executionId = "order-42") => {
    const record = await runtime.heap.readStep({ executionId, stepKey: "charge" });
    return record && { ...JSON.parse(record.stepResponseJson), done: record.meta.done };
  };

  return {
    runtime,
    provider,
    lookups,
    charges,
    deliveries,
    admit,
    tick,
    readStep,
    exitBeforeNextReply: () => {
      exitBeforeReply++;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test("a worker that fails after watch commits, before the unfinished step record, is released; the next delivery watches again and suspends with a new wakeAt", async () => {
  const { runtime, provider, lookups, admit, tick, readStep, advance, now } = setup();
  provider.perform.mockRejectedValueOnce(new Error("timeout"));
  const watch = vi.spyOn(runtime.effects, "watch");
  const writeStep = runtime.heap.writeStep.bind(runtime.heap);
  vi.spyOn(runtime.heap, "writeStep")
    .mockRejectedValueOnce(new Error("disk full"))
    .mockImplementation(writeStep);
  await admit();

  expect(await tick()).toBe(1);
  expect(watch).toHaveBeenCalledTimes(1);
  expect(await readStep()).toBeNull();
  expect(await runtime.executions.get("order-42")).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 1,
  });

  advance(redeliveryDelay(1));
  lookups.push({ status: "unknown" });
  expect(await tick()).toBe(1);
  expect(watch).toHaveBeenCalledTimes(2);
  expect(await readStep()).toMatchObject({
    type: "effect-wait",
    wakeAt: now() + RETRY_IN,
    done: false,
  });
  expect(await runtime.executions.get("order-42")).toMatchObject({
    status: "suspended",
    unacknowledgedDeliveryCount: 0,
  });
});

test("after a delivery crashes at the pause, a later delivery's wakeAt decides when the retry runs", async () => {
  const { runtime, provider, lookups, admit, tick, advance, now, exitBeforeNextReply, deliveries } =
    setup();
  provider.perform.mockRejectedValueOnce(new Error("timeout"));
  await admit();

  exitBeforeNextReply();
  expect(await tick()).toBe(1);
  const abandonedWakeAt = now() + RETRY_IN;

  // The lease expires, then the redelivery delay passes.
  advance(DEFAULT_LEASE_DURATION + redeliveryDelay(1));
  lookups.push({ status: "unknown" });
  expect(await tick()).toBe(1);
  const wakeAt = now() + RETRY_IN;
  expect(await runtime.executions.get("order-42")).toMatchObject({ status: "suspended" });

  advance(abandonedWakeAt - now());
  expect(await tick()).toBe(0);

  advance(wakeAt - now());
  expect(await tick()).toBe(1);
  expect(deliveries).toHaveLength(3);
  expect((await runtime.executions.get("order-42"))?.outcome).toEqual({
    status: "completed",
    result: { chargeId: "ch-1" },
  });
});

test("a worker that fails after the unfinished step record, before replying, leaves the next delivery safe", async () => {
  const { runtime, provider, charges, admit, tick, readStep, advance, exitBeforeNextReply } = setup();
  provider.perform.mockImplementationOnce(async (effectId) => {
    charges.set(effectId, { chargeId: "ch-1" });
    throw new Error("response lost");
  });
  await admit();

  exitBeforeNextReply();
  await tick();
  expect(await readStep()).toMatchObject({ type: "effect-wait", done: false });
  expect(await runtime.executions.get("order-42")).toMatchObject({
    status: "running",
    unacknowledgedDeliveryCount: 0,
  });

  advance(DEFAULT_LEASE_DURATION + redeliveryDelay(1));
  expect(await tick()).toBe(1);
  expect((await runtime.executions.get("order-42"))?.outcome).toEqual({
    status: "completed",
    result: { chargeId: "ch-1" },
  });
  expect(provider.perform).toHaveBeenCalledTimes(1);
  expect(provider.lookup).toHaveBeenCalledTimes(1);
  expect(charges.size).toBe(1);
});

test("a requested wake that becomes due is delivered once, and acknowledgement clears it", async () => {
  const { runtime, lookups, provider, admit, tick, advance, deliveries } = setup();
  provider.perform.mockRejectedValueOnce(new Error("timeout"));
  await admit();

  await tick();
  expect(deliveries).toEqual(["order-42"]);
  advance(RETRY_IN - 1);
  expect(await tick()).toBe(0);

  advance(1);
  lookups.push({ status: "unknown" });
  expect(await tick()).toBe(1);
  expect(await tick()).toBe(0);
  expect(deliveries).toHaveLength(2);
  expect(await runtime.executions.get("order-42")).toMatchObject({ status: "suspended" });

  advance(RETRY_IN);
  expect(await tick()).toBe(1);
  expect(await tick()).toBe(0);
  expect(deliveries).toHaveLength(3);
  expect((await runtime.executions.get("order-42"))?.status).toBe("completed");
});

test("a settlement wakes every watching execution, and each reads the settled result", async () => {
  const { runtime, provider, lookups, admit, tick, advance, readStep } = setup();
  provider.perform.mockRejectedValueOnce(new Error("timeout"));
  lookups.push({ status: "unknown" });
  await admit("order-42");
  await admit("support-check");

  expect(await tick()).toBe(2);
  for (const executionId of ["order-42", "support-check"]) {
    expect(await runtime.executions.get(executionId)).toMatchObject({ status: "suspended" });
  }

  advance(1);
  await runtime.effects.settle({
    effectId: EFFECT_ID,
    operation: "charge-v1",
    status: "settled",
    result: { chargeId: "ch-settled" },
  });
  provider.lookup.mockClear();
  provider.perform.mockClear();

  expect(await tick()).toBe(2);
  for (const executionId of ["order-42", "support-check"]) {
    expect((await runtime.executions.get(executionId))?.outcome).toEqual({
      status: "completed",
      result: { chargeId: "ch-settled" },
    });
    expect(await readStep(executionId)).toMatchObject({
      type: "step-result",
      result: { chargeId: "ch-settled" },
      done: true,
    });
  }
  expect(provider.lookup).not.toHaveBeenCalled();
  expect(provider.perform).not.toHaveBeenCalled();
});

test("an EffectClient failure inside a worker replies retry: deliver rejects, the lease is released, and no step result exists", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "yieldstar-effect-"));
  const db = createSqliteDb({ path: join(dir, "shared.db"), wal: true });
  const runtime = new SqliteRuntime(db);
  const errors: { err?: Error; message: string }[] = [];
  const dispatcherLogger = {
    info() {},
    warn() {},
    error(fields: { err?: Error }, message: string) {
      errors.push({ err: fields?.err, message });
    },
  } as unknown as Logger;
  const invoker = createWorkerInvoker({
    workerPath: new URL("effect-worker.mjs", fixtures).href,
    logger,
  });
  const dispatcher = new ExecutionDispatcher(runtime, {
    invoker,
    logger: dispatcherLogger,
    pollInterval: 5,
    keepAlive: false,
  });
  cleanups.push(async () => {
    await dispatcher.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await runtime.executions.admit({
    executionId: "order-42",
    workflowId: "charge-order",
    params: undefined,
    context: new Map([["dir", dir]]),
  });

  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();

  expect(errors).toHaveLength(1);
  expect(errors[0]!.message).toBe(
    "Delivery failed without an outcome; releasing its lease for redelivery"
  );
  expect(errors[0]!.err).toMatchObject({
    name: "InfrastructureError",
    cause: { name: "EffectDeliveryError", code: "EFFECT_CLIENT_UNAVAILABLE" },
  });
  // Released, not expired: the record has no live lease.
  expect(await runtime.executions.get("order-42")).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 1,
  });
  expect(await runtime.heap.readStep({ executionId: "order-42", stepKey: "charge" })).toBeNull();
  expect(await runtime.effects.getEffect("acct-1:charge:order-42")).toBeUndefined();
  expect(existsSync(join(dir, "calls"))).toBe(false);

  dispatcher.start();
  expect(
    await waitForExecutionOutcome(runtime.executions, "order-42", { pollInterval: 5 })
  ).toEqual({ status: "completed", result: { chargeId: "ch-1" } });
  expect(readFileSync(join(dir, "calls"), "utf8")).toBe("perform\n");
  expect(await runtime.effects.getEffect("acct-1:charge:order-42")).toMatchObject({
    status: "settled",
    result: { chargeId: "ch-1" },
  });
});
