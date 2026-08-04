---
status: proposed
created_at: 2026-07-30
---

# Durable Workflow Start

## Abstract

When a workflow triggers another workflow, it is possible – in rare circumstances – for it to be triggered twice. This occurs when a worker crashes after the inner workflow has been created, but before the durable step records completion. In that case, the step is replayed and the inner workflow is triggered again.

To solve this problem, we will introduce `step.start` specifically for starting another workflow as a durable step. If the step is replayed, it will return the original target execution instead of triggering the workflow again.

## Problem

Yieldstar records each completed step so that a workflow can resume after a crash.

Yieldstar has no step for starting another workflow. Authors must call `trigger` inside `step.run`.

```ts
yield* step.run("start:job:job-1", async () => {
  const promisedTarget = sdk.trigger({
    workflowId: "process-job",
    params: { jobId: "job-1" },
  })

  // If the worker crashes here, replay will trigger the workflow again.

  return promisedTarget
})
```

## Proposed solution

`step.start` will start another workflow as a durable step. Replaying it with the same step key will return the first target instead of creating another.

```ts
// Replaying this step will return the same target execution ID.
const target = yield* step.start("start:job:job-1", {
  workflowId: "process-job",
  params: { jobId: "job-1" },
})
```

## Proposed API

`step.start` will take a step key and a target workflow. It will return `{ executionId }` for the target it creates or finds.

```ts
type DurableValue =
  | null
  | boolean
  | number
  | string
  | DurableValue[]
  | DurableObject

type DurableObject = { [key: string]: DurableValue }

type DurableValueEncoding =
  | { status: "encoded"; canonical: string }
  | { status: "invalid"; message: string }

interface DurableValueCodec {
  encode(value: unknown): DurableValueEncoding
}

declare const durableValueCodec: DurableValueCodec

interface StepRunner {
  start(
    stepKey: string,
    target: {
      workflowId: string
      params?: DurableObject
    }
  ): AsyncGenerator<
    StepResponse,
    { executionId: string },
    StepResult | StepError
  >
}
```

Parameters will accept:

- `null`;
- booleans;
- finite numbers;
- strings;
- arrays with no missing items; and
- plain objects whose values follow these same rules.

A plain object will:

- have the default object prototype or `null`; and
- contain only its own enumerable data properties with string keys.

Parameters will reject:

- accessors;
- symbol or non-enumerable properties;
- missing array items;
- `undefined`;
- functions;
- symbols;
- reference cycles.

`@yieldstar/core` will export the `durableValueCodec` value. Its `encode` operation will validate recursively and return either an error message or one canonical JSON string. It will sort object keys and encode `-0` as `0`.

## Runtime API

This RFC will add these types to `@yieldstar/core`:

```ts
interface ExecutionClient {
  admit(request: {
    executionId?: string
  }): Promise<
    | { status: "accepted"; executionId: string }
    | {
        status: "rejected"
        code: "EXECUTION_ID_CONFLICT"
        message: string
      }
  >
}

interface WorkflowStartClient {
  start(request: {
    requestId: {
      executionId: string
      stepKey: string
    }
    workflowId: string
    params?: DurableObject
  }): Promise<
    | { status: "accepted"; executionId: string }
    | {
        status: "rejected"
        code: WorkflowStartErrorCode
        message: string
      }
  >
}

type WorkflowStartErrorCode =
  | "INVALID_START_PARAMETERS"
  | "START_REQUEST_MISMATCH"

declare class ExecutionAdmissionError extends Error {
  readonly code: "EXECUTION_ID_CONFLICT"
}

declare class WorkflowStartError extends Error {
  constructor(
    readonly code: WorkflowStartErrorCode,
    message: string
  )
}
```

## Required Semantics

