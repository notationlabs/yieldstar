import {
  acknowledgeExecution,
  claimExecution,
  createExecutionState,
  createStartedExecution,
  executionIdConflict,
  executionNotFound,
  isExecutionClaimable,
  isLeaseCurrent,
  matchStartRequest,
  nextClaimAt,
  prepareExecutionAdmission,
  prepareExecutionStart,
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
  type ExecutionStartRequest,
  type ExecutionStartResult,
  type ExecutionReleaseResult,
  type ExecutionRenewResult,
  type ExecutionState,
  type ExecutionWakeResult,
  type StartRequestState,
  type WorkflowRunOutcome,
} from "@yieldstar/core";

/**
 * In-memory execution records. Every operation reads, transitions and writes
 * a record synchronously, so each one is atomic like a database transaction.
 * Records are stored encoded, so reads are isolated from caller mutation.
 */
export class MemoryExecutionClient implements ExecutionClient {
  private executions = new Map<string, ExecutionState>();
  /** Keyed by startRequestKey. */
  private startRequests = new Map<string, StartRequestState>();
  private clock: () => number;

  constructor(options?: { clock?: () => number }) {
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options?.clock ?? (() => Date.now());
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
    if (this.executions.has(prepared.executionId)) {
      return executionIdConflict(prepared.executionId);
    }
    this.executions.set(
      prepared.executionId,
      createExecutionState({
        executionId: prepared.executionId,
        workflowId: request.workflowId,
        encoded: prepared.encoded,
        now: this.clock(),
      })
    );
    return { status: "accepted", executionId: prepared.executionId };
  }

  async start(request: ExecutionStartRequest): Promise<ExecutionStartResult> {
    const prepared = prepareExecutionStart(request);
    if (!prepared.ok) return prepared.result;
    const { start } = prepared;
    const key = startRequestKey(start.callerExecutionId, start.stepKey);

    const recorded = this.startRequests.get(key);
    if (recorded) return matchStartRequest(recorded, start);

    const caller = this.executions.get(start.callerExecutionId);
    if (!caller) {
      throw new Error(
        `Cannot start a workflow from execution "${start.callerExecutionId}": it does not exist`
      );
    }
    let created = createStartedExecution({ start, caller, now: this.clock() });
    while (this.executions.has(created.target.executionId)) {
      created = createStartedExecution({ start, caller, now: this.clock() });
    }
    this.executions.set(created.target.executionId, created.target);
    this.startRequests.set(key, created.startRequest);
    return { status: "accepted", executionId: created.target.executionId };
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    const state = this.executions.get(executionId);
    return state ? toExecutionRecord(state, this.clock()) : undefined;
  }

  async requestWake(request: {
    executionId: string;
    wakeAt: number;
  }): Promise<ExecutionWakeResult> {
    const state = this.executions.get(request.executionId);
    if (!state) return executionNotFound(request.executionId);
    const next = requestExecutionWake(state, request.wakeAt, this.clock());
    if (!next) return { status: "ignored" };
    this.executions.set(request.executionId, next);
    return { status: "requested" };
  }

  /**
   * Synchronously makes an execution due now, for writes that must request a
   * wake in the same critical section as their own commit (store waiters).
   * Unknown and terminal executions are ignored.
   */
  wakeNow(executionId: string) {
    const state = this.executions.get(executionId);
    if (!state) return;
    const now = this.clock();
    const next = requestExecutionWake(state, now, now);
    if (next) this.executions.set(executionId, next);
  }

  /**
   * Synchronously checks that `lease` is current, for fenced writes that must
   * check the token in the same critical section as their own write (heap
   * step records).
   */
  isLeaseCurrent(lease: ExecutionLease): boolean {
    const state = this.executions.get(lease.executionId);
    return state !== undefined && isLeaseCurrent(state, lease);
  }

  async claimDue(request: {
    limit: number;
    duration: number;
    executionIds?: readonly string[];
  }): Promise<ExecutionLease[]> {
    const now = this.clock();
    const ids = request.executionIds && new Set(request.executionIds);
    const claimable = [...this.executions.values()]
      .filter(
        (state) =>
          (!ids || ids.has(state.executionId)) &&
          isExecutionClaimable(state, now)
      )
      .map((state) => ({ state, at: nextClaimAt(state)! }))
      .sort(
        (a, b) =>
          a.at - b.at ||
          (a.state.executionId < b.state.executionId ? -1 : 1)
      )
      .slice(0, Math.max(0, request.limit));

    return claimable.map(({ state }) => {
      const claimed = claimExecution(state, { now, duration: request.duration });
      this.executions.set(state.executionId, claimed.state);
      return claimed.lease;
    });
  }

  async renew(request: {
    lease: ExecutionLease;
    duration: number;
  }): Promise<ExecutionRenewResult> {
    const state = this.executions.get(request.lease.executionId);
    if (!state) return { status: "lost" };
    const renewed = renewExecutionLease(state, {
      lease: request.lease,
      duration: request.duration,
      now: this.clock(),
    });
    this.executions.set(state.executionId, renewed.state);
    return renewed.result;
  }

  async release(request: {
    lease: ExecutionLease;
  }): Promise<ExecutionReleaseResult> {
    const state = this.executions.get(request.lease.executionId);
    if (!state) return { status: "lost" };
    const released = releaseExecutionLease(state, {
      lease: request.lease,
      now: this.clock(),
    });
    this.executions.set(state.executionId, released.state);
    return released.result;
  }

  async acknowledge(request: {
    lease: ExecutionLease;
    outcome: WorkflowRunOutcome;
  }): Promise<ExecutionAcknowledgeResult> {
    const state = this.executions.get(request.lease.executionId);
    if (!state) return { status: "lost" };
    const { state: next, result } = acknowledgeExecution(state, {
      lease: request.lease,
      outcome: request.outcome,
      now: this.clock(),
    });
    this.executions.set(state.executionId, next);
    return result;
  }
}

function startRequestKey(callerExecutionId: string, stepKey: string) {
  return JSON.stringify([callerExecutionId, stepKey]);
}
