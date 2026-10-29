// A real worker: runs the shared parity workflows over an in-memory runtime.
import { WorkflowRunner } from "@yieldstar/core";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { leaseLocally } from "./lease-locally.mjs";
import { parityRouter } from "./parity-workflows.mjs";

const logger = { info() {}, error() {} };
const runtime = new MemoryRuntime();
const runner = new WorkflowRunner(runtime, {
  router: parityRouter,
  logger,
});

createWorkflowWorker(leaseLocally(runtime, runner), logger).listen();
