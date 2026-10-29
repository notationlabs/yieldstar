import type { StandardSchemaV1 } from "@standard-schema/spec";
import { durableValueCodec, type Durable, type IfDurable } from "./durable-value";
import { WorkflowValueError, registerErrorClass } from "./errors";

export type Draft<T> = T extends object
  ? { -readonly [K in keyof T]: Draft<T[K]> }
  : T;

export type StoreVersion = number;
export type StorePath = readonly (string | number)[];

export type StoreDefinition<Schema extends StandardSchemaV1 = StandardSchemaV1> =
  {
    name: string;
    schema: Schema;
  };

export type StoreState<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<Schema>;

export type StoreKey = {
  storeName: string;
  storeId: string;
};

/**
 * Identifies the durable workflow step performing a store operation.
 * When provided to `updateStore`/`takeFromStore`, the store client records
 * the committed result in an applied-steps ledger keyed by
 * (storeName, storeId, executionId, stepKey), written atomically with the
 * state change. A retried call with the same StoreStepId returns the recorded
 * result without re-running the updater/selector/claim, making the operation
 * exactly-once even if the caller crashes before persisting its own record
 * of the result (e.g. the workflow heap write).
 */
export type StoreStepId = {
  executionId: string;
  stepKey: string;
};

export type StoreSnapshot<T> = {
  state: T;
  instanceId: string;
  version: StoreVersion;
};

export type StoreUpdateResult<T> = {
  state: T;
  previousVersion: StoreVersion;
  version: StoreVersion;
};

export type StoreUpdateFromResult<T> =
  | ({ updated: true } & StoreUpdateResult<T>)
  | {
      updated: false;
      expectedInstanceId: string;
      actualInstanceId: string;
      expectedVersion: StoreVersion;
      actualVersion: StoreVersion;
    };

export type StoreDeleteFromResult =
  | { deleted: true }
  | {
      deleted: false;
      reason: "conflict";
      expectedInstanceId: string;
      actualInstanceId: string;
      expectedVersion: StoreVersion;
      actualVersion: StoreVersion;
    }
  | {
      deleted: false;
      reason: "not-found";
      expectedInstanceId: string;
      expectedVersion: StoreVersion;
    };

export type StoreSelector<T, R> = (state: Readonly<T>) => R;

export type StoreTakeResult<R> =
  | {
      matched: true;
      selected: NonNullable<R>;
      instanceId: string;
      version: StoreVersion;
    }
  | {
      matched: false;
      instanceId: string;
      version: StoreVersion;
      readPaths: StorePath[];
    };

export type StoreWaiter = {
  workflowId: string;
  executionId: string;
  stepKey: string;
  storeName: string;
  storeId: string;
  instanceId: string;
  sinceVersion: StoreVersion;
  readPaths: StorePath[];
};

export type StoreMutationCommitResult =
  | { status: "committed" }
  | { status: "already-applied"; result: unknown }
  | { status: "conflict"; snapshot: StoreSnapshot<unknown> };

export type StoreMutation = {
  definition: StoreDefinition;
  id: string;
  expected: StoreSnapshot<unknown>;
  nextState: unknown;
  changedPaths: StorePath[];
  stepId?: StoreStepId;
  result: unknown;
};

export type RuntimeStore<T> = {
  get(): Promise<StoreSnapshot<T>>;
  update(updater: (draft: Draft<T>) => void | T): Promise<StoreUpdateResult<T>>;
  updateFrom(
    snapshot: StoreSnapshot<T>,
    updater: (draft: Draft<T>) => void | T
  ): Promise<StoreUpdateFromResult<T>>;
  deleteFrom(snapshot: StoreSnapshot<T>): Promise<StoreDeleteFromResult>;
};

/** A store state failed its schema. Workflow code can catch it. */
export class StoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreValidationError";
  }
}

/** The addressed store does not exist. Workflow code can catch it. */
export class StoreNotFoundError extends Error {
  constructor(storeName: string, storeId: string) {
    super(`Store "${storeName}:${storeId}" does not exist`);
    this.name = "StoreNotFoundError";
  }
}

registerErrorClass("StoreValidationError", StoreValidationError);
registerErrorClass("StoreNotFoundError", StoreNotFoundError);

