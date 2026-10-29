import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type { Logger } from "pino";
import {
  DEFAULT_LEASE_DURATION,
  ExecutionDispatcher,
  InfrastructureError,
  WorkerExitedError,
  WorkflowRunner,
  redeliveryDelay,
  type DeliveryOptions,
  type DispatcherOptions,
  type ExecutionLease,
  type Runtime,
  type WorkflowEvent,
  type WorkflowInvoker,
  type WorkflowRunOutcome,
} from "@yieldstar/core";
import { createWorkflowInvoker as createTestInvoker } from "@yieldstar/test-invoker";
import { createWorkflowInvoker as createWorkerInvoker } from "@yieldstar/worker-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";
import { workflow } from "yieldstar";

const isBun = "Bun" in globalThis;
const { createSqliteDb } = isBun
  ? await import("@yieldstar/sqlite-runtime/bun")
  : await import("@yieldstar/sqlite-runtime/node");

const logger = { info() {}, error() {}, warn() {} } as unknown as Logger;
const fixtures = new URL("./fixtures/worker-invoker/", import.meta.url);

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function dispatcherFor(
  runtime: Runtime,
  invoker: WorkflowInvoker,
  options: Partial<DispatcherOptions> = {}
) {
  const dispatcher = new ExecutionDispatcher(runtime, {
    invoker,
    logger,
    pollInterval: 1,
    keepAlive: false,
    ...options,
  });
  cleanups.push(() => dispatcher.stop());
  return dispatcher;
}

/** An invoker whose deliveries run `handle`, and that tracks what is running. */
function stubInvoker(
  handle: (event: WorkflowEvent, options: DeliveryOptions) => Promise<WorkflowRunOutcome>
) {
  const active = new Set<string>();
  const stats = { delivered: [] as string[], maxActive: 0, overlaps: [] as string[] };
  const invoker: WorkflowInvoker = {
    workflowEndEmitter: new EventEmitter(),
    async deliver(event, options) {
      if (active.has(event.executionId)) stats.overlaps.push(event.executionId);
      active.add(event.executionId);
      stats.delivered.push(event.executionId);
      stats.maxActive = Math.max(stats.maxActive, active.size);
      try {
        return await handle(event, options);
      } finally {
        active.delete(event.executionId);
      }
    },
  };
  return { invoker, stats, active };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function admit(runtime: Runtime, executionId: string, workflowId = "workflow") {
  const result = await runtime.executions.admit({
    executionId,
    workflowId,
    params: undefined,
    context: new Map(),
  });
  expect(result).toEqual({ status: "accepted", executionId });
}

function clocked() {
  const clock = { now: 1_000_000 };
  const runtime = new MemoryRuntime({ clock: () => clock.now });
  return { runtime, clock };
}

// Filtering

test("delivers only the executions named in filter.executionIds", async () => {
  const { runtime } = clocked();
  const { invoker, stats } = stubInvoker(async () => ({ status: "completed", result: "ok" }));
  const dispatcher = dispatcherFor(runtime, invoker, { filter: { executionIds: ["mine"] } });
  for (const id of ["other", "mine"]) await admit(runtime, id);

  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();
  expect(stats.delivered).toEqual(["mine"]);
  expect(await dispatcher.tick()).toBe(0);
  expect(await runtime.executions.get("other")).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 0,
  });
});

test("rejects an empty filter.executionIds", () => {
  const { runtime } = clocked();
  const { invoker } = stubInvoker(async () => ({ status: "completed", result: "ok" }));
  expect(() => dispatcherFor(runtime, invoker, { filter: { executionIds: [] } })).toThrow(
    RangeError
  );
});

// Concurrency

test("delivers N due executions at once when concurrency is N", async () => {
  const { runtime } = clocked();
  const gate = deferred();
  const { invoker, stats } = stubInvoker(async () => {
    await gate.promise;
    return { status: "completed", result: "ok" };
  });
  const dispatcher = dispatcherFor(runtime, invoker, { concurrency: 5 });
  for (let i = 0; i < 5; i++) await admit(runtime, `e${i}`);

  expect(await dispatcher.tick()).toBe(5);
  // Every delivery has started while none has finished.
  await vi.waitFor(() => expect(stats.delivered).toHaveLength(5));
  expect(stats.maxActive).toBe(5);
  expect(dispatcher.activeDeliveries).toBe(5);

  gate.resolve();
  await dispatcher.drain();
  for (let i = 0; i < 5; i++) {
    expect((await runtime.executions.get(`e${i}`))?.status).toBe("completed");
  }
});

