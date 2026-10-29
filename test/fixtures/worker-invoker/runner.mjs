// A real worker: runs the shared parity workflows over an in-memory runtime.
import { WorkflowRunner } from "@yieldstar/core";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { parityRouter } from "./parity-workflows.mjs";

const logger = { info() {}, error() {} };
const runner = new WorkflowRunner(new MemoryRuntime(), {
  router: parityRouter,
  logger,
});

createWorkflowWorker(runner, logger).listen();
