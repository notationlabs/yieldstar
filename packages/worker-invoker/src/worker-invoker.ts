import type { Logger } from "pino";
import type {
  ExecutionLease,
  WorkflowEvent,
  WorkflowInvoker,
  WorkflowRunOutcome,
} from "@yieldstar/core";
import { WorkerExitedError } from "@yieldstar/core";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deserializeError } from "serialize-error";
import type { WorkerDelivery, WorkerMessage } from "./worker";

/**
 * Runs each delivery in a forked worker process. `deliver` resolves with the
 * worker's outcome, and rejects when the delivery ends without one: a spawn
 * error, a missing handshake, an infrastructure error in the worker, or an
 * exit before replying. An exit before replying rejects with a
 * `WorkerExitedError`, so the dispatcher leaves the lease to expire instead of
 * releasing it.
 *
 * The worker exits as soon as its IPC channel to this process closes, so a
 * worker whose runtime process has died makes no further fenced writes.
 */
export function createWorkflowInvoker(params: {
  workerPath: string;
  execPath?: string;
  handshakeTimeout?: number;
  logger: Logger;
}): WorkflowInvoker {
  const workflowEndEmitter = new EventEmitter();
  const { logger, workerPath, execPath, handshakeTimeout = 5_000 } = params;
  return {
    workflowEndEmitter,
    deliver(event: WorkflowEvent, lease: ExecutionLease) {
      const { executionId } = event;

      const filePath = workerPath.startsWith("file:")
        ? fileURLToPath(workerPath)
        : workerPath;

      return new Promise<WorkflowRunOutcome>((resolve, reject) => {
        logger.info({ executionId }, "Starting child process");

        const childProcess = fork(filePath, [], {
          execPath,
          serialization: "advanced",
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        });
        let settled = false;

        const settle = (result: { outcome: WorkflowRunOutcome } | { error: Error }) => {
          clearTimeout(handshakeTimer);
          if (settled) return;
          settled = true;
          if ("error" in result) {
            logger.error({ executionId, err: result.error }, result.error.message);
            reject(result.error);
          } else {
            resolve(result.outcome);
          }
          logger.info({ executionId }, "Terminating child process");
          childProcess.kill();
        };

        childProcess.on("error", (error) => settle({ error }));

        // The worker sends a "ready" message once it is listening. Until it
        // arrives we hold the event back: a worker running a different runtime
        // (or an incompatible IPC serialization) can never decode our frames,
        // so a missing handshake turns a silent hang into a clear error.
        let ready = false;
        const handshakeTimer = setTimeout(() => {
          settle({
            error: new Error(
              `Worker did not complete the IPC handshake within ${handshakeTimeout}ms. ` +
                "Check that the worker calls listen() and that execPath runs the same runtime as the parent process."
            ),
          });
        }, handshakeTimeout);

        childProcess.on("exit", (code, signal) => {
          if (settled) return;
          const detail = signal ? `signal ${signal}` : `code ${code}`;
          settle({
            error: new WorkerExitedError(
              `Worker process exited before replying (${detail})`
            ),
          });
        });

        childProcess.on("message", (message: WorkerMessage) => {
          if (settled) return;
          switch (message.status) {
            case "ready":
              if (ready) return;
              ready = true;
              clearTimeout(handshakeTimer);
              // Advanced serialization carries a Map but not a ReadonlyMap
              // wrapper, so send the context as a plain Map.
              const delivery: WorkerDelivery = {
                event: { ...event, context: new Map(event.context) },
                lease,
              };
              childProcess.send(
                delivery,
                (error) => {
                  if (error) settle({ error });
                }
              );
              return;
            case "outcome": {
              const { outcome } = message;
              settle({
                outcome:
                  outcome.status === "failed"
                    ? { status: "failed", error: deserializeError(outcome.error) }
                    : outcome,
              });
              return;
            }
            case "error":
              settle({ error: deserializeError(message.error) });
              return;
          }
        });
      });
    },
  };
}
