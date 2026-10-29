import { createWorkflowRouter } from "yieldstar";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/bun";
import { simpleWorkflow } from "../workflows/simple";
import { dynamicWorkflow } from "../workflows/dynamic";

export const runtimeDb = createSqliteDb({
  path: "./.db/local-execution.sqlite",
});
export const runtime = new SqliteRuntime(runtimeDb);

export const workflowRouter = createWorkflowRouter({
  "simple-workflow": simpleWorkflow,
  "dynamic-workflow": dynamicWorkflow,
});

export type WorkflowRouter = typeof workflowRouter;
