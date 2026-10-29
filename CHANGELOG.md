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
- Infrastructure errors, such as the SQLite database throwing during a store step, no longer reach workflow `try/catch`. The delivery is not acknowledged and is redelivered after the redelivery timeout. Store validation and not-found errors, and errors thrown by updaters, selectors and claims, remain catchable.
- Removed `StoreWaiter.event` and the SQLite `store_wake_outbox` table. `SqliteStoreClient` takes `{ db, executions? }` instead of a scheduler client.
- `registerStoreClientConformance` factories return `{ runtime, createPeer?, restart?, dispose? }` instead of building a store client from a scheduler.
- `MiddlewareEvent.executionId` is optional; it is absent when the runtime will choose the ID.
- `StepDelay.resumeIn` and `WorkflowDelay.resumeIn` are renamed `wakeAt`. Delay and retry steps read their wake time from the runtime clock instead of `Date.now()`, and `WorkflowGeneratorParams` carries that `clock`.

### Added

- Added `Runtime`, `ExecutionClient` (`admit`, `get`, `requestWake`, `claimDue`, `acknowledge`), `ExecutionRecord`, `ExecutionStatus`, `ExecutionOutcome`, `WorkflowRunOutcome`, `ExecutionAdmissionError`, and `InfrastructureError` to `@yieldstar/core`.
- Added `SqliteRuntime(db, { clock?, redeliveryTimeout? })` and `MemoryRuntime({ clock?, redeliveryTimeout? })`, each exposing `clock`, `executions`, `heap`, and `stores`.
- Added `ExecutionDispatcher(runtime, { invoker, logger, pollInterval?, keepAlive? })` with `start`, `stop`, `tick`, and `drain`. It is the only component that delivers executions, and it returns a finished execution's recorded outcome without running workflow code.
- Added `waitForExecutionOutcome` and the storage-neutral execution state machine (`prepareExecutionAdmission`, `claimExecution`, `acknowledgeExecution`, and related helpers) for runtime adapter authors.
- Added `StoreValidationError` and `StoreNotFoundError`.
- Re-exported `ExecutionAdmissionError` and the execution record types from `yieldstar`.

### Changed

- A store commit makes each waiting execution due in the same transaction, so a durable commit always has durable wakes.
- Store waiters persist until the step that registered them records its result, instead of being consumed by a wake.
- Any number of wakes for one execution, from delays, retries and store commits, collapse into one delivery at the earliest due time.
- `triggerAndWait` and `POST /events` settle from the execution record, so they settle even if the process that ran the execution restarted.

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
