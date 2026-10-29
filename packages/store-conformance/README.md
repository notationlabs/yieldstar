# `@yieldstar/store-conformance`

This package contains the runnable qualification suites for YieldStar runtimes: one for store connectors and one for the execution client. The normative protocol is documented in the [store connector conformance specification](https://github.com/notationlabs/yieldstar/blob/main/docs/store-connector-spec.md).

Install it with the test runner and core package:

```sh
pnpm add -D @yieldstar/core @yieldstar/store-conformance vitest
```

Register the suite from a Vitest test file. The only required integration point is a factory that creates a clean backend and returns a `Runtime` built on it. Store wakes are observed through the runtime's `ExecutionClient`: the suite admits the executions that wait on stores, and a commit that satisfies a waiter must make that execution due, so `runtime.executions.claimDue()` returns it.

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

The base factory qualifies a process-local runtime. A backend that supports multiple clients should also return `createPeer`, a runtime over the same backend as another process would open; a durable backend should additionally return `restart`. These capabilities activate the shared-client race and crash-recovery suites:

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

Run the test with either supported runtime:

```sh
vitest run store-conformance.test.ts
```

## Execution client suite

`registerExecutionClientConformance` checks a runtime's `ExecutionClient` and fenced heap writes against RFC 001 and RFC 002: admission, wake merging, claims, acknowledgement and terminal outcomes; leases, renewal, release and the `running` status; the redelivery delay and `unacknowledgedDeliveries`; and fencing of heap writes, renewals, releases and acknowledgements against a stale holder. The suite passes a `clock` to `create`; build every runtime on it so the suite controls time, including lease expiry.

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

