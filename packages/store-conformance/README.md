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

The base factory qualifies a process-local runtime. A backend that supports multiple clients should also return `createPeer`; a durable backend should additionally return `restart`. These capabilities activate the shared-client race and crash-recovery suites:

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

