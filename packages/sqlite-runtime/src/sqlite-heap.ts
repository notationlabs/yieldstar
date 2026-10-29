import type { HeapClient } from "@yieldstar/core";
import { StepResponsesDao } from "./dao/step-response-dao";
import { StoreWaitersDao } from "./dao/store-waiters-dao";
import type { SqliteDriver } from "./sqlite-driver";
import { runTransaction } from "./sqlite-transaction";

export class SqliteHeapClient implements HeapClient {
  private db: SqliteDriver;
  private stepResponsesDao: StepResponsesDao;
  private storeWaitersDao: StoreWaitersDao;

  constructor(db: SqliteDriver) {
    this.db = db;
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

    if (!result?.step_response) {
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

  async writeStep(params: {
    executionId: string;
    stepKey: string;
    stepAttempt: number;
    stepDone: boolean;
    stepResponseJson: string;
  }) {
    runTransaction(this.db, () => {
      this.stepResponsesDao.insertStepResponse(
        params.executionId,
        params.stepKey,
        params.stepAttempt,
        params.stepDone,
        params.stepResponseJson
      );
      // A waiter is deleted with the write that records its step's result.
      // Unfinished attempts (e.g. a store wait) keep the waiter they registered.
      if (params.stepDone) {
        this.storeWaitersDao.deleteStepWaiters(
          params.executionId,
          params.stepKey
        );
      }
    });
  }
}
