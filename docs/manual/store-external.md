# External Store Access

Stores are not workflow-only. Any code with a `StoreClient` – an HTTP handler, a webhook receiver, a CLI – can read and write a store directly. This is how events get _into_ the system: an external write wakes any workflow that is waiting on the state it changed.

## Getting a handle

`runtime.stores.store(definition, id)` returns a plain async handle – no workflow, no steps.

```ts
import { SqliteRuntime } from "@yieldstar/sqlite-runtime/bun";
import { ConversationStore } from "./shared";

const runtime = new SqliteRuntime(db);
const storeClient = runtime.stores;

const conversation = storeClient.store(ConversationStore, "conversation:123");
```

Take the store client from the runtime rather than constructing one, because the runtime wires it to the execution records. When a write changes state that a suspended workflow is waiting on, the store client makes that workflow's execution due in the same transaction as the write. A running dispatcher then delivers it. See [Resident-process runtime](../runtimes/resident-process.md) for the full wiring.

## Missing stores

The handle's operations follow the same rule as workflow operations: `get`, `update`, `updateFrom` and `deleteFrom` on a missing store first create it from the definition's `initial(id)`, in the same write. So a webhook handler can write to a conversation before any workflow has used it, and `get` never fails because a store is missing. `deleteStore` is the exception, since it never creates a store.

## Reading

```ts
const { state, instanceId, version } = await conversation.get();
```

`instanceId` is an internal UUIDv7 assigned when the store is created. It stays
the same for the lifetime of that store. Deleting and recreating the same
logical definition and ID assigns a new instance ID and resets the version to
zero.

## Writing

`update` takes the same synchronous, pure draft-mutating updater as the workflow
API. The runtime validates the resulting state and increments the version by
one. Concurrent updates are retried against the latest state, so the updater
must be synchronous and side-effect-free.

```ts
await conversation.update((draft) => {
  draft.messages.push({
    id: crypto.randomUUID(),
    content: "hello",
    processed: false,
  });
});
```

If a workflow is suspended on `store.when` or `store.take` over `s.messages`, this write wakes it. That is the whole event-ingestion story: the webhook handler writes state, and the workflow that cares about that state resumes.

When a write or deletion depends on an earlier snapshot, use the conditional
operations:

```ts
const snapshot = await conversation.get();

const updated = await conversation.updateFrom(snapshot, (draft) => {
  draft.status = "synced";
});

const current = await conversation.get();
const deleted = await conversation.deleteFrom(current);
```

They commit only if both `instanceId` and `version` still match. `StoreClient`
also exposes `listStores(definition)`, which returns sorted live logical IDs,
and idempotent unconditional `deleteStore({ definition, id })` for
administrative cleanup.

## The pattern in full

```ts
// HTTP handler – external side
app.post("/conversations/:id/messages", async (req) => {
  await storeClient
    .store(ConversationStore, req.params.id)
    .update((draft) => {
      draft.messages.push(req.body);
    });
  return new Response("ok");
});

// Workflow – waiting side
const msg = yield* store.take(
  `next:${turn}`,
  (s) => s.messages.find((m) => !m.processed),
  (draft, m) => {
    draft.messages.find((x) => x.id === m.id)!.processed = true;
  }
);
```

External updates are not workflow steps and have no step key. If a request
fails or your handler retries, read the current store and decide whether the
write still needs to be applied.
