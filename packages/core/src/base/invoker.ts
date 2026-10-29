import type { EventEmitter } from "node:events";
import type { WorkflowEvent } from "./event";
import type { WorkflowRunOutcome } from "./execution";

export type WorkflowInvoker = {
  /**
   * @deprecated The execution record is the source of truth for outcomes.
   * The dispatcher still emits terminal outcomes here as an in-process fast
   * path; no guarantee depends on it.
   */
  workflowEndEmitter: EventEmitter;
  /**
   * Runs one delivery of an execution and resolves with its outcome. Rejects,
   * without an outcome, when the delivery hits an infrastructure error or the
   * worker exits before replying.
   */
  deliver(event: WorkflowEvent): Promise<WorkflowRunOutcome>;
};
