# Runtime matrix

Yieldstar separates a runtime family from its connectors. A runtime family defines where coordination, scheduling, and workflow execution live. A connector binds that family to a host runtime and persistence driver.

Yieldstar ships one runtime family: the resident-process runtime. Its `ExecutionDispatcher` and SQLite connection stay inside one long-lived application process, while each delivery of an execution runs in a forked child process.

| Runtime family | Host | Persistence connector | Workflow execution | Ingress |
| --- | --- | --- | --- | --- |
| Resident process | Bun | `@yieldstar/sqlite-runtime/bun` using `bun:sqlite` | `@yieldstar/worker-invoker` child process | Local SDK or HTTP routes |
| Resident process | Node 22.6+ | `@yieldstar/sqlite-runtime/node` using `node:sqlite` | `@yieldstar/worker-invoker` child process | Local SDK or any Request-to-Response HTTP router |

The SQLite runtime implementation is shared across both rows. Only `createSqliteDb` and the native prepared-statement adapter differ, so execution-record, heap, and store semantics remain identical.

Start with [Resident-process runtime](./resident-process.md), then choose [Bun with SQLite](./resident-process-bun.md) or [Node with SQLite](./resident-process-node.md).
