import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { Logger } from "pino";
import { expect, test } from "vitest";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";

const logger = { info() {}, error() {} } as unknown as Logger;
const fixtures = new URL("./fixtures/worker-invoker/", import.meta.url);

const which = (runtime: "bun" | "node") => {
  const result = spawnSync("which", [runtime], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const executeAndWait = async ({
  fixture,
  executionId,
  context = new Map(),
  execPath,
  handshakeTimeout,
}: {
  fixture: string;
  executionId: string;
  context?: Map<unknown, unknown>;
  execPath?: string;
  handshakeTimeout?: number;
}) => {
  const invoker = createWorkflowInvoker({
    workerPath: new URL(fixture, fixtures).href,
    execPath,
    handshakeTimeout,
    logger,
  });
  const result = once(invoker.workflowEndEmitter, executionId);

  await invoker.execute({
    workflowId: "workflow",
    executionId,
    params: undefined,
    context,
  });

  return result;
};

test("forks a worker and preserves its Map context", { timeout: 2_000 }, async () => {
  const result = await executeAndWait({
    fixture: "success.mjs",
    executionId: "worker-success",
    context: new Map([["requestId", "request"]]),
  });

  expect(result).toEqual([true]);
});

test("rejects when the worker process cannot spawn", { timeout: 2_000 }, async () => {
  const invoker = createWorkflowInvoker({
    workerPath: new URL("success.mjs", fixtures).href,
    execPath: "/missing/yieldstar-node",
    logger,
  });

  await expect(
    invoker.execute({
      workflowId: "workflow",
      executionId: "worker-spawn-error",
      params: undefined,
      context: new Map(),
    })
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test(
  "emits nothing when a suspended workflow replies without a result",
  { timeout: 2_000 },
  async () => {
    const executionId = "worker-suspend";
    const invoker = createWorkflowInvoker({
      workerPath: new URL("suspend.mjs", fixtures).href,
      logger,
    });
    const emissions: unknown[] = [];
    invoker.workflowEndEmitter.on(executionId, (result) => {
      emissions.push(result);
    });

    await invoker.execute({
      workflowId: "workflow",
      executionId,
      params: undefined,
      context: new Map(),
    });

    // Wait for the killed child to exit so a spurious exit-handler emission would surface
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(emissions).toEqual([]);
  }
);

const parentRuntime = "Bun" in globalThis ? "Bun" : "Node";
const workerRuntime = parentRuntime === "Bun" ? "node" : "bun";
const crossRuntimePath = which(workerRuntime);

test.skipIf(!crossRuntimePath)(
  `surfaces an error when forking a ${workerRuntime} worker under ${parentRuntime} (cross-runtime IPC unsupported)`,
  { timeout: 2_000 },
  async () => {
    const [error] = await executeAndWait({
      fixture: "success.mjs",
      executionId: `worker-cross-runtime-${workerRuntime}`,
      context: new Map([["requestId", "request"]]),
      execPath: crossRuntimePath!,
      handshakeTimeout: 1_000,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/exited before replying|IPC handshake/);
  }
);

test("emits an error when the worker never completes the handshake", { timeout: 2_000 }, async () => {
  const [error] = await executeAndWait({
    fixture: "never-ready.mjs",
    executionId: "worker-never-ready",
    handshakeTimeout: 500,
  });

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/did not complete the IPC handshake within 500ms/);
});

test("emits an error when the worker exits before replying", { timeout: 2_000 }, async () => {
  const [error] = await executeAndWait({
    fixture: "early-exit.mjs",
    executionId: "worker-early-exit",
  });

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/exited before replying \(code 17\)/);
});
