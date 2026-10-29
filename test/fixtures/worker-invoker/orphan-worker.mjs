import { writeFileSync } from "node:fs";
import { WorkflowRunner } from "@yieldstar/core";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";
import { createWorkflowWorker } from "@yieldstar/worker-invoker";
import { workflow } from "yieldstar";

const { createSqliteDb } =
  "Bun" in globalThis
    ? await import("@yieldstar/sqlite-runtime/bun")
    : await import("@yieldstar/sqlite-runtime/node");

const logger = { info() {}, error() {}, warn() {} };
const dbPath = process.env.YIELDSTAR_ORPHAN_DB;
const runtime = new SqliteRuntime(createSqliteDb({ path: dbPath, wal: true }));

const router = {
  orphan: workflow(async function* (step, event) {
    yield* step.run("before", () => "written");
    yield* step.run("during", async () => {
      writeFileSync(event.params.markerPath, String(process.pid));
      // Gives the test time to kill the runtime process before this step's
      // result is written.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return "written after the runtime process died";
    });
    return "done";
  }),
};

createWorkflowWorker(new WorkflowRunner(runtime, { router, logger }), logger).listen();
