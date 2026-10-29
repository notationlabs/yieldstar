# Changelog

## Unreleased

### Breaking changes

- Executions now have a durable execution record (RFC 001). Removed `SqliteEventLoop`, `SqliteTaskQueue`, `SqliteTaskQueueClient`, `SqliteTimersClient`, `SqliteSchedulerClient`, `MemoryEventLoop`, `MemoryTaskQueue`, `MemoryTimers`, `MemorySchedulerClient`, and the core `SchedulerClient` and `EventProcessor` types. Construct a `SqliteRuntime` or `MemoryRuntime` and run an `ExecutionDispatcher` instead.
- `WorkflowRunner` takes a runtime: `new WorkflowRunner(runtime, { router, logger })`. `run()` resolves with a `WorkflowRunOutcome` (`completed`, `suspended` or `failed`) and rejects only on infrastructure errors. An unregistered `workflowId` resolves as `failed` instead of throwing.
- `WorkflowInvoker.execute(event)` is replaced by `deliver(event)`, which resolves with the delivery's outcome. `workflowEndEmitter` is deprecated. The worker IPC protocol now reports `outcome` and `error` messages.
- `createLocalSdk(invoker)` is now `createLocalSdk(runtime, { invoker?, pollInterval? })`. `trigger` resolves once admission commits and no longer runs anything; a dispatcher must be running. `triggerAndWait` reads the execution record and rejects with the recorded error.
- `createRoutes({ invoker, ... })` is now `createRoutes({ runtime, invoker?, ... })`. `POST /trigger` admits the execution and returns `409` when the execution ID is in use and `400` when the event cannot be stored without loss. `POST /events` returns `404` for an unknown execution.
- Execution IDs are unique and never reused. Triggering with an ID already admitted throws `ExecutionAdmissionError` (`EXECUTION_ID_CONFLICT`). The HTTP SDK no longer generates IDs client-side; it reads the accepted ID from the trigger response.
- Admission rejects `params` and `context` that do not round-trip through JSON exactly, such as `Date`s, class instances, `undefined` properties, `NaN`, and `bigint` (`INVALID_EXECUTION_EVENT`).
- Execution `params`, `context` and outcomes are stored with `durableValueCodec` (RFC 004), and values written in the earlier format are not read. Admission accepts `undefined` and errors anywhere in `params` and `context`, and rejects `context` keys that are not strings (`INVALID_EXECUTION_EVENT`). A failed outcome's error keeps its registered class, `code`, `cause` and durable fields. A completed result the codec rejects is recorded as `failed` with `WorkflowValueError` (`INVALID_STEP_VALUE`).
- Step records are encoded with `durableValueCodec` instead of `serialize-error` (RFC 004), and records written in the earlier format are not read; let in-flight executions finish before upgrading. A `step.run` result, a store step's result, store state or a workflow result that is not a durable value, such as a `Date`, `Map`, `Set`, `bigint` or class instance, now throws `WorkflowValueError` (`INVALID_STEP_VALUE`) on the first run instead of changing on replay. An invalid workflow result fails the execution with the step key `$$workflow-result$$`.
- Workflow code receives the decoded copy of every step result on the first run as well as on replay, so it never sees the object the step function returned. Error-shaped plain objects stay plain objects, `undefined` properties keep their keys, and plain objects with a `$type` key read back unchanged.
- A recorded step error keeps its registered class, `code`, `cause`, `stack` and durable fields; other properties are omitted on the first run too. A thrown value that is not an error is rethrown as thrown, or as `Error(String(value))` when it is not durable.
- `step.run`'s function result is typed with `Durable<T>`, so returning a `Date`, `Map`, `Set`, `bigint` or function is a type error.
- Store state that is not a durable value after schema validation is rejected with `WorkflowValueError` (`INVALID_STEP_VALUE`) and leaves the store unchanged, as does a `take` selection. Store connectors encode state and step receipts with `durableValueCodec` (`encodeStoreValue`, `decodeStoreValue`).
- The worker IPC protocol sends event params and context as `encodeExecutionEvent` encodings, and results and errors as `durableValueCodec` encodings.
- `POST /trigger` reads its body, and `POST /events` writes the result or error, with `durableValueCodec`. Plain JSON remains a valid trigger body. The HTTP SDK's `waitForResult` throws the recorded error as its registered class rather than a plain `Error`, and `trigger` rejects non-durable params or context with `INVALID_EXECUTION_EVENT` before sending a request.
- `yieldstar`, `@yieldstar/worker-invoker` and `@yieldstar/http-server` no longer depend on `serialize-error`.
- `DurableValue` gains `undefined` and `Error`, so `ExecutionClient.start` accepts params with `undefined` properties; `{ a: undefined }` and `{}` do not match.
- Infrastructure errors, such as the SQLite database throwing during a store step, no longer reach workflow `try/catch`. The delivery is not acknowledged and is redelivered after the redelivery delay. Store validation and not-found errors, and errors thrown by updaters, selectors and claims, remain catchable.
- Removed `StoreWaiter.event` and the SQLite `store_wake_outbox` table. `SqliteStoreClient` takes `{ db, executions? }` instead of a scheduler client.
- `registerStoreClientConformance` factories return `{ runtime, createPeer?, restart?, dispose? }` instead of building a store client from a scheduler.
- `MiddlewareEvent.executionId` is optional; it is absent when the runtime will choose the ID.
- Executions are delivered under leases with fencing tokens (RFC 002), replacing the fixed redelivery timeout. `ExecutionDelivery` is replaced by `ExecutionLease` (`{ executionId, token, expiresAt }`). `claimDue` takes `{ limit, duration }` and returns leases earliest due first; `acknowledge` takes `{ lease, outcome }` and returns `{ status: "lost" }` for a stale lease. `ExecutionStatus` gains `running`, and `ExecutionRecord` gains `unacknowledgedDeliveryCount`.
- `HeapClient.writeStep` takes `{ lease, stepKey, stepAttempt, done, stepResponseJson }` instead of an `executionId` and `stepDone`, and resolves with the record as stored or `{ status: "lost" }`. Rewriting an existing record no longer throws; it returns the existing record unchanged.
- `WorkflowInvoker.deliver(event, { lease, signal })` and `WorkflowRunner.run(event, { lease, signal, logger? })` take a `DeliveryOptions` object with the delivery's lease and an `AbortSignal`. `WorkflowGeneratorParams` carries the `lease` and `signal`. The worker IPC protocol sends `{ type: "deliver", event, lease }` to start a delivery; there is no abort message, because the worker invoker kills a worker whose lease is lost.
- A delivery that ends without an outcome is redelivered after a redelivery delay that starts at 1 second and doubles with each consecutive unacknowledged delivery, up to 5 minutes, instead of after five minutes.
- `StepDelay.resumeIn` and `WorkflowDelay.resumeIn` are renamed `wakeAt`. Delay and retry steps read their wake time from the runtime clock instead of `Date.now()`, and `WorkflowGeneratorParams` carries that `clock`.
- `WorkflowGeneratorParams` carries an `executionClient`, which `WorkflowRunner` sets from its runtime's `executions`.
- `WorkflowGeneratorParams` carries an `effectClient`, which `WorkflowRunner` sets from its runtime's `effects` (RFC 005). Code that builds `WorkflowGeneratorParams` by hand must pass one.
- `@yieldstar/store-conformance` is renamed to `@yieldstar/runtime-conformance`, since its suites qualify a whole runtime. The exports are unchanged.