test("runs no more than `concurrency` deliveries at once when more are due", async () => {
  const runtime = new MemoryRuntime();
  const { invoker, stats } = stubInvoker(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { status: "completed", result: "ok" };
  });
  const dispatcher = dispatcherFor(runtime, invoker, { concurrency: 3 });
  const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
  for (const id of ids) await admit(runtime, id);

  // A manual claim takes only the free slots.
  expect(await dispatcher.tick()).toBe(3);
  expect(await dispatcher.tick()).toBe(0);

  dispatcher.start();
  await vi.waitFor(
    async () => {
      for (const id of ids) {
        expect((await runtime.executions.get(id))?.status).toBe("completed");
      }
    },
    { timeout: 2_000 }
  );
  expect(stats.maxActive).toBe(3);
  expect(stats.delivered.sort()).toEqual([...ids].sort());
});

test("defaults to 10 deliveries at once", async () => {
  const { runtime } = clocked();
  const gate = deferred();
  const { invoker } = stubInvoker(async () => {
    await gate.promise;
    return { status: "suspended" };
  });
  const dispatcher = dispatcherFor(runtime, invoker);
  for (let i = 0; i < 12; i++) await admit(runtime, `e${i}`);
  expect(await dispatcher.tick()).toBe(10);
  gate.resolve();
  await dispatcher.drain();
});

test("claims new executions without waiting for earlier deliveries to reach an outcome", async () => {
  const runtime = new MemoryRuntime();
  const slow = deferred();
  const { invoker } = stubInvoker(async (event) => {
    if (event.executionId === "slow") await slow.promise;
    return { status: "completed", result: event.executionId };
  });
  const dispatcher = dispatcherFor(runtime, invoker);
  dispatcher.start();
  await admit(runtime, "slow");
  await vi.waitFor(async () =>
    expect((await runtime.executions.get("slow"))?.status).toBe("running")
  );
  await admit(runtime, "fast");
  await vi.waitFor(async () =>
    expect((await runtime.executions.get("fast"))?.status).toBe("completed")
  );
  expect((await runtime.executions.get("slow"))?.status).toBe("running");
  slow.resolve();
  await vi.waitFor(async () =>
    expect((await runtime.executions.get("slow"))?.status).toBe("completed")
  );
});

function sharedBackends(): { name: string; open(): Runtime[] }[] {
  return [
    {
      name: "one memory runtime",
      open() {
        const runtime = new MemoryRuntime();
        return [runtime, runtime, runtime];
      },
    },
    {
      name: "separate SQLite connections to one file",
      open() {
        const dir = mkdtempSync(join(tmpdir(), "yieldstar-dispatchers-"));
        const path = join(dir, "dispatchers.db");
        const dbs = [0, 1, 2].map(() => createSqliteDb({ path, wal: true }));
        cleanups.push(() => {
          for (const db of dbs) db.close();
          rmSync(dir, { recursive: true, force: true });
        });
        return dbs.map((db) => new SqliteRuntime(db));
      },
    },
  ];
}

for (const backend of sharedBackends()) {
  test(`never gives an execution two live leases across several dispatchers (${backend.name})`, async () => {
    const runtimes = backend.open();
    const ids = Array.from({ length: 30 }, (_, i) => `shared-${i}`);
    for (const id of ids) await admit(runtimes[0], id);

    // One invoker across all dispatchers sees every delivery.
    const { invoker, stats } = stubInvoker(async () => {
      await new Promise((r) => setTimeout(r, 2));
      return { status: "completed", result: "ok" };
    });
    const dispatchers = runtimes.map((runtime) =>
      dispatcherFor(runtime, invoker, { concurrency: 4 })
    );
    for (const dispatcher of dispatchers) dispatcher.start();

    await vi.waitFor(
      async () => {
        for (const id of ids) {
          expect((await runtimes[0].executions.get(id))?.status).toBe("completed");
        }
      },
      { timeout: 5_000 }
    );
    expect(stats.overlaps).toEqual([]);
    // Each execution was delivered exactly once.
    expect(stats.delivered.sort()).toEqual([...ids].sort());
  });
}

