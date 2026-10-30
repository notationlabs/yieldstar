import type { DurableObject, DurableValue } from "./durable-value";

export type EffectBeginRequest = {
  operation: string;
  /** Identifies the external operation across every execution and runtime. */
  effectId: string;
  input: DurableObject;
  /** The execution and step that are beginning the effect. */
  executionId: string;
  stepKey: string;
};

/**
 * How an effect ended. A `failed` effect ended with a definite failure: the
 * external operation did not succeed and never will.
 */
export type EffectOutcome =
  | { status: "settled"; result: DurableValue }
  | { status: "failed"; error: Error };

export type EffectBeginResult =
  | { status: "new" }
  | { status: "pending" }
  | EffectOutcome
  | { status: "rejected"; code: "EFFECT_REQUEST_MISMATCH" };

export type EffectSettleRequest = {
  operation: string;
  effectId: string;
} & EffectOutcome;

export type EffectSettleResult =
  | EffectOutcome
  | {
      status: "conflict";
      /** The first outcome, which stays. */
      outcome: EffectOutcome;
      conflictingOutcome: EffectOutcome;
    };

export type EffectWatchRequest = {
  effectId: string;
  executionId: string;
  stepKey: string;
};

/** A settlement that reported a different outcome from the stored one. */
export type EffectConflictReport = {
  outcome: EffectOutcome;
  conflictingOutcome: EffectOutcome;
  reportedAt: number;
};

export type EffectRecord = {
  effectId: string;
  operation: string;
  input: DurableObject;
  status: "pending" | "settled" | "failed";
  /** Present, possibly as `undefined`, only when `status` is `settled`. */
  result?: DurableValue;
  /** Present only when `status` is `failed`. */
  error?: Error;
  conflicts: EffectConflictReport[];
};

/**
 * The runtime's record of external effects, keyed by effect ID (RFC 005).
 * Effect records are never deleted, including when an execution that began
 * one is cancelled or pruned.
 *
 * `begin`, `settle` and `watch` are not fenced: a stale lease holder's calls
 * are accepted, and are safe because each is idempotent by effect ID. A
 * client throws `EffectClientInvariantError` for a request the driver should
 * never make, such as one with invalid values or for an unknown effect, and
 * for stored data it cannot read. Any other rejection means the client may be
 * unavailable.
 */
export interface EffectClient {
  /**
   * Creates a pending effect before returning `new`. For an existing effect,
   * returns its current state when `operation` and the canonical encoding of
   * `input` match, and `EFFECT_REQUEST_MISMATCH` otherwise, leaving the
   * effect unchanged.
   */
  begin(request: EffectBeginRequest): Promise<EffectBeginResult>;

  /**
   * Settles a pending effect with a result, or fails it with an error, and
   * wakes every execution watching it, all-or-nothing. Settling an effect
   * again with an equal outcome, or failing a failed effect again with any
   * error, returns the stored outcome; any other outcome keeps the first,
   * returns `conflict` and stores a permanent conflict report.
   */
  settle(request: EffectSettleRequest): Promise<EffectSettleResult>;

  /**
   * Registers the step as a waiter on the effect, so settlement wakes its
   * execution. Repeating it keeps one registration. If the effect is already
   * settled or failed, wakes the execution now. The waiter is deleted by the heap write
   * that records the step's result.
   */
  watch(request: EffectWatchRequest): Promise<void>;

  /** For operators: the effect, its result and any conflict reports. */
  getEffect(effectId: string): Promise<EffectRecord | undefined>;
}

/**
 * Thrown by an `EffectClient` when a request or its stored data breaks the
 * client's invariants. The driver requests another delivery instead of
 * recording a step.
 */
export class EffectClientInvariantError extends Error {
  readonly code = "EFFECT_RUNTIME_INVARIANT" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EffectClientInvariantError";
  }
}

export type WorkflowEffectErrorCode =
  | "INVALID_EFFECT_REQUEST"
  | "EFFECT_REQUEST_MISMATCH"
  | "EFFECT_OUTCOME_UNKNOWN";

/** The codes with which `step.effect` requests another delivery. */
export type EffectDeliveryErrorCode =
  | "EFFECT_CLIENT_UNAVAILABLE"
  | "EFFECT_HANDLER_INVALID"
  | "EFFECT_RUNTIME_INVARIANT";

/**
 * The cause of the infrastructure error with which `step.effect` ends a
 * delivery without recording its step. It never reaches workflow code: the
 * delivery is not acknowledged, and the execution is delivered again.
 *
 * - `EFFECT_CLIENT_UNAVAILABLE`: an `EffectClient` call failed, and may
 *   recover without intervention.
 * - `EFFECT_HANDLER_INVALID`: `lookup` or `perform` returned a malformed
 *   response or a value that is not durable, or `fails` threw.
 * - `EFFECT_RUNTIME_INVARIANT`: the `EffectClient` threw
 *   `EffectClientInvariantError` or answered with a malformed response.
 */
export class EffectDeliveryError extends Error {
  readonly code: EffectDeliveryErrorCode;
  readonly effectId: string;
  readonly stepKey: string;

  constructor(
    code: EffectDeliveryErrorCode,
    params: { effectId: string; stepKey: string; message: string },
    options?: ErrorOptions
  ) {
    super(params.message, options);
    this.name = "EffectDeliveryError";
    this.code = code;
    this.effectId = params.effectId;
    this.stepKey = params.stepKey;
  }
}

/**
 * Thrown to workflow code by `step.effect` for an invalid request, one that
 * does not match the recorded effect, or an effect whose outcome is still
 * unknown after `maxAttempts`. It is recorded as the step's error, so replay
 * throws it again.
 */
export class WorkflowEffectError extends Error {
  readonly code: WorkflowEffectErrorCode;

  constructor(code: WorkflowEffectErrorCode, message: string) {
    super(message);
    this.name = "WorkflowEffectError";
    this.code = code;
  }
}
