import { durableValueCodec, isPlainObject, type DurableObject, type DurableValue } from "../base/durable-value";
import {
  EffectClientInvariantError,
  type EffectBeginRequest,
  type EffectBeginResult,
  type EffectOutcome,
  type EffectRecord,
  type EffectSettleRequest,
  type EffectSettleResult,
  type EffectWatchRequest,
} from "../base/effect";

/**
 * An effect as runtime adapters store it. `input`, `result` and the values of
 * each conflict report are canonical `durableValueCodec` encodings, so equal
 * values compare as equal strings.
 */
export type EffectState = {
  effectId: string;
  operation: string;
  input: string;
  status: "pending" | EffectOutcomeStatus;
  /** The result, or the error when `status` is `failed`. */
  result?: string;
  conflicts: EffectConflictState[];
};

export type EffectOutcomeStatus = EffectOutcome["status"];

export type EffectConflictState = {
  status: EffectOutcomeStatus;
  /** The stored result or error. */
  result: string;
  conflictingStatus: EffectOutcomeStatus;
  conflictingResult: string;
  reportedAt: number;
};

export type PreparedEffectBegin = {
  effectId: string;
  operation: string;
  /** The canonical input. */
  input: string;
  executionId: string;
  stepKey: string;
};

export type PreparedEffectSettle = {
  effectId: string;
  operation: string;
  status: EffectOutcomeStatus;
  /** The canonical result, or the canonical error when `status` is `failed`. */
  result: string;
};

/**
 * Checks the values `step.effect` passes to `begin`, and returns a message
 * naming the first invalid one. The driver rejects these requests with
 * `INVALID_EFFECT_REQUEST` before calling the client.
 */
export function validateEffectRequest(request: {
  effectId: unknown;
  operation: unknown;
  input: unknown;
}): { ok: true; input: string } | { ok: false; message: string } {
  if (!isNonEmptyString(request.effectId)) {
    return { ok: false, message: "effectId must be a non-empty string" };
  }
  if (!isNonEmptyString(request.operation)) {
    return { ok: false, message: "operation must be a non-empty string" };
  }
  if (!isPlainObject(request.input)) {
    return { ok: false, message: "input must be a plain object" };
  }
  const encoding = durableValueCodec.encode(request.input);
  if (encoding.status === "invalid") {
    return { ok: false, message: `input: ${encoding.message}` };
  }
  return { ok: true, input: encoding.canonical };
}

/**
 * Validates a `begin` request and encodes its input canonically. Adapters call
 * this before touching storage; it throws `EffectClientInvariantError` for a
 * request the driver should have rejected.
 */
export function prepareEffectBegin(request: EffectBeginRequest): PreparedEffectBegin {
  const validated = validateEffectRequest(request);
  if (!validated.ok) throw invariant(`Invalid effect request: ${validated.message}`);
  assertStepId(request);
  return {
    effectId: request.effectId,
    operation: request.operation,
    input: validated.input,
    executionId: request.executionId,
    stepKey: request.stepKey,
  };
}

/** Validates a `settle` request and encodes its result or error canonically. */
export function prepareEffectSettle(request: EffectSettleRequest): PreparedEffectSettle {
  if (!isNonEmptyString(request.effectId)) {
    throw invariant("Invalid effect settlement: effectId must be a non-empty string");
  }
  if (!isNonEmptyString(request.operation)) {
    throw invariant("Invalid effect settlement: operation must be a non-empty string");
  }
  let value: unknown;
  if (request.status === "settled") {
    value = request.result;
  } else if (request.status === "failed") {
    if (!(request.error instanceof Error)) {
      throw invariant("Invalid effect settlement: error must be an Error");
    }
    value = request.error;
  } else {
    throw invariant('Invalid effect settlement: status must be "settled" or "failed"');
  }
  const encoding = durableValueCodec.encode(value);
  if (encoding.status === "invalid") {
    const field = request.status === "settled" ? "result" : "error";
    throw invariant(`Invalid effect settlement: ${field}: ${encoding.message}`);
  }
  return {
    effectId: request.effectId,
    operation: request.operation,
    status: request.status,
    result: encoding.canonical,
  };
}

/** Validates a `watch` request. */
export function prepareEffectWatch(request: EffectWatchRequest): EffectWatchRequest {
  if (!isNonEmptyString(request.effectId)) {
    throw invariant("Invalid effect watch: effectId must be a non-empty string");
  }
  assertStepId(request);
  return {
    effectId: request.effectId,
    executionId: request.executionId,
    stepKey: request.stepKey,
  };
}

/** The pending effect a `begin` that finds no effect creates. */
export function createEffectState(begin: PreparedEffectBegin): EffectState {
  return {
    effectId: begin.effectId,
    operation: begin.operation,
    input: begin.input,
    status: "pending",
    conflicts: [],
  };
}

