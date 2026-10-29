import { afterEach, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import {
  ExecutionDispatcher,
  InfrastructureError,
  REDELIVERY_TIMEOUT,
  WorkflowRunner,
  type WorkflowRouter,
} from "@yieldstar/core";
import { createRoutes } from "@yieldstar/http-server";
import { createWorkflowInvoker } from "@yieldstar/test-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { testSchema } from "@yieldstar/test-utils";
import {
  ExecutionAdmissionError,
  RetryableError,
  createHttpSdkFactory,
  createLocalSdk,
  defineStore,
  workflow,
} from "yieldstar";

const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;

function setup<W extends WorkflowRouter>(
  router: W,
  options?: ConstructorParameters<typeof MemoryRuntime>[0]
) {
  const runtime = new MemoryRuntime(options);
  const runner = new WorkflowRunner(runtime, { router, logger });
  const invoker = createWorkflowInvoker({ runner, logger });
  const dispatcher = new ExecutionDispatcher(runtime, {
    invoker,
    logger,
    pollInterval: 1,
    keepAlive: false,
  });
  const sdk = createLocalSdk<W>(runtime, { invoker, pollInterval: 1 });
  dispatchers.push(dispatcher);
  return { runtime, runner, invoker, dispatcher, sdk };
}

const dispatchers: ExecutionDispatcher[] = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const event = (workflowId: string, executionId = workflowId) => ({
  workflowId,
  executionId,
  params: undefined,
  context: new Map(),
});

// Runner

test("deliver resolves with completed and the result when the workflow returns", async () => {
  const { invoker } = setup({
    returns: workflow(async function* (step) {
      return yield* step.run("one", () => 1);
    }),
  });

  await expect(invoker.deliver(event("returns"))).resolves.toEqual({
    status: "completed",
    result: 1,
  });
});

test("deliver resolves with failed when the workflow throws outside a step", async () => {
  const { invoker } = setup({
    throws: workflow(async function* () {
      throw new RangeError("outside a step");
    }),
  });

  const outcome = await invoker.deliver(event("throws"));
  expect(outcome.status).toBe("failed");
  expect(outcome.status === "failed" && outcome.error).toMatchObject({
    name: "RangeError",
    message: "outside a step",
  });
});

test("deliver rejects when an infrastructure operation fails, and nothing is recorded", async () => {
  const { runtime, invoker, sdk } = setup({
    run: workflow(async function* (step) {
      return yield* step.run("one", () => 1);
    }),
  });
  vi.spyOn(runtime.heap, "writeStep").mockRejectedValue(new Error("disk full"));

  const { executionId } = await sdk.trigger({ workflowId: "run" });
  await expect(invoker.deliver(event("run", executionId))).rejects.toBeInstanceOf(
    InfrastructureError
  );
  expect((await runtime.executions.get(executionId))?.status).toBe("admitted");
});

test("a delay records its step and suspends with the delay's wakeAt", async () => {
  const { runtime, invoker } = setup(
    {
      waits: workflow(async function* (step) {
        yield* step.delay("wait", 60_000);
      }),
    },
    { clock: () => 1_000 }
  );

  await expect(invoker.deliver(event("waits"))).resolves.toEqual({
    status: "suspended",
    wakeAt: 61_000,
  });
  expect(
    await runtime.heap.readStep({ executionId: "waits", stepKey: "wait" })
  ).not.toBeNull();
});

test("delay and retry wake times read the runtime clock", async () => {
  let now = 1_000;
  const { invoker } = setup(
    {
      waits: workflow(async function* (step) {
        yield* step.delay("wait", 60_000);
        return "woke";
      }),
      retries: workflow(async function* (step) {
        yield* step.run("flaky", () => {
          throw new RetryableError("again", { maxAttempts: 2, retryInterval: 5_000 });
        });
      }),
    },
    { clock: () => now }
  );

  // A replay before the recorded wakeAt stays suspended, whatever Date.now says.
  now = 60_999;
  await invoker.deliver(event("waits"));
  await expect(invoker.deliver(event("waits"))).resolves.toEqual({
    status: "suspended",
    wakeAt: 120_999,
  });
  now = 120_999;
  await expect(invoker.deliver(event("waits"))).resolves.toEqual({
    status: "completed",
    result: "woke",
  });

  await expect(invoker.deliver(event("retries"))).resolves.toEqual({
    status: "suspended",
    wakeAt: 125_999,
  });
});

// Outcomes

test("a runtime call failing inside try/catch does not run the catch and is not acknowledged", async () => {
  const Counter = defineStore("delivery-counter", testSchema<{ n: number }>());
  let caught = false;
  const { runtime, invoker, sdk } = setup({
    guarded: workflow(async function* (step) {
      const counter = yield* step.store(Counter, { initial: { n: 0 } });
      try {
        yield* counter.update("bump", (draft) => {
          draft.n++;
        });
      } catch {
        caught = true;
      }
      return "done";
    }),
  });
  vi.spyOn(runtime.stores, "updateStore").mockRejectedValue(
    new Error("database is locked")
  );

  const { executionId } = await sdk.trigger({ workflowId: "guarded" });
  await expect(
    invoker.deliver(event("guarded", executionId))
  ).rejects.toThrow("database is locked");
  expect(caught).toBe(false);
  expect((await runtime.executions.get(executionId))?.status).toBe("admitted");
});

test("store errors caused by workflow code still reach its catch", async () => {
  const Counter = defineStore("delivery-validated", {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: any) =>
        value.n > 0 ? { issues: [{ message: "too big" }] } : { value },
    },
  });
  const { sdk, dispatcher } = setup({
    validated: workflow(async function* (step) {
      const counter = yield* step.store(Counter, { initial: { n: 0 } });
      try {
        yield* counter.update("bump", (draft: any) => {
          draft.n++;
        });
      } catch (err) {
        return (err as Error).name;
      }
    }),
  });
  dispatcher.start();

  await expect(sdk.triggerAndWait({ workflowId: "validated" })).resolves.toBe(
    "StoreValidationError"
  );
});

