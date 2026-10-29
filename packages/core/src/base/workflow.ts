import type { Logger } from "pino";
import type { EventParams, WorkflowEvent, EventContext } from "./event";
import type { ExecutionLease } from "./execution";
import { HeapClient } from "./heap";
import { StoreClient } from "./store";
import { StepResponse, WorkflowResult } from "./step";

export type WorkflowGeneratorParams<
  Params extends EventParams,
  Context extends EventContext
> = {
  event: WorkflowEvent<Params, Context>;
  /** The delivery's lease. Every heap step write is fenced by it. */
  lease: ExecutionLease;
  heapClient: HeapClient;
  storeClient: StoreClient;
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
