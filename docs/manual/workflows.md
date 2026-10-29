# Defining Workflows

A workflow is an async generator function that yields steps. The `workflow()` factory wraps that generator into a `WorkflowGenerator`.

## Basic definition

```ts
import { workflow } from "yieldstar";

const myWorkflow = workflow(async function* (step, event, logger) {
  const a = yield* step.run(() => 1);
  const b = yield* step.run(() => a + 1);
  return b;
});
```

The generator function receives three arguments:

| Argument | Type                             | Description                                                   |
| -------- | -------------------------------- | ------------------------------------------------------------- |
| `step`   | `StepRunner`                     | Exposes `run`, `delay`, `poll`, `store`, `start` and `effect` |
| `event`  | `WorkflowEvent<Params, Context>` | Contains `workflowId`, `executionId`, `params`, and `context` |
| `logger` | `Logger` (Pino)                  | Structured logger scoped to the execution                     |

`workflow` and `createWorkflow` are aliases. Both return a `WorkflowGenerator`.

## Type parameters

`workflow()` accepts two type parameters: the input params and the return type.

```ts
const processOrder = workflow<{ orderId: string }, boolean>(async function* (step, event) {
  const order = yield* step.run(() => fetchOrder(event.params.orderId));
  return yield* step.run(() => processPayment(order));
});
```

These types carry through to the SDK when the workflow is registered in a router, so `workflowId`, `params`, and the return type are all enforced at the call site.

## Execution model

Every time the runtime invokes a workflow, the generator replays from the beginning. 

Steps that have already completed return their cached result from the heap with no re-execution and no side effects. 

When the generator reaches a step that has not yet run, it executes the function, persists the result to the heap, and advances. 

If the generator hits a `delay` or a retryable error, it yields control back to the runtime. The delivery ends as `suspended` with the time the paused step needs (`wakeAt`), the execution record becomes due at that time, and the process terminates.

On the next invocation the same replay happens: cached steps resolve instantly, and the generator picks up where it left off. This means a workflow can span minutes, hours, or days while the process that runs it is ephemeral.

```ts
const w = workflow(async function* (step) {
  // Execution 1: runs, caches result
  // Execution 2: replays from cache
  const a = yield* step.run(() => expensiveComputation());

  // Execution 1: suspends here, due again in 5s
  // Execution 2: elapsed, continues
  yield* step.delay(5000);

  // Execution 2: runs, caches result
  const b = yield* step.run(() => useResult(a));

  return b;
});
```

## Execution records

Each trigger creates one execution, and the runtime keeps one durable `ExecutionRecord` for it. Admission writes the record with the event (`workflowId`, `params`, `context`) once, and every delivery reads the event back from it.

```ts
interface ExecutionRecord {
  executionId: string;
  workflowId: string;
  params: EventParams;
  context: EventContext;
  status: "admitted" | "running" | "suspended" | "completed" | "failed";
  outcome?: { status: "completed"; result: unknown } | { status: "failed"; error: Error };
  admittedAt: number;
  updatedAt: number;
  unacknowledgedDeliveryCount: number; // consecutive deliveries that ended without an outcome
  parent?: { executionId: string; stepKey: string }; // set when step.start admitted it
}
```

| Status      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `admitted`  | No delivery has been acknowledged yet                                |
| `running`   | A dispatcher holds a live lease on the execution and is delivering it |
| `suspended` | The latest delivery paused on a delay, retry, store wait or effect wait |
| `completed` | The workflow returned. `outcome.result` holds the return value       |
| `failed`    | Workflow code threw an uncaught error. `outcome.error` holds it      |

`completed` and `failed` are terminal and permanent. A finished execution never runs workflow code again: a later delivery returns the recorded outcome.

An execution started by another workflow with [`step.start`](./steps.md#stepstart) records the caller's execution ID and step key as `parent`. The link never changes, and executions created by a trigger have none.

**Execution IDs are unique for the lifetime of the runtime.** A trigger may supply its own `executionId`, and the runtime reserves it unchanged; otherwise the runtime chooses one. Reusing an ID that was ever admitted, including one whose execution failed, is rejected with `EXECUTION_ID_CONFLICT`. This matters because the ID is how a replay finds its own recorded steps, so a reused ID would replay another execution's results.

A record is `running` while a dispatcher holds a lease on it, and otherwise changes status only when a delivery is acknowledged with an outcome. If a delivery hits an infrastructure error (the database throws, the worker exits), it ends without an outcome: the record returns to its earlier status, `unacknowledgedDeliveryCount` goes up by one, and the execution is delivered again after a redelivery delay. The delay starts at 1 second and doubles with each consecutive unacknowledged delivery, and any acknowledgement resets the count. Such errors never reach workflow code; see [Steps](./steps.md#errors).

## Registering workflows

A router maps string IDs to workflow generators:

```ts
import { createWorkflowRouter } from "yieldstar";

const router = createWorkflowRouter({
  "process-order": processOrder,
  "send-reminder": sendReminder,
});

export type Router = typeof router;
```

Exporting the `Router` type and passing it to the SDK factory gives you type-safe `workflowId` and `params` at every call site.
