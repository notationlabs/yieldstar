import { durableValueCodec, isPlainObject, type DurableObject, type DurableValue } from "../base/durable-value";
import {
  EffectClientInvariantError,
  type EffectBeginRequest,
  type EffectBeginResult,
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
  status: "pending" | "settled";
  result?: string;
  conflicts: EffectConflictState[];
};

export type EffectConflictState = {
  result: string;
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
  /** The canonical result. */
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

/** Validates a `settle` request and encodes its result canonically. */
export function prepareEffectSettle(request: EffectSettleRequest): PreparedEffectSettle {
  if (!isNonEmptyString(request.effectId)) {
    throw invariant("Invalid effect settlement: effectId must be a non-empty string");
  }
  if (!isNonEmptyString(request.operation)) {
    throw invariant("Invalid effect settlement: operation must be a non-empty string");
  }
  const encoding = durableValueCodec.encode(request.result);
  if (encoding.status === "invalid") {
    throw invariant(`Invalid effect settlement: result: ${encoding.message}`);
  }
  return {
    effectId: request.effectId,
    operation: request.operation,
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
  return { status: "settled", result: decodeSettledResult(state) };
}

/**
 * Applies a settlement. `wake` is true only when this settlement moved the
 * effect from pending to settled: adapters then wake every waiter in the same
 * write. `state` is the input object when nothing changed. Throws
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
  if (state.status === "pending") {
    return {
      state: { ...state, status: "settled", result: settle.result },
      result: { status: "settled", result: decodeValue(settle.result, state.effectId) },
      wake: true,
    };
  }
  const result = decodeSettledResult(state);
  if (state.result === settle.result) {
    return { state, result: { status: "settled", result }, wake: false };
  }
  const conflictingResult = decodeValue(settle.result, state.effectId);
  // One report per distinct conflicting result, so a settlement repeated after
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
            { result: state.result!, conflictingResult: settle.result, reportedAt: now },
          ],
        },
    result: { status: "conflict", result, conflictingResult },
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
      result: decodeValue(conflict.result, state.effectId),
      conflictingResult: decodeValue(conflict.conflictingResult, state.effectId),
      reportedAt: conflict.reportedAt,
    })),
  };
  if (state.status === "settled") record.result = decodeSettledResult(state);
  return record;
}

export function effectNotFound(effectId: string): EffectClientInvariantError {
  return invariant(`Effect "${effectId}" does not exist: begin it first`);
}

function decodeSettledResult(state: EffectState): DurableValue {
  if (state.result === undefined) {
    throw invariant(`Settled effect "${state.effectId}" has no stored result`);
  }
  return decodeValue(state.result, state.effectId);
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
