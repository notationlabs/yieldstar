# Resident-process runtime

The resident-process runtime keeps coordination inside the application that owns the workflow service. It is the runtime family available in Yieldstar 0.5.

The long-lived process owns four pieces:

- A `SqliteRuntime` over a `SqliteDriver` connection selected through the Bun or Node connector.
- An `ExecutionDispatcher` that leases due executions, delivers up to 10 at once through the invoker, renews each lease while its delivery runs, and acknowledges the outcome on the execution record.
- A `WorkflowInvoker` that forks a fresh child process for each delivery.
- A local SDK or HTTP routes that admit executions and read their outcomes from the record.

The child process creates its own `SqliteRuntime` over the same SQLite file and a `WorkflowRunner` on top of it. On every delivery it replays cached steps, runs until the next durable boundary, sends the outcome (`completed`, `suspended` or `failed`) to the parent, and exits. Delayed and state-suspended executions become due again on their record, and the dispatcher delivers them to a new child.

## Shared runtime surface

Import `SqliteRuntime` and `createSqliteDb` from a connector entry point. `SqliteRuntime` is also exported from the package root.

```ts
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/bun";

const runtime = new SqliteRuntime(createSqliteDb({ path: "./.db/local.sqlite" }));
```

For Node, change the import to `@yieldstar/sqlite-runtime/node`. No other runtime wiring changes.

## Delivery guarantees

`SqliteRuntime` keeps execution records, step results, stores and waiters in one database, so it keeps every [runtime guarantee](https://github.com/notationlabs/yieldstar/blob/main/docs/store-connector-spec.md#runtime-guarantees) in single transactions:

| Situation                                            | Behavior                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A trigger reuses an execution ID                     | Admission is rejected with `EXECUTION_ID_CONFLICT`; the HTTP route returns `409`             |
| A timer and a store commit wake the same execution   | The wakes merge on the record; the execution is delivered once, at the earlier time          |
| A finished execution is claimed again                | The dispatcher returns the recorded outcome without forking a worker                         |
| A delivery runs for longer than its lease            | The dispatcher renews the 30-second lease every 10 seconds, so a slow delivery keeps it      |
| The worker reports an infrastructure error           | The lease is released unacknowledged, and the execution is delivered again after the redelivery delay (1 second, doubling with each unacknowledged delivery) |
| The worker exits before replying                     | The lease is left to expire, and the execution is delivered again after the redelivery delay |
| The app process dies during a delivery               | The worker exits as soon as its IPC channel closes; the lease expires and another dispatcher can claim the execution |
| A paused worker resumes after another claim          | Its step writes and acknowledgement carry a stale token and are rejected                     |
| The app restarts                                     | `admitted` and `suspended` records and their pending wakes are still in the file, and the next dispatcher delivers them |
| A store commit lands                                 | The wakes for the waiters it satisfies commit in the same transaction                        |

**Leases decide when another dispatcher may take over; tokens decide whose writes count.** Each delivery runs under a lease that the dispatcher renews while the delivery runs. If the dispatcher stops renewing, because its process died or froze, the lease expires and another dispatcher can claim the execution with a higher token. Every step write and acknowledgement checks the token in the same SQLite transaction, so a worker that falls behind can no longer record anything. Several app processes can therefore share one database file, each running a dispatcher. A dispatcher runs up to `concurrency` deliveries at once (10 by default).

Fencing does not make `step.run` exactly-once. A frozen worker may still run a step's side effects before its write is rejected.

## Connector choice

| Host process | Connector | Native database |
| --- | --- | --- |
| Bun | `@yieldstar/sqlite-runtime/bun` | `bun:sqlite` `Database` |
| Node | `@yieldstar/sqlite-runtime/node` | `node:sqlite` `DatabaseSync` |

Both connectors implement the same synchronous `SqliteDriver` contract. Transactions use `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`, and prepared statements expose `get`, `all`, and `run` with named `$parameter` bindings.

## Process requirements

The invoker uses `node:child_process.fork` with advanced IPC serialization so workflow context remains a `Map` across the process boundary. The worker sends a `ready` handshake before the invoker delivers an event; a missing handshake fails after the configured timeout instead of hanging. TypeScript worker paths require Node 22.6 or newer for built-in type stripping. Use compiled JavaScript worker files with older Node releases.

Parent and worker must use the same runtime family. Node must fork Node and Bun must fork Bun because their advanced IPC wire formats are not interoperable. The optional `execPath` can select another executable only within that constraint.

The executable invoker mode and the old `@yieldstar/bun-*` packages were removed in 0.5. Use `@yieldstar/worker-invoker`, `@yieldstar/http-server`, and the appropriate `@yieldstar/sqlite-runtime` connector entry point.
