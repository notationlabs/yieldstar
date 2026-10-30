# Durable Stores

A store is schema-validated state that lives outside any single workflow execution. Workflows read and update it through durable steps; external code can write to it too. This one primitive covers long-lived agents, mailboxes, shared project state, and human approval flows – without a separate concept for each.

## Defining a store

`defineStore` creates a store _type_, not an instance. It takes a name, any [Standard Schema](https://standardschema.dev/) – Zod, Valibot, and ArkType all work – and the state a new store starts with.

```ts
import { defineStore } from "yieldstar";
import * as v from "valibot";

const ConversationStore = defineStore(
  "conversation",
  v.object({
    messages: v.array(
      v.object({
        id: v.string(),
        content: v.string(),
        processed: v.optional(v.boolean(), false),
      })
    ),
    status: v.picklist(["idle", "working"]),
  }),
  {
    initial: (conversationId) => ({ messages: [], status: "idle" }), // ← required
  }
);
```

`initial` is a synchronous function of the store's `id` that returns a durable value. It is required, because any operation may be the first one on a store, and that operation creates the store from `initial` (see [Creating a store](#creating-a-store)).

The runtime validates state against the schema when a store is created, and again on every update before it commits. So a bad write fails upfront, rather than leaving invalid state behind.

### Durable state

After the schema accepts a state, the runtime checks that the schema's output is a durable value (see [Step values](./steps.md#step-values)). TypeScript checks it first: `defineStore` and `step.store` reject a schema whose output type is not durable, and `select`, `when` and `take` reject a selector whose result is not. State may hold `Date`s, `Map`s and `Set`s, and an updater can mutate them in place, for example with `draft.totals.set("mug", 2)`. A state that holds a class instance or a function makes its store step throw `WorkflowValueError` with the code `INVALID_STEP_VALUE`, and the store is left unchanged: no new version, no wakes. The same applies to the state `initial` returns, which then creates no store, and to the value a `take` selects, which then claims nothing.

```ts
try {
  yield* store.update("touch", (draft) => {
    draft.updatedAt = new Date(); // ← not durable
  });
} catch (err) {
  // WorkflowValueError: INVALID_STEP_VALUE, stepKey "touch". The store's version is unchanged.
}
```

Store state may hold `undefined` properties, which keep their keys, and errors, which keep their registered class.

## Opening a store

`step.store` returns a handle to one store. It takes no `yield*`, because obtaining a handle reads nothing, writes nothing and records no step:

```ts
const store = step.store(ConversationStore, { id: event.params.conversationId });
```

Store identity is `name + id`. Omit the `id` and it defaults to `event.executionId`, giving you execution-local state:

```ts
const store = step.store(ScratchStore);
```

Pass an explicit `id` to share one store across executions – a conversation id, an agent id, a project id. Store state is never scoped to an execution, but each step an operation records belongs to the execution that runs it.

### Reopening a handle

Since a handle records no step, any code may ask for the same store again. A loop can reopen it on every turn, and a helper can open it from its `id` instead of receiving the handle from its caller:

```ts
async function* addTask(step: StepRunner, projectId: string, task: Task) {
  const project = step.store(ProjectStore, { id: projectId });
  yield* project.update(`add:${task.id}`, (draft) => {
    draft.tasks.push(task);
  });
}

for (const task of tasks) {
  yield* addTask(step, projectId, task); // ← each call opens the same store
}
```

Handles for the same `name + id` address the same store. The step keys that matter are the operations' keys, such as `add:${task.id}`, and those must still be unique within an execution.

### Creating a store

No operation creates a store on its own. Instead, every durable operation – `get`, `select`, `update`, `updateFrom`, `deleteFrom`, `when` and `take` – creates a missing store from `initial(id)` first, in the same atomic write as the operation itself. In the `addTask` example, the first `update` creates the project store with `{ projectId, tasks: [] }` and adds the task in one commit, so no caller has to create the store before the others use it.

The runtime guarantees the following about creation:

- `initial` runs only when the store does not exist.
- Two executions that update a missing store at the same time record exactly one initial state, and both updates apply to it.
- A workflow that crashes after an operation commits, but before its step is recorded, does not create the store or apply the operation a second time on replay. The store's receipt for the step returns the committed result.
- A store deleted between deliveries is created again from `initial` by the next operation, with a new `instanceId`.

`initial` can only derive state from `id`. Data that is not derived from the `id`, such as a conversation's first message, is written by an operation, such as a first `update`. A workflow that needs that data before it continues waits for it with [`when`](./store-waiting.md).

An error thrown by `initial` is thrown from the operation that ran it, so workflow code can catch it like an error thrown by an updater.

## Reading

`store.get` returns a snapshot containing the state and a version number that
increments on each update. The snapshot also contains an internal UUIDv7
`instanceId`, assigned when the store is created. Deleting and recreating the
same logical store assigns a new instance ID.

```ts
const { state, instanceId, version } = yield* store.get("load");
```

`store.select` runs a pure selector and persists only the selected value:

```ts
const unprocessed = yield* store.select("unprocessed", (s) =>
  s.messages.filter((m) => !m.processed)
);
```

Reads are durable steps. The first time a read step runs, it reads the latest committed state, and the runtime records the snapshot under the step key. On replay, the runtime returns the recorded snapshot – not whatever the store contains by then.

A _new_ read step may observe newer state. Workflows are long-running, so this is deliberate: each completed read is stable across replays, but the workflow as a whole is not one big snapshot transaction.

## Updating

`store.update` mutates a draft:

```ts
yield* store.update(`finish:${msg.id}`, (draft) => {
  const message = draft.messages.find((m) => m.id === msg.id)!;
  message.processed = true;
  draft.status = "idle";
});
```

The runtime validates the new state, commits it, and increments the version by
one. Concurrent updates are retried against the latest state, so an updater may
run more than once.

Updates are durable and idempotent by step key. On replay, the runtime returns
the recorded result without running the updater again.

Updaters must be synchronous and side-effect-free. Do not perform network
calls, start timers, or modify anything outside the draft.

When a decision depends on an earlier read, use `updateFrom` to commit only if
the store has not changed since that snapshot:

```ts
const snapshot = yield* store.get("load-before-sync");
const remote = yield* step.run("sync-remote", () =>
  syncRemote(snapshot.state)
);

const result = yield* store.updateFrom(
  "save-remote-result",
  snapshot,
  (draft) => {
    draft.remoteId = remote.id;
  }
);

if (!result.updated) {
  // The updater did not run. Read fresh state and reconcile in new steps.
}
```

The successful branch contains the same state and version fields as
`store.update`, plus `updated: true`. A conflict returns `updated: false` and
the expected and actual instance IDs and versions. Comparing both values
prevents an old snapshot from matching a deleted and recreated store whose
version happens to be the same. Both outcomes are durable step results. A
retry after a conflict must use a fresh read and a new step key.

## Deleting

Use `deleteFrom` when deletion is based on a snapshot:

```ts
const snapshot = yield* store.get("load-before-delete");
const result = yield* store.deleteFrom("delete", snapshot);

if (!result.deleted) {
  // The store changed, was recreated, or was already removed.
}
```

The store is deleted only when its instance ID and version still match the
snapshot. Replaying a successful deletion returns its recorded result without
deleting a newer store created under the same logical ID.

Runtime integrations can call `listStores(definition)` to get the definition's
live logical IDs in ascending order, and `deleteStore({ definition, id })` for
an unconditional, idempotent administrative deletion. Prefer `deleteFrom`
when the deletion decision was made from previously read state.

## Waiting

To pause a workflow until the store reaches some condition, see [Waiting on State](./store-waiting.md).