test("an infrastructure error leaves the status unchanged and the execution is delivered again", async () => {
  let runs = 0;
  let now = 1_000;
  const { runtime, sdk, dispatcher } = setup(
    {
      flaky: workflow(async function* (step) {
        runs++;
        return yield* step.run("one", () => "ok");
      }),
    },
    { clock: () => now }
  );
  const writeStep = runtime.heap.writeStep.bind(runtime.heap);
  vi.spyOn(runtime.heap, "writeStep")
    .mockRejectedValueOnce(new Error("disk full"))
    .mockImplementation(writeStep);

  const { executionId } = await sdk.trigger({ workflowId: "flaky" });
  await dispatcher.tick();
  await dispatcher.drain();
  expect((await runtime.executions.get(executionId))?.status).toBe("admitted");

  // Not claimable again until the redelivery timeout passes.
  now += REDELIVERY_TIMEOUT - 1;
  await dispatcher.tick();
  await dispatcher.drain();
  expect(runs).toBe(1);

  // Once it passes, the uncovered wake is delivered again.
  now += 1;
  await dispatcher.tick();
  await dispatcher.drain();
  expect((await runtime.executions.get(executionId))?.outcome).toEqual({
    status: "completed",
    result: "ok",
  });
  expect(runs).toBe(2);
});

test("a terminal execution delivered again returns its outcome without running workflow code", async () => {
  let runs = 0;
  const { runtime, sdk, dispatcher, invoker } = setup({
    once: workflow(async function* () {
      runs++;
      return "first";
    }),
  });
  dispatcher.start();
  const result = await sdk.triggerAndWait({ workflowId: "once", executionId: "once" });
  expect(result).toBe("first");
  await dispatcher.stop();

  // Simulate a stale claim reaching the dispatcher after the outcome.
  vi.spyOn(runtime.executions, "claimDue").mockResolvedValueOnce([
    { executionId: "once", token: "stale" },
  ]);
  const emitted = new Promise((resolve) =>
    invoker.workflowEndEmitter.once("once", resolve)
  );
  await dispatcher.tick();
  await dispatcher.drain();

  await expect(emitted).resolves.toBe("first");
  expect(runs).toBe(1);
});

