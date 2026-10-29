import {
  defineStore,
  type Runtime,
  type StandardSchemaV1,
  type StorePath,
  type StoreWaiter,
} from "@yieldstar/core";
import { describe, expect, test } from "vitest";

/**
 * A clean runtime under test. Store wakes are observed through its
 * `ExecutionClient`: a commit that satisfies a waiter makes the waiter's
 * execution due, so `runtime.executions.claimDue()` returns it.
 */
export type StoreConformanceHarness = {
  runtime: Runtime;
  /** Creates another runtime connected to the same backend. */
  createPeer?(): Runtime | Promise<Runtime>;
  /** Simulates opening the same durable backend in a new process. */
  restart?(): Runtime | Promise<Runtime>;
  dispose?(): void | Promise<void>;
};

export type StoreConformanceFactory = () =>
  | StoreConformanceHarness
  | Promise<StoreConformanceHarness>;

export type StoreConformanceOptions = {
  name: string;
  create: StoreConformanceFactory;
};

type State = {
  messages: { id: string }[];
  unrelated?: number;
};

type TakeState = {
  messages: { id: string; claimedBy?: string }[];
};

const WORKFLOW_ID = "workflow";
const STEP_KEY = "wait";

function schema<T>(): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "yieldstar-conformance",
      validate(value) {
        return { value: value as T };
      },
    },
  };
}

function waiter(
  storeName: string,
  storeId: string,
  instanceId: string,
  sinceVersion: number,
  readPaths: StorePath[] = [["messages"]],
  executionId = "execution"
): StoreWaiter {
  return {
    workflowId: WORKFLOW_ID,
    executionId,
    stepKey: STEP_KEY,
    storeName,
    storeId,
    instanceId,
    sinceVersion,
    readPaths,
  };
}

/**
 * Admits executions and acknowledges their admission deliveries as suspended,
 * so they are waiting and nothing is due.
 */
async function admitWaiting(runtime: Runtime, ...executionIds: string[]) {
  for (const executionId of executionIds) {
    const admitted = await runtime.executions.admit({
      executionId,
      workflowId: WORKFLOW_ID,
      params: undefined,
      context: new Map(),
    });
    if (admitted.status !== "accepted") {
      throw new Error(`admission of "${executionId}" was rejected: ${admitted.message}`);
    }
  }
  const woken = await drainWakes(runtime);
  expect(woken).toEqual([...new Set(executionIds)].sort());
}

/**
 * Claims every due execution, acknowledges each delivery as suspended, and
 * returns their sorted IDs. Each ID appears at most once per claim.
 */
async function drainWakes(runtime: Runtime): Promise<string[]> {
  const deliveries = await runtime.executions.claimDue();
  for (const delivery of deliveries) {
    await runtime.executions.acknowledge({ delivery, outcome: { status: "suspended" } });
  }
  return deliveries.map((delivery) => delivery.executionId).sort();
}

/**
 * Waits until exactly `expected` executions have been woken. A runtime may
 * apply commit wakes through an outbox, so they are applied eventually; each
 * execution must still be delivered once.
 */
async function expectWoken(runtime: Runtime, expected: string[]) {
  const woken: string[] = [];
  const want = [...expected].sort();
  for (let attempt = 0; attempt < 100; attempt++) {
    woken.push(...(await drainWakes(runtime)));
    if (woken.length >= want.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(woken.sort()).toEqual(want);
}

/** Asserts that nothing is due, allowing an outbox a moment to apply. */
async function expectNotWoken(runtime: Runtime) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await drainWakes(runtime)).toEqual([]);
}

/** Records a step's result, which deletes that step's waiter. */
async function recordStep(runtime: Runtime, executionId: string, stepKey = STEP_KEY) {
  await runtime.heap.writeStep({
    executionId,
    stepKey,
    stepAttempt: 1,
    stepDone: true,
    stepResponseJson: JSON.stringify({ done: true }),
  });
}

