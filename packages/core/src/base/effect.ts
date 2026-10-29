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

export type EffectBeginResult =
  | { status: "new" }
  | { status: "pending" }
  | { status: "settled"; result: DurableValue }
  | { status: "rejected"; code: "EFFECT_REQUEST_MISMATCH" };

export type EffectSettleRequest = {
  operation: string;
  effectId: string;
  result: DurableValue;
};

export type EffectSettleResult =
  | { status: "settled"; result: DurableValue }
  | {
      status: "conflict";
      /** The first result, which stays settled. */
      result: DurableValue;
      conflictingResult: DurableValue;
    };

export type EffectWatchRequest = {
  effectId: string;
  executionId: string;
  stepKey: string;
};

/** A settlement that reported a different result from the settled one. */
export type EffectConflictReport = {
  result: DurableValue;
  conflictingResult: DurableValue;
  reportedAt: number;
};

export type EffectRecord = {
  effectId: string;
  operation: string;
  input: DurableObject;
  status: "pending" | "settled";
  /** Present, possibly as `undefined`, only when `status` is `settled`. */
  result?: DurableValue;
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
   * Settles a pending effect with `result` and wakes every execution watching
   * it, all-or-nothing. Settling an effect again with an equal result returns
   * the settled result; a different result keeps the first, returns
   * `conflict` and stores a permanent conflict report.
   */
  settle(request: EffectSettleRequest): Promise<EffectSettleResult>;

  /**
   * Registers the step as a waiter on the effect, so settlement wakes its
   * execution. Repeating it keeps one registration. If the effect is already
   * settled, wakes the execution now. The waiter is deleted by the heap write
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
  | "EFFECT_REQUEST_MISMATCH";

/** The codes with which `step.effect` requests another delivery. */
export type EffectDeliveryErrorCode =
  | "EFFECT_CLIENT_UNAVAILABLE"
  | "EFFECT_HANDLER_INVALID"
  | "EFFECT_RUNTIME_INVARIANT";

/**
 * Thrown to workflow code by `step.effect` for an invalid request or one that
 * does not match the recorded effect. It is recorded as the step's error, so
 * replay throws it again.
 */
export class WorkflowEffectError extends Error {
  readonly code: WorkflowEffectErrorCode;

  constructor(code: WorkflowEffectErrorCode, message: string) {
    super(message);
    this.name = "WorkflowEffectError";
    this.code = code;
  }
}
