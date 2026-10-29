import { afterEach, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import {
  DEFAULT_LEASE_DURATION,
  ExecutionDispatcher,
  InfrastructureError,
  WorkflowRunner,
  redeliveryDelay,
  type ExecutionLease,
  type ExecutionStartRequest,
  type ExecutionStartResult,
  type WorkflowRouter,
} from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/test-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { WorkflowStartError, createLocalSdk, workflow } from "yieldstar";

const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;

const dispatchers: ExecutionDispatcher[] = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((d) => d.stop()));
  vi.restoreAllMocks();
});

/**
 * A fake `ExecutionClient.start`, idempotent by request ID: the first call for
 * a request ID mints a new execution ID, and later calls return it.
 */
function fakeStart(
  respond: (
    request: ExecutionStartRequest,
    executionId: string
  ) => ExecutionStartResult = (_, executionId) => ({
    status: "accepted",
    executionId,
  })
) {
  const minted = new Map<string, string>();
  return vi.fn(async (request: ExecutionStartRequest) => {
    const key = JSON.stringify(request.requestId);
    if (!minted.has(key)) minted.set(key, `target-${minted.size + 1}`);
    return respond(request, minted.get(key)!);
  });
}

function setup<W extends WorkflowRouter>(router: W) {
  let now = 1_000;
  const runtime = new MemoryRuntime({ clock: () => now });
  const runner = new WorkflowRunner(runtime, { router, logger });
  const invoker = createWorkflowInvoker({ runner, logger });
  const dispatcher = new ExecutionDispatcher(runtime, {
    invoker,
    logger,
    pollInterval: 1,
    keepAlive: false,
  });
  dispatchers.push(dispatcher);
  const sdk = createLocalSdk<W>(runtime, { invoker, pollInterval: 1 });

  // One lease per execution is held across a test's direct deliveries.
  const leases = new Map<string, ExecutionLease>();
  async function deliver(workflowId: string, executionId = workflowId) {
    let lease = leases.get(executionId);
    if (!lease) {
      await runtime.executions.admit({
        workflowId,
        executionId,
        params: undefined,
        context: new Map(),
      });
      const claimed = await runtime.executions.claimDue({
        limit: 1_000,
        duration: DEFAULT_LEASE_DURATION,
      });
      lease = claimed.find((l) => l.executionId === executionId);
      if (!lease) throw new Error(`could not lease "${executionId}"`);
      leases.set(executionId, lease);
    }
    return invoker.deliver(
      { workflowId, executionId, params: undefined, context: new Map() },
      { lease, signal: new AbortController().signal }
    );
  }

  const advance = (ms: number) => {
    now += ms;
  };

  const readStep = async (executionId: string, stepKey: string) => {
    const record = await runtime.heap.readStep({ executionId, stepKey });
    return record && JSON.parse(record.stepResponseJson);
  };

  return { runtime, dispatcher, sdk, deliver, advance, readStep };
}

// Workflow driver

