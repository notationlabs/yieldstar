import { Runtime, type RuntimeOptions } from "@yieldstar/core";
import { SqliteEffectClient } from "./sqlite-effect";
import { SqliteExecutionClient } from "./sqlite-execution";
import { SqliteHeapClient } from "./sqlite-heap";
import { SqliteStoreClient } from "./sqlite-store";
import type { SqliteDriver } from "./sqlite-driver";

export type SqliteRuntimeOptions = RuntimeOptions;

/**
 * Execution records, step records, stores, effects and waiters in one SQLite
 * database, so every guarantee that spans them (wakes for a store commit or an
 * effect settlement, deleting a waiter with its step's result) holds in a
 * single transaction.
 */
export class SqliteRuntime extends Runtime {
  readonly clock: () => number;
  readonly executions: SqliteExecutionClient;
  readonly effects: SqliteEffectClient;
  readonly heap: SqliteHeapClient;
  readonly stores: SqliteStoreClient;

  constructor(db: SqliteDriver, options: SqliteRuntimeOptions = {}) {
    super();
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options.clock ?? (() => Date.now());
    this.executions = new SqliteExecutionClient(db, { clock: this.clock });
    this.heap = new SqliteHeapClient(db);
    this.stores = new SqliteStoreClient({ db, executions: this.executions });
    this.effects = new SqliteEffectClient({
      db,
      executions: this.executions,
      clock: this.clock,
    });
  }
}
