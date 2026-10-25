import { workflow } from "yieldstar";

export const pollingWorkflow = workflow(async function* (step, event, logger) {
  let num: number;

  yield* step.poll({ retryInterval: 1000, maxAttempts: 10 }, () => {
    logger.info("Polling");
    num = Math.random();
    return num > 0.75;
  });

  yield* step.run(() => {
    logger.info({ num }, "Poll finished");
  });
});