// Renewal

test("renews a lease so a delivery longer than one lease period completes with one claim", async () => {
  const runtime = new MemoryRuntime();
  const peer = runtime;
  const { invoker, stats } = stubInvoker(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return { status: "completed", result: "long" };
  });
  const dispatcher = dispatcherFor(runtime, invoker, {
    leaseDuration: 100,
    renewInterval: 25,
  });
  await admit(runtime, "long");
  expect(await dispatcher.tick()).toBe(1);

  // Another dispatcher keeps trying to claim while the delivery runs.
  const stolen: ExecutionLease[] = [];
  const poll = setInterval(async () => {
    stolen.push(...(await peer.executions.claimDue({ limit: 10, duration: 100 })));
  }, 10);
  try {
    await dispatcher.drain();
  } finally {
    clearInterval(poll);
  }
  expect(stolen).toEqual([]);
  expect(stats.delivered).toEqual(["long"]);
  expect(await runtime.executions.get("long")).toMatchObject({
    status: "completed",
    unacknowledgedDeliveryCount: 0,
  });
});

test("stops renewing and does not acknowledge once a renewal returns lost", async () => {
  const runtime = new MemoryRuntime();
  const renewed = deferred();
  vi.spyOn(runtime.executions, "renew").mockImplementation(async () => {
    renewed.resolve();
    return { status: "lost" };
  });
  const acknowledge = vi.spyOn(runtime.executions, "acknowledge");
  const { invoker } = stubInvoker(async () => {
    await renewed.promise;
    return { status: "completed", result: "stale" };
  });
  const dispatcher = dispatcherFor(runtime, invoker, {
    leaseDuration: 100,
    renewInterval: 10,
  });
  await admit(runtime, "lost-renewal");
  await dispatcher.tick();
  await dispatcher.drain();
  expect(runtime.executions.renew).toHaveBeenCalledTimes(1);
  expect(acknowledge).not.toHaveBeenCalled();
  expect((await runtime.executions.get("lost-renewal"))?.outcome).toBeUndefined();
});

// Rejections

test("releases the lease when a delivery replies retry, counting one unacknowledged delivery", async () => {
  const { runtime, clock } = clocked();
  const release = vi.spyOn(runtime.executions, "release");
  let replies = 0;
  const { invoker } = stubInvoker(async () => {
    replies++;
    throw new InfrastructureError(new Error("database is locked"));
  });
  const dispatcher = dispatcherFor(runtime, invoker);
  await admit(runtime, "retry");
  await dispatcher.tick();
  await dispatcher.drain();

  expect(release).toHaveBeenCalledTimes(1);
  expect(await runtime.executions.get("retry")).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 1,
  });
  // Released, not expired: claimable after the redelivery delay, well
  // before the lease would have expired.
  clock.now += redeliveryDelay(1) - 1;
  expect(await dispatcher.tick()).toBe(0);
  clock.now += 1;
  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();
  expect(replies).toBe(2);
});

test("waits a non-zero delay, never shorter than the last, before each redelivery after a retry", async () => {
  const { runtime, clock } = clocked();
  const { invoker } = stubInvoker(async () => {
    throw new Error("retry");
  });
  const dispatcher = dispatcherFor(runtime, invoker);
  await admit(runtime, "backoff");
  await dispatcher.tick();
  await dispatcher.drain();

  const delays: number[] = [];
  const step = 100;
  for (let i = 0; i < 4; i++) {
    let waited = 0;
    while ((await dispatcher.tick()) === 0) {
      clock.now += step;
      waited += step;
      if (waited > 3_600_000) throw new Error("never redelivered");
    }
    await dispatcher.drain();
    delays.push(waited);
  }
  expect(delays.every((d) => d > 0)).toBe(true);
  for (let i = 1; i < delays.length; i++) {
    expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
  }
  expect((await runtime.executions.get("backoff"))?.unacknowledgedDeliveryCount).toBe(5);
});

