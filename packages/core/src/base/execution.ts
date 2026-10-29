import type { DurableObject } from "./durable-value";
import type { EventContext, EventParams } from "./event";

export type ExecutionStatus =
  | "admitted"
  | "running"
  | "suspended"
  | "completed"
  | "failed";

export type ExecutionOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: Error };

/** The execution and step that started an execution with `step.start`. */
export type ExecutionParent = { executionId: string; stepKey: string };

/**
 * The durable record of one workflow execution. Admission creates it and
 * stores the event once; every delivery reads the event from here.
 *
 * - `admitted`: no delivery has been acknowledged yet.
 * - `running`: the execution has a live lease. When the lease ends without a
 *   terminal acknowledgement, the status returns to `suspended` if any
 *   earlier delivery was acknowledged as suspended, and to `admitted`
 *   otherwise.
 * - `suspended`: the latest acknowledged delivery suspended the workflow.
 * - `completed` and `failed` are terminal. `outcome` is present only in these
 *   states.
 *
 * `parent` is present, and immutable, only on executions admitted by `start`.
 */
export interface ExecutionRecord {
  executionId: string;
  workflowId: string;
  params: EventParams;
  context: EventContext;
  status: ExecutionStatus;
  outcome?: ExecutionOutcome;
  admittedAt: number;
  updatedAt: number;
  /** Consecutive deliveries that ended without an acknowledgement. */
  unacknowledgedDeliveryCount: number;
  parent?: ExecutionParent;
}

export type ExecutionAdmissionErrorCode =
  | "EXECUTION_ID_CONFLICT"
  | "INVALID_EXECUTION_EVENT";

/**
 * A lease on one execution, granted by `claimDue`. `token` is a fencing token:
 * every claim of the execution issues a token greater than every earlier one,
 * and only the current token's fenced writes are accepted. It also identifies
 * the wakes the delivery covers. `expiresAt` is read from the runtime clock;
 * clocks decide only when the execution becomes claimable again, never whose
 * writes count.
 */
export type ExecutionLease = {
  executionId: string;
  token: number;
  expiresAt: number;
};

/**
 * Returned by a fenced write whose lease is no longer current: a higher token
 * has been issued, or the lease has ended. The write changed nothing, and its
 * holder must stop.
 */
export type LeaseLost = { status: "lost" };

export function isLeaseLost(value: unknown): value is LeaseLost {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "lost"
  );
}

/**
 * What a delivery reports once its durable work is finished:
 * - `completed`: the workflow returned a result;
 * - `suspended`: the unfinished step is recorded, and `wakeAt`, when present,
 *   is the earliest time a paused step needs the execution to run again;
 * - `failed`: workflow code threw an uncaught error.
 *
 * Infrastructure errors are never outcomes: the delivery rejects instead.
 */
export type WorkflowRunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "suspended"; wakeAt?: number }
  | { status: "failed"; error: Error };

export type ExecutionAdmissionRequest = {
  executionId?: string;
  workflowId: string;
  params: EventParams;
  context: EventContext;
};

export type ExecutionAdmissionResult =
  | { status: "accepted"; executionId: string }
  | {
      status: "rejected";
      code: ExecutionAdmissionErrorCode;
      message: string;
    };

export type WorkflowStartErrorCode =
  | "INVALID_START_PARAMETERS"
  | "START_REQUEST_MISMATCH";

export type ExecutionStartRequest = {
  /** Identifies the request: the calling execution and its step key. */
  requestId: { executionId: string; stepKey: string };
  workflowId: string;
  params?: DurableObject;
};

export type ExecutionStartResult =
  | { status: "accepted"; executionId: string }
  | {
      status: "rejected";
      code: WorkflowStartErrorCode;
      message: string;
    };

export type ExecutionWakeResult =
  | { status: "requested" }
  | { status: "ignored" }
  | {
      status: "rejected";
      code: "EXECUTION_NOT_FOUND";
      message: string;
    };

export type ExecutionAcknowledgeResult =
  | { status: "suspended" }
  | ExecutionOutcome
  | LeaseLost;

export type ExecutionRenewResult =
  | { status: "renewed"; lease: ExecutionLease }
  | LeaseLost;

export type ExecutionReleaseResult = { status: "released" } | LeaseLost;

export interface ExecutionClient {
  /**
   * Creates the execution record with status `admitted` and makes it due
   * immediately, all-or-nothing. Execution IDs are never reused.
   */
  admit(request: ExecutionAdmissionRequest): Promise<ExecutionAdmissionResult>;

  get(executionId: string): Promise<ExecutionRecord | undefined>;

