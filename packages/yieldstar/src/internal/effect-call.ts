import type { Logger } from "pino";
import {
  EffectClientInvariantError,
  EffectDeliveryError,
  InfrastructureError,
  StepResponse,
  durableValueCodec,
  type DurableObject,
  type DurableValue,
  type EffectClient,
  type EffectDeliveryErrorCode,
  type EffectOutcome,
} from "@yieldstar/core";

/** What `lookup` reports about an effect ID (RFC 005). */
export type EffectLookup<T> =
  | { status: "settled"; result: T }
  | { status: "failed"; error: Error }
  | { status: "not-found" }
  | { status: "unknown" };

/** The effect request a step yields once its descriptor is valid. */
export type EffectCallRequest = {
  stepKey: string;
  effectId: string;
  operation: string;
  input: DurableObject;
  retryIn: number;
  maxAttempts?: number;
  lookup(effectId: string): Promise<unknown>;
  perform(effectId: string): Promise<unknown>;
  fails?(error: unknown): boolean;
};

/**
 * - `settled`: the effect's result, which the step records.
 * - `failed`: the effect's error, which the step records and throws.
 * - `rejected`: the effect exists with a different operation or input.
 * - `suspended`: the step watches the effect and is due again at `wakeAt`.
 * - `unknown`: the outcome is still unknown after `maxAttempts`.
 */
export type EffectCallOutcome =
  | EffectOutcome
  | { status: "rejected"; code: "EFFECT_REQUEST_MISMATCH" }
  | { status: "suspended"; wakeAt: number }
  | { status: "unknown"; attempts: number };

/**
 * Yielded by `step.effect`. The driver runs the effect with
 * `executeEffectCall` and resumes the step with its outcome.
 */
export class StepEffectCall extends StepResponse {
  static type = "effect-call";
  readonly type = "effect-call";
  readonly request: EffectCallRequest;

  constructor(request: EffectCallRequest) {
    super();
    this.request = request;
  }
}

/**
 * Runs an effect step's protocol against the runtime's `EffectClient`. Every
 * failure that must not be recorded rejects with an `InfrastructureError`
 * whose cause is an `EffectDeliveryError`, so the delivery is retried.
 */
