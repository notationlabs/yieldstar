import {
  isLeaseCurrent,
  type ExecutionLease,
  type HeapClient,
  type HeapRecord,
  type LeaseLost,
} from "@yieldstar/core";
import { ExecutionsDao } from "./dao/executions-dao";
import { StepResponsesDao } from "./dao/step-response-dao";
import { StoreWaitersDao } from "./dao/store-waiters-dao";
import type { SqliteDriver } from "./sqlite-driver";
import { runTransaction } from "./sqlite-transaction";

export class SqliteHeapClient implements HeapClient {
  private db: SqliteDriver;
  private executionsDao: ExecutionsDao;
  private stepResponsesDao: StepResponsesDao;
  private storeWaitersDao: StoreWaitersDao;

  constructor(db: SqliteDriver) {
    this.db = db;
    this.executionsDao = new ExecutionsDao(db);
    this.stepResponsesDao = new StepResponsesDao(db);
    this.storeWaitersDao = new StoreWaitersDao(db);
  }

  async getAllSteps() {
    return this.stepResponsesDao.getAllSteps();
  }

  async deleteAll() {
    this.stepResponsesDao.deleteAll();
  }

  async readStep(params: { executionId: string; stepKey: string }) {
    const result = this.stepResponsesDao.getLatestStepResponse(
      params.executionId,
      params.stepKey
    );

    if (!result) {
      return null;
    }

    return {
      stepResponseJson: result.step_response,
      meta: {
        attempt: result.step_attempt,
        done: Boolean(result.step_done),
      },
    };
  }

  /**
   * Checks the lease against the `executions` row and writes the step record
   * in one IMMEDIATE transaction, so no claim can interleave between them.
   */
  async writeStep(params: {
    lease: ExecutionLease;
    stepKey: string;
    stepAttempt: number;
    done: boolean;
    stepResponseJson: string;
  }): Promise<HeapRecord | LeaseLost> {
    const { lease, stepKey, stepAttempt, done, stepResponseJson } = params;
    const { executionId } = lease;
    return runTransaction(this.db, () => {
      const state = this.executionsDao.getState(executionId);
      if (!state || !isLeaseCurrent(state, lease)) {
        return { status: "lost" as const };
      }

      // A record never changes once written: return it as stored.
      const existing = this.stepResponsesDao.getStepResponse(
        executionId,
        stepKey,
        stepAttempt
      );
      if (existing) {
        return {
          stepResponseJson: existing.step_response,
          meta: { attempt: existing.step_attempt, done: Boolean(existing.step_done) },
        };
      }

      this.stepResponsesDao.insertStepResponse(
        executionId,
        stepKey,
        stepAttempt,
        done,
        stepResponseJson
      );
      // A waiter is deleted with the write that records its step's result.
      // Unfinished attempts (e.g. a store wait) keep the waiter they registered.
      if (done) {
        this.storeWaitersDao.deleteStepWaiters(executionId, stepKey);
      }
      return { stepResponseJson, meta: { attempt: stepAttempt, done } };
    });
  }
}
