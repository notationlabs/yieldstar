import type { Logger } from "pino";
import type { ExecutionClient, WorkflowInvoker } from "@yieldstar/core";
import {
  FreezableMap,
  MiddlewareEvent,
  MiddlewareFunction,
  durableValueCodec,
  encodeThrownValue,
  waitForExecutionOutcome,
} from "@yieldstar/core";
import { executeMiddlewareChain } from "./middleware";

export type RouteHandler = (request: Request) => Response | Promise<Response>;
export type Routes = Record<string, { POST: RouteHandler }>;

type TriggerBody = {
  executionId?: string;
  workflowId: string;
  params?: unknown;
  context?: Record<string, unknown>;
};

/**
 * Admits an execution. The body is read with the durable value codec, so plain
 * JSON is accepted and the HTTP SDK's tagged values (such as `undefined` and
 * errors) keep their shape. Responds `202` with the accepted `executionId`,
 * `409` when the ID is already in use, and `400` when the event cannot be
 * stored without loss. A dispatcher delivers the execution afterwards.
 */
export const createTriggerHandler =
  (params: {
    executions: ExecutionClient;
    logger: Logger;
    middleware?: MiddlewareFunction[];
  }): RouteHandler =>
  async (req) => {
    const { logger, executions, middleware = [] } = params;

    const decoding = durableValueCodec.decode(await req.text());
    if (decoding.status === "invalid" || !isTriggerBody(decoding.value)) {
      return Response.json(
        {
          code: "INVALID_EXECUTION_EVENT",
          message:
            decoding.status === "invalid"
              ? `Invalid trigger body: ${decoding.message}`
              : "Invalid trigger body: expected { workflowId, executionId?, params?, context? }",
        },
        { status: 400 }
      );
    }
    const body = decoding.value;

    const event: MiddlewareEvent = {
      executionId: body.executionId,
      workflowId: body.workflowId,
      params: body.params as MiddlewareEvent["params"],
      context: new FreezableMap<string, any>(Object.entries(body.context ?? {})),
    };

    return executeMiddlewareChain(
      req,
      event,
      logger,
      middleware,
      async (req, event) => {
        try {
          const admission = await executions.admit({
            executionId: event.executionId,
            workflowId: event.workflowId,
            params: event.params,
            context: event.context,
          });
          if (admission.status === "accepted") {
            return Response.json(
              { executionId: admission.executionId },
              { status: 202 }
            );
          }
          return Response.json(
            { code: admission.code, message: admission.message },
            { status: admission.code === "EXECUTION_ID_CONFLICT" ? 409 : 400 }
          );
        } catch (err: any) {
          logger.error(err);
          return Response.json(err.message, { status: 500 });
        }
      }
    );
  };

/**
 * Waits for an execution's record to reach a terminal status. Responds with
 * the result, or `500` with the recorded error, each encoded with the durable
 * value codec, or `404` for an unknown ID.
 */
export const createEventsHandler =
  (params: {
    executions: ExecutionClient;
    invoker?: WorkflowInvoker;
  }): RouteHandler =>
  async (req) => {
    const { executions, invoker } = params;

    const { executionId } = (await req.json()) as {
      executionId: string;
    };

    if (!executionId) {
      return new Response("Missing executionId", {
        status: 400,
      });
    }

    const outcome = await waitForExecutionOutcome(executions, executionId, {
      emitter: invoker?.workflowEndEmitter,
      signal: req.signal,
    });

    if (!outcome) {
      return new Response("Execution not found", { status: 404 });
    }

    if (outcome.status === "failed") {
      return durableJson(encodeThrownValue(outcome.error), 500);
    }

    const result = durableValueCodec.encode(outcome.result);
    if (result.status === "invalid") {
      return durableJson(encodeThrownValue(new Error(result.message)), 500);
    }
    return durableJson(result.canonical, 200);
  };

function durableJson(canonical: string, status: number) {
  return new Response(canonical, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isDecodedObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

function isTriggerBody(value: unknown): value is TriggerBody {
  if (!isDecodedObject(value) || typeof value.workflowId !== "string") {
    return false;
  }
  if (value.executionId !== undefined && typeof value.executionId !== "string") {
    return false;
  }
  return value.context === undefined || isDecodedObject(value.context);
}

export function createRoutes(params: {
  basePath?: `/${string}`;
  runtime: { executions: ExecutionClient };
  /** Optional: lets the events route settle as soon as a delivery is acknowledged. */
  invoker?: WorkflowInvoker;
  logger: Logger;
  middleware?: MiddlewareFunction[];
}): Routes {
  const { logger, runtime, invoker, middleware = [], basePath = "" } = params;
  const { executions } = runtime;
  return {
    [`${basePath}/trigger`]: {
      POST: createTriggerHandler({ executions, logger, middleware }),
    },
    [`${basePath}/events`]: {
      POST: createEventsHandler({ executions, invoker }),
    },
  };
}
