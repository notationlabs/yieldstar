import type {
  WorkflowRouter,
  TriggerEvent,
  WorkflowGeneratorReturnType,
  EventParamsOf,
} from "@yieldstar/core";
import type { Logger } from "pino";
import pino from "pino";
import { ExecutionDispatcher, WorkflowRunner } from "@yieldstar/core";
import { createWorkflowInvoker } from "@yieldstar/test-invoker";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { createLocalSdk } from "yieldstar";

export function createTestSdkFactory(params?: {
  logger?: Logger;
  /** Passed to the memory runtime, e.g. a fixed clock or a short redelivery timeout. */
  runtime?: ConstructorParameters<typeof MemoryRuntime>[0];
}) {
  const logger = params?.logger ?? pino({ level: "error" });

  return <W extends WorkflowRouter>(workflowRouter: W) => {
    const runtime = new MemoryRuntime(params?.runtime);

    const workflowRunner = new WorkflowRunner(runtime, {
      router: workflowRouter,
      logger,
    });

    const invoker = createWorkflowInvoker({
      runner: workflowRunner,
      logger,
    });

    // The dispatcher polls an in-memory runtime, so it is cheap to leave
    // running; it does not keep the test process alive.
    const dispatcher = new ExecutionDispatcher(runtime, {
      invoker,
      logger,
      pollInterval: 1,
      keepAlive: false,
    });

    const sdk = createLocalSdk<W>(runtime, { invoker, pollInterval: 1 });

    return {
      async trigger<
        K extends keyof W & string,
        Params extends EventParamsOf<W[K]> = EventParamsOf<W[K]>
      >(event: TriggerEvent<K, Params>): Promise<{ executionId: string }> {
        dispatcher.start();
        return sdk.trigger(event as TriggerEvent<K, EventParamsOf<W[K]>>);
      },
      async triggerAndWait<
        K extends keyof W & string,
        Params extends EventParamsOf<W[K]> = EventParamsOf<W[K]>
      >(
        event: TriggerEvent<K, Params>
      ): Promise<WorkflowGeneratorReturnType<W[K]>> {
        dispatcher.start();
        return sdk.triggerAndWait(event as TriggerEvent<K, EventParamsOf<W[K]>>);
      },
      store: runtime.stores.store.bind(runtime.stores),
      runtime,
      dispatcher,
      storeClient: runtime.stores,
      heapClient: runtime.heap,
    };
  };
}
