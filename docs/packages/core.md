# @yieldstar/core

Base types, abstract classes, the `WorkflowRunner` execution engine, and the `ExecutionDispatcher`. This package defines the interfaces that runtime implementations such as `@yieldstar/sqlite-runtime` must satisfy.

## Install

```sh
bun add @yieldstar/core
```

## `Runtime` (abstract class)

A runtime bundles the three clients that hold durable state, and the clock they all read. `SqliteRuntime` and `MemoryRuntime` extend it.

```ts
abstract class Runtime {
  abstract readonly clock: () => number; // shared by every client and by delay and retry steps
  abstract readonly executions: ExecutionClient;
  abstract readonly heap: HeapClient;
  abstract readonly stores: StoreClient;
}

interface RuntimeOptions {
  clock?: () => number; // every client reads time from this; defaults to Date.now
}
```

A runtime is defined by the guarantees its clients keep together, not by how many databases it uses. See [Runtime guarantees](https://github.com/notationlabs/yieldstar/blob/main/docs/store-connector-spec.md#runtime-guarantees).

## `WorkflowRunner`

Runs one delivery of a workflow against a runtime's heap and stores. The runner replays the generator, advances it to the next durable boundary, and resolves with a `WorkflowRunOutcome`.

```ts
import { WorkflowRunner } from "@yieldstar/core";

const runner = new WorkflowRunner(runtime, { router, logger });
```

| Param            | Type             | Description                       |
| ---------------- | ---------------- | --------------------------------- |
| `runtime`        | `Runtime`        | Supplies `heap` and `stores`      |
| `options.router` | `WorkflowRouter` | Map of workflow IDs to generators |
| `options.logger` | `Logger`         | Pino logger                       |

`runner.run(event, { lease, signal, logger? })` runs the delivery under `lease`, the `ExecutionLease` the dispatcher claimed. Every step write carries it. The method resolves with an outcome for everything workflow code can cause, and rejects only with an `InfrastructureError`:

```ts
type WorkflowRunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "suspended"; wakeAt?: number } // wakeAt: when a delay or retry elapses
  | { status: "failed"; error: Error };
```

An event whose `workflowId` has no registered workflow resolves as `failed`. A store wait resolves as `suspended` without `wakeAt`, because a store commit wakes it.

Two step-write results also reject with an `InfrastructureError`, and both end the delivery without an outcome:

- The write returns `lost` because another claim has taken over. The cause is a `LeaseLostError`.
- The step is already recorded with a different value. The cause is a `StepConflictError`. The record stands, the delivery ends as a retry, and the next delivery replays the recorded value.

## `ExecutionRecord`

The durable record of one execution. See [Execution records](../manual/workflows.md#execution-records).

```ts
type ExecutionStatus = "admitted" | "running" | "suspended" | "completed" | "failed";

type ExecutionOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: Error };

interface ExecutionRecord {
  executionId: string;
  workflowId: string;
  params: EventParams;
  context: EventContext; // a ReadonlyMap
  status: ExecutionStatus;
  outcome?: ExecutionOutcome; // present only when completed or failed
  admittedAt: number;
  updatedAt: number;
  unacknowledgedDeliveryCount: number; // consecutive deliveries that ended without an acknowledgement
  parent?: ExecutionParent; // present only on executions admitted by `start`
}

type ExecutionParent = { executionId: string; stepKey: string };
```

`parent` names the execution and step that started this one with [`step.start`](../manual/steps.md#stepstart). It is set when the target is admitted and never changes. An execution admitted through `admit`, such as a trigger, has no parent.

`running` means the execution has a live lease. When the lease ends without a terminal acknowledgement, the status returns to `suspended` if an earlier delivery was acknowledged as suspended, and to `admitted` otherwise. Operators can read `unacknowledgedDeliveryCount` to find executions that keep failing.

## `ExecutionClient` (interface)

Admits executions, holds their pending wakes, leases due executions to dispatchers, and records delivery outcomes.

```ts
interface ExecutionClient {
  admit(request: {
    executionId?: string;
    workflowId: string;
    params: EventParams;
    context: EventContext;
  }): Promise<
    | { status: "accepted"; executionId: string }
    | { status: "rejected"; code: ExecutionAdmissionErrorCode; message: string }
  >;

  get(executionId: string): Promise<ExecutionRecord | undefined>;

  start(request: {
    requestId: { executionId: string; stepKey: string }; // the calling execution and its step
    workflowId: string;
    params?: DurableObject;
  }): Promise<
    | { status: "accepted"; executionId: string }
    | { status: "rejected"; code: WorkflowStartErrorCode; message: string }
  >;

  requestWake(request: { executionId: string; wakeAt: number }): Promise<
    | { status: "requested" }
    | { status: "ignored" } // the execution is terminal
    | { status: "rejected"; code: "EXECUTION_NOT_FOUND"; message: string }
  >;

  claimDue(request: { limit: number; duration: number }): Promise<ExecutionLease[]>;

  renew(request: {
    lease: ExecutionLease;
    duration: number;
  }): Promise<{ status: "renewed"; lease: ExecutionLease } | LeaseLost>;

  release(request: { lease: ExecutionLease }): Promise<{ status: "released" } | LeaseLost>;

  acknowledge(request: {
    lease: ExecutionLease;
    outcome: WorkflowRunOutcome;
  }): Promise<{ status: "suspended" } | ExecutionOutcome | LeaseLost>;
}

type ExecutionLease = { executionId: string; token: number; expiresAt: number };
type LeaseLost = { status: "lost" };
```

| Method        | Contract                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admit`       | Creates the record as `admitted` and makes it due now, all-or-nothing. Reserves a supplied ID unchanged or chooses one. Rejects a used ID with `EXECUTION_ID_CONFLICT`, and `params` or `context` values that `durableValueCodec` cannot encode, or `context` keys that are not strings, with `INVALID_EXECUTION_EVENT` |
| `start`       | Admits a target execution on behalf of the step named by `requestId`, idempotently by that ID. A new start admits the target due now, with the caller's `context` and `parent` set to `requestId`, and records the start request, all-or-nothing. A repeated request ID returns the first target's ID if its `workflowId` and canonical `params` match, and `START_REQUEST_MISMATCH` otherwise, whatever the target's status. Missing `params` and `{}` do not match. An empty `workflowId`, or `params` that are not a plain object or that `durableValueCodec` cannot encode, return `INVALID_START_PARAMETERS` and admit nothing |
| `requestWake` | Carries wakes from outside a delivery, such as a store commit. Pending wakes merge into one due time: the earliest                                                       |
| `claimDue`    | Leases up to `limit` executions that are due at or before the runtime clock and have no live lease, earliest due first. Each lease lasts `duration` ms and carries a token greater than every earlier token for that execution. An execution has at most one live lease at a time, across every client sharing the backend |
| `renew`       | Extends the lease to `duration` ms from now. Returns `lost` once a higher token has been issued or the lease has ended. An expired lease that nobody has claimed again is still current |
| `release`     | Ends the lease without an outcome. The delivery counts as unacknowledged, so the execution is claimable again after the redelivery delay |
| `acknowledge` | Records the outcome and ends the lease, clearing the wakes the delivery covered. The next due time is the earlier of the outcome's `wakeAt` and any wake requested after the claim. A stale lease returns `lost` and changes nothing |

`renew`, `release`, `acknowledge` and `HeapClient.writeStep` are fenced: the adapter checks the lease's token and makes the write in one atomic step, and accepts the write only if the token is current. Clocks decide only when an execution becomes claimable again; tokens decide whose writes count. A holder that receives `lost` must stop, without acknowledging. `start` is not fenced: it is idempotent by its request ID, so a stale holder that calls it receives the same target and starts nothing new.

A lease ends without an acknowledgement when it is released, or when it expires and another claim takes over. Each such delivery adds one to `unacknowledgedDeliveryCount`, and any acknowledgement resets it to zero. While it is above zero, the execution waits a redelivery delay after the delivery ended before it can be claimed. The delay starts at 1 second and doubles with each unacknowledged delivery, up to 5 minutes (`redeliveryDelay(n)`).

`ExecutionAdmissionError` (`code: "EXECUTION_ID_CONFLICT" | "INVALID_EXECUTION_EVENT"`) is what the SDKs throw for a rejected admission. `WorkflowStartError` (`code: "INVALID_START_PARAMETERS" | "START_REQUEST_MISMATCH"`) is what `step.start` throws to workflow code for a rejected start; the rejection is recorded as the step's result, so replay throws the same class and code. `InfrastructureError` wraps a runtime failure; `InfrastructureError.is(err)` recognises one even when several copies of `@yieldstar/core` are loaded. `isLeaseLost(value)` recognises a `LeaseLost` result.

Runtime adapter authors can import the storage-neutral state machine that `SqliteRuntime` and `MemoryRuntime` share: `prepareExecutionAdmission`, `createExecutionState`, `prepareExecutionStart`, `matchStartRequest`, `createStartedExecution`, `requestExecutionWake`, `claimExecution`, `renewExecutionLease`, `releaseExecutionLease`, `acknowledgeExecution`, `isLeaseCurrent`, `nextClaimAt`, `isExecutionClaimable`, `toExecutionRecord`, and the event and outcome codecs. An adapter persists `ExecutionState` however it likes and applies each transition inside one atomic write. A fenced heap write checks `isLeaseCurrent` in the same write. For `start`, an adapter validates the request with `prepareExecutionStart`, looks up the request ID, answers a recorded request with `matchStartRequest`, and otherwise inserts the target and the `StartRequestState` from `createStartedExecution` in one atomic write, choosing another ID if the target's is in use. `DEFAULT_LEASE_DURATION` (30 seconds), `REDELIVERY_DELAY_BASE` and `REDELIVERY_DELAY_MAX` are the defaults.

## `durableValueCodec`

The one codec for every durable value (RFC 004). It validates values, encodes them as canonical JSON and decodes them back unchanged. Execution `params`, `context` and outcomes are stored with it, and `ExecutionClient.start` compares params by their canonical encoding.

```ts
type DurableValue =
  | null | boolean | number | string | undefined | Error
  | DurableValue[] | DurableObject;
type DurableObject = { [key: string]: DurableValue };

type DurableValueEncoding =
  | { status: "encoded"; canonical: string }
  | { status: "invalid"; message: string };
type DurableDecoding =
  | { status: "decoded"; value: DurableValue }
  | { status: "invalid"; message: string };

const durableValueCodec: {
  encode(value: unknown): DurableValueEncoding;
  decode(canonical: string): DurableDecoding;
};

// Compile-time check for a recorded value; accepts interfaces.
type Durable<T> = /* T, or never where T holds a Date, Map, Set, bigint or function */;
```

`encode` accepts `null`, booleans, finite numbers, strings, `undefined`, errors, arrays with no missing items, and plain objects (the default prototype or `null`) whose own properties are enumerable data properties with string keys. It rejects functions, symbols, bigints, `NaN` and infinities, class instances such as `Date` and `Map`, accessors, symbol or non-enumerable properties, missing array items and reference cycles, and returns a message naming the path of the first invalid value. Neither method throws for an invalid input.

The canonical string sorts object keys and writes `-0` as `0`, so two values that differ only in key order encode to the same string. Values JSON cannot hold are tagged objects with a `$type` key:

| Value | Encoding |
| --- | --- |
| `undefined` | `{"$type":"undefined"}` |
| A plain object with its own `$type` key | `{"$type":"object","value":{...}}` |
| An error | `{"$type":"error","name":...,"message":...,"stack"?,"code"?,"cause"?,"errors"?,"fields"?}` |

So `{ a: undefined }` and `{}` stay distinct, and only a tagged value decodes as `undefined` or an error: an error-shaped plain object stays a plain object.

An error keeps its `name`, `message`, a string `stack` and `code`, its own `cause` (encoded recursively), a non-enumerable `errors` array such as `AggregateError`'s, and its own enumerable properties whose values are durable, under `fields`. Properties that are not durable are left out rather than rejecting the error. `encodeThrownValue(value)` encodes a thrown value as thrown when it is durable, and as `Error(String(value))` otherwise.

`decode` revives an error as the class registered under its `name` with `registerErrorClass(name, errorClass)`, setting its prototype and fields without calling the constructor, and as an `Error` with the same name, message, code, cause and fields when no class is registered. Registration is per process. `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`, `WorkflowStartError`, `WorkflowValueError`, `StoreValidationError` and `StoreNotFoundError` are registered by default, and `yieldstar` registers `RetryableError`.

`WorkflowValueError` (`code: "INVALID_STEP_VALUE" | "STEP_SCHEMA_INVALID"`, `stepKey`) reports a value the codec or a step's schema rejects. A completed outcome whose result the codec rejects is recorded as `failed` with `INVALID_STEP_VALUE` and `stepKey` `WORKFLOW_RESULT_STEP_KEY` (`"$$workflow-result$$"`).

## `ExecutionDispatcher`

The only component that delivers executions. It leases due executions, reads each event from its record, passes it to `invoker.deliver` with the lease, and acknowledges the outcome under that lease. A terminal execution that is claimed again returns its recorded outcome without running workflow code.

- **Concurrency.** It runs up to `concurrency` deliveries at once, and claims new executions as slots free up without waiting for earlier deliveries to reach an outcome. Several dispatchers, in one process or several, can share one backend: each execution has at most one live lease.
- **Renewal.** It renews each lease every `renewInterval` while the delivery runs, so a slow delivery keeps its lease. If a renewal returns `lost`, it stops renewing, aborts the delivery's `signal`, and neither acknowledges nor releases.
- **Abandonment.** If an aborted delivery has not settled `abortGracePeriod` after the abort, the dispatcher stops waiting for it and frees its slot. This covers in-process invokers, which cannot stop a step function that is already running. The abandoned delivery may keep running, but its signal and stale token block every write it attempts, and its late outcome or rejection is logged and ignored. The worker invoker kills its worker on abort, so its deliveries settle at once.
- **Rejections.** A delivery that rejects is not acknowledged. If the worker exited before replying (`WorkerExitedError`), the dispatcher leaves the lease to expire. Any other rejection is a retry reply, and the dispatcher releases the lease. Either way the execution is delivered again after the redelivery delay.
- **Backend errors.** If reading the record, acknowledging or releasing throws, the dispatcher logs the error and leaves the lease to expire rather than trying to release it. This is intended: expiry is safe, it counts as an unacknowledged delivery, so the execution is delivered again after the redelivery delay, and the backend that just threw may be unreachable anyway.

```ts
import { ExecutionDispatcher } from "@yieldstar/core";

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();
```

| Option          | Type              | Default              | Description                                         |
| --------------- | ----------------- | -------------------- | --------------------------------------------------- |
| `invoker`       | `WorkflowInvoker` | –                    | Runs each delivery                                  |
| `logger`        | `Logger`          | –                    | Pino logger                                         |
| `concurrency`   | `number`          | `10`                 | The maximum number of deliveries this dispatcher runs at once |
| `pollInterval`  | `number`          | `10`                 | Milliseconds between claims when nothing was due    |
| `keepAlive`     | `boolean`         | `true`               | Whether the dispatcher's timers keep the process alive |
| `leaseDuration` | `number`          | `30_000`             | Milliseconds each lease lasts unless renewed        |
| `renewInterval` | `number`          | `leaseDuration / 3`  | Milliseconds between renewals; must be shorter than `leaseDuration` |
| `abortGracePeriod` | `number`       | `1_000`              | Milliseconds to wait for a delivery after aborting it before abandoning it and freeing its slot |

| Method    | Behavior                                                                                   |
| --------- | ------------------------------------------------------------------------------------------ |
| `start()` | Starts the claim loop                                                                      |
| `stop()`  | Stops claiming and waits for in-flight deliveries to settle                                |
| `tick()`  | Claims once, up to the free slots, and starts those deliveries; resolves with the number claimed, without waiting |
| `drain()` | Waits for every delivery started so far to settle                                          |

## `waitForExecutionOutcome`

`waitForExecutionOutcome(executions, executionId, { emitter?, pollInterval?, signal? })` polls `executions.get` until the record is terminal and resolves with its `ExecutionOutcome`, or with `undefined` when no record exists. `pollInterval` defaults to `25` ms. The local SDK and the `/events` route use it; passing the invoker's `workflowEndEmitter` as `emitter` triggers an early re-read when the dispatcher acknowledges.

## `HeapClient` (abstract class)

Persistence layer for step results, indexed by `(executionId, stepKey)`.

```ts
abstract readStep(params: {
  executionId: string;
  stepKey: string;
}): Promise<HeapRecord | null>;

abstract writeStep(params: {
  lease: ExecutionLease;
  stepKey: string;
  stepAttempt: number;
  done: boolean;
  stepResponseJson: string;
}): Promise<HeapRecord | LeaseLost>;
```

`readStep` returns the latest attempt. `writeStep` is fenced by `lease`: if the lease is not current, nothing changes and it returns `lost`. A `done` record deletes the step's store waiters in the same write. Records are keyed by execution, step key and attempt, and never change once written. Rewriting an existing record succeeds without changing it and resolves with the record as stored, so the caller can compare it with the value it wrote.

## `HeapRecord`

```ts
type HeapRecord = {
  stepResponseJson: string;
  meta: { attempt: number; done: boolean };
};
```

## `StoreClient` (abstract class)

Persistence layer for [durable stores](../manual/stores.md). An implementation
owns store state and versions, waiters created by `when`/`take`, an applied-steps
ledger, and the wakes a commit requests from the runtime's `ExecutionClient`. The ledger records each committed workflow update by
`(executionId, stepKey)` so replay can return the result without applying the
update again.

```ts
abstract getOrCreateStore(params: {
  definition: StoreDefinition;
  id: string;
  initial?: State | (() => State | Promise<State>);
}): Promise<StoreSnapshot>;

abstract getStore(params: {
  definition: StoreDefinition;
  id: string;
}): Promise<StoreSnapshot>;

abstract updateStore(params: {
  definition: StoreDefinition;
  id: string;
  updater: (draft: Draft) => void | State;
  stepId?: StoreStepId; // identifies the workflow step; keys the applied-steps ledger
}): Promise<StoreUpdateResult>;

abstract updateStoreFrom(params: {
  definition: StoreDefinition;
  id: string;
  snapshot: StoreSnapshot;
  updater: (draft: Draft) => void | State;
  stepId?: StoreStepId;
}): Promise<StoreUpdateFromResult>;

abstract listStores(definition: StoreDefinition): Promise<string[]>;
abstract deleteStore(params: { definition: StoreDefinition; id: string }): Promise<void>;
abstract deleteStoreFrom(params): Promise<StoreDeleteFromResult>;

abstract takeFromStore(params): Promise<StoreTakeResult>;

abstract registerWaiter(waiter: StoreWaiter): Promise<void>;
```

The base class also provides `storeClient.store(definition, id)`, the external read/write handle described in [External Store Access](../manual/store-external.md).

An implementation must uphold these contracts:

- Every store instance has a UUIDv7 instance ID; `(definition.name, id)` remains the unique logical lookup key.
- Each update atomically writes the state, increments the version by one, and records its workflow-step result when a `stepId` is present.
- Snapshot-based updates and deletions compare both the instance ID and version.
- When `stepId` is provided and the ledger already holds that step, the implementation returns the recorded result and does not run the updater.
- `registerWaiter` compares the store's current instance and version with the waiter; if either has moved on, it wakes the waiter immediately rather than leaving it to sleep through a write that already happened.
- A commit that satisfies a waiter requests a wake for the waiter's `executionId`. Once the commit is durable, that wake is durable too. A waiter carries no copy of the workflow event.
- A waiter stays registered until the heap write that records its step's result deletes it.
- Schema failures throw `StoreValidationError` and a missing store throws `StoreNotFoundError`. A state, initial state or take selection that is not a durable value throws `WorkflowValueError` (`INVALID_STEP_VALUE`) before anything commits; `validateStoreState` makes this check after the schema. Workflow code can catch these three; any other error a client throws is treated as an infrastructure error and abandons the delivery.

## `CasStoreClient` (abstract class)

Base class for connectors that support compare-and-swap (CAS). It implements
`updateStore`, `updateStoreFrom`, and `takeFromStore`; a connector supplies
ledger lookup and the atomic mutation operation:

```ts
abstract getAppliedStoreStep(params): Promise<{ result: unknown } | undefined>;

abstract commitStoreMutation(
  mutation: StoreMutation
): Promise<
  | { status: "committed" }
  | { status: "already-applied"; result: unknown }
  | { status: "conflict"; snapshot: StoreSnapshot<unknown> }
>;
```

`commitStoreMutation` checks the applied-step ledger first, compares the
expected instance ID and version, and atomically writes the next state, version,
step result, and the wakes for any waiters the commit satisfies. On conflict it returns the current
snapshot so the base class can recompute the update. Application callbacks run
outside the connector's transaction and may run more than once.

## `WorkflowInvoker` (type)

```ts
type WorkflowInvoker = {
  /** @deprecated The execution record is the source of truth for outcomes. */
  workflowEndEmitter: EventEmitter;
  deliver(
    event: WorkflowEvent,
    options: { lease: ExecutionLease; signal: AbortSignal }
  ): Promise<WorkflowRunOutcome>;
};
```

`deliver` runs one delivery under `lease` and resolves with its outcome. Once `signal` aborts, the delivery runs no more workflow code and makes no more fenced writes, and rejects with an `InfrastructureError` whose cause is the signal's reason. An invoker that can stop a running step function should, and reject at once: the worker invoker kills its worker. It rejects, without an outcome, when the delivery hits an infrastructure error or the worker exits before replying. A worker exit rejects with a `WorkerExitedError`, and the dispatcher leaves the lease to expire. The dispatcher treats every other rejection as a retry reply and releases the lease. The dispatcher still emits terminal outcomes on `workflowEndEmitter` as an in-process fast path; no guarantee depends on it.

## Step response classes

| Class             | Type string          | Description                                         |
| ----------------- | -------------------- | --------------------------------------------------- |
| `StepKey`         | `"step-key"`         | Cache key for the current step                      |
| `StepCacheCheck`  | `"cache-check"`      | Signals the runner to look up cached state          |
| `StepResult`      | `"step-result"`      | Wraps a successful step return value                |
| `StepError`       | `"step-error"`       | Wraps a caught error with optional retry policy     |
| `StepDelay`       | `"step-delay"`       | Carries a `wakeAt` timestamp                        |
| `StepInvalid`     | `"step-invalid"`     | Protocol violation (e.g., missing `yield*`)         |
| `WorkflowResult`  | `"workflow-result"`  | Wraps the workflow's return value                   |
| `WorkflowDelay`   | `"workflow-delay"`   | No longer emitted by `WorkflowRunner`               |
| `WorkflowRestart` | `"workflow-restart"` | Signals the runtime to re-invoke                    |

## Event types

```ts
type TriggerEvent<WorkflowId, Params> = {
  workflowId: WorkflowId;
  executionId?: string;
  params: Params;
  context?: Record<string, any>;
};

type ExecutionEvent<Params> = {
  workflowId: string;
  executionId: string;
  params: Params;
  context?: Record<string, any>;
};

type WorkflowEvent<Params, Context> = {
  workflowId: string;
  executionId: string;
  params: Params;
  context: Context;
};
```

## Middleware types

```ts
type MiddlewareNext = () => Promise<Response>;

type MiddlewareFunction = (
  req: Request,
  event: MiddlewareEvent,
  next: MiddlewareNext,
  logger: Logger,
) => Promise<Response>;
```