- A start request will be identified by the caller's execution ID and the step key.
- A repeated request with the same workflow ID and parameters will return the first target execution ID without starting another workflow.
- A repeated request with a different workflow ID or parameters will return `START_REQUEST_MISMATCH`, also after the target has been delivered and acknowledged.
- Parameter values will match when their canonical encodings match. Missing parameters and an empty object will not match.
- `WorkflowStartClient` will validate parameters with `durableValueCodec` and will return `INVALID_START_PARAMETERS` when encoding fails, without admitting an execution or queuing a target.
- A successful new start will be all-or-nothing: either the target execution exists and is queued for delivery, or no trace of the request is observable.
- Execution IDs will be unique across the runtime and will never be reused. Two start requests will never receive the same execution ID, and a started execution will never collide with a directly triggered one.
- An accepted start will be recorded as a durable step. Replay will return the recorded `{ executionId }` without another client call.
- A rejected start will be recorded and thrown to workflow code as `WorkflowStartError`. Replay will restore the same class and code without another client call.
- If `WorkflowStartClient` throws, no step will be recorded and workflow code will not be able to catch the error. The next execution attempt will call the client again with the same request ID.
- Direct `trigger` will admit its execution ID through `ExecutionClient` before launching a worker. An unused caller-supplied ID will be reserved and returned unchanged; an ID already in use will return `EXECUTION_ID_CONFLICT`, the SDK will throw `ExecutionAdmissionError`, and the HTTP trigger route will return `409 Conflict`.
- If worker launch fails after admission, the execution ID will remain reserved. Execution IDs will not be recycled according to launch outcome.
- Direct-trigger parameters will remain governed by the existing `TriggerEvent` contract. They will not be encoded or stored by execution admission.
- `createLocalSdk` and the HTTP trigger handler will return the execution ID accepted by `ExecutionClient` instead of generating one in the client.

## Delivery acknowledgement

Queue delivery and direct trigger need different acknowledgements. A queued target can be removed only after the workflow reaches a durable outcome. A direct `trigger` needs to know only that its worker started.

```ts
type WorkflowRunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "suspended" }
  | { status: "failed"; error: Error }

interface WorkflowInvoker {
  workflowEndEmitter: EventEmitter
  launch(event: ExecutionEvent): Promise<void>
  deliver(event: ExecutionEvent): Promise<void>
}
```

Each `WorkflowRunOutcome` will mean that the matching durable work is finished:

- `completed` will mean that the workflow result is recorded;
- `suspended` will mean that the unfinished step and every wake needed to resume it are recorded; and
- `failed` will mean that an uncaught workflow error is recorded as the terminal workflow result.

After a terminal outcome is recorded, a later delivery will return the same outcome without executing workflow code again.

An error thrown by infrastructure – rather than by workflow code – will not be recorded as a workflow failure. The run will reject, the worker will reply `retry`, and the same execution will be delivered again. A child error or exit before a durable outcome will have the same meaning.

`workflowEndEmitter` will remain the completion-observation contract used by `triggerAndWait` and the HTTP events route. It will emit a result for `completed` and an error for `failed`. It will not emit for `suspended`. An operational error from a directly launched invocation will continue to emit an error so an existing completion waiter does not hang. A rejected queued delivery will not emit a completion error because that execution remains eligible for another delivery.

`WorkflowInvoker.deliver` will resolve without a value after a durable outcome and will reject after `retry`, a child error, or an early exit. The event loop will remove a queued target only when `deliver` resolves; if it rejects, the target will stay in the queue and will become available again when its visibility timeout expires.

`WorkflowInvoker.launch` will preserve the existing direct-trigger contract by resolving when the child process starts, without waiting for its workflow outcome. Direct `trigger` will not use the event-loop queue.

`@yieldstar/worker-invoker` and `@yieldstar/test-invoker` will implement the same `launch` and `deliver` contract.

## Conformance tests

Runtime-adapter tests will exercise `WorkflowStartClient`, `ExecutionClient`, and the delivery queue:

| Case | Observable outcome |
| --- | --- |
| Failure before a new start commits | No queued target becomes observable; a repeated call succeeds as a first call. |
| Start commit followed by a lost response | A repeated call returns the committed execution ID; exactly one target is queued. |
| Two concurrent calls with one start-request ID | Both return the same execution ID; exactly one target is queued. |
| Two different start-request IDs | Each receives a different execution ID. |
| Direct admission receives an unused caller-supplied ID | It reserves and returns that exact ID. |
| Direct admission receives an ID in use | It returns `EXECUTION_ID_CONFLICT`; no worker is launched. |
| Worker launch fails after direct admission | Repeating the admission with that ID returns `EXECUTION_ID_CONFLICT`. |
| Invalid start parameters | The client returns `INVALID_START_PARAMETERS`; no execution is admitted and no target is queued. |
| Parameter objects have different key order | `durableValueCodec` returns the same canonical string and the requests match. |
| A repeated request changes the workflow ID or parameters | The client returns `START_REQUEST_MISMATCH`; the original start is unchanged. |
| A matching request repeats after target acknowledgement | It returns the original execution ID without queuing another target. |

Workflow-driver tests will inspect recorded steps and calls to a fake `WorkflowStartClient`:

| Client behavior or interruption | Observable outcome |
| --- | --- |
| Returns `accepted` | The execution ID object is recorded and returned; replay makes no client call. |
| Returns `rejected` | A `WorkflowStartError` and its code are recorded and thrown to workflow code; replay restores the same class and code without a client call. |
| Returns `INVALID_START_PARAMETERS` | The driver records and throws that rejection after one client call. |
| Throws | No step is recorded, workflow code cannot catch the error, and the next execution attempt calls the client again. |
| Caller stops after `accepted` but before recording the step | The next attempt calls the client with the same start-request ID and records its first execution ID. |

Runner tests will cover terminal outcomes:

| Case | Observable outcome |
| --- | --- |
| Workflow returns | Replay returns `completed` with the same result without executing workflow code. |
| Workflow throws outside a step | Replay returns `failed` with the same error without executing workflow code. |
| An infrastructure operation fails during a run | The run rejects, no terminal outcome is recorded, and the worker replies `retry`. |
| A delay suspends the workflow | The unfinished step and scheduler wake are recorded before `suspended` is returned. |

Delivery tests will cover both invokers, the event loop, direct trigger, and completion observers:

| Delivery or launch outcome | Observable outcome |
| --- | --- |
| Runner returns `completed`, `suspended`, or `failed` | `deliver` resolves without a value and the event loop removes the queued target. |
| Runner rejects, the worker replies `retry`, or the child exits before an outcome | `deliver` rejects, the event loop keeps the queued target, continues polling, and delivers the same execution after its visibility timeout. |
| `WorkflowStartClient` throws | The driver records no step, workflow code cannot catch the error, `deliver` rejects, and the same execution is delivered again. |
| Runner returns `completed` or `failed` | `workflowEndEmitter` emits the result or terminal error. |
| Runner returns `suspended` | `workflowEndEmitter` emits nothing. |
| A queued delivery rejects for retry | `workflowEndEmitter` emits nothing. |
| A directly launched invocation has an operational error | `workflowEndEmitter` emits the error to its existing waiter. |
| Direct `trigger` starts a child whose workflow remains running | `launch` resolves after the child starts without waiting for a workflow outcome. |
| Local or HTTP trigger omits an execution ID | The SDK returns the ID accepted by `ExecutionClient`. |
| Worker and test invokers receive the same event and runner behavior | Their `launch`, `deliver`, and completion-observation behavior match. |

## Not Specified

This RFC will not choose:

- how admission, start-request, or queue state is stored, or which records a runtime adapter keeps;
- transaction boundaries inside a runtime adapter, beyond the all-or-nothing guarantee for a new start;
- the driver-internal step responses that carry a start request or a terminal outcome; or
- where the terminal workflow outcome is stored.
