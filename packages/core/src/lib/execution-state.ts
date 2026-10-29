import type { EventContext, EventParams } from "../base/event";
import type {
  ExecutionAcknowledgeResult,
  ExecutionLease,
  ExecutionOutcome,
  ExecutionParent,
  ExecutionRecord,
  ExecutionReleaseResult,
  ExecutionRenewResult,
  ExecutionStartRequest,
  ExecutionStartResult,
  ExecutionStatus,
  LeaseLost,
  WorkflowRunOutcome,
} from "../base/execution";
import { isTerminalExecutionStatus } from "../base/execution";
import type { DurableValue } from "../base/durable-value";
import {
  decodeParsedValue,
  durableValueCodec,
  encodeThrownValue,
  isPlainObject,
} from "../base/durable-value";
import { WORKFLOW_RESULT_STEP_KEY, WorkflowValueError } from "../base/errors";
import { ReadOnlyMap } from "../utils/map";

/**
 * Storage-neutral state of one execution record, with the event and outcome
 * already encoded. Runtime adapters persist these fields however they like and
 * apply the transitions below inside one atomic write, so every adapter keeps
 * the same lease, wake and acknowledgement semantics.
 *
 * Lease transitions (claim, renew, release) do not change `updatedAt`.
 */
export type ExecutionState = {
  executionId: string;
  workflowId: string;
  params: string;
  context: string;
  /**
   * The status the execution rests in when it has no live lease. The record's
   * `running` status is derived from the lease and the clock by
   * `executionStatusAt`, so an expired lease reads as ended without a write.
   */
  status: Exclude<ExecutionStatus, "running">;
  outcome: string | null;
  admittedAt: number;
  updatedAt: number;
  /** The earliest of the wakes not covered by a lease. */
  dueAt: number | null;
  /**
   * The wakes the current lease covers. They stay pending until that lease is
   * acknowledged, so a lease that is released or expires leaves them due.
   */
  claimedDueAt: number | null;
  /** The highest token issued for this execution (0 before the first claim). */
  leaseToken: number;
  /**
   * Non-null while the lease with `leaseToken` is held, that is, claimed and
   * not yet released or acknowledged. A held lease stays current after it
   * expires, until a later claim issues a higher token.
   */
  leaseExpiresAt: number | null;
  /**
   * Consecutive leases that ended by release or by expiry and a later claim.
   * It does not include a held lease that has expired;
   * `unacknowledgedDeliveryCountAt` adds that one.
   */
  unacknowledgedDeliveryCount: number;
  /**
   * When a released execution may be claimed again. A held lease's delay is
   * measured from `leaseExpiresAt` instead.
   */
  redeliverAt: number | null;
  /** Set at admission by `start`, and never changed. */
  parent: ExecutionParent | null;
};

export const DEFAULT_LEASE_DURATION = 30_000;

/** The redelivery delay after one unacknowledged delivery. */
export const REDELIVERY_DELAY_BASE = 1_000;

export const REDELIVERY_DELAY_MAX = 300_000;

/**
 * How long an execution waits after a delivery ends unacknowledged before it
 * can be claimed again. Starts at `REDELIVERY_DELAY_BASE` and doubles with
 * each consecutive unacknowledged delivery, up to `REDELIVERY_DELAY_MAX`.
 */
export function redeliveryDelay(unacknowledgedDeliveryCount: number): number {
  if (unacknowledgedDeliveryCount <= 0) return 0;
  const exponent = Math.min(unacknowledgedDeliveryCount - 1, 30);
  return Math.min(REDELIVERY_DELAY_BASE * 2 ** exponent, REDELIVERY_DELAY_MAX);
}

export class ExecutionEventEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEventEncodingError";
  }
}

/**
 * Encodes `params` with the durable value codec and `context` as its entries,
 * so that decoding returns exactly what was admitted. Context keys must be
 * strings. Throws `ExecutionEventEncodingError` for any value the codec
 * rejects.
 */
