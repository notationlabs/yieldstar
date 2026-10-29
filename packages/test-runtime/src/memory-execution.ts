import {
  DEFAULT_REDELIVERY_TIMEOUT,
  acknowledgeExecution,
  claimExecution,
  createExecutionState,
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
  type ExecutionState,
  type ExecutionWakeResult,
  type WorkflowRunOutcome,
} from "@yieldstar/core";

/**
 * In-memory execution records. Every operation reads, transitions and writes
 * a record synchronously, so each one is atomic like a database transaction.
 * Records are stored encoded, so reads are isolated from caller mutation.
 */
export class MemoryExecutionClient implements ExecutionClient {
  private executions = new Map<string, ExecutionState>();
  private clock: () => number;
  private redeliveryTimeout: number;

  constructor(options?: { clock?: () => number; redeliveryTimeout?: number }) {
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options?.clock ?? (() => Date.now());
    this.redeliveryTimeout =
      options?.redeliveryTimeout ?? DEFAULT_REDELIVERY_TIMEOUT;
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

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    const state = this.executions.get(executionId);
    return state ? toExecutionRecord(state) : undefined;
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

  async claimDue(): Promise<ExecutionDelivery[]> {
    const now = this.clock();
    const deliveries: ExecutionDelivery[] = [];
    for (const [executionId, state] of this.executions) {
      if (!isExecutionClaimable(state, now)) continue;
      const token = crypto.randomUUID();
      this.executions.set(
        executionId,
        claimExecution(state, {
          now,
          token,
          redeliveryTimeout: this.redeliveryTimeout,
        })
      );
      deliveries.push({ executionId, token });
    }
    return deliveries;
  }

  async acknowledge(request: {
    delivery: ExecutionDelivery;
    outcome: WorkflowRunOutcome;
  }): Promise<ExecutionAcknowledgeResult> {
    const { executionId } = request.delivery;
    const state = this.executions.get(executionId);
    if (!state) {
      throw new Error(`Execution "${executionId}" does not exist`);
    }
    const { state: next, result } = acknowledgeExecution(state, {
      delivery: request.delivery,
      outcome: request.outcome,
      now: this.clock(),
    });
    this.executions.set(executionId, next);
    return result;
  }
}
