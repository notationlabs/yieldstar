import { v7 as uuidv7 } from "uuid";
import {
  CasStoreClient,
  cloneStoreState,
  decodeStoreValue,
  encodeStoreValue,
  storePathsIntersect,
  type StandardSchemaV1,
  type StoreDefinition,
  type StoreDeletion,
  type StoreMutation,
  type StoreMutationCommitResult,
  type StorePath,
  type StoreSnapshot,
  type StoreStepId,
  type StoreWaiter,
} from "@yieldstar/core";
import type { MemoryExecutionClient } from "./memory-execution";

type StoreRecord = {
  state: unknown;
  instanceId: string;
  version: number;
};

export class MemoryStoreClient extends CasStoreClient {
  private stores = new Map<string, StoreRecord>();
  // Waiters stay registered when woken; they are deleted when their step's
  // result is recorded (deleteWaitersForStep) or their store is deleted.
  private waiters = new Map<string, StoreWaiter>();
  // Applied-steps ledger: (storeName, storeId, executionId, stepKey) ->
  // serialized committed result. Written in the same synchronous critical
  // section (within the write queue) as the state commit, so a retried
  // workflow step returns the recorded result instead of re-applying.
  private appliedSteps = new Map<string, string>();
  private executions: Pick<MemoryExecutionClient, "wakeNow">;
  // Serializes writes so concurrent commits cannot interleave.
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor(params: { executions: Pick<MemoryExecutionClient, "wakeNow"> }) {
    super();
    this.executions = params.executions;
  }

