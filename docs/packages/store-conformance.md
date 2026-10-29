# @yieldstar/store-conformance

Vitest qualification suites for Yieldstar runtimes. `registerStoreClientConformance` verifies a `StoreClient`'s store lifecycle, concurrency, replay idempotency, waiter wake-up, wake collapsing, and crash-recovery behavior. `registerExecutionClientConformance` verifies a runtime's `ExecutionClient` against RFC 001.

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

Return `createPeer` when the backend supports multiple runtimes sharing the same data. This enables the cross-client race suites.

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

`registerExecutionClientConformance` checks a runtime's `ExecutionClient` against RFC 001: admission, wake merging, claims, acknowledgement and terminal outcomes. The suite passes a `clock` to `create`; build the runtime on it so the suite controls time. Return `restart` from a durable backend to enable the restart cases; without it they are skipped.

```ts
import { registerExecutionClientConformance } from "@yieldstar/store-conformance";
import { MyRuntime } from "./my-runtime";

registerExecutionClientConformance({
  name: "my-runtime",
  create({ clock }) {
    const backend = createCleanBackend();
    return {
      runtime: new MyRuntime(backend, { clock }),
      restart: () => new MyRuntime(backend.reopen(), { clock }),
      dispose: () => backend.close(),
    };
  },
});
```

The normative contract is in the repository's [store connector conformance specification](https://github.com/notationlabs/yieldstar/blob/main/docs/store-connector-spec.md).
