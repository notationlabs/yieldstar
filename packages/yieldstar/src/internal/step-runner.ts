import {
  assertSynchronousClaim,
  assertSynchronousUpdater,
  cloneStoreState,
  defineStore,
  type Draft,
  type DurableObject,
  type DurableStoreSchema,
  type IfDurable,
  type ExecutionStartRequest,
  type ExecutionStartResult,
  InfrastructureError,
  type StandardSchemaV1,
  StepResponse,
  StepKey,
  StepError,
  StepResult,
  StepDelay,
  StepCacheCheck,
  StepStoreWait,
  type StoreDefinition,
  type StoreDeleteFromResult,
  type StoreKey,
  type StoreSelector,
  type StoreSnapshot,
  type StoreState,
  type StoreTakeResult,
  type StoreUpdateFromResult,
  type StoreUpdateResult,
  type StoreWaiter,
  trackStoreSelector,
  type Durable,
  type StepSchemaVerdict,
  durableValueCodec,
  StepEffectWait,
  validateEffectRequest,
  WorkflowEffectError,
  WorkflowStartError,
  WorkflowValueError,
} from "@yieldstar/core";
import { RetryableError } from "../exports/errors";
import { getCallSiteHash } from "./utils";
import {
  StepRuntimeCall,
  workflowCallback,
  type RuntimeCallResult,
} from "./runtime-call";
import type { WorkflowEvent } from "@yieldstar/core";
import {
  StepEffectCall,
  type EffectCallOutcome,
  type EffectLookup,
} from "./effect-call";

export type { EffectLookup };

/**
 * @description A library of step generators, each of which:
 * @yields a StepResponse to workflow consumers
 * @returns the result of executing a user-defined function, or
 * @returns the cached result from a previous run, or
 * @throws any error caught when running the user-defined function,
 * once retries have been exhausted, or if there are no retry semantics
 */
export { defineStore };

export type WorkflowStore<T> = {
  readonly definition: StoreDefinition<any>;
  readonly id: string;
  readonly key: StoreKey;
  get(key?: string): AsyncGenerator<StepResponse, StoreSnapshot<T>>;
  select<R>(
    key: string,
    selector: StoreSelector<T, R> & DurableSelector<T, R>
  ): AsyncGenerator<StepResponse, R>;
  update(
    key: string,
    updater: (draft: Draft<T>) => void | T
  ): AsyncGenerator<StepResponse, StoreUpdateResult<T>>;
  updateFrom(
    key: string,
    snapshot: StoreSnapshot<T>,
    updater: (draft: Draft<T>) => void | T
  ): AsyncGenerator<StepResponse, StoreUpdateFromResult<T>>;
  deleteFrom(
    key: string,
    snapshot: StoreSnapshot<T>
  ): AsyncGenerator<StepResponse, StoreDeleteFromResult>;
  when<R>(
    selector: StoreSelector<T, R | undefined | null | false> &
      DurableMatchSelector<T, R>
  ): AsyncGenerator<StepResponse, NonNullable<R>>;
  when<R>(
    key: string,
    selector: StoreSelector<T, R | undefined | null | false> &
      DurableMatchSelector<T, R>
  ): AsyncGenerator<StepResponse, NonNullable<R>>;
  take<R>(
    key: string,
    selector: StoreSelector<T, R | undefined | null | false> &
      DurableMatchSelector<T, R>,
    claim: (draft: Draft<T>, selected: NonNullable<R>) => void
  ): AsyncGenerator<StepResponse, NonNullable<R>>;
};

/** A store selector whose result, which the step records, is durable. */
type DurableSelector<T, R> = IfDurable<R, StoreSelector<T, Durable<R>>>;

/**
 * A `when` or `take` selector whose match is durable. `false` is excluded
 * before the check so that `R` is inferred as it would be without it.
 */
type DurableMatchSelector<T, R> = IfDurable<
  Exclude<R, false>,
  StoreSelector<T, Durable<Exclude<R, false>> | undefined | null | false>
