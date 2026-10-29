import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Logger } from "pino";
import {
  ExecutionDispatcher,
  waitForExecutionOutcome,
  type DispatcherOptions,
} from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";

const { createSqliteDb } =
  "Bun" in globalThis
    ? await import("@yieldstar/sqlite-runtime/bun")
    : await import("@yieldstar/sqlite-runtime/node");

const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;
const fixtures = new URL("./fixtures/worker-invoker/", import.meta.url);

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A SQLite file shared by this process's dispatcher and its forked workers,
 * each of which opens its own connection.
 */
function setup(options: Partial<DispatcherOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yieldstar-start-"));
  const db = createSqliteDb({ path: join(dir, "shared.db"), wal: true });
  const runtime = new SqliteRuntime(db);
  const invoker = createWorkflowInvoker({
    workerPath: new URL("start-worker.mjs", fixtures).href,
    logger,
  });
  const dispatcher = new ExecutionDispatcher(runtime, {
    invoker,
    logger,
    pollInterval: 5,
    keepAlive: false,
    ...options,
  });
  cleanups.push(async () => {
    await dispatcher.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const admitCaller = async (params: Record<string, unknown>) => {
    const admitted = await runtime.executions.admit({
      executionId: "order-42",
      workflowId: "charge-order",
      params,
      context: new Map([
        ["dir", dir],
        ["tenant", "acme"],
      ]),
    });
    expect(admitted).toEqual({ status: "accepted", executionId: "order-42" });
  };

  const outcomeOf = (executionId: string) =>
    waitForExecutionOutcome(runtime.executions, executionId, { pollInterval: 5 });

  const starts = () =>
    readFileSync(join(dir, "starts"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  const shipOrderIds = () =>
    db
      .query<{ execution_id: string }>(
        "SELECT execution_id FROM executions WHERE workflow_id = 'ship-order'"
      )
      .all()
      .map((row) => row.execution_id);

  return { dir, runtime, dispatcher, admitCaller, outcomeOf, starts, shipOrderIds };
}

test("step.start through worker processes and SQLite: the caller records the target, and the target runs with its parent link and the caller's context", { timeout: 10_000 }, async () => {
  const { runtime, dispatcher, admitCaller, outcomeOf, starts, shipOrderIds } = setup();
  await admitCaller({ orderId: 42 });
  dispatcher.start();

  const callerOutcome = await outcomeOf("order-42");
  expect(callerOutcome).toMatchObject({ status: "completed" });
  const { shipment } = (callerOutcome as { result: { shipment: string } }).result;
  expect(shipOrderIds()).toEqual([shipment]);

  expect(await outcomeOf(shipment)).toEqual({
    status: "completed",
    result: { orderId: 42, courier: "courier-1", tenant: "acme" },
  });
  expect(await runtime.executions.get(shipment)).toMatchObject({
    workflowId: "ship-order",
    params: { orderId: 42 },
    parent: { executionId: "order-42", stepKey: "ship" },
  });
  expect(await runtime.executions.get("order-42")).not.toHaveProperty("parent");

  expect(starts()).toEqual([
    {
      request: {
        requestId: { executionId: "order-42", stepKey: "ship" },
        workflowId: "ship-order",
        params: { orderId: 42 },
      },
      result: { status: "accepted", executionId: shipment },
    },
  ]);
  const recorded = await runtime.heap.readStep({ executionId: "order-42", stepKey: "ship" });
  expect(JSON.parse(recorded!.stepResponseJson)).toMatchObject({
    type: "step-result",
    result: { executionId: shipment },
  });
});

test("a worker that crashes after the target is started, before the step is recorded, starts nothing new on redelivery", { timeout: 15_000 }, async () => {
  const { runtime, dispatcher, admitCaller, outcomeOf, starts, shipOrderIds } = setup({
    leaseDuration: 300,
    renewInterval: 100,
  });
  await admitCaller({ orderId: 42, crashAfterStart: true });
  dispatcher.start();

  const callerOutcome = await outcomeOf("order-42");
  expect(callerOutcome).toMatchObject({ status: "completed" });
  const { shipment } = (callerOutcome as { result: { shipment: string } }).result;

  // The crashed attempt and the redelivery sent one request ID and received
  // one target.
  const calls = starts();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0].result).toEqual({ status: "accepted", executionId: shipment });
  expect(shipOrderIds()).toEqual([shipment]);

  expect(await outcomeOf(shipment)).toMatchObject({ status: "completed" });
  expect(await runtime.executions.get(shipment)).toMatchObject({
    parent: { executionId: "order-42", stepKey: "ship" },
  });
  // The crash ended a delivery without an acknowledgement; the redelivery's
  // acknowledgement reset the count.
  expect(await runtime.executions.get("order-42")).toMatchObject({
    status: "completed",
    unacknowledgedDeliveryCount: 0,
  });
});
