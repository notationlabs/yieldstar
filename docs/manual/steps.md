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

## Step values

The runtime records each step's result in the step's record, and replay reads the result back from that record. A step's result must therefore be a durable value, so that replay returns exactly what the first run saw:

| Durable                                                       | Not durable                                       |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `null`, booleans, finite numbers, strings                     | `Date`, `Map`, `Set`, `bigint`, functions         |
| `undefined`, as a whole value, a property or an array item    | Class instances, such as `new Reservation()`      |
| Errors, including their class, `code`, `cause` and fields     | `NaN`, `Infinity`, sparse arrays, cycles          |
| Arrays and plain objects made of durable values               | Objects with symbol keys, getters or setters      |

For example, a `reserve-stock` step that returns its hold's expiry as a `Date` is rejected on its first run:

```ts
const reservation = yield* step.run("reserve-stock", async () => ({
  id: "r-42",
  expiresAt: new Date(Date.now() + 15 * 60_000), // ← not durable
}));
// Throws WorkflowValueError with code "INVALID_STEP_VALUE" and stepKey "reserve-stock"
```

The rejection is recorded as the step's error, so replay throws the same `WorkflowValueError`, and workflow code can catch it like any other step error. This is important because the mistake surfaces in the first test run, rather than on a replay hours later. TypeScript catches most of these values earlier with the `Durable<T>` type, so `new Date()` in the example above is a type error. Every API that records a value checks it: `step.run` results, workflow params and results, `step.start` params, `step.effect` inputs and results, store state (through the store's schema output) and the values `select`, `when` and `take` return. Interfaces, optional properties and unions with `undefined` are accepted. A value typed `any` is not checked, and one typed `unknown` is rejected until it is narrowed, since it may hold anything; the runtime still checks both.

Workflow code never receives the object the step function returned. On the first run, `step.run` encodes the result, decodes it again, and returns the decoded copy, which is the same value replay reads from the record:

```ts
const order = { id: 42, note: undefined };
const recorded = yield* step.run("load", async () => order);

recorded === order; // false: a decoded copy
recorded; // { id: 42, note: undefined }: the undefined property keeps its key
```

Plain objects stay plain objects. An object with `name`, `message` and `stack` properties is not an error, and an object with a `$type` key reads back unchanged.

