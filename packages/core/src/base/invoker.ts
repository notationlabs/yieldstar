import type { EventEmitter } from "node:events";
import type { WorkflowEvent } from "./event";
import type { ExecutionLease, WorkflowRunOutcome } from "./execution";

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
   * worker exits before replying. Every fenced write the delivery makes
   * carries `lease`.
   *
   * A worker that exits before replying rejects with a `WorkerExitedError`:
   * the dispatcher then leaves the lease to expire, because the worker's last
   * writes may still be landing. Every other rejection is a retry reply, and
   * the dispatcher releases the lease.
   */
  deliver(event: WorkflowEvent, lease: ExecutionLease): Promise<WorkflowRunOutcome>;
};

const WORKER_EXITED = Symbol.for("yieldstar.workerExited");

/**
 * Rejects a delivery whose worker exited, or was killed, before replying.
 * The dispatcher does not release the lease: it expires, and the execution is
 * delivered again after the redelivery delay.
 */
export class WorkerExitedError extends Error {
  readonly [WORKER_EXITED] = true;

  constructor(message: string) {
    super(message);
    this.name = "WorkerExitedError";
  }

  static is(value: unknown): value is WorkerExitedError {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[WORKER_EXITED] === true
    );
  }
}
