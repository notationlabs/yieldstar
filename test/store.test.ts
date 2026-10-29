import { expect, test, vi } from "vitest";
import type { StandardSchemaV1, StepRunner } from "yieldstar";
import { testSchema } from "@yieldstar/test-utils";
import { DEFAULT_LEASE_DURATION, waitForExecutionOutcome } from "@yieldstar/core";
import { createSdk } from "./sdk";
import { WORKFLOW_RESULT_STEP_KEY, defineStore, workflow } from "yieldstar";
import { setTimeout as sleep } from "node:timers/promises";

type Message = {
  id: string;
  content: string;
  processed: boolean;
  claimedBy?: string;
};

type ConversationState = {
  messages: Message[];
  status: "idle" | "working";
};

const ConversationStore = defineStore(
  "conversation",
  testSchema<ConversationState>(),
  { initial: () => ({ messages: [], status: "idle" }) }
);

const REPLAY_DELAY_MS = 10;

/**
 * Runs an execution across a `step.delay` replay boundary deterministically.
 *
 * A tiny real-time delay may already have elapsed when the workflow checks it,
 * so the workflow wouldn't suspend. Instead:
 * 1. Freeze Date an hour in the past until the execution records its delay
 *    step and suspends. The wake stays in the future, so nothing claims it.
 * 2. Run `beforeReplay` while the execution is parked.
 * 3. Restore the real clock, so the delay has elapsed when the wake replays
 *    the workflow.
 */
async function acrossReplayBoundary<T>(params: {
  sdk: ReturnType<typeof createSdk>;
  executionId: string;
  delayKey: string;
  start: () => Promise<T>;
  beforeReplay?: () => Promise<unknown>;
}): Promise<T> {
  const { sdk, executionId, delayKey } = params;
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 3_600_000 });
  let resultPromise: Promise<T>;
  try {
    resultPromise = params.start();
    // Surface failures without waiting for the boundary
    resultPromise.catch(() => {});
    await vi.waitFor(
      () => {
        const key = sdk.heapClient.getKey({ executionId, stepKey: delayKey });
        if (!sdk.heapClient.cache[key]) throw new Error("not suspended yet");
      },
      { timeout: 2_000, interval: 1 }
    );
    await params.beforeReplay?.();
  } finally {
    vi.useRealTimers();
  }
  return resultPromise;
}

test("workflow stores can be created, read, and updated", async () => {
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore);

    const initial = yield* store.get("initial");

    const update = yield* store.update("append", (draft) => {
      draft.messages.push({
        id: "msg-1",
        content: "hello",
        processed: false,
      });
    });

    const current = yield* store.get("current");

    return {
      initial,
      update,
      current,
    };
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  expect(result.initial).toMatchObject({
    state: { messages: [], status: "idle" },
    version: 0,
  });
  expect(result.initial.instanceId).toMatch(/^[0-9a-f-]+$/);
  expect(result.update.previousVersion).toBe(0);
  expect(result.update.version).toBe(1);
  expect(result.current).toEqual({
    state: {
      messages: [{ id: "msg-1", content: "hello", processed: false }],
      status: "idle",
    },
    instanceId: result.initial.instanceId,
    version: 1,
  });
});

test("workflow store updates are idempotent across replay", async () => {
  let runs = 0;
  const testWorkflow = workflow(async function* (step) {
    runs++;
    const store = step.store(ConversationStore, { id: "replay" });

    yield* store.update("append-once", (draft) => {
      draft.messages.push({
        id: "msg-1",
        content: "hello",
        processed: false,
      });
    });

    yield* step.delay("replay-boundary", REPLAY_DELAY_MS);

    const snapshot = yield* store.get("after-replay");
    return snapshot.state.messages;
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const executionId = "idempotent-replay";
  const result = await acrossReplayBoundary({
    sdk,
    executionId,
    delayKey: "replay-boundary",
    start: () => sdk.triggerAndWait({ workflowId: "workflow", executionId }),
  });

  expect(runs).toBe(2);
  expect(result).toEqual([
    { id: "msg-1", content: "hello", processed: false },
  ]);
});

test("workflow stores can conditionally update from a snapshot", async () => {
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "conditional" });
    const snapshot = yield* store.get("snapshot");

    yield* store.update("intervening-update", (draft) => {
      draft.status = "working";
    });

    return yield* store.updateFrom("conditional-update", snapshot, (draft) => {
      draft.status = "idle";
    });
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  expect(result).toMatchObject({
    updated: false,
    expectedVersion: 0,
    actualVersion: 1,
  });
  if (result.updated) throw new Error("update should conflict");
  expect(result.actualInstanceId).toBe(result.expectedInstanceId);
});

