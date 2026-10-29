import type { EventContext, EventParams } from "../base/event";
import type {
  ExecutionAcknowledgeResult,
  ExecutionLease,
  ExecutionOutcome,
  ExecutionRecord,
  ExecutionReleaseResult,
  ExecutionRenewResult,
  ExecutionStatus,
  LeaseLost,
  WorkflowRunOutcome,
} from "../base/execution";
import { isTerminalExecutionStatus } from "../base/execution";
import { ReadOnlyMap } from "../utils/map";

/**
 * Storage-neutral state of one execution record, with the event and outcome
 * already encoded. Runtime adapters persist these fields however they like and
 * apply the transitions below inside one atomic write, so every adapter keeps
 * the same lease, wake and acknowledgement semantics.
 *
 * `status` is the status the execution rests in when it has no live lease
 * (`admitted`, `suspended` or terminal); it is never `running`. The record's
 * `running` status is derived from the lease and the clock by
 * `executionStatusAt`, so an expired lease reads as ended without a write.
 * Lease transitions (claim, renew, release) do not change `updatedAt`.
 *
 * Pending wakes are split in two:
 * - `dueAt` merges wakes not covered by a lease;
 * - `claimedDueAt` holds the wakes the current lease covers. They stay
 *   pending until that lease is acknowledged, so a lease that is released or
 *   expires leaves them due.
 *
 * Leases:
 * - `leaseToken` is the highest token issued for this execution (0 before the
 *   first claim). It never decreases.
 * - `leaseExpiresAt` is non-null while the lease with `leaseToken` is held,
 *   that is, claimed and not yet released or acknowledged. A held lease
 *   stays current after it expires, until a later claim issues a higher token.
 * - `unacknowledgedDeliveries` counts consecutive leases that ended by release
 *   or by expiry and a later claim. It does not include a held lease that has
 *   expired; `unacknowledgedDeliveriesAt` adds that one.
 * - `redeliverAt` is when a released execution may be claimed again, after the
 *   redelivery delay. A held lease's delay is measured from `leaseExpiresAt`.
 */
export type ExecutionState = {
  executionId: string;
  workflowId: string;
  params: string;
  context: string;
  status: Exclude<ExecutionStatus, "running">;
  outcome: string | null;
  admittedAt: number;
  updatedAt: number;
  dueAt: number | null;
  claimedDueAt: number | null;
  leaseToken: number;
  leaseExpiresAt: number | null;
  unacknowledgedDeliveries: number;
  redeliverAt: number | null;
};

/** How long a lease lasts unless renewed: 30 seconds. */
export const DEFAULT_LEASE_DURATION = 30_000;

/** The redelivery delay after one unacknowledged delivery: 1 second. */
export const REDELIVERY_DELAY_BASE = 1_000;

/** The longest redelivery delay: 5 minutes. */
export const REDELIVERY_DELAY_MAX = 300_000;

/**
 * How long an execution waits after a delivery ends unacknowledged before it
 * can be claimed again. Starts at `REDELIVERY_DELAY_BASE` and doubles with
 * each consecutive unacknowledged delivery, up to `REDELIVERY_DELAY_MAX`. It
 * never decreases as `unacknowledgedDeliveries` grows, and it is zero only
 * when there are none.
 */
export function redeliveryDelay(unacknowledgedDeliveries: number): number {
  if (unacknowledgedDeliveries <= 0) return 0;
  const exponent = Math.min(unacknowledgedDeliveries - 1, 30);
  return Math.min(REDELIVERY_DELAY_BASE * 2 ** exponent, REDELIVERY_DELAY_MAX);
}

export class ExecutionEventEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEventEncodingError";
  }
}

/**
 * Encodes `params` and `context` so that decoding returns exactly what was
 * admitted. Values that JSON cannot round-trip (undefined properties, Dates,
 * class instances, non-finite numbers, cycles…) are rejected rather than
 * stored lossily.
 */
export function encodeExecutionEvent(event: {
  params: EventParams;
  context: EventContext | undefined;
}): { params: string; context: string } {
  if (event.params !== undefined) assertDurableJson(event.params, "params");
  const entries: [unknown, unknown][] = event.context
    ? [...event.context.entries()]
    : [];
  for (const [key, value] of entries) {
    const label = `context[${JSON.stringify(key) ?? String(key)}]`;
    if (
      !(typeof key === "string" || typeof key === "number" || key === null) ||
      (typeof key === "number" && !isDurableNumber(key))
    ) {
      throw new ExecutionEventEncodingError(
        `${label}: context keys must be strings or finite numbers`
      );
    }
    assertDurableJson(value, label);
  }
  return {
    params: JSON.stringify(event.params === undefined ? {} : { value: event.params }),
    context: JSON.stringify(entries),
  };
}