/**
 * A schema whose output, the store state, is a durable value. The state is
 * still validated by the codec at runtime.
 */
export type DurableStoreSchema<Schema extends StandardSchemaV1> = IfDurable<
  StoreState<Schema>,
  StandardSchemaV1<
    StandardSchemaV1.InferInput<Schema>,
    Durable<StoreState<Schema>>
  >
>;

export function defineStore<Schema extends StandardSchemaV1>(
  name: string,
  schema: Schema & DurableStoreSchema<Schema>
): StoreDefinition<Schema> {
  return { name, schema };
}

export abstract class StoreClient {
  store<Schema extends StandardSchemaV1>(
    definition: StoreDefinition<Schema>,
    id: string
  ): RuntimeStore<StoreState<Schema>> {
    return {
      get: () =>
        this.getStore({
          definition,
          id,
        }),
      update: (updater) =>
        this.updateStore({
          definition,
          id,
          updater,
        }),
      updateFrom: (snapshot, updater) =>
        this.updateStoreFrom({
          definition,
          id,
          snapshot,
          updater,
        }),
      deleteFrom: (snapshot) =>
        this.deleteStoreFrom({
          definition,
          id,
          snapshot,
        }),
    };
  }

  abstract getOrCreateStore<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    initial?:
      | StoreState<Schema>
      | (() => StoreState<Schema> | Promise<StoreState<Schema>>);
  }): Promise<StoreSnapshot<StoreState<Schema>>>;

  abstract getStore<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
  }): Promise<StoreSnapshot<StoreState<Schema>>>;

  /**
   * Updates a store's state atomically.
   * Updaters must be synchronous, deterministic, and side-effect-free. CAS-backed
   * clients may run an updater again when another writer wins the version race.
   * A rejected promise does not prove that the mutation was rolled back: a
   * connector may commit state and then fail while delivering its durable wake
   * intents. Retrying is exactly-once only when the same `stepId` is supplied.
   * Callers without a `stepId` must read and reconcile instead of blindly retrying.
   *
   * When `stepId` is provided the update is exactly-once per
   * (executionId, stepKey): the committed StoreUpdateResult is recorded in
   * the applied-steps ledger inside the same transaction as the state change,
   * and a repeated call with the same stepId returns the recorded result
   * verbatim without running the updater or bumping the version.
   */
  abstract updateStore<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    updater: (draft: Draft<StoreState<Schema>>) => void | StoreState<Schema>;
    stepId?: StoreStepId;
  }): Promise<StoreUpdateResult<StoreState<Schema>>>;

  /**
   * Updates a store only if it has not changed since `snapshot` was read.
   * A conflict does not change the store, though a racing writer may cause a
   * pure updater to have been evaluated before the conflict is observed. When `stepId`
   * identifies an update that already committed, its recorded result wins
   * over the version check so replay remains exactly-once.
   */
  abstract updateStoreFrom<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    snapshot: StoreSnapshot<StoreState<Schema>>;
    updater: (draft: Draft<StoreState<Schema>>) => void | StoreState<Schema>;
    stepId?: StoreStepId;
  }): Promise<StoreUpdateFromResult<StoreState<Schema>>>;

  /**
   * Atomically selects and claims from a store. The selector and claim run
   * locally against a snapshot, then commit with a single conditional version
   * bump. A conflict re-runs both functions against the new snapshot. If the selector does not match, nothing is
   * committed and the store's current version plus the selector's tracked
   * read paths are returned so the caller can register a waiter with the
   * correct sinceVersion (closing the lost-wakeup gap by construction).
   *
   * `claim` must be synchronous – implementations must reject (throw) if it
   * returns a Promise.
   *
   * When `stepId` is provided, a MATCHED (committed) take is recorded in the
   * applied-steps ledger inside the same transaction as the claim commit, and
   * a repeated call with the same stepId returns the recorded outcome without
   * re-running the selector or claim. Unmatched outcomes are NOT recorded:
   * an unmatched take commits nothing and registers a waiter, so it must
   * remain free to re-evaluate the selector on every wake.
   */
  abstract takeFromStore<Schema extends StandardSchemaV1, R>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    selector: StoreSelector<StoreState<Schema>, R>;
    claim: (
      draft: Draft<StoreState<Schema>>,
      selected: NonNullable<R>
    ) => void;
    stepId?: StoreStepId;
  }): Promise<StoreTakeResult<R>>;

  /**
   * Registers a versioned read observation. Registration must be linearizable
   * with mutations: a stale observation is woken immediately, while a current
   * observation is woken by a later intersecting mutation. A wake requests a
   * delivery of `waiter.executionId`; it carries no copy of the event. Once a
   * mutation is durable, the wakes it requires are durable too. The waiter
   * stays registered until the heap records its step's result.
   */
  abstract registerWaiter(waiter: StoreWaiter): Promise<void>;

  /**
   * Enumerates the ids of every store created under a given definition name.
   * Needed by external consumers (e.g. Notation's state backend) that treat a
   * store name as a collection of instances and must list them. Order is
   * ascending by id so callers get a deterministic sequence.
   */
  abstract listStores(definition: StoreDefinition): Promise<string[]>;

  /**
   * Removes a physical store instance and its waiters. Applied-step receipts
   * remain authoritative for the logical store key across recreation. A no-op
   * if the store does not exist.
   */
  abstract deleteStore(params: {
    definition: StoreDefinition;
    id: string;
  }): Promise<void>;

  /** Deletes a store only if its instance ID and version still match the snapshot. */
  abstract deleteStoreFrom(params: {
    definition: StoreDefinition;
    id: string;
    snapshot: StoreSnapshot<unknown>;
    stepId?: StoreStepId;
  }): Promise<StoreDeleteFromResult>;
}

