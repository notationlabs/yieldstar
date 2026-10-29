import type { Logger } from "pino";
import type {
  WorkflowGenerator,
  WorkflowEvent,
  EventParams,
  ExecutionLease,
  WorkflowRunOutcome,
} from "..";
import {
  InfrastructureError,
  StepDelay,
  StepStoreWait,
  WorkflowResult,
} from "..";
import type { Runtime } from "../base/runtime";
import type { DeliveryOptions } from "../base/invoker";
import { EventContext } from "../base/event";

export class WorkflowRunner<
  Router extends Record<string, WorkflowGenerator<any, any, any>>
> {
  private runtime: Runtime;
  private router: Router;
  private logger: Logger;

  constructor(runtime: Runtime, options: { router: Router; logger: Logger }) {
    this.runtime = runtime;
    this.router = options.router;
    this.logger = options.logger;
  }

  /**
   * Runs one delivery under `options.lease` and resolves with its outcome.
   * Rejects only with an infrastructure error, which must not be acknowledged
   * as an outcome; a lost lease is one, and so is an aborted `options.signal`.
   */
  run = async (
    event: WorkflowEvent,
    options: DeliveryOptions & { logger?: Logger }
  ): Promise<WorkflowRunOutcome> => {
    const { lease, signal, logger = this.logger } = options;
    const workflow = this.router[event.workflowId];

    if (!workflow) {
      return {
        status: "failed",
        error: new Error(`No workflow registered for "${event.workflowId}"`),
      };
    }

    let response: WorkflowResult<unknown> | StepDelay | StepStoreWait;
    try {
      response = await this.runWorkflows({
        workflow,
        logger,
        event,
        lease,
        signal,
      });
    } catch (err) {
      if (InfrastructureError.is(err)) throw err;
      return { status: "failed", error: toError(err) };
    }

    switch (response.type) {
      case "workflow-result":
        return { status: "completed", result: response.result };
      case "step-delay":
        return { status: "suspended", wakeAt: response.wakeAt };
      case "store-wait":
        return { status: "suspended" };
    }
  };

  private async runWorkflows<
    Params extends EventParams,
    Result,
    Context extends EventContext
  >(params: {
    workflow: WorkflowGenerator<Params, Result, Context>;
    event: WorkflowEvent<Params, Context>;
    lease: ExecutionLease;
    signal: AbortSignal;
    logger: Logger;
  }): Promise<WorkflowResult<Result> | StepDelay | StepStoreWait> {
    const { workflow, event, lease, signal, logger } = params;

    const workflowIterator = workflow({
      event,
      lease,
      signal,
      heapClient: this.runtime.heap,
      storeClient: this.runtime.stores,
      clock: this.runtime.clock,
      logger,
    });

    const iteratorResult = await workflowIterator.next();
    const stageResponse = iteratorResult.value;

    if (iteratorResult.done) {
      return stageResponse as WorkflowResult<Result>;
    }

    // A delay's `wakeAt` is the absolute time it elapses, which is exactly
    // the `wakeAt` the suspended outcome reports.
    if (stageResponse instanceof StepDelay) {
      return stageResponse;
    }

    if (stageResponse instanceof StepStoreWait) {
      return stageResponse;
    }

    throw new Error(
      "Workflow runner critical error. This is likely because your worklow and worker are referencing different versions of @yieldstar/core."
    );
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
