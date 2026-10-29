import pino from "pino";
import { WorkflowRunner } from "@yieldstar/core";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { runtime, workflowRouter } from "./shared";

const logger = pino();

const workflowRunner = new WorkflowRunner(runtime, {
  router: workflowRouter,
  logger,
});

const worker = createWorkflowWorker(workflowRunner, logger);

worker.listen();