test("external store updates wake when waiters", async () => {
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "external-wake" });

    return yield* store.when("next-message", (state) =>
      state.messages.find((message) => !message.processed)
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const resultPromise = sdk.triggerAndWait({ workflowId: "workflow" });

  await sleep(5);

  await sdk.store(ConversationStore, "external-wake").update((draft) => {
    draft.messages.push({
      id: "msg-1",
      content: "hello",
      processed: false,
    });
  });

  await expect(resultPromise).resolves.toEqual({
    id: "msg-1",
    content: "hello",
    processed: false,
  });
});

test("execution-local default store id is unique per execution", async () => {
  let firstExecutionId: string | undefined;
  let secondExecutionId: string | undefined;

  const testWorkflow = workflow(async function* (step, event) {
    const store = step.store(ConversationStore);

    if (event.executionId === "run-1") {
      firstExecutionId = store.id;
      yield* store.update("write", (draft) => {
        draft.status = "working";
      });
    } else {
      secondExecutionId = store.id;
    }

    const snapshot = yield* store.get("final");
    return snapshot.state.status;
  });

  const sdk = createSdk({ workflow: testWorkflow });

  const result1 = await sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "run-1",
  });
  const result2 = await sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "run-2",
  });

  expect(firstExecutionId).toBe("run-1");
  expect(secondExecutionId).toBe("run-2");
  expect(result1).toBe("working");
  expect(result2).toBe("idle");
});

test("durable get and select replay stability", async () => {
  let selectCallCount = 0;
  let runs = 0;
  const testWorkflow = workflow(async function* (step) {
    runs++;
    const store = step.store(ConversationStore, { id: "replay-stability" });

    const valGet = yield* store.get("read-get");
    const valSelect = yield* store.select("read-select", (s) => {
      selectCallCount++;
      return s.status;
    });

    yield* step.delay("suspend", REPLAY_DELAY_MS);

    return { valGet, valSelect };
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const executionId = "replay-stability";
  const res = await acrossReplayBoundary({
    sdk,
    executionId,
    delayKey: "suspend",
    start: () => sdk.triggerAndWait({ workflowId: "workflow", executionId }),
    // Change the store while the execution is suspended, before it replays
    beforeReplay: () =>
      sdk.store(ConversationStore, "replay-stability").update((draft) => {
        draft.status = "working";
      }),
  });

  expect(runs).toBe(2);
  expect(res.valGet.state.status).toBe("idle");
  expect(res.valSelect).toBe("idle");
  expect(selectCallCount).toBe(1);
});

test("schema validation on create and update", async () => {
  const strictStateSchema = strictSchema<{ count: number }>((val: any) => {
    if (typeof val !== "object" || val === null || typeof val.count !== "number") {
      return "Count must be a number";
    }
    return undefined;
  });

  const StrictStore = defineStore("strict-store", strictStateSchema, {
    initial: () => ({ count: 0 }),
  });

  const InvalidInitialStore = defineStore("strict-invalid-initial", strictStateSchema, {
    initial: () => ({ count: "not-a-number" }) as any,
  });

  const testWorkflowInvalidCreate = workflow(async function* (step) {
    yield* step.store(InvalidInitialStore, { id: "strict-1" }).get("read");
  });

  const sdk1 = createSdk({ workflow: testWorkflowInvalidCreate });
  await expect(
    sdk1.triggerAndWait({ workflowId: "workflow" })
  ).rejects.toThrow(/Invalid store state/);
  expect(await sdk1.storeClient.listStores(InvalidInitialStore)).toEqual([]);

  const testWorkflowInvalidUpdate = workflow(async function* (step) {
    const store = step.store(StrictStore, { id: "strict-2" });

    yield* store.update("bad-update", (draft) => {
      draft.count = "invalid" as any;
    });
  });

  const sdk2 = createSdk({ workflow: testWorkflowInvalidUpdate });
  await expect(
    sdk2.triggerAndWait({ workflowId: "workflow" })
  ).rejects.toThrow(/Invalid store state/);
});

test("when returns immediately when selector matches", async () => {
  let ranStep = false;
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "immediate-match" });

    const status = yield* store.when("wait-working", (s) =>
      s.status === "working" ? s.status : false
    );

    ranStep = true;
    return status;
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(ConversationStore, "immediate-match").update((draft) => {
    draft.status = "working";
  });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  expect(ranStep).toBe(true);
  expect(result).toBe("working");
});

