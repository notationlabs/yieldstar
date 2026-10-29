# @yieldstar/store-conformance

Vitest qualification suites for Yieldstar runtimes. `registerStoreClientConformance` verifies a `StoreClient`'s store lifecycle, concurrency, replay idempotency, waiter wake-up, wake collapsing, and crash-recovery behavior. `registerExecutionClientConformance` verifies a runtime's `ExecutionClient` and fenced heap writes against RFC 001 and RFC 002.

## Install

```sh
pnpm add -D @yieldstar/core @yieldstar/store-conformance vitest
```

## Register the suite

Create a Vitest test file and provide a factory that creates a clean backend and returns a `Runtime` built on it. The suite observes store wakes through the runtime's `ExecutionClient`: it admits the executions that wait on stores, and a commit that satisfies a waiter must make that execution due, so `runtime.executions.claimDue()` returns it.

```ts
import { registerStoreClientConformance } from "@yieldstar/store-conformance";
import { MyRuntime } from "./my-runtime";

registerStoreClientConformance({
  name: "my-store",
  create() {
    const backend = createCleanBackend();
    return {
      runtime: new MyRuntime(backend),
      dispose: () => backend.close(),
    };
  },
});
```

Run it with either supported test host:

```sh
vitest run store-conformance.test.ts
```

## Optional capabilities

Return `createPeer` when the backend supports multiple runtimes sharing the same data. This enables the cross-client race suites. The execution client suite uses the same capability for its lease races (see below).

Return `restart` when the backend is durable. This enables the suites that check commits, wakes and waiters survive a restart.

```ts
create() {
  const backend = createCleanBackend();
  const runtime = new MyRuntime(backend);

  return {
    runtime,
    createPeer: () => new MyRuntime(backend),
    restart: async () => {
      await runtime.close();
      return new MyRuntime(backend.reopen());
    },
    dispose: () => backend.close(),
  };
}
```

## Execution client suite

`registerExecutionClientConformance` checks a runtime's `ExecutionClient` and fenced heap writes against RFC 001 and RFC 002: admission, wake merging, claims, acknowledgement and terminal outcomes; leases, renewal, release and the `running` status; the redelivery delay and `unacknowledgedDeliveryCount`; and fencing of heap writes, renewals, releases and acknowledgements against a stale holder. The suite passes a `clock` to `create`; build every runtime on it so the suite controls time, including lease expiry.

The harness has two optional capabilities:

- `createPeer` returns another runtime over the same backend, as a second runtime process would. The suite uses it to race two clients for one execution and to reclaim an expired lease from a different client than the one that holds it. Return it whenever several processes can share the backend; without it those cases run both sides on `runtime`, which proves less.
- `restart` reopens the same durable backend in a new runtime. It enables the restart cases; without it they are skipped.

```ts
import { registerExecutionClientConformance } from "@yieldstar/store-conformance";
import { MyRuntime } from "./my-runtime";

registerExecutionClientConformance({
  name: "my-runtime",
  create({ clock }) {
    const backend = createCleanBackend();
    return {
      runtime: new MyRuntime(backend, { clock }),
      // A separate connection, as another process would open.
      createPeer: () => new MyRuntime(backend.connect(), { clock }),
      restart: () => new MyRuntime(backend.reopen(), { clock }),
      dispose: () => backend.close(),
    };
  },
});
```

The suite covers the runtime adapter. RFC 002's dispatcher and worker cases, such as concurrency, releasing on a retry reply, a worker that exits without replying, and a worker whose runtime process dies, are properties of `ExecutionDispatcher` and the invoker rather than of an adapter; the repository tests them in `test/dispatcher.test.ts` and `test/worker-invoker.test.ts`.

The normative contract is in the repository's [store connector conformance specification](https://github.com/notationlabs/yieldstar/blob/main/docs/store-connector-spec.md).