>;

export type StepRunner = ReturnType<typeof createStepRunner>;

export function createStepRunner(params: {
  event: WorkflowEvent;
  clock: () => number;
}) {
  const { event, clock } = params;

  /**
   * Returns a handle to the store `definition.name` + `id`, where `id`
   * defaults to this execution's ID. Obtaining a handle reads, creates and
   * records nothing, so any caller may obtain the same handle again. Each
   * operation on a missing store first creates it from `definition.initial`.
   */
  function store<Schema extends StandardSchemaV1>(
    definition: StoreDefinition<Schema> & {
      schema: DurableStoreSchema<Schema>;
    },
    params?: { id?: string }
  ): WorkflowStore<StoreState<Schema>> {
    return createWorkflowStore({
      definition,
      id: params?.id ?? event.executionId,
      event,
    });
  }

  /**
   * Starts another workflow as a durable step and returns its execution ID.
   * The start is identified by this execution's ID and `stepKey`, so every
   * replay of the step names the same target. A rejected start throws a
   * `WorkflowStartError`.
   */
  function start<Params extends Record<string, any>>(
    stepKey: string,
    target: { workflowId: string; params?: Params & Durable<Params> }
  ): AsyncGenerator<
    StepResponse,
    { executionId: string },
    StepResult | StepError
  > {
    if (stepKey === "") {
      throw new Error("step.start requires a non-empty step key");
    }
    const request: ExecutionStartRequest = {
      requestId: { executionId: event.executionId, stepKey },
      workflowId: target.workflowId,
    };
    // A missing params and an empty object are different requests.
    if (target.params !== undefined) {
      request.params = target.params as DurableObject;
    }
    return startStep(stepKey, request);
  }

  /**
   * Runs an external operation identified by `descriptor.effectId`, at most
   * once in effect: after an uncertain attempt, `lookup` decides whether the
   * operation already happened before `perform` runs again (RFC 005).
   */
  function effect<T, Input extends Record<string, any> = DurableObject>(
    stepKey: string,
    descriptor: EffectDescriptor<T, Input> & DurableEffectResult<T>
  ): AsyncGenerator<StepResponse, T, StepResult | StepError> {
    if (typeof stepKey !== "string" || stepKey === "") {
      throw new Error("step.effect requires a non-empty step key");
    }
    return effectStep(stepKey, descriptor) as AsyncGenerator<
      StepResponse,
      T,
      StepResult | StepError
    >;
  }

  return { run, delay: createDelay(clock), poll, store, start, effect };
}

/**
 * Describes one external operation for `step.effect`. `effectId` names the
 * operation in the external system, so every caller that means it, in any
 * execution or runtime, uses the same ID, and no caller reuses it for another
 * operation. The external system must guarantee that repeated `perform` calls
 * for one ID make one operation with one result, that `not-found` proves no
 * call exists or can still finish, and that `settled` and `failed` never
 * change.
 */
export type EffectDescriptor<T, Input = DurableObject> = {
  effectId: string;
  /** Names the version of the behaviour of `input`, `lookup` and `perform`. */
  operation: string;
  input: Input & Durable<Input>;
  /** Milliseconds before an uncertain outcome is looked up again. */
  retryIn: number;
  /**
   * The number of attempts that may end uncertain before the step throws a
   * `WorkflowEffectError` with code `EFFECT_OUTCOME_UNKNOWN`. Without it, the
   * step looks the effect up until its outcome is known.
   */
  maxAttempts?: number;
  /** Reports what the external system knows about `effectId`. */
  lookup(effectId: string): Promise<EffectLookup<T>>;
  /** Performs the operation under `effectId`. */
  perform(effectId: string): Promise<T>;
  /**
   * Returns true when an error thrown by `perform` proves that the operation
   * failed and will never succeed. The effect then fails with the error, and
   * the step throws it. Any other thrown value leaves the outcome uncertain.
   */
  fails?(error: unknown): boolean;
};