### Added

- Added `Runtime`, `ExecutionClient` (`admit`, `get`, `requestWake`, `claimDue`, `acknowledge`), `ExecutionRecord`, `ExecutionStatus`, `ExecutionOutcome`, `WorkflowRunOutcome`, `ExecutionAdmissionError`, and `InfrastructureError` to `@yieldstar/core`.
- Added `SqliteRuntime(db, { clock? })` and `MemoryRuntime({ clock? })`, each exposing `clock`, `executions`, `heap`, and `stores`.
- Added `ExecutionDispatcher(runtime, { invoker, logger, pollInterval?, keepAlive? })` with `start`, `stop`, `tick`, and `drain`. It is the only component that delivers executions, and it returns a finished execution's recorded outcome without running workflow code.
- Added `registerExecutionClientConformance` to `@yieldstar/runtime-conformance`, covering RFC 001's `ExecutionClient` tables for any runtime.
- Added `waitForExecutionOutcome` and the storage-neutral execution state machine (`prepareExecutionAdmission`, `claimExecution`, `acknowledgeExecution`, and related helpers) for runtime adapter authors.
- Added `StoreValidationError` and `StoreNotFoundError`.
- Re-exported `ExecutionAdmissionError` and the execution record types from `yieldstar`.
- Added `ExecutionClient.renew` and `ExecutionClient.release`, `DeliveryOptions`, `LeaseLost`, `isLeaseLost`, `LeaseLostError`, `StepConflictError`, `WorkerExitedError`, `DEFAULT_LEASE_DURATION`, `redeliveryDelay`, and the lease transitions (`renewExecutionLease`, `releaseExecutionLease`, `isLeaseCurrent`) to `@yieldstar/core`.
- Added `concurrency` (default `10`), `leaseDuration` (default 30 seconds), `renewInterval` (default a third of `leaseDuration`) and `abortGracePeriod` (default 1 second, `DEFAULT_ABORT_GRACE_PERIOD`) options to `ExecutionDispatcher`, and its `activeDeliveries` count. The dispatcher claims new executions as slots free up, without waiting for earlier deliveries.
- Added RFC 002's lease, redelivery-delay and fencing cases to `registerExecutionClientConformance`. Harnesses may return `createPeer` to run the lease races across two runtimes on one backend.
- Added `WORKER_ORPHANED_EXIT_CODE` to `@yieldstar/worker-invoker`.
- Added `step.start(stepKey, { workflowId, params? })` (RFC 003), which starts another workflow as a durable step and returns `{ executionId }`. Replays and repeated attempts return the first target instead of starting another. A rejected start throws `WorkflowStartError` (`INVALID_START_PARAMETERS` or `START_REQUEST_MISMATCH`), and replay restores its class and code.
- Re-exported `WorkflowStartError` and the `DurableObject`, `DurableValue`, `ExecutionParent` and `WorkflowStartErrorCode` types from `yieldstar`.
- Added `ExecutionClient.start` (RFC 003), which admits a target execution idempotently by its request ID (`{ executionId, stepKey }`), together with its start-request record. A repeat with a different `workflowId` or `params` returns `START_REQUEST_MISMATCH`, also after the target has finished. `start` is not fenced. Custom runtime adapters must implement it.
- Added `parent` (`ExecutionParent`) to `ExecutionRecord`: the execution and step that started it with `step.start`. It never changes, and executions admitted through `admit` have none.
- Added `durableValueCodec` and the `DurableValue`, `DurableObject` and `DurableValueEncoding` types to `@yieldstar/core`. `encode` validates plain data and returns canonical JSON with sorted keys.
- Added `durableValueCodec.decode`, `encodeThrownValue`, `registerErrorClass`, `WorkflowValueError`, `WorkflowValueErrorCode`, `WORKFLOW_RESULT_STEP_KEY` and the `Durable<T>`, `DurableDecoding` and `ErrorClass` types to `@yieldstar/core` (RFC 004). The codec tags `undefined`, errors and plain objects with a `$type` key, and revives errors as their registered class without calling its constructor.
- Added a `schema` option to `step.run` (RFC 004): `step.run(key, fn, { schema })` validates the decoded value with a Standard Schema on the first run and on replay, and returns the schema's output. The step record notes whether the schema accepted the value on the first run; a rejection throws `WorkflowValueError` (`STEP_SCHEMA_INVALID`) on both runs.
- Re-exported `WorkflowValueError`, `registerErrorClass`, `WORKFLOW_RESULT_STEP_KEY` and the `Durable`, `ErrorClass` and `WorkflowValueErrorCode` types from `yieldstar`, and added the `DurableStepFn` and `StepRunOptions` types. `RetryableError`, `StoreValidationError` and `StoreNotFoundError` are registered error classes by default.
- Added `decodeParsedValue`, `DurableValueError`, `encodeStoreValue`, `decodeStoreValue` and the `StepSchemaVerdict` type to `@yieldstar/core`, and an optional `stepKey` argument to `validateStoreState`.
- Added `WorkflowStartError` and `WorkflowStartErrorCode` to `@yieldstar/core`, and the start transitions `prepareExecutionStart`, `matchStartRequest` and `createStartedExecution` (with `StartRequestState`) for runtime adapter authors.
- `SqliteRuntime` stores start requests in a `start_requests` table and the parent link in `parent_execution_id` and `parent_step_key` columns on `executions`. A new start inserts the target and the request in one transaction.
- Added RFC 003's `start` cases to `registerExecutionClientConformance`. Harnesses may return `failStartCommits` to run the case that a start which fails before it commits leaves no trace.
- Added `EffectClient` (`begin`, `settle`, `watch`, `getEffect`), `EffectRecord`, `EffectClientInvariantError` (`EFFECT_RUNTIME_INVARIANT`), `WorkflowEffectError` (`INVALID_EFFECT_REQUEST`, `EFFECT_REQUEST_MISMATCH`), the `EffectDeliveryErrorCode` type and the effect transitions (`validateEffectRequest`, `prepareEffectBegin`, `prepareEffectSettle`, `prepareEffectWatch`, `createEffectState`, `matchEffectBegin`, `settleEffect`, `toEffectRecord`) to `@yieldstar/core` (RFC 005). `Runtime` gains `effects`; custom runtime adapters must implement it.
- `MemoryRuntime` and `SqliteRuntime` expose `effects` (`MemoryEffectClient`, `SqliteEffectClient`). A settlement wakes every waiting execution in the same write, and the heap write that records a step's result deletes its effect waiters. `SqliteRuntime` stores effects in `effects`, `effect_conflicts` and `effect_waiters` tables.
- Added `registerEffectClientConformance` to `@yieldstar/runtime-conformance` (RFC 005). Harnesses may return `failEffectWatches` to run the case that a watch which fails before it commits registers nothing.

