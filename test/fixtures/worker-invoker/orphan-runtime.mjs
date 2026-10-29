import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";

const [dbPath, markerPath] = process.argv.slice(2);
const { createSqliteDb } =
  "Bun" in globalThis
    ? await import("@yieldstar/sqlite-runtime/bun")
    : await import("@yieldstar/sqlite-runtime/node");

const logger = { info() {}, error() {}, warn() {} };
const runtime = new SqliteRuntime(createSqliteDb({ path: dbPath, wal: true }));
await runtime.executions.admit({
  executionId: "orphan",
  workflowId: "orphan",
  params: { markerPath },
  context: new Map(),
});
const [lease] = await runtime.executions.claimDue({ limit: 1, duration: 30_000 });
const record = await runtime.executions.get("orphan");

const invoker = createWorkflowInvoker({
  workerPath: new URL("orphan-worker.mjs", import.meta.url).href,
  logger,
});
invoker
  .deliver(
    {
      workflowId: record.workflowId,
      executionId: "orphan",
      params: record.params,
      context: record.context,
    },
    { lease, signal: new AbortController().signal }
  )
  .catch(() => {});

// Stay alive until the test kills this process.
setInterval(() => {}, 1_000);
