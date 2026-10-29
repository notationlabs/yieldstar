import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { expect, test } from "vitest";
import {
  WorkflowRunner,
  type ExecutionLease,
  type WorkflowEvent,
  type WorkflowRunOutcome,
} from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { createWorkflowInvoker as createTestInvoker } from "@yieldstar/test-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";
// @ts-expect-error – plain .mjs fixture shared with the worker process
import { parityRouter } from "./fixtures/worker-invoker/parity-workflows.mjs";
// @ts-expect-error – plain .mjs fixture shared with the worker process
import { leaseLocally } from "./fixtures/worker-invoker/lease-locally.mjs";

const logger = { info() {}, error() {} } as unknown as Logger;
const fixtures = new URL("./fixtures/worker-invoker/", import.meta.url);

const which = (runtime: "bun" | "node") => {
  const result = spawnSync("which", [runtime], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const event = (overrides: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  workflowId: "workflow",
  executionId: "execution",
  params: undefined,
  context: new Map(),
  ...overrides,
});

const leaseFor = (event: WorkflowEvent): ExecutionLease => ({
  executionId: event.executionId,
  token: 1,
  expiresAt: Date.now() + 30_000,
});

const deliver = ({
  fixture,
  execPath,
  handshakeTimeout,
  ...overrides
}: Partial<WorkflowEvent> & {
  fixture: string;
  execPath?: string;
  handshakeTimeout?: number;
}) =>
  createWorkflowInvoker({
    workerPath: new URL(fixture, fixtures).href,
    execPath,
    handshakeTimeout,
    logger,
  }).deliver(event(overrides), leaseFor(event(overrides)));

test("forks a worker, preserves its Map context and resolves with its outcome", { timeout: 2_000 }, async () => {
  await expect(
    deliver({
      fixture: "success.mjs",
      executionId: "worker-success",
      context: new Map([["requestId", "request"]]),
    })
  ).resolves.toEqual({ status: "completed", result: true });
});

test("resolves with a suspended outcome and its wakeAt", { timeout: 2_000 }, async () => {
  await expect(
    deliver({ fixture: "suspend.mjs", executionId: "worker-suspend" })
  ).resolves.toEqual({ status: "suspended", wakeAt: 1234 });
});

test("rejects when the worker reports an infrastructure error", { timeout: 2_000 }, async () => {
  await expect(
    deliver({ fixture: "infrastructure-error.mjs", executionId: "worker-infra" })
  ).rejects.toThrow("database is locked");
});

test("rejects when the worker process cannot spawn", { timeout: 2_000 }, async () => {
  await expect(
    deliver({
      fixture: "success.mjs",
      executionId: "worker-spawn-error",
      execPath: "/missing/yieldstar-node",
    })
  ).rejects.toMatchObject({ code: "ENOENT" });
});

const parentRuntime = "Bun" in globalThis ? "Bun" : "Node";
const workerRuntime = parentRuntime === "Bun" ? "node" : "bun";
const crossRuntimePath = which(workerRuntime);

test.skipIf(!crossRuntimePath)(
  `rejects when forking a ${workerRuntime} worker under ${parentRuntime} (cross-runtime IPC unsupported)`,
  { timeout: 2_000 },
  async () => {
    await expect(
      deliver({
        fixture: "success.mjs",
        executionId: `worker-cross-runtime-${workerRuntime}`,
        context: new Map([["requestId", "request"]]),
        execPath: crossRuntimePath!,
        handshakeTimeout: 1_000,
      })
    ).rejects.toThrow(/exited before replying|IPC handshake/);
  }
);

test("rejects when the worker never completes the handshake", { timeout: 2_000 }, async () => {
  await expect(
    deliver({
      fixture: "never-ready.mjs",
      executionId: "worker-never-ready",
      handshakeTimeout: 500,
    })
  ).rejects.toThrow(/did not complete the IPC handshake within 500ms/);
});

test("rejects when the worker exits before replying", { timeout: 2_000 }, async () => {
  await expect(
    deliver({ fixture: "early-exit.mjs", executionId: "worker-early-exit" })
  ).rejects.toThrow(/exited before replying \(code 17\)/);
});

test("worker and test invokers deliver the same outcomes", { timeout: 10_000 }, async () => {
  const workerInvoker = createWorkflowInvoker({
    workerPath: new URL("runner.mjs", fixtures).href,
    logger,
  });
  const testRuntime = new MemoryRuntime();
  const testInvoker = createTestInvoker({
    runner: leaseLocally(
      testRuntime,
      new WorkflowRunner(testRuntime, { router: parityRouter, logger })
    ) as WorkflowRunner<any>,
    logger,
  });

  const cases: WorkflowEvent[] = [
    event({
      workflowId: "completes",
      executionId: "parity-completes",
      params: { n: 21 },
      context: new Map([["requestId", "request"]]),
    }),
    event({ workflowId: "fails", executionId: "parity-fails" }),
    event({ workflowId: "suspends", executionId: "parity-suspends" }),
    event({ workflowId: "unregistered", executionId: "parity-unregistered" }),
  ];

  for (const parityEvent of cases) {
    const [fromWorker, fromTest] = await Promise.all([
      workerInvoker.deliver(parityEvent, leaseFor(parityEvent)),
      testInvoker.deliver(parityEvent, leaseFor(parityEvent)),
    ]);
    expect(normalize(fromWorker)).toEqual(normalize(fromTest));
  }
});

/** Errors compare by name and message; delay wake times by their status. */
function normalize(outcome: WorkflowRunOutcome) {
  if (outcome.status === "failed") {
    return {
      status: outcome.status,
      error: { name: outcome.error.name, message: outcome.error.message },
    };
  }
  if (outcome.status === "suspended") {
    return { status: outcome.status, hasWakeAt: typeof outcome.wakeAt === "number" };
  }
  return outcome;
}

test("a worker whose runtime process dies exits and makes no further fenced writes", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "yieldstar-orphan-"));
  const dbPath = join(dir, "orphan.db");
  const markerPath = join(dir, "worker.pid");
  const parent = spawn(
    process.execPath,
    [new URL("orphan-runtime.mjs", fixtures).pathname, dbPath, markerPath],
    { stdio: "inherit", env: { ...process.env, YIELDSTAR_ORPHAN_DB: dbPath } }
  );
  let workerPid: number | undefined;
  try {
    // The worker has written its first step and is inside the second.
    const deadline = Date.now() + 5_000;
    while (!existsSync(markerPath) || readFileSync(markerPath, "utf8") === "") {
      if (Date.now() > deadline) throw new Error("worker never reached its second step");
      await new Promise((r) => setTimeout(r, 10));
    }
    workerPid = Number(readFileSync(markerPath, "utf8"));
    parent.kill("SIGKILL");

    // Wait past the point where the second step would have been written.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(isAlive(workerPid)).toBe(false);

    const { createSqliteDb } =
      "Bun" in globalThis
        ? await import("@yieldstar/sqlite-runtime/bun")
        : await import("@yieldstar/sqlite-runtime/node");
    const db = createSqliteDb({ path: dbPath, wal: true });
    try {
      const runtime = new SqliteRuntime(db);
      expect(await runtime.heap.readStep({ executionId: "orphan", stepKey: "before" })).toMatchObject({
        meta: { done: true },
      });
      expect(await runtime.heap.readStep({ executionId: "orphan", stepKey: "during" })).toBeNull();
      // The lease was neither released nor acknowledged: it is left to expire.
      expect(await runtime.executions.get("orphan")).toMatchObject({ status: "running" });
    } finally {
      db.close();
    }
  } finally {
    parent.kill("SIGKILL");
    if (workerPid && isAlive(workerPid)) process.kill(workerPid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
