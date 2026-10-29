# HTTP Server

The HTTP server exposes a runtime's execution records through `/trigger` and `/events` endpoints, so clients can admit executions and collect outcomes over the network. Its handlers use standard `Request` and `Response` types. The example uses `Bun.serve`, but the routes object can plug into any Request-to-Response router.

## Server

```ts [server.ts]
import pino from "pino";
import { ExecutionDispatcher } from "@yieldstar/core";
import { createRoutes } from "@yieldstar/http-server";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { runtime } from "./shared";

const logger = pino();
const workerPath = new URL("./worker.ts", import.meta.url).href;
const invoker = createWorkflowInvoker({ workerPath, logger });

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();

Bun.serve({
  port: 8080,
  routes: {
    "/status": new Response("OK"),
    ...createRoutes({ runtime, invoker, logger }),
  },
});
```

`runtime` is the `SqliteRuntime` from the [quick start](./quickstart.md)'s `shared.ts`, and the worker is the same `worker.ts`. The routes only read and write execution records; the dispatcher is what delivers admitted executions to workers. `invoker` is optional and only lets `/events` respond as soon as the dispatcher acknowledges a delivery, instead of on its next read of the record.

## Client

```ts
import { createHttpSdkFactory } from "yieldstar";
import type { Router } from "./shared";

const createSdk = createHttpSdkFactory<Router>();
const sdk = createSdk({ url: "http://localhost:8080" });

const exec = await sdk.trigger({
  workflowId: "my-workflow",
});
await exec.ack();
const result = await exec.waitForResult();
```

## Routes

`createRoutes` registers two POST endpoints:

| Endpoint        | Body                                                 | Responses                                                                                                                         |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /trigger` | `{ workflowId, params?, context?, executionId? }`    | `202 { executionId }` once admission commits; `409 { code: "EXECUTION_ID_CONFLICT" }`; `400 { code: "INVALID_EXECUTION_EVENT" }` |
| `POST /events`  | `{ executionId }`                                    | Blocks until the record is terminal. `200` with the result, `500` with the serialized recorded error, `404` for an unknown ID      |

`/trigger` responds `202` before any workflow code runs. When the body omits `executionId`, the runtime chooses one and the response carries it.

An optional `basePath` prefixes both routes:

```ts
createRoutes({ runtime, logger, basePath: "/api/workflows" });
// → POST /api/workflows/trigger
// → POST /api/workflows/events
```

## Middleware

Middleware functions run before the execution is admitted and can inspect the request, modify the event context, or short-circuit with an early response:

```ts
import { createMiddleware } from "@yieldstar/http-server";

const auth = createMiddleware(async (req, event, next, logger) => {
  const token = req.headers.get("Authorization");
  if (!token) return new Response("Unauthorized", { status: 401 });
  event.context.set("userId", parseToken(token).sub);
  return next();
});

createRoutes({ runtime, logger, middleware: [auth] });
```

Each middleware receives four arguments: `req` (the incoming `Request`), `event` (a `MiddlewareEvent` whose `context` map is mutable at this stage, and whose `executionId` is `undefined` when the client lets the runtime choose one), `next` (a function that forwards to the next middleware or the final handler), and `logger`.

Once every middleware has run, the context map is frozen and admitted with the event. Every delivery reads it back from the execution record as a read-only `Map` available through `event.context`, so context values must be plain JSON data.
