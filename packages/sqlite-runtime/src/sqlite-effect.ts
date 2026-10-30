import {
  createEffectState,
  effectNotFound,
  matchEffectBegin,
  prepareEffectBegin,
  prepareEffectSettle,
  prepareEffectWatch,
  settleEffect,
  toEffectRecord,
  type EffectBeginRequest,
  type EffectBeginResult,
  type EffectClient,
  type EffectRecord,
  type EffectSettleRequest,
  type EffectSettleResult,
  type EffectWatchRequest,
} from "@yieldstar/core";
import { EffectWaitersDao } from "./dao/effect-waiters-dao";
import { EffectsDao } from "./dao/effects-dao";
import type { SqliteDriver } from "./sqlite-driver";
import { SqliteExecutionClient } from "./sqlite-execution";
import { runTransaction } from "./sqlite-transaction";

/**
 * Effect records and waiters in the same database as the execution records,
 * so a settlement and the wakes of its waiters commit in one IMMEDIATE
 * transaction.
 */
export class SqliteEffectClient implements EffectClient {
  private db: SqliteDriver;
  private executions: SqliteExecutionClient;
  private effectsDao: EffectsDao;
  private effectWaitersDao: EffectWaitersDao;
  private clock: () => number;

  /**
   * @param params.executions The execution client whose records waiters wake.
   * Defaults to one over `db` with the default clock; SqliteRuntime passes
   * its own so both share the runtime clock.
   */
  constructor(params: {
    db: SqliteDriver;
    executions?: SqliteExecutionClient;
    clock?: () => number;
  }) {
    this.db = params.db;
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = params.clock ?? (() => Date.now());
    this.executions =
      params.executions ?? new SqliteExecutionClient(params.db, { clock: this.clock });
    this.effectsDao = new EffectsDao(params.db);
    this.effectWaitersDao = new EffectWaitersDao(params.db);
  }

  async begin(request: EffectBeginRequest): Promise<EffectBeginResult> {
    const begin = prepareEffectBegin(request);
    return runTransaction(this.db, () => {
      const state = this.effectsDao.getState(begin.effectId);
      if (state) return matchEffectBegin(state, begin);
      this.effectsDao.insertState(createEffectState(begin));
      return { status: "new" as const };
    });
  }

  async settle(request: EffectSettleRequest): Promise<EffectSettleResult> {
    const settle = prepareEffectSettle(request);
    return runTransaction(this.db, () => {
      const state = this.effectsDao.getState(settle.effectId);
      if (!state) throw effectNotFound(settle.effectId);
      const settled = settleEffect(state, settle, this.clock());
      if (settled.state !== state) this.effectsDao.updateState(state, settled.state);
      if (settled.wake) {
        for (const executionId of this.effectWaitersDao.getWaitingExecutionIds(
          settle.effectId
        )) {
          this.executions.wakeInTransaction(executionId);
        }
      }
      return settled.result;
    });
  }

  async watch(request: EffectWatchRequest): Promise<void> {
    const watch = prepareEffectWatch(request);
    runTransaction(this.db, () => {
      const state = this.effectsDao.getState(watch.effectId);
      if (!state) throw effectNotFound(watch.effectId);
      this.effectWaitersDao.upsertWaiter(watch);
      if (state.status !== "pending") {
        this.executions.wakeInTransaction(watch.executionId);
      }
    });
  }

  async getEffect(effectId: string): Promise<EffectRecord | undefined> {
    const state = this.effectsDao.getState(effectId);
    return state ? toEffectRecord(state) : undefined;
  }
}