### Changed

- A store commit makes each waiting execution due in the same transaction, so a durable commit always has durable wakes.
- Store waiters persist until the step that registered them records its result, instead of being consumed by a wake.
- Any number of wakes for one execution, from delays, retries and store commits, collapse into one delivery at the earliest due time.
- `triggerAndWait` and `POST /events` settle from the execution record, so they settle even if the process that ran the execution restarted.
- Several dispatchers, in one process or in several processes sharing one SQLite file, can deliver executions at once. An execution has at most one live lease, and every heap step write, renewal, release and acknowledgement checks the lease's token atomically, so a stale holder's writes return `lost` and change nothing.
- The dispatcher renews each lease while its delivery runs, so a slow delivery is no longer delivered a second time. A delivery that rejects releases its lease, except when the worker exits before replying, which leaves the lease to expire.
- The driver ends a delivery as a retry when a step is already recorded with a different value; the next delivery replays the recorded value.
- When a renewal returns `lost`, the dispatcher aborts the delivery's signal. The driver checks the signal before each step function and each fenced write, and ends an aborted delivery with an `InfrastructureError` caused by `LeaseLostError`, without running more workflow code. The delivery is neither acknowledged nor released.
- The worker invoker kills the worker (`SIGKILL`) when a delivery's signal aborts, so a step function that hangs stops at once, and `deliver` rejects with the lease-lost `InfrastructureError` rather than `WorkerExitedError`.
- The dispatcher abandons an aborted delivery that has not settled within `abortGracePeriod` (default 1 second) and frees its slot, so an in-process step function that hangs no longer holds a slot forever. The abandoned delivery's late outcome or rejection is ignored.
- When reading the record, acknowledging or releasing throws, the dispatcher leaves the lease to expire rather than releasing it.
- A forked worker exits as soon as its IPC channel to the runtime process closes, so it makes no further writes after that process dies.