test("an accepted start is recorded and returned; replay makes no client call", async () => {
  const { runtime, deliver, advance, readStep } = setup({
    charge: workflow(async function* (step) {
      const target = yield* step.start("ship", {
        workflowId: "ship-order",
        params: { orderId: 42 },
      });
      yield* step.delay("wait", 60_000);
      return target;
    }),
  });
  const start = fakeStart();
  vi.spyOn(runtime.executions, "start").mockImplementation(start);

  await expect(deliver("charge", "order-42")).resolves.toMatchObject({
    status: "suspended",
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith({
    requestId: { executionId: "order-42", stepKey: "ship" },
    workflowId: "ship-order",
    params: { orderId: 42 },
  });
  expect(await readStep("order-42", "ship")).toMatchObject({
    type: "step-result",
    result: { executionId: "target-1" },
  });

  advance(60_000);
  await expect(deliver("charge", "order-42")).resolves.toEqual({
    status: "completed",
    result: { executionId: "target-1" },
  });
  expect(start).toHaveBeenCalledTimes(1);
});

test("a start without params sends no params, which differs from an empty object", async () => {
  const { runtime, deliver } = setup({
    bare: workflow(async function* (step) {
      yield* step.start("a", { workflowId: "target" });
      yield* step.start("b", { workflowId: "target", params: {} });
    }),
  });
  const start = fakeStart();
  vi.spyOn(runtime.executions, "start").mockImplementation(start);

  await deliver("bare");
  expect(start.mock.calls[0]![0]).not.toHaveProperty("params");
  expect(start.mock.calls[1]![0]).toHaveProperty("params", {});
});

test("a rejected start is recorded and thrown as WorkflowStartError; replay restores the class and code without a client call", async () => {
  const caught: { isStartError: boolean; code: unknown; message: string }[] = [];
  const { runtime, deliver, advance, readStep } = setup({
    charge: workflow(async function* (step) {
      try {
        yield* step.start("ship", { workflowId: "ship-express" });
      } catch (err) {
        caught.push({
          isStartError: err instanceof WorkflowStartError,
          code: (err as WorkflowStartError).code,
          message: (err as Error).message,
        });
      }
      yield* step.delay("wait", 60_000);
      return "handled";
    }),
  });
  const start = fakeStart(() => ({
    status: "rejected",
    code: "START_REQUEST_MISMATCH",
    message: "ship was started with a different request",
  }));
  vi.spyOn(runtime.executions, "start").mockImplementation(start);

  await deliver("charge");
  expect(await readStep("charge", "ship")).toMatchObject({
    type: "step-error",
    err: { name: "WorkflowStartError", code: "START_REQUEST_MISMATCH" },
  });

  advance(60_000);
  await expect(deliver("charge")).resolves.toEqual({
    status: "completed",
    result: "handled",
  });
  const expected = {
    isStartError: true,
    code: "START_REQUEST_MISMATCH",
    message: "ship was started with a different request",
  };
  expect(caught).toEqual([expected, expected]);
  expect(start).toHaveBeenCalledTimes(1);
});

test("INVALID_START_PARAMETERS is recorded and thrown after one client call", async () => {
  const { runtime, deliver, readStep } = setup({
    charge: workflow(async function* (step) {
      yield* step.start("ship", {
        workflowId: "ship-order",
        params: { at: new Date() } as never,
      });
      return "unreachable";
    }),
  });
  const start = fakeStart(() => ({
    status: "rejected",
    code: "INVALID_START_PARAMETERS",
    message: "$.at: Date instances are not plain objects",
  }));
  vi.spyOn(runtime.executions, "start").mockImplementation(start);

  const outcome = await deliver("charge");
  expect(outcome.status).toBe("failed");
  const error = outcome.status === "failed" ? outcome.error : undefined;
  expect(error).toBeInstanceOf(WorkflowStartError);
  expect(error).toMatchObject({ code: "INVALID_START_PARAMETERS" });
  expect(await readStep("charge", "ship")).toMatchObject({
    type: "step-error",
    err: { code: "INVALID_START_PARAMETERS" },
  });
  expect(start).toHaveBeenCalledTimes(1);
});

test("a throwing client records no step, cannot be caught, and the next attempt calls the client again", async () => {
  let caught = false;
  const { runtime, deliver, readStep } = setup({
    charge: workflow(async function* (step) {
      try {
        return yield* step.start("ship", { workflowId: "ship-order" });
      } catch {
        caught = true;
      }
    }),
  });
  const accept = fakeStart();
  const start = vi
    .fn(accept)
    .mockRejectedValueOnce(new Error("database is locked"));
  vi.spyOn(runtime.executions, "start").mockImplementation(start);

  await expect(deliver("charge")).rejects.toBeInstanceOf(InfrastructureError);
  expect(caught).toBe(false);
  expect(await readStep("charge", "ship")).toBeNull();

  await expect(deliver("charge")).resolves.toEqual({
    status: "completed",
    result: { executionId: "target-1" },
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]![0].requestId).toEqual(
    start.mock.calls[0]![0].requestId
  );
});

test("a caller that stops after an accepted start, before recording it, records the first execution ID on its next attempt", async () => {
  const { runtime, deliver, readStep } = setup({
    charge: workflow(async function* (step) {
      return yield* step.start("ship", { workflowId: "ship-order" });
    }),
  });
  const start = fakeStart();
  vi.spyOn(runtime.executions, "start").mockImplementation(start);
  const writeStep = runtime.heap.writeStep.bind(runtime.heap);
  vi.spyOn(runtime.heap, "writeStep")
    .mockRejectedValueOnce(new Error("disk full"))
    .mockImplementation(writeStep);

  await expect(deliver("charge")).rejects.toBeInstanceOf(InfrastructureError);
  await expect(start.mock.results[0]!.value).resolves.toEqual({
    status: "accepted",
    executionId: "target-1",
  });
  expect(await readStep("charge", "ship")).toBeNull();

  await expect(deliver("charge")).resolves.toEqual({
    status: "completed",
    result: { executionId: "target-1" },
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]![0].requestId).toEqual({
    executionId: "charge",
    stepKey: "ship",
  });
  expect(await readStep("charge", "ship")).toMatchObject({
    result: { executionId: "target-1" },
  });
});

// Delivery

test("a throwing ExecutionClient.start rejects the delivery, and the dispatcher delivers the execution again", async () => {
  let caught = false;
  const { runtime, sdk, dispatcher, advance, readStep } = setup({
    charge: workflow(async function* (step) {
      try {
        return yield* step.start("ship", { workflowId: "ship-order" });
      } catch {
        caught = true;
      }
    }),
  });
  const start = vi
    .fn(fakeStart())
    .mockRejectedValueOnce(new Error("database is locked"));
  vi.spyOn(runtime.executions, "start").mockImplementation(start);

  const { executionId } = await sdk.trigger({ workflowId: "charge" });
  await dispatcher.tick();
  await dispatcher.drain();

  expect(caught).toBe(false);
  expect(await readStep(executionId, "ship")).toBeNull();
  const record = await runtime.executions.get(executionId);
  expect(record).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 1,
  });
  expect(record?.outcome).toBeUndefined();

  advance(redeliveryDelay(1));
  await dispatcher.tick();
  await dispatcher.drain();
  expect((await runtime.executions.get(executionId))?.outcome).toEqual({
    status: "completed",
    result: { executionId: "target-1" },
  });
  expect(start).toHaveBeenCalledTimes(2);
});
