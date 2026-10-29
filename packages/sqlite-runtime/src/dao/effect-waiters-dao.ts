import type { SqliteDriver } from "../sqlite-driver";

class EffectWaiterRow {
  execution_id!: string;
}

/**
 * Effect waiters live in the same database as step records, so the heap can
 * delete a waiter in the same transaction that records its step's result.
 * Callers own the surrounding transaction.
 */
export class EffectWaitersDao {
  private db: SqliteDriver;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.setupDb();
  }

  setupDb() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS effect_waiters (
        effect_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        PRIMARY KEY (effect_id, execution_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS idx_effect_waiters_step
      ON effect_waiters(execution_id, step_key);
    `);
  }

  upsertWaiter(waiter: { effectId: string; executionId: string; stepKey: string }) {
    this.db
      .query(
        `INSERT INTO effect_waiters (effect_id, execution_id, step_key)
         VALUES ($effectId, $executionId, $stepKey)
         ON CONFLICT(effect_id, execution_id, step_key) DO NOTHING`
      )
      .run({
        $effectId: waiter.effectId,
        $executionId: waiter.executionId,
        $stepKey: waiter.stepKey,
      });
  }

  getWaitingExecutionIds(effectId: string): string[] {
    return this.db
      .query<EffectWaiterRow>(
        `SELECT DISTINCT execution_id FROM effect_waiters WHERE effect_id = $effectId`
      )
      .all({ $effectId: effectId })
      .map((row) => row.execution_id);
  }

  deleteStepWaiters(executionId: string, stepKey: string) {
    this.db
      .query(
        `DELETE FROM effect_waiters WHERE execution_id = $executionId AND step_key = $stepKey`
      )
      .run({ $executionId: executionId, $stepKey: stepKey });
  }
}