export function encodeExecutionEvent(event: {
  params: EventParams;
  context: EventContext | undefined;
}): { params: string; context: string } {
  const params = durableValueCodec.encode(event.params);
  if (params.status === "invalid") {
    throw new ExecutionEventEncodingError(`params${params.message.slice(1)}`);
  }
  const entries: unknown[] = [];
  for (const [key, value] of event.context?.entries() ?? []) {
    if (typeof key !== "string") {
      throw new ExecutionEventEncodingError(
        `context: keys must be strings, got ${typeof key}`
      );
    }
    entries.push([key, value]);
  }
  const context = durableValueCodec.encode(entries);
  if (context.status === "invalid") {
    throw new ExecutionEventEncodingError(`context${context.message.slice(1)}`);
  }
  return { params: params.canonical, context: context.canonical };
}

export function decodeExecutionEvent(encoded: {
  params: string;
  context: string;
}): { params: EventParams; context: EventContext } {
  const entries = decodeOrThrow(encoded.context, "context");
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
    )
  ) {
    throw new Error("Invalid execution context encoding: expected [key, value] entries");
  }
  return {
    params: decodeOrThrow(encoded.params, "params") as EventParams,
    context: new ReadOnlyMap(new Map(entries as [string, DurableValue][])),
  };
}

/**
 * Encodes a terminal outcome. A completed result the codec rejects is recorded
 * as a failed outcome with `WorkflowValueError` (`INVALID_STEP_VALUE`), and a
 * failure that is not an error is recorded as `Error(String(value))`.
 */
export function encodeExecutionOutcome(outcome: ExecutionOutcome): string {
  if (outcome.status === "completed") {
    const result = durableValueCodec.encode(outcome.result);
    if (result.status === "encoded") {
      return `{"result":${result.canonical},"status":"completed"}`;
    }
    return encodeFailedOutcome(
      new WorkflowValueError(
        "INVALID_STEP_VALUE",
        WORKFLOW_RESULT_STEP_KEY,
        `Workflow result is not a durable value: ${result.message}`
      )
    );
  }
  return encodeFailedOutcome(outcome.error);
}

function encodeFailedOutcome(error: unknown) {
  // An outcome's error is always an Error, so a thrown value that is not one
  // is recorded as Error(String(value)) even when it is durable.
  const encoded = encodeThrownValue(
    error instanceof Error ? error : new Error(safeString(error))
  );
  return `{"error":${encoded},"status":"failed"}`;
}

export function decodeExecutionOutcome(encoded: string): ExecutionOutcome {
  const parsed = JSON.parse(encoded);
  if (parsed.status === "completed") {
    return { status: "completed", result: decodeParsedValue(parsed.result, "result") };
  }
  const error = decodeParsedValue(parsed.error, "error");
  if (!(error instanceof Error)) {
    throw new Error("Invalid failed outcome encoding: expected an error");
  }
  return { status: "failed", error };
}

function decodeOrThrow(canonical: string, label: string) {
  const decoding = durableValueCodec.decode(canonical);
  if (decoding.status === "invalid") {
    throw new Error(`Invalid ${label} encoding: ${decoding.message}`);
  }
  return decoding.value;
}

function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return "Thrown value is not a durable value";
  }
}

export function createExecutionState(params: {
  executionId: string;
  workflowId: string;
  encoded: { params: string; context: string };
  now: number;
  parent?: ExecutionParent;
}): ExecutionState {
  return {
    executionId: params.executionId,
    workflowId: params.workflowId,
    params: params.encoded.params,
    context: params.encoded.context,
    status: "admitted",
    outcome: null,
    admittedAt: params.now,
    updatedAt: params.now,
    dueAt: params.now,
    claimedDueAt: null,
    leaseToken: 0,
    leaseExpiresAt: null,
    unacknowledgedDeliveryCount: 0,
    redeliverAt: null,
    parent: params.parent ?? null,
  };
}

/** Whether a lease is held and has expired. Such a lease is still current. */
function hasExpiredLease(state: ExecutionState, now: number) {
  return state.leaseExpiresAt !== null && state.leaseExpiresAt <= now;
}

/** The record's status at `now`: `running` while a lease is live. */
export function executionStatusAt(
  state: ExecutionState,
  now: number
): ExecutionStatus {
  if (state.leaseExpiresAt !== null && state.leaseExpiresAt > now) {
    return "running";
  }
  return state.status;
}