/**
 * Checks the effect's result type without taking part in its inference. A
 * `perform` that resolves with nothing settles the effect with `undefined`.
 */
type DurableEffectResult<T> = [T] extends [void]
  ? unknown
  : IfDurable<T, { perform(effectId: string): Promise<Durable<T>> }>;

async function* effectStep(
  key: string,
  descriptor: EffectDescriptor<unknown, unknown>
): AsyncGenerator<StepResponse, unknown, any> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) return yield* replay(cached);

  const { effectId, operation, input, retryIn, maxAttempts, lookup, perform, fails } =
    (descriptor ?? {}) as Partial<EffectDescriptor<unknown, unknown>>;
  const invalid = invalidEffectRequest({
    effectId,
    operation,
    input,
    retryIn,
    maxAttempts,
    lookup,
    perform,
    fails,
  });
  if (invalid) {
    const err = new WorkflowEffectError(
      "INVALID_EFFECT_REQUEST",
      `step.effect "${key}": ${invalid}`
    );
    yield new StepError(err);
    // unreachable – consumer calls throw() on the generator first
    throw err;
  }

  const outcome: EffectCallOutcome = yield new StepEffectCall({
    stepKey: key,
    effectId: effectId!,
    operation: operation!,
    input: input as DurableObject,
    retryIn: retryIn!,
    maxAttempts,
    lookup: (id) => lookup!.call(descriptor, id),
    perform: (id) => perform!.call(descriptor, id),
    fails: fails && ((error) => fails.call(descriptor, error)),
  });

  switch (outcome.status) {
    case "settled":
      return yield* record(outcome.result);
    case "failed":
      yield new StepError(outcome.error);
      throw outcome.error;
    case "unknown": {
      const err = new WorkflowEffectError(
        "EFFECT_OUTCOME_UNKNOWN",
        `The outcome of effect "${effectId}" is still unknown after ${outcome.attempts} ${
          outcome.attempts === 1 ? "attempt" : "attempts"
        }`
      );
      yield new StepError(err);
      throw err;
    }
    case "rejected": {
      const err = new WorkflowEffectError(
        outcome.code,
        `Effect "${effectId}" was begun with a different operation or input`
      );
      yield new StepError(err);
      throw err;
    }
    case "suspended":
      yield new StepEffectWait(outcome.wakeAt);
      throw new Error("Effect wait yielded control unexpectedly");
  }
}

function invalidEffectRequest(request: {
  effectId: unknown;
  operation: unknown;
  input: unknown;
  retryIn: unknown;
  maxAttempts: unknown;
  lookup: unknown;
  perform: unknown;
  fails: unknown;
}): string | undefined {
  const validated = validateEffectRequest(request);
  if (!validated.ok) return validated.message;
  const { retryIn } = request;
  if (typeof retryIn !== "number" || !Number.isFinite(retryIn) || retryIn < 0) {
    return "retryIn must be a finite, non-negative number";
  }
  const { maxAttempts } = request;
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    return "maxAttempts must be a positive integer";
  }
  if (typeof request.lookup !== "function") return "lookup must be a function";
  if (typeof request.perform !== "function") return "perform must be a function";
  if (request.fails !== undefined && typeof request.fails !== "function") {
    return "fails must be a function";
  }
  return undefined;
}

async function* startStep(
  key: string,
  request: ExecutionStartRequest
): AsyncGenerator<StepResponse, { executionId: string }, any> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) return yield* replay(cached);

  const started: RuntimeCallResult<ExecutionStartResult> =
    yield new StepRuntimeCall(async ({ executions }) => {
      // The client's failures are never the workflow's to catch: whatever it
      // throws, the delivery ends and the next attempt calls it again.
      try {
        return await executions.start(request);
      } catch (err) {
        throw InfrastructureError.is(err) ? err : new InfrastructureError(err);
      }
    });

  if (!started.ok) {
    throw new Error("ExecutionClient.start failed without an infrastructure error");
  }

  const outcome = started.value;

  if (outcome.status === "rejected") {
    const err = new WorkflowStartError(outcome.code, outcome.message);
    yield new StepError(err);
    // unreachable – consumer calls throw() on the generator first
    throw err;
  }

  return yield* record({ executionId: outcome.executionId });
}