/** Answers a `begin` for an effect that already exists. */
export function matchEffectBegin(
  state: EffectState,
  begin: PreparedEffectBegin
): EffectBeginResult {
  if (state.operation !== begin.operation || state.input !== begin.input) {
    return { status: "rejected", code: "EFFECT_REQUEST_MISMATCH" };
  }
  if (state.status === "pending") return { status: "pending" };
  return decodeStoredOutcome(state);
}

/**
 * Applies a settlement. `wake` is true only when this settlement moved the
 * effect out of pending: adapters then wake every waiter in the same write.
 * `state` is the input object when nothing changed. Throws
 * `EffectClientInvariantError` when the operation differs from the effect's,
 * which `begin` would have rejected.
 */
export function settleEffect(
  state: EffectState,
  settle: PreparedEffectSettle,
  now: number
): { state: EffectState; result: EffectSettleResult; wake: boolean } {
  if (state.operation !== settle.operation) {
    throw invariant(
      `Cannot settle effect "${state.effectId}" as operation "${settle.operation}": it was begun as "${state.operation}"`
    );
  }
  const settled = decodeOutcome(settle.status, settle.result, state.effectId);
  if (state.status === "pending") {
    return {
      state: { ...state, status: settle.status, result: settle.result },
      result: settled,
      wake: true,
    };
  }
  const stored = decodeStoredOutcome(state);
  if (state.status === settle.status && state.result === settle.result) {
    return { state, result: stored, wake: false };
  }
  // Two failures agree that the operation failed, though their errors differ
  // in detail such as the stack, so the first error stays without a report.
  if (state.status === "failed" && settle.status === "failed") {
    return { state, result: stored, wake: false };
  }
  // One report per distinct conflicting value, so a settlement repeated after
  // a lost response does not add another.
  const reported = state.conflicts.some(
    (conflict) => conflict.conflictingResult === settle.result
  );
  return {
    state: reported
      ? state
      : {
          ...state,
          conflicts: [
            ...state.conflicts,
            {
              status: state.status,
              result: state.result!,
              conflictingStatus: settle.status,
              conflictingResult: settle.result,
              reportedAt: now,
            },
          ],
        },
    result: { status: "conflict", outcome: stored, conflictingOutcome: settled },
    wake: false,
  };
}

export function toEffectRecord(state: EffectState): EffectRecord {
  const record: EffectRecord = {
    effectId: state.effectId,
    operation: state.operation,
    input: decodeInput(state),
    status: state.status,
    conflicts: state.conflicts.map((conflict) => ({
      outcome: decodeOutcome(conflict.status, conflict.result, state.effectId),
      conflictingOutcome: decodeOutcome(
        conflict.conflictingStatus,
        conflict.conflictingResult,
        state.effectId
      ),
      reportedAt: conflict.reportedAt,
    })),
  };
  if (state.status !== "pending") {
    const outcome = decodeStoredOutcome(state);
    if (outcome.status === "settled") record.result = outcome.result;
    else record.error = outcome.error;
  }
  return record;
}

export function effectNotFound(effectId: string): EffectClientInvariantError {
  return invariant(`Effect "${effectId}" does not exist: begin it first`);
}

function decodeStoredOutcome(state: EffectState): EffectOutcome {
  if (state.status === "pending") {
    throw invariant(`Effect "${state.effectId}" is pending`);
  }
  if (state.result === undefined) {
    throw invariant(`Effect "${state.effectId}" is ${state.status} but has no stored value`);
  }
  return decodeOutcome(state.status, state.result, state.effectId);
}

function decodeOutcome(
  status: EffectOutcomeStatus,
  canonical: string,
  effectId: string
): EffectOutcome {
  const value = decodeValue(canonical, effectId);
  if (status === "settled") return { status, result: value };
  if (status === "failed" && value instanceof Error) return { status, error: value };
  if (status === "failed") {
    throw invariant(`Stored error of effect "${effectId}" is not an Error`);
  }
  throw invariant(`Effect "${effectId}" has an unknown status`);
}

function decodeInput(state: EffectState): DurableObject {
  const input = decodeValue(state.input, state.effectId);
  if (!isPlainObject(input)) {
    throw invariant(`Stored input of effect "${state.effectId}" is not an object`);
  }
  return input as DurableObject;
}

function decodeValue(canonical: string, effectId: string): DurableValue {
  const decoded = durableValueCodec.decode(canonical);
  if (decoded.status === "invalid") {
    throw invariant(`Stored value of effect "${effectId}" is invalid: ${decoded.message}`);
  }
  return decoded.value;
}

function assertStepId(request: { executionId: unknown; stepKey: unknown }) {
  if (!isNonEmptyString(request.executionId)) {
    throw invariant("Invalid effect request: executionId must be a non-empty string");
  }
  if (!isNonEmptyString(request.stepKey)) {
    throw invariant("Invalid effect request: stepKey must be a non-empty string");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function invariant(message: string) {
  return new EffectClientInvariantError(message);
}
