import type { Logger } from "pino";
import type { WorkflowInvoker } from "../base/invoker";
import type { Runtime } from "../base/runtime";
import type {
  ExecutionAcknowledgeResult,
  ExecutionDelivery,
} from "../base/execution";
import { isTerminalExecutionStatus } from "../base/execution";

/**
 * The only component that delivers executions. It claims due executions,
 * reads each event from its record, hands it to the invoker, and acknowledges
 * the outcome. A delivery that rejects is not acknowledged: its wakes stay
 * pending and the runtime redelivers it after its redelivery timeout.
 */
export class ExecutionDispatcher {
  private runtime: Runtime;
  private invoker: WorkflowInvoker;
  private logger: Logger;
  private pollInterval: number;
  private keepAlive: boolean;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = new Set<Promise<void>>();

  constructor(
    runtime: Runtime,
    options: {
      invoker: WorkflowInvoker;
      logger: Logger;
      /** Milliseconds between claims when nothing is due. @default 10 */
      pollInterval?: number;
      /** Whether the polling timer keeps the process alive. @default true */
      keepAlive?: boolean;
    }
  ) {
    this.runtime = runtime;
    this.invoker = options.invoker;
    this.logger = options.logger;
    this.pollInterval = options.pollInterval ?? 10;
    this.keepAlive = options.keepAlive ?? true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  /** Stops claiming and waits for in-flight deliveries to settle. */
  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Claims due executions once and starts delivering them. Resolves with the
   * number of deliveries claimed; it does not wait for them to finish.
   */
  async tick(): Promise<number> {
    const deliveries = await this.runtime.executions.claimDue();
    for (const delivery of deliveries) {
      const task = this.dispatch(delivery).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
    }
    return deliveries.length;
  }

  /** Waits for every delivery started so far to settle. */
  async drain() {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async loop() {
    if (!this.running) return;
    let claimed = 0;
    try {
      claimed = await this.tick();
    } catch (err) {
      this.logger.error({ err }, "Failed to claim due executions");
    }
    if (!this.running) return;
    this.timer = setTimeout(() => this.loop(), claimed > 0 ? 0 : this.pollInterval);
    if (!this.keepAlive) this.timer.unref?.();
  }

  private async dispatch(delivery: ExecutionDelivery) {
    const { executionId } = delivery;
    const { executions } = this.runtime;

    try {
      const record = await executions.get(executionId);
      if (!record) {
        this.logger.error({ executionId }, "Claimed execution has no record");
        return;
      }

      // A finished execution never runs again: return its recorded outcome.
      if (isTerminalExecutionStatus(record.status)) {
        const result = await executions.acknowledge({
          delivery,
          outcome: record.outcome!,
        });
        this.emit(executionId, result);
        return;
      }

      let outcome;
      try {
        outcome = await this.invoker.deliver({
          workflowId: record.workflowId,
          executionId,
          params: record.params,
          context: record.context,
        });
      } catch (err) {
        this.logger.error(
          { executionId, err },
          "Delivery failed without an outcome; it will be redelivered"
        );
        return;
      }

      const result = await executions.acknowledge({ delivery, outcome });
      this.emit(executionId, result);
    } catch (err) {
      this.logger.error({ executionId, err }, "Failed to dispatch execution");
    }
  }

  private emit(executionId: string, result: ExecutionAcknowledgeResult) {
    if (result.status === "completed") {
      this.invoker.workflowEndEmitter.emit(executionId, result.result);
    } else if (result.status === "failed") {
      this.invoker.workflowEndEmitter.emit(executionId, result.error);
    }
  }
}