test("workflow update wakes another waiting workflow", async () => {
  const waiterWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "shared-wake" });

    return yield* store.when("wait-status", (s) =>
      s.status === "working" ? s.status : false
    );
  });

  const updaterWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "shared-wake" });

    yield* store.update("set-status", (draft) => {
      draft.status = "working";
    });
  });

  const router = {
    waiter: waiterWorkflow,
    updater: updaterWorkflow,
  };

  const sdk = createSdk(router);
  const waiterPromise = sdk.triggerAndWait({ workflowId: "waiter" });

  await sleep(5);
  await sdk.trigger({ workflowId: "updater" });

  await expect(waiterPromise).resolves.toBe("working");
});

test("unrelated paths do not wake waiters", async () => {
  let wakeCount = 0;

  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "unrelated-paths" });

    wakeCount++;

    return yield* store.when("wait-messages", (state) =>
      state.messages.length > 0 ? state.messages : false
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const resultPromise = sdk.triggerAndWait({ workflowId: "workflow" });

  await sleep(5);

  await sdk.store(ConversationStore, "unrelated-paths").update((draft) => {
    draft.status = "working";
  });

  await sleep(5);
  expect(wakeCount).toBe(1);

  await sdk.store(ConversationStore, "unrelated-paths").update((draft) => {
    draft.messages.push({ id: "msg-1", content: "hello", processed: false });
  });

  const res = await resultPromise;
  expect(wakeCount).toBe(2);
  expect(res).toEqual([{ id: "msg-1", content: "hello", processed: false }]);
});

test("replacing an ancestor path wakes descendant waiters", async () => {
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "ancestor-wake" });

    return yield* store.when("wait-descendant", (state) =>
      state.messages[0]?.processed ? "done" : false
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(ConversationStore, "ancestor-wake").update((draft) => {
    draft.messages.push({ id: "msg-1", content: "hello", processed: false });
  });
  const resultPromise = sdk.triggerAndWait({ workflowId: "workflow" });

  await sleep(5);

  await sdk.store(ConversationStore, "ancestor-wake").update((draft) => {
    draft.messages = [{ id: "msg-1", content: "hello", processed: true }];
  });

  await expect(resultPromise).resolves.toBe("done");
});

test("select runs against a clone so mutation cannot corrupt store state", async () => {
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "select-mutation" });

    const selected = yield* store.select("mutate-select", (state) => {
      // Mutating the selected state must not affect the stored state
      (state as ConversationState).status = "working";
      (state as ConversationState).messages.push({
        id: "rogue",
        content: "oops",
        processed: false,
      });
      return state.status;
    });

    const snapshot = yield* store.get("after-select");
    return { selected, state: snapshot.state };
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  expect(result.state).toEqual({ messages: [], status: "idle" });
});

