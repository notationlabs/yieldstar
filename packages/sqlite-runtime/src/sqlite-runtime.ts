import { Runtime, type RuntimeOptions } from "@yieldstar/core";
import { SqliteExecutionClient } from "./sqlite-execution";
import { SqliteHeapClient } from "./sqlite-heap";
import { SqliteStoreClient } from "./sqlite-store";
import type { SqliteDriver } from "./sqlite-driver";

export type SqliteRuntimeOptions = RuntimeOptions & {
  /**
   * How long a claimed delivery may go unacknowledged before it is
   * delivered again.
   * @default DEFAULT_REDELIVERY_TIMEOUT
   */
  redeliveryTimeout?: number;
};

/**
 * Execution records, step records, stores and waiters in one SQLite
 * database, so every guarantee that spans them (wakes for a store commit,
 * deleting a waiter with its step's result) holds in a single transaction.
 */
export class SqliteRuntime extends Runtime {
  readonly clock: () => number;
  readonly executions: SqliteExecutionClient;
  readonly heap: SqliteHeapClient;
  readonly stores: SqliteStoreClient;

  constructor(db: SqliteDriver, options: SqliteRuntimeOptions = {}) {
    super();
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options.clock ?? (() => Date.now());
    this.executions = new SqliteExecutionClient(db, {
      ...options,
      clock: this.clock,
    });
    this.heap = new SqliteHeapClient(db);
    this.stores = new SqliteStoreClient({ db, executions: this.executions });
  }
}
