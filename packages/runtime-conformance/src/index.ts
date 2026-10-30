import {
  DEFAULT_LEASE_DURATION,
  defineStore,
  type Runtime,
  type StandardSchemaV1,
  type StoreDefinition,
  type StorePath,
  type StoreWaiter,
} from "@yieldstar/core";
import { describe, expect, test } from "vitest";

export {
  registerEffectClientConformance,
  type EffectConformanceHarness,
  type EffectConformanceHarnessOptions,
  type EffectConformanceOptions,
} from "./effect";
export {
  registerExecutionClientConformance,
  type ExecutionConformanceHarness,
  type ExecutionConformanceHarnessOptions,
  type ExecutionConformanceOptions,
} from "./execution";

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

const seeds = new Map<string, unknown>();

/**
 * Returns an `initial` for the store definition named `storeName`: the state
 * seeded for an ID, or a copy of `fallback`.
 */
function seeded<T>(storeName: string, fallback: T): (id: string) => T {
  return (id) =>
    structuredClone((seeds.get(JSON.stringify([storeName, id])) ?? fallback) as T);
}

/** Sets the state a seeded definition's `initial` returns for `id`. */
function seed<T>(definition: StoreDefinition<StandardSchemaV1<unknown, T>>, id: string, state: T) {
  seeds.set(JSON.stringify([definition.name, id]), state);
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
  const leases = await claimAll(runtime);
  for (const lease of leases) {
    await runtime.executions.acknowledge({ lease, outcome: { status: "suspended" } });
  }
  return leases.map((lease) => lease.executionId).sort();
}