export function decodeExecutionEvent(encoded: {
  params: string;
  context: string;
}): { params: EventParams; context: EventContext } {
  const params = JSON.parse(encoded.params) as { value?: EventParams };
  return {
    params: "value" in params ? params.value : undefined,
    context: new ReadOnlyMap(new Map(JSON.parse(encoded.context))),
  };
}

export function encodeExecutionOutcome(outcome: ExecutionOutcome): string {
  if (outcome.status === "completed") {
    return JSON.stringify({
      status: "completed",
      result: outcome.result === undefined ? {} : { value: outcome.result },
    });
  }
  return JSON.stringify({ status: "failed", error: encodeError(outcome.error) });
}

export function decodeExecutionOutcome(encoded: string): ExecutionOutcome {
  const parsed = JSON.parse(encoded);
  if (parsed.status === "completed") {
    return {
      status: "completed",
      result: "value" in parsed.result ? parsed.result.value : undefined,
    };
  }
  return { status: "failed", error: decodeError(parsed.error) };
}

/** Keeps at least `name` and `message`, plus `stack` and a string `code`. */
function encodeError(error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as { code?: unknown }).code;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(typeof code === "string" ? { code } : {}),
  };
}

function decodeError(encoded: {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}): Error {
  const error = new Error(encoded.message);
  error.name = encoded.name;
  if (encoded.stack !== undefined) error.stack = encoded.stack;
  if (encoded.code !== undefined) {
    (error as Error & { code?: string }).code = encoded.code;
  }
  return error;
}

export function createExecutionState(params: {
  executionId: string;
  workflowId: string;
  encoded: { params: string; context: string };
  now: number;
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
    // Admission makes the execution due immediately.
    dueAt: params.now,
    claimedDueAt: null,
    leaseToken: 0,
    leaseExpiresAt: null,
    unacknowledgedDeliveries: 0,
    redeliverAt: null,
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
export function unacknowledgedDeliveriesAt(state: ExecutionState, now: number) {
  return state.unacknowledgedDeliveries + (hasExpiredLease(state, now) ? 1 : 0);
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
    unacknowledgedDeliveries: unacknowledgedDeliveriesAt(state, now),
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
      state.leaseExpiresAt + redeliveryDelay(state.unacknowledgedDeliveries + 1)
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
      unacknowledgedDeliveries:
        state.unacknowledgedDeliveries + (state.leaseExpiresAt !== null ? 1 : 0),
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
  const unacknowledgedDeliveries = state.unacknowledgedDeliveries + 1;
  return {
    state: {
      ...state,
      // The wakes the lease covered stay pending.
      dueAt: earliest(state.dueAt, state.claimedDueAt),
      claimedDueAt: null,
      leaseExpiresAt: null,
      unacknowledgedDeliveries,
      redeliverAt: params.now + redeliveryDelay(unacknowledgedDeliveries),
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
    unacknowledgedDeliveries: 0,
    redeliverAt: null,
    updatedAt: now,
  };

  if (outcome.status !== "suspended") {
    const terminal: ExecutionOutcome =
      outcome.status === "completed"
        ? { status: "completed", result: outcome.result }
        : { status: "failed", error: outcome.error };
    const encoded = encodeExecutionOutcome(terminal);
    return {
      // Reaching a terminal status clears every pending wake.
      state: {
        ...state,
        ...ended,
        status: terminal.status,
        outcome: encoded,
        dueAt: null,
      },
      result: decodeExecutionOutcome(encoded),
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

function isDurableNumber(value: number) {
  return Number.isFinite(value) && !Object.is(value, -0);
}

function assertDurableJson(value: unknown, path: string, seen = new Set<object>()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!isDurableNumber(value)) {
      throw new ExecutionEventEncodingError(`${path}: ${value} cannot round-trip`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new ExecutionEventEncodingError(`${path}: ${typeof value} cannot round-trip`);
  }
  if (seen.has(value)) {
    throw new ExecutionEventEncodingError(`${path}: circular reference`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new ExecutionEventEncodingError(`${path}[${i}]: sparse array hole`);
      }
      assertDurableJson(value[i], `${path}[${i}]`, seen);
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ExecutionEventEncodingError(
        `${path}: ${proto?.constructor?.name ?? "object"} instances cannot round-trip`
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ExecutionEventEncodingError(`${path}: symbol keys cannot round-trip`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__") {
        throw new ExecutionEventEncodingError(`${path}.__proto__ cannot round-trip`);
      }
      assertDurableJson(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
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
