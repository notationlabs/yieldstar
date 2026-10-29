import {
  InfrastructureError,
  StepResponse,
  StoreNotFoundError,
  StoreValidationError,
  WorkflowValueError,
  type ExecutionClient,
  type StoreClient,
} from "@yieldstar/core";

export type RuntimeClients = {
  stores: StoreClient;
  executions: ExecutionClient;
};

export type RuntimeCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Yielded by a step that needs a runtime client. Steps never call runtime
 * clients themselves: the driver makes the call outside workflow code and
 * resumes the step with a `RuntimeCallResult`. Only failures that belong to
 * workflow code (see `isWorkflowFacingError`) resume the step; any other
 * failure is an infrastructure error and ends the delivery without an outcome.
 */
export class StepRuntimeCall<T = unknown> extends StepResponse {
  static type = "runtime-call";
  readonly type = "runtime-call";
  readonly call: (clients: RuntimeClients) => Promise<T>;

  constructor(call: (clients: RuntimeClients) => Promise<T>) {
    super();
    this.call = call;
  }
}

/** Marks an error thrown by a workflow-supplied callback run by a client. */
export class StepCallbackError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "StepCallbackError";
  }
}

/**
 * Wraps a workflow-supplied callback (updater, selector, claim, initial state)
 * that a runtime client will run, so its errors reach workflow code rather
 * than being mistaken for infrastructure errors.
 */
export function workflowCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
  assertResult?: (result: R) => void
): (...args: A) => R {
  return (...args) => {
    try {
      const result = fn(...args);
      assertResult?.(result);
      return result;
    } catch (err) {
      throw new StepCallbackError(err);
    }
  };
}

export async function executeRuntimeCall<T>(
  request: StepRuntimeCall<T>,
  clients: RuntimeClients
): Promise<RuntimeCallResult<T>> {
  try {
    return { ok: true, value: await request.call(clients) };
  } catch (err) {
    if (InfrastructureError.is(err)) throw err;
    if (err instanceof StepCallbackError) return { ok: false, error: err.cause };
    if (isWorkflowFacingError(err)) return { ok: false, error: err };
    throw new InfrastructureError(err);
  }
}

/** Store failures caused by the workflow's own data, which it may catch. */
function isWorkflowFacingError(err: unknown) {
  return (
    err instanceof StoreValidationError ||
    err instanceof WorkflowValueError ||
    err instanceof StoreNotFoundError ||
    (err instanceof Error &&
      (err.name === "StoreValidationError" || err.name === "StoreNotFoundError"))
  );
}

/** Runs a heap operation, tagging its failure as an infrastructure error. */
export async function infrastructure<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw InfrastructureError.is(err) ? err : new InfrastructureError(err);
  }
}
