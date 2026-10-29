# Resident-process runtime

The resident-process runtime keeps coordination inside the application that owns the workflow service. It is the runtime family available in Yieldstar 0.5.

The long-lived process owns four pieces:

- A `SqliteRuntime` over a `SqliteDriver` connection selected through the Bun or Node connector.
- An `ExecutionDispatcher` that claims due executions, delivers each through the invoker, and acknowledges the outcome on the execution record.
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
| The worker throws an infrastructure error or exits   | The delivery is not acknowledged, and the execution is delivered again after `redeliveryTimeout` (default five minutes) |
| The app restarts                                     | `admitted` and `suspended` records and their pending wakes are still in the file, and the next dispatcher delivers them |
| A store commit lands                                 | The wakes for the waiters it satisfies commit in the same transaction                        |

**Keep `redeliveryTimeout` (`new SqliteRuntime(db, { redeliveryTimeout })`) longer than your longest delivery.** The runtime cannot tell a slow delivery from a lost one, so a delivery that runs past the timeout is claimed and delivered again while the first is still running. Execution leases (RFC 002) will replace this timeout.

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
