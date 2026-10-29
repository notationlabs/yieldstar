import type { Logger } from "pino";
import type { EventParams, WorkflowEvent, EventContext } from "./event";
import type { ExecutionClient, ExecutionLease } from "./execution";
import { HeapClient } from "./heap";
import { StoreClient } from "./store";
import { StepResponse, WorkflowResult } from "./step";

export type WorkflowGeneratorParams<
  Params extends EventParams,
  Context extends EventContext
> = {
  event: WorkflowEvent<Params, Context>;
  /** Every heap step write is fenced by this lease. */
  lease: ExecutionLease;
  /**
   * Aborted when the delivery must stop. The driver checks it before each
   * step function and each fenced write.
   */
  signal: AbortSignal;
  heapClient: HeapClient;
  storeClient: StoreClient;
  /** `step.start` admits its target through this client. */
  executionClient: ExecutionClient;
  /** The runtime clock. Delay and retry wake times are read from it. */
  clock: () => number;
  logger: Logger;
};

export type WorkflowGenerator<
  Params extends EventParams,
  Result,
  Context extends EventContext
> = (
  genParams: WorkflowGeneratorParams<Params, Context>
) => AsyncGenerator<StepResponse, WorkflowResult<Result>, StepResponse>;

export type WorkflowGeneratorReturnType<CG> = CG extends WorkflowGenerator<
  infer Params,
  infer Result,
  infer Context
>
  ? Result
  : never;

export type WorkflowRouter = Record<string, WorkflowGenerator<any, any, any>>;

export type EventOfWorkflow<W extends WorkflowGenerator<any, any, any>> =
  Parameters<W>[0]["event"];

export type EventParamsOf<W extends WorkflowGenerator<any, any, any>> =
  Parameters<W>[0]["event"]["params"];
