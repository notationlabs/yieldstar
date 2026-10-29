import type { HeapRecord, HeapClient } from "@yieldstar/core";

export class MemoryHeapClient implements HeapClient {
  cache: Record<string, HeapRecord[]> = {};
  private onStepDone?: (step: { executionId: string; stepKey: string }) => void;

  constructor(params?: {
    /**
     * Called synchronously when a step's result is recorded, so the runtime
     * deletes the step's store waiters in the same write.
     */
    onStepDone?: (step: { executionId: string; stepKey: string }) => void;
  }) {
    this.onStepDone = params?.onStepDone;
  }

  getKey(params: { executionId: string; stepKey: string }) {
    return `${params.executionId}:${params.stepKey}`;
  }

  async readStep(params: { executionId: string; stepKey: string }) {
    const attempts = this.cache[this.getKey(params)];
    if (!attempts) return null;
    return attempts[0];
  }

  async writeStep(params: {
    executionId: string;
    stepKey: string;
    stepAttempt: number;
    stepDone: boolean;
    stepResponseJson: string;
  }) {
    const { stepAttempt, stepDone, stepResponseJson, ...keyParams } = params;
    const key = this.getKey(keyParams);
    const value = {
      stepResponseJson,
      meta: {
        attempt: stepAttempt,
        done: stepDone,
      },
    };
    const attempts = this.cache[key];
    if (!attempts) this.cache[key] = [];
    this.cache[key].unshift(value);
    if (stepDone) this.onStepDone?.(keyParams);
  }
}