  private enqueueWrite<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.writeLock.then(fn, fn);
    this.writeLock = result.catch(() => {});
    return result;
  }

  protected createInstanceId(): string {
    return uuidv7();
  }

  protected async readStore(params: {
    definition: StoreDefinition;
    id: string;
  }): Promise<StoreSnapshot<unknown> | undefined> {
    const record = this.stores.get(
      this.storeKey(params.definition.name, params.id)
    );
    return record ? this.toSnapshot(record) : undefined;
  }

  protected insertStore(params: {
    definition: StoreDefinition;
    id: string;
    snapshot: StoreSnapshot<unknown>;
  }): Promise<StoreSnapshot<unknown>> {
    return this.enqueueWrite(async () => {
      const key = this.storeKey(params.definition.name, params.id);
      const record = this.stores.get(key);
      if (record) return this.toSnapshot(record);
      this.stores.set(key, {
        state: cloneStoreState(params.snapshot.state),
        instanceId: params.snapshot.instanceId,
        version: params.snapshot.version,
      });
      return cloneStoreState(params.snapshot);
    });
  }

  protected async getAppliedStoreStep(params: {
    definition: StoreDefinition;
    id: string;
    stepId: StoreStepId;
  }): Promise<{ result: unknown } | undefined> {
    const applied = this.appliedSteps.get(
      this.appliedStepKey(params.definition.name, params.id, params.stepId)
    );
    return applied ? { result: decodeStoreValue(applied) } : undefined;
  }

  protected commitStoreMutation(
    mutation: StoreMutation
  ): Promise<StoreMutationCommitResult> {
    return this.enqueueWrite(async () => {
      if (mutation.stepId) {
        const applied = this.appliedSteps.get(
          this.appliedStepKey(
            mutation.definition.name,
            mutation.id,
            mutation.stepId
          )
        );
        if (applied) {
          return {
            status: "already-applied",
            result: decodeStoreValue(applied),
          };
        }
      }

      const key = this.storeKey(mutation.definition.name, mutation.id);
      const record = this.stores.get(key);
      if (!record && !mutation.expected.created) return { status: "missing" };
      if (
        record &&
        (mutation.expected.created ||
          record.instanceId !== mutation.expected.instanceId ||
          record.version !== mutation.expected.version)
      ) {
        return { status: "conflict", snapshot: this.toSnapshot(record) };
      }

      const version = mutation.expected.version + 1;
      this.stores.set(key, {
        state: cloneStoreState(mutation.nextState),
        instanceId: mutation.expected.instanceId,
        version,
      });

      if (mutation.stepId) {
        this.appliedSteps.set(
          this.appliedStepKey(
            mutation.definition.name,
            mutation.id,
            mutation.stepId
          ),
          encodeStoreValue(mutation.result)
        );
      }

      // Wakes are requested in the same synchronous critical section as the
      // commit, so a committed change is never left without its wakes.
      this.wakeMatchingWaiters({
        storeName: mutation.definition.name,
        storeId: mutation.id,
        version,
        changedPaths: mutation.changedPaths,
      });
      return { status: "committed" };
    });
  }

  async listStores<Schema extends StandardSchemaV1>(
    definition: StoreDefinition<Schema>
  ): Promise<string[]> {
    const prefix = `${definition.name}:`;
    const ids: string[] = [];
    for (const key of this.stores.keys()) {
      if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
    return ids.sort();
  }

  async deleteStore<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
  }): Promise<void> {
    return this.enqueueWrite(async () => {
      const { name } = params.definition;
      this.stores.delete(this.storeKey(name, params.id));
      for (const [key, waiter] of [...this.waiters.entries()]) {
        if (waiter.storeName === name && waiter.storeId === params.id) {
          this.waiters.delete(key);
        }
      }
    });
  }

  protected commitStoreDeletion(
    deletion: StoreDeletion
  ): Promise<StoreMutationCommitResult> {
    return this.enqueueWrite(async () => {
      const ledgerKey = deletion.stepId
        ? this.appliedStepKey(
            deletion.definition.name,
            deletion.id,
            deletion.stepId
          )
        : undefined;
      if (ledgerKey) {
        const applied = this.appliedSteps.get(ledgerKey);
        if (applied) {
          return { status: "already-applied", result: decodeStoreValue(applied) };
        }
      }

      const key = this.storeKey(deletion.definition.name, deletion.id);
      const record = this.stores.get(key);
      if (!record) return { status: "missing" };
      if (
        record.instanceId !== deletion.expected.instanceId ||
        record.version !== deletion.expected.version
      ) {
        return { status: "conflict", snapshot: this.toSnapshot(record) };
      }

      this.stores.delete(key);
      for (const [waiterKey, waiter] of [...this.waiters.entries()]) {
        if (waiter.instanceId === record.instanceId) {
          this.waiters.delete(waiterKey);
        }
      }
      if (ledgerKey) {
        this.appliedSteps.set(ledgerKey, encodeStoreValue(deletion.result));
      }
      return { status: "committed" };
    });
  }

  async registerWaiter(waiter: StoreWaiter): Promise<void> {
    return this.enqueueWrite(async () => {
      const key = this.waiterKey(
        waiter.storeName,
        waiter.storeId,
        waiter.executionId,
        waiter.stepKey
      );
      // Lost-wakeup guard: if an update landed between the caller's getStore
      // and this registration, the version has already advanced. Wake
      // immediately – replay re-evaluates the selector, so a spurious wake
      // is safe.
      const record = this.stores.get(
        this.storeKey(waiter.storeName, waiter.storeId)
      );
      if (
        !record ||
        record.instanceId !== waiter.instanceId ||
        record.version > waiter.sinceVersion
      ) {
        this.waiters.set(key, cloneStoreState(waiter));
        this.executions.wakeNow(waiter.executionId);
        return;
      }
      this.waiters.set(key, cloneStoreState(waiter));
    });
  }

  /**
   * Deletes the waiters a step registered. Called synchronously when the heap
   * records the step's result, so the waiter goes with that write.
   */
  deleteWaitersForStep(params: { executionId: string; stepKey: string }) {
    for (const [key, waiter] of [...this.waiters.entries()]) {
      if (
        waiter.executionId === params.executionId &&
        waiter.stepKey === params.stepKey
      ) {
        this.waiters.delete(key);
      }
    }
  }

  private wakeMatchingWaiters(params: {
    storeName: string;
    storeId: string;
    version: number;
    changedPaths: readonly (readonly (string | number)[])[];
  }) {
    for (const waiter of this.waiters.values()) {
      if (waiter.storeName !== params.storeName) continue;
      if (waiter.storeId !== params.storeId) continue;
      if (waiter.sinceVersion >= params.version) continue;
      if (!storePathsIntersect(waiter.readPaths, [...params.changedPaths])) {
        continue;
      }

      this.executions.wakeNow(waiter.executionId);
    }
  }

  private storeKey(storeName: string, storeId: string) {
    return `${storeName}:${storeId}`;
  }

  private appliedStepKey(
    storeName: string,
    storeId: string,
    stepId: StoreStepId
  ) {
    return JSON.stringify([
      storeName,
      storeId,
      stepId.executionId,
      stepId.stepKey,
    ]);
  }

  private waiterKey(
    storeName: string,
    storeId: string,
    executionId: string,
    stepKey: string
  ) {
    return `${storeName}:${storeId}:${executionId}:${stepKey}`;
  }

  private toSnapshot(record: StoreRecord): StoreSnapshot<unknown> {
    return {
      state: cloneStoreState(record.state),
      instanceId: record.instanceId,
      version: record.version,
    };
  }
}
