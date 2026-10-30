# yieldstar

The main SDK package. Exports the workflow definition API, router factory, error classes, and both SDK clients.

## Install

```sh
bun add yieldstar
```

## Exports

```ts
import { workflow, createWorkflow } from "yieldstar";
import { createWorkflowRouter } from "yieldstar";
import { RetryableError, ExecutionAdmissionError, WorkflowStartError } from "yieldstar";
import { WorkflowValueError, registerErrorClass, WORKFLOW_RESULT_STEP_KEY } from "yieldstar";
import { WorkflowEffectError, EffectDeliveryError, EffectClientInvariantError } from "yieldstar";
import { defineStore } from "yieldstar";
import { createLocalSdk } from "yieldstar";
import { createHttpSdkFactory } from "yieldstar";
import type {
  WorkflowFn,
  StepRunner,
  StepRunOptions,
  DurableStepFn,
  WorkflowStore,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionParent,
  Durable,
  DurableObject,
  DurableValue,
  ErrorClass,
  WorkflowValueErrorCode,
  WorkflowStartErrorCode,
  EffectDescriptor,
  EffectLookup,
  EffectRecord,
  WorkflowEffectErrorCode,
  EffectDeliveryErrorCode,
} from "yieldstar";
```

## `workflow(fn)` / `createWorkflow(fn)`