test("take returns immediately and claims", async () => {
  const testWorkflow = workflow(async function* (step, event) {
    const store = step.store(ConversationStore, { id: "take-immediate" });

    return yield* store.take(
      "take-next",
      (s) => s.messages.find((m) => !m.claimedBy),
      (draft, msg) => {
        msg.claimedBy = event.executionId;
      }
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(ConversationStore, "take-immediate").update((draft) => {
    draft.messages.push({ id: "msg-1", content: "hello", processed: false });
  });
  const result = await sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "taker-1",
  });

  // Reference-snapshot rule: the returned value reflects the claim
  expect(result).toEqual({
    id: "msg-1",
    content: "hello",
    processed: false,
    claimedBy: "taker-1",
  });

  const snapshot = await sdk.store(ConversationStore, "take-immediate").get();
  expect(snapshot.state.messages[0]!.claimedBy).toBe("taker-1");
  expect(snapshot.version).toBe(2);
});

test("take waits then claims on external update", async () => {
  const testWorkflow = workflow(async function* (step, event) {
    const store = step.store(ConversationStore, { id: "take-wait" });

    return yield* store.take(
      "take-next",
      (s) => s.messages.find((m) => !m.claimedBy),
      (draft, msg) => {
        msg.claimedBy = event.executionId;
      }
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const resultPromise = sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "taker-1",
  });

  await sleep(5);

  await sdk.store(ConversationStore, "take-wait").update((draft) => {
    draft.messages.push({ id: "msg-1", content: "hello", processed: false });
  });

  await expect(resultPromise).resolves.toEqual({
    id: "msg-1",
    content: "hello",
    processed: false,
    claimedBy: "taker-1",
  });

  const snapshot = await sdk.store(ConversationStore, "take-wait").get();
  expect(snapshot.state.messages[0]!.claimedBy).toBe("taker-1");
});

test("two concurrent takers never claim the same item", async () => {
  const testWorkflow = workflow(async function* (step, event) {
    const store = step.store(ConversationStore, { id: "take-race" });

    return yield* store.take(
      "take-next",
      (s) => s.messages.find((m) => !m.claimedBy),
      (draft, msg) => {
        msg.claimedBy = event.executionId;
      }
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(ConversationStore, "take-race").update((draft) => {
    draft.messages.push(
      { id: "msg-1", content: "one", processed: false },
      { id: "msg-2", content: "two", processed: false }
    );
  });

  const [first, second] = await Promise.all([
    sdk.triggerAndWait({ workflowId: "workflow", executionId: "taker-a" }),
    sdk.triggerAndWait({ workflowId: "workflow", executionId: "taker-b" }),
  ]);

  expect(first.id).not.toBe(second.id);
  expect([first.id, second.id].sort()).toEqual(["msg-1", "msg-2"]);

  const snapshot = await sdk.store(ConversationStore, "take-race").get();
  const claimants = snapshot.state.messages.map((m) => m.claimedBy).sort();
  expect(claimants).toEqual(["taker-a", "taker-b"]);
});

test("take replay idempotency", async () => {
  let selectorCalls = 0;
  let claimCalls = 0;

  let runs = 0;

  const testWorkflow = workflow(async function* (step, event) {
    runs++;
    const store = step.store(ConversationStore, { id: "take-replay" });

    const taken = yield* store.take(
      "take-next",
      (s) => {
        selectorCalls++;
        return s.messages.find((m) => !m.claimedBy);
      },
      (draft, msg) => {
        claimCalls++;
        msg.claimedBy = event.executionId;
      }
    );

    yield* step.delay("replay-boundary", REPLAY_DELAY_MS);

    return taken;
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(ConversationStore, "take-replay").update((draft) => {
    draft.messages.push({ id: "msg-1", content: "hello", processed: false });
  });
  const result = await acrossReplayBoundary({
    sdk,
    executionId: "taker-1",
    delayKey: "replay-boundary",
    start: () =>
      sdk.triggerAndWait({ workflowId: "workflow", executionId: "taker-1" }),
  });

  expect(runs).toBe(2);

  expect(result).toEqual({
    id: "msg-1",
    content: "hello",
    processed: false,
    claimedBy: "taker-1",
  });
  expect(selectorCalls).toBe(1);
  expect(claimCalls).toBe(1);

  const snapshot = await sdk.store(ConversationStore, "take-replay").get();
  // A single version bump after the seed: select + claim committed atomically, once
  expect(snapshot.version).toBe(2);
});

test("claim validation failure leaves item unclaimed", async () => {
  const strictStateSchema = strictSchema<{
    messages: { id: string; claimedBy?: string }[];
  }>((val: any) => {
    if (val?.messages?.some((m: any) => m.claimedBy === 42)) {
      return "claimedBy must be a string";
    }
    return undefined;
  });

  const StrictStore = defineStore("strict-take-store", strictStateSchema, {
    initial: () => ({ messages: [] }),
  });

  const testWorkflow = workflow(async function* (step) {
    const store = step.store(StrictStore, { id: "take-invalid" });

    yield* store.take(
      "take-next",
      (s) => s.messages.find((m) => !m.claimedBy),
      (draft, msg) => {
        msg.claimedBy = 42 as any;
      }
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(StrictStore, "take-invalid").update((draft) => {
    draft.messages.push({ id: "msg-1" });
  });
  await expect(
    sdk.triggerAndWait({ workflowId: "workflow" })
  ).rejects.toThrow(/Invalid store state/);

  const snapshot = await sdk.store(StrictStore, "take-invalid").get();
  expect(snapshot.state.messages).toEqual([{ id: "msg-1" }]);
  expect(snapshot.version).toBe(1);
});

test("async claim rejected", async () => {
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "take-async-claim" });

    yield* store.take(
      "take-next",
      (s) => s.messages.find((m) => !m.claimedBy),
      (async (draft: any, msg: any) => {
        msg.claimedBy = "async";
      }) as any
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  await sdk.store(ConversationStore, "take-async-claim").update((draft) => {
    draft.messages.push({ id: "msg-1", content: "hello", processed: false });
  });
  await expect(
    sdk.triggerAndWait({ workflowId: "workflow" })
  ).rejects.toThrow(/synchronous/);

  const snapshot = await sdk.store(ConversationStore, "take-async-claim").get();
  expect(snapshot.state.messages[0]!.claimedBy).toBeUndefined();
  expect(snapshot.version).toBe(1);
});

test("store update converges exactly-once when the heap write is lost", async () => {
  let workflowUpdaterRuns = 0;

  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: "crash-gap" });

    return yield* store.update("append-once", (draft) => {
      workflowUpdaterRuns++;
      draft.messages.push({
        id: "msg-1",
        content: "hello",
        processed: false,
      });
    });
  });

  const sdk = createSdk({ workflow: testWorkflow });

  // Simulate a previous run that crashed AFTER the store commit but BEFORE
  // the heap write: the store has already applied this execution's
  // "append-once" step (recorded in the applied-steps ledger), creating the
  // store as it did, but the workflow heap has no record of it, so replay
  // cache-misses.
  const original = await sdk.storeClient.updateStore({
    definition: ConversationStore,
    id: "crash-gap",
    updater: (draft) => {
      draft.messages.push({
        id: "msg-1",
        content: "hello",
        processed: false,
      });
    },
    stepId: { executionId: "crash-replay", stepKey: "append-once" },
  });

  // Replay: the workflow runs from scratch with the same execution id
  const result = await sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "crash-replay",
  });

  // The workflow's updater never ran – the ledger returned the recorded
  // result, and the generator wrote the heap row it previously failed to
  expect(workflowUpdaterRuns).toBe(0);
  expect(result).toEqual(original);

  // The store was created once and the mutation applied once
  const snapshot = await sdk.store(ConversationStore, "crash-gap").get();
  expect(snapshot.version).toBe(1);
  expect(snapshot.state.messages).toEqual([
    { id: "msg-1", content: "hello", processed: false },
  ]);
});

test("updateFrom replay returns its committed result after the store advances", async () => {
  let updaterRuns = 0;
  let originalSnapshot: {
    state: ConversationState;
    instanceId: string;
    version: number;
  };

  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, {
      id: "conditional-crash-gap",
    });

    return yield* store.updateFrom(
      "persist-from-snapshot",
      originalSnapshot,
      (draft) => {
        updaterRuns++;
        draft.status = "working";
      }
    );
  });

  const sdk = createSdk({ workflow: testWorkflow });
  originalSnapshot = await sdk.storeClient.getStore({
    definition: ConversationStore,
    id: "conditional-crash-gap",
  });

  // Simulate the conditional store commit succeeding before the workflow
  // heap records the step result.
  const committed = await sdk.storeClient.updateStoreFrom({
    definition: ConversationStore,
    id: "conditional-crash-gap",
    snapshot: originalSnapshot,
    updater(draft) {
      draft.status = "working";
    },
    stepId: {
      executionId: "conditional-crash-replay",
      stepKey: "persist-from-snapshot",
    },
  });

  // The original snapshot is now stale. Ledger-first replay must still return
  // the committed result rather than report a conflict or run the updater.
  await sdk.storeClient.updateStore({
    definition: ConversationStore,
    id: "conditional-crash-gap",
    updater(draft) {
      draft.messages.push({
        id: "msg-after",
        content: "later",
        processed: false,
      });
    },
  });

  const replayed = await sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "conditional-crash-replay",
  });

  expect(replayed).toEqual(committed);
  expect(replayed.updated).toBe(true);
  expect(updaterRuns).toBe(0);

  const current = await sdk
    .store(ConversationStore, "conditional-crash-gap")
    .get();
  expect(current.version).toBe(2);
  expect(current.state.messages).toEqual([
    { id: "msg-after", content: "later", processed: false },
  ]);
});

