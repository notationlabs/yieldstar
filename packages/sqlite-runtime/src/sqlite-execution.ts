import {
  acknowledgeExecution,
  claimExecution,
  createExecutionState,
  DEFAULT_REDELIVERY_TIMEOUT,
  executionIdConflict,
  executionNotFound,
  isExecutionClaimable,
  prepareExecutionAdmission,
  requestExecutionWake,
  toExecutionRecord,
  type ExecutionAcknowledgeResult,
  type ExecutionAdmissionRequest,
  type ExecutionAdmissionResult,
  type ExecutionClient,
  type ExecutionDelivery,
  type ExecutionRecord,
  type ExecutionWakeResult,
  type WorkflowRunOutcome,
} from "@yieldstar/core";
import { ExecutionsDao } from "./dao/executions-dao";
import type { SqliteDriver } from "./sqlite-driver";
import { runTransaction } from "./sqlite-transaction";

export type SqliteExecutionClientOptions = {
  /** Reads the current time. Defaults to `Date.now`. */
  clock?: () => number;
  /**
   * How long a claimed delivery may go unacknowledged before `claimDue`
   * returns the execution again.
   * @default DEFAULT_REDELIVERY_TIMEOUT
   */
  redeliveryTimeout?: number;
};

/**
 * Execution records in the `executions` table. Every operation loads a row,
 * applies a pure transition from @yieldstar/core and writes it back inside one
 * IMMEDIATE transaction, so processes sharing the database file see the same
 * semantics as the memory runtime.
 */
export class SqliteExecutionClient implements ExecutionClient {
  private db: SqliteDriver;
  private executionsDao: ExecutionsDao;
  private clock: () => number;
  private redeliveryTimeout: number;

  constructor(db: SqliteDriver, options: SqliteExecutionClientOptions = {}) {
    this.db = db;
    this.executionsDao = new ExecutionsDao(db);
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options.clock ?? (() => Date.now());
    this.redeliveryTimeout =
      options.redeliveryTimeout ?? DEFAULT_REDELIVERY_TIMEOUT;
  }

  async admit(
    request: ExecutionAdmissionRequest
  ): Promise<ExecutionAdmissionResult> {
    const prepared = prepareExecutionAdmission(request);
    if (!prepared.ok) {
      return {
        status: "rejected",
        code: prepared.code,
        message: prepared.message,
      };
    }

    return runTransaction(this.db, () => {
      const state = createExecutionState({
        executionId: prepared.executionId,
        workflowId: request.workflowId,
        encoded: prepared.encoded,
        now: this.clock(),
      });
      // The record is inserted already due, so it and its first wake commit
      // together.
      if (!this.executionsDao.insertState(state)) {
        return executionIdConflict(prepared.executionId);
      }
      return { status: "accepted", executionId: prepared.executionId };
    });
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    const state = this.executionsDao.getState(executionId);
    return state ? toExecutionRecord(state) : undefined;
  }

  async requestWake(request: {
    executionId: string;
    wakeAt: number;
  }): Promise<ExecutionWakeResult> {
    return runTransaction(this.db, () => {
      const state = this.executionsDao.getState(request.executionId);
      if (!state) return executionNotFound(request.executionId);

      const next = requestExecutionWake(state, request.wakeAt, this.clock());
      if (!next) return { status: "ignored" };

      this.executionsDao.updateState(next);
      return { status: "requested" };
    });
  }

  async claimDue(): Promise<ExecutionDelivery[]> {
    return runTransaction(this.db, () => {
      const now = this.clock();
      const deliveries: ExecutionDelivery[] = [];

      for (const executionId of this.executionsDao.getClaimableIds(now)) {
        const state = this.executionsDao.getState(executionId);
        if (!state || !isExecutionClaimable(state, now)) continue;

        const token = crypto.randomUUID();
        this.executionsDao.updateState(
          claimExecution(state, {
            now,
            token,
            redeliveryTimeout: this.redeliveryTimeout,
          })
        );
        deliveries.push({ executionId, token });
      }

      return deliveries;
    });
  }

  async acknowledge(request: {
    delivery: ExecutionDelivery;
    outcome: WorkflowRunOutcome;
  }): Promise<ExecutionAcknowledgeResult> {
    return runTransaction(this.db, () => {
      const executionId = request.delivery.executionId;
      const state = this.executionsDao.getState(executionId);
      if (!state) {
        throw new Error(executionNotFound(executionId).message);
      }

      const acknowledged = acknowledgeExecution(state, {
        delivery: request.delivery,
        outcome: request.outcome,
        now: this.clock(),
      });
      if (acknowledged.state !== state) {
        this.executionsDao.updateState(acknowledged.state);
      }
      return acknowledged.result;
    });
  }

  /**
   * @internal Requests a wake from inside a transaction the caller already
   * holds on the same database, so the wake commits with the caller's write
   * (e.g. a store commit). `wakeAt` defaults to the runtime clock's now.
   * Unknown and terminal executions are ignored.
   */
  wakeInTransaction(executionId: string, wakeAt: number = this.clock()) {
    const state = this.executionsDao.getState(executionId);
    if (!state) return;

    const next = requestExecutionWake(state, wakeAt, this.clock());
    if (next) this.executionsDao.updateState(next);
  }
}