/** Registers the normative YieldStar store connector qualification suite. */
export function registerStoreClientConformance({
  name,
  create,
}: StoreConformanceOptions): void {
  const Store = defineStore(`${name}-store-conformance`, schema<State>());
  const TakeStore = defineStore(`${name}-take-conformance`, schema<TakeState>());

  describe(`${name} store connector conformance`, () => {
    test("creates, reads, lists, deletes, and recreates logical stores", async () => {
      const harness = await create();
      const OtherStore = defineStore(`${name}-other-conformance`, schema<State>());
      try {
        const first = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "b",
          initial: { messages: [] },
        });
        const second = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "a",
          initial: { messages: [] },
        });
        await harness.runtime.stores.getOrCreateStore({
          definition: OtherStore,
          id: "a",
          initial: { messages: [] },
        });

        expect(first.instanceId).toMatch(/^[0-9a-f-]+$/);
        expect(second.instanceId).not.toBe(first.instanceId);
        expect(await harness.runtime.stores.listStores(Store)).toEqual(["a", "b"]);
        await harness.runtime.stores.deleteStore({ definition: Store, id: "b" });
        expect(await harness.runtime.stores.listStores(Store)).toEqual(["a"]);
        await expect(
          harness.runtime.stores.getStore({ definition: Store, id: "b" })
        ).rejects.toThrow(/does not exist/);
        const recreated = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "b",
          initial: { messages: [] },
        });
        expect(recreated.instanceId).not.toBe(first.instanceId);
        await harness.runtime.stores.deleteStore({ definition: Store, id: "missing" });
      } finally {
        await harness.dispose?.();
      }
    });

    test("rejects asynchronous updaters and claims without committing", async () => {
      const harness = await create();
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: TakeStore,
          id: "sync-callbacks",
          initial: { messages: [{ id: "one" }] },
        });
        await expect(
          harness.runtime.stores.updateStore({
            definition: TakeStore,
            id: "sync-callbacks",
            updater: (async (draft: TakeState) => {
              draft.messages.push({ id: "two" });
            }) as never,
          })
        ).rejects.toThrow(/synchronous/);
        await expect(
          harness.runtime.stores.takeFromStore({
            definition: TakeStore,
            id: "sync-callbacks",
            selector: (state) => state.messages[0],
            claim: (async (_draft: TakeState, selected: { claimedBy?: string }) => {
              selected.claimedBy = "worker";
            }) as never,
          })
        ).rejects.toThrow(/synchronous/);
        expect(
          await harness.runtime.stores.getStore({ definition: TakeStore, id: "sync-callbacks" })
        ).toMatchObject({ state: { messages: [{ id: "one" }] }, version: 0 });
      } finally {
        await harness.dispose?.();
      }
    });

    test("retries an updater after an interleaved CAS conflict", async () => {
      let validations = 0;
      let racing = false;
      let release!: () => void;
      const bothPrepared = new Promise<void>((resolve) => {
        release = resolve;
      });
      const raceSchema: StandardSchemaV1<unknown, { messages: string[] }> = {
        "~standard": {
          version: 1 as const,
          vendor: "yieldstar-conformance",
          async validate(value: unknown) {
            if (!racing) return { value: value as { messages: string[] } };
            validations++;
            if (validations === 2) release();
            if (validations <= 2) await bothPrepared;
            return { value: value as { messages: string[] } };
          },
        },
      };
      const RaceStore = defineStore(`${name}-cas-race-conformance`, raceSchema);
      const harness = await create();
      let updaterRuns = 0;
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: RaceStore,
          id: "race",
          initial: { messages: [] },
        });
        racing = true;
        validations = 0;
        const results = await Promise.all(
          ["a", "b"].map((id) =>
            harness.runtime.stores.updateStore({
              definition: RaceStore,
              id: "race",
              updater(draft) {
                updaterRuns++;
                draft.messages.push(id);
              },
            })
          )
        );
        expect(updaterRuns).toBe(3);
        expect(results.map((result) => result.version).sort()).toEqual([1, 2]);
        const final = await harness.runtime.stores.getStore({ definition: RaceStore, id: "race" });
        expect(final).toMatchObject({ state: { messages: ["a", "b"] }, version: 2 });
      } finally {
        await harness.dispose?.();
      }
    });

    test("makes a step receipt and mutation exactly-once under concurrent replay", async () => {
      const harness = await create();
      let updaterRuns = 0;
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "receipt-race",
          initial: { messages: [] },
        });
        const results = await Promise.all(
          ["a", "b"].map((id) =>
            harness.runtime.stores.updateStore({
              definition: Store,
              id: "receipt-race",
              stepId: { executionId: "producer", stepKey: "append" },
              updater(draft) {
                updaterRuns++;
                draft.messages.push({ id });
              },
            })
          )
        );
        expect(results[1]).toEqual(results[0]);
        expect(updaterRuns).toBeGreaterThanOrEqual(1);
        expect(updaterRuns).toBeLessThanOrEqual(2);
        expect(
          await harness.runtime.stores.getStore({ definition: Store, id: "receipt-race" })
        ).toMatchObject({ state: { messages: [{ id: results[0].state.messages[0].id }] }, version: 1 });
        let replayRuns = 0;
        expect(
          await harness.runtime.stores.updateStore({
            definition: Store,
            id: "receipt-race",
            stepId: { executionId: "producer", stepKey: "append" },
            updater() {
              replayRuns++;
            },
          })
        ).toEqual(results[0]);
        expect(replayRuns).toBe(0);

        await harness.runtime.stores.deleteStore({ definition: Store, id: "receipt-race" });
        const recreated = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "receipt-race",
          initial: { messages: [] },
        });
        expect(
          await harness.runtime.stores.updateStore({
            definition: Store,
            id: "receipt-race",
            stepId: { executionId: "producer", stepKey: "append" },
            updater() { replayRuns++; },
          })
        ).toEqual(results[0]);
        expect(replayRuns).toBe(0);
        expect(await harness.runtime.stores.getStore({ definition: Store, id: "receipt-race" })).toEqual(recreated);
      } finally {
        await harness.dispose?.();
      }
    });

    test("scopes receipts by execution and step key", async () => {
      const harness = await create();
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "receipt-scope",
          initial: { messages: [] },
        });
        for (const [executionId, stepKey] of [["one", "a"], ["one", "b"], ["two", "a"]]) {
          await harness.runtime.stores.updateStore({
            definition: Store,
            id: "receipt-scope",
            stepId: { executionId, stepKey },
            updater(draft) {
              draft.messages.push({ id: `${executionId}:${stepKey}` });
            },
          });
        }
        expect(
          await harness.runtime.stores.getStore({ definition: Store, id: "receipt-scope" })
        ).toMatchObject({
          state: { messages: [{ id: "one:a" }, { id: "one:b" }, { id: "two:a" }] },
          version: 3,
        });
      } finally {
        await harness.dispose?.();
      }
    });

    test("applies calls without step ids independently and returns detached state", async () => {
      const harness = await create();
      try {
        const initial = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "external-update",
          initial: { messages: [] },
        });
        initial.state.messages.push({ id: "caller-only" });
        for (const id of ["one", "two"]) {
          const result = await harness.runtime.stores.updateStore({
            definition: Store,
            id: "external-update",
            updater(draft) { draft.messages.push({ id }); },
          });
          result.state.messages.push({ id: "result-only" });
        }
        expect(
          await harness.runtime.stores.getStore({ definition: Store, id: "external-update" })
        ).toMatchObject({ state: { messages: [{ id: "one" }, { id: "two" }] }, version: 2 });
      } finally {
        await harness.dispose?.();
      }
    });

    test("committed state contains no tracking proxies", async () => {
      const harness = await create();
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "plain-state",
          initial: { messages: [{ id: "one" }] },
        });
        await harness.runtime.stores.updateStore({
          definition: Store,
          id: "plain-state",
          updater(draft) {
            (draft as Record<string, unknown>).lastMessage = draft.messages[0];
            (draft as Record<string, unknown>).wrapped = { inner: draft.messages };
          },
        });
        const snapshot = await harness.runtime.stores.getStore({ definition: Store, id: "plain-state" });
        expect(() => structuredClone(snapshot.state)).not.toThrow();
        expect((snapshot.state as unknown as Record<string, unknown>).lastMessage).toEqual({ id: "one" });
        expect((snapshot.state as unknown as Record<string, unknown>).wrapped).toEqual({
          inner: [{ id: "one" }],
        });
      } finally {
        await harness.dispose?.();
      }
    });

    test("mutating updates do not deep-diff the full state", async () => {
      type PerformanceState = {
        changed: number;
        large: Record<string, number>;
      };
      const PerformanceStore = defineStore(
        `${name}-bounded-update-conformance`,
        schema<PerformanceState>()
      );
      const harness = await create();
      const size = 1000;
      const large = Object.fromEntries(
        Array.from({ length: size }, (_, index) => [`key-${index}`, index])
      );
      const instrument = () => {
        let reads = 0;
        const value = new Proxy(large, {
          get(target, property, receiver) {
            if (typeof property === "string" && property.startsWith("key-")) reads++;
            return Reflect.get(target, property, receiver);
          },
        });
        return { value, reads: () => reads };
      };
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: PerformanceStore,
          id: "mutating",
          initial: { changed: 0, large: {} },
        });
        const mutating = instrument();
        await harness.runtime.stores.updateStore({
          definition: PerformanceStore,
          id: "mutating",
          updater(draft) {
            draft.changed = 1;
            draft.large = mutating.value;
          },
        });

        await harness.runtime.stores.getOrCreateStore({
          definition: PerformanceStore,
          id: "replacement",
          initial: { changed: 0, large: {} },
        });
        const replacement = instrument();
        await harness.runtime.stores.updateStore({
          definition: PerformanceStore,
          id: "replacement",
          updater: () => ({ changed: 1, large: replacement.value }),
        });

        expect(replacement.reads() - mutating.reads()).toBeGreaterThanOrEqual(size);
      } finally {
        await harness.dispose?.();
      }
    });

    test("conditional updates conflict and replay ledger-first", async () => {
      const harness = await create();
      let updaterRuns = 0;
      try {
        const snapshot = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "conditional",
          initial: { messages: [] },
        });
        const stepId = { executionId: "execution", stepKey: "conditional" };
        const committed = await harness.runtime.stores.updateStoreFrom({
          definition: Store,
          id: "conditional",
          snapshot,
          stepId,
          updater(draft) {
            updaterRuns++;
            draft.messages.push({ id: "first" });
          },
        });
        await harness.runtime.stores.updateStore({
          definition: Store,
          id: "conditional",
          updater(draft) {
            draft.messages.push({ id: "second" });
          },
        });
        expect(
          await harness.runtime.stores.updateStoreFrom({
            definition: Store,
            id: "conditional",
            snapshot: { ...snapshot, instanceId: "" },
            stepId,
            updater() {
              updaterRuns++;
            },
          })
        ).toEqual(committed);
        expect(updaterRuns).toBe(1);
        expect(
          await harness.runtime.stores.updateStoreFrom({
            definition: Store,
            id: "conditional",
            snapshot,
            updater() {
              updaterRuns++;
            },
          })
        ).toMatchObject({ updated: false, expectedVersion: 0, actualVersion: 2 });
        expect(updaterRuns).toBe(1);
        await expect(
          harness.runtime.stores.updateStoreFrom({
            definition: Store,
            id: "conditional",
            snapshot: { ...snapshot, instanceId: "" },
            updater() {},
          })
        ).rejects.toThrow(/missing instanceId/);
      } finally {
        await harness.dispose?.();
      }
    });

    test("claims distinct values and records only matched takes", async () => {
      const harness = await create();
      let selectorRuns = 0;
      let claimRuns = 0;
      try {
        await harness.runtime.stores.getOrCreateStore({
          definition: TakeStore,
          id: "take",
          initial: { messages: [{ id: "one" }, { id: "two" }] },
        });
        const take = (worker: string, stepKey: string) =>
          harness.runtime.stores.takeFromStore({
            definition: TakeStore,
            id: "take",
            stepId: { executionId: "execution", stepKey },
            selector: (state) => {
              selectorRuns++;
              return state.messages.find((message) => !message.claimedBy);
            },
            claim: (_draft, selected) => {
              claimRuns++;
              selected.claimedBy = worker;
            },
          });
        const [first, second] = await Promise.all([take("a", "a"), take("b", "b")]);
        if (!first.matched || !second.matched) throw new Error("both takes must match");
        expect(first.selected.id).not.toBe(second.selected.id);
        expect([first.version, second.version].sort()).toEqual([1, 2]);
        const selectorRunsAfterCommit = selectorRuns;
        const claimRunsAfterCommit = claimRuns;
        expect(await take("ignored", "a")).toEqual(first);
        expect(selectorRuns).toBe(selectorRunsAfterCommit);
        expect(claimRuns).toBe(claimRunsAfterCommit);
        expect(
          await harness.runtime.stores.getStore({ definition: TakeStore, id: "take" })
        ).toMatchObject({ version: 2 });

        const miss = await harness.runtime.stores.takeFromStore({
          definition: TakeStore,
          id: "take",
          stepId: { executionId: "execution", stepKey: "later" },
          selector: (state) => state.messages.find((message) => !message.claimedBy),
          claim() {},
        });
        if (miss.matched) throw new Error("take must not match");
        expect(miss.version).toBe(2);
        expect(miss.readPaths).toContainEqual(["messages"]);
        await harness.runtime.stores.updateStore({
          definition: TakeStore,
          id: "take",
          updater(draft) {
            draft.messages.push({ id: "three" });
          },
        });
        expect(
          await harness.runtime.stores.takeFromStore({
            definition: TakeStore,
            id: "take",
            stepId: { executionId: "execution", stepKey: "later" },
            selector: (state) => state.messages.find((message) => !message.claimedBy),
            claim: (_draft, selected) => {
              selected.claimedBy = "c";
            },
          })
        ).toMatchObject({ matched: true });
      } finally {
        await harness.dispose?.();
      }
    });

    test("protects recreated stores during conditional deletion and replays the receipt", async () => {
      const harness = await create();
      try {
        const original = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "delete",
          initial: { messages: [] },
        });
        await harness.runtime.stores.updateStore({
          definition: Store,
          id: "delete",
          updater(draft) {
            draft.messages.push({ id: "changed" });
          },
        });
        expect(
          await harness.runtime.stores.deleteStoreFrom({ definition: Store, id: "delete", snapshot: original })
        ).toMatchObject({ deleted: false, reason: "conflict" });
        const current = await harness.runtime.stores.getStore({ definition: Store, id: "delete" });
        const stepId = { executionId: "execution", stepKey: "delete" };
        expect(
          await harness.runtime.stores.deleteStoreFrom({ definition: Store, id: "delete", snapshot: current, stepId })
        ).toEqual({ deleted: true });
        const recreated = await harness.runtime.stores.getOrCreateStore({
          definition: Store,
          id: "delete",
          initial: { messages: [] },
        });
        expect(recreated.instanceId).not.toBe(original.instanceId);
        expect(
          await harness.runtime.stores.deleteStoreFrom({ definition: Store, id: "delete", snapshot: current, stepId })
        ).toEqual({ deleted: true });
        expect(await harness.runtime.stores.getStore({ definition: Store, id: "delete" })).toEqual(recreated);
      } finally {
        await harness.dispose?.();
      }
    });
    test("wakes an intersecting waiter's execution and keeps the waiter until its step is recorded", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "execution");
        const initial = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "selective-wake",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "selective-wake", initial.instanceId, initial.version)
        );
        await expectNotWoken(runtime);
        await runtime.stores.updateStore({
          definition: Store,
          id: "selective-wake",
          updater(draft) { draft.unrelated = 1; },
        });
        await expectNotWoken(runtime);
        await runtime.stores.updateStore({
          definition: Store,
          id: "selective-wake",
          updater(draft) { draft.messages.push({ id: "ready" }); },
        });
        await expectWoken(runtime, ["execution"]);

        // The wake did not consume the waiter: its step has not recorded a result.
        await runtime.stores.updateStore({
          definition: Store,
          id: "selective-wake",
          updater(draft) { draft.messages.push({ id: "again" }); },
        });
        await expectWoken(runtime, ["execution"]);

        // Recording another step's result leaves the waiter in place.
        await recordStep(runtime, "execution", "some-other-step");
        await runtime.stores.updateStore({
          definition: Store,
          id: "selective-wake",
          updater(draft) { draft.messages.push({ id: "third" }); },
        });
        await expectWoken(runtime, ["execution"]);

        // Recording the waiter's own step deletes it.
        await recordStep(runtime, "execution");
        await runtime.stores.updateStore({
          definition: Store,
          id: "selective-wake",
          updater(draft) { draft.messages.push({ id: "after-step" }); },
        });
        await expectNotWoken(runtime);
      } finally {
        await harness.dispose?.();
      }
    });

    test("collapses the wakes of many commits and waiters into one due execution", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "collapsed", "bystander");
        for (const id of ["collapse-a", "collapse-b"]) {
          const snapshot = await runtime.stores.getOrCreateStore({
            definition: Store,
            id,
            initial: { messages: [] },
          });
          await runtime.stores.registerWaiter({
            ...waiter(Store.name, id, snapshot.instanceId, snapshot.version),
            executionId: "collapsed",
            stepKey: `wait-${id}`,
          });
        }
        const shared = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "collapse-shared",
          initial: { messages: [] },
        });
        for (const executionId of ["collapsed", "bystander"]) {
          await runtime.stores.registerWaiter(
            waiter(Store.name, "collapse-shared", shared.instanceId, shared.version, [["messages"]], executionId)
          );
        }
        for (const id of ["collapse-a", "collapse-b", "collapse-a", "collapse-shared"]) {
          await runtime.stores.updateStore({
            definition: Store,
            id,
            updater(draft) { draft.messages.push({ id: "ready" }); },
          });
        }
        await expectWoken(runtime, ["bystander", "collapsed"]);
        await expectNotWoken(runtime);
      } finally {
        await harness.dispose?.();
      }
    });

    test("ignores wakes for executions without a record or with a terminal outcome", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await runtime.executions.admit({
          executionId: "finished",
          workflowId: WORKFLOW_ID,
          params: undefined,
          context: new Map(),
        });
        const [delivery] = await runtime.executions.claimDue();
        await runtime.executions.acknowledge({
          delivery,
          outcome: { status: "completed", result: "done" },
        });
        const initial = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "orphan-wake",
          initial: { messages: [] },
        });
        for (const executionId of ["unknown", "finished"]) {
          await runtime.stores.registerWaiter(
            waiter(Store.name, "orphan-wake", initial.instanceId, initial.version, [["messages"]], executionId)
          );
        }
        const committed = await runtime.stores.updateStore({
          definition: Store,
          id: "orphan-wake",
          updater(draft) { draft.messages.push({ id: "ready" }); },
        });
        expect(committed.version).toBe(1);
        await expectNotWoken(runtime);
        expect(await runtime.executions.get("unknown")).toBeUndefined();
        expect(await runtime.executions.get("finished")).toMatchObject({
          status: "completed",
          outcome: { status: "completed", result: "done" },
        });
      } finally {
        await harness.dispose?.();
      }
    });

    test("deleteStore purges the store's waiters", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "execution");
        const original = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "deleted-waiters",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "deleted-waiters", original.instanceId, original.version)
        );
        await runtime.stores.deleteStore({ definition: Store, id: "deleted-waiters" });
        const recreated = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "deleted-waiters",
          initial: { messages: [] },
        });
        expect(recreated.instanceId).not.toBe(original.instanceId);
        await runtime.stores.updateStore({
          definition: Store,
          id: "deleted-waiters",
          updater(draft) { draft.messages.push({ id: "new-instance" }); },
        });
        await expectNotWoken(runtime);

        // A waiter registered on the new instance is woken by it.
        const current = await runtime.stores.getStore({ definition: Store, id: "deleted-waiters" });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "deleted-waiters", current.instanceId, current.version)
        );
        await runtime.stores.updateStore({
          definition: Store,
          id: "deleted-waiters",
          updater(draft) { draft.messages.push({ id: "again" }); },
        });
        await expectWoken(runtime, ["execution"]);
      } finally {
        await harness.dispose?.();
      }
    });

    test("conditional deletion purges the store's waiters", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "execution");
        const initial = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "conditional-delete-wake",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "conditional-delete-wake", initial.instanceId, initial.version)
        );
        await runtime.stores.updateStore({
          definition: Store,
          id: "conditional-delete-wake",
          updater(draft) { draft.messages.push({ id: "old" }); },
        });
        // A wake requested before deletion stays requested.
        await expectWoken(runtime, ["execution"]);
        const current = await runtime.stores.getStore({
          definition: Store,
          id: "conditional-delete-wake",
        });
        expect(
          await runtime.stores.deleteStoreFrom({
            definition: Store,
            id: "conditional-delete-wake",
            snapshot: current,
          })
        ).toEqual({ deleted: true });
        await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "conditional-delete-wake",
          initial: { messages: [] },
        });
        await runtime.stores.updateStore({
          definition: Store,
          id: "conditional-delete-wake",
          updater(draft) { draft.messages.push({ id: "new" }); },
        });
        await expectNotWoken(runtime);
      } finally {
        await harness.dispose?.();
      }
    });

    test("wakes for replacement, take-claim, and shifted-array paths", async () => {
      type QueueState = { messages: { id: string; claimedBy?: string }[] };
      const QueueStore = defineStore(`${name}-wake-paths-conformance`, schema<QueueState>());
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "replacement", "claim", "splice");
        const replacement = await runtime.stores.getOrCreateStore({
          definition: QueueStore,
          id: "replacement",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter(QueueStore.name, "replacement", replacement.instanceId, replacement.version, [["messages"]], "replacement")
        );
        await runtime.stores.updateStore({
          definition: QueueStore,
          id: "replacement",
          updater: () => ({ messages: [{ id: "ready" }] }),
        });
        await expectWoken(runtime, ["replacement"]);

        const claim = await runtime.stores.getOrCreateStore({
          definition: QueueStore,
          id: "claim",
          initial: { messages: [{ id: "one" }] },
        });
        await runtime.stores.registerWaiter(
          waiter(QueueStore.name, "claim", claim.instanceId, claim.version, [["messages", 0, "claimedBy"]], "claim")
        );
        const claimed = await runtime.stores.takeFromStore({
          definition: QueueStore,
          id: "claim",
          selector: (state) => state.messages[0],
          claim: (_draft, selected) => { selected.claimedBy = "worker"; },
        });
        if (!claimed.matched) throw new Error("take must match");
        expect(claimed.selected).toEqual({ id: "one", claimedBy: "worker" });
        await expectWoken(runtime, ["claim"]);

        const splice = await runtime.stores.getOrCreateStore({
          definition: QueueStore,
          id: "splice",
          initial: { messages: [{ id: "one" }, { id: "two" }] },
        });
        await runtime.stores.registerWaiter(
          waiter(QueueStore.name, "splice", splice.instanceId, splice.version, [["messages", 0, "id"]], "splice")
        );
        await runtime.stores.takeFromStore({
          definition: QueueStore,
          id: "splice",
          selector: (state) => state.messages[0],
          claim: (draft) => { draft.messages.splice(0, 1); },
        });
        await expectWoken(runtime, ["splice"]);
        expect(
          await runtime.stores.getStore({ definition: QueueStore, id: "splice" })
        ).toMatchObject({ state: { messages: [{ id: "two" }] }, version: 1 });
      } finally {
        await harness.dispose?.();
      }
    });

    test("immediately wakes a stale registration", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "behind", "replaced", "missing");
        const initial = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "stale-registration",
          initial: { messages: [] },
        });
        await runtime.stores.updateStore({
          definition: Store,
          id: "stale-registration",
          updater(draft) { draft.messages.push({ id: "first" }); },
        });
        // Observed an older version.
        await runtime.stores.registerWaiter(
          waiter(Store.name, "stale-registration", initial.instanceId, initial.version, [["messages"]], "behind")
        );
        await expectWoken(runtime, ["behind"]);

        // Observed an instance that has since been deleted and recreated.
        const original = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "stale-instance",
          initial: { messages: [] },
        });
        await runtime.stores.deleteStore({ definition: Store, id: "stale-instance" });
        await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "stale-instance",
          initial: { messages: [] },
        });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "stale-instance", original.instanceId, original.version, [["messages"]], "replaced")
        );
        await expectWoken(runtime, ["replaced"]);

        // Observed a store that no longer exists.
        const gone = await runtime.stores.getOrCreateStore({
          definition: Store,
          id: "stale-missing",
          initial: { messages: [] },
        });
        await runtime.stores.deleteStore({ definition: Store, id: "stale-missing" });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "stale-missing", gone.instanceId, gone.version, [["messages"]], "missing")
        );
        await expectWoken(runtime, ["missing"]);
      } finally {
        await harness.dispose?.();
      }
    });

    test("does not lose a waiter registration racing a commit", async () => {
      const harness = await create();
      const { runtime } = harness;
      const executionIds = Array.from({ length: 10 }, (_, index) => `registration-race-${index}`);
      try {
        await admitWaiting(runtime, ...executionIds);
        for (const [index, id] of executionIds.entries()) {
          const initial = await runtime.stores.getOrCreateStore({
            definition: Store,
            id,
            initial: { messages: [] },
          });
          const register = () =>
            runtime.stores.registerWaiter(
              waiter(Store.name, id, initial.instanceId, initial.version, [["messages"]], id)
            );
          const update = () =>
            runtime.stores.updateStore({
              definition: Store,
              id,
              updater(draft) { draft.messages.push({ id: "ready" }); },
            });
          await Promise.all(index % 2 === 0 ? [register(), update()] : [update(), register()]);
        }
        await expectWoken(runtime, executionIds);
      } finally {
        await harness.dispose?.();
      }
    });

    test("qualifies declared shared-client capabilities", async () => {
      const harness = await create();
      try {
        if (!harness.createPeer) return;
        const primary = harness.runtime;
        const peer = await harness.createPeer();
        await primary.stores.getOrCreateStore({
          definition: Store,
          id: "shared-client",
          initial: { messages: [] },
        });
        const results = await Promise.all([
          primary.stores.updateStore({
            definition: Store,
            id: "shared-client",
            updater(draft) { draft.messages.push({ id: "a" }); },
          }),
          peer.stores.updateStore({
            definition: Store,
            id: "shared-client",
            updater(draft) { draft.messages.push({ id: "b" }); },
          }),
        ]);
        expect(results.map((result) => result.version).sort()).toEqual([1, 2]);

        // A waiter registered through one client is woken by a commit through
        // another, and the wake is visible to every client.
        await admitWaiting(primary, "shared-wake");
        const wakeInitial = await peer.stores.getOrCreateStore({
          definition: Store,
          id: "shared-wake",
          initial: { messages: [] },
        });
        await peer.stores.registerWaiter(
          waiter(Store.name, "shared-wake", wakeInitial.instanceId, wakeInitial.version, [["messages"]], "shared-wake")
        );
        await primary.stores.updateStore({
          definition: Store,
          id: "shared-wake",
          updater(draft) { draft.messages.push({ id: "ready" }); },
        });
        await expectWoken(peer, ["shared-wake"]);
        // A step recorded through one client deletes the waiter for every client.
        await recordStep(primary, "shared-wake");
        await peer.stores.updateStore({
          definition: Store,
          id: "shared-wake",
          updater(draft) { draft.messages.push({ id: "after-step" }); },
        });
        await expectNotWoken(primary);

        const registrar = await harness.createPeer();
        const committer = await harness.createPeer();
        const executionIds = Array.from({ length: 10 }, (_, index) => `shared-registration-race-${index}`);
        await admitWaiting(primary, ...executionIds);
        for (const [index, id] of executionIds.entries()) {
          const snapshot = await committer.stores.getOrCreateStore({
            definition: Store,
            id,
            initial: { messages: [] },
          });
          const register = () =>
            registrar.stores.registerWaiter(
              waiter(Store.name, id, snapshot.instanceId, snapshot.version, [["messages"]], id)
            );
          const update = () =>
            committer.stores.updateStore({
              definition: Store,
              id,
              updater(draft) { draft.messages.push({ id: "ready" }); },
            });
          await Promise.all(index % 2 === 0 ? [register(), update()] : [update(), register()]);
        }
        await expectWoken(primary, executionIds);
      } finally {
        await harness.dispose?.();
      }
    });

    test("qualifies declared durable-wake capabilities", async () => {
      const harness = await create();
      try {
        if (!harness.restart) return;
        const { runtime } = harness;
        await admitWaiting(runtime, "durable-wake", "durable-waiter");
        for (const executionId of ["durable-wake", "durable-waiter"]) {
          const initial = await runtime.stores.getOrCreateStore({
            definition: Store,
            id: executionId,
            initial: { messages: [] },
          });
          await runtime.stores.registerWaiter(
            waiter(Store.name, executionId, initial.instanceId, initial.version, [["messages"]], executionId)
          );
        }
        await runtime.stores.updateStore({
          definition: Store,
          id: "durable-wake",
          updater(draft) { draft.messages.push({ id: "ready" }); },
        });

        // The commit returned, so its wake survives a crash before any claim.
        const restarted = await harness.restart();
        expect(
          await restarted.stores.getStore({ definition: Store, id: "durable-wake" })
        ).toMatchObject({ state: { messages: [{ id: "ready" }] }, version: 1 });
        await expectWoken(restarted, ["durable-wake"]);

        // Waiters survive the restart too, until their step is recorded.
        for (const id of ["durable-wake", "durable-waiter"]) {
          await restarted.stores.updateStore({
            definition: Store,
            id,
            updater(draft) { draft.messages.push({ id: "after-restart" }); },
          });
        }
        await expectWoken(restarted, ["durable-wake", "durable-waiter"]);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
