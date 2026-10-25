import { afterEach, expect, test, vi } from "vitest";
import { SqliteTaskQueue } from "@yieldstar/sqlite-runtime";

const isBun = "Bun" in globalThis;
const { createSqliteDb } = isBun
  ? await import("@yieldstar/sqlite-runtime/bun")
  : await import("@yieldstar/sqlite-runtime/node");

const VISIBILITY_WINDOW = 300000;

afterEach(() => {
  vi.useRealTimers();
});

test("a claimed task becomes visible again after the visibility window", async () => {
  vi.useFakeTimers();

  const db = createSqliteDb({ path: ":memory:", wal: false });
  const taskQueue = new SqliteTaskQueue(db);

  taskQueue.add({
    workflowId: "workflow-1",
    executionId: "execution-1",
    params: undefined,
    context: new Map(),
  });

  const claimed = taskQueue.process();
  expect(claimed?.event.workflowId).toBe("workflow-1");

  // While claimed, the task is hidden from other workers
  expect(taskQueue.process()).toBeUndefined();
  expect(taskQueue.isEmpty).toBe(true);

  // Simulate a worker crash: the task is never removed or made visible.
  // Once the visibility window elapses, a fresh queue can claim it again.
  vi.advanceTimersByTime(VISIBILITY_WINDOW + 1);

  const recoveredQueue = new SqliteTaskQueue(db);
  expect(recoveredQueue.isEmpty).toBe(false);

  const reclaimed = recoveredQueue.process();
  expect(reclaimed?.taskId).toBe(claimed?.taskId);
  expect(reclaimed?.event.workflowId).toBe("workflow-1");

  db.close();
});