## 0.5.0 - 2026-07-21

### Breaking changes

- Renamed `@yieldstar/bun-sqlite-runtime` to `@yieldstar/sqlite-runtime`, `@yieldstar/bun-worker-invoker` to `@yieldstar/worker-invoker`, and `@yieldstar/bun-http-server` to `@yieldstar/http-server`. The old package names are not shipped as compatibility packages; follow the [migration guide](docs/migrations/0.4-to-0.5.md) before upgrading.
- Removed the worker invoker's `executable` option. Parent and worker processes must use the same runtime family because Bun and Node cannot communicate through Node's V8 advanced IPC serialization.
- Store updater callbacks must be synchronous, deterministic, and side-effect-free. `update`, `updateFrom`, and take claims reject promise-returning callbacks because compare-and-swap retries may execute a callback more than once.

### Added

- Added durable workflow stores through `defineStore` and `step.store()`, with `get`, `select`, `update`, `updateFrom`, `deleteFrom`, `when`, and `take` operations.
- Added Standard Schema validation for store state, versioned snapshots and receipts carrying `instanceId` and `version`, and discriminated update and delete results.
- Added compare-and-swap store mutations and an applied-steps ledger so retried workflow store operations have exactly-once semantics, including explicit `already-applied` and `conflict` outcomes.
- Added a minimal synchronous `SqliteDriver` contract and connector entry points at `@yieldstar/sqlite-runtime/bun` and `@yieldstar/sqlite-runtime/node` for real `bun:sqlite` and `node:sqlite` databases.
- Added Node.js support for the resident-process runtime. TypeScript worker entry points require Node 22.6 or newer for built-in type stripping; older Node versions can use compiled JavaScript workers.
- Added one Vitest suite that runs the complete conformance and fork-integration coverage under both Bun and Node.
- Added two-leg GitHub Actions CI pinned to Bun 1.3.14, Node 22.18.0, and pnpm 11.6.0.
- Added a worker `ready` handshake and configurable timeout so missing listeners and unsupported cross-runtime forks fail explicitly instead of hanging.

