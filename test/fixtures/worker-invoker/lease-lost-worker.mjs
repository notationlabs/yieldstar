// A worker over a SQLite file shared with the test's dispatcher. Its "slow"
// step writes a marker, then waits long enough for the test to abort the
// delivery; its "after" step writes another marker if it ever runs. Every
// heap step write is logged to `writes` beside the database.
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
    const { dir } = event.params;
    yield* step.run("before", () => "written");
    yield* step.run("slow", async () => {
      writeFileSync(join(dir, "slow-started"), "");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return "finished after the lease was lost";
    });
    yield* step.run("after", () => {
      writeFileSync(join(dir, "after-ran"), "");
      return "unreachable";
    });
    return "done";
  }),
};

createWorkflowWorker(
  {
    run(event, options) {
      const { dir } = event.params;
      const runtime = new SqliteRuntime(
        createSqliteDb({ path: join(dir, "shared.db"), wal: true })
      );
      const writeStep = runtime.heap.writeStep.bind(runtime.heap);
      runtime.heap.writeStep = (params) => {
        appendFileSync(join(dir, "writes"), `${params.stepKey}\n`);
        return writeStep(params);
      };
      return new WorkflowRunner(runtime, { router, logger }).run(event, options);
    },
  },
  logger
).listen();
