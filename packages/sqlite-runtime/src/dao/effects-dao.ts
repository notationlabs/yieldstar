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
  status!: EffectConflictState["status"];
  result!: string;
  conflicting_status!: EffectConflictState["conflictingStatus"];
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
        status TEXT NOT NULL DEFAULT 'settled',
        result TEXT NOT NULL,
        conflicting_status TEXT NOT NULL DEFAULT 'settled',
        conflicting_result TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        PRIMARY KEY (effect_id, conflicting_result)
      );
    `);
    // Databases created before effects could fail have no status columns.
    // Every conflict report in them is between two results.
    const columns = this.db
      .query<{ name: string }>(`PRAGMA table_info(effect_conflicts)`)
      .all()
      .map((column) => column.name);
    for (const column of ["status", "conflicting_status"]) {
      if (!columns.includes(column)) {
        this.db.run(
          `ALTER TABLE effect_conflicts ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'settled'`
        );
      }
    }
  }

  getState(effectId: string): EffectState | undefined {
    const row = this.db
      .query<EffectRow>(`SELECT * FROM effects WHERE effect_id = $effectId`)
      .get({ $effectId: effectId });
    if (!row) return undefined;
    const conflicts = this.db
      .query<EffectConflictRow>(
        `SELECT status, result, conflicting_status, conflicting_result, reported_at
         FROM effect_conflicts
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
        status: conflict.status,
        result: conflict.result,
        conflictingStatus: conflict.conflicting_status,
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
        `INSERT INTO effect_conflicts
           (effect_id, status, result, conflicting_status, conflicting_result, reported_at)
         VALUES
           ($effectId, $status, $result, $conflictingStatus, $conflictingResult, $reportedAt)`
      )
      .run({
        $effectId: effectId,
        $status: conflict.status,
        $result: conflict.result,
        $conflictingStatus: conflict.conflictingStatus,
        $conflictingResult: conflict.conflictingResult,
        $reportedAt: conflict.reportedAt,
      });
  }
}
