import type { Logger } from "pino";
import type { WorkflowInvoker } from "../base/invoker";
import { WorkerExitedError } from "../base/invoker";
import type { Runtime } from "../base/runtime";
import type {
  ExecutionAcknowledgeResult,
  ExecutionLease,
  WorkflowRunOutcome,
} from "../base/execution";
import { LeaseLostError, isTerminalExecutionStatus } from "../base/execution";
import { DEFAULT_LEASE_DURATION } from "./execution-state";

/** How many deliveries a dispatcher runs at once unless configured: 10. */
export const DEFAULT_DISPATCHER_CONCURRENCY = 10;

export interface DispatcherOptions {
  invoker: WorkflowInvoker;
  logger: Logger;
  /** The maximum number of deliveries this dispatcher runs at once. @default 10 */
  concurrency?: number;
  /** Milliseconds between claims when nothing is due. @default 10 */
  pollInterval?: number;
  /** Whether the dispatcher's timers keep the process alive. @default true */
  keepAlive?: boolean;
  /** How long each lease lasts unless renewed, in milliseconds. @default 30_000 */
  leaseDuration?: number;
  /**
   * Milliseconds between renewals of a delivery's lease, measured on the
   * process's timers. Must be shorter than `leaseDuration`.
   * @default leaseDuration / 3
   */
  renewInterval?: number;
}

/**
 * The only component that delivers executions. It leases due executions, reads
 * each event from its record, hands it to the invoker, and acknowledges the
 * outcome under the delivery's lease.
 *
 * - Up to `concurrency` deliveries run at once. The dispatcher claims new
 *   executions as slots free up, without waiting for earlier deliveries.
 * - It renews each lease every `renewInterval` while the delivery runs. If a
 *   renewal returns `lost`, another claim has taken over: the dispatcher stops
 *   renewing, aborts the delivery's signal so it runs no more workflow code,
 *   and neither acknowledges nor releases.
 * - A delivery that rejects is not acknowledged. If the worker exited before
 *   replying, the lease is left to expire; any other rejection is a retry
 *   reply, and the lease is released. Either way the wakes stay pending and the
 *   execution is delivered again after the redelivery delay.
 */
export class ExecutionDispatcher {
  private runtime: Runtime;
  private invoker: WorkflowInvoker;
  private logger: Logger;
  private pollInterval: number;
  private keepAlive: boolean;
  private concurrency: number;
  private leaseDuration: number;
  private renewInterval: number;
  private running = false;
  private looping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = new Set<Promise<void>>();
  /** Slots reserved by claims that have not returned yet. */
  private claiming = 0;

  constructor(runtime: Runtime, options: DispatcherOptions) {
    this.runtime = runtime;
    this.invoker = options.invoker;
    this.logger = options.logger;
    this.pollInterval = options.pollInterval ?? 10;
    this.keepAlive = options.keepAlive ?? true;
    this.concurrency = options.concurrency ?? DEFAULT_DISPATCHER_CONCURRENCY;
    this.leaseDuration = options.leaseDuration ?? DEFAULT_LEASE_DURATION;
    this.renewInterval = options.renewInterval ?? this.leaseDuration / 3;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    if (!(this.leaseDuration > 0)) {
      throw new RangeError("leaseDuration must be positive");
    }
    if (!(this.renewInterval > 0 && this.renewInterval < this.leaseDuration)) {
      throw new RangeError("renewInterval must be positive and shorter than leaseDuration");
    }
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
    await this.drain();
  }

  /** The number of deliveries running now. */
  get activeDeliveries() {
    return this.inFlight.size;
  }

  /**
   * Leases due executions, up to the free delivery slots, and starts
   * delivering them. Resolves with the number of deliveries claimed; it does
   * not wait for them to finish.
   */
  async tick(): Promise<number> {
    const slots = this.concurrency - this.inFlight.size - this.claiming;
    if (slots <= 0) return 0;
    this.claiming += slots;
    let leases: ExecutionLease[];
    try {
      leases = await this.runtime.executions.claimDue({
        limit: slots,
        duration: this.leaseDuration,
      });
    } finally {
      this.claiming -= slots;
    }
    for (const lease of leases) {
      const task: Promise<void> = this.dispatch(lease).finally(() => {
        this.inFlight.delete(task);
        // A slot is free: claim again now rather than at the next poll.
        if (this.running && !this.looping) this.schedule(0);
      });
      this.inFlight.add(task);
    }
    return leases.length;
  }

