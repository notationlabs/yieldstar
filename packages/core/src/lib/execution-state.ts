import type { EventContext, EventParams } from "../base/event";
import type {
  ExecutionAcknowledgeResult,
  ExecutionDelivery,
  ExecutionOutcome,
  ExecutionRecord,
  ExecutionStatus,
  WorkflowRunOutcome,
} from "../base/execution";
import { isTerminalExecutionStatus } from "../base/execution";
import { ReadOnlyMap } from "../utils/map";

/**
 * Storage-neutral state of one execution record, with the event and outcome
 * already encoded. Runtime adapters persist these fields however they like and
 * apply the transitions below inside one atomic write, so every adapter keeps
 * the same wake and acknowledgement semantics.
 *
 * Pending wakes are split in two:
 * - `dueAt` merges wakes not covered by a claimed delivery;
 * - `claimedDueAt` holds the wakes a claimed delivery covers. They stay
 *   pending until that delivery is acknowledged, so an unacknowledged
 *   delivery is redelivered once `claimExpiresAt` passes.
 */
export type ExecutionState = {
  executionId: string;
  workflowId: string;
  params: string;
  context: string;
  status: ExecutionStatus;
  outcome: string | null;
  admittedAt: number;
  updatedAt: number;
  dueAt: number | null;
  claimToken: string | null;
  claimedDueAt: number | null;
  claimExpiresAt: number | null;
};

/** Five minutes, matching the visibility window of the former task queue. */
export const DEFAULT_REDELIVERY_TIMEOUT = 300_000;

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
    claimToken: null,
    claimedDueAt: null,
    claimExpiresAt: null,
  };
}

export function toExecutionRecord(state: ExecutionState): ExecutionRecord {
  const event = decodeExecutionEvent(state);
  return {
    executionId: state.executionId,
    workflowId: state.workflowId,
    params: event.params,
    context: event.context,
    status: state.status,
    ...(state.outcome !== null
      ? { outcome: decodeExecutionOutcome(state.outcome) }
      : {}),
    admittedAt: state.admittedAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * The earliest time `claimDue` may return this execution, or null when it has
 * nothing pending. Adapters can index this value to find due executions.
 */
export function nextClaimAt(state: ExecutionState): number | null {
  if (isTerminalExecutionStatus(state.status)) return null;
  // A claimed delivery covers wakes that were due when it was claimed, so it
  // becomes claimable again exactly when its redelivery timeout passes.
  if (state.claimToken !== null) return state.claimExpiresAt;
  return state.dueAt;
}

export function isExecutionClaimable(state: ExecutionState, now: number) {
  const at = nextClaimAt(state);
  return at !== null && at <= now;
}

/** Returns null when the execution is terminal and the wake is ignored. */
export function requestExecutionWake(
  state: ExecutionState,
  wakeAt: number,
  now: number
): ExecutionState | null {
  if (isTerminalExecutionStatus(state.status)) return null;
  return { ...state, dueAt: earliest(state.dueAt, wakeAt), updatedAt: now };
}

export function claimExecution(
  state: ExecutionState,
  params: { now: number; token: string; redeliveryTimeout: number }
): ExecutionState {
  return {
    ...state,
    // Redelivering an expired claim covers its wakes plus any merged since.
    claimedDueAt: earliest(state.dueAt, state.claimedDueAt),
    dueAt: null,
    claimToken: params.token,
    claimExpiresAt: params.now + params.redeliveryTimeout,
  };
}

export function acknowledgeExecution(
  state: ExecutionState,
  params: {
    delivery: ExecutionDelivery;
    outcome: WorkflowRunOutcome;
    now: number;
  }
): { state: ExecutionState; result: ExecutionAcknowledgeResult } {
  if (isTerminalExecutionStatus(state.status)) {
    return { state, result: decodeExecutionOutcome(state.outcome!) };
  }

  const { outcome, now } = params;

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
        status: terminal.status,
        outcome: encoded,
        updatedAt: now,
        dueAt: null,
        claimToken: null,
        claimedDueAt: null,
        claimExpiresAt: null,
      },
      result: decodeExecutionOutcome(encoded),
    };
  }

  const dueAt = earliest(state.dueAt, outcome.wakeAt ?? null);
  const ownsClaim = state.claimToken === params.delivery.token;

  return {
    state: ownsClaim
      ? {
          ...state,
          status: "suspended",
          updatedAt: now,
          dueAt,
          claimToken: null,
          claimedDueAt: null,
          claimExpiresAt: null,
        }
      : // A stale delivery (its claim expired and was redelivered) records its
        // suspension without clearing wakes another delivery now covers.
        { ...state, status: "suspended", updatedAt: now, dueAt },
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