test("counts both a retry reply and a later lease expiry", async () => {
  const { runtime, clock } = clocked();
  const replies: (() => never)[] = [
    () => {
      throw new Error("retry");
    },
    () => {
      throw new WorkerExitedError("Worker process exited before replying (code 1)");
    },
  ];
  const { invoker } = stubInvoker(async () => replies.shift()!());
  const release = vi.spyOn(runtime.executions, "release");
  const dispatcher = dispatcherFor(runtime, invoker);
  await admit(runtime, "both");

  await dispatcher.tick();
  await dispatcher.drain();
  clock.now += redeliveryDelay(1);
  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();
  expect(release).toHaveBeenCalledTimes(1);

  clock.now += DEFAULT_LEASE_DURATION;
  expect(await runtime.executions.get("both")).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 2,
  });
});

test("resets the count when a delivery is acknowledged after several retries, so the next wake is not delayed", async () => {
  const { runtime, clock } = clocked();
  let failures = 3;
  const { invoker } = stubInvoker(async () => {
    if (failures-- > 0) throw new Error("retry");
    return { status: "suspended" };
  });
  const dispatcher = dispatcherFor(runtime, invoker);
  await admit(runtime, "recovers");
  for (let i = 0; i < 4; i++) {
    while ((await dispatcher.tick()) === 0) clock.now += 100;
    await dispatcher.drain();
  }
  expect(await runtime.executions.get("recovers")).toMatchObject({
    status: "suspended",
    unacknowledgedDeliveryCount: 0,
  });

  await runtime.executions.requestWake({ executionId: "recovers", wakeAt: clock.now });
  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();
});

test("leaves the lease to expire when the worker exits without replying, then delivers again", async () => {
  const { runtime, clock } = clocked();
  const release = vi.spyOn(runtime.executions, "release");
  const invoker = createWorkerInvoker({
    workerPath: new URL("early-exit.mjs", fixtures).href,
    logger,
  });
  const deliver = vi.spyOn(invoker, "deliver");
  const dispatcher = dispatcherFor(runtime, invoker);
  await admit(runtime, "exits");

  await dispatcher.tick();
  await dispatcher.drain();
  expect(deliver).toHaveBeenCalledTimes(1);
  await expect(deliver.mock.results[0].value).rejects.toBeInstanceOf(WorkerExitedError);
  expect(release).not.toHaveBeenCalled();
  expect((await runtime.executions.get("exits"))?.status).toBe("running");

  // Not claimable while the lease is live, nor until the delay after it.
  clock.now += DEFAULT_LEASE_DURATION + redeliveryDelay(1) - 1;
  expect(await dispatcher.tick()).toBe(0);
  clock.now += 1;
  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();
  expect(deliver).toHaveBeenCalledTimes(2);
  // The expired lease counts as one unacknowledged delivery.
  expect((await runtime.executions.get("exits"))?.unacknowledgedDeliveryCount).toBe(1);
});

// Driver

test("ends a delivery as a retry when a step is already recorded with a different value, and replays the recorded value", async () => {
  const { runtime, clock } = clocked();
  let runs = 0;
  const router = {
    charge: workflow(async function* (step) {
      return yield* step.run("charge", () => {
        runs++;
        return { receipt: `r-${runs}` };
      });
    }),
  };
  const runner = new WorkflowRunner(runtime, { router, logger });
  const invoker = createTestInvoker({ runner, logger });
  const deliver = vi.spyOn(invoker, "deliver");
  const dispatcher = dispatcherFor(runtime, invoker);

  // Another write records the step between this delivery's read and write.
  const writeStep = runtime.heap.writeStep.bind(runtime.heap);
  vi.spyOn(runtime.heap, "writeStep").mockImplementationOnce(async (params) => {
    await writeStep({
      ...params,
      stepResponseJson: params.stepResponseJson.replace("r-1", "r-recorded"),
    });
    return writeStep(params);
  });

  await admit(runtime, "conflict", "charge");
  await dispatcher.tick();
  await dispatcher.drain();
  await expect(deliver.mock.results[0].value).rejects.toMatchObject({
    name: "InfrastructureError",
    cause: { name: "StepConflictError", stepKey: "charge" },
  });
  expect(await runtime.executions.get("conflict")).toMatchObject({
    status: "admitted",
    unacknowledgedDeliveryCount: 1,
  });

  clock.now += redeliveryDelay(1);
  expect(await dispatcher.tick()).toBe(1);
  await dispatcher.drain();
  expect(await runtime.executions.get("conflict")).toMatchObject({
    status: "completed",
    outcome: { status: "completed", result: { receipt: "r-recorded" } },
  });
  expect(runs).toBe(1);
});

