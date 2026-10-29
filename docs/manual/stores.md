# Durable Stores

A store is schema-validated state that lives outside any single workflow execution. Workflows read and update it through durable steps; external code can write to it too. This one primitive covers long-lived agents, mailboxes, shared project state, and human approval flows – without a separate concept for each.

## Defining a store

`defineStore` creates a store _type_, not an instance. It takes a name and any [Standard Schema](https://standardschema.dev/) – Zod, Valibot, and ArkType all work.

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
  })
);
```

The runtime validates state against the schema when a store is created, and again on every update before it commits. So a bad write fails upfront, rather than leaving invalid state behind.

### Durable state

After the schema accepts a state, the runtime checks that the schema's output is a durable value (see [Step values](./steps.md#step-values)). A state that holds a `Date`, a `Map` or a class instance makes its store step throw `WorkflowValueError` with the code `INVALID_STEP_VALUE`, and the store is left unchanged: no new version, no wakes. The same applies to `initial`, which then creates no store, and to the value a `take` selects, which then claims nothing.

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

## Creating and opening a store

`step.store` returns a handle. If the store does not exist yet, the runtime creates it from `initial`; if it does, the existing store is returned and `initial` is ignored.

```ts
const store = yield* step.store(ConversationStore, {
  id: event.params.conversationId,
  initial: { messages: [], status: "idle" },
});
```

Store identity is `name + id`. Omit the `id` and it defaults to `event.executionId`, giving you execution-local state:

```ts
const store = yield* step.store(ScratchStore, { initial: {} });
```

Pass an explicit `id` to share one store across executions – a conversation id, an agent id, a project id. If the store does not exist and no `initial` is provided, the step fails.

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
