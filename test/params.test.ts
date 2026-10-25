import type { WorkflowFn } from "yieldstar";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { workflow } from "yieldstar";
import { createSdk } from "./sdk";

test("passing params to a workflow", async () => {
  const testParams = { foo: "bar", count: 42 };
  let capturedParams: any;

  const mockWorkflowGenerator = vi.fn<WorkflowFn<any, any, any>>(async function* (
    step,
    event
  ) {
    capturedParams = event.params;
    return yield* step.run(() => event.params);
  });

  const testWorkflow = workflow(mockWorkflowGenerator);
  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({
    workflowId: "workflow",
    params: testParams,
  });

  await sleep(1);

  expect(result).toBeDefined();
  expect(mockWorkflowGenerator).toBeCalledTimes(1);
  expect(capturedParams).toEqual(testParams);
  expect(result).toEqual(testParams);
});

test("params are optional", async () => {
  let capturedParams: any;

  const mockWorkflowGenerator = vi.fn<WorkflowFn<any, any, any>>(async function* (
    step,
    event
  ) {
    capturedParams = event.params;
    return yield* step.run(() => event.params || "default value");
  });

  const testWorkflow = workflow(mockWorkflowGenerator);
  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  await sleep(1);

  expect(result).toBeDefined();
  expect(mockWorkflowGenerator).toBeCalledTimes(1);
  expect(capturedParams).toBeUndefined();
  expect(result).toBe("default value");
});