/**
 * Consecutive unacknowledged deliveries at `now`, counting a held lease that
 * has expired as ended.
 */
export function unacknowledgedDeliveryCountAt(state: ExecutionState, now: number) {
  return state.unacknowledgedDeliveryCount + (hasExpiredLease(state, now) ? 1 : 0);
}

export function toExecutionRecord(
  state: ExecutionState,
  now: number
): ExecutionRecord {
  const event = decodeExecutionEvent(state);
  return {
    executionId: state.executionId,
    workflowId: state.workflowId,
    params: event.params,
    context: event.context,
    status: executionStatusAt(state, now),
    ...(state.outcome !== null
      ? { outcome: decodeExecutionOutcome(state.outcome) }
      : {}),
    admittedAt: state.admittedAt,
    updatedAt: state.updatedAt,
    unacknowledgedDeliveryCount: unacknowledgedDeliveryCountAt(state, now),
    ...(state.parent !== null ? { parent: { ...state.parent } } : {}),
  };
}

/**
 * The earliest time `claimDue` may return this execution, or null when it has
 * nothing pending. It depends only on the state, not on the clock, so
 * adapters can persist and index it to find due executions.
 */
export function nextClaimAt(state: ExecutionState): number | null {
  if (isTerminalExecutionStatus(state.status)) return null;
  if (state.leaseExpiresAt !== null) {
    // A held lease covers the wakes that were due when it was claimed. Once it
    // expires, it counts as unacknowledged, and the redelivery delay runs
    // from its expiry.
    const due = earliest(state.dueAt, state.claimedDueAt);
    if (due === null) return null;
    return Math.max(
      due,
      state.leaseExpiresAt + redeliveryDelay(state.unacknowledgedDeliveryCount + 1)
    );
  }
  if (state.dueAt === null) return null;
  return state.redeliverAt === null
    ? state.dueAt
    : Math.max(state.dueAt, state.redeliverAt);
}

export function isExecutionClaimable(state: ExecutionState, now: number) {
  const at = nextClaimAt(state);
  return at !== null && at <= now;
}

/**
 * Whether `lease` is the execution's current lease: its token is the highest
 * issued and the lease has not been released or acknowledged. Expiry alone
 * does not end it. Adapters check this in the same atomic write as every
 * fenced write.
 */
export function isLeaseCurrent(state: ExecutionState, lease: ExecutionLease) {
  return (
    state.executionId === lease.executionId &&
    state.leaseExpiresAt !== null &&
    state.leaseToken === lease.token
  );
}

const LOST: LeaseLost = { status: "lost" };

/** Returns null when the execution is terminal and the wake is ignored. */
export function requestExecutionWake(
  state: ExecutionState,
  wakeAt: number,
  now: number
): ExecutionState | null {
  if (isTerminalExecutionStatus(state.status)) return null;
  return { ...state, dueAt: earliest(state.dueAt, wakeAt), updatedAt: now };
}

/**
 * Leases a claimable execution with the next token. Adapters check
 * `isExecutionClaimable` first, in the same atomic write.
 */
export function claimExecution(
  state: ExecutionState,
  params: { now: number; duration: number }
): { state: ExecutionState; lease: ExecutionLease } {
  const lease: ExecutionLease = {
    executionId: state.executionId,
    token: state.leaseToken + 1,
    expiresAt: params.now + params.duration,
  };
  return {
    state: {
      ...state,
      // Claiming over an expired lease ends it unacknowledged.
      unacknowledgedDeliveryCount:
        state.unacknowledgedDeliveryCount + (state.leaseExpiresAt !== null ? 1 : 0),
      // The lease covers the wakes due now, plus any an expired lease covered.
      claimedDueAt: earliest(state.dueAt, state.claimedDueAt),
      dueAt: null,
      leaseToken: lease.token,
      leaseExpiresAt: lease.expiresAt,
      redeliverAt: null,
    },
    lease,
  };
}

