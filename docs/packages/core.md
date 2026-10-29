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

`runner.run(event, logger?)` resolves with an outcome for everything workflow code can cause, and rejects only with an `InfrastructureError`:

```ts
type WorkflowRunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "suspended"; wakeAt?: number } // wakeAt: when a delay or retry elapses
  | { status: "failed"; error: Error };
```

An event whose `workflowId` has no registered workflow resolves as `failed`. A store wait resolves as `suspended` without `wakeAt`, because a store commit wakes it.

## `ExecutionRecord`

The durable record of one execution. See [Execution records](../manual/workflows.md#execution-records).

```ts
type ExecutionStatus = "admitted" | "suspended" | "completed" | "failed";

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
}
```

## `ExecutionClient` (interface)

Admits executions, holds their pending wakes, and records delivery outcomes.

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

  requestWake(request: { executionId: string; wakeAt: number }): Promise<
    | { status: "requested" }
    | { status: "ignored" } // the execution is terminal
    | { status: "rejected"; code: "EXECUTION_NOT_FOUND"; message: string }
  >;

  claimDue(): Promise<ExecutionDelivery[]>; // ExecutionDelivery = { executionId, token }

  acknowledge(request: {
    delivery: ExecutionDelivery;
    outcome: WorkflowRunOutcome;
  }): Promise<{ status: "suspended" } | ExecutionOutcome>;
}
```

| Method        | Contract                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admit`       | Creates the record as `admitted` and makes it due now, all-or-nothing. Reserves a supplied ID unchanged or chooses one. Rejects a used ID with `EXECUTION_ID_CONFLICT`, and an event that cannot round-trip with `INVALID_EXECUTION_EVENT` |
| `requestWake` | Carries wakes from outside a delivery, such as a store commit. Pending wakes merge into one due time: the earliest                                                       |
| `claimDue`    | Returns executions due at or before the runtime clock, each at most once. A claimed execution is not returned again until it is acknowledged or the redelivery timeout passes |
| `acknowledge` | Records the outcome and clears the wakes the delivery covered. The next due time is the earlier of the outcome's `wakeAt` and any wake requested after the claim. Terminal outcomes are immutable: a later acknowledgement returns the first one |

`ExecutionAdmissionError` (`code: "EXECUTION_ID_CONFLICT" | "INVALID_EXECUTION_EVENT"`) is what the SDKs throw for a rejected admission. `InfrastructureError` wraps a runtime failure; `InfrastructureError.is(err)` recognises one even when several copies of `@yieldstar/core` are loaded.

Runtime adapter authors can import the storage-neutral state machine that `SqliteRuntime` and `MemoryRuntime` share: `prepareExecutionAdmission`, `createExecutionState`, `requestExecutionWake`, `claimExecution`, `acknowledgeExecution`, `nextClaimAt`, `isExecutionClaimable`, `toExecutionRecord`, and the event and outcome codecs. An adapter persists `ExecutionState` however it likes and applies each transition inside one atomic write. `DEFAULT_REDELIVERY_TIMEOUT` is five minutes.

## `ExecutionDispatcher`

The only component that delivers executions. It claims due executions, reads each event from its record, passes it to `invoker.deliver`, and acknowledges the outcome. A terminal execution that is claimed again is acknowledged with its recorded outcome without running workflow code. A delivery that rejects is not acknowledged, so the runtime delivers it again after the redelivery timeout.

```ts
import { ExecutionDispatcher } from "@yieldstar/core";

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();
```

| Option         | Type              | Default | Description                                         |
| -------------- | ----------------- | ------- | --------------------------------------------------- |
| `invoker`      | `WorkflowInvoker` | –       | Runs each delivery                                  |
| `logger`       | `Logger`          | –       | Pino logger                                         |
| `pollInterval` | `number`          | `10`    | Milliseconds between claims when nothing was due    |
| `keepAlive`    | `boolean`         | `true`  | Whether the polling timer keeps the process alive   |

| Method    | Behavior                                                                                   |
| --------- | ------------------------------------------------------------------------------------------ |
| `start()` | Starts the claim loop                                                                      |
| `stop()`  | Stops claiming and waits for in-flight deliveries to settle                                |
| `tick()`  | Claims once and starts those deliveries; resolves with the number claimed, without waiting |
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
  executionId: string;
  stepKey: string;
  stepAttempt: number;
  stepDone: boolean;
  stepResponseJson: string;
}): Promise<void>;
```

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
- Schema failures throw `StoreValidationError` and a missing store throws `StoreNotFoundError`. Workflow code can catch these two; any other error a client throws is treated as an infrastructure error and abandons the delivery.

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
  deliver(event: WorkflowEvent): Promise<WorkflowRunOutcome>;
};
```

`deliver` runs one delivery and resolves with its outcome. It rejects, without an outcome, when the delivery hits an infrastructure error or the worker exits before replying. The dispatcher still emits terminal outcomes on `workflowEndEmitter` as an in-process fast path; no guarantee depends on it.

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