### Changed

- Made the SQLite heap, scheduler, timers, task queue, event loop, stores, and DAOs independent of a concrete SQLite implementation.
- Replaced `Bun.spawn` worker IPC with `node:child_process.fork`, including propagation of spawn errors and premature child exits. The optional `execPath` can select another binary from the same runtime family.
- Retyped HTTP route handlers with standard `Request` and `Response` APIs while keeping the routes object compatible with `Bun.serve` and other Request-to-Response routers.
- Replaced Bun-specific runtime utilities and targeted all package bundles at Node.
- Replaced `Bun.randomUUIDv7()` with UUID v7 from the `uuid` package.
- Added `step.effect(stepKey, { effectId, operation, input, lookup, perform, retryIn })` (RFC 005), which calls an external system under a stable effect ID. A new effect calls `perform`; a pending one calls `lookup` first and calls `perform` only on `not-found`. The result settles the effect before the step is recorded, so a replay after a crash reads it without an external call. An `unknown` lookup or a rejected callback watches the effect and suspends with `wakeAt = now + retryIn`, and a settlement elsewhere wakes the execution. `lookup` and `perform` are not called once the delivery's signal has aborted.
- `step.effect` throws `WorkflowEffectError` (`INVALID_EFFECT_REQUEST` or `EFFECT_REQUEST_MISMATCH`) to workflow code, recorded so replay throws the same class and code. Client failures, malformed callback responses and client invariants record no step and reject the delivery with an `InfrastructureError` caused by `EffectDeliveryError` (`EFFECT_CLIENT_UNAVAILABLE`, `EFFECT_HANDLER_INVALID` or `EFFECT_RUNTIME_INVARIANT`). A conflicting settlement logs a warning and records the first result.
- Added `EffectDeliveryError` and the `StepEffectWait` step response, recorded as an unfinished step, to `@yieldstar/core`. `WorkflowEffectError`, `EffectDeliveryError` and `EffectClientInvariantError` are registered error classes by default.
- Re-exported `WorkflowEffectError`, `EffectDeliveryError`, `EffectClientInvariantError` and the `EffectRecord`, `WorkflowEffectErrorCode` and `EffectDeliveryErrorCode` types from `yieldstar`, and added the `EffectDescriptor` and `EffectLookup` types.
