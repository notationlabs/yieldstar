# @yieldstar/runtime-conformance

Vitest qualification suites for Yieldstar runtimes. `registerStoreClientConformance` verifies a `StoreClient`'s store lifecycle, concurrency, replay idempotency, waiter wake-up, wake collapsing, and crash-recovery behavior. `registerExecutionClientConformance` verifies a runtime's `ExecutionClient` and fenced heap writes against RFC 001, RFC 002 and RFC 003. `registerEffectClientConformance` verifies its `EffectClient` against RFC 005.

## Install

```sh
pnpm add -D @yieldstar/core @yieldstar/runtime-conformance vitest
```

## Register the suite

Create a Vitest test file and provide a factory that creates a clean backend and returns a `Runtime` built on it. The suite observes store wakes through the runtime's `ExecutionClient`: it admits the executions that wait on stores, and a commit that satisfies a waiter must make that execution due, so `runtime.executions.claimDue()` returns it.

```ts
import { registerStoreClientConformance } from "@yieldstar/runtime-conformance";
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
vitest run runtime-conformance.test.ts
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

`registerExecutionClientConformance` checks a runtime's `ExecutionClient` and fenced heap writes against RFC 001, RFC 002 and RFC 003: admission, wake merging, claims, acknowledgement and terminal outcomes; leases, renewal, release and the `running` status; the redelivery delay and `unacknowledgedDeliveryCount`; fencing of heap writes, renewals, releases and acknowledgements against a stale holder; and `start`, its idempotency by request ID, parameter validation, mismatches and the target's parent link. The suite passes a `clock` to `create`; build every runtime on it so the suite controls time, including lease expiry.

The harness has three optional capabilities:

- `createPeer` returns another runtime over the same backend, as a second runtime process would. The suite uses it to race two clients for one execution and to reclaim an expired lease from a different client than the one that holds it. Return it whenever several processes can share the backend; without it those cases run both sides on `runtime`, which proves less.
- `restart` reopens the same durable backend in a new runtime. It enables the restart cases; without it they are skipped.
- `failStartCommits` makes every new `start` on `runtime` fail after it begins writing but before it commits, and returns a function that stops the failures. It enables the case that a failed start leaves no trace; without it that case is skipped. The SQLite harness installs a temporary trigger that aborts the start-request insert.

```ts
import { registerExecutionClientConformance } from "@yieldstar/runtime-conformance";
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

## Effect client suite

`registerEffectClientConformance` checks a runtime's `EffectClient` against RFC 005: `begin` creating or reading one effect, mismatched operations and inputs, concurrent equal and different settlements and their conflict reports, `watch` registration and immediate wakes, settlement racing `watch`, waiter deletion with the step's result and its rejection for a stale holder, value encoding, and durability across a restart. Its harness takes the same `clock`, `createPeer` and `restart` as the execution client suite, plus `failEffectWatches`, which makes every `watch` on `runtime` fail before it commits and returns a function that stops the failures. Without it the case for a failed watch is skipped; the SQLite harness installs a temporary trigger that aborts the waiter insert.

```ts
import { registerEffectClientConformance } from "@yieldstar/runtime-conformance";

registerEffectClientConformance({
  name: "my-runtime",
  create({ clock }) {
    const backend = createCleanBackend();
    return {
      runtime: new MyRuntime(backend, { clock }),
      createPeer: () => new MyRuntime(backend.connect(), { clock }),
      restart: () => new MyRuntime(backend.reopen(), { clock }),
      dispose: () => backend.close(),
    };
  },
});
```

The suite covers the runtime adapter. RFC 003's workflow-driver and delivery cases for `step.start`, and RFC 005's for `step.effect`, are tested in the repository rather than here (`test/start.test.ts`, `test/effect.test.ts` and `test/effect-delivery.test.ts`). RFC 002's dispatcher and worker cases, such as concurrency, releasing on a retry reply, a worker that exits without replying, and a worker whose runtime process dies, are properties of `ExecutionDispatcher` and the invoker rather than of an adapter; the repository tests them in `test/dispatcher.test.ts` and `test/worker-invoker.test.ts`.

The normative contract is in the repository's [store connector conformance specification](https://github.com/notationlabs/yieldstar/blob/main/docs/store-connector-spec.md).
