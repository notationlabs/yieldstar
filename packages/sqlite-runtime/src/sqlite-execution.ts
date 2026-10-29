import {
  acknowledgeExecution,
  claimExecution,
  createExecutionState,
  executionIdConflict,
  executionNotFound,
  isExecutionClaimable,
  prepareExecutionAdmission,
  releaseExecutionLease,
  renewExecutionLease,
  requestExecutionWake,
  toExecutionRecord,
  type ExecutionAcknowledgeResult,
  type ExecutionAdmissionRequest,
  type ExecutionAdmissionResult,
  type ExecutionClient,
  type ExecutionLease,
  type ExecutionRecord,
  type ExecutionReleaseResult,
  type ExecutionRenewResult,
  type ExecutionState,
  type ExecutionWakeResult,
  type WorkflowRunOutcome,
} from "@yieldstar/core";
import { ExecutionsDao } from "./dao/executions-dao";
import type { SqliteDriver } from "./sqlite-driver";
import { runTransaction } from "./sqlite-transaction";

export type SqliteExecutionClientOptions = {
  /** Reads the current time. Defaults to `Date.now`. */
  clock?: () => number;
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

  constructor(db: SqliteDriver, options: SqliteExecutionClientOptions = {}) {
    this.db = db;
    this.executionsDao = new ExecutionsDao(db);
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options.clock ?? (() => Date.now());
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
    return state ? toExecutionRecord(state, this.clock()) : undefined;
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

  async claimDue(request: {
    limit: number;
    duration: number;
  }): Promise<ExecutionLease[]> {
    if (request.limit <= 0) return [];
    // The IMMEDIATE transaction holds the write lock, so concurrent claims from
    // any process sharing the file see each other's leases.
    return runTransaction(this.db, () => {
      const now = this.clock();
      const leases: ExecutionLease[] = [];

      for (const executionId of this.executionsDao.getClaimableIds(
        now,
        request.limit
      )) {
        const state = this.executionsDao.getState(executionId);
        if (!state || !isExecutionClaimable(state, now)) continue;

        const claimed = claimExecution(state, {
          now,
          duration: request.duration,
        });
        this.executionsDao.updateState(claimed.state);
        leases.push(claimed.lease);
      }

      return leases;
    });
  }

  async renew(request: {
    lease: ExecutionLease;
    duration: number;
  }): Promise<ExecutionRenewResult> {
    return this.transition(request.lease, (state) =>
      renewExecutionLease(state, {
        lease: request.lease,
        duration: request.duration,
        now: this.clock(),
      })
    );
  }

  async release(request: {
    lease: ExecutionLease;
  }): Promise<ExecutionReleaseResult> {
    return this.transition(request.lease, (state) =>
      releaseExecutionLease(state, { lease: request.lease, now: this.clock() })
    );
  }

  async acknowledge(request: {
    lease: ExecutionLease;
    outcome: WorkflowRunOutcome;
  }): Promise<ExecutionAcknowledgeResult> {
    return this.transition(request.lease, (state) =>
      acknowledgeExecution(state, {
        lease: request.lease,
        outcome: request.outcome,
        now: this.clock(),
      })
    );
  }

  /**
   * Applies a fenced transition in one transaction. The transition checks the
   * lease against the stored token, so the check and the write are atomic.
   */
  private transition<R>(
    lease: ExecutionLease,
    fn: (state: ExecutionState) => { state: ExecutionState; result: R }
  ): Promise<R | { status: "lost" }> {
    return Promise.resolve(
      runTransaction(this.db, () => {
        const state = this.executionsDao.getState(lease.executionId);
        if (!state) return { status: "lost" as const };
        const next = fn(state);
        if (next.state !== state) this.executionsDao.updateState(next.state);
        return next.result;
      })
    );
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
