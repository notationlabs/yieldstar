---
status: proposed
created_at: 2026-07-30
---

# Durable External Effect

## Abstract

A worker can crash after an external system finishes an operation but before Yieldstar saves the result. Therefore, retrying can perform the operation twice, while stopping can leave the workflow without its result.

We will solve this with `step.effect`, which will use a caller-supplied idempotency key to ask the external service what happened after an uncertain attempt. If the service reports that the operation completed, the step will return its result; if the service proves that it did not start, the step can safely try again.

## Problem

`step.run` records its result after its function returns.

```ts
const resource = yield* step.run(`provision:${accountId}`, async () => {
  const resource = await cloud.provision(configuration)

  // The resource now exists, but Yieldstar has not recorded the result.
  // If the worker crashes here, replay will provision it again.
  return resource
})
```

If the cloud service creates the resource but the response is lost, retrying this step calls `provision` again.

## Proposed solution

`step.effect` will give the external operation a stable identity. After an uncertain attempt, it will look up that identity before deciding whether it is safe to perform the operation again.

```ts
const resource = yield* step.effect(`provision:${accountId}`, {
  // This ID belongs to the external operation, not this workflow execution.
  id: `account:${accountId}`,
  input: configuration,
  lookup: id => cloud.lookup(id),

  // Yieldstar will call perform again only after lookup proves that no
  // earlier call exists or can still finish.
  perform: (id, configuration) => cloud.provision(id, configuration),
  retryIn: 60_000,
})
```

## Proposed API

`step.effect` will separate the workflow step from the external operation. The step key will identify where the call occurs in one workflow execution; the effect ID will identify the operation in the external service.

