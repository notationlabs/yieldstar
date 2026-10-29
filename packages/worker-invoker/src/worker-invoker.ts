import type { Logger } from "pino";
import type {
  DeliveryOptions,
  WorkflowEvent,
  WorkflowInvoker,
  WorkflowRunOutcome,
} from "@yieldstar/core";
import {
  InfrastructureError,
  WorkerExitedError,
  durableValueCodec,
  encodeExecutionEvent,
} from "@yieldstar/core";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  SerializedOutcome,
  WorkerDelivery,
  WorkerMessage,
  WorkerRequest,
} from "./worker";

/**
 * Runs each delivery in a forked worker process. `deliver` resolves with the
 * worker's outcome, and rejects when the delivery ends without one: a spawn
 * error, a missing handshake, an infrastructure error in the worker, or an
 * exit before replying. An exit before replying rejects with a
 * `WorkerExitedError`, so the dispatcher leaves the lease to expire instead of
 * releasing it.
 *
 * When `options.signal` aborts, the invoker kills the worker with `SIGKILL`,
 * stopping even a step function that is still running, and rejects at once
 * with an `InfrastructureError` whose cause is the signal's reason. A signal
 * that has already aborted rejects without forking a worker.
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
    deliver(event: WorkflowEvent, { lease, signal }: DeliveryOptions) {
      const { executionId } = event;

      const filePath = workerPath.startsWith("file:")
        ? fileURLToPath(workerPath)
        : workerPath;

      return new Promise<WorkflowRunOutcome>((resolve, reject) => {
        if (signal.aborted) {
          reject(new InfrastructureError(signal.reason));
          return;
        }
        logger.info({ executionId }, "Starting child process");

        const childProcess = fork(filePath, [], {
          execPath,
          serialization: "advanced",
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        });
        let settled = false;

        const request = (message: WorkerRequest) =>
          childProcess.send(message, (error) => {
            if (error) settle({ error });
          });

        // The lease was lost: kill the worker rather than ask it to stop, so
        // a step function that never returns cannot keep it running.
        const onAbort = () =>
          settle({ error: new InfrastructureError(signal.reason) }, "SIGKILL");

        const settle = (
          result: { outcome: WorkflowRunOutcome } | { error: Error },
          killSignal: NodeJS.Signals = "SIGTERM"
        ) => {
          clearTimeout(handshakeTimer);
          signal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          logger.info({ executionId }, "Terminating child process");
          childProcess.kill(killSignal);
          if ("error" in result) {
            logger.error({ executionId, err: result.error }, result.error.message);
            reject(result.error);
          } else {
            resolve(result.outcome);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });

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
              let encoded: { params: string; context: string };
              try {
                encoded = encodeExecutionEvent(event);
              } catch (error) {
                settle({ error: error as Error });
                return;
              }
              const delivery: WorkerDelivery = {
                type: "deliver",
                event: { ...event, ...encoded },
                lease,
              };
              request(delivery);
              return;
            case "outcome": {
              const { outcome } = message;
              try {
                settle({ outcome: deserializeOutcome(outcome) });
              } catch (error) {
                settle({ error: error as Error });
              }
              return;
            }
            case "error":
              settle({ error: decodeWorkerError(message.error) });
              return;
          }
        });
      });
    },
  };
}

function deserializeOutcome(outcome: SerializedOutcome): WorkflowRunOutcome {
  switch (outcome.status) {
    case "suspended":
      return outcome;
    case "completed":
      return { status: "completed", result: decodeOrThrow(outcome.result) };
    case "failed": {
      const error = decodeOrThrow(outcome.error);
      return {
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

function decodeWorkerError(encoded: string): Error {
  const decoding = durableValueCodec.decode(encoded);
  if (decoding.status === "invalid") {
    return new Error(`Worker sent an invalid error: ${decoding.message}`);
  }
  const error = decoding.value;
  return error instanceof Error ? error : new Error(String(error));
}

function decodeOrThrow(encoded: string) {
  const decoding = durableValueCodec.decode(encoded);
  if (decoding.status === "invalid") {
    throw new Error(`Worker sent an invalid outcome: ${decoding.message}`);
  }
  return decoding.value;
}
