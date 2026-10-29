import { createWorkflowRouter } from "yieldstar";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/bun";
import { simpleWorkflow } from "../workflows/simple";
import { dynamicWorkflow } from "../workflows/dynamic";

export const workflowRouter = createWorkflowRouter({
  "simple-workflow": simpleWorkflow,
  "dynamic-workflow": dynamicWorkflow,
});

export const runtimeDb = createSqliteDb({ path: "./.db/http-server.sqlite" });

export const runtime = new SqliteRuntime(runtimeDb);

export type WorkflowRouter = typeof workflowRouter;