  /** Waits for every delivery started so far to settle. */
  async drain() {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.loop();
    }, delay);
    if (!this.keepAlive) this.timer.unref?.();
  }

  private async loop() {
    if (!this.running || this.looping) return;
    this.looping = true;
    let claimed = 0;
    try {
      claimed = await this.tick();
    } catch (err) {
      this.logger.error({ err }, "Failed to claim due executions");
    } finally {
      this.looping = false;
    }
    if (!this.running) return;
    // When every slot is busy, the next delivery to finish schedules a claim.
    if (this.inFlight.size + this.claiming >= this.concurrency) return;
    this.schedule(claimed > 0 ? 0 : this.pollInterval);
  }

  private async dispatch(lease: ExecutionLease) {
    const { executionId } = lease;
    const { executions } = this.runtime;
    const renewal = this.renew(lease);

    try {
      const record = await executions.get(executionId);
      if (!record) {
        this.logger.error({ executionId }, "Claimed execution has no record");
        return;
      }

      // A finished execution never runs again: return its recorded outcome.
      // Reaching a terminal status ends the lease, so no lease is current
      // here and there is nothing to acknowledge.
      if (isTerminalExecutionStatus(record.status)) {
        this.emit(executionId, record.outcome!);
        return;
      }

      let outcome: WorkflowRunOutcome;
      try {
        outcome = await this.invoker.deliver(
          {
            workflowId: record.workflowId,
            executionId,
            params: record.params,
            context: record.context,
          },
          { lease, signal: renewal.signal }
        );
      } catch (err) {
        const current = await renewal.stop();
        if (!current) return;
        if (WorkerExitedError.is(err)) {
          // The worker may have died mid-write; let the lease expire rather
          // than invite a new holder while its last writes may still land.
          this.logger.error(
            { executionId, err },
            "Worker exited without replying; the lease will expire and the execution will be redelivered"
          );
          return;
        }
        this.logger.error(
          { executionId, err },
          "Delivery failed without an outcome; releasing its lease for redelivery"
        );
        const released = await executions.release({ lease: current });
        if (released.status === "lost") this.warnLost(lease);
        return;
      }

      const current = await renewal.stop();
      if (!current) return;
      const result = await executions.acknowledge({ lease: current, outcome });
      if (result.status === "lost") {
        this.warnLost(lease);
        return;
      }
      this.emit(executionId, result);
    } catch (err) {
      this.logger.error({ executionId, err }, "Failed to dispatch execution");
    } finally {
      await renewal.stop();
    }
  }

  /**
   * Renews `lease` every `renewInterval` until stopped. `signal` aborts, with
   * a `LeaseLostError`, once a renewal returns `lost`. `stop` waits for any
   * renewal in flight and resolves with the latest lease, or `undefined` once
   * a renewal has returned `lost`.
   */
  private renew(lease: ExecutionLease) {
    const controller = new AbortController();
    let current: ExecutionLease | undefined = lease;
    let pending: Promise<void> | undefined;
    let stopped = false;
    const { executions } = this.runtime;

    const timer = setInterval(() => {
      if (stopped || pending || !current) return;
      const renewing = current;
      pending = executions
        .renew({ lease: renewing, duration: this.leaseDuration })
        .then(
          (result) => {
            if (result.status === "lost") {
              current = undefined;
              clearInterval(timer);
              this.warnLost(lease);
              controller.abort(new LeaseLostError(lease.executionId));
            } else if (current) {
              current = result.lease;
            }
          },
          (err) => {
            // Keep trying: the lease stays current until another claim
            // issues a higher token, even after it expires.
            this.logger.error(
              { executionId: lease.executionId, err },
              "Failed to renew lease"
            );
          }
        )
        .finally(() => {
          pending = undefined;
        });
    }, this.renewInterval);
    if (!this.keepAlive) timer.unref?.();

    return {
      signal: controller.signal,
      async stop() {
        stopped = true;
        clearInterval(timer);
        await pending;
        return current;
      },
    };
  }

  private warnLost(lease: ExecutionLease) {
    this.logger.warn(
      { executionId: lease.executionId, token: lease.token },
      "Lease was lost to another claim; this delivery stops without an outcome"
    );
  }

  private emit(executionId: string, result: ExecutionAcknowledgeResult) {
    if (result.status === "completed") {
      this.invoker.workflowEndEmitter.emit(executionId, result.result);
    } else if (result.status === "failed") {
      this.invoker.workflowEndEmitter.emit(executionId, result.error);
    }
  }
}
