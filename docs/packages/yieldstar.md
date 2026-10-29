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
import { RetryableError, ExecutionAdmissionError } from "yieldstar";
import { defineStore } from "yieldstar";
import { createLocalSdk } from "yieldstar";
import { createHttpSdkFactory } from "yieldstar";
import type { WorkflowFn, WorkflowStore, ExecutionRecord, ExecutionStatus } from "yieldstar";
```

## `workflow(fn)` / `createWorkflow(fn)`

Defines a workflow. Returns a `WorkflowGenerator`.

```ts
const w = workflow<Params, Result>(async function* (step, event, logger) {
  return yield* step.run(() => compute());
});
```

| Type parameter | Constraint                    | Description                                  |
| -------------- | ----------------------------- | -------------------------------------------- |
| `Params`       | `Record<string, any> \| void` | Shape of `event.params`                      |
| `Result`       | any                           | Return type of the workflow                  |
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

Thrown inside `step.run` to trigger structured retries.

```ts
throw new RetryableError(message, { maxAttempts, retryInterval });
```

| Property        | Type     | Description                        |
| --------------- | -------- | ---------------------------------- |
| `maxAttempts`   | `number` | Total attempts including the first |
| `retryInterval` | `number` | Milliseconds between attempts      |

## `ExecutionAdmissionError`

Thrown by both SDKs' `trigger` when admission is rejected. `err.code` is `"EXECUTION_ID_CONFLICT"` (the `executionId` is already in use) or `"INVALID_EXECUTION_EVENT"` (the event cannot round-trip through JSON).

## `createLocalSdk<Router>(runtime, { invoker?, pollInterval? })`

Creates a local SDK client that admits executions into `runtime`. See [Local SDK](../manual/sdk-local.md).

## `createHttpSdkFactory<Router>()`

Returns a factory for HTTP SDK clients. See [HTTP SDK](../manual/sdk-http.md).

## `defineStore(name, schema)`

Defines a durable store type from a name and any Standard Schema. See [Durable Stores](../manual/stores.md).

```ts
const ConversationStore = defineStore("conversation", schema);
```

## Step runner

Available on the first argument of a workflow function:

```ts
yield * step.run(fn);
yield * step.run("key", fn);

yield * step.delay(ms);
yield * step.delay("key", ms);

yield * step.poll(opts, predicate);
yield * step.poll("key", opts, predicate);

yield * step.store(definition, { id, initial });
```

`step.store` returns a `WorkflowStore` handle with `get`, `select`, `update`, `when`, and `take` – see [Durable Stores](../manual/stores.md) and [Waiting on State](../manual/store-waiting.md).