export async function executeEffectCall(
  request: EffectCallRequest,
  context: {
    effects: EffectClient;
    executionId: string;
    /** The number of earlier attempts of this step that ended uncertain. */
    attempt: number;
    clock: () => number;
    /** Checked before every callback, so a lost lease makes no external call. */
    assertLease: () => void;
    logger: Logger;
  }
): Promise<EffectCallOutcome> {
  const { effects, executionId, attempt, clock, assertLease, logger } = context;
  const { stepKey, effectId, operation, input, retryIn, maxAttempts } = request;

  const fail = (code: EffectDeliveryErrorCode, message: string, cause?: unknown) =>
    new InfrastructureError(
      new EffectDeliveryError(
        code,
        { effectId, stepKey, message },
        cause === undefined ? undefined : { cause }
      )
    );

  async function client<T>(method: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      const message = `EffectClient.${method} failed for effect "${effectId}": ${errorMessage(err)}`;
      if (isInvariantError(err)) throw fail("EFFECT_RUNTIME_INVARIANT", message, err);
      throw fail("EFFECT_CLIENT_UNAVAILABLE", message, err);
    }
  }

  const malformedClient = (method: string) =>
    fail(
      "EFFECT_RUNTIME_INVARIANT",
      `EffectClient.${method} returned a malformed response for effect "${effectId}"`
    );

  // Ends an uncertain attempt. The step watches the effect and looks it up
  // again after `retryIn`, unless this was its last attempt.
  async function suspend(): Promise<EffectCallOutcome> {
    if (maxAttempts !== undefined && attempt + 1 >= maxAttempts) {
      return { status: "unknown", attempts: attempt + 1 };
    }
    await client("watch", () => effects.watch({ effectId, executionId, stepKey }));
    return { status: "suspended", wakeAt: clock() + retryIn };
  }

  async function settle(outcome: EffectOutcome): Promise<EffectCallOutcome> {
    if (outcome.status === "settled") {
      const encoding = durableValueCodec.encode(outcome.result);
      if (encoding.status === "invalid") {
        throw fail(
          "EFFECT_HANDLER_INVALID",
          `Effect "${effectId}" result is not a durable value: ${encoding.message}`
        );
      }
    }
    const settled = await client("settle", () =>
      effects.settle({ operation, effectId, ...outcome })
    );
    if (!isObject(settled)) throw malformedClient("settle");
    if (settled.status === "conflict") {
      if (!isOutcome(settled.outcome) || !isOutcome(settled.conflictingOutcome)) {
        throw malformedClient("settle");
      }
      logger.warn(
        {
          executionId,
          stepKey,
          effectId,
          outcome: settled.outcome,
          conflictingOutcome: settled.conflictingOutcome,
        },
        `Effect "${effectId}" settled with a different outcome; the first outcome stands`
      );
      return settled.outcome;
    }
    if (!isOutcome(settled)) throw malformedClient("settle");
    return settled;
  }

  function isDefiniteFailure(err: unknown): boolean {
    if (!request.fails) return false;
    try {
      return request.fails(err) === true;
    } catch (failsErr) {
      throw fail(
        "EFFECT_HANDLER_INVALID",
        `fails threw for effect "${effectId}": ${errorMessage(failsErr)}`,
        failsErr
      );
    }
  }

  const begun = await client("begin", () =>
    effects.begin({ operation, effectId, input, executionId, stepKey })
  );
  if (!isObject(begun)) throw malformedClient("begin");

  let next: "lookup" | "perform";
  switch (begun.status) {
    case "settled":
    case "failed":
      if (!isOutcome(begun)) throw malformedClient("begin");
      return begun;
    case "rejected":
      if (begun.code !== "EFFECT_REQUEST_MISMATCH") throw malformedClient("begin");
      return { status: "rejected", code: begun.code };
    case "new":
      next = "perform";
      break;
    case "pending":
      // An earlier attempt may have started the operation, or finished it.
      next = "lookup";
      break;
    default:
      throw malformedClient("begin");
  }

  if (next === "lookup") {
    assertLease();
    let found: unknown;
    try {
      found = await request.lookup(effectId);
    } catch {
      return suspend();
    }
    if (!isObject(found)) throw malformedLookup(fail, effectId);
    switch (found.status) {
      case "settled":
        if (!("result" in found)) throw malformedLookup(fail, effectId);
        return settle({ status: "settled", result: found.result as DurableValue });
      case "failed":
        if (!(found.error instanceof Error)) throw malformedLookup(fail, effectId);
        return settle({ status: "failed", error: found.error });
      case "unknown":
        return suspend();
      case "not-found":
        break;
      default:
        throw malformedLookup(fail, effectId);
    }
  }

  assertLease();
  let performed: unknown;
  try {
    performed = await request.perform(effectId);
  } catch (err) {
    if (!isDefiniteFailure(err)) return suspend();
    return settle({ status: "failed", error: toError(err) });
  }
  return settle({ status: "settled", result: performed as DurableValue });
}

function malformedLookup(
  fail: (code: EffectDeliveryErrorCode, message: string) => InfrastructureError,
  effectId: string
) {
  return fail(
    "EFFECT_HANDLER_INVALID",
    `lookup for effect "${effectId}" returned a malformed response: expected { status: "settled", result }, { status: "failed", error }, { status: "not-found" } or { status: "unknown" }`
  );
}

// Matches by code too, so an invariant error from another copy of
// @yieldstar/core, or one revived without its class, is still recognised.
function isInvariantError(err: unknown) {
  return (
    err instanceof EffectClientInvariantError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "EFFECT_RUNTIME_INVARIANT")
  );
}

function isOutcome(value: unknown): value is EffectOutcome {
  if (!isObject(value)) return false;
  if (value.status === "settled") return "result" in value;
  if (value.status === "failed") return value.error instanceof Error;
  return false;
}

// A definite failure is stored as an error, so a thrown value that is not an
// Error is wrapped in one.
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  let message: string;
  try {
    message = String(err);
  } catch {
    message = "Thrown value is not an Error";
  }
  return new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
