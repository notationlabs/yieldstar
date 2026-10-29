import { v7 as uuidv7 } from "uuid";
import { StoreWaitersDao } from "./dao/store-waiters-dao";
import type { SqliteDriver } from "./sqlite-driver";
import { SqliteExecutionClient } from "./sqlite-execution";
import { runTransaction } from "./sqlite-transaction";
import {
  cloneStoreState,
  CasStoreClient,
  decodeStoreValue,
  encodeStoreValue,
  storePathsIntersect,
  type StandardSchemaV1,
  type StoreDefinition,
  type StoreDeletion,
  type StorePath,
  type StoreSnapshot,
  type StoreStepId,
  type StoreWaiter,
  type StoreMutation,
  type StoreMutationCommitResult,
} from "@yieldstar/core";

class StoreRow {
  instance_id!: string;
  state!: string;
  version!: number;
}

class AppliedStepRow {
  result!: string;
}

class StoreIdRow {
  store_id!: string;
}

/**
 * Stores, waiters and the applied-steps ledger, in the same database as the
 * execution records. A commit that satisfies waiters requests their wakes in
 * the same transaction, so a durable commit always has durable wakes.
 *
 * Every write is one synchronous IMMEDIATE transaction: nothing awaits
 * between BEGIN and COMMIT, so operations on a shared connection cannot
 * interleave, and processes sharing the file serialize on SQLite's lock.
 */
export class SqliteStoreClient extends CasStoreClient {
  private db: SqliteDriver;
  private executions: SqliteExecutionClient;
  private storeWaitersDao: StoreWaitersDao;

  /**
   * @param params.executions The execution client whose records waiters wake.
   * Defaults to one over `db` with the default clock; SqliteRuntime passes
   * its own so both share the runtime clock.
   */
  constructor(params: { db: SqliteDriver; executions?: SqliteExecutionClient }) {
    super();
    this.db = params.db;
    this.executions = params.executions ?? new SqliteExecutionClient(params.db);
    this.setupDb();
    this.storeWaitersDao = new StoreWaitersDao(params.db);
  }

  protected createInstanceId(): string {
    return uuidv7();
  }

  protected async readStore(params: {
    definition: StoreDefinition;
    id: string;
  }): Promise<StoreSnapshot<unknown> | undefined> {
    const row = this.getStoreRow(params.definition.name, params.id);
    return row ? toSnapshot(row) : undefined;
  }

  protected async insertStore(params: {
    definition: StoreDefinition;
    id: string;
    snapshot: StoreSnapshot<unknown>;
  }): Promise<StoreSnapshot<unknown>> {
    return runTransaction(this.db, () => {
      const row = this.getStoreRow(params.definition.name, params.id);
      if (row) return toSnapshot(row);
      this.insertStoreRow({
        storeName: params.definition.name,
        storeId: params.id,
        instanceId: params.snapshot.instanceId,
        version: params.snapshot.version,
        state: params.snapshot.state,
      });
      return cloneStoreState(params.snapshot);
    });
  }

  protected async getAppliedStoreStep(params: {
    definition: StoreDefinition;
    id: string;
    stepId: StoreStepId;
  }): Promise<{ result: unknown } | undefined> {
    const row = this.getAppliedStepRow({
      storeName: params.definition.name,
      storeId: params.id,
      stepId: params.stepId,
    });
    return row ? { result: decodeStoreValue(row.result) } : undefined;
  }

