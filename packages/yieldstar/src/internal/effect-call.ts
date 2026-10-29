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
} from "@yieldstar/core";

/** What `lookup` reports about an effect ID (RFC 005). */
export type EffectLookup<T> =
  | { status: "settled"; result: T }
  | { status: "not-found" }
  | { status: "unknown" };

/** The effect request a step yields once its descriptor is valid. */
export type EffectCallRequest = {
  stepKey: string;
  effectId: string;
  operation: string;
  input: DurableObject;
  retryIn: number;
  lookup(effectId: string): Promise<unknown>;
  perform(effectId: string): Promise<unknown>;
};

/**
 * - `settled`: the effect's result, which the step records.
 * - `rejected`: the effect exists with a different operation or input.
 * - `suspended`: the step watches the effect and is due again at `wakeAt`.
 */
export type EffectCallOutcome =
  | { status: "settled"; result: DurableValue }
  | { status: "rejected"; code: "EFFECT_REQUEST_MISMATCH" }
  | { status: "suspended"; wakeAt: number };

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
    clock: () => number;
    /** Checked before every callback, so a lost lease makes no external call. */
    assertLease: () => void;
    logger: Logger;
  }
): Promise<EffectCallOutcome> {
  const { effects, executionId, clock, assertLease, logger } = context;
  const { stepKey, effectId, operation, input, retryIn } = request;

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

  async function suspend(): Promise<EffectCallOutcome> {
    await client("watch", () => effects.watch({ effectId, executionId, stepKey }));
    return { status: "suspended", wakeAt: clock() + retryIn };
  }

  async function settle(result: unknown): Promise<EffectCallOutcome> {
    const encoding = durableValueCodec.encode(result);
    if (encoding.status === "invalid") {
      throw fail(
        "EFFECT_HANDLER_INVALID",
        `Effect "${effectId}" result is not a durable value: ${encoding.message}`
      );
    }
    const settled = await client("settle", () =>
      effects.settle({ operation, effectId, result: result as DurableValue })
    );
    if (!isObject(settled) || !("result" in settled)) throw malformedClient("settle");
    if (settled.status === "conflict") {
      logger.warn(
        {
          executionId,
          stepKey,
          effectId,
          result: settled.result,
          conflictingResult: settled.conflictingResult,
        },
        `Effect "${effectId}" settled with a different result; the first result stands`
      );
    } else if (settled.status !== "settled") {
      throw malformedClient("settle");
    }
    return { status: "settled", result: settled.result };
  }

  const begun = await client("begin", () =>
    effects.begin({ operation, effectId, input, executionId, stepKey })
  );
  if (!isObject(begun)) throw malformedClient("begin");

  let next: "lookup" | "perform";
  switch (begun.status) {
    case "settled":
      if (!("result" in begun)) throw malformedClient("begin");
      return { status: "settled", result: begun.result };
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
        return settle(found.result);
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
  } catch {
    return suspend();
  }
  return settle(performed);
}

function malformedLookup(
  fail: (code: EffectDeliveryErrorCode, message: string) => InfrastructureError,
  effectId: string
) {
  return fail(
    "EFFECT_HANDLER_INVALID",
    `lookup for effect "${effectId}" returned a malformed response: expected { status: "settled", result }, { status: "not-found" } or { status: "unknown" }`
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
