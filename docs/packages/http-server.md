# @yieldstar/http-server

HTTP routes and middleware for triggering workflows over the network. Handlers use the standard `Request` and `Response` APIs.

## Install

```sh
bun add @yieldstar/http-server
```

## `createRoutes({ runtime, invoker?, logger, middleware?, basePath? })`

Returns route handlers for `POST /trigger` and `POST /events`. The routes object plugs directly into `Bun.serve({ routes })` or any router that accepts `Request` to `Response` handlers.

```ts
import { createRoutes } from "@yieldstar/http-server";

Bun.serve({
  port: 8080,
  routes: {
    ...createRoutes({ runtime, invoker, logger }),
  },
});
```

| Param        | Type                   | Description                      |
| ------------ | ---------------------- | -------------------------------- |
| `runtime`    | `{ executions: ExecutionClient }` | The runtime whose execution records the routes admit and read |
| `invoker`    | `WorkflowInvoker`      | Optional. Lets `/events` respond as soon as a delivery is acknowledged |
| `logger`     | `Logger`               | Pino logger                      |
| `middleware` | `MiddlewareFunction[]` | Optional middleware chain        |
| `basePath`   | `` `/${string}` ``     | Optional prefix for routes       |

### `POST /trigger`

Accepts a `{ workflowId, params?, context?, executionId? }` body encoded with the durable value codec, of which plain JSON is a subset. Runs the middleware chain, then calls `runtime.executions.admit`. The routes never run workflow code; an `ExecutionDispatcher` must be running against the same runtime.

| Status | Body                                            | Cause                                                          |
| ------ | ----------------------------------------------- | -------------------------------------------------------------- |
| `202`  | `{ executionId }`                               | Admission committed. The ID is the caller's or the runtime's   |
| `409`  | `{ code: "EXECUTION_ID_CONFLICT", message }`    | The supplied `executionId` is already in use                   |
| `400`  | `{ code: "INVALID_EXECUTION_EVENT", message }`  | the body is not a valid encoding, or `params` or `context` are not durable values |
| `500`  | Error message                                   | Admission threw, for example because the database failed       |

### `POST /events`

Accepts `{ executionId }` JSON body. Blocks until the execution record is terminal, polling the record and re-reading early when `invoker.workflowEndEmitter` fires. Returns the result encoded with the durable value codec, the recorded error encoded the same way with status 500, or 404 when no record exists. The request's abort signal ends the wait.

## `createMiddleware(fn)`

Wraps a middleware function for use with `createRoutes`. Middleware receives `(req, event, next, logger)`.

```ts
import { createMiddleware } from "@yieldstar/http-server";

const auth = createMiddleware(async (req, event, next, logger) => {
  const token = req.headers.get("Authorization");
  if (!token) return new Response("Unauthorized", { status: 401 });
  event.context.set("userId", parseToken(token).sub);
  return next();
});
```

The `event.context` is a `FreezableMap`. Middleware can call `.set()` to add entries. After middleware runs, the context is frozen and admitted with the event; it becomes a read-only `Map` inside the workflow. `event.executionId` is optional: it is `undefined` when the client lets the runtime choose an ID.

Middleware executes in order. Each function must either return a `Response` (to short-circuit) or call `next()` to continue the chain.
