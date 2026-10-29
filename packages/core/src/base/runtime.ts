import type { ExecutionClient } from "./execution";
import type { HeapClient } from "./heap";
import type { StoreClient } from "./store";

export interface RuntimeOptions {
  /** Every client of the runtime reads time from this clock. Defaults to `Date.now`. */
  clock?: () => number;
}

/**
 * A runtime is defined by the guarantees its clients keep, not by how many
 * databases it uses:
 *
 * - Where one write must accompany another, such as the wakes for a store
 *   commit, the second is durable once the first commits and is applied
 *   eventually (in one transaction or through an outbox).
 * - A store waiter is deleted atomically with its step's result.
 * - Every client reads time from the runtime's clock.
 */
export abstract class Runtime {
  /** The clock every client, and every step's wake time, reads. */
  abstract readonly clock: () => number;
  abstract readonly executions: ExecutionClient;
  abstract readonly heap: HeapClient;
  abstract readonly stores: StoreClient;
}
