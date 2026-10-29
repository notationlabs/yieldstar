import { appendFileSync, existsSync, writeFileSync } from "node:fs";
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
  "charge-order": workflow(async function* (step, event) {
    yield* step.run("charge", () => "charged");
    const shipment = yield* step.start("ship", {
      workflowId: "ship-order",
      params: { orderId: event.params.orderId },
    });
    return { shipment: shipment.executionId };
  }),
  "ship-order": workflow(async function* (step, event) {
    const courier = yield* step.run("book-courier", () => "courier-1");
    return { orderId: event.params.orderId, courier, tenant: event.context.get("tenant") };
  }),
};

// The test shares the database directory through the caller's context, which
// step.start passes on to the target.
createWorkflowWorker(
  {
    run(event, options) {
      const dir = event.context.get("dir");
      const runtime = new SqliteRuntime(
        createSqliteDb({ path: join(dir, "shared.db"), wal: true })
      );
      const start = runtime.executions.start.bind(runtime.executions);
      runtime.executions.start = async (request) => {
        const result = await start(request);
        appendFileSync(join(dir, "starts"), `${JSON.stringify({ request, result })}\n`);
        // Crashes once after the start commits, before the step is recorded.
        const crashMarker = join(dir, "crash-after-start");
        if (event.params.crashAfterStart && !existsSync(crashMarker)) {
          writeFileSync(crashMarker, "");
          process.exit(1);
        }
        return result;
      };
      return new WorkflowRunner(runtime, { router, logger }).run(event, options);
    },
  },
  logger
).listen();
