import pino from "pino";
import { createMiddleware, createRoutes } from "@yieldstar/http-server";
import { ExecutionDispatcher } from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/worker-invoker";
import { runtime } from "./shared";

const logger = pino();
const workerPath = new URL("worker.ts", import.meta.url).href;

const invoker = createWorkflowInvoker({
  workerPath,
  logger,
});

const dispatcher = new ExecutionDispatcher(runtime, { invoker, logger });
dispatcher.start();

const authMiddleware = createMiddleware(async (req, event, next) => {
  const token = req.headers.get("Authorization");
  if (!token) {
    return Response.json("Unauthorized", { status: 401 });
  }
  return next();
});

const corsMiddleware = createMiddleware(async (req, event, next) => {
  event.context.set("cors", "enabled");
  const response = await next();
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
});

Bun.serve({
  port: 8080,
  routes: {
    "/status": new Response("OK"),
    ...createRoutes({
      logger,
      runtime,
      invoker,
      middleware: [corsMiddleware, authMiddleware],
    }),
  },
});
