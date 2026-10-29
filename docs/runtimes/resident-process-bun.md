# Resident process: Bun with SQLite

Use the Bun connector when the application process and forked workers run under Bun. It wraps `bun:sqlite` behind the shared synchronous `SqliteDriver` contract.

## Install

```sh
bun add yieldstar @yieldstar/core @yieldstar/sqlite-runtime @yieldstar/worker-invoker
```

## Runtime

```ts [shared.ts]
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/bun";

export const db = createSqliteDb({ path: "./.db/local.sqlite" });
export const runtime = new SqliteRuntime(db);
```

## Worker

```ts [worker.ts]
import pino from "pino";
import { WorkflowRunner } from "@yieldstar/core";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { router, runtime } from "./shared";

const logger = pino();
const runner = new WorkflowRunner(runtime, { router, logger });

createWorkflowWorker(runner, logger).listen();
```

## Application

```ts [app.ts]
import pino from "pino";
import { ExecutionDispatcher } from "@yieldstar/core";
import { createLocalSdk } from "yieldstar";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { runtime } from "./shared";
import type { Router } from "./shared";

const logger = pino();
const workerPath = new URL("./worker.ts", import.meta.url).href;
const invoker = createWorkflowInvoker({ workerPath, logger });

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();

const sdk = createLocalSdk<Router>(runtime, { invoker });
const result = await sdk.triggerAndWait({ workflowId: "my-workflow" });
await dispatcher.stop();
```

Run the application with `bun app.ts`. The child process inherits Bun as `process.execPath`, while the runtime and IPC APIs remain the same as the Node connector path.
