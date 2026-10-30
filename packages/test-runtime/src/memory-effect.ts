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
  type EffectState,
  type EffectWatchRequest,
} from "@yieldstar/core";
import type { MemoryExecutionClient } from "./memory-execution";

/**
 * In-memory effect records and waiters. Every operation runs synchronously
 * after validation, so each is atomic with the wakes it requests.
 */
export class MemoryEffectClient implements EffectClient {
  private effects = new Map<string, EffectState>();
  /** Keyed by effect ID, then by execution ID and step key. */
  private waiters = new Map<string, Map<string, EffectWatchRequest>>();
  private executions: Pick<MemoryExecutionClient, "wakeNow">;
  private clock: () => number;

  constructor(params: {
    executions: Pick<MemoryExecutionClient, "wakeNow">;
    clock?: () => number;
  }) {
    this.executions = params.executions;
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = params.clock ?? (() => Date.now());
  }

  async begin(request: EffectBeginRequest): Promise<EffectBeginResult> {
    const begin = prepareEffectBegin(request);
    const state = this.effects.get(begin.effectId);
    if (state) return matchEffectBegin(state, begin);
    this.effects.set(begin.effectId, createEffectState(begin));
    return { status: "new" };
  }

  async settle(request: EffectSettleRequest): Promise<EffectSettleResult> {
    const settle = prepareEffectSettle(request);
    const state = this.effects.get(settle.effectId);
    if (!state) throw effectNotFound(settle.effectId);
    const settled = settleEffect(state, settle, this.clock());
    this.effects.set(settle.effectId, settled.state);
    if (settled.wake) {
      for (const waiter of this.waiters.get(settle.effectId)?.values() ?? []) {
        this.executions.wakeNow(waiter.executionId);
      }
    }
    return settled.result;
  }

  async watch(request: EffectWatchRequest): Promise<void> {
    const watch = prepareEffectWatch(request);
    const state = this.effects.get(watch.effectId);
    if (!state) throw effectNotFound(watch.effectId);
    let waiters = this.waiters.get(watch.effectId);
    if (!waiters) this.waiters.set(watch.effectId, (waiters = new Map()));
    waiters.set(waiterKey(watch), watch);
    if (state.status !== "pending") this.executions.wakeNow(watch.executionId);
  }

  async getEffect(effectId: string): Promise<EffectRecord | undefined> {
    const state = this.effects.get(effectId);
    return state ? toEffectRecord(state) : undefined;
  }

  /**
   * Deletes the waiters a step registered. Called synchronously when the heap
   * records the step's result, so the waiter goes with that write.
   */
  deleteWaitersForStep(params: { executionId: string; stepKey: string }) {
    const key = waiterKey(params);
    for (const [effectId, waiters] of this.waiters) {
      waiters.delete(key);
      if (waiters.size === 0) this.waiters.delete(effectId);
    }
  }
}

function waiterKey(step: { executionId: string; stepKey: string }) {
  return JSON.stringify([step.executionId, step.stepKey]);
}
