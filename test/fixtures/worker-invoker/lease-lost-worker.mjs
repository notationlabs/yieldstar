import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowRunner } from "@yieldstar/core";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { workflow } from "yieldstar";

const { createSqliteDb } =
  "Bun" in globalThis
    ? await import("@yieldstar/sqlite-runtime/bun")
    : await import("@yieldstar/sqlite-runtime/node");

const logger = { info() {}, error() {}, warn() {} };

const router = {
  "lease-lost": workflow(async function* (step, event) {
    const { dir, slowMs = 300 } = event.params;
    yield* step.run("before", () => "written");
    yield* step.run("slow", async () => {
      writeFileSync(join(dir, "slow-started"), "");
      // Long enough for the test to abort the delivery mid-step.
      await new Promise((resolve) => setTimeout(resolve, slowMs));
      return "finished after the lease was lost";
    });
    yield* step.run("after", () => {
      writeFileSync(join(dir, "after-ran"), "");
      return "unreachable";
    });
    return "done";
  }),
  quick: workflow(async function* () {
    return "quick";
  }),
};

createWorkflowWorker(
  {
    run(event, options) {
      const { dir } = event.params;
      writeFileSync(join(dir, "pid"), String(process.pid));
      const runtime = new SqliteRuntime(
        createSqliteDb({ path: join(dir, "shared.db"), wal: true })
      );
      const writeStep = runtime.heap.writeStep.bind(runtime.heap);
      runtime.heap.writeStep = (params) => {
        appendFileSync(
          join(dir, "writes"),
          `${params.lease.executionId} ${params.stepKey}\n`
        );
        return writeStep(params);
      };
      return new WorkflowRunner(runtime, { router, logger }).run(event, options);
    },
  },
  logger
).listen();