// Aborting a delivery whose lease is lost

test("a renewal that returns lost stops the delivery before its next step function, with no further fenced writes", async () => {
  const runtime = new MemoryRuntime();
  const slowStarted = deferred();
  const renewLost = deferred();
  const ran: string[] = [];
  const router = {
    leaseLost: workflow(async function* (step) {
      yield* step.run("before", () => ran.push("before"));
      yield* step.run("slow", async () => {
        ran.push("slow");
        slowStarted.resolve();
        await renewLost.promise;
        // The dispatcher aborts the signal as the renewal settles.
        await new Promise((r) => setTimeout(r, 5));
        return "finished after the lease was lost";
      });
      yield* step.run("after", () => ran.push("after"));
      return "done";
    }),
  };
  const runner = new WorkflowRunner(runtime, { router, logger });
  const invoker = createTestInvoker({ runner, logger });
  const deliver = vi.spyOn(invoker, "deliver");
  vi.spyOn(runtime.executions, "renew").mockImplementation(async () => {
    await slowStarted.promise;
    renewLost.resolve();
    return { status: "lost" };
  });
  const writeStep = vi.spyOn(runtime.heap, "writeStep");
  const acknowledge = vi.spyOn(runtime.executions, "acknowledge");
  const release = vi.spyOn(runtime.executions, "release");
  const dispatcher = dispatcherFor(runtime, invoker, {
    leaseDuration: 1_000,
    renewInterval: 10,
  });

  await admit(runtime, "lease-lost", "leaseLost");
  await dispatcher.tick();
  await dispatcher.drain();

  const signal = deliver.mock.calls[0][1].signal;
  expect(signal.aborted).toBe(true);
  await expect(deliver.mock.results[0].value).rejects.toMatchObject({
    name: "InfrastructureError",
    cause: { name: "LeaseLostError", executionId: "lease-lost" },
  });
  expect(ran).toEqual(["before", "slow"]);
  // Only the step finished before the lease was lost was written.
  expect(writeStep.mock.calls.map(([params]) => params.stepKey)).toEqual(["before"]);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(await runtime.executions.get("lease-lost")).toMatchObject({ status: "running" });
});

test("a renewal that returns lost stops a worker's delivery before its next step function, with no further fenced writes", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "yieldstar-lease-lost-"));
  const db = createSqliteDb({ path: join(dir, "shared.db"), wal: true });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = new SqliteRuntime(db);
  const invoker = createWorkerInvoker({
    workerPath: new URL("lease-lost-worker.mjs", fixtures).href,
    logger,
  });
  const deliver = vi.spyOn(invoker, "deliver");
  // The lease stays current in the database, so only the abort can stop the
  // worker's writes: fencing alone would let them land.
  vi.spyOn(runtime.executions, "renew").mockImplementation(async () => {
    await vi.waitFor(() => expect(existsSync(join(dir, "slow-started"))).toBe(true), {
      timeout: 5_000,
      interval: 5,
    });
    return { status: "lost" };
  });
  const acknowledge = vi.spyOn(runtime.executions, "acknowledge");
  const release = vi.spyOn(runtime.executions, "release");
  const dispatcher = dispatcherFor(runtime, invoker, {
    leaseDuration: 5_000,
    renewInterval: 10,
  });

  await runtime.executions.admit({
    executionId: "worker-lease-lost",
    workflowId: "lease-lost",
    params: { dir },
    context: new Map(),
  });
  await dispatcher.tick();
  await dispatcher.drain();

  await expect(deliver.mock.results[0].value).rejects.toMatchObject({
    name: "InfrastructureError",
    cause: { name: "LeaseLostError", executionId: "worker-lease-lost" },
  });
  expect(existsSync(join(dir, "after-ran"))).toBe(false);
  expect(readFileSync(join(dir, "writes"), "utf8")).toBe("worker-lease-lost before\n");
  expect(
    await runtime.heap.readStep({ executionId: "worker-lease-lost", stepKey: "slow" })
  ).toBeNull();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(await runtime.executions.get("worker-lease-lost")).toMatchObject({
    status: "running",
  });
});

