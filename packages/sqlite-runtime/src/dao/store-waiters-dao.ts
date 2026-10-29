import type { StoreWaiter } from "@yieldstar/core";
import type { SqliteDriver } from "../sqlite-driver";

export class StoreWaiterRow {
  workflow_id!: string;
  execution_id!: string;
  step_key!: string;
  store_name!: string;
  store_id!: string;
  since_version!: number;
  read_paths!: string;
}

/**
 * Store waiters live in the same database as step records, so the heap can
 * delete a waiter in the same transaction that records its step's result.
 * Callers own the surrounding transaction.
 */
export class StoreWaitersDao {
  private db: SqliteDriver;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.setupDb();
  }

  setupDb() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS store_waiters (
        workflow_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        store_name TEXT NOT NULL,
        store_id TEXT NOT NULL,
        since_version INTEGER NOT NULL,
        read_paths TEXT NOT NULL,
        PRIMARY KEY (store_name, store_id, execution_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS idx_store_waiters_step
      ON store_waiters(execution_id, step_key);
    `);
  }

  upsertWaiter(waiter: StoreWaiter) {
    this.db
      .query(
        `INSERT INTO store_waiters
           (workflow_id, execution_id, step_key, store_name, store_id, since_version, read_paths)
         VALUES
           ($workflowId, $executionId, $stepKey, $storeName, $storeId, $sinceVersion, $readPaths)
         ON CONFLICT(store_name, store_id, execution_id, step_key)
         DO UPDATE SET
           workflow_id = excluded.workflow_id,
           since_version = excluded.since_version,
           read_paths = excluded.read_paths`
      )
      .run({
        $workflowId: waiter.workflowId,
        $executionId: waiter.executionId,
        $stepKey: waiter.stepKey,
        $storeName: waiter.storeName,
        $storeId: waiter.storeId,
        $sinceVersion: waiter.sinceVersion,
        $readPaths: JSON.stringify(waiter.readPaths),
      });
  }

  getStoreWaiters(storeName: string, storeId: string) {
    return this.db
      .query<StoreWaiterRow>(
        `SELECT * FROM store_waiters
         WHERE store_name = $storeName AND store_id = $storeId`
      )
      .all({ $storeName: storeName, $storeId: storeId });
  }

  deleteStoreWaiters(storeName: string, storeId: string) {
    this.db
      .query(
        `DELETE FROM store_waiters WHERE store_name = $storeName AND store_id = $storeId`
      )
      .run({ $storeName: storeName, $storeId: storeId });
  }

  deleteStepWaiters(executionId: string, stepKey: string) {
    this.db
      .query(
        `DELETE FROM store_waiters WHERE execution_id = $executionId AND step_key = $stepKey`
      )
      .run({ $executionId: executionId, $stepKey: stepKey });
  }
}