test("an execution whose workflowId has no registered workflow is acknowledged as failed", async () => {
  const { runtime, sdk, dispatcher } = setup({});
  dispatcher.start();

  await expect(
    (sdk as ReturnType<typeof createLocalSdk<any>>).triggerAndWait({
      workflowId: "missing",
      executionId: "orphan",
      params: undefined,
    })
  ).rejects.toThrow('No workflow registered for "missing"');
  expect((await runtime.executions.get("orphan"))?.status).toBe("failed");
});

// SDK

test("local trigger without an ID returns the ID the execution client accepted", async () => {
  const { runtime, sdk } = setup({ noop: workflow(async function* () {}) });

  const { executionId } = await sdk.trigger({ workflowId: "noop" });

  expect(executionId).toEqual(expect.any(String));
  expect(await runtime.executions.get(executionId)).toMatchObject({
    executionId,
    workflowId: "noop",
    status: "admitted",
  });
});

test("local trigger with an ID in use throws ExecutionAdmissionError", async () => {
  const { sdk } = setup({ noop: workflow(async function* () {}) });
  await sdk.trigger({ workflowId: "noop", executionId: "order-42" });

  const error = await sdk
    .trigger({ workflowId: "noop", executionId: "order-42" })
    .catch((err) => err);
  expect(error).toBeInstanceOf(ExecutionAdmissionError);
  expect(error.code).toBe("EXECUTION_ID_CONFLICT");
});

test("local trigger rejects params that cannot round-trip", async () => {
  const { runtime, sdk } = setup({ noop: workflow(async function* () {}) });

  const error = await sdk
    .trigger({
      workflowId: "noop",
      executionId: "lossy",
      params: { at: new Date() },
    } as never)
    .catch((err) => err);
  expect(error).toMatchObject({ code: "INVALID_EXECUTION_EVENT" });
  expect(await runtime.executions.get("lossy")).toBeUndefined();
});

test("direct trigger resolves once admission commits, and the dispatcher delivers it", async () => {
  let runs = 0;
  const { runtime, sdk, dispatcher } = setup({
    counted: workflow(async function* () {
      runs++;
      return "delivered";
    }),
  });

  const { executionId } = await sdk.trigger({ workflowId: "counted" });
  expect(runs).toBe(0);
  expect((await runtime.executions.get(executionId))?.status).toBe("admitted");

  dispatcher.start();
  await vi.waitFor(async () =>
    expect((await runtime.executions.get(executionId))?.outcome).toEqual({
      status: "completed",
      result: "delivered",
    })
  );
  expect(runs).toBe(1);
});

test("HTTP trigger returns the accepted ID, and 409 Conflict for an ID in use", async () => {
  const router = {
    greet: workflow(async function* (step, event) {
      return `hello ${(event.params as { name: string }).name}`;
    }),
  };
  const { runtime, invoker, dispatcher } = setup(router);
  const routes = createRoutes({ runtime, invoker, logger });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    return routes[path]!.POST(new Request(url, init));
  });
  dispatcher.start();
  const http = createHttpSdkFactory<typeof router>()({ url: "http://yieldstar.test" });

  const execution = await http.trigger({
    workflowId: "greet",
    params: { name: "world" },
  });
  expect(await runtime.executions.get(execution.executionId)).toBeDefined();
  await expect(execution.waitForResult()).resolves.toBe("hello world");

  const response = await fetch("http://yieldstar.test/trigger", {
    method: "POST",
    body: JSON.stringify({
      workflowId: "greet",
      executionId: execution.executionId,
      params: { name: "again" },
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "EXECUTION_ID_CONFLICT" });

  const error = await http
    .trigger({
      workflowId: "greet",
      executionId: execution.executionId,
      params: { name: "again" },
    })
    .catch((err) => err);
  expect(error).toBeInstanceOf(ExecutionAdmissionError);
  expect(error.code).toBe("EXECUTION_ID_CONFLICT");
});
