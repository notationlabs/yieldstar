# Quick Start

A Yieldstar application has three parts: **workflows** that define the work, a **worker** that executes it, and an **app** that triggers it and runs the dispatcher that hands due executions to workers. This guide sets up all three with SQLite persistence.

## Install

```sh
bun add yieldstar @yieldstar/core @yieldstar/worker-invoker @yieldstar/sqlite-runtime pino
```

This quick start uses Bun. For Node, use the [`node:sqlite` connector guide](../runtimes/resident-process-node.md); the shared runtime APIs are identical.

## 1. Define a workflow

A workflow is a generator function that yields steps. Each step is a checkpoint, the result of which is persisted by the runtime and can be retrieved if the workflow is paused or needs to be re-run.

```ts [shared.ts]
import { workflow, createWorkflowRouter } from "yieldstar";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/bun";

export const greet = workflow<{ name: string }, string>(async function* (step, event) {
  const greeting = yield* step.run(() => `Hello, ${event.params.name}`);
  yield* step.delay(1000);
  return yield* step.run(() => `${greeting}!`);
});

export const router = createWorkflowRouter({ greet });
export type Router = typeof router;

export const db = createSqliteDb({ path: "./.db/local.sqlite" });
export const runtime = new SqliteRuntime(db);
```

`createWorkflowRouter` registers workflows by ID. Those IDs become the typed keys the SDK uses to trigger them.

`SqliteRuntime` keeps execution records, step results and stores in one SQLite file. The app and the worker each construct one over the same file.

## 2. Create the worker

The worker is a subprocess that runs workflow deliveries in isolation. It connects the `WorkflowRunner` to the SQLite runtime, then listens for execution events over IPC.

```ts [worker.ts]
import pino from "pino";
import { WorkflowRunner } from "@yieldstar/core";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { router, runtime } from "./shared";

const logger = pino();

const runner = new WorkflowRunner(runtime, { router, logger });

createWorkflowWorker(runner, logger).listen();
```

## 3. Trigger and await the result

The app entry point creates an invoker that spawns worker subprocesses on demand, starts an `ExecutionDispatcher` that delivers due executions through that invoker, and uses the typed SDK to trigger workflows.

```ts [app.ts]
import pino from "pino";
import { ExecutionDispatcher } from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { createLocalSdk } from "yieldstar";
import { runtime } from "./shared";
import type { Router } from "./shared";

const logger = pino();
const workerPath = new URL("./worker.ts", import.meta.url).href;
const invoker = createWorkflowInvoker({ workerPath, logger });

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();

const sdk = createLocalSdk<Router>(runtime, { invoker });
const result = await sdk.triggerAndWait({
  workflowId: "greet",
  params: { name: "World" },
});

console.log(result); // "Hello, World!"
await dispatcher.stop();
```

The SDK only admits the execution: it writes an execution record and makes it due. The dispatcher claims it, forks a worker, and records the outcome. `triggerAndWait` resolves once that record reaches `completed`.

## 4. Run it

```sh
bun app.ts
```

The workflow executes two steps with a 1-second delay between them. 

The first step computes a greeting. The delay suspends the execution, and its record becomes due again one second later. The dispatcher then delivers it to a new worker, and the second step appends punctuation.

The state lives in `.db/local.sqlite`.

On resume, completed steps replay from the heap without re-executing.