/**
 * Implements store transformations as read/compute/compare-and-swap loops.
 * Storage connectors only implement the atomic mutation protocol and never
 * execute application callbacks while holding a storage transaction.
 */
export abstract class CasStoreClient extends StoreClient {
  protected abstract getAppliedStoreStep(params: {
    definition: StoreDefinition;
    id: string;
    stepId: StoreStepId;
  }): Promise<{ result: unknown } | undefined>;

  /**
   * Atomically compares `expected`, writes the next state, records the optional
   * step result, and records the wake obligations created by `changedPaths`.
   * A transactional outbox is recommended but is not part of the protocol.
   */
  protected abstract commitStoreMutation(
    mutation: StoreMutation
  ): Promise<StoreMutationCommitResult>;

  async updateStore<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    updater: (draft: Draft<StoreState<Schema>>) => void | StoreState<Schema>;
    stepId?: StoreStepId;
  }): Promise<StoreUpdateResult<StoreState<Schema>>> {
    const applied = await this.getAppliedResult(params);
    if (applied) {
      return applied.result as StoreUpdateResult<StoreState<Schema>>;
    }

    let snapshot = await this.getStore({
      definition: params.definition,
      id: params.id,
    });
    while (true) {
      const prepared = await prepareStoreUpdate(
        params.definition,
        snapshot,
        params.updater,
        params.stepId?.stepKey
      );
      const result: StoreUpdateResult<StoreState<Schema>> = {
        state: cloneStoreState(prepared.nextState),
        previousVersion: snapshot.version,
        version: snapshot.version + 1,
      };
      const committed = await this.commitStoreMutation({
        definition: params.definition,
        id: params.id,
        expected: snapshot,
        nextState: prepared.nextState,
        changedPaths: prepared.changedPaths,
        stepId: params.stepId,
        result,
      });

      if (committed.status === "committed") return result;
      if (committed.status === "already-applied") {
        return committed.result as StoreUpdateResult<StoreState<Schema>>;
      }
      snapshot = committed.snapshot as StoreSnapshot<StoreState<Schema>>;
      // TODO: add a configurable retry cap/backoff policy before remote CAS
      // connectors are introduced; SQLite serializes commits locally.
    }
  }

  async updateStoreFrom<Schema extends StandardSchemaV1>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    snapshot: StoreSnapshot<StoreState<Schema>>;
    updater: (draft: Draft<StoreState<Schema>>) => void | StoreState<Schema>;
    stepId?: StoreStepId;
  }): Promise<StoreUpdateFromResult<StoreState<Schema>>> {
    const applied = await this.getAppliedResult(params);
    if (applied) {
      return applied.result as StoreUpdateFromResult<StoreState<Schema>>;
    }

    assertStoreSnapshotInstanceId(params.snapshot);

    const current = await this.getStore({
      definition: params.definition,
      id: params.id,
    });
    if (!sameStoreVersion(current, params.snapshot)) {
      return storeUpdateConflict(params.snapshot, current);
    }

    const prepared = await prepareStoreUpdate(
      params.definition,
      params.snapshot,
      params.updater,
      params.stepId?.stepKey
    );
    const result: StoreUpdateFromResult<StoreState<Schema>> = {
      updated: true,
      state: cloneStoreState(prepared.nextState),
      previousVersion: params.snapshot.version,
      version: params.snapshot.version + 1,
    };
    const committed = await this.commitStoreMutation({
      definition: params.definition,
      id: params.id,
      expected: params.snapshot,
      nextState: prepared.nextState,
      changedPaths: prepared.changedPaths,
      stepId: params.stepId,
      result,
    });

    if (committed.status === "committed") return result;
    if (committed.status === "already-applied") {
      return committed.result as StoreUpdateFromResult<StoreState<Schema>>;
    }
    return storeUpdateConflict(params.snapshot, committed.snapshot);
  }

  async takeFromStore<Schema extends StandardSchemaV1, R>(params: {
    definition: StoreDefinition<Schema>;
    id: string;
    selector: StoreSelector<StoreState<Schema>, R>;
    claim: (
      draft: Draft<StoreState<Schema>>,
      selected: NonNullable<R>
    ) => void;
    stepId?: StoreStepId;
  }): Promise<StoreTakeResult<R>> {
    const applied = await this.getAppliedResult(params);
    if (applied) return applied.result as StoreTakeResult<R>;

    let snapshot = await this.getStore({
      definition: params.definition,
      id: params.id,
    });
    while (true) {
      const previousState = cloneStoreState(snapshot.state);
      const draft = cloneStoreState(previousState) as Draft<StoreState<Schema>>;
      const tracked = trackStoreUpdater(draft);
      const { result: selectedResult, readPaths } = trackStoreSelector(
        tracked.draft as StoreState<Schema>,
        params.selector
      );

      if (!isStoreSelectorMatch(selectedResult)) {
        return {
          matched: false,
          instanceId: snapshot.instanceId,
          version: snapshot.version,
          readPaths,
        };
      }

      const selected = unwrapTrackedValue(selectedResult) as NonNullable<R>;
      assertSynchronousClaim(params.claim(tracked.draft, selected));
      const prepared = await finalizeStoreMutation({
        definition: params.definition,
        previousState,
        draft,
        tracked,
        stepKey: params.stepId?.stepKey,
      });
      // Checked before the commit, so a selection that cannot be recorded
      // leaves the store unchanged.
      assertDurableStoreValue(
        selected,
        params.stepId?.stepKey ?? "",
        `Store take selection for "${params.definition.name}"`
      );
      const selectedSnapshot = cloneStoreState(selected);
      const result: StoreTakeResult<R> = {
        matched: true,
        selected: selectedSnapshot,
        instanceId: snapshot.instanceId,
        version: snapshot.version + 1,
      };
      const committed = await this.commitStoreMutation({
        definition: params.definition,
        id: params.id,
        expected: snapshot,
        nextState: prepared.nextState,
        changedPaths: prepared.changedPaths,
        stepId: params.stepId,
        result,
      });

      if (committed.status === "committed") return result;
      if (committed.status === "already-applied") {
        return committed.result as StoreTakeResult<R>;
      }
      snapshot = committed.snapshot as StoreSnapshot<StoreState<Schema>>;
      // TODO: share the configurable retry cap/backoff policy with updateStore.
    }
  }

  private getAppliedResult(params: {
    definition: StoreDefinition;
    id: string;
    stepId?: StoreStepId;
  }) {
    return params.stepId
      ? this.getAppliedStoreStep({
          definition: params.definition,
          id: params.id,
          stepId: params.stepId,
        })
      : Promise.resolve(undefined);
  }
}

