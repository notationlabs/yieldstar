import pino from "pino";
import { ExecutionDispatcher } from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { createLocalSdk } from "yieldstar";
import { runtime } from "./shared";
import type { WorkflowRouter } from "./shared";

const logger = pino();
const workerPath = new URL("worker.ts", import.meta.url).href;

export const invoker = createWorkflowInvoker({ workerPath, logger });
export const sdk = createLocalSdk<WorkflowRouter>(runtime, { invoker });

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();

try {
  const result = await sdk.triggerAndWait({
    workflowId: "dynamic-workflow",
    params: { msg: "hello" },
  });
  console.log(result);
} finally {
  await dispatcher.stop();
}
