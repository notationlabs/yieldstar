# HTTP SDK

`createHttpSdkFactory` produces a factory function that creates typed SDK clients bound to a remote server's base URL. Like the local SDK, it takes your `Router` type as a generic parameter so TypeScript validates every `workflowId` and its corresponding `params` at compile time.

## Setup

```ts
import { createHttpSdkFactory } from "yieldstar";
import type { Router } from "./shared";

const createSdk = createHttpSdkFactory<Router>();
const sdk = createSdk({ url: "http://localhost:8080" });
```

Pass `fetchOptions` to attach custom headers or other `RequestInit` properties to every outgoing request:

```ts
const sdk = createSdk({
  url: "http://localhost:8080",
  fetchOptions: {
    headers: { Authorization: "Bearer token" },
  },
});
```

## `sdk.trigger`

Posts to `/trigger` and returns a handle containing `executionId`, `ack()`, and `waitForResult()`. The server admits the execution and responds with the execution ID it accepted; the SDK reads `executionId` from that response rather than generating one itself.

```ts
const exec = await sdk.trigger({
  workflowId: "process-order",
  params: { orderId: "abc123" },
});
```

When the server rejects the admission, `trigger` throws an `ExecutionAdmissionError` with the server's `code`: `EXECUTION_ID_CONFLICT` for a `409` (the supplied `executionId` is already in use) or `INVALID_EXECUTION_EVENT` for a `400` (the event cannot round-trip through JSON; see [Local SDK](./sdk-local.md#trigger-event-shape)). Any other non-2xx response throws the response's `statusText`.

## `exec.ack()`

Returns the parsed trigger response, `{ executionId }`.

```ts
const { executionId } = await exec.ack();
```

## `exec.waitForResult()`

Posts to `/events` with the `executionId` and blocks until the execution record reaches a terminal status, then returns the result.

```ts
const result = await exec.waitForResult();
```

If the record is `failed`, `waitForResult` deserializes the recorded error and re-throws it with the original stack trace preserved.

## Trigger event shape

| Field         | Type                  | Required                 | Description                                                  |
| ------------- | --------------------- | ------------------------ | ------------------------------------------------------------ |
| `workflowId`  | `string`              | Yes                      | ID matching a key in the router                              |
| `params`      | `Record<string, any>` | Depends on workflow type | Input data accessible via `event.params` inside the workflow |
| `executionId` | `string`              | No                       | Custom execution ID. The runtime chooses one if omitted      |
| `context`     | `Record<string, any>` | No                       | Additional context passed through middleware                 |