async function prepareStoreUpdate<Schema extends StandardSchemaV1>(
  definition: StoreDefinition<Schema>,
  snapshot: StoreSnapshot<StoreState<Schema>>,
  updater: (draft: Draft<StoreState<Schema>>) => void | StoreState<Schema>,
  stepKey: string | undefined
) {
  const previousState = cloneStoreState(snapshot.state);
  const draft = cloneStoreState(previousState) as Draft<StoreState<Schema>>;
  const tracked = trackStoreUpdater(draft);
  const updated = updater(tracked.draft);
  assertSynchronousUpdater(updated);
  const returned = updated === undefined ? undefined : unwrapTrackedValue(updated);
  return finalizeStoreMutation({
    definition,
    previousState,
    draft,
    tracked,
    replacement: returned,
    stepKey,
  });
}

async function finalizeStoreMutation<Schema extends StandardSchemaV1>(params: {
  definition: StoreDefinition<Schema>;
  previousState: StoreState<Schema>;
  draft: Draft<StoreState<Schema>>;
  tracked: TrackedStoreUpdater<Draft<StoreState<Schema>>>;
  replacement?: unknown;
  stepKey?: string;
}) {
  const isReplacement =
    params.replacement !== undefined && params.replacement !== params.draft;
  const nextState = await validateStoreState(
    params.definition,
    isReplacement ? params.replacement : params.draft,
    params.stepKey
  );
  const changedPaths =
    !isReplacement && (nextState as unknown) === params.draft
      ? params.tracked.writePaths()
      : diffStorePaths(params.previousState, nextState);
  return { nextState, changedPaths };
}