Defines a workflow. Returns a `WorkflowGenerator`. `Params` and `Result` are checked with `Durable<T>` (see [Step values](../manual/steps.md#step-values)), so a workflow whose params or result type holds a function is a type error. A generic `Result` cannot be checked, so a function that wraps `workflow` must give it a concrete result type.

```ts
const w = workflow<Params, Result>(async function* (step, event, logger) {
  return yield* step.run(() => compute());
});
```

| Type parameter | Constraint                    | Description                                  |
| -------------- | ----------------------------- | -------------------------------------------- |
| `Params`       | `Record<string, any> \| void` | Shape of `event.params`; must be durable     |
| `Result`       | any                           | Return type of the workflow; must be durable |
| `Context`      | `ReadonlyMap<any, any>`       | Shape of `event.context` (set by middleware) |

## `createWorkflowRouter(workflows)`

Registers workflows with string IDs. Returns the same object, typed for SDK consumption.

```ts
const router = createWorkflowRouter({
  order: orderWorkflow,
  reminder: reminderWorkflow,
});
export type Router = typeof router;
```

## `RetryableError`

Thrown inside `step.run` to trigger structured retries. It is registered by default, so replay rethrows a `RetryableError`.

```ts
throw new RetryableError(message, { maxAttempts, retryInterval });
```

| Property        | Type     | Description                        |
| --------------- | -------- | ---------------------------------- |
| `maxAttempts`   | `number` | Total attempts including the first |
| `retryInterval` | `number` | Milliseconds between attempts      |

## `ExecutionAdmissionError`

Thrown by both SDKs' `trigger` when admission is rejected. `err.code` is `"EXECUTION_ID_CONFLICT"` (the `executionId` is already in use) or `"INVALID_EXECUTION_EVENT"` (`params` or `context` are not durable values).

## `WorkflowStartError`

Thrown to workflow code by `step.start` when the runtime rejects the start. `err.code` is `"INVALID_START_PARAMETERS"` (`params` are not a durable value, or `workflowId` is empty) or `"START_REQUEST_MISMATCH"` (the step already started a different workflow or different `params`). See [`step.start`](../manual/steps.md#stepstart).

## `WorkflowEffectError`

Thrown to workflow code by `step.effect`. `err.code` is `"INVALID_EFFECT_REQUEST"` (the `effectId`, `operation`, `input`, `retryIn`, `maxAttempts`, `lookup`, `perform` or `fails` is invalid), `"EFFECT_REQUEST_MISMATCH"` (the effect already exists with a different `operation` or `input`) or `"EFFECT_OUTCOME_UNKNOWN"` (the outcome is still unknown after `maxAttempts` attempts). It is recorded as the step's error, so replay throws the same class and code. See [`step.effect`](../manual/steps.md#stepeffect).

## `EffectDeliveryError`

The `cause` of the `InfrastructureError` with which `step.effect` ends a delivery without recording its step. It never reaches workflow code. `err.code` is `"EFFECT_CLIENT_UNAVAILABLE"`, `"EFFECT_HANDLER_INVALID"` or `"EFFECT_RUNTIME_INVARIANT"`, and `err.effectId` and `err.stepKey` name the effect and step. See [Effect errors](../manual/steps.md#effect-errors).

## `WorkflowValueError`

Thrown to workflow code when a step's value cannot be recorded unchanged. `err.code` is `"INVALID_STEP_VALUE"` (a step result, store state or workflow result is not a durable value) or `"STEP_SCHEMA_INVALID"` (a step's `schema` rejected its value), and `err.stepKey` names the step; it is `WORKFLOW_RESULT_STEP_KEY` (`"$$workflow-result$$"`) for an invalid workflow result. See [Step values](../manual/steps.md#step-values).

## `registerErrorClass(name, errorClass)`

Registers the class that recorded errors named `name` are revived as, in this process. See [Errors in step records](../manual/steps.md#errors-in-step-records).

## `createLocalSdk<Router>(runtime, { invoker?, pollInterval? })`

Creates a local SDK client that admits executions into `runtime`. See [Local SDK](../manual/sdk-local.md).

## `createHttpSdkFactory<Router>()`

Returns a factory for HTTP SDK clients. See [HTTP SDK](../manual/sdk-http.md).

## `defineStore(name, schema, { initial })`

Defines a durable store type from a name, any Standard Schema whose output type is durable (`DurableStoreSchema<Schema>`), and `initial`, a required synchronous function that returns the state of a new store from its `id`. Every operation on a missing store creates it from `initial(id)`. See [Durable Stores](../manual/stores.md#creating-a-store).

```ts
const ConversationStore = defineStore("conversation", schema, {
  initial: (conversationId) => ({ messages: [], status: "idle" }),
});
```

## Step runner

Available on the first argument of a workflow function:

```ts
yield* step.run(fn);
yield* step.run("key", fn);
yield* step.run("key", fn, { schema });

yield* step.delay(ms);
yield* step.delay("key", ms);

yield* step.poll(opts, predicate);
yield* step.poll("key", opts, predicate);

const store = step.store(definition, { id }); // no yield*

yield* step.start("key", { workflowId, params });

yield* step.effect("key", { effectId, operation, input, lookup, perform, retryIn, fails, maxAttempts });
```

`step.store` returns a `WorkflowStore` handle synchronously and records no step, so a loop or helper can request the same store again. `id` defaults to `event.executionId`. The handle has the readonly properties `definition`, `id` and `key`, and the durable operations `get`, `select`, `update`, `updateFrom`, `deleteFrom`, `when` and `take`, each of which creates a missing store from the definition's `initial` – see [Durable Stores](../manual/stores.md) and [Waiting on State](../manual/store-waiting.md). Helpers that take the step runner can type it as `StepRunner`.

`step.start` starts another workflow as its own execution, once per step key, and returns `{ executionId }` – see [Steps](../manual/steps.md#stepstart).

`step.effect` calls an external system under a stable `effectId`, looking up an uncertain earlier attempt before performing it again, and returns the operation's result – see [Steps](../manual/steps.md#stepeffect). Its descriptor is typed `EffectDescriptor<T, Input>`, and `lookup` resolves with an `EffectLookup<T>`:

```ts
type EffectDescriptor<T, Input = DurableObject> = {
  effectId: string;
  operation: string;
  input: Input; // checked with Durable<Input>
  retryIn: number;
  maxAttempts?: number;
  lookup(effectId: string): Promise<EffectLookup<T>>;
  perform(effectId: string): Promise<T>; // T is checked with Durable<T>
  fails?(error: unknown): boolean;
};

type EffectLookup<T> =
  | { status: "settled"; result: T }
  | { status: "failed"; error: Error }
  | { status: "not-found" }
  | { status: "unknown" };
```