function createWorkflowStore<T>(params: {
  definition: StoreDefinition<any>;
  id: string;
  event: WorkflowEvent;
}): WorkflowStore<T> {
  const { id, event } = params;
  const key = { storeName: params.definition.name, storeId: id };
  // Any operation may run `initial` on a missing store, so its errors must
  // reach workflow code instead of ending the delivery as infrastructure.
  const definition: StoreDefinition<any> = {
    ...params.definition,
    initial: workflowCallback(params.definition.initial),
  };

  return {
    definition: params.definition,
    id,
    key,
    get(stepKey?: string) {
      return runtimeStep(
        stepKey ?? getCallSiteHash(this.get),
        async ({ stores }) =>
          (await stores.getStore({ definition, id })) as StoreSnapshot<T>
      );
    },
    select<R>(stepKey: string, selector: StoreSelector<T, R>) {
      return runtimeStep(stepKey, async ({ stores }) => {
        const snapshot = await stores.getStore({ definition, id });
        // Run the selector against a clone so accidental mutation cannot
        // corrupt shared state (consistent with when, which throws via
        // its tracking proxy).
        return workflowCallback(selector)(cloneStoreState(snapshot.state as T));
      });
    },
    update(stepKey, updater) {
      return runtimeStep(
        stepKey,
        async ({ stores }) =>
          (await stores.updateStore({
            definition,
            id,
            updater: workflowCallback(updater, assertSynchronousUpdater) as any,
            // Exactly-once across the store-commit/heap-write gap: on replay
            // after a crash, the store's applied-steps ledger returns the
            // recorded result instead of re-running the updater.
            stepId: { executionId: event.executionId, stepKey },
          })) as StoreUpdateResult<T>
      );
    },
    updateFrom(stepKey, snapshot, updater) {
      return runtimeStep(
        stepKey,
        async ({ stores }) =>
          (await stores.updateStoreFrom({
            definition,
            id,
            snapshot,
            updater: workflowCallback(updater, assertSynchronousUpdater) as any,
            stepId: { executionId: event.executionId, stepKey },
          })) as StoreUpdateFromResult<T>
      );
    },
    deleteFrom(stepKey, snapshot) {
      return runtimeStep<StoreDeleteFromResult>(stepKey, ({ stores }) =>
        stores.deleteStoreFrom({
          definition,
          id,
          snapshot,
          stepId: { executionId: event.executionId, stepKey },
        })
      );
    },
    when<R>(
      arg1:
        | string
        | StoreSelector<T, R | undefined | null | false>,
      arg2?: StoreSelector<T, R | undefined | null | false>
    ) {
      const stepKey =
        typeof arg1 === "string" ? arg1 : getCallSiteHash(this.when);
      const selector = (
        typeof arg1 === "string" ? arg2 : arg1
      ) as StoreSelector<T, R | undefined | null | false>;

      return whenStep({
        definition,
        id,
        event,
        stepKey,
        selector,
      });
    },
    take<R>(
      stepKey: string,
      selector: StoreSelector<T, R | undefined | null | false>,
      claim: (draft: Draft<T>, selected: NonNullable<R>) => void
    ) {
      return takeStep({
        definition,
        id,
        event,
        stepKey,
        selector,
        claim,
      });
    },
  };
}

export type StepRunOptions<S extends StandardSchemaV1> = {
  /**
   * Validates the step's decoded value, on the first run and on every
   * replay; the step returns the schema's output. The step function must
   * return the schema's input as a durable value.
   */
  schema: S;
};

