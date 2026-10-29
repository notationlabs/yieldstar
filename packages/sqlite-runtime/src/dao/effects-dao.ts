import type { EffectConflictState, EffectState } from "@yieldstar/core";
import type { SqliteDriver } from "../sqlite-driver";

class EffectRow {
  effect_id!: string;
  operation!: string;
  input!: string;
  status!: EffectState["status"];
  result!: string | null;
}

class EffectConflictRow {
  result!: string;
  conflicting_result!: string;
  reported_at!: number;
}

/**
 * Effect records and their conflict reports. Neither is deleted with an
 * execution. Callers own the surrounding transaction.
 */
export class EffectsDao {
  private db: SqliteDriver;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.setupDb();
  }

  setupDb() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS effects (
        effect_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS effect_conflicts (
        effect_id TEXT NOT NULL,
        result TEXT NOT NULL,
        conflicting_result TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        PRIMARY KEY (effect_id, conflicting_result)
      );
    `);
  }

  getState(effectId: string): EffectState | undefined {
    const row = this.db
      .query<EffectRow>(`SELECT * FROM effects WHERE effect_id = $effectId`)
      .get({ $effectId: effectId });
    if (!row) return undefined;
    const conflicts = this.db
      .query<EffectConflictRow>(
        `SELECT result, conflicting_result, reported_at FROM effect_conflicts
         WHERE effect_id = $effectId
         ORDER BY reported_at, rowid`
      )
      .all({ $effectId: effectId });
    const state: EffectState = {
      effectId: row.effect_id,
      operation: row.operation,
      input: row.input,
      status: row.status,
      conflicts: conflicts.map((conflict) => ({
        result: conflict.result,
        conflictingResult: conflict.conflicting_result,
        reportedAt: conflict.reported_at,
      })),
    };
    if (row.result !== null) state.result = row.result;
    return state;
  }

  insertState(state: EffectState) {
    this.db
      .query(
        `INSERT INTO effects (effect_id, operation, input, status, result)
         VALUES ($effectId, $operation, $input, $status, $result)`
      )
      .run({
        $effectId: state.effectId,
        $operation: state.operation,
        $input: state.input,
        $status: state.status,
        $result: state.result ?? null,
      });
  }

  /** Writes a transition from `before` to `after`: the settlement and any new conflict reports. */
  updateState(before: EffectState, after: EffectState) {
    if (before.status !== after.status || before.result !== after.result) {
      this.db
        .query(
          `UPDATE effects SET status = $status, result = $result
           WHERE effect_id = $effectId`
        )
        .run({
          $effectId: after.effectId,
          $status: after.status,
          $result: after.result ?? null,
        });
    }
    for (const conflict of after.conflicts.slice(before.conflicts.length)) {
      this.insertConflict(after.effectId, conflict);
    }
  }

  private insertConflict(effectId: string, conflict: EffectConflictState) {
    this.db
      .query(
        `INSERT INTO effect_conflicts (effect_id, result, conflicting_result, reported_at)
         VALUES ($effectId, $result, $conflictingResult, $reportedAt)`
      )
      .run({
        $effectId: effectId,
        $result: conflict.result,
        $conflictingResult: conflict.conflictingResult,
        $reportedAt: conflict.reportedAt,
      });
  }
}
