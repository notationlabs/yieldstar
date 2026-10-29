import type { Logger } from "pino";
import type {
  DeliveryOptions,
  WorkflowEvent,
  WorkflowInvoker,
  WorkflowRunner,
} from "@yieldstar/core";
import { EventEmitter } from "node:events";

/** Runs deliveries in-process with the same `deliver` contract as the worker invoker. */
export function createWorkflowInvoker(params: {
  logger: Logger;
  runner: WorkflowRunner<any>;
}): WorkflowInvoker {
  const workflowEndEmitter = new EventEmitter();
  const { logger, runner } = params;
  return {
    workflowEndEmitter,
    async deliver(event: WorkflowEvent, { lease, signal }: DeliveryOptions) {
      const { executionId } = event;
      logger.info({ executionId }, "Starting workflow delivery");
      return runner.run(event, { lease, signal, logger });
    },
  };
}
