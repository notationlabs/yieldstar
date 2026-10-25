import { expect, test } from "vitest";
import { createWorkflow } from "yieldstar";
import { createSdk } from "./sdk";

test("failing steps can be caught", async () => {
  const workflow = createWorkflow(async function* (step) {
    try {
      yield* step.run(async () => {
        throw new Error("Step error");
      });
    } catch {
      return true;
    }
  });

  const sdk = createSdk({ workflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  expect(result).toBe(true);
});

test("triggerAndWait rejects workflow errors", async () => {
  const workflow = createWorkflow(async function* () {
    throw new Error("Workflow error");
  });
  const sdk = createSdk({ workflow });

  await expect(
    sdk.triggerAndWait({ workflowId: "workflow" })
  ).rejects.toThrow("Workflow error");
});

test.skip("errors should be thrown by trigger", async () => {
  const workflow = createWorkflow(async function* (step) {
    throw new Error("Step error");
  });
  const sdk = createSdk({ workflow });
  expect(() => sdk.trigger({ workflowId: "workflow" })).toThrow();
});