test("deleteFrom replay returns its committed result without deleting a new instance", async () => {
  const executionId = "delete-crash-replay";
  const storeId = "delete-crash-gap";
  const testWorkflow = workflow(async function* (step) {
    const store = step.store(ConversationStore, { id: storeId });
    const snapshot = yield* store.get("delete-snapshot");
    return yield* store.deleteFrom("delete-store", snapshot);
  });
  const sdk = createSdk({ workflow: testWorkflow });
  const snapshot = await sdk.storeClient.getStore({
    definition: ConversationStore,
    id: storeId,
  });

  // These earlier workflow steps were durably recorded before the deletion,
  // by a delivery that held the execution's lease.
  await sdk.runtime.executions.admit({
    workflowId: "workflow",
    executionId,
    params: undefined,
    context: new Map(),
  });
  const [lease] = await sdk.runtime.executions.claimDue({
    limit: 1,
    duration: DEFAULT_LEASE_DURATION,
  });
  await sdk.heapClient.writeStep({
    lease,
    stepKey: "delete-snapshot",
    stepAttempt: 0,
    done: true,
    stepResponseJson: JSON.stringify({
      type: "step-result",
      result: snapshot,
    }),
  });

  const committed = await sdk.storeClient.deleteStoreFrom({
    definition: ConversationStore,
    id: storeId,
    snapshot,
    stepId: { executionId, stepKey: "delete-store" },
  });
  expect(committed).toEqual({ deleted: true });

  const recreated = await sdk.storeClient.getStore({
    definition: ConversationStore,
    id: storeId,
  });
  expect(recreated.instanceId).not.toBe(snapshot.instanceId);

  // End that delivery before it records the deletion; the next one replays.
  await sdk.runtime.executions.acknowledge({
    lease,
    outcome: { status: "suspended", wakeAt: sdk.runtime.clock() },
  });
  sdk.dispatcher.start();
  const replayed = await waitForExecutionOutcome(sdk.runtime.executions, executionId, {
    pollInterval: 1,
  });
  expect(replayed).toEqual({ status: "completed", result: { deleted: true } });
  expect(await sdk.storeClient.getStore({
    definition: ConversationStore,
    id: storeId,
  })).toEqual(recreated);
});

