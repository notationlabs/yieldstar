# @yieldstar/sqlite-runtime

`SqliteRuntime`: a driver-agnostic SQLite implementation of the `Runtime` contract, with execution records, the heap, and durable stores in one database. Bun and Node connector entry points provide the native database driver.

See [Bun with SQLite](../runtimes/resident-process-bun.md) and [Node with SQLite](../runtimes/resident-process-node.md) for complete resident-process wiring.

## Install

```sh
bun add @yieldstar/sqlite-runtime
```

## `createSqliteDb({ path })`

Creates and returns a `SqliteDriver` at the given file path. Tables are created automatically on first use. Use the `/bun` connector with Bun or the `/node` connector with Node.

```ts
import { createSqliteDb } from "@yieldstar/sqlite-runtime/bun";

const db = createSqliteDb({ path: "./.db/local.sqlite" });
```

The Node connector has the same API:

```ts
import { createSqliteDb } from "@yieldstar/sqlite-runtime/node";

const db = createSqliteDb({ path: "./.db/local.sqlite" });
```

## `SqliteRuntime`

```ts
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/bun";

const runtime = new SqliteRuntime(createSqliteDb({ path: "./.db/local.sqlite" }));
```

| Option              | Type           | Default      | Description                                                              |
| ------------------- | -------------- | ------------ | ------------------------------------------------------------------------ |
| `clock`             | `() => number` | `Date.now`   | Time source for every client operation and for delay and retry wake times |

The runtime exposes four clients that share the database:

| Client               | Class                   | Tables                                   |
| -------------------- | ----------------------- | ---------------------------------------- |
| `runtime.executions` | `SqliteExecutionClient` | `executions`, `start_requests`           |
| `runtime.effects`    | `SqliteEffectClient`    | `effects`, `effect_conflicts`, `effect_waiters` |
| `runtime.heap`       | `SqliteHeapClient`      | `step_responses`                         |
| `runtime.stores`     | `SqliteStoreClient`     | `stores`, `store_waiters`, `store_applied_steps` |

Keeping them in one database lets every guarantee that spans clients hold in a single SQLite transaction:

- A store commit and the wakes for the waiters it satisfies commit together.
- An effect settlement and the wakes for its waiters commit together.
- The heap write that records a step's result deletes that step's store and effect waiters.
- Admission inserts the record already due, so the record and its first wake commit together.
- A new `start` inserts the target, already due and with its parent link, and the start request in one transaction. The request is looked up in the same transaction, so concurrent starts with one request ID admit one target.

Every write runs as one synchronous `IMMEDIATE` transaction. Separate processes that open the same file, such as the app and its worker subprocesses, therefore serialize on SQLite's lock and see the same execution records.

Updaters must be synchronous, deterministic, and side-effect-free. They run
against a snapshot outside the SQLite transaction; if the conditional commit
loses a version race, the base store client runs the updater again against the
latest snapshot.

`SqliteExecutionClient`, `SqliteEffectClient`, `SqliteHeapClient`, and `SqliteStoreClient` remain exported for adapter tests. Construct them through `SqliteRuntime` in applications, so the store client requests wakes from the same execution client and clock.