The same rule applies to the values that store steps record, to store state (see [Durable Stores](./stores.md#durable-state)) and to the workflow's own result. A workflow that returns a `Date` fails with `WorkflowValueError` (`INVALID_STEP_VALUE`) and the step key `$$workflow-result$$`.

### Schemas

A step that needs a `Date` returns an ISO string and passes a schema that turns the string into a `Date`. The schema is any [Standard Schema](https://standardschema.dev), such as one from Zod or Valibot:

```ts
const expiresAt = yield* step.run(
  "reserve-stock",
  async () => new Date(Date.now() + 15 * 60_000).toISOString(),
  { schema: z.string().pipe(z.coerce.date()) }
);
// expiresAt is a Date, on the first run and on replay
```

`step.run` validates the decoded value with the schema on the first run and on every replay, and returns the schema's output. The step function must still return a durable value, because the record stores the schema's input, not its output.

The step record notes whether the schema accepted the value on the first run. If the schema rejects it, the raw value is still recorded, and both the first run and replay throw `WorkflowValueError` with the code `STEP_SCHEMA_INVALID`.

### Errors in step records

An error thrown by a step function is recorded too, and replay throws it again. The record keeps the error's `name`, `message`, `stack`, a string `code`, its `cause`, and its own enumerable properties that are durable values. Other properties are left out, on the first run as well as on replay.

Replay revives an error as the class registered under its `name`. A custom class must be registered for `instanceof` to hold:

```ts
import { registerErrorClass } from "yieldstar";

class CourierError extends Error {
  code = "COURIER_DOWN";
  constructor(public courier: string) {
    super(`${courier} is down`);
    this.name = "CourierError";
  }
}
registerErrorClass("CourierError", CourierError);

try {
  yield* step.run("ship", () => courier.book(order));
} catch (err) {
  if (err instanceof CourierError) {
    yield* step.run("ship-backup", () => backupCourier.book(order));
  }
}
```

Revival sets the prototype and fields without calling the constructor, so a constructor with required arguments is fine. Registration is per process: a worker process must register the class too, or it revives the error as a plain `Error` with the same `name`, `message`, `code`, `cause` and fields.

These classes are registered by default: `RetryableError`, `WorkflowStartError`, `WorkflowValueError`, `WorkflowEffectError`, `EffectDeliveryError`, `EffectClientInvariantError`, `StoreValidationError`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError` and `AggregateError`.

A thrown value that is not an error, such as a string or a plain object, is rethrown as it was thrown. A thrown value that is not durable, such as a class instance, is recorded and rethrown as `Error(String(value))`.

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

`params` must be a durable value (see [Step values](#step-values)), and TypeScript checks this with `Durable<T>`. Keys may be in any order, and `{ a: undefined }` is a different request from `{}`.

A rejected start throws a `WorkflowStartError`, which workflow code can catch. Its `code` is:

- `INVALID_START_PARAMETERS` when `params` are not a durable value or `workflowId` is empty; or
- `START_REQUEST_MISMATCH` when the step was already started with a different `workflowId` or `params`, for example after a deploy changed the step.

The rejection is recorded, so replay throws the same error. If the runtime fails while starting the target, the error is an infrastructure error: it does not reach workflow code, and the next delivery tries the same start again.

## `step.effect`

`step.effect` calls an external system, such as a payment provider or a cloud API, so that the operation happens once even when a delivery stops partway through. A `step.run` that charges a card can charge it twice: if the worker crashes after the provider takes the money but before the step is recorded, the next delivery runs the step function again. `step.effect` closes that gap by asking the provider what happened before it tries again.

```ts
const payment = yield* step.effect("charge", {
  effectId: `acct-1:charge:order-${orderId}`,
  operation: "charge-v1",
  input: { amount: 4999 },
  lookup: (effectId) => payments.lookup(effectId),
  perform: (effectId) => payments.charge(effectId, { amount: 4999 }),
  retryIn: 60_000,
});
```

The step key names where the call happens in this execution. `effectId` names the operation in the external system. These are different things: a support tool that checks on the same payment has no `charge` step, but it uses the same effect ID. Every caller that means one operation must use the same `effectId`, and no caller may reuse it for another, so build it from everything that identifies the operation, such as the provider account, the tenant, the kind of operation and the business identity.

| Field       | Description                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `effectId`  | Identifies the operation in the external system. A non-empty string                             |
| `operation` | Names the version of the behaviour of `input`, `lookup` and `perform`. A non-empty string        |
| `input`     | A plain object of durable values that describes the request                                      |
| `lookup`    | Asks the external system what it knows about `effectId`                                          |
| `perform`   | Performs the operation under `effectId` and resolves with its result                             |
| `retryIn`   | Milliseconds to wait before looking up an uncertain outcome again. Finite and not negative       |

Before it calls `perform`, the runtime writes a pending effect record for the effect ID, so the record always exists before the operation can start. When a later attempt finds the record still pending, an earlier call may have started or finished, so it calls `lookup` instead of `perform`. `lookup` resolves with one of three answers:

```ts
type EffectLookup<T> =
  | { status: "settled"; result: T } // the operation happened; here is its result
  | { status: "not-found" } // no call exists, is running, or can still finish
  | { status: "unknown" }; // the system cannot say yet
```

| Situation                                      | What the step does                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| The step is already recorded                   | Returns or throws the recorded value, without calling anything              |
| No effect record exists                        | Calls `perform`                                                             |
| The effect is pending                          | Calls `lookup`                                                              |
| `lookup` returns `not-found`                   | Calls `perform`                                                             |
| `perform` resolves, or `lookup` returns `settled` | Settles the effect with the result, records the step and returns the result |
| The effect is already settled                  | Records and returns the settled result, without calling `lookup` or `perform` |
| `lookup` returns `unknown`, or a callback rejects | Suspends the execution until `retryIn` has passed, then begins again      |

A rejected `lookup` or `perform` counts as `unknown`, because the step cannot tell whether the operation happened. The step suspends, as `step.delay` does, and the delivery ends as `suspended` with `wakeAt` set to now plus `retryIn`. On the next delivery the step begins again and looks up the effect. If another execution settles the effect while this one waits, the runtime wakes this one straight away, and it reads the settled result.

Once settled, an effect never changes. The result is stored in the effect record before the step is recorded, so a crash between the two returns the stored result on the next delivery without calling the external system. Every execution that begins the same effect receives that result.

`input`, the result of `perform` and a settled `lookup` result must be durable values (see [Step values](#step-values)). A `perform` that resolves with nothing, such as a delete, settles the effect with `undefined`. TypeScript checks `input` and the result with `Durable<T>`.

### The external system's guarantees

`step.effect` can only make an operation safe if the external system keeps these promises for each effect ID:

1. Repeated or concurrent `perform` calls make one operation and return one result.
2. `not-found` proves that no call was accepted, is running or has completed, and that no earlier call can still finish. A charge still in flight must not be reported as `not-found`, or a second `perform` charges again.
3. `settled` returns the same result as every successful `perform`, and never changes.
4. `unknown` means neither the result nor its absence is known yet.

Many payment and cloud APIs keep the first promise with an idempotency key; pass the effect ID as that key. If an API cannot keep these promises, `step.effect` does not make it safe to call twice.

If workflow code changes while an effect is pending, the new code must still use the same `effectId`, and its `lookup` and `perform` must keep the same guarantees. Otherwise the runtime may be unable to find out what happened or to repeat the operation safely.

### Effect errors

`step.effect` throws a `WorkflowEffectError`, which workflow code can catch. Its `code` is:

- `INVALID_EFFECT_REQUEST` when `effectId` or `operation` is not a non-empty string, `input` is not a plain object of durable values, `retryIn` is not finite and non-negative, or `lookup` or `perform` is not a function. Nothing is sent to the runtime's effect records.
- `EFFECT_REQUEST_MISMATCH` when the effect already exists with a different `operation` or `input`, for example after a deploy changed the amount. Neither callback runs.

```ts
try {
  yield* step.effect("charge", { ...chargeEffect, input: { amount: 5999 } });
} catch (err) {
  if (err instanceof WorkflowEffectError && err.code === "EFFECT_REQUEST_MISMATCH") {
    // the payment was begun with another amount
  }
}
```

Both are recorded as the step's error, so replay throws the same class and code. Inputs match when their canonical encodings match, so key order does not matter and `{ a: undefined }` differs from `{}`.

The step does not authorize a result: a workflow that submits the same `effectId`, `operation` and `input` receives the stored result.

These failures are not the workflow's to handle, so they do not reach workflow code. The step records nothing, the delivery ends without an outcome and the execution is delivered again after the redelivery delay. The delivery's error is an `InfrastructureError` whose `cause` is an `EffectDeliveryError` with one of these codes:

| Code                        | Cause                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| `EFFECT_CLIENT_UNAVAILABLE` | The runtime's effect records could not be reached. Usually recovers by itself |
| `EFFECT_HANDLER_INVALID`    | `lookup` returned a malformed answer, or a result is not a durable value   |
| `EFFECT_RUNTIME_INVARIANT`  | The runtime's effect records hold invalid data or behaved incorrectly      |

The last two need an operator's repair if they persist. The effect stays pending until a delivery settles it.

If two calls settle one effect with different results, which only happens when the external system breaks its guarantees, the first result stays settled and is returned. The runtime logs a warning with both results and keeps a permanent conflict report on the effect record for operators.

Effect records outlive executions. Cancelling or pruning an execution with a pending effect does not cancel the external operation, and the effect may still settle.

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

`step.start` always takes a key, because the key identifies the start request as well as the cached step. Keep it stable across deploys: a different key starts a different target. `step.effect` always takes a key too; the effect itself is identified by its `effectId`.

If two steps in the same execution resolve to the same cache key, the runtime throws: `"Each step in a loop must have a unique cache key."`

## Errors

Errors fall into two groups, and only the first reaches workflow code.

| Workflow errors (catchable)                                                   | Infrastructure errors (not catchable)                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Errors thrown by your step functions                                         | The heap or store database throws                              |
| Errors thrown by your store updaters, selectors, claims and initial states    | A worker crashes or exits before reporting an outcome          |
| `StoreValidationError` (a state failed its schema)                            | The execution client throws during `step.start`                |
| `WorkflowStartError` (`step.start` was rejected)                              | `step.effect` cannot reach or trust its effect records, or a callback returns a malformed answer (`EffectDeliveryError`) |
| `WorkflowValueError` (a value is not durable, or failed its step's schema)    |                                                                |
| `WorkflowEffectError` (`step.effect` was invalid or mismatched)               |                                                                |

Steps do not call runtime clients themselves. A store step yields a request, and the driver makes the call outside workflow code, then resumes the step with the result. If the call fails with an infrastructure error, the driver does not resume the step, so a `try/catch` around it never runs:

```ts
const order = step.store(OrderStore, { id: event.params.orderId });

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
