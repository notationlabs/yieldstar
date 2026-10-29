import {
  assertSynchronousClaim,
  assertSynchronousUpdater,
  cloneStoreState,
  defineStore,
  type Draft,
  type DurableObject,
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
  WorkflowStartError,
} from "@yieldstar/core";
import { RetryableError } from "../exports/errors";
import { getCallSiteHash } from "./utils";
import {
  StepCallbackError,
  StepRuntimeCall,
  workflowCallback,
  type RuntimeCallResult,
} from "./runtime-call";
import type { WorkflowEvent } from "@yieldstar/core";

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
    selector: StoreSelector<T, R>
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
    selector: StoreSelector<T, R | undefined | null | false>
  ): AsyncGenerator<StepResponse, NonNullable<R>>;
  when<R>(
    key: string,
    selector: StoreSelector<T, R | undefined | null | false>
  ): AsyncGenerator<StepResponse, NonNullable<R>>;
  take<R>(
    key: string,
    selector: StoreSelector<T, R | undefined | null | false>,
    claim: (draft: Draft<T>, selected: NonNullable<R>) => void
  ): AsyncGenerator<StepResponse, NonNullable<R>>;
};

export type StepRunner = ReturnType<typeof createStepRunner>;

export function createStepRunner(params: {
  event: WorkflowEvent;
  clock: () => number;
}) {
  const { event, clock } = params;

  function store<Schema extends StandardSchemaV1>(
    definition: StoreDefinition<Schema>,
    params?: {
      id?: string;
      initial?:
        | StoreState<Schema>
        | (() => StoreState<Schema> | Promise<StoreState<Schema>>);
    }
  ): AsyncGenerator<StepResponse, WorkflowStore<StoreState<Schema>>> {
    const id = params?.id ?? event.executionId;
    const key = `store:${definition.name}:${id}`;

    return storeStep({
      key,
      definition,
      id,
      event,
      initial: params?.initial,
    });
  }

  /**
   * Starts another workflow as a durable step and returns its execution ID.
   * The start is identified by this execution's ID and `stepKey`, so every
   * replay of the step names the same target. A rejected start throws a
   * `WorkflowStartError`.
   */
  function start(
    stepKey: string,
    target: { workflowId: string; params?: DurableObject }
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
    if (target.params !== undefined) request.params = target.params;
    return startStep(stepKey, request);
  }

  return { run, delay: createDelay(clock), poll, store, start };
}

async function* startStep(
  key: string,
  request: ExecutionStartRequest
): AsyncGenerator<StepResponse, { executionId: string }, any> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) {
    yield cached;
    if (cached instanceof StepError) {
      // unreachable – consumer calls throw() on the generator first
      throw cached.err;
    }
    return cached.result;
  }

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

  const result = { executionId: outcome.executionId };
  yield new StepResult(result);
  return result;
}

async function* storeStep<Schema extends StandardSchemaV1>(params: {
  key: string;
  definition: StoreDefinition<Schema>;
  id: string;
  event: WorkflowEvent;
  initial?:
    | StoreState<Schema>
    | (() => StoreState<Schema> | Promise<StoreState<Schema>>);
}): AsyncGenerator<
  StepResponse,
  WorkflowStore<StoreState<Schema>>,
  any
> {
  const { key, definition, id, event, initial } = params;

  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) {
    yield cached;
    if (cached instanceof StepError) {
      throw cached.err;
    }
    return createWorkflowStore({ definition, id, event });
  }

  const created: RuntimeCallResult<unknown> = yield new StepRuntimeCall(
    ({ stores }) =>
      stores.getOrCreateStore({
        definition,
        id,
        initial:
          typeof initial === "function"
            ? async () => {
                try {
                  return await (
                    initial as () =>
                      | StoreState<Schema>
                      | Promise<StoreState<Schema>>
                  )();
                } catch (err) {
                  throw new StepCallbackError(err);
                }
              }
            : initial,
      })
  );

  if (!created.ok) {
    yield new StepError(created.error);
    throw created.error;
  }

  yield new StepResult({ storeName: definition.name, storeId: id });
  return createWorkflowStore({ definition, id, event });
}

