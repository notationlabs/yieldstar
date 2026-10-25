import type { EventContext } from "@yieldstar/core";
import { workflow } from "yieldstar";

const workflowPlan = [
  { type: "get-number" },
  { type: "delay", duration: 1000 },
  { type: "log" },
  { type: "fail" },
] as const;

export const dynamicWorkflow = workflow<{ msg: string }, void, EventContext>(async function* (
  step,
  event,
  logger
) {
  let lastResult: any;
  for (const action of workflowPlan) {
    switch (action.type) {
      case "get-number":
        lastResult = yield* step.run(() => Math.random());
        break;
      case "delay":
        yield* step.delay(action.duration);
        break;
      case "log":
        yield* step.run(() => {
          logger.info(`Hello ${event.params.msg}: ${lastResult}`);
        });
        break;
      case "fail":
        throw new Error("Workflow failure");
    }
  }
});
