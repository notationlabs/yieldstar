import type { Logger } from "pino";
import type {
  Durable,
  WorkflowEvent,
  WorkflowGenerator,
  EventParams,
  EventContext,
  IfDurable,
} from "@yieldstar/core";
import type { StepRunner } from "../internal/step-runner";
import { isIterable } from "../internal/utils";
import { decodeStepRecord, encodeStepRecord } from "../internal/step-record";
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
  InfrastructureError,
  LeaseLostError,
  StepConflictError,
  isLeaseLost,
  WORKFLOW_RESULT_STEP_KEY,
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

/**
 * A workflow function whose params and result are durable values. Params are
 * an input, so a function type cannot check them; a missing property named
 * for the problem does instead.
 */
export type DurableWorkflowFn<Params, Result> = IfDurable<
  Params,
  { "Workflow params must be durable values": Durable<Params> }
> &
  IfDurable<
    Result,
    (step: any, event: any, logger: any) => AsyncGenerator<any, Durable<Result>>
  >;

/**
 * Wraps a workflow function in a generator that advances its steps and yields
 * control to the executor whenever a step needs async work.
 */
export function workflow<
  Params extends EventParams,
  Result,
  Context extends EventContext
>(
  workflowFn: WorkflowFn<Params, Result, Context> &
    DurableWorkflowFn<Params, Result>
): WorkflowGenerator<Params, Result, Context> {
  return async function* workflowGenerator({
    event,
    lease,
    signal,
    heapClient,
    storeClient,
    executionClient,
    clock,
    logger,
  }) {
    const stepRunner = createStepRunner({ event, clock });
    const workflowIterator = workflowFn(stepRunner, event, logger);
    const { executionId } = event;

    let iteratorResult: IteratorResult<any> | null = null;
    let nextIteratorResult: IteratorResult<any> | null = null;
    // A step that produced a result resumes with its decoded record, which
    // is what it returns to workflow code.
    let resumeWith: StepResult | undefined;
    const stepKeys = new Set<string>();

    while (true) {
      let stepAttempt = 0;
      let stepKey: string;

      // Throwing a step error into the workflow already advanced it.
      if (nextIteratorResult) {
        iteratorResult = nextIteratorResult;
        nextIteratorResult = null;
      } else {
        stopIfAborted(signal);
        iteratorResult = await workflowIterator.next(resumeWith);
      }
      resumeWith = undefined;

      if (iteratorResult.done) {
        stepKey = WORKFLOW_RESULT_STEP_KEY;
      } else if (!(iteratorResult.value instanceof StepKey)) {
        throw new Error("Step runners must yield a StepKey object");
      } else {
        stepKey = iteratorResult.value.key;
        if (stepKeys.has(stepKey)) {
          throw new Error("Each step in a loop must have a unique cache key.");
        }
        stepKeys.add(stepKey)
      }

      let cached = await infrastructure(() =>
        heapClient.readStep({
          executionId,
          stepKey,
        })
      );

      if (cached?.meta) {
        stepAttempt = cached.meta.attempt + 1;
      }

      // An unfinished record is a failed attempt: run the step again.
      if (cached?.meta.done === false) {
        cached = null;
      }

      if (!iteratorResult.done) {
        iteratorResult = await workflowIterator.next();
      }

      let stepResponse: StepResponse;

      if (iteratorResult.done) {
        stepResponse = new WorkflowResult(iteratorResult.value);
      } else {
        stepResponse = iteratorResult.value;
      }

      if (stepResponse instanceof StepCacheCheck) {
        const cachedResponse = cached
          ? decodeStepRecord(cached.stepResponseJson)
          : null;
        // Resuming the step runs the step function unless it is cached.
        stopIfAborted(signal);
        iteratorResult = await workflowIterator.next(cachedResponse);
        stepResponse = iteratorResult.value;

        // A step that needs a runtime client yields a request. Make the call
        // here, outside workflow code, and resume the step with its result.
        // An infrastructure error rejects the delivery without resuming it.
        while (stepResponse instanceof StepRuntimeCall) {
          stopIfAborted(signal);
          const callResult = await executeRuntimeCall(stepResponse, {
            stores: storeClient,
            executions: executionClient,
          });
          iteratorResult = await workflowIterator.next(callResult);
          stepResponse = iteratorResult.value;
        }
      } else if (!(stepResponse instanceof WorkflowResult)) {
        throw new Error("Step runners must yield a CacheCheck object");
      }

      // TODO: the iterable check should come before the StepKey check.
      // TODO: not throwing here causes a critical error; should the workflow break?
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

      let stepResponseJson: string | undefined;
      // The workflow result is encoded on every delivery, so that an invalid
      // result fails the same way whether or not it is already recorded.
      if (!cached || stepResponse instanceof WorkflowResult) {
        const record = encodeStepRecord(stepResponse, stepKey);
        stepResponseJson = record.json;
        stepResponse = record.response;
      }

      const needsRetry =
        !cached?.meta.done &&
        stepResponse instanceof StepError &&
        // 1-indexed vs 0-indexed
        stepResponse.maxAttempts > stepAttempt + 1;
      const needsWake =
        !cached?.meta.done && stepResponse instanceof StepStoreWait;

      if (!cached && stepResponseJson !== undefined) {
        const done = !needsRetry && !needsWake;
        stopIfAborted(signal);
        const written = await infrastructure(() =>
          heapClient.writeStep({
            lease,
            stepKey,
            stepAttempt,
            done,
            stepResponseJson: stepResponseJson!,
          })
        );
        // Another claim has taken over: stop without an outcome.
        if (isLeaseLost(written)) {
          throw new InfrastructureError(new LeaseLostError(executionId));
        }
        // The step was already recorded with a different value. The record
        // stands, so this delivery must not continue with its own value: end
        // it as a retry, and the next delivery replays the recorded one.
        if (
          written.stepResponseJson !== stepResponseJson ||
          written.meta.done !== done
        ) {
          throw new InfrastructureError(
            new StepConflictError(executionId, stepKey)
          );
        }
      }

      if (stepResponse instanceof WorkflowResult) {
        return stepResponse;
      }

      // Only an invalid workflow result is recorded as a step error under
      // the workflow result's key. The workflow has finished, so it fails.
      if (iteratorResult.done && stepResponse instanceof StepError) {
        throw stepResponse.err;
      }

      if (stepResponse instanceof StepInvalid) {
        break;
      }

      if (stepResponse instanceof StepError) {
        if (needsRetry) {
          yield new StepDelay(clock() + stepResponse.retryInterval);
        } else {
          stopIfAborted(signal);
          nextIteratorResult = await workflowIterator.throw(stepResponse.err);
          continue;
        }
      }

      if (stepResponse instanceof StepDelay) {
        if (stepResponse.wakeAt <= clock()) {
          continue;
        }
      }

      if (stepResponse instanceof StepResult) {
        resumeWith = stepResponse;
      } else {
        yield stepResponse;
      }
    }

    throw new Error(
      "Workflow yielded an invalid step. Steps must be yielded with yield* from a step runner."
    );
  };
}

export const createWorkflow = workflow;

/**
 * Ends the delivery once its signal has aborted, before it runs more workflow
 * code or makes another fenced write. Like a lost lease found by a fenced
 * write, it rejects with an infrastructure error, which is not acknowledged.
 */
function stopIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new InfrastructureError(signal.reason);
}