/**
 * A step function whose result, or the value its promise resolves to, is a
 * durable value. Checking the whole function type keeps the result's type as
 * TypeScript infers it, and names the offending property in the error.
 */
export type DurableStepFn<F> = F extends () => infer R
  ? () => R extends PromiseLike<infer U> ? PromiseLike<DurableUnion<U>> : DurableUnion<R>
  : never;

type DurableUnion<T> = T extends unknown ? Durable<T> : never;

function run<F extends () => unknown>(
  fn: F & DurableStepFn<F>
): AsyncGenerator<StepResponse, Awaited<ReturnType<F>>, StepResponse>;

function run<F extends () => unknown>(
  key: string,
  fn: F & DurableStepFn<F>
): AsyncGenerator<StepResponse, Awaited<ReturnType<F>>, StepResponse>;

function run<S extends StandardSchemaV1>(
  fn: () => StepSchemaInput<S> | PromiseLike<StepSchemaInput<S>>,
  options: StepRunOptions<S>
): AsyncGenerator<StepResponse, StandardSchemaV1.InferOutput<S>, StepResponse>;

function run<S extends StandardSchemaV1>(
  key: string,
  fn: () => StepSchemaInput<S> | PromiseLike<StepSchemaInput<S>>,
  options: StepRunOptions<S>
): AsyncGenerator<StepResponse, StandardSchemaV1.InferOutput<S>, StepResponse>;

// NOTE: run/delay/poll are plain (synchronous) functions that delegate to
// async generators. This matters for keyless steps: the call-site hash must be
// captured while the user's call site is still on the stack. An async
// generator body doesn't execute until its first .next(), which happens inside
// the workflow driver, so hashing there would give every keyless step the same
// key.
function run(
  arg1: string | (() => unknown),
  arg2?: (() => unknown) | StepRunOptions<StandardSchemaV1>,
  arg3?: StepRunOptions<StandardSchemaV1>
): AsyncGenerator<StepResponse, any, StepResponse> {
  let key: string | null = null;
  let fn: () => unknown;
  let options: StepRunOptions<StandardSchemaV1> | undefined;

  if (typeof arg1 === "string") {
    key = arg1;
    fn = arg2 as () => unknown;
    options = arg3;
  } else {
    fn = arg1;
    options = arg2 as StepRunOptions<StandardSchemaV1> | undefined;
  }

  if (!key) key = getCallSiteHash(run);

  return durableStep(key, fn, options?.schema);
}

type StepSchemaInput<S extends StandardSchemaV1> = Durable<
  StandardSchemaV1.InferInput<S>
>;

/** `step.delay`, reading its wake time from the runtime clock. */
function createDelay(clock: () => number) {
  function delay(retryInterval: number): any;
  function delay(key: string, retryInterval: number): any;
  function delay(
    arg1: string | number,
    arg2?: number
  ): AsyncGenerator<any, void, StepDelay> {
    let key: string | null = null;
    let retryInterval: number;

    if (typeof arg1 === "string") {
      key = arg1;
      retryInterval = arg2!;
    } else {
      retryInterval = arg1;
    }

    if (!key) key = getCallSiteHash(delay);

    return delayStep(key, retryInterval, clock);
  }

  return delay;
}

async function* delayStep(
  key: string,
  retryInterval: number,
  clock: () => number
): AsyncGenerator<any, void, StepDelay> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) {
    yield new StepDelay(cached.wakeAt);
  } else {
    yield new StepDelay(clock() + retryInterval);
  }
}

type PollOpts = { maxAttempts: number; retryInterval: number };
type PollPredicate = () => boolean | Promise<boolean>;

function poll(opts: PollOpts, predicate: PollPredicate): any;
function poll(key: string, opts: PollOpts, predicate: PollPredicate): any;

