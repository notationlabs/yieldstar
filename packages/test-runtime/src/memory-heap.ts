import type {
  ExecutionLease,
  HeapClient,
  HeapRecord,
  LeaseLost,
} from "@yieldstar/core";

export class MemoryHeapClient implements HeapClient {
  /** Each step's records, latest attempt first. */
  cache: Record<string, HeapRecord[]> = {};
  private isLeaseCurrent: (lease: ExecutionLease) => boolean;
  private onStepDone?: (step: { executionId: string; stepKey: string }) => void;

  constructor(params: {
    /**
     * Checks a lease synchronously, so the token check and the write happen
     * in one critical section.
     */
    isLeaseCurrent: (lease: ExecutionLease) => boolean;
    /**
     * Called synchronously when a step's result is recorded, so the runtime
     * deletes the step's store waiters in the same write.
     */
    onStepDone?: (step: { executionId: string; stepKey: string }) => void;
  }) {
    this.isLeaseCurrent = params.isLeaseCurrent;
    this.onStepDone = params.onStepDone;
  }

  getKey(params: { executionId: string; stepKey: string }) {
    return `${params.executionId}:${params.stepKey}`;
  }

  async readStep(params: { executionId: string; stepKey: string }) {
    const attempts = this.cache[this.getKey(params)];
    if (!attempts) return null;
    return clone(attempts[0]);
  }

  async writeStep(params: {
    lease: ExecutionLease;
    stepKey: string;
    stepAttempt: number;
    done: boolean;
    stepResponseJson: string;
  }): Promise<HeapRecord | LeaseLost> {
    const { lease, stepKey, stepAttempt, done, stepResponseJson } = params;
    if (!this.isLeaseCurrent(lease)) return { status: "lost" };

    const step = { executionId: lease.executionId, stepKey };
    const key = this.getKey(step);
    const attempts = (this.cache[key] ??= []);

    // A record never changes once written: return it as stored.
    const existing = attempts.find((record) => record.meta.attempt === stepAttempt);
    if (existing) return clone(existing);

    const record: HeapRecord = {
      stepResponseJson,
      meta: { attempt: stepAttempt, done },
    };
    attempts.unshift(record);
    attempts.sort((a, b) => b.meta.attempt - a.meta.attempt);
    if (done) this.onStepDone?.(step);
    return clone(record);
  }
}

function clone(record: HeapRecord): HeapRecord {
  return { stepResponseJson: record.stepResponseJson, meta: { ...record.meta } };
}
