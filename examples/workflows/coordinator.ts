import type { Logger } from "pino";
import type { WorkflowFn } from "yieldstar";
import { workflow } from "yieldstar";

type CustomWorkflowFn<Params, Result> = (
  step: Parameters<WorkflowFn<any, Result, any>>[0],
  waitForState: (s: string) => AsyncGenerator
) => AsyncGenerator<any, Result>;

// essentially a custom step
const waitForStateFactory = (step: any, event: any, logger: Logger) =>
  async function* (state: string) {
    yield* step.poll({ maxAttempts: 10, retryInterval: 1000 }, () => {
      logger.info("Polling...");
      // check state matches
      return true;
    });
  };

const workflowFactory = <Params, Result>(
  workflowFn: CustomWorkflowFn<Params, Result>
) => {
  return workflow(async function* (step, event, logger) {
    const waitForState = waitForStateFactory(step, event, logger);
    return yield* workflowFn(step, waitForState);
  });
};

export const coordinatorWorkflow = workflowFactory(async function* (
  step,
  waitForState
) {
  const a = yield* step.run(() => 2);
  yield* waitForState("enabled");
  return yield* step.run(() => a * 3);
});