  protected async commitStoreMutation(
    mutation: StoreMutation
  ): Promise<StoreMutationCommitResult> {
    return runTransaction(this.db, (): StoreMutationCommitResult => {
      if (mutation.stepId) {
        const applied = this.getAppliedStepRow({
          storeName: mutation.definition.name,
          storeId: mutation.id,
          stepId: mutation.stepId,
        });
        if (applied) {
          return {
            status: "already-applied",
            result: decodeStoreValue(applied.result),
          };
        }
      }

      const row = this.getStoreRow(mutation.definition.name, mutation.id);
      if (!row && !mutation.expected.created) return { status: "missing" };
      if (
        row &&
        (mutation.expected.created ||
          row.instance_id !== mutation.expected.instanceId ||
          row.version !== mutation.expected.version)
      ) {
        return { status: "conflict", snapshot: toSnapshot(row) };
      }

      const version = mutation.expected.version + 1;
      if (mutation.expected.created) {
        this.insertStoreRow({
          storeName: mutation.definition.name,
          storeId: mutation.id,
          instanceId: mutation.expected.instanceId,
          version,
          state: mutation.nextState,
        });
      } else {
        const changed = this.db
          .query(
            `UPDATE stores
             SET version = $version, state = $state
             WHERE instance_id = $instanceId AND version = $expectedVersion`
          )
          .run({
            $instanceId: mutation.expected.instanceId,
            $expectedVersion: mutation.expected.version,
            $version: version,
            $state: encodeStoreValue(mutation.nextState),
          });
        if (Number(changed.changes) !== 1) {
          throw new Error("Store changed during its mutation transaction");
        }
      }

      if (mutation.stepId) {
        this.insertAppliedStepRow({
          storeName: mutation.definition.name,
          storeId: mutation.id,
          stepId: mutation.stepId,
          result: encodeStoreValue(mutation.result),
        });
      }

      // Wakes commit with the mutation. Waiters stay registered until the
      // heap records their step's result; a replay whose selector still does
      // not match re-registers with a newer sinceVersion.
      const executionIds = this.selectMatchingExecutionIds({
        storeName: mutation.definition.name,
        storeId: mutation.id,
        version,
        changedPaths: mutation.changedPaths,
      });
      for (const executionId of executionIds) {
        this.executions.wakeInTransaction(executionId);
      }

      return { status: "committed" };
    });
  }

  async listStores<Schema extends StandardSchemaV1>(
    definition: StoreDefinition<Schema>
  ): Promise<string[]> {
    const rows = this.db
      .query<StoreIdRow>(
        `SELECT store_id FROM stores
         WHERE store_name = $storeName
         ORDER BY store_id ASC`
      )
      .all({ $storeName: definition.name });
    return rows.map((row) => row.store_id);
  }