export function renewExecutionLease(
  state: ExecutionState,
  params: { lease: ExecutionLease; duration: number; now: number }
): { state: ExecutionState; result: ExecutionRenewResult } {
  if (!isLeaseCurrent(state, params.lease)) return { state, result: LOST };
  const lease: ExecutionLease = {
    ...params.lease,
    expiresAt: params.now + params.duration,
  };
  return {
    state: { ...state, leaseExpiresAt: lease.expiresAt },
    result: { status: "renewed", lease },
  };
}

export function releaseExecutionLease(
  state: ExecutionState,
  params: { lease: ExecutionLease; now: number }
): { state: ExecutionState; result: ExecutionReleaseResult } {
  if (!isLeaseCurrent(state, params.lease)) return { state, result: LOST };
  const unacknowledgedDeliveryCount = state.unacknowledgedDeliveryCount + 1;
  return {
    state: {
      ...state,
      // The wakes the lease covered stay pending.
      dueAt: earliest(state.dueAt, state.claimedDueAt),
      claimedDueAt: null,
      leaseExpiresAt: null,
      unacknowledgedDeliveryCount,
      redeliverAt: params.now + redeliveryDelay(unacknowledgedDeliveryCount),
    },
    result: { status: "released" },
  };
}

export function acknowledgeExecution(
  state: ExecutionState,
  params: {
    lease: ExecutionLease;
    outcome: WorkflowRunOutcome;
    now: number;
  }
): { state: ExecutionState; result: ExecutionAcknowledgeResult } {
  if (!isLeaseCurrent(state, params.lease)) return { state, result: LOST };

  // A held lease is never on a terminal record, but keep the first outcome
  // regardless: terminal outcomes are immutable.
  if (isTerminalExecutionStatus(state.status)) {
    return { state, result: decodeExecutionOutcome(state.outcome!) };
  }

  const { outcome, now } = params;
  const ended = {
    claimedDueAt: null,
    leaseExpiresAt: null,
    unacknowledgedDeliveryCount: 0,
    redeliverAt: null,
    updatedAt: now,
  };

  if (outcome.status !== "suspended") {
    const encoded = encodeExecutionOutcome(
      outcome.status === "completed"
        ? { status: "completed", result: outcome.result }
        : { status: "failed", error: outcome.error }
    );
    // An invalid result is recorded as failed, so the status comes from the
    // encoding rather than the reported outcome.
    const terminal = decodeExecutionOutcome(encoded);
    return {
      // Reaching a terminal status clears every pending wake.
      state: {
        ...state,
        ...ended,
        status: terminal.status,
        outcome: encoded,
        dueAt: null,
      },
      result: terminal,
    };
  }

  return {
    // The wakes the lease covered are cleared; wakes requested since the
    // claim stay pending, merged with the outcome's `wakeAt`.
    state: {
      ...state,
      ...ended,
      status: "suspended",
      dueAt: earliest(state.dueAt, outcome.wakeAt ?? null),
    },
    result: { status: "suspended" },
  };
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Validates an admission request and encodes its event. Adapters call this
 * before their atomic insert, then reject with `EXECUTION_ID_CONFLICT` if the
 * ID is already in use.
 */
export function prepareExecutionAdmission(request: {
  executionId?: string;
  workflowId: string;
  params: EventParams;
  context: EventContext;
}):
  | { ok: true; executionId: string; encoded: { params: string; context: string } }
  | { ok: false; code: "INVALID_EXECUTION_EVENT"; message: string } {
  if (typeof request.workflowId !== "string" || request.workflowId === "") {
    return {
      ok: false,
      code: "INVALID_EXECUTION_EVENT",
      message: "workflowId must be a non-empty string",
    };
  }
  if (
    request.executionId !== undefined &&
    (typeof request.executionId !== "string" || request.executionId === "")
  ) {
    return {
      ok: false,
      code: "INVALID_EXECUTION_EVENT",
      message: "executionId must be a non-empty string",
    };
  }
  try {
    return {
      ok: true,
      executionId: request.executionId ?? crypto.randomUUID(),
      encoded: encodeExecutionEvent(request),
    };
  } catch (err) {
    if (!(err instanceof ExecutionEventEncodingError)) throw err;
    return { ok: false, code: "INVALID_EXECUTION_EVENT", message: err.message };
  }
}

export function executionIdConflict(executionId: string) {
  return {
    status: "rejected" as const,
    code: "EXECUTION_ID_CONFLICT" as const,
    message: `Execution "${executionId}" already exists`,
  };
}

export function executionNotFound(executionId: string) {
  return {
    status: "rejected" as const,
    code: "EXECUTION_NOT_FOUND" as const,
    message: `Execution "${executionId}" does not exist`,
  };
}

/**
 * A recorded start request, keyed by `callerExecutionId` and `stepKey`.
 * `executionId` is the target it admitted. Adapters keep it until the caller
 * is pruned, including after the target is terminal.
 */
export type StartRequestState = {
  callerExecutionId: string;
  stepKey: string;
  workflowId: string;
  /** The canonical params, or null when the request had none. */
  params: string | null;
  executionId: string;
};

export type PreparedExecutionStart = {
  callerExecutionId: string;
  stepKey: string;
  workflowId: string;
  params: string | null;
};

/**
 * Validates a start request and encodes its params canonically. Adapters call
 * this before touching storage and return the rejection as is.
 */
export function prepareExecutionStart(
  request: ExecutionStartRequest
):
  | { ok: true; start: PreparedExecutionStart }
  | {
      ok: false;
      result: Extract<ExecutionStartResult, { status: "rejected" }>;
    } {
  const invalid = (message: string) => ({
    ok: false as const,
    result: {
      status: "rejected" as const,
      code: "INVALID_START_PARAMETERS" as const,
      message,
    },
  });
  if (typeof request.workflowId !== "string" || request.workflowId === "") {
    return invalid("workflowId must be a non-empty string");
  }
  let params: string | null = null;
  if (request.params !== undefined) {
    if (!isPlainObject(request.params)) {
      return invalid("params must be a plain object");
    }
    const encoding = durableValueCodec.encode(request.params);
    if (encoding.status === "invalid") {
      return invalid(`params: ${encoding.message}`);
    }
    params = encoding.canonical;
  }
  return {
    ok: true,
    start: {
      callerExecutionId: request.requestId.executionId,
      stepKey: request.requestId.stepKey,
      workflowId: request.workflowId,
      params,
    },
  };
}

/**
 * Answers a repeated start request from its record: the first target's ID when
 * the workflow ID and canonical params match, and `START_REQUEST_MISMATCH`
 * otherwise. The target's status does not matter.
 */
export function matchStartRequest(
  recorded: StartRequestState,
  start: PreparedExecutionStart
): ExecutionStartResult {
  if (
    recorded.workflowId === start.workflowId &&
    recorded.params === start.params
  ) {
    return { status: "accepted", executionId: recorded.executionId };
  }
  return {
    status: "rejected",
    code: "START_REQUEST_MISMATCH",
    message: `Step "${start.stepKey}" of execution "${start.callerExecutionId}" already started workflow "${recorded.workflowId}" with different parameters or workflow ID`,
  };
}

/**
 * Builds a new start's target state and start-request record. The target
 * inherits the caller's encoded context and links to the caller as its parent.
 * Adapters insert both in one atomic write, after finding no recorded request
 * for the same ID. `executionId` defaults to a random UUID; if it is already in
 * use, adapters must not reuse it.
 */
export function createStartedExecution(params: {
  start: PreparedExecutionStart;
  caller: ExecutionState;
  now: number;
  executionId?: string;
}): { target: ExecutionState; startRequest: StartRequestState } {
  const { start, caller, now } = params;
  const executionId = params.executionId ?? crypto.randomUUID();
  const target = createExecutionState({
    executionId,
    workflowId: start.workflowId,
    encoded: {
      params: start.params ?? encodeExecutionEvent({ params: undefined, context: undefined }).params,
      context: caller.context,
    },
    now,
    parent: { executionId: start.callerExecutionId, stepKey: start.stepKey },
  });
  return {
    target,
    startRequest: {
      callerExecutionId: start.callerExecutionId,
      stepKey: start.stepKey,
      workflowId: start.workflowId,
      params: start.params,
      executionId,
    },
  };
}