function sameStoreVersion(
  left: StoreSnapshot<unknown>,
  right: StoreSnapshot<unknown>
) {
  return (
    left.instanceId === right.instanceId && left.version === right.version
  );
}

function assertStoreSnapshotInstanceId(snapshot: { instanceId?: string }) {
  if (!snapshot.instanceId) {
    throw new Error(
      "Store snapshot is missing instanceId; read a fresh snapshot"
    );
  }
}

function storeUpdateConflict(
  expected: StoreSnapshot<unknown>,
  actual: StoreSnapshot<unknown>
): Extract<StoreUpdateFromResult<never>, { updated: false }> {
  return {
    updated: false,
    expectedInstanceId: expected.instanceId,
    actualInstanceId: actual.instanceId,
    expectedVersion: expected.version,
    actualVersion: actual.version,
  };
}

export function isStoreSelectorMatch<R>(
  result: R
): result is Exclude<R, undefined | null | false> {
  return result !== undefined && result !== null && result !== false;
}

export function assertSynchronousClaim(claimResult: unknown): void {
  if (
    claimResult &&
    typeof (claimResult as PromiseLike<unknown>).then === "function"
  ) {
    throw new Error("Store take claims must be synchronous");
  }
}

export function assertSynchronousUpdater(updaterResult: unknown): void {
  if (
    updaterResult &&
    typeof (updaterResult as PromiseLike<unknown>).then === "function"
  ) {
    throw new Error("Store updaters must be synchronous");
  }
}

/**
 * Validates a state against its store's schema, then checks that the schema's
 * output is a durable value. Throws `StoreValidationError` when the schema
 * rejects the state, and `WorkflowValueError` (`INVALID_STEP_VALUE`) when the
 * output is not durable, so callers that validate before committing leave the
 * store unchanged. `stepKey` names the step in that error.
 */
export async function validateStoreState<Schema extends StandardSchemaV1>(
  definition: StoreDefinition<Schema>,
  state: unknown,
  stepKey = ""
): Promise<StoreState<Schema>> {
  const result = await definition.schema["~standard"].validate(state);

  if ("issues" in result && result.issues) {
    const messages = result.issues.map((issue) => issue.message).join("; ");
    throw new StoreValidationError(
      `Invalid store state for "${definition.name}": ${messages}`
    );
  }

  assertDurableStoreValue(result.value, stepKey, `Store state for "${definition.name}"`);
  return result.value as StoreState<Schema>;
}

function assertDurableStoreValue(value: unknown, stepKey: string, label: string) {
  const encoding = durableValueCodec.encode(value);
  if (encoding.status === "invalid") {
    throw new WorkflowValueError(
      "INVALID_STEP_VALUE",
      stepKey,
      `${label} is not a durable value: ${encoding.message}`
    );
  }
}

/** Encodes a store state or step result for storage. Throws if it is not durable. */
export function encodeStoreValue(value: unknown): string {
  const encoding = durableValueCodec.encode(value);
  if (encoding.status === "invalid") {
    throw new Error(`Store value is not a durable value: ${encoding.message}`);
  }
  return encoding.canonical;
}

