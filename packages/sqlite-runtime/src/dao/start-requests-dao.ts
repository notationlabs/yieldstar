import type { StartRequestState } from "@yieldstar/core";
import type { SqliteDriver } from "../sqlite-driver";

class StartRequestRow {
  caller_execution_id!: string;
  step_key!: string;
  workflow_id!: string;
  params!: string | null;
  execution_id!: string;
}

/**
 * Start requests recorded by `ExecutionClient.start`, keyed by the caller's
 * execution ID and step key. Callers own the surrounding transaction, which
 * must also insert the target execution.
 */
export class StartRequestsDao {
  private db: SqliteDriver;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.setupDb();
  }

  setupDb() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS start_requests (
        caller_execution_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        params TEXT,
        execution_id TEXT NOT NULL,
        PRIMARY KEY (caller_execution_id, step_key)
      );
    `);
  }

  get(callerExecutionId: string, stepKey: string): StartRequestState | undefined {
    const row = this.db
      .query<StartRequestRow>(
        `SELECT * FROM start_requests
         WHERE caller_execution_id = $callerExecutionId AND step_key = $stepKey`
      )
      .get({ $callerExecutionId: callerExecutionId, $stepKey: stepKey });
    return row
      ? {
          callerExecutionId: row.caller_execution_id,
          stepKey: row.step_key,
          workflowId: row.workflow_id,
          params: row.params,
          executionId: row.execution_id,
        }
      : undefined;
  }

  insert(request: StartRequestState) {
    this.db
      .query(
        `INSERT INTO start_requests
           (caller_execution_id, step_key, workflow_id, params, execution_id)
         VALUES
           ($callerExecutionId, $stepKey, $workflowId, $params, $executionId)`
      )
      .run({
        $callerExecutionId: request.callerExecutionId,
        $stepKey: request.stepKey,
        $workflowId: request.workflowId,
        $params: request.params,
        $executionId: request.executionId,
      });
  }
}