`input`, lookup results, and performed results will be `DurableValue` data. [RFC 001](./001-durable-workflow-start.md#proposed-api) defines `DurableValue`, its validation rules, and its canonical encoding. `durableValueCodec` will be the only validator and canonical encoder for these values.

```ts
type EffectLookup<T extends DurableValue> =
  | { status: "settled"; result: T }
  | { status: "not-found" }
  | { status: "unknown" }

type EffectDescriptor<T extends DurableValue> = {
  effectId: string
  operation: string
  input: { [key: string]: DurableValue }
  retryIn: number
  lookup(effectId: string): Promise<EffectLookup<T>>
  perform(effectId: string): Promise<T>
}

interface StepRunner {
  effect<T extends DurableValue>(
    stepKey: string,
    effect: EffectDescriptor<T>
  ): AsyncGenerator<StepResponse, T, StepResult | StepError>
}
```

`stepKey` will identify the step within one workflow execution. `effectId` will identify the external operation, even when several runtimes can call the same external system.

Every caller of one external operation must use the same `effectId`. No caller may use that ID for a different operation.

`operation` will name the version of the behavior defined by `input`, `lookup`, and `perform`. It will not change after the effect record is created.

`retryIn` must be finite and non-negative. It will set how long the step waits before it looks up an uncertain outcome again.

`step.effect` will not add authorization to an effect result. A workflow that submits the same `effectId`, `operation`, and `input` will receive the stored result.

An application should build `effectId` from every part needed to identify one external operation. Depending on the application, those parts may include:

- the provider account;
- the tenant;
- the kind of operation; and
- the business identity.

## External system contract

Every runtime that calls the external system will need to use the same `effectId` for the same operation. The external system must provide these guarantees for that identity:

1. Concurrent or repeated `perform` calls refer to one operation and return one result.
2. `not-found` proves that no accepted, running, or completed call exists and that no earlier call can later finish.
3. `settled` returns the same result as every successful `perform` call and remains stable.
4. `unknown` means neither `perform` nor absence is safe to assume. A later `lookup` may try again.

A rejected `lookup` or `perform` call will also be an unknown outcome. If the external system cannot provide these guarantees, `step.effect` will not make the operation safe.

## Runtime API

`step.effect` will require the delivery acknowledgement from [RFC 001](./001-durable-workflow-start.md#delivery-acknowledgement).

This RFC will add an `EffectClient` to `@yieldstar/core`:

```ts
interface EffectClient {
  begin(request: {
    operation: string
    effectId: string
    input: { [key: string]: DurableValue }
    executionId: string
    stepKey: string
  }): Promise<
    | { status: "new" }
    | { status: "pending" }
    | { status: "settled"; result: DurableValue }
    | { status: "rejected"; code: "EFFECT_REQUEST_MISMATCH" }
  >

  settle(request: {
    operation: string
    effectId: string
    result: DurableValue
  }): Promise<
    | { status: "settled"; result: DurableValue }
    | {
        status: "conflict"
        result: DurableValue
        conflictingResult: DurableValue
      }
  >

  wait(request: {
    effectId: string
    event: WorkflowEvent
    stepKey: string
    wakeAt: number
  }): Promise<{ wakeAt: number }>
}

class EffectClientInvariantError extends Error {
  code: "EFFECT_RUNTIME_INVARIANT" | "EFFECT_WAITER_MISMATCH"
}

interface WorkflowEffectError extends Error {
  code: "INVALID_EFFECT_REQUEST" | "EFFECT_REQUEST_MISMATCH"
}
```

## Required Semantics

- Each effect will be identified by `effectId`. Its `operation` and `input` will be immutable, and a settled result will never change or be deleted.
- `begin` will create a pending effect before returning `new`. If the effect already exists, a different `operation` or `input` will return `EFFECT_REQUEST_MISMATCH`; matching values will return the effect's current state. Values will match when their canonical encodings match.
- `settle` will settle a pending effect only once. Concurrent calls with the same encoded result will return that result. A call with a different result will keep the first result, return `conflict` with both values, and preserve a permanent conflict report that runtime operators can inspect.
- `wait` will register the calling execution to be woken and will schedule a wake at `wakeAt`. Registration and scheduling will be all-or-nothing.
- Repeating `wait` for the same effect, execution, and step will return the first `wakeAt` without adding another registration. A repeat that carries a different workflow event will throw `EFFECT_WAITER_MISMATCH` and will preserve the first registration.
- When `settle` succeeds, every waiting execution will be woken. No execution will remain registered without a pending or delivered wake.
- Scheduled wakes will survive a runtime restart and will be delivered by the runtime process, not by a child worker.
- A lost scheduler response may create a duplicate wake. This will be safe because both deliveries will read the same effect and step records.
- Error revival will apply only to `StepError`. A plain object that resembles an error will remain a plain object after serialization.

## Driver behavior

`step.effect` will first ask whether a step result is already recorded. When one exists, it will return or throw that result without calling the client or a callback. Otherwise:

| Outcome | Behavior |
| --- | --- |
| Invalid `effectId`, `operation`, `input`, or `retryIn` | The driver will record and throw `INVALID_EFFECT_REQUEST` before `begin`. |
| `begin` returns `new` | The driver will call `perform`. |
| `begin` returns `pending` | The driver will call `lookup`. |
| `begin` returns `settled` | The driver will record and return its result without calling a callback. |
| `begin` returns `EFFECT_REQUEST_MISMATCH` | The driver will record and throw that code without calling a callback. |
| `perform` returns or `lookup` returns `settled` | The driver will validate the result, call `settle`, then record and return its result. |
| `lookup` returns `not-found` | The driver will call `perform`. |
| A callback rejects or `lookup` returns `unknown` | The driver will call `wait`, then suspend the step. |
| `settle` reports a conflict | The driver will report it and record the first result. |
| `begin`, `settle`, or `wait` throws an ordinary error | The driver will record no step and request another delivery with `EFFECT_CLIENT_UNAVAILABLE`. |
| A callback returns a malformed response or invalid value | The driver will record no step, retain the pending effect, and request another delivery with `EFFECT_HANDLER_INVALID`. |
| `EffectClient` throws `EffectClientInvariantError` | The driver will record no step and request another delivery with its code. |

A suspended effect step will remain unfinished. A later delivery will start the effect step again from `begin`. The worker will acknowledge suspension only after both `wait` and the unfinished step record succeed.

`INVALID_EFFECT_REQUEST` and `EFFECT_REQUEST_MISMATCH` will be recorded as `WorkflowEffectError` values. Workflow code may catch them, and their `code` will survive serialization.

Four error codes will request another delivery instead of reaching workflow code:

- `EFFECT_CLIENT_UNAVAILABLE` will describe an uncertain failure that may recover without intervention.
- `EFFECT_HANDLER_INVALID` will report an invalid callback response or result.
- `EFFECT_RUNTIME_INVARIANT` will report invalid data or behavior inside the runtime.
- `EFFECT_WAITER_MISMATCH` will report a repeated wait carrying a different workflow event.

The last three errors will require operator repair if they persist. All four will leave the delivery unacknowledged under [RFC 001](./001-durable-workflow-start.md#delivery-acknowledgement).

If workflow code changes while an effect is pending, the new code must still call `step.effect` with the same `effectId`. Its callbacks must keep the same external-system guarantees. Otherwise, Yieldstar may be unable to discover or safely repeat the operation.

## Conformance tests

Runtime-adapter tests will exercise `EffectClient` and wake delivery:

| Operation or race | Observable outcome |
| --- | --- |
| `begin` creates or reads an effect | One effect exists for the ID; repeated matching calls return its current state. |
| `begin` receives changed operation or input | It rejects without changing the effect. |
| `settle` receives equal results concurrently | One settled result exists. |
| `settle` receives different results | The first result remains settled and one conflict report contains both values. |
| Failure before `wait` commits | No wake is scheduled; a repeated call succeeds as a first call. |
| `wait` commits and its response is lost | Repeating it returns the first wake time and adds nothing. |
| Repeated `wait` carries a different event | It throws `EFFECT_WAITER_MISMATCH` and preserves the first registration. |
| Settlement races with `wait` | The waiting execution is woken; no registration is left without a wake. |
| The runtime restarts with stored wakes | Delivery of those wakes resumes. |
| The scheduler accepts a wake but its response is lost | Resubmission may add one harmless duplicate wake. |

Workflow-driver tests will use a fake client and callbacks:

| Path or interruption | Observable outcome |
| --- | --- |
| New effect | `begin`, `perform`, and `settle` run in order. |
| Pending effect with `not-found` | `begin`, `lookup`, `perform`, and `settle` run in order. |
| Already-settled effect | No callback runs and the recorded result is returned. |
| During `perform`, after external completion, or after its response | `lookup` runs before another `perform`. |
| After `lookup` returns `not-found` | `lookup` runs again before `perform`. |
| After `lookup` returns `settled` but before `settle` | `lookup` runs again and the same result is stored. |
| After `settle` but before the step result | The effect record supplies the result without an external call. |
| After the step result but before workflow continuation | The recorded step supplies the result. |
| `lookup` returns `unknown` or a callback rejects | `wait` completes before the step suspends. |
| Invalid request | `INVALID_EFFECT_REQUEST` is recorded and reaches workflow code without calling the client. |
| Changed operation or input | `EFFECT_REQUEST_MISMATCH` is recorded and reaches workflow code without a callback. |
| Client availability failure | No step is recorded and delivery retry carries `EFFECT_CLIENT_UNAVAILABLE`. |
| Malformed lookup or invalid callback result | No step is recorded, the effect stays pending, and delivery retry carries `EFFECT_HANDLER_INVALID`. |
| Client invariant or waiter mismatch | No step is recorded and delivery retry preserves its operator-repair code. |
| Conflicting settlement | The conflict is reported and the first result is recorded and returned. |

Serialization tests will round-trip every valid durable value, including an error-shaped object, without changing its type or value. They will reject every invalid value. A suspended effect step will remain unfinished after serialization and deserialization.

Integration tests will cover `EffectClient` through queue acknowledgement:

| Interruption | Observable outcome |
| --- | --- |
| `wait` commits, then the worker fails before the unfinished step record | The queue retains the delivery; replay reuses the first registration and wake. |
| The unfinished step record commits, then the worker fails before replying | The queue retains the delivery; replay remains safe. |
| A scheduled wake commits | The execution runs again after delivery, and the wake is not delivered a second time after confirmation. |
| `settle` commits with waiting executions | Each is woken and reads the settled result. |
| `EffectClient` fails inside the worker | The worker replies `retry`, the invoker rejects, the queue retains the delivery, and no step result exists. |

## Not Specified

This RFC will not choose:

- how effect records, waiter registrations, or wake requests are stored;
- how the runtime process schedules and drains wakes;
- the driver-internal step responses that carry an effect request or a suspension; or
- when waiter cleanup runs inside settlement.
