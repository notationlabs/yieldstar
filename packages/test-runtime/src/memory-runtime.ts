import { Runtime, type RuntimeOptions } from "@yieldstar/core";
import { MemoryExecutionClient } from "./memory-execution";
import { MemoryHeapClient } from "./memory-heap";
import { MemoryStoreClient } from "./memory-store";

export class MemoryRuntime extends Runtime {
  readonly clock: () => number;
  readonly executions: MemoryExecutionClient;
  readonly heap: MemoryHeapClient;
  readonly stores: MemoryStoreClient;

  constructor(options?: RuntimeOptions) {
    super();
    // Read Date.now lazily so fake timers installed later still apply.
    this.clock = options?.clock ?? (() => Date.now());
    this.executions = new MemoryExecutionClient({ clock: this.clock });
    this.stores = new MemoryStoreClient({ executions: this.executions });
    this.heap = new MemoryHeapClient({
      // A waiter is deleted in the same synchronous write as its step's result.
      onStepDone: (step) => this.stores.deleteWaitersForStep(step),
    });
  }
}