export function decodeStoreValue(canonical: string): unknown {
  const decoding = durableValueCodec.decode(canonical);
  if (decoding.status === "invalid") {
    throw new Error(`Invalid store value encoding: ${decoding.message}`);
  }
  return decoding.value;
}

/**
 * Copies a state as the durable value codec would read it back. Values the
 * codec rejects, which validation keeps out of committed state, are copied
 * with `structuredClone`.
 */
export function cloneStoreState<T>(state: T): T {
  const encoding = durableValueCodec.encode(state);
  if (encoding.status === "encoded") {
    const decoding = durableValueCodec.decode(encoding.canonical);
    if (decoding.status === "decoded") return decoding.value as T;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(state);
    } catch {
      // Fallback if structuredClone fails (e.g. for Proxy objects in JavaScriptCore)
    }
  }

  return JSON.parse(JSON.stringify(state));
}

/**
 * Diffs two store states and returns the set of changed paths.
 *
 * This is O(total state size). `trackStoreUpdater` records ordinary mutation
 * paths in O(changes); the diff handles cases a recording proxy cannot observe:
 * - the updater RETURNED a replacement state instead of mutating the draft
 * - schema validation returned a transformed copy of the draft
 *
 * NOTE: array splices (insert/remove in the middle) report all shifted
 * indices as changed, which can over-wake waiters. This is safe – wakes are
 * spurious at worst, since replay re-evaluates the selector.
 */
export function diffStorePaths(previous: unknown, next: unknown): StorePath[] {
  const paths: StorePath[] = [];

  function visit(left: unknown, right: unknown, path: StorePath) {
    if (Object.is(left, right)) return;

    if (!isDiffableObject(left) || !isDiffableObject(right)) {
      paths.push(path);
      return;
    }

    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

    for (const key of keys) {
      visit(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        [...path, arrayKeyToPathSegment(key)]
      );
    }
  }

  visit(previous, next, []);
  return collapseStorePaths(paths);
}

const TRACKING_TARGET = Symbol("yieldstar.trackingTarget");

/**
 * Unwraps a tracking proxy (`trackStoreSelector` or `trackStoreUpdater`)
 * one level, back to the object it wraps. When a selector runs over a
 * write-recording draft, the selected value unwraps to the RECORDING proxy,
 * so claim mutations applied through it land on the draft AND are recorded
 * as write paths. Derived values (fresh arrays/objects built inside the
 * selector) are returned as-is.
 */
export function unwrapTrackedValue<V>(value: V): V {
  if (isDiffableObject(value)) {
    const target = (value as Record<PropertyKey, unknown>)[
      TRACKING_TARGET as unknown as string
    ];
    if (target !== undefined) return target as V;
  }
  return value;
}

export function trackStoreSelector<T, R>(
  state: T,
  selector: StoreSelector<T, R>
): { result: R; readPaths: StorePath[] } {
  const paths: StorePath[] = [];
  const proxies = new WeakMap<object, unknown>();

  function track(value: unknown, path: StorePath): unknown {
    if (!isDiffableObject(value)) return value;

    const cached = proxies.get(value);
    if (cached) return cached;

    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        if (typeof property === "symbol") {
          if (property === TRACKING_TARGET) return target;
          return Reflect.get(target, property, receiver);
        }

        const nextPath = [...path, arrayKeyToPathSegment(property)];
        if (nextPath.length > 0) {
          paths.push(nextPath);
        }

        const child = Reflect.get(target, property, receiver);
        return track(child, nextPath);
      },
      set() {
        throw new Error("Store selectors must not mutate state");
      },
      deleteProperty() {
        throw new Error("Store selectors must not mutate state");
      },
    });

    proxies.set(value, proxy);
    return proxy;
  }

  const result = selector(track(state, []) as Readonly<T>);

  return {
    result,
    readPaths: collapseStorePaths(paths),
  };
}

export type TrackedStoreUpdater<T> = {
  /** Write-recording proxy over the raw draft. Hand this to the updater. */
  draft: T;
  /** The collapsed set of paths written so far (O(changes), not O(state)). */
  writePaths(): StorePath[];
};

