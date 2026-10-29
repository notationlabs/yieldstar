# @yieldstar/worker-invoker

Subprocess-based workflow invoker. Forks a new child process for each delivery of an execution and communicates via IPC.

## Install

```sh
bun add @yieldstar/worker-invoker
```

## `createWorkflowInvoker({ workerPath, execPath?, logger })`

Creates a `WorkflowInvoker` that forks a subprocess with `node:child_process`. Each call to `deliver` runs the worker with `process.execPath` (or `execPath` when given), sends the execution event and its lease via IPC as `{ event, lease }`, and resolves with the worker's `WorkflowRunOutcome`. An `ExecutionDispatcher` makes these calls; application code does not.

```ts
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";

const invoker = createWorkflowInvoker({
  workerPath: new URL("./worker.ts", import.meta.url).href,
  logger,
});
```

TypeScript worker paths require Node 22.6 or newer for built-in type stripping. Use compiled JavaScript workers on older Node versions.

| Param        | Type     | Description                                              |
| ------------ | -------- | -------------------------------------------------------- |
| `workerPath` | `string` | Path or `file://` URL to the worker script               |
| `execPath`   | `string` | Runtime binary used to fork the worker (defaults to `process.execPath`) |
| `handshakeTimeout` | `number` | Milliseconds to wait for the worker's `ready` handshake (defaults to `5000`) |
| `logger`     | `Logger` | Pino logger                                              |

The worker sends a `ready` handshake when `listen()` starts, and the invoker holds the event back until it arrives. A worker that never handshakes — most commonly an `execPath` from a different runtime family than the parent, since Node's advanced IPC serialization is not interoperable with Bun's — is killed after `handshakeTimeout` and `deliver` rejects. Node must fork Node, and Bun must fork Bun.

The worker replies with one of two messages, and the child process is killed after it:

| Message                         | `deliver`                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `{ status: "outcome", outcome }` | Resolves with the outcome. A `failed` outcome's error is deserialized with `serialize-error`  |
| `{ status: "error", error }`     | Rejects: the worker hit an infrastructure error, which is not an outcome                      |

`deliver` also rejects on a spawn error, a missing handshake, or an exit before replying. The dispatcher never acknowledges a rejected delivery, and the runtime delivers it again after the redelivery delay:

| Rejection                                                        | Lease                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The worker exits before replying (`WorkerExitedError`)            | Left to expire, because the worker's last writes may still be landing      |
| An `error` reply, a spawn error, or a missing handshake (a retry) | Released at once                                                          |

The dispatcher renews the lease in the parent process for as long as the delivery runs. `@yieldstar/test-invoker` implements the same `deliver` contract in-process.

The invoker still exposes a deprecated `workflowEndEmitter` (`EventEmitter`). The dispatcher emits terminal outcomes on it so the local SDK and `/events` route can re-read the execution record early; the record remains the source of truth.

## `createWorkflowWorker(runner, logger)`

Creates a worker that listens for IPC messages in the subprocess. Call `.listen()` to start processing.

```ts
import { WorkflowRunner } from "@yieldstar/core";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";

const runner = new WorkflowRunner(runtime, { router, logger });
createWorkflowWorker(runner, logger).listen();
```

The worker listens on `process.on("message")`, converts the incoming event's context into a `ReadOnlyMap`, and passes the event to `workflowRunner.run`. The outcome, or the infrastructure error that `run` rejected with, is sent back to the parent via `process.send`. On `listen()` the worker also sends the `ready` handshake that the invoker waits for before delivering the event.

The runner makes every step write under the lease the parent sent, so a write returns `lost` once another claim has taken over. The worker also exits, with `WORKER_ORPHANED_EXIT_CODE` (75), as soon as its IPC channel closes. If the runtime process that holds the lease dies, nothing renews the lease and another runtime may claim the execution, so the worker stops at once and makes no further fenced writes.