function claimAll(runtime: Runtime) {
  return runtime.executions.claimDue({ limit: 1_000, duration: DEFAULT_LEASE_DURATION });
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

/**
 * Records a step's result, which deletes that step's waiter. Heap writes are
 * fenced, so this wakes and leases the execution first. Call it only when
 * nothing else is due.
 */
async function recordStep(runtime: Runtime, executionId: string, stepKey = STEP_KEY) {
  await runtime.executions.requestWake({ executionId, wakeAt: runtime.clock() });
  const leases = await claimAll(runtime);
  const lease = leases.find((lease) => lease.executionId === executionId);
  if (!lease) throw new Error(`could not lease "${executionId}" to record a step`);
  const written = await runtime.heap.writeStep({
    lease,
    stepKey,
    stepAttempt: 1,
    done: true,
    stepResponseJson: JSON.stringify({ done: true }),
  });
  expect(written).toMatchObject({ meta: { done: true } });
  for (const claimed of leases) {
    await runtime.executions.acknowledge({
      lease: claimed,
      outcome: { status: "suspended" },
    });
  }
}

/** Registers the normative YieldStar store connector qualification suite. */
export function registerStoreClientConformance({
  name,
  create,
}: StoreConformanceOptions): void {
  const Store = defineStore(`${name}-store-conformance`, schema<State>(), {
    initial: seeded<State>(`${name}-store-conformance`, { messages: [] }),
  });
  const TakeStore = defineStore(`${name}-take-conformance`, schema<TakeState>(), {
    initial: seeded<TakeState>(`${name}-take-conformance`, { messages: [] }),
  });

  describe(`${name} store connector conformance`, () => {
    test("creates, reads, lists, deletes, and recreates logical stores", async () => {
      const harness = await create();
      const OtherStore = defineStore(`${name}-other-conformance`, schema<State>(), {
        initial: () => ({ messages: [] }),
      });
      try {
        const first = await harness.runtime.stores.getStore({
          definition: Store,
          id: "b",
        });
        const second = await harness.runtime.stores.getStore({
          definition: Store,
          id: "a",
        });
        await harness.runtime.stores.getStore({
          definition: OtherStore,
          id: "a",
        });

        expect(first.instanceId).toMatch(/^[0-9a-f-]+$/);
        expect(second.instanceId).not.toBe(first.instanceId);
        expect(await harness.runtime.stores.listStores(Store)).toEqual(["a", "b"]);
        expect(
          await harness.runtime.stores.getStore({ definition: Store, id: "b" })
        ).toEqual(first);
        await harness.runtime.stores.deleteStore({ definition: Store, id: "b" });
        expect(await harness.runtime.stores.listStores(Store)).toEqual(["a"]);
        const recreated = await harness.runtime.stores.getStore({
          definition: Store,
          id: "b",
        });
        expect(recreated).toMatchObject({ state: { messages: [] }, version: 0 });
        expect(recreated.instanceId).not.toBe(first.instanceId);
        await harness.runtime.stores.deleteStore({ definition: Store, id: "missing" });
        expect(await harness.runtime.stores.listStores(Store)).toEqual(["a", "b"]);
      } finally {
        await harness.dispose?.();
      }
    });

    test("rejects non-durable state with INVALID_STEP_VALUE and leaves the store unchanged", async () => {
      const harness = await create();
      const { stores } = harness.runtime;
      const invalid = { code: "INVALID_STEP_VALUE", name: "WorkflowValueError" };
      try {
        seed(Store, "never-created", { messages: [], unrelated: new Date(Number.NaN) as never });
        await expect(
          stores.getStore({ definition: Store, id: "never-created" })
        ).rejects.toMatchObject(invalid);
        await expect(
          stores.updateStore({
            definition: Store,
            id: "never-created",
            stepId: { executionId: "never-created", stepKey: "update" },
            updater() {},
          })
        ).rejects.toMatchObject({ ...invalid, stepKey: "update" });
        expect(await stores.listStores(Store)).toEqual([]);

        seed(Store, "durable", { messages: [{ id: "one" }] });
        const created = await stores.getStore({
          definition: Store,
          id: "durable",
        });
        const stepId = { executionId: "durable-execution", stepKey: "update" };
        await expect(
          stores.updateStore({
            definition: Store,
            id: "durable",
            stepId,
            updater(draft) {
              draft.messages.push({ id: "two" });
              (draft as Record<string, unknown>).at = new Date(Number.NaN);
            },
          })
        ).rejects.toMatchObject({ ...invalid, stepKey: "update" });
        await expect(
          stores.updateStoreFrom({
            definition: Store,
            id: "durable",
            snapshot: created,
            updater: () => ({ messages: [], unrelated: Number.NaN as never }),
          })
        ).rejects.toMatchObject(invalid);
        expect(await stores.getStore({ definition: Store, id: "durable" })).toMatchObject({
          state: { messages: [{ id: "one" }] },
          version: 0,
        });

        seed(TakeStore, "durable-take", { messages: [{ id: "one" }] });
        await stores.getStore({
          definition: TakeStore,
          id: "durable-take",
        });
        await expect(
          stores.takeFromStore({
            definition: TakeStore,
            id: "durable-take",
            selector: (state) => state.messages.length > 0 && new Date(Number.NaN),
            claim(draft) {
              draft.messages = [];
            },
          })
        ).rejects.toMatchObject(invalid);
        expect(
          await stores.getStore({ definition: TakeStore, id: "durable-take" })
        ).toMatchObject({ state: { messages: [{ id: "one" }] }, version: 0 });

        // A failed update records no receipt, so the step can commit later.
        const retried = await stores.updateStore({
          definition: Store,
          id: "durable",
          stepId,
          updater(draft) {
            draft.messages.push({ id: "two" });
          },
        });
        expect(retried).toMatchObject({ version: 1, state: { messages: [{ id: "one" }, { id: "two" }] } });
      } finally {
        await harness.dispose?.();
      }
    });

    test("stores state and receipts with the durable value codec", async () => {
      const harness = await create();
      const { stores } = harness.runtime;
      try {
        seed(Store, "codec", { messages: [], unrelated: undefined });
        await stores.getStore({
          definition: Store,
          id: "codec",
        });
        const stepId = { executionId: "codec-execution", stepKey: "update" };
        const update = () =>
          stores.updateStore({
            definition: Store,
            id: "codec",
            stepId,
            updater(draft) {
              draft.messages.push({ id: "one", $type: "undefined" } as never);
              (draft as Record<string, unknown>).error = new RangeError("r");
            },
          });
        const first = await update();
        const replayed = await update();
        const read = await stores.getStore({ definition: Store, id: "codec" });
        for (const state of [first.state, replayed.state, read.state]) {
          expect(Object.keys(state).sort()).toEqual(["error", "messages", "unrelated"]);
          expect(state.messages).toEqual([{ id: "one", $type: "undefined" }]);
          expect((state as Record<string, unknown>).error).toBeInstanceOf(RangeError);
        }
        expect(replayed.version).toBe(1);

        if (harness.restart) {
          const restarted = await harness.restart();
          const reopened = await restarted.stores.getStore({ definition: Store, id: "codec" });
          expect(Object.keys(reopened.state).sort()).toEqual(["error", "messages", "unrelated"]);
          expect((reopened.state as Record<string, unknown>).error).toBeInstanceOf(RangeError);
        }
      } finally {
        await harness.dispose?.();
      }
    });

    test("rejects asynchronous updaters and claims without committing", async () => {
      const harness = await create();
      try {
        seed(TakeStore, "sync-callbacks", { messages: [{ id: "one" }] });
        await harness.runtime.stores.getStore({
          definition: TakeStore,
          id: "sync-callbacks",
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
      const RaceStore = defineStore(`${name}-cas-race-conformance`, raceSchema, {
        initial: () => ({ messages: [] }),
      });
      const harness = await create();
      let updaterRuns = 0;
      try {
        await harness.runtime.stores.getStore({
          definition: RaceStore,
          id: "race",
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
        await harness.runtime.stores.getStore({
          definition: Store,
          id: "receipt-race",
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
        const recreated = await harness.runtime.stores.getStore({
          definition: Store,
          id: "receipt-race",
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
        await harness.runtime.stores.getStore({
          definition: Store,
          id: "receipt-scope",
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
        const initial = await harness.runtime.stores.getStore({
          definition: Store,
          id: "external-update",
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
        seed(Store, "plain-state", { messages: [{ id: "one" }] });
        await harness.runtime.stores.getStore({
          definition: Store,
          id: "plain-state",
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
        schema<PerformanceState>(),
        { initial: () => ({ changed: 0, large: {} }) }
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
        await harness.runtime.stores.getStore({
          definition: PerformanceStore,
          id: "mutating",
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

        await harness.runtime.stores.getStore({
          definition: PerformanceStore,
          id: "replacement",
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
        const snapshot = await harness.runtime.stores.getStore({
          definition: Store,
          id: "conditional",
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
        seed(TakeStore, "take", { messages: [{ id: "one" }, { id: "two" }] });
        await harness.runtime.stores.getStore({
          definition: TakeStore,
          id: "take",
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
        const original = await harness.runtime.stores.getStore({
          definition: Store,
          id: "delete",
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
        const recreated = await harness.runtime.stores.getStore({
          definition: Store,
          id: "delete",
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
    describe("missing stores (RFC 006)", () => {
      type CreatedState = { createdBy: string; messages: { id: string }[] };

      /**
       * A store whose `initial` records each evaluation and stamps the state
       * it returns with the evaluation's number, so a test can tell which
       * initial state a store recorded.
       */
      function countedStore(suffix: string, validate?: () => Promise<void>) {
        const evaluations: string[] = [];
        const countedSchema: StandardSchemaV1<unknown, CreatedState> = {
          "~standard": {
            version: 1,
            vendor: "yieldstar-conformance",
            async validate(value) {
              await validate?.();
              return { value: value as CreatedState };
            },
          },
        };
        const definition = defineStore(
          `${name}-${suffix}-missing-conformance`,
          countedSchema,
          {
            initial(id) {
              evaluations.push(id);
              return { createdBy: `initial-${evaluations.length}`, messages: [] };
            },
          }
        );
        return { definition, evaluations };
      }

      test("every operation on a missing store creates it from initial in the same write", async () => {
        const harness = await create();
        const { stores } = harness.runtime;
        const { definition, evaluations } = countedStore("operations");
        const stepId = (stepKey: string) => ({ executionId: "operations", stepKey });
        try {
          expect(await stores.getStore({ definition, id: "get" })).toMatchObject({
            state: { createdBy: "initial-1", messages: [] },
            version: 0,
          });

          const updated = await stores.updateStore({
            definition,
            id: "update",
            stepId: stepId("update"),
            updater(draft) {
              draft.messages.push({ id: "one" });
            },
          });
          expect(updated).toEqual({
            state: { createdBy: "initial-2", messages: [{ id: "one" }] },
            previousVersion: 0,
            version: 1,
          });

          const taken = await stores.takeFromStore({
            definition,
            id: "take",
            stepId: stepId("take"),
            selector: (state) => state.createdBy,
            claim(draft) {
              draft.messages.push({ id: "claimed" });
            },
          });
          expect(taken).toMatchObject({ matched: true, selected: "initial-3", version: 1 });

          const unmatched = await stores.takeFromStore({
            definition,
            id: "unmatched-take",
            selector: (state) => state.messages[0],
            claim() {},
          });
          expect(unmatched).toMatchObject({ matched: false, version: 0 });

          const stale = { state: undefined, instanceId: "stale", version: 0 };
          expect(
            await stores.updateStoreFrom({
              definition,
              id: "update-from",
              snapshot: stale as never,
              updater() {},
            })
          ).toMatchObject({ updated: false, expectedInstanceId: "stale", actualVersion: 0 });
          expect(
            await stores.deleteStoreFrom({ definition, id: "delete-from", snapshot: stale })
          ).toMatchObject({ deleted: false, reason: "conflict", actualVersion: 0 });

          expect(evaluations).toEqual([
            "get",
            "update",
            "take",
            "unmatched-take",
            "update-from",
            "delete-from",
          ]);
          expect(await stores.listStores(definition)).toEqual([
            "delete-from",
            "get",
            "take",
            "unmatched-take",
            "update",
            "update-from",
          ]);
          expect(await stores.getStore({ definition, id: "update" })).toMatchObject({
            state: updated.state,
            version: 1,
          });
          expect(await stores.getStore({ definition, id: "take" })).toMatchObject({
            state: { createdBy: "initial-3", messages: [{ id: "claimed" }] },
            instanceId: taken.instanceId,
            version: 1,
          });
          expect(
            (await stores.getStore({ definition, id: "unmatched-take" })).instanceId
          ).toBe(unmatched.instanceId);
          expect(evaluations).toHaveLength(6);
        } finally {
          await harness.dispose?.();
        }
      });

      test("evaluates initial only when the store is missing", async () => {
        const harness = await create();
        const { stores } = harness.runtime;
        const { definition, evaluations } = countedStore("existing");
        try {
          const created = await stores.getStore({ definition, id: "existing" });
          await stores.updateStore({
            definition,
            id: "existing",
            updater(draft) {
              draft.messages.push({ id: "one" });
            },
          });
          const current = await stores.getStore({ definition, id: "existing" });
          await stores.takeFromStore({
            definition,
            id: "existing",
            selector: (state) => state.messages[0],
            claim() {},
          });
          await stores.updateStoreFrom({ definition, id: "existing", snapshot: created, updater() {} });
          await stores.deleteStoreFrom({ definition, id: "existing", snapshot: created });
          expect(evaluations).toEqual(["existing"]);

          await stores.deleteStoreFrom({ definition, id: "existing", snapshot: current });
          await stores.deleteStore({ definition, id: "existing" });
          await stores.deleteStore({ definition, id: "never-read" });
          expect(await stores.listStores(definition)).toEqual([]);
          expect(evaluations).toEqual(["existing"]);
        } finally {
          await harness.dispose?.();
        }
      });

      test("a falsy initial state is a stored state, not a missing store", async () => {
        const harness = await create();
        const { stores } = harness.runtime;
        try {
          for (const [index, falsy] of [0, "", false, null].entries()) {
            let evaluations = 0;
            const Falsy = defineStore(
              `${name}-falsy-${index}-missing-conformance`,
              schema<typeof falsy>(),
              {
                initial() {
                  evaluations += 1;
                  return falsy;
                },
              }
            );
            expect(await stores.getStore({ definition: Falsy, id: "falsy" })).toMatchObject({
              state: falsy,
              version: 0,
            });
            expect(await stores.getStore({ definition: Falsy, id: "falsy" })).toMatchObject({
              state: falsy,
              version: 0,
            });
            expect(evaluations).toBe(1);
          }
        } finally {
          await harness.dispose?.();
        }
      });

      test("creates nothing when initial or the operation fails", async () => {
        const harness = await create();
        const { stores } = harness.runtime;
        const Throwing = defineStore(`${name}-throwing-missing-conformance`, schema<State>(), {
          initial() {
            throw new RangeError("no initial state");
          },
        });
        const { definition } = countedStore("failing");
        try {
          await expect(stores.getStore({ definition: Throwing, id: "throws" })).rejects.toThrow(
            RangeError
          );
          await expect(
            stores.updateStore({ definition: Throwing, id: "throws", updater() {} })
          ).rejects.toThrow(RangeError);
          expect(await stores.listStores(Throwing)).toEqual([]);

          await expect(
            stores.updateStore({
              definition,
              id: "updater-throws",
              updater() {
                throw new RangeError("no update");
              },
            })
          ).rejects.toThrow(RangeError);
          await expect(
            stores.takeFromStore({
              definition,
              id: "claim-throws",
              selector: (state) => state.createdBy,
              claim() {
                throw new RangeError("no claim");
              },
            })
          ).rejects.toThrow(RangeError);
          expect(await stores.listStores(definition)).toEqual([]);
        } finally {
          await harness.dispose?.();
        }
      });

      test("records exactly one initial state when executions update a missing store at once", async () => {
        let racing = false;
        let arrived = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        // The first two validations are the two initial states, so neither
        // update commits until both have found the store missing.
        const { definition, evaluations } = countedStore("concurrent", async () => {
          if (!racing || ++arrived > 2) return;
          if (arrived === 2) release();
          await bothRead;
        });
        const harness = await create();
        const peer = (await harness.createPeer?.()) ?? harness.runtime;
        try {
          for (const id of ["get", "update"]) {
            racing = true;
            arrived = 0;
            if (id === "get") {
              const [first, second] = await Promise.all([
                harness.runtime.stores.getStore({ definition, id }),
                peer.stores.getStore({ definition, id }),
              ]);
              expect(second).toEqual(first);
              continue;
            }
            const results = await Promise.all(
              [harness.runtime, peer].map((runtime, index) =>
                runtime.stores.updateStore({
                  definition,
                  id,
                  stepId: { executionId: `execution-${index}`, stepKey: "append" },
                  updater(draft) {
                    draft.messages.push({ id: `execution-${index}` });
                  },
                })
              )
            );
            expect(results.map((result) => result.version).sort()).toEqual([1, 2]);
          }
          racing = false;
          expect(evaluations).toEqual(["get", "get", "update", "update"]);

          const got = await harness.runtime.stores.getStore({ definition, id: "get" });
          expect(got).toMatchObject({ version: 0, state: { messages: [] } });
          expect(["initial-1", "initial-2"]).toContain(got.state.createdBy);

          const updated = await peer.stores.getStore({ definition, id: "update" });
          expect(updated.version).toBe(2);
          expect(["initial-3", "initial-4"]).toContain(updated.state.createdBy);
          expect(updated.state.messages.map((message) => message.id).sort()).toEqual([
            "execution-0",
            "execution-1",
          ]);
        } finally {
          await harness.dispose?.();
        }
      });

      test("replays a committed operation from its receipt without creating the store again", async () => {
        const harness = await create();
        const { definition, evaluations } = countedStore("receipt");
        const stepId = { executionId: "crashed", stepKey: "append" };
        let updaterRuns = 0;
        const append = (runtime: Runtime) =>
          runtime.stores.updateStore({
            definition,
            id: "receipt",
            stepId,
            updater(draft) {
              updaterRuns++;
              draft.messages.push({ id: "once" });
            },
          });
        try {
          const committed = await append(harness.runtime);
          const created = await harness.runtime.stores.getStore({ definition, id: "receipt" });

          // The workflow crashed before recording the step, so it runs again.
          const runtime = (await harness.restart?.()) ?? harness.runtime;
          expect(await append(runtime)).toEqual(committed);
          expect(await runtime.stores.getStore({ definition, id: "receipt" })).toEqual(created);
          expect(created).toMatchObject({ state: { messages: [{ id: "once" }] }, version: 1 });

          // The receipt is read first, so a store deleted since is not recreated.
          await runtime.stores.deleteStore({ definition, id: "receipt" });
          expect(await append(runtime)).toEqual(committed);
          expect(await runtime.stores.listStores(definition)).toEqual([]);
          expect(updaterRuns).toBe(1);
          expect(evaluations).toEqual(["receipt"]);
        } finally {
          await harness.dispose?.();
        }
      });

      test("creates a store deleted between operations again from initial", async () => {
        const harness = await create();
        const { definition, evaluations } = countedStore("recreate");
        const append = (runtime: Runtime, id: string) =>
          runtime.stores.updateStore({
            definition,
            id: "recreate",
            stepId: { executionId: "recreate", stepKey: id },
            updater(draft) {
              draft.messages.push({ id });
            },
          });
        try {
          await append(harness.runtime, "first");
          const original = await harness.runtime.stores.getStore({ definition, id: "recreate" });
          await harness.runtime.stores.deleteStoreFrom({
            definition,
            id: "recreate",
            snapshot: original,
            stepId: { executionId: "recreate", stepKey: "delete" },
          });

          const runtime = (await harness.restart?.()) ?? harness.runtime;
          expect(await append(runtime, "second")).toEqual({
            state: { createdBy: "initial-2", messages: [{ id: "second" }] },
            previousVersion: 0,
            version: 1,
          });
          const recreated = await runtime.stores.getStore({ definition, id: "recreate" });
          expect(recreated.instanceId).not.toBe(original.instanceId);
          expect(evaluations).toEqual(["recreate", "recreate"]);
        } finally {
          await harness.dispose?.();
        }
      });

      test("an unmatched take on a missing store lets its waiter wait", async () => {
        const harness = await create();
        const { runtime } = harness;
        const { definition } = countedStore("waiting-take");
        try {
          await admitWaiting(runtime, "taker");
          const miss = await runtime.stores.takeFromStore({
            definition,
            id: "waiting-take",
            selector: (state) => state.messages[0],
            claim() {},
          });
          if (miss.matched) throw new Error("take must not match");
          await runtime.stores.registerWaiter(
            waiter(definition.name, "waiting-take", miss.instanceId, miss.version, miss.readPaths, "taker")
          );
          await expectNotWoken(runtime);
          await runtime.stores.updateStore({
            definition,
            id: "waiting-take",
            updater(draft) {
              draft.messages.push({ id: "ready" });
            },
          });
          await expectWoken(runtime, ["taker"]);
        } finally {
          await harness.dispose?.();
        }
      });
    });

    test("wakes an intersecting waiter's execution and keeps the waiter until its step is recorded", async () => {
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "execution");
        const initial = await runtime.stores.getStore({
          definition: Store,
          id: "selective-wake",
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
          const snapshot = await runtime.stores.getStore({
            definition: Store,
            id,
          });
          await runtime.stores.registerWaiter({
            ...waiter(Store.name, id, snapshot.instanceId, snapshot.version),
            executionId: "collapsed",
            stepKey: `wait-${id}`,
          });
        }
        const shared = await runtime.stores.getStore({
          definition: Store,
          id: "collapse-shared",
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
        const [lease] = await claimAll(runtime);
        await runtime.executions.acknowledge({
          lease,
          outcome: { status: "completed", result: "done" },
        });
        const initial = await runtime.stores.getStore({
          definition: Store,
          id: "orphan-wake",
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
        const original = await runtime.stores.getStore({
          definition: Store,
          id: "deleted-waiters",
        });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "deleted-waiters", original.instanceId, original.version)
        );
        await runtime.stores.deleteStore({ definition: Store, id: "deleted-waiters" });
        const recreated = await runtime.stores.getStore({
          definition: Store,
          id: "deleted-waiters",
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
        const initial = await runtime.stores.getStore({
          definition: Store,
          id: "conditional-delete-wake",
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
        await runtime.stores.getStore({
          definition: Store,
          id: "conditional-delete-wake",
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
      const QueueStore = defineStore(`${name}-wake-paths-conformance`, schema<QueueState>(), {
        initial: seeded<QueueState>(`${name}-wake-paths-conformance`, { messages: [] }),
      });
      const harness = await create();
      const { runtime } = harness;
      try {
        await admitWaiting(runtime, "replacement", "claim", "splice");
        const replacement = await runtime.stores.getStore({
          definition: QueueStore,
          id: "replacement",
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

        seed(QueueStore, "claim", { messages: [{ id: "one" }] });
        const claim = await runtime.stores.getStore({
          definition: QueueStore,
          id: "claim",
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

        seed(QueueStore, "splice", { messages: [{ id: "one" }, { id: "two" }] });
        const splice = await runtime.stores.getStore({
          definition: QueueStore,
          id: "splice",
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
        const initial = await runtime.stores.getStore({
          definition: Store,
          id: "stale-registration",
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
        const original = await runtime.stores.getStore({
          definition: Store,
          id: "stale-instance",
        });
        await runtime.stores.deleteStore({ definition: Store, id: "stale-instance" });
        await runtime.stores.getStore({
          definition: Store,
          id: "stale-instance",
        });
        await runtime.stores.registerWaiter(
          waiter(Store.name, "stale-instance", original.instanceId, original.version, [["messages"]], "replaced")
        );
        await expectWoken(runtime, ["replaced"]);

        // Observed a store that no longer exists.
        const gone = await runtime.stores.getStore({
          definition: Store,
          id: "stale-missing",
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
          const initial = await runtime.stores.getStore({
            definition: Store,
            id,
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
        await primary.stores.getStore({
          definition: Store,
          id: "shared-client",
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
        const wakeInitial = await peer.stores.getStore({
          definition: Store,
          id: "shared-wake",
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
          const snapshot = await committer.stores.getStore({
            definition: Store,
            id,
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
          const initial = await runtime.stores.getStore({
            definition: Store,
            id: executionId,
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
