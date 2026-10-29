import type { EventEmitter } from "node:events";
import type { WorkflowEvent } from "./event";
import type { ExecutionLease, WorkflowRunOutcome } from "./execution";

export type DeliveryOptions = {
  /** Every fenced write the delivery makes carries this lease. */
  lease: ExecutionLease;
  /**
   * Aborted when the delivery must stop: the dispatcher aborts it, with a
   * `LeaseLostError` as its reason, when a renewal returns `lost`. The driver
   * checks it before each step function and each fenced write, and ends an
   * aborted delivery without running more workflow code.
   */
  signal: AbortSignal;
};

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
   * worker exits before replying. Once `options.signal` aborts, the delivery runs
   * no more workflow code and makes no more fenced writes; it rejects with an
   * `InfrastructureError` whose cause is the signal's reason. An invoker that
   * can stop a step function already running, as the worker invoker does by
   * killing its worker, should do so and reject at once. The dispatcher
   * abandons a delivery that has not settled within its `abortGracePeriod`
   * of the abort, and frees its slot.
   *
   * A worker that exits before replying rejects with a `WorkerExitedError`:
   * the dispatcher then leaves the lease to expire, because the worker's last
   * writes may still be landing. Every other rejection is a retry reply, and
   * the dispatcher releases the lease.
   */
  deliver(event: WorkflowEvent, options: DeliveryOptions): Promise<WorkflowRunOutcome>;
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