/**
 * Wraps a draft in a write-recording Proxy so changed paths can be derived
 * from the updater's own mutations in O(changes) instead of deep-diffing the
 * whole previous/next state (O(state size) – see `diffStorePaths`).
 *
 * - Every `set` and `deleteProperty` through the proxy records its full
 *   path. Mutating array methods are trapped naturally via the index/length
 *   sets they perform: a push onto `messages` records ["messages", 3] (and
 *   ["messages", "length"]), preserving prefix-match wake semantics – a
 *   waiter on ["messages"] still wakes via prefix intersection.
 * - Reads return proxied children so nested mutations are captured, but the
 *   mutation itself lands on the underlying raw draft (Reflect.set on the
 *   target), because the mutated draft becomes the next state.
 * - Values assigned through the proxy are unwrapped (top-level) so the raw
 *   draft never stores a proxy wrapper for the common `draft.a = draft.b`
 *   case. Deeper wrappers (a proxy nested inside a fresh object) are
 *   laundered at commit time: `cloneStoreState` always produces fresh plain
 *   objects (structuredClone rejects proxies and falls back to JSON), and
 *   the SQLite client serializes state through JSON.stringify.
 * - Ambiguous traps (`defineProperty`) record conservatively. Changed paths
 *   only affect wake precision, never state correctness: an extra path is a
 *   spurious wake (safe – replay re-evaluates the selector), while a missed
 *   path would lose a wakeup. When in doubt, over-report.
 *
 * IMPORTANT: this only observes MUTATIONS of the draft. If the updater
 * RETURNS a replacement state instead of mutating (the
 * `updated === undefined ? draft : updated` contract), no writes go through
 * the proxy – callers must detect that case and fall back to
 * `diffStorePaths(previousState, replacement)`.
 */
export function trackStoreUpdater<T>(target: T): TrackedStoreUpdater<T> {
  const paths: StorePath[] = [];
  const proxies = new WeakMap<object, unknown>();

  function record(path: StorePath, property: PropertyKey) {
    if (typeof property === "symbol") {
      // Symbol-keyed writes are invisible to JSON state and read paths;
      // record the parent path so any waiter on it still wakes.
      paths.push(path);
      return;
    }
    paths.push([...path, arrayKeyToPathSegment(String(property))]);
  }

  function track(value: unknown, path: StorePath): unknown {
    if (!isDiffableObject(value)) return value;

    const cached = proxies.get(value);
    if (cached) return cached;

    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        if (typeof property === "symbol") {
          if (property === TRACKING_TARGET) return target;
          return Reflect.get(target, property, receiver);
        }

        // Read without the proxy receiver so any getters run against the
        // raw draft, then wrap the child so nested mutations are captured.
        const child = Reflect.get(target, property);
        return track(child, [...path, arrayKeyToPathSegment(property)]);
      },
      set(target, property, value) {
        record(path, property);
        // Unwrap so the raw draft never stores a proxy wrapper, and set on
        // the raw target (no proxy receiver) so the draft receives the
        // mutation directly.
        return Reflect.set(target, property, unwrapTrackedValue(value));
      },
      deleteProperty(target, property) {
        record(path, property);
        return Reflect.deleteProperty(target, property);
      },
      defineProperty(target, property, descriptor) {
        record(path, property);
        if ("value" in descriptor) {
          descriptor = { ...descriptor, value: unwrapTrackedValue(descriptor.value) };
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    });

    proxies.set(value, proxy);
    return proxy;
  }

  return {
    draft: track(target, []) as T,
    writePaths: () => collapseStorePaths(paths),
  };
}

export function storePathsIntersect(
  readPaths: StorePath[],
  writePaths: StorePath[]
): boolean {
  return readPaths.some((readPath) =>
    writePaths.some(
      (writePath) =>
        isPathPrefix(readPath, writePath) || isPathPrefix(writePath, readPath)
    )
  );
}

function collapseStorePaths(paths: StorePath[]): StorePath[] {
  const unique = new Map(paths.map((path) => [path.join("\u0000"), path]));
  return [...unique.values()];
}

function isPathPrefix(prefix: StorePath, path: StorePath): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, index) => segment === path[index]);
}

function isDiffableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function arrayKeyToPathSegment(key: string): string | number {
  if (/^(0|[1-9]\d*)$/.test(key)) return Number(key);
  return key;
}