function createWorkflowStore<T>(params: {
  definition: StoreDefinition<any>;
  id: string;
  event: WorkflowEvent;
}): WorkflowStore<T> {
  const { definition, id, event } = params;
  const key = { storeName: definition.name, storeId: id };

  return {
    definition,
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

function run<T extends any>(
  fn: () => T | Promise<T>,
): AsyncGenerator<StepResponse, T, StepResult | StepError>;

function run<T extends any>(
  key: string,
  fn: () => T | Promise<T>,
): AsyncGenerator<StepResponse, T, StepResult | StepError>;

// NOTE: run/delay/poll are plain (synchronous) functions that delegate to
// async generators. This matters for keyless steps: the call-site hash must be
// captured while the user's call site is still on the stack. An async
// generator body doesn't execute until its first .next(), which happens inside
// the workflow driver, so hashing there would give every keyless step the same
// key.
function run<T extends any>(
  arg1: string | (() => T | Promise<T>),
  arg2?: (() => T | Promise<T>) | string,
): AsyncGenerator<StepResponse, T, StepResult | StepError> {
  let key: string | null = null;
  let fn: () => T | Promise<T>;

  if (typeof arg1 === "string") {
    key = arg1;
    fn = arg2 as () => T | Promise<T>;
  } else {
    fn = arg1;
  }

  if (!key) key = getCallSiteHash(run);

  return durableStep(key, fn);
}

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

async function* durableStep<T extends any>(
  key: string,
  fn: () => T | Promise<T>
): AsyncGenerator<StepResponse, T, StepResult | StepError> {
  yield new StepKey(key);

  const cached = yield new StepCacheCheck();

  if (cached) {
    yield cached;
    if (cached instanceof StepError) {
      // unreachable – consumer calls throw() on the generator first
      throw cached.err;
    }
    return cached.result;
  }

  try {
    const result = await fn();
    yield new StepResult(result);
    return result;
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

  if (cached) {
    yield cached;
    if (cached instanceof StepError) {
      // unreachable – consumer calls throw() on the generator first
      throw cached.err;
    }
    return cached.result;
  }

  const outcome: RuntimeCallResult<T> = yield new StepRuntimeCall(call);

  if (!outcome.ok) {
    yield new StepError(outcome.error);
    // unreachable – consumer calls throw() on the generator first
    throw outcome.error;
  }

  yield new StepResult(outcome.value);
  return outcome.value;
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

  if (cached) {
    yield cached;
    if (!(cached instanceof StepResult)) {
      throw new Error("Store wait step cache must resolve to a step result");
    }
    return cached.result;
  }

  const read: RuntimeCallResult<StoreSnapshot<unknown>> =
    yield new StepRuntimeCall(({ stores }) =>
      stores.getStore({ definition, id })
    );

  if (!read.ok) {
    yield new StepError(read.error);
    throw read.error;
  }

  const snapshot = read.value;
  const { result, readPaths } = trackStoreSelector(
    cloneStoreState(snapshot.state as T),
    selector
  );

  if (result !== undefined && result !== null && result !== false) {
    const clonedResult = cloneStoreState(result);
    yield new StepResult(clonedResult);
    return clonedResult as NonNullable<R>;
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

  if (cached) {
    yield cached;
    if (!(cached instanceof StepResult)) {
      throw new Error("Store take step cache must resolve to a step result");
    }
    return cached.result;
  }

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

  if (!taken.ok) {
    yield new StepError(taken.error);
    // unreachable – consumer calls throw() on the generator first
    throw taken.error;
  }

  const outcome = taken.value;

  if (outcome.matched) {
    yield new StepResult(outcome.selected);
    return outcome.selected as NonNullable<R>;
  }

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

  if (!registered.ok) {
    yield new StepError(registered.error);
    throw registered.error;
  }

  yield new StepStoreWait();
}
