# Resident process: Node with SQLite

Use the Node connector when the application process and forked workers run under Node. It wraps `node:sqlite` `DatabaseSync` behind the shared synchronous `SqliteDriver` contract.

## Requirements

Node 22.6 or newer can run TypeScript worker entry points through built-in type stripping. Compile the application and point `workerPath` at JavaScript when using an older Node release.

## Install

```sh
pnpm add yieldstar @yieldstar/core @yieldstar/sqlite-runtime @yieldstar/worker-invoker
```

## Runtime

```ts [shared.ts]
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/node";

export const db = createSqliteDb({ path: "./.db/local.sqlite" });
export const runtime = new SqliteRuntime(db);
```

## Worker and application

Use the same `WorkflowRunner`, `createWorkflowWorker`, `ExecutionDispatcher`, and local SDK wiring shown on the [Bun connector page](./resident-process-bun.md). Only the connector import in `shared.ts` changes.

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

Run a TypeScript application with `node app.ts` on a supported Node release. Both the parent and forked worker use Node, and SQLite operations go through the real `node:sqlite` connector.