type Task = { id: string; title: string };
type ProjectState = { projectId: string; tasks: Task[] };

let projectInitialCalls = 0;
const ProjectStore = defineStore("project", testSchema<ProjectState>(), {
  initial: (projectId) => {
    projectInitialCalls++;
    return { projectId, tasks: [] };
  },
});

async function* addTask(step: StepRunner, projectId: string, task: Task) {
  const project = step.store(ProjectStore, { id: projectId });
  return yield* project.update(`add:${task.id}`, (draft) => {
    draft.tasks.push(task);
  });
}

test("step.store returns a handle without recording a step or touching the store", async () => {
  const testWorkflow = workflow(async function* (step) {
    const first = step.store(ConversationStore, { id: "handle-only" });
    const second = step.store(ConversationStore, { id: "handle-only" });
    const local = step.store(ConversationStore);
    // @ts-expect-error initial is declared on the store definition, not here
    step.store(ConversationStore, { id: "handle-only", initial: { messages: [], status: "idle" } });
    return {
      first: first.key,
      second: second.key,
      local: local.key,
      definition: first.definition === ConversationStore,
    };
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({
    workflowId: "workflow",
    executionId: "handles",
  });

  expect(result).toEqual({
    first: { storeName: "conversation", storeId: "handle-only" },
    second: { storeName: "conversation", storeId: "handle-only" },
    local: { storeName: "conversation", storeId: "handles" },
    definition: true,
  });
  expect(await sdk.storeClient.listStores(ConversationStore)).toEqual([]);
  expect(Object.keys(sdk.heapClient.cache)).toEqual([
    `handles:${WORKFLOW_RESULT_STEP_KEY}`,
  ]);
});

test("a loop and a helper reopen the same store handle and the first operation creates it", async () => {
  projectInitialCalls = 0;
  let runs = 0;
  const tasks: Task[] = [
    { id: "a", title: "Plan" },
    { id: "b", title: "Build" },
    { id: "c", title: "Ship" },
  ];
  const testWorkflow = workflow(async function* (step) {
    runs++;
    const counts: number[] = [];
    for (const task of tasks) {
      const project = step.store(ProjectStore, { id: "p1" });
      counts.push(yield* project.select(`count:${task.id}`, (state) => state.tasks.length));
      yield* addTask(step, "p1", task);
    }

    yield* step.delay("replay-boundary", REPLAY_DELAY_MS);

    const final = yield* step.store(ProjectStore, { id: "p1" }).get("final");
    return { counts, final };
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const executionId = "reentrant-handles";
  const result = await acrossReplayBoundary({
    sdk,
    executionId,
    delayKey: "replay-boundary",
    start: () => sdk.triggerAndWait({ workflowId: "workflow", executionId }),
  });

  expect(runs).toBe(2);
  expect(result.counts).toEqual([0, 1, 2]);
  expect(result.final).toMatchObject({
    state: { projectId: "p1", tasks },
    version: 3,
  });
  expect(projectInitialCalls).toBe(1);
});

test("two executions updating one missing store record one initial state and both updates", async () => {
  const testWorkflow = workflow(async function* (step, event) {
    return yield* addTask(step, "p-shared", {
      id: event.executionId,
      title: event.executionId,
    });
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const [first, second] = await Promise.all([
    sdk.triggerAndWait({ workflowId: "workflow", executionId: "writer-a" }),
    sdk.triggerAndWait({ workflowId: "workflow", executionId: "writer-b" }),
  ]);

  expect([first.previousVersion, second.previousVersion].sort()).toEqual([0, 1]);
  const snapshot = await sdk.store(ProjectStore, "p-shared").get();
  expect(snapshot.version).toBe(2);
  expect(snapshot.state.projectId).toBe("p-shared");
  expect(snapshot.state.tasks.map((task) => task.id).sort()).toEqual([
    "writer-a",
    "writer-b",
  ]);
});

test("a store deleted between deliveries is created again from initial by the next operation", async () => {
  const testWorkflow = workflow(async function* (step) {
    yield* addTask(step, "p-deleted", { id: "a", title: "Plan" });
    const before = yield* step.store(ProjectStore, { id: "p-deleted" }).get("before");

    yield* step.delay("replay-boundary", REPLAY_DELAY_MS);

    yield* addTask(step, "p-deleted", { id: "b", title: "Build" });
    const after = yield* step.store(ProjectStore, { id: "p-deleted" }).get("after");
    return { before, after };
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const executionId = "deleted-between-deliveries";
  const result = await acrossReplayBoundary({
    sdk,
    executionId,
    delayKey: "replay-boundary",
    start: () => sdk.triggerAndWait({ workflowId: "workflow", executionId }),
    beforeReplay: () =>
      sdk.storeClient.deleteStore({ definition: ProjectStore, id: "p-deleted" }),
  });

  expect(result.before).toMatchObject({
    state: { projectId: "p-deleted", tasks: [{ id: "a", title: "Plan" }] },
    version: 1,
  });
  expect(result.after).toMatchObject({
    state: { projectId: "p-deleted", tasks: [{ id: "b", title: "Build" }] },
    version: 1,
  });
  expect(result.after.instanceId).not.toBe(result.before.instanceId);
});

test("an initial state that throws reaches workflow code from every operation", async () => {
  const UnseededStore = defineStore("unseeded", testSchema<{ n: number }>(), {
    initial: (id) => {
      throw new Error(`no seed for ${id}`);
    },
  });
  let runs = 0;
  const testWorkflow = workflow(async function* (step) {
    runs++;
    const store = step.store(UnseededStore, { id: "u1" });
    const operations = {
      get: () => store.get("get"),
      select: () => store.select("select", (state) => state.n),
      update: () => store.update("update", (draft) => void draft.n++),
      when: () => store.when("when", (state) => state.n > 0),
      take: () => store.take("take", (state) => state.n > 0, (draft) => void draft.n--),
    };
    const errors: Record<string, string> = {};
    for (const [name, operation] of Object.entries(operations)) {
      try {
        yield* operation();
      } catch (err) {
        errors[name] = (err as Error).message;
      }
    }
    return errors;
  });

  const sdk = createSdk({ workflow: testWorkflow });
  const result = await sdk.triggerAndWait({ workflowId: "workflow" });

  expect(runs).toBe(1);
  expect(result).toEqual({
    get: "no seed for u1",
    select: "no seed for u1",
    update: "no seed for u1",
    when: "no seed for u1",
    take: "no seed for u1",
  });
  expect(await sdk.storeClient.listStores(UnseededStore)).toEqual([]);
});

function strictSchema<T>(validator: (v: unknown) => string | undefined): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "yieldstar-test",
      validate(value) {
        const error = validator(value);
        if (error) {
          return { issues: [{ message: error }] };
        }
        return { value: value as T };
      },
    },
  };
}