// Abandoning a delivery that does not stop after its lease is lost

test("frees the slot of an in-process delivery whose step function hangs after the lease is lost, and the hung step makes no write", async () => {
  const runtime = new MemoryRuntime();
  const hangStarted = deferred();
  const hang = deferred();
  const router = {
    hangs: workflow(async function* (step) {
      yield* step.run("before", () => "written");
      yield* step.run("hang", async () => {
        hangStarted.resolve();
        await hang.promise;
        return "finished long after the lease was lost";
      });
      return "unreachable";
    }),
    quick: workflow(async function* () {
      return "quick";
    }),
  };
  const runner = new WorkflowRunner(runtime, { router, logger });
  const invoker = createTestInvoker({ runner, logger });
  const deliver = vi.spyOn(invoker, "deliver");
  const renew = runtime.executions.renew.bind(runtime.executions);
  vi.spyOn(runtime.executions, "renew").mockImplementation(async (request) => {
    if (request.lease.executionId !== "hung") return renew(request);
    await hangStarted.promise;
    return { status: "lost" };
  });
  const writeStep = vi.spyOn(runtime.heap, "writeStep");
  const acknowledge = vi.spyOn(runtime.executions, "acknowledge");
  const release = vi.spyOn(runtime.executions, "release");
  const dispatcher = dispatcherFor(runtime, invoker, {
    concurrency: 1,
    leaseDuration: 1_000,
    renewInterval: 10,
    abortGracePeriod: 50,
  });

  await admit(runtime, "hung", "hangs");
  await dispatcher.tick();
  await hangStarted.promise;
  await admit(runtime, "next", "quick");
  dispatcher.start();

  // The hung delivery's slot is freed, so the next execution is delivered.
  await vi.waitFor(
    async () => expect((await runtime.executions.get("next"))?.status).toBe("completed"),
    { timeout: 2_000 }
  );
  expect(deliver.mock.calls.map(([event]) => event.executionId)).toEqual(["hung", "next"]);

  // The hung step function finishes late; its write is stopped by the signal.
  hang.resolve();
  await expect(deliver.mock.results[0].value).rejects.toMatchObject({
    name: "InfrastructureError",
    cause: { name: "LeaseLostError", executionId: "hung" },
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(
    writeStep.mock.calls
      .filter(([params]) => params.lease.executionId === "hung")
      .map(([params]) => params.stepKey)
  ).toEqual(["before"]);
  expect(acknowledge.mock.calls.map(([request]) => request.lease.executionId)).toEqual(["next"]);
  expect(release).not.toHaveBeenCalled();
  expect(await runtime.executions.get("hung")).toMatchObject({ status: "running" });
});

for (const late of ["resolves", "rejects"] as const) {
  test(`ignores an abandoned delivery that ${late} late: no acknowledgement, no release, no unhandled rejection`, async () => {
    const runtime = new MemoryRuntime();
    const started = deferred();
    const gate = deferred();
    // An invoker that ignores its signal entirely.
    const { invoker } = stubInvoker(async () => {
      started.resolve();
      await gate.promise;
      if (late === "rejects") throw new Error("late failure");
      return { status: "completed", result: "late" };
    });
    vi.spyOn(runtime.executions, "renew").mockImplementation(async () => {
      await started.promise;
      return { status: "lost" };
    });
    const acknowledge = vi.spyOn(runtime.executions, "acknowledge");
    const release = vi.spyOn(runtime.executions, "release");
    const warnings: string[] = [];
    const dispatcher = new ExecutionDispatcher(runtime, {
      invoker,
      logger: {
        ...logger,
        warn: (_: unknown, message: string) => warnings.push(message),
      } as unknown as Logger,
      pollInterval: 1,
      keepAlive: false,
      leaseDuration: 1_000,
      renewInterval: 10,
      abortGracePeriod: 20,
    });
    cleanups.push(() => dispatcher.stop());
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    cleanups.push(() => process.off("unhandledRejection", unhandled));

    await admit(runtime, "abandoned");
    await dispatcher.tick();
    // drain settles once the delivery is abandoned, not when it finishes.
    await dispatcher.drain();
    expect(dispatcher.activeDeliveries).toBe(0);
    expect(warnings).toContain(
      "Delivery did not stop within the abort grace period after its lease was lost; abandoning it"
    );

    gate.resolve();
    await vi.waitFor(() =>
      expect(warnings.some((message) => message.startsWith("Abandoned delivery"))).toBe(true)
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(await runtime.executions.get("abandoned")).toMatchObject({ status: "running" });
  });
}

test("kills a worker whose step function hangs after the lease is lost, frees its slot at once, and the hung step makes no write", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "yieldstar-hung-worker-"));
  const db = createSqliteDb({ path: join(dir, "shared.db"), wal: true });
  let workerPid: number | undefined;
  cleanups.push(() => {
    if (workerPid && isAlive(workerPid)) process.kill(workerPid, "SIGKILL");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = new SqliteRuntime(db);
  const invoker = createWorkerInvoker({
    workerPath: new URL("lease-lost-worker.mjs", fixtures).href,
    logger,
  });
  const deliver = vi.spyOn(invoker, "deliver");
  // The lease stays current in the database, so only the kill can stop the
  // hung step's write: fencing alone would let it land once the step returns.
  const renew = runtime.executions.renew.bind(runtime.executions);
  vi.spyOn(runtime.executions, "renew").mockImplementation(async (request) => {
    if (request.lease.executionId !== "hung-worker") return renew(request);
    await vi.waitFor(() => expect(existsSync(join(dir, "slow-started"))).toBe(true), {
      timeout: 5_000,
      interval: 5,
    });
    workerPid = Number(readFileSync(join(dir, "pid"), "utf8"));
    return { status: "lost" };
  });
  const acknowledge = vi.spyOn(runtime.executions, "acknowledge");
  const release = vi.spyOn(runtime.executions, "release");
  // A grace period far longer than the test: only the kill can free the slot.
  const dispatcher = dispatcherFor(runtime, invoker, {
    concurrency: 1,
    leaseDuration: 5_000,
    renewInterval: 10,
    abortGracePeriod: 60_000,
  });

  const slowMs = 1_500;
  await runtime.executions.admit({
    executionId: "hung-worker",
    workflowId: "lease-lost",
    params: { dir, slowMs },
    context: new Map(),
  });
  await runtime.executions.admit({
    executionId: "next-worker",
    workflowId: "quick",
    params: { dir },
    context: new Map(),
  });
  const started = Date.now();
  dispatcher.start();

  await vi.waitFor(
    async () =>
      expect((await runtime.executions.get("next-worker"))?.status).toBe("completed"),
    { timeout: 5_000, interval: 10 }
  );
  // The slot was freed by the kill, before the hung step could have returned.
  expect(Date.now() - started).toBeLessThan(slowMs);
  await expect(deliver.mock.results[0].value).rejects.toMatchObject({
    name: "InfrastructureError",
    cause: { name: "LeaseLostError", executionId: "hung-worker" },
  });
  await expect(deliver.mock.results[0].value).rejects.not.toBeInstanceOf(WorkerExitedError);
  expect(workerPid).toBeTypeOf("number");
  await vi.waitFor(() => expect(isAlive(workerPid!)).toBe(false), { timeout: 2_000 });

  // Wait past the point where the hung step would have returned and written.
  await new Promise((r) => setTimeout(r, slowMs - (Date.now() - started) + 300));
  const writes = readFileSync(join(dir, "writes"), "utf8").trim().split("\n");
  expect(writes.filter((line) => line.startsWith("hung-worker "))).toEqual([
    "hung-worker before",
  ]);
  expect(
    await runtime.heap.readStep({ executionId: "hung-worker", stepKey: "slow" })
  ).toBeNull();
  expect(acknowledge.mock.calls.map(([request]) => request.lease.executionId)).toEqual([
    "next-worker",
  ]);
  expect(release).not.toHaveBeenCalled();
  expect(await runtime.executions.get("hung-worker")).toMatchObject({ status: "running" });
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
