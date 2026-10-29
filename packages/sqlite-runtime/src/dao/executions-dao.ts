import type { ExecutionState, ExecutionStatus } from "@yieldstar/core";
import { nextClaimAt } from "@yieldstar/core";
import type { SqliteDriver } from "../sqlite-driver";

class ExecutionRow {
  execution_id!: string;
  workflow_id!: string;
  params!: string;
  context!: string;
  status!: ExecutionStatus;
  outcome!: string | null;
  admitted_at!: number;
  updated_at!: number;
  due_at!: number | null;
  claim_token!: string | null;
  claimed_due_at!: number | null;
  claim_expires_at!: number | null;
  next_claim_at!: number | null;
}

class ExecutionIdRow {
  execution_id!: string;
}

/**
 * Persists every ExecutionState field, plus `next_claim_at` (derived with
 * nextClaimAt) so claimDue can find due executions through an index.
 * Callers own the surrounding transaction.
 */
export class ExecutionsDao {
  private db: SqliteDriver;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.setupDb();
  }

  setupDb() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        params TEXT NOT NULL,
        context TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        admitted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        due_at INTEGER,
        claim_token TEXT,
        claimed_due_at INTEGER,
        claim_expires_at INTEGER,
        next_claim_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_executions_next_claim_at
      ON executions(next_claim_at) WHERE next_claim_at IS NOT NULL;
    `);
  }

  getState(executionId: string): ExecutionState | undefined {
    const row = this.db
      .query<ExecutionRow>(
        `SELECT * FROM executions WHERE execution_id = $executionId`
      )
      .get({ $executionId: executionId });
    return row ? toState(row) : undefined;
  }

  // `now` is a millisecond Unix timestamp from the runtime clock
  getClaimableIds(now: number) {
    return this.db
      .query<ExecutionIdRow>(
        `SELECT execution_id FROM executions
         WHERE next_claim_at IS NOT NULL AND next_claim_at <= $now
         ORDER BY next_claim_at, execution_id`
      )
      .all({ $now: now })
      .map((row) => row.execution_id);
  }

  /** Returns false when the execution ID is already in use. */
  insertState(state: ExecutionState): boolean {
    const result = this.db
      .query(
        `INSERT INTO executions (
           execution_id, workflow_id, params, context, status, outcome,
           admitted_at, updated_at, due_at, claim_token, claimed_due_at,
           claim_expires_at, next_claim_at
         ) VALUES (
           $executionId, $workflowId, $params, $context, $status, $outcome,
           $admittedAt, $updatedAt, $dueAt, $claimToken, $claimedDueAt,
           $claimExpiresAt, $nextClaimAt
         )
         ON CONFLICT(execution_id) DO NOTHING`
      )
      .run(toBindings(state));
    return Number(result.changes) === 1;
  }

  updateState(state: ExecutionState) {
    this.db
      .query(
        `UPDATE executions SET
           workflow_id = $workflowId,
           params = $params,
           context = $context,
           status = $status,
           outcome = $outcome,
           admitted_at = $admittedAt,
           updated_at = $updatedAt,
           due_at = $dueAt,
           claim_token = $claimToken,
           claimed_due_at = $claimedDueAt,
           claim_expires_at = $claimExpiresAt,
           next_claim_at = $nextClaimAt
         WHERE execution_id = $executionId`
      )
      .run(toBindings(state));
  }
}

function toState(row: ExecutionRow): ExecutionState {
  return {
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    params: row.params,
    context: row.context,
    status: row.status,
    outcome: row.outcome,
    admittedAt: Number(row.admitted_at),
    updatedAt: Number(row.updated_at),
    dueAt: toNumberOrNull(row.due_at),
    claimToken: row.claim_token,
    claimedDueAt: toNumberOrNull(row.claimed_due_at),
    claimExpiresAt: toNumberOrNull(row.claim_expires_at),
  };
}

function toBindings(state: ExecutionState) {
  return {
    $executionId: state.executionId,
    $workflowId: state.workflowId,
    $params: state.params,
    $context: state.context,
    $status: state.status,
    $outcome: state.outcome,
    $admittedAt: state.admittedAt,
    $updatedAt: state.updatedAt,
    $dueAt: state.dueAt,
    $claimToken: state.claimToken,
    $claimedDueAt: state.claimedDueAt,
    $claimExpiresAt: state.claimExpiresAt,
    $nextClaimAt: nextClaimAt(state),
  };
}

function toNumberOrNull(value: number | null) {
  return value === null ? null : Number(value);
}
