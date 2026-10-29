import type { EventContext, EventParams } from "./event";

export type ExecutionStatus = "admitted" | "suspended" | "completed" | "failed";

export type ExecutionOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: Error };

/**
 * The durable record of one workflow execution. Admission creates it and
 * stores the event once; every delivery reads the event from here.
 *
 * - `admitted`: no delivery has been acknowledged yet.
 * - `suspended`: the latest acknowledged delivery suspended the workflow.
 * - `completed` and `failed` are terminal. `outcome` is present only in these
 *   states.
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
}

export type ExecutionAdmissionErrorCode =
  | "EXECUTION_ID_CONFLICT"
  | "INVALID_EXECUTION_EVENT";

/**
 * A claim on a due execution. `token` identifies the wakes the delivery
 * covers; its contents are opaque to callers.
 */
export type ExecutionDelivery = {
  executionId: string;
  token: string;
};

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
  | ExecutionOutcome;

export interface ExecutionClient {
  /**
   * Creates the execution record with status `admitted` and makes it due
   * immediately, all-or-nothing. Execution IDs are never reused.
   */
  admit(request: ExecutionAdmissionRequest): Promise<ExecutionAdmissionResult>;

  get(executionId: string): Promise<ExecutionRecord | undefined>;

  /**
   * Requests a wake from outside a delivery, such as a store commit. Wakes not
   * covered by a claimed delivery merge into one due time: the earliest.
   */
  requestWake(request: {
    executionId: string;
    wakeAt: number;
  }): Promise<ExecutionWakeResult>;

  /**
   * Claims executions whose due time is at or before the runtime clock. An
   * execution appears at most once, and is not returned again until it is
   * acknowledged or its redelivery timeout passes.
   */
  claimDue(): Promise<ExecutionDelivery[]>;

  /**
   * Records a delivery's outcome and clears the wakes it covered. Terminal
   * outcomes are immutable: later acknowledgements return the first one.
   */
  acknowledge(request: {
    delivery: ExecutionDelivery;
    outcome: WorkflowRunOutcome;
  }): Promise<ExecutionAcknowledgeResult>;
}

export class ExecutionAdmissionError extends Error {
  readonly code: ExecutionAdmissionErrorCode;

  constructor(code: ExecutionAdmissionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionAdmissionError";
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
