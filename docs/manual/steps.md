# Steps

Each step wraps a discrete unit of work. 

When a step is yielded, the runtime persists the result, schedules any retries, or yields control back to the workflow to continue execution. 

On subsequent workflow executions, the runtime replays the previously cached value so the step function does not re-execute. 

Note: Steps must be yielded with `yield*`; plain `yield` produces a runtime error.

## `step.run`

`step.run` executes a function, caches its return value, and replays that cached result on subsequent workflow invocation without re-executing the function.

```ts
const result =
  yield *
  step.run(() => {
    return fetchUser(userId);
  });
```

`step.run` accepts sync or async functions:

```ts
const data =
  yield *
  step.run(async () => {
    const res = await fetch("https://api.example.com/data");
    return res.json();
  });
```

## `step.delay`

`step.delay` pauses the workflow for a given number of milliseconds. When a workflow reaches a delay, the runtime records the unfinished step and the delivery ends as `suspended` with `wakeAt` set to the time the delay elapses. The execution record becomes due at that time.

Once it is due, the dispatcher delivers the execution again. All steps before the delay replay from cache, and execution continues from the next step.

```ts
yield * step.delay(30_000); // pause for 30 seconds
```

This makes long pauses (waiting for a cooling-off period, spacing out API calls, scheduling future work) durable across process restarts without blocking a thread.

## `step.poll`

`step.poll` repeatedly evaluates a predicate at a fixed interval until it returns `true` or exhausts its retry budget. It composes `step.run` with `RetryableError` internally, so each attempt is cached and retried on the same schedule as any other step.

```ts
yield *
  step.poll({ retryInterval: 1000, maxAttempts: 10 }, async () => {
    const status = await checkDeployment(deployId);
    return status === "ready";
  });
```

If the predicate returns `false` on every attempt, the step throws after `maxAttempts`. If the predicate throws a non-retryable error, execution stops immediately.

## `step.start`

`step.start` starts another workflow as its own execution and returns `{ executionId }`. It takes a step key and the target workflow:

```ts
const target = yield* step.start("ship", {
  workflowId: "ship-order",
  params: { orderId: event.params.orderId },
});
```

The start is identified by the calling execution's ID and the step key. If a delivery stops after the target is started but before the step is recorded, the next delivery sends the same request and receives the same target, so the workflow is never started twice. The target's execution record links back to the caller and its step as `parent`, and inherits the caller's `context`.

`params` must be plain data: `null`, booleans, finite numbers, strings, and arrays and plain objects built from them. Keys may be in any order.

A rejected start throws a `WorkflowStartError`, which workflow code can catch. Its `code` is:

- `INVALID_START_PARAMETERS` when `params` are not plain data or `workflowId` is empty; or
- `START_REQUEST_MISMATCH` when the step was already started with a different `workflowId` or `params`, for example after a deploy changed the step.

The rejection is recorded, so replay throws the same error. If the runtime fails while starting the target, the error is an infrastructure error: it does not reach workflow code, and the next delivery tries the same start again.

## Cache keys

Yieldstar derives a cache key for each step automatically from the call site. This works for straight-line workflows, but breaks inside loops because every iteration shares the same call site and collides.

To disambiguate, pass an explicit cache key as the first argument:

```ts
for (let i = 0; i < items.length; i++) {
  yield * step.run(`process-item:${i}`, () => processItem(items[i]));
}
```

All three step primitives accept an optional key:

```ts
yield * step.run("key", fn);
yield * step.delay("key", ms);
yield * step.poll("key", opts, predicate);
```

If two steps in the same execution resolve to the same cache key, the runtime throws: `"Each step in a loop must have a unique cache key."`

## Errors

Errors fall into two groups, and only the first reaches workflow code.

| Workflow errors (catchable)                                                   | Infrastructure errors (not catchable)                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Errors thrown by your step functions                                         | The heap or store database throws                              |
| Errors thrown by your store updaters, selectors, claims and initial states    | A worker crashes or exits before reporting an outcome          |
| `StoreValidationError` (a state failed its schema), `StoreNotFoundError`      | The execution client throws during `step.start`                |
| `WorkflowStartError` (`step.start` was rejected)                              |                                                                |

Steps do not call runtime clients themselves. A store step yields a request, and the driver makes the call outside workflow code, then resumes the step with the result. If the call fails with an infrastructure error, the driver does not resume the step, so a `try/catch` around it never runs:

```ts
const order = yield* step.store(OrderStore, { id: event.params.orderId });

try {
  yield* order.update("mark-paid", (draft) => {
    draft.status = "paid";
  });
} catch (err) {
  // Runs for StoreValidationError or an error thrown by the updater.
  // Does not run if SQLite throws: the delivery is abandoned instead.
}
```

An infrastructure error is not an outcome. The delivery is not acknowledged, the execution record keeps its status, and the runtime delivers the execution again after a redelivery delay (1 second, doubling with each consecutive failed delivery, up to 5 minutes). Completed steps replay from the heap, so the retry resumes where the failed delivery stopped.
