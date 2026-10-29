# Durable Store Spec

Status: proposal

This spec adds durable, schema-validated state to YieldStar. The goal is to make long-lived agents, actors, mailboxes, shared project state, human approval workflows, and external event ingestion possible without adding separate concepts for each one.

The core API should stay small:

```ts
const store = step.store(StoreDef, { id })
yield* store.update("append:message-1", draft => {
  draft.messages.push(message)
})
const message = yield* store.when(s =>
  s.messages.find(m => !m.processed)
)
```

## Design Principles

- A store definition creates a store type, not an instance.
- Store identity is `definition.name + id`.
- If no store id is provided inside a workflow, the id defaults to `event.executionId`.
- Reads inside workflows are yielded and durable.
- Replaying a workflow must never observe a different value for an already completed read.
- Workflow updates are idempotent by step key. This is enforced at two layers: the workflow heap caches completed step results, and the store itself keeps an applied-steps ledger written atomically with each commit, so a crash between the store commit and the heap write cannot re-apply an update on replay.
- Public APIs should not expose path lists for writes.
- `when` should infer watched paths by running the selector against a tracking proxy.
- Store schemas use Standard Schema, not Zod-specific APIs.

## Prior Art

Selector-driven tracking has enough precedent to be worth pursuing, but the durable runtime needs stricter semantics than UI state libraries.

MobX reactions run user functions in a reactive context and record the observables read during that execution. Solid memos similarly re-execute when tracked dependencies change. React Tracked and proxy-compare-style systems use JavaScript `Proxy` objects to track which object paths are read. Immer can generate write patches with array paths from mutating update functions.

References:

- [MobX reactions](https://mobx.js.org/reactions.html)
- [Solid createMemo](https://docs.solidjs.com/reference/basic-reactivity/create-memo)
- [React Tracked state usage tracking](https://react-tracked.js.org/docs/introduction/)
- [Immer patches](https://immerjs.github.io/immer/patches/)
- [Standard Schema](https://standardschema.dev/)

The useful shape for YieldStar is:

- Run `when` selectors against a read-tracking proxy.
- Run `update` functions against a write-recording proxy over the draft, recording the path of every write.
- Wake waiters when recorded write paths intersect selector-read paths.
- Replay the workflow and re-run the selector rather than serializing selector functions.

This keeps the magical part local and inspectable: selectors are ordinary functions, but the runtime derives their dependencies from actual reads.

## Store Definition API

```ts
import type { StandardSchemaV1 } from "@standard-schema/spec"

type StoreDefinition<Schema extends StandardSchemaV1> = {
  name: string
  schema: Schema
  initial: (id: string) => StoreState<Schema>
}

type StoreState<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<Schema>

function defineStore<Schema extends StandardSchemaV1>(
  name: string,
  schema: Schema,
  options: {
    initial: (id: string) => Durable<StoreState<Schema>>
  }
): StoreDefinition<Schema>
```

`initial` is required, so every store can always be created. It is synchronous and evaluated only when the store with that `id` does not exist.

Example:

```ts
const ConversationStore = defineStore(
  "conversation",
  v.object({
    messages: v.array(
      v.object({
        id: v.string(),
        role: v.picklist(["user", "assistant", "tool"]),
        content: v.string(),
        processed: v.optional(v.boolean(), false),
      })
    ),
    status: v.picklist(["idle", "working"]),
  }),
  { initial: () => ({ messages: [], status: "idle" }) }
)
```

The schema is validated:

- when a store is created from `initial`
- after every workflow update
- after every external update
- before a snapshot is returned if the persisted format version or schema version requires validation

## Store Identity

```ts
type StoreId = string

type StoreKey = {
  storeName: string
  storeId: StoreId
}
```

Inside a workflow:

```ts
const storeId = params.id ?? event.executionId
```

So:

```ts
step.store(ConversationStore)
```

means execution-local store.

And:

```ts
step.store(ConversationStore, { id: event.params.conversationId })
```

means shared/correlation-bound store.

There is no public `scope`, `mailbox`, `actor`, or `writePolicy`.

## Workflow API

```ts
interface StepRunner {
  store<Schema extends StandardSchemaV1>(
    store: StoreDefinition<Schema>,
    params?: {
      id?: string
    }
  ): WorkflowStore<StoreState<Schema>>
}
```

Semantics:

- `step.store` returns a handle synchronously. It does not read, create or change the store, and records no workflow step.
- Repeated calls for the same identity return handles for the same store, so a loop or helper may request a handle without receiving it from another caller.
- If no `id` is provided, use `event.executionId`.
- Every durable operation on a missing store first creates it from `definition.initial(id)`, in the same atomic store write as the operation.
- Concurrent or repeated operations on a missing store record exactly one initial state per store identity.
- A crash after an operation commits but before its step is recorded neither creates the store again nor applies the operation twice; the operation's receipt identifies it.
- A store deleted between deliveries is created again from `initial` by the next operation.
- An error thrown by `initial` is a workflow error thrown from the operation that ran it.

## Workflow Store Handle

```ts
type StoreVersion = number
type StorePath = readonly (string | number | symbol)[]

type StoreSnapshot<T> = {
  state: T
  instanceId: string // UUIDv7 assigned when this store instance is created
  version: StoreVersion
}

type StoreUpdateResult<T> = {
  state: T
  previousVersion: StoreVersion
  version: StoreVersion
}

type StoreSelector<T, R> = (state: Readonly<T>) => R

interface WorkflowStore<T> {
  readonly definition: StoreDefinition<any>
  readonly id: string
  readonly key: StoreKey

  get(key?: string): AsyncGenerator<StepResponse, StoreSnapshot<T>>

  select<R>(
    key: string,
    selector: StoreSelector<T, R>
  ): AsyncGenerator<StepResponse, R>

  update(
    key: string,
    updater: (draft: Draft<T>) => void | T
  ): AsyncGenerator<StepResponse, StoreUpdateResult<T>>

  updateFrom(
    key: string,
    snapshot: StoreSnapshot<T>,
    updater: (draft: Draft<T>) => void | T
  ): AsyncGenerator<StepResponse, StoreUpdateFromResult<T>>

  deleteFrom(
    key: string,
    snapshot: StoreSnapshot<T>
  ): AsyncGenerator<StepResponse, StoreDeleteFromResult>

  when<R>(
    selector: StoreSelector<T, R | undefined | null | false>
  ): AsyncGenerator<StepResponse, NonNullable<R>>

  when<R>(
    key: string,
    selector: StoreSelector<T, R | undefined | null | false>
  ): AsyncGenerator<StepResponse, NonNullable<R>>

  take<R>(
    key: string,
    selector: StoreSelector<T, R | undefined | null | false>,
    claim: (draft: Draft<T>, selected: NonNullable<R>) => void
  ): AsyncGenerator<StepResponse, NonNullable<R>>
}
```

There is intentionally no `WorkflowStore.version`. Versions belong to snapshots and update results, because a long-lived handle would otherwise invite stale reads.

There is intentionally no `timeoutMs`. Timeouts can be added later as an explicit cancellation/deadline primitive, but the first store API should not mix "wait for data" with "fail after time" until the workflow cancellation story is clear.

## Default Read Policy

The default read policy is:

```text
read latest committed on first execution of the step;
return the recorded snapshot on replay
```

In other words:

- `get` and `select` read the latest committed store state when that step first runs.
- The snapshot and version are persisted under the step key.
- Replays return the persisted snapshot, not whatever the external store contains later.
- A later read with a different step key may observe newer committed state.
- A read after a completed `store.update` sees that update if no newer write wins the race before the read executes.

This is deliberately not a workflow-wide snapshot transaction. Workflows are long-running processes, so they should be allowed to observe new committed state at new durable read steps while keeping each completed read replay-stable.

## `get`

```ts
const snapshot = yield* store.get("load-current")
```

Returns:

```ts
snapshot.state
snapshot.version
```

If the key is omitted, YieldStar may use the call-site hash, following the same caveats as other step helpers. Explicit keys are required when a workflow can reach the same call site more than once before yielding.

## `select`

```ts
const unprocessed = yield* store.select("unprocessed", s =>
  s.messages.filter(m => !m.processed)
)
```

`select` is a durable read followed by a pure selector. The selected value is persisted as the step result. The selector is not serialized.

## `update`

```ts
yield* store.update(`start:${message.id}`, draft => {
  draft.status = "working"
})
```

`update` is a durable step. The key is the workflow step key for that update.

Updaters are synchronous, deterministic, and side-effect-free. Stores commit
with compare-and-swap (CAS): if the version changed after the read, the runtime
runs the updater again against the latest snapshot.

If replayed, the workflow step cache returns the recorded `StoreUpdateResult` and the runtime does not call the store updater again. This holds even when the previous run crashed after the store commit but before the workflow heap write, because the store itself records the committed result in the applied-steps ledger (see below) inside the same transaction as the state change.

The runtime derives changed paths automatically. The updater runs against a write-recording proxy over the draft, and every `set`/`deleteProperty` through the proxy records its full path (mutating array methods are captured naturally via the index/length writes they perform). This makes path derivation O(changes) rather than O(state size). If the updater returns a replacement state instead of mutating the draft, the runtime falls back to deep-diffing the previous and next states. Changed paths only affect wake precision, never state correctness, so ambiguous operations are recorded conservatively – an extra path is at worst a spurious wake, which replay absorbs.

Update semantics:

- Updates are atomic per store.
- Each successful update increments the store version by one.
- The updated state is validated against the store schema before commit.
- The update result records `previousVersion` and `version`.
- The runtime records changed paths internally for waiter wakeups.
- Durable connectors record matching wake intents atomically with the state
  change. Scheduler delivery happens after commit and is best-effort: a failed
  delivery remains pending and does not reject the committed update.
- A connector response can be lost after commit. Workflow calls are
  exactly-once through their `stepId`; direct callers must read and reconcile
  before retrying an ambiguous failure.

## `when`

`when` is the durable wait primitive. It waits once for a condition and returns the selected value – it is not a subscription. It is the pure observe primitive: the store is never mutated by a `when`.

```ts
const message = yield* store.when(s =>
  s.messages.find(m => !m.processed)
)
```

The selector-only form uses the call-site hash as the durable step key. The keyed form is required when the same workflow can reach the same `when` call site more than once before yielding:

```ts
const message = yield* store.when(`next-message:${turn}`, s =>
  s.messages.find(m => !m.processed)
)
```

Semantics:

1. Read the current committed store snapshot.
2. Run the selector against a read-tracking proxy.
3. Record the paths read by the selector.
4. If the selector returns a truthy/non-null value, persist and return it.
5. Otherwise persist a waiter:
   - workflow id
   - execution id
   - original event
   - store name
   - store id
   - step key
   - current store version
   - tracked read paths
6. Yield control to the runtime.
7. When the store changes at an intersecting path, enqueue the same workflow execution.
8. On replay, run the selector again.

The selector is not serialized. The runtime wakes coarsely from stored read paths, then the workflow replay evaluates the actual condition.

## `take`

`take` is the atomic wait-and-consume primitive. It selects and claims from a
snapshot, then conditionally commits the claim as one version bump. If the
snapshot is stale, selection and claiming restart from the latest state. This
is the primitive for multi-consumer mailboxes and queues where exactly one
execution must win each item; `when` remains the pure observe primitive.

```ts
const msg = yield* store.take(
  `next-message:${turn}`,
  s => s.messages.find(m => !m.claimedBy && !m.processed),
  (draft, msg) => {
    msg.claimedBy = event.executionId
  }
)
```

```ts
take<R>(
  key: string,
  selector: StoreSelector<T, R | undefined | null | false>,
  claim: (draft: Draft<T>, selected: NonNullable<R>) => void
): AsyncGenerator<StepResponse, NonNullable<R>>
```

The key is REQUIRED – takes live in loops, and a call-site-hash default would silently return the same cached item every iteration.

Semantics:

- `take` is a durable step: on cache hit, replay returns the recorded selected value; the selector and claim never re-run.
- On first execution, using the store's CAS protocol:
  1. Run the selector against the current state via the read-tracking proxy.
  2. If the selector returns a truthy value: apply `claim(draft, selected)`, validate the resulting state against the schema, conditionally commit a single version bump, record the changed paths and selected step result, and return it. A CAS conflict restarts selection and claiming from the newer snapshot.
  3. If the selector returns a falsy value: commit nothing, register a waiter with the tracked read paths and observed version, then recheck the store version before suspending. This closes the lost-wakeup gap without holding a transaction while the selector runs.
- On wake, replay re-runs the whole take. A competing consumer may have already claimed the item – the selector then misses and the waiter re-registers. Spurious wakes are safe.
- Return value (reference-snapshot rule): the selector runs against the draft, so a selected value that is a reference into state is snapshotted AFTER the claim runs – e.g. a claimed message is returned with `claimedBy` populated. A derived value (a `filter().length`, a mapped object) is returned as computed; the claim cannot appear in it. The selector cannot be re-run post-claim, because a correct claim makes the selector stop matching.
- `claim` must be synchronous. The runtime rejects (throws) if it returns a Promise.
- Contract: `claim` must falsify the selector for the selected item (e.g. set `processed` or `claimedBy`), otherwise the workflow spins, re-taking the same item forever. The runtime does not verify this.

### Path Tracking

`when` and `take` track paths by observing property reads:

```ts
yield* store.when("wait-status", s => s.status === "idle")
```

tracks `["status"]`.

```ts
yield* store.when("next-message", s =>
  s.messages.find(m => !m.processed)
)
```

tracks at least `["messages"]`. Implementations may also record deeper paths such as `["messages", 0, "processed"]`, but they must retain ancestor collection paths so appending to `messages` wakes the waiter.

A write path matches a read path when either path is a prefix of the other. This lets:

- a waiter on `["messages"]` wake for `["messages", 3]`
- a waiter on `["status"]` wake for `["status"]`
- a waiter on `["profile", "name"]` wake if `["profile"]` is replaced

### Selector Requirements

Selectors should be synchronous and pure:

- no network
- no timers
- no mutation
- no reads from external mutable state
- no async work

The runtime may reject async selectors. The selector result must be serializable, because successful `when` and `take` results are persisted.

## Applied-Steps Ledger

Workflow `update` and `take` steps commit to the store first and persist the step result to the workflow heap second. A crash between the two would otherwise make the operation at-least-once: replay would find no heap row, re-run the updater or claim, and apply the mutation twice.

The store closes this gap with an applied-steps ledger it owns:

- Every workflow-issued `update`/`take` carries a `stepId` (`executionId` + `stepKey`). External `runtime.store(...)` calls carry no `stepId` and never touch the ledger.
- The ledger is keyed by `(storeName, storeId, executionId, stepKey)` and stores the serialized committed result (`StoreUpdateResult`, or the matched take outcome).
- The ledger row is written ATOMICALLY with the state change: in SQLite, inside the same transaction as the state update and version bump; in memory, in the same critical section of the write queue. Either both commit or neither does.
- On a repeated call with the same `stepId`, the store returns the recorded result verbatim without running the updater/selector/claim and without bumping the version.

Convergence: crash after store commit but before heap write → replay cache-misses the heap → the store operation hits the ledger → the original recorded result is returned without re-applying → the generator writes the heap row it previously failed to write. From then on the ordinary heap cache takes over.

Unmatched take outcomes are NOT recorded. An unmatched take commits nothing, registers a waiter, and suspends – it must remain free to re-evaluate the selector on every wake. Only committed (matched) outcomes enter the ledger.

Ledger retention: ledger rows share the lifecycle of workflow execution retention. When executions are pruned, their ledger rows become unreachable (a replayed `stepId` requires a live execution) and can be deleted with them. Retention machinery is deferred to the execution-retention feature; no separate GC is built for the ledger.

## External Runtime API

External writes are required for event ingestion and human/app interaction.

```ts
interface Runtime {
  store<Schema extends StandardSchemaV1>(
    store: StoreDefinition<Schema>,
    id: string
  ): RuntimeStore<StoreState<Schema>>
}

interface RuntimeStore<T> {
  get(): Promise<StoreSnapshot<T>>

  update(
    updater: (draft: Draft<T>) => void | T
  ): Promise<StoreUpdateResult<T>>

  updateFrom(
    snapshot: StoreSnapshot<T>,
    updater: (draft: Draft<T>) => void | T
  ): Promise<StoreUpdateFromResult<T>>

  deleteFrom(snapshot: StoreSnapshot<T>): Promise<StoreDeleteFromResult>
}
```

Example:

```ts
await runtime
  .store(ConversationStore, "conversation:123")
  .update(draft => {
    draft.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content: "hello",
      processed: false,
    })
  })
```

The update wakes matching `when` and `take` waiters using internally generated changed paths.

## Store Lifetime

Lifecycle is implicit:

```text
No id provided:
  store id = executionId
  lifecycle may be tied to workflow execution retention

id provided:
  store id = params.id
  lifecycle is independent and app-managed
```

## Example Agent

```ts
const AgentStore = defineStore(
  "agent",
  v.object({
    messages: v.array(Message),
    status: v.picklist(["idle", "working"]),
    memory: v.record(v.string(), v.unknown()),
  }),
  { initial: () => ({ messages: [], status: "idle", memory: {} }) }
)

export const agent = workflow(async function* (step, event) {
  const store = step.store(AgentStore, { id: event.params.agentId })

  let turn = 0

  while (true) {
    // `take` atomically claims the next message, so multiple agent
    // executions (a worker pool) can share one mailbox without two workers
    // processing the same message. The claim falsifies the selector.
    const msg = yield* store.take(
      `next-message:${turn++}`,
      s => s.messages.find(m => !m.claimedBy && !m.processed),
      (draft, msg) => {
        msg.claimedBy = event.executionId
      }
    )

    yield* store.update(`start:${msg.id}`, draft => {
      draft.status = "working"
    })

    const response = yield* step.run(`llm:${msg.id}`, () =>
      callModel(msg.content)
    )

    yield* store.update(`finish:${msg.id}`, draft => {
      const message = draft.messages.find(m => m.id === msg.id)!
      message.processed = true
      message.response = response.text
      draft.status = "idle"
    })

    // `when` fits where the workflow only observes – e.g. pausing until an
    // operator flips the store back to idle. Nothing is claimed.
    yield* store.when(`resume:${msg.id}`, s => s.status === "idle")
  }
})
```

## Intended Evolution (Non-Normative)

The blob-per-store storage model (one row holding the full JSON state, rewritten on every commit) is a v1 simplification. The intended future shape is log-structured: each commit appends a patch row (the recorded write paths plus their new values) and the runtime writes periodic snapshots, so reads reconstruct state from the latest snapshot plus subsequent patches, waiter matching runs directly against patch paths, and history older than the last snapshot is truncatable. The write-recording proxy already produces the per-commit path information this model needs; nothing in this section is required for conformance.

## Runtime Work

This is a first-class runtime feature, not only an SDK helper.

Required core changes:

- Add store definitions, snapshots, update results, and waiter response types to `@yieldstar/core`.
- Add a `StoreClient` abstraction beside `HeapClient` and `SchedulerClient`.
- Pass the store client into workflow generators.
- Make `stepRunner` execution-aware so `step.store` can use `event.executionId`.
- Add a workflow suspension response for store waiters.
- Teach `WorkflowRunner` to register store waiters and wake executions.

Required runtime changes:

- Memory store state and waiters.
- SQLite store and waiter tables.
- Atomic per-store update transactions.
- Waiter wakeup by path intersection.
- Event re-enqueue with the original workflow event.

Required SDK/API changes:

- Local runtime access to `runtime.store(...)`.
- HTTP endpoints for external store `get` and `update` if store access is exposed remotely.
- Test utilities that can trigger workflows and mutate stores externally.

Required tests:

- store creation from the definition's initial state by the first operation
- repeated handle requests from a loop and a helper
- execution-local default store id
- shared explicit store id
- durable `get` replay stability
- durable `select` replay stability
- workflow update idempotency
- schema validation on create and update
- `when` returns immediately when selector matches
- `when` waits when selector does not match
- external update wakes a waiting workflow
- workflow update wakes another waiting workflow
- array append wakes selector tracking the array
- unrelated paths do not wake waiters
- replacing an ancestor path wakes descendant waiters
- concurrent updates serialize per store
- take returns immediately and claims
- take waits then claims on external update
- two concurrent takers never claim the same item
- take replay idempotency
- claim validation failure leaves item unclaimed
- async claim rejected
