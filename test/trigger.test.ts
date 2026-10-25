import type { WorkflowFn } from "yieldstar";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { workflow } from "yieldstar";
import { createSdk } from "./sdk";

// todo – use sqlite runtime
test("triggering a workflow", async () => {
  const mockWorkflowGenerator = vi.fn<WorkflowFn<any, any, any>>(async function* (
    step
  ) {
    return yield* step.run(() => 1);
  });

  const testWorkflow = workflow(mockWorkflowGenerator);
  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  await sleep(1);

  expect(result).toBeDefined();
  expect(mockWorkflowGenerator).toBeCalledTimes(1);
});