function poll(
  arg1: string | PollOpts,
  arg2: PollOpts | PollPredicate,
  arg3?: PollPredicate
) {
  let key: string | null = null;
  let opts: PollOpts;
  let predicate: PollPredicate;

  if (typeof arg1 === "string") {
    key = arg1;
    opts = arg2 as PollOpts;
    predicate = arg3 as PollPredicate;
  } else {
    opts = arg1;
    predicate = arg2 as PollPredicate;
  }

  if (!key) key  = getCallSiteHash(poll);

  const task = async () => {
    if (!(await predicate())) {
      throw new RetryableError("Polling reached max retries", {
        maxAttempts: opts.maxAttempts,
        retryInterval: opts.retryInterval,
      });
    }
  };

  return run(key, task);
}

async function* durableStep(
  key: string,
  fn: () => unknown,
  schema: StandardSchemaV1 | undefined
): AsyncGenerator<StepResponse, any, any> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) {
    const value = yield* replay(cached);
    if (!schema) return value;
    const validated = await validateStepValue(key, schema, value);
    if (cached.schema === "rejected" && validated.ok) {
      throw new WorkflowValueError(
        "STEP_SCHEMA_INVALID",
        key,
        `Step "${key}" schema rejected its value on the first run`
      );
    }
    return unwrapValidated(validated);
  }

  let result: unknown;
  try {
    result = await fn();
  } catch (err: unknown) {
    if (err instanceof RetryableError) {
      yield new StepError(err, {
        maxAttempts: err.maxAttempts,
        retryInterval: err.retryInterval,
      });
    } else {
      yield new StepError(err);
    }
    // unreachable – consumer calls throw() on the generator first
    throw err;
  }

  if (!schema) return yield* record(result);

  // The schema validates the value as replay will decode it. A value the
  // codec rejects is left for the driver to record as INVALID_STEP_VALUE.
  const encoding = durableValueCodec.encode(result);
  if (encoding.status === "invalid") return yield* record(result);
  const decoding = durableValueCodec.decode(encoding.canonical);
  if (decoding.status === "invalid") throw new Error(decoding.message);
  const validated = await validateStepValue(key, schema, decoding.value);
  yield* record(result, validated.ok ? "accepted" : "rejected");
  return unwrapValidated(validated);
}

type ValidatedStepValue =
  | { ok: true; value: unknown }
  | { ok: false; error: WorkflowValueError };

async function validateStepValue(
  key: string,
  schema: StandardSchemaV1,
  value: unknown
): Promise<ValidatedStepValue> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const messages = result.issues.map((issue) => issue.message).join("; ");
    return {
      ok: false,
      error: new WorkflowValueError(
        "STEP_SCHEMA_INVALID",
        key,
        `Step "${key}" value failed its schema: ${messages}`
      ),
    };
  }
  return { ok: true, value: result.value };
}

function unwrapValidated(validated: ValidatedStepValue) {
  if (!validated.ok) throw validated.error;
  return validated.value;
}

/**
 * Yields a step's result for the driver to record, and returns the decoded
 * record the driver resumes the step with, so that the first run returns
 * what replay will.
 */
async function* record<T>(
  result: T,
  schema?: StepSchemaVerdict
): AsyncGenerator<StepResponse, T, any> {
  const recorded: StepResult = yield new StepResult(result, schema);
  return recorded.result;
}

/** Yields a recorded response; the driver throws a recorded error into the step. */
async function* replay(cached: StepResponse): AsyncGenerator<StepResponse, any, any> {
  const recorded: StepResult = yield cached;
  return recorded.result;
}

/**
 * Yields a store step's error for the driver to record and throw. A value
 * error raised by a store client is given this step's key.
 */
async function* fail(key: string, error: unknown): AsyncGenerator<StepResponse, never, any> {
  const err =
    error instanceof WorkflowValueError && error.stepKey !== key
      ? new WorkflowValueError(error.code, key, error.message)
      : error;
  yield new StepError(err);
  // unreachable – consumer calls throw() on the generator first
  throw err;
}

