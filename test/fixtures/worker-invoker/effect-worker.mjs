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

// The test shares its directory through the execution's context. Every
// callback appends to "calls", so the test sees calls across workers.
const router = {
  "charge-order": workflow(async function* (step, event) {
    const dir = event.context.get("dir");
    return yield* step.effect("charge", {
      effectId: `acct-1:charge:${event.executionId}`,
      operation: "charge-v1",
      input: { amount: 4999 },
      retryIn: 0,
      lookup: async () => {
        appendFileSync(join(dir, "calls"), "lookup\n");
        return { status: "not-found" };
      },
      perform: async () => {
        appendFileSync(join(dir, "calls"), "perform\n");
        return { chargeId: "ch-1" };
      },
    });
  }),
};

createWorkflowWorker(
  {
    run(event, options) {
      const dir = event.context.get("dir");
      const runtime = new SqliteRuntime(
        createSqliteDb({ path: join(dir, "shared.db"), wal: true })
      );
      const begin = runtime.effects.begin.bind(runtime.effects);
      // Fails once, as an unreachable effect store would.
      runtime.effects.begin = async (request) => {
        const marker = join(dir, "begin-failed");
        if (!existsSync(marker)) {
          writeFileSync(marker, "");
          throw new Error("effect store unreachable");
        }
        return begin(request);
      };
      return new WorkflowRunner(runtime, { router, logger }).run(event, options);
    },
  },
  logger
).listen();
