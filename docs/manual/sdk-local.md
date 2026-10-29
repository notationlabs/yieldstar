# Local SDK

`createLocalSdk` builds a typed client that admits executions directly into a runtime in the same process. It takes your `Router` type as a generic parameter, so TypeScript checks every `workflowId` and its corresponding `params` at compile time.

## Setup

```ts
import { ExecutionDispatcher } from "@yieldstar/core";
import { createLocalSdk } from "yieldstar";
import type { Router } from "./shared";

const sdk = createLocalSdk<Router>(runtime, { invoker });

// The SDK never runs workflow code. A dispatcher must be running somewhere
// against the same runtime to deliver what the SDK admits.
new ExecutionDispatcher(runtime, { invoker, logger }).start();
```

| Option         | Type              | Default | Description                                                                         |
| -------------- | ----------------- | ------- | ----------------------------------------------------------------------------------- |
| `invoker`      | `WorkflowInvoker` | –       | Optional. Lets `triggerAndWait` re-read the record as soon as a delivery is acknowledged |
| `pollInterval` | `number`          | `25`    | Milliseconds between reads of the execution record in `triggerAndWait`              |

## `sdk.trigger`

Admits an execution and resolves with `{ executionId }` once admission commits. Admission writes the [execution record](./workflows.md#execution-records) and makes it due immediately; `trigger` does not wait for a worker to start.

```ts
const { executionId } = await sdk.trigger({
  workflowId: "process-order",
  params: { orderId: "abc123" },
});
```

`trigger` throws an `ExecutionAdmissionError` when admission is rejected:

| `code`                    | Cause                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `EXECUTION_ID_CONFLICT`   | The supplied `executionId` is already in use. IDs are never reused, even after the execution fails |
| `INVALID_EXECUTION_EVENT` | `params` or `context` cannot round-trip through JSON exactly (see below)  |

```ts
import { ExecutionAdmissionError } from "yieldstar";

try {
  await sdk.trigger({ workflowId: "process-order", executionId: "order-abc123", params });
} catch (err) {
  if (err instanceof ExecutionAdmissionError && err.code === "EXECUTION_ID_CONFLICT") {
    // order-abc123 was already admitted
  }
}
```

## `sdk.triggerAndWait`

Admits an execution, then waits for its record to reach a terminal status and returns the workflow's return value.

```ts
const result = await sdk.triggerAndWait({
  workflowId: "process-order",
  params: { orderId: "abc123" },
});
```

The promise settles from the execution record, not from an in-memory event, so it settles even if the worker that ran the execution restarted. If the record is `failed`, the promise rejects with the recorded error. The error keeps its `name`, `message`, `stack`, a string `code`, its `cause` and its durable fields, and it is revived as its class when that class is registered with `registerErrorClass` (see [Errors in step records](./steps.md#errors-in-step-records)).

## Trigger event shape

| Field         | Type                  | Required                 | Description                                                  |
| ------------- | --------------------- | ------------------------ | ------------------------------------------------------------ |
| `workflowId`  | `string`              | Yes                      | ID matching a key in the router                              |
| `params`      | `Record<string, any>` | Depends on workflow type | Input data accessible via `event.params` inside the workflow |
| `executionId` | `string`              | No                       | Custom execution ID. The runtime chooses one if omitted      |
| `context`     | `Record<string, any>` | No                       | Becomes the read-only `event.context` map                    |

Every delivery reads `params` and `context` back from the record exactly as they were admitted, so both must be durable values (see [Step values](./steps.md#step-values)). Admission rejects `Date`s, class instances, `NaN` and `Infinity`, `bigint`, sparse arrays and circular references with `INVALID_EXECUTION_EVENT`. `undefined` properties and errors are accepted and read back unchanged. Pass an ISO string instead of a `Date`.