  async deleteStore<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
  }): Promise<void> {
    runTransaction(this.db, () => {
      this.db
        .query(
          `DELETE FROM stores WHERE store_name = $storeName AND store_id = $storeId`
        )
        .run({
          $storeName: params.definition.name,
          $storeId: params.id,
        });
      this.storeWaitersDao.deleteStoreWaiters(params.definition.name, params.id);
    });
  }

  protected async commitStoreDeletion(
    deletion: StoreDeletion
  ): Promise<StoreMutationCommitResult> {
    return runTransaction(this.db, (): StoreMutationCommitResult => {
      if (deletion.stepId) {
        const applied = this.getAppliedStepRow({
          storeName: deletion.definition.name,
          storeId: deletion.id,
          stepId: deletion.stepId,
        });
        if (applied) {
          return {
            status: "already-applied",
            result: decodeStoreValue(applied.result),
          };
        }
      }

      const row = this.getStoreRow(deletion.definition.name, deletion.id);
      if (!row) return { status: "missing" };
      if (
        row.instance_id !== deletion.expected.instanceId ||
        row.version !== deletion.expected.version
      ) {
        return { status: "conflict", snapshot: toSnapshot(row) };
      }

      this.storeWaitersDao.deleteStoreWaiters(deletion.definition.name, deletion.id);
      this.db
        .query(`DELETE FROM stores WHERE instance_id = $instanceId`)
        .run({ $instanceId: row.instance_id });
      if (deletion.stepId) {
        this.insertAppliedStepRow({
          storeName: deletion.definition.name,
          storeId: deletion.id,
          stepId: deletion.stepId,
          result: encodeStoreValue(deletion.result),
        });
      }
      return { status: "committed" };
    });
  }

  async registerWaiter(waiter: StoreWaiter): Promise<void> {
    runTransaction(this.db, () => {
      this.storeWaitersDao.upsertWaiter(waiter);

      // Lost-wakeup guard: if an update committed between the caller's
      // getStore and this registration, the version has already advanced
      // past sinceVersion and no future update is guaranteed. Request an
      // immediate wake – the replay re-evaluates the selector, so a
      // spurious wake is safe.
      const row = this.getStoreRow(waiter.storeName, waiter.storeId);
      if (
        !row ||
        row.instance_id !== waiter.instanceId ||
        row.version > waiter.sinceVersion
      ) {
        this.executions.wakeInTransaction(waiter.executionId);
      }
    });
  }

  private setupDb() {
    this.createStoresTable();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS store_applied_steps (
        store_name TEXT NOT NULL,
        store_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (store_name, store_id, execution_id, step_key)
      );
    `);
  }

  private createStoresTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS stores (
        instance_id TEXT PRIMARY KEY,
        store_name TEXT NOT NULL,
        store_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        UNIQUE (store_name, store_id)
      )
    `);
  }

  private getAppliedStepRow(params: {
    storeName: string;
    storeId: string;
    stepId: StoreStepId;
  }) {
    return this.db
      .query<AppliedStepRow>(
        `SELECT result FROM store_applied_steps
         WHERE store_name = $storeName
           AND store_id = $storeId
           AND execution_id = $executionId
           AND step_key = $stepKey`
      )
      .get({
        $storeName: params.storeName,
        $storeId: params.storeId,
        $executionId: params.stepId.executionId,
        $stepKey: params.stepId.stepKey,
      });
  }

  private insertAppliedStepRow(params: {
    storeName: string;
    storeId: string;
    stepId: StoreStepId;
    result: string;
  }) {
    this.db
      .query(
        `INSERT INTO store_applied_steps
           (store_name, store_id, execution_id, step_key, result)
         VALUES
           ($storeName, $storeId, $executionId, $stepKey, $result)`
      )
      .run({
        $storeName: params.storeName,
        $storeId: params.storeId,
        $executionId: params.stepId.executionId,
        $stepKey: params.stepId.stepKey,
        $result: params.result,
      });
  }

  private getStoreRow(storeName: string, storeId: string) {
    return this.db
      .query<StoreRow>(
        `SELECT instance_id, state, version FROM stores
         WHERE store_name = $storeName AND store_id = $storeId`
      )
      .get({
        $storeName: storeName,
        $storeId: storeId,
      });
  }

  /** Executions with a waiter that the commit at `version` satisfies. */
  private selectMatchingExecutionIds(params: {
    storeName: string;
    storeId: string;
    version: number;
    changedPaths: StorePath[];
  }): Set<string> {
    const executionIds = new Set<string>();
    const rows = this.storeWaitersDao.getStoreWaiters(
      params.storeName,
      params.storeId
    );

    for (const row of rows) {
      if (row.since_version >= params.version) continue;

      const readPaths = JSON.parse(row.read_paths) as StorePath[];
      if (!storePathsIntersect(readPaths, params.changedPaths)) continue;

      executionIds.add(row.execution_id);
    }

    return executionIds;
  }

  private insertStoreRow(params: {
    storeName: string;
    storeId: string;
    instanceId: string;
    version: number;
    state: unknown;
  }) {
    this.db
      .query(
        `INSERT INTO stores (instance_id, store_name, store_id, version, state)
         VALUES ($instanceId, $storeName, $storeId, $version, $state)`
      )
      .run({
        $instanceId: params.instanceId,
        $storeName: params.storeName,
        $storeId: params.storeId,
        $version: params.version,
        $state: encodeStoreValue(params.state),
      });
  }
}

function toSnapshot(row: StoreRow) {
  return {
    state: decodeStoreValue(row.state),
    instanceId: row.instance_id,
    version: row.version,
  };
}
