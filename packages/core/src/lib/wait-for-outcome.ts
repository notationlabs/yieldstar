import type { EventEmitter } from "node:events";
import type { ExecutionClient, ExecutionOutcome } from "../base/execution";
import { isTerminalExecutionStatus } from "../base/execution";

/**
 * Resolves with an execution's outcome once its record is terminal, or with
 * undefined if no record exists. The record is the source of truth, so this
 * settles even if the process that ran the execution restarted. An optional
 * `emitter` (the invoker's deprecated `workflowEndEmitter`) only nudges an
 * early re-read.
 */
export async function waitForExecutionOutcome(
  executions: Pick<ExecutionClient, "get">,
  executionId: string,
  options?: { emitter?: EventEmitter; pollInterval?: number; signal?: AbortSignal }
): Promise<ExecutionOutcome | undefined> {
  const pollInterval = options?.pollInterval ?? 25;
  const emitter = options?.emitter;
  let wake: (() => void) | undefined;
  const nudge = () => wake?.();
  emitter?.on(executionId, nudge);
  try {
    while (true) {
      options?.signal?.throwIfAborted();
      const record = await executions.get(executionId);
      if (!record) return undefined;
      if (isTerminalExecutionStatus(record.status)) return record.outcome;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollInterval);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    emitter?.off(executionId, nudge);
  }
}
