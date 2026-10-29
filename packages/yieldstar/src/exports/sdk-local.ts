import type {
  EventParamsOf,
  ExecutionClient,
  WorkflowRouter,
  WorkflowInvoker,
  TriggerEvent,
  WorkflowGeneratorReturnType,
} from "@yieldstar/core";
import {
  ExecutionAdmissionError,
  waitForExecutionOutcome,
} from "@yieldstar/core";

type TriggerAck = {
  executionId: string;
};

export function createLocalSdk<W extends WorkflowRouter>(
  runtime: { executions: ExecutionClient },
  options?: {
    /** Lets `triggerAndWait` settle as soon as the dispatcher acknowledges. */
    invoker?: WorkflowInvoker;
    /** Milliseconds between reads of the execution record. @default 25 */
    pollInterval?: number;
  }
) {
  const { executions } = runtime;

  return {
    /**
     * Admits an execution and resolves once admission commits. A dispatcher
     * delivers it; this does not wait for a worker to start.
     * @throws {ExecutionAdmissionError} when the ID is already in use or the
     * event cannot be stored without loss
     */
    async trigger<K extends string & keyof W>(
      event: TriggerEvent<K, EventParamsOf<W[K]>>
    ): Promise<TriggerAck> {
      const admission = await executions.admit({
        executionId: event.executionId,
        workflowId: event.workflowId,
        params: event.params,
        context: new Map(Object.entries(event.context ?? {})),
      });
      if (admission.status === "rejected") {
        throw new ExecutionAdmissionError(admission.code, admission.message);
      }
      return { executionId: admission.executionId };
    },
    /**
     * Admits an execution and waits for its record to reach a terminal
     * status. Resolves with the result, or rejects with the recorded error.
     */
    async triggerAndWait<K extends string & keyof W>(
      event: TriggerEvent<K, EventParamsOf<W[K]>>
    ): Promise<WorkflowGeneratorReturnType<W[K]>> {
      const { executionId } = await this.trigger(event);
      const outcome = await waitForExecutionOutcome(executions, executionId, {
        emitter: options?.invoker?.workflowEndEmitter,
        pollInterval: options?.pollInterval,
      });
      if (!outcome) {
        throw new Error(`Execution "${executionId}" has no record`);
      }
      if (outcome.status === "failed") throw outcome.error;
      return outcome.result as WorkflowGeneratorReturnType<W[K]>;
    },
  };
}
