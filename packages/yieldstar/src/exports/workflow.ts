import type { Logger } from "pino";
import type {
  WorkflowEvent,
  WorkflowGenerator,
  EventParams,
  EventContext,
} from "@yieldstar/core";
import type { StepRunner } from "../internal/step-runner";
import { isIterable } from "../internal/utils";
import {
  deserializeStepResponse,
  serializeStepResponse,
} from "../internal/serialise";
import { createStepRunner } from "../internal/step-runner";
import {
  StepRuntimeCall,
  executeRuntimeCall,
  infrastructure,
} from "../internal/runtime-call";
import {
  StepResponse,
  StepKey,
  StepError,
  StepResult,
  StepDelay,
  StepCacheCheck,
  StepInvalid,
  StepStoreWait,
  WorkflowResult,
} from "@yieldstar/core";

export type WorkflowFn<
  Params extends EventParams,
  Result,
  Context extends EventContext
> = (
  step: StepRunner,
  event: WorkflowEvent<Params, Context>,
  logger: Logger
) => AsyncGenerator<any, Result>;

export function workflow<
  Params extends EventParams,
  Result,
  Context extends EventContext
>(
  workflowFn: WorkflowFn<Params, Result, Context>
): WorkflowGenerator<Params, Result, Context> {
  /**
   * @description Advances workflow steps, handling any workflow logic, and
   * yielding control to a workflow executor to do async work
   * @yields {StepResponse}
   */
  return async function* workflowGenerator({ event, heapClient, storeClient, logger }) {
    const stepRunner = createStepRunner({ event });
    const workflowIterator = workflowFn(stepRunner, event, logger);
    const { executionId } = event;

    let iteratorResult: IteratorResult<any> | null = null;
    let nextIteratorResult: IteratorResult<any> | null = null;
    const stepKeys = new Set<string>();

    while (true) {
      let stepAttempt = 0;
      let stepKey: string;

      /**
       * If we already have the next iterator result from a previous iteration
       * (e.g. it threw an error and advanced the workflow), use that, otherwise,
       * advance the workflow generator
       */
      if (nextIteratorResult) {
        iteratorResult = nextIteratorResult;
        nextIteratorResult = null;
      } else {
        iteratorResult = await workflowIterator.next();
      }

      /**
       * Get the StepKey from the step runner.
       * If the generator is done, the workflow has returned, so we set a
       * special key for that.
       * Finally, check that this call site wasn't reached before.
       */
      if (iteratorResult.done) {
        stepKey = "$$workflow-result$$";
      } else if (!(iteratorResult.value instanceof StepKey)) {
        throw new Error("Step runners must yield a StepKey object");
      } else {
        stepKey = iteratorResult.value.key;
        if (stepKeys.has(stepKey)) {
          throw new Error("Each step in a loop must have a unique cache key.");
        }
        stepKeys.add(stepKey)
      }

      /**
       * Using the StepKey, retrieve the previous response for this step from
       * the cache
       */
      let cached = await infrastructure(() =>
        heapClient.readStep({
          executionId,
          stepKey,
        })
      );

      /**
       * Increment attempt counter. We'll save this after execution.
       */
      if (cached?.meta) {
        stepAttempt = cached.meta.attempt + 1;
      }

      /**
       * If the step needs to be retried, ignore the cached value
       */
      if (cached?.meta.done === false) {
        cached = null;
      }

      /**
       * If the workflow generator hasn't returned, advance the step runner
       */
      if (!iteratorResult.done) {
        iteratorResult = await workflowIterator.next();
      }

      /**
       * We can now get a StepResponse object from the iterator result.
       * The step runner generator always yields a StepResponse, whereas
       * the workflow generator return value needs to be wrapped.
       */
      let stepResponse: StepResponse;

      if (iteratorResult.done) {
        stepResponse = new WorkflowResult(iteratorResult.value);
      } else {
        stepResponse = iteratorResult.value;
      }

      /**
       * If the first yielded value is a cache check, advance to actual step,
       * passing it the cached value
       */
      if (stepResponse instanceof StepCacheCheck) {
        const cachedResponse = cached
          ? deserializeStepResponse(cached.stepResponseJson)
          : null;
        iteratorResult = await workflowIterator.next(cachedResponse);
        stepResponse = iteratorResult.value;

        /**
         * A step that needs a runtime client yields a request. Make the call
         * here, outside workflow code, and resume the step with its result.
         * An infrastructure error rejects the delivery without resuming it.
         */
        while (stepResponse instanceof StepRuntimeCall) {
          const callResult = await executeRuntimeCall(stepResponse, {
            stores: storeClient,
          });
          iteratorResult = await workflowIterator.next(callResult);
          stepResponse = iteratorResult.value;
        }
      } else if (!(stepResponse instanceof WorkflowResult)) {
        throw new Error("Step runners must yield a CacheCheck object");
      }

      /**
       * Check for invalid iterators e.g. developer didn't use yield* or didn't
       * use a step runner
       * @todo: iterable check should be before StepKey check
       * @todo: not throwing here causes a critical error – should workflow break?
       */
      if (isIterable(stepResponse)) {
        console.log("[ERR] Steps must be yielded using yield*\n");
        stepResponse = new StepInvalid();
      } else if (!(stepResponse instanceof StepResponse)) {
        console.log(
          `[ERR] Iterators should yield a StepResponse. Got ${JSON.stringify(
            stepResponse
          )}`
        );
        stepResponse = new StepInvalid();
      }

      /**
       * Determine if step needs to be retried
       */
      const needsRetry =
        !cached?.meta.done &&
        stepResponse instanceof StepError &&
        // 1-indexed vs 0-indexed
        stepResponse.maxAttempts > stepAttempt + 1;
      const needsWake =
        !cached?.meta.done && stepResponse instanceof StepStoreWait;

      /**
       * If this step attempt is not already cached, cache it
       */
      if (!cached) {
        await infrastructure(() =>
          heapClient.writeStep({
            executionId,
            stepKey,
            stepAttempt,
            stepDone: !needsRetry && !needsWake,
            stepResponseJson: serializeStepResponse(stepResponse),
          })
        );
      }

      /**
       * Once the WorkflowResult is cached, return the WorkflowResult to the
       * upstream consumer e.g the worker
       */
      if (stepResponse instanceof WorkflowResult) {
        return stepResponse;
      }

      /**
       * Once invalid iterator steps have been cached, stop execution
       */
      if (stepResponse instanceof StepInvalid) {
        break;
      }

      /**
       * If step runner yielded a step error, either throw the error back for
       * user to handle, or yield to worker, if it should be retried.
       * (Throwing also advances the workflow generator, so, in that case, we
       * store the next iterator result, and continue to the next step).
       */
      if (stepResponse instanceof StepError) {
        if (needsRetry) {
          yield new StepDelay(Date.now() + stepResponse.retryInterval);
        } else {
          nextIteratorResult = await workflowIterator.throw(stepResponse.err);
          continue;
        }
      }

      /**
       * If the delay has already elapsed, continue straight to next step
       */
      if (stepResponse instanceof StepDelay) {
        if (stepResponse.resumeIn <= Date.now()) {
          continue;
        }
      }

      /**
       * Yield control back to the worker if the stepResponse is not a result
       * i.e. async work is required. (Whenever we receive a StepResult, it's
       * always possible to continue straight to the next step).
       */
      if (!(stepResponse instanceof StepResult)) {
        yield stepResponse;
      }
    }

    /**
     * We only arrive here after a workflow yields an invalid step
     */
    throw new Error(
      "Workflow yielded an invalid step. Steps must be yielded with yield* from a step runner."
    );
  };
}

export const createWorkflow = workflow;