/**
 * A durable step whose work is a runtime client call. The driver makes the
 * call and resumes the step with its result.
 */
async function* runtimeStep<T>(
  key: string,
  call: StepRuntimeCall<T>["call"]
): AsyncGenerator<StepResponse, T, any> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) return yield* replay(cached);

  const outcome: RuntimeCallResult<T> = yield new StepRuntimeCall(call);

  if (!outcome.ok) return yield* fail(key, outcome.error);

  return yield* record(outcome.value);
}

async function* whenStep<T, R>(params: {
  definition: StoreDefinition<any>;
  id: string;
  event: WorkflowEvent;
  stepKey: string;
  selector: StoreSelector<T, R | undefined | null | false>;
}): AsyncGenerator<StepResponse, NonNullable<R>, any> {
  const { definition, id, event, stepKey, selector } = params;

  yield new StepKey(stepKey);

  const cached = yield new StepCacheCheck();

  if (cached) return yield* replay(cached);

  const read: RuntimeCallResult<StoreSnapshot<unknown>> =
    yield new StepRuntimeCall(({ stores }) =>
      stores.getStore({ definition, id })
    );

  if (!read.ok) return yield* fail(stepKey, read.error);

  const snapshot = read.value;
  const { result, readPaths } = trackStoreSelector(
    cloneStoreState(snapshot.state as T),
    selector
  );

  if (result !== undefined && result !== null && result !== false) {
    return yield* record(result as NonNullable<R>);
  }

  yield* registerWaiter({
    workflowId: event.workflowId,
    executionId: event.executionId,
    stepKey,
    storeName: definition.name,
    storeId: id,
    instanceId: snapshot.instanceId,
    sinceVersion: snapshot.version,
    readPaths,
  });

  throw new Error("Store wait yielded control unexpectedly");
}

async function* takeStep<T, R>(params: {
  definition: StoreDefinition<any>;
  id: string;
  event: WorkflowEvent;
  stepKey: string;
  selector: StoreSelector<T, R | undefined | null | false>;
  claim: (draft: Draft<T>, selected: NonNullable<R>) => void;
}): AsyncGenerator<StepResponse, NonNullable<R>, any> {
  const { definition, id, event, stepKey, selector, claim } = params;

  yield new StepKey(stepKey);

  const cached = yield new StepCacheCheck();

  if (cached) return yield* replay(cached);

  const taken: RuntimeCallResult<StoreTakeResult<R>> =
    yield new StepRuntimeCall(({ stores }) =>
      stores.takeFromStore({
        definition,
        id,
        selector: workflowCallback(selector) as any,
        claim: workflowCallback(claim, assertSynchronousClaim) as any,
        // Exactly-once across the store-commit/heap-write gap: on replay
        // after a crash, the store's applied-steps ledger returns the
        // recorded (matched) outcome instead of re-running selector/claim.
        stepId: { executionId: event.executionId, stepKey },
      })
    );

  if (!taken.ok) return yield* fail(stepKey, taken.error);

  const outcome = taken.value;

  if (outcome.matched) return yield* record(outcome.selected as NonNullable<R>);

  yield* registerWaiter({
    workflowId: event.workflowId,
    executionId: event.executionId,
    stepKey,
    storeName: definition.name,
    storeId: id,
    instanceId: outcome.instanceId,
    sinceVersion: outcome.version,
    readPaths: outcome.readPaths,
  });

  throw new Error("Store take yielded control unexpectedly");
}

/** Registers a waiter, then suspends the step until a store change wakes it. */
async function* registerWaiter(
  waiter: StoreWaiter
): AsyncGenerator<StepResponse, void, any> {
  const registered: RuntimeCallResult<void> = yield new StepRuntimeCall(
    ({ stores }) => stores.registerWaiter(waiter)
  );

  if (!registered.ok) return yield* fail(waiter.stepKey, registered.error);

  yield new StepStoreWait();
}