  /**
   * Starts a workflow on behalf of the execution and step named by
   * `requestId`, idempotently by that ID. A new start admits the target with
   * the caller's context and a parent link to the caller, and records the
   * start request, all-or-nothing. A repeated request returns the first
   * target's ID if its workflow ID and canonical params match, and
   * `START_REQUEST_MISMATCH` otherwise, whatever the target's status. Invalid
   * params return `INVALID_START_PARAMETERS` and admit nothing. Not fenced.
   */
  start(request: ExecutionStartRequest): Promise<ExecutionStartResult>;

  /**
   * Requests a wake from outside a delivery, such as a store commit. Wakes not
   * covered by a claimed delivery merge into one due time: the earliest.
   */
  requestWake(request: {
    executionId: string;
    wakeAt: number;
  }): Promise<ExecutionWakeResult>;

  /**
   * Leases up to `limit` executions whose due time is at or before the runtime
   * clock and that have no live lease, earliest due first. Each lease lasts
   * `duration` milliseconds and carries a token greater than every earlier
   * token for its execution. An execution has at most one live lease at a
   * time, across every client sharing the backend.
   */
  claimDue(request: {
    limit: number;
    duration: number;
    /**
     * Claims only executions whose ID is in this list, as part of the same
     * atomic claim. An empty list claims nothing. When absent, any execution
     * whose due time has passed may be claimed.
     */
    executionIds?: readonly string[];
  }): Promise<ExecutionLease[]>;

  /**
   * Extends a lease to `duration` milliseconds from now. Returns `lost` if a
   * higher token has been issued or the lease has ended. An expired lease
   * that has not been claimed again is still current.
   */
  renew(request: {
    lease: ExecutionLease;
    duration: number;
  }): Promise<ExecutionRenewResult>;

  /**
   * Ends a lease without acknowledging an outcome. The delivery counts as
   * unacknowledged, so the execution becomes claimable again only after the
   * redelivery delay. Returns `lost` for a stale lease.
   */
  release(request: { lease: ExecutionLease }): Promise<ExecutionReleaseResult>;

  /**
   * Records a delivery's outcome and ends its lease, all-or-nothing. A
   * `suspended` outcome clears the wakes the lease covered, leaving the
   * execution due at the earliest of `wakeAt` and any wake requested since the
   * claim. A stale lease returns `lost` and changes nothing.
   */
  acknowledge(request: {
    lease: ExecutionLease;
    outcome: WorkflowRunOutcome;
  }): Promise<ExecutionAcknowledgeResult>;
}

/**
 * Thrown by the driver when a fenced write returns `lost`: another claim has
 * taken over the execution, so this delivery must stop without acknowledging.
 */
export class LeaseLostError extends Error {
  readonly executionId: string;

  constructor(executionId: string) {
    super(`Lease on execution "${executionId}" was lost`);
    this.name = "LeaseLostError";
    this.executionId = executionId;
  }
}

/**
 * Thrown by the driver when the current holder writes a step record that
 * already exists with a different value. The recorded value stands: the
 * delivery ends as a retry, and the next delivery replays the recorded value.
 */
export class StepConflictError extends Error {
  readonly executionId: string;
  readonly stepKey: string;

  constructor(executionId: string, stepKey: string) {
    super(
      `Step "${stepKey}" of execution "${executionId}" is already recorded with a different value`
    );
    this.name = "StepConflictError";
    this.executionId = executionId;
    this.stepKey = stepKey;
  }
}

export class ExecutionAdmissionError extends Error {
  readonly code: ExecutionAdmissionErrorCode;

  constructor(code: ExecutionAdmissionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionAdmissionError";
    this.code = code;
  }
}

/**
 * Thrown to workflow code by `step.start` when the runtime rejects the start.
 * The rejection is recorded as the step's result, so replay throws it again.
 */
export class WorkflowStartError extends Error {
  readonly code: WorkflowStartErrorCode;

  constructor(code: WorkflowStartErrorCode, message: string) {
    super(message);
    this.name = "WorkflowStartError";
    this.code = code;
  }
}

const INFRASTRUCTURE_ERROR = Symbol.for("yieldstar.infrastructureError");

/**
 * Wraps a failure of the runtime rather than of workflow code, such as a heap
 * or store client rejecting. A delivery that hits one rejects without
 * resuming workflow code, and is not acknowledged.
 */
export class InfrastructureError extends Error {
  readonly [INFRASTRUCTURE_ERROR] = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "InfrastructureError";
  }

  static is(value: unknown): value is InfrastructureError {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[INFRASTRUCTURE_ERROR] === true
    );
  }
}

export function isTerminalExecutionStatus(
  status: ExecutionStatus
): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}
