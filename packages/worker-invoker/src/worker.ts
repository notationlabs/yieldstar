import type { Logger } from "pino";
import type {
  EventContext,
  WorkflowEvent,
  WorkflowRunOutcome,
  WorkflowRunner,
} from "@yieldstar/core";
import { ReadOnlyMap } from "@yieldstar/core";
import { serializeError } from "serialize-error";

let context: EventContext;

export const getContext = () => context;

/**
 * Messages a worker sends its parent. `outcome` reports a finished delivery;
 * `error` reports an infrastructure error, which is not an outcome.
 */
export type WorkerMessage =
  | { status: "ready" }
  | { status: "outcome"; outcome: SerializedOutcome }
  | { status: "error"; error: unknown };

export type SerializedOutcome =
  | Exclude<WorkflowRunOutcome, { status: "failed" }>
  | { status: "failed"; error: unknown };

export function createWorkflowWorker(
  workflowRunner: WorkflowRunner<any>,
  logger: Logger
) {
  const send = (message: WorkerMessage) => process.send!(message);
  return {
    listen() {
      process.on(
        "message",
        async (event: Omit<WorkflowEvent, "context"> & { context: Map<any, any> }) => {
          const workflowEvent: WorkflowEvent = {
            ...event,
            context: new ReadOnlyMap(event.context),
          };
          context = workflowEvent.context;
          try {
            const outcome = await workflowRunner.run(workflowEvent, logger);
            send({
              status: "outcome",
              outcome:
                outcome.status === "failed"
                  ? { status: "failed", error: serializeError(outcome.error) }
                  : outcome,
            });
          } catch (error: any) {
            send({ status: "error", error: serializeError(error) });
          }
        }
      );
      send({ status: "ready" });
    },
  };
}
