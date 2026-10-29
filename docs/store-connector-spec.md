# YieldStar store connector conformance specification

Status: publishable specification for the YieldStar connector protocol, revised for RFC 001 (execution records), RFC 002 (execution leases) and RFC 005 (durable external effects).

This document defines the observable contract for a YieldStar store connector. The words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are normative.

## Qualification

A connector is qualified by running `registerStoreClientConformance` from `@yieldstar/runtime-conformance` against a factory that creates a clean backend and returns a `Runtime` over it. A store connector is never qualified alone: its wakes are requests to the runtime's `ExecutionClient`, so the suite observes them as executions that `runtime.executions.claimDue()` returns. Passing the base suite qualifies the runtime for process-local use.

A factory that returns `createPeer` declares that independent runtimes can concurrently access the same backend, as separate runtime processes would. The shared-client checks then become REQUIRED, including the lease checks in which one runtime claims an execution and a peer races it for the same execution or claims it after the first lease expires. Several dispatchers, in one process or several, MAY share a backend declared this way. A factory that returns `restart` declares durable storage of stores, waiters and wakes across process failure. The durable-wake checks then become REQUIRED.

Qualification applies to synchronous, transaction-capable drivers. Async remote drivers such as Turso and batch-only backends such as D1 require future protocol extensions and are not qualified by this version.

## Runtime guarantees

A `Runtime` bundles four clients: `executions` (`ExecutionClient`), `effects` (`EffectClient`), `heap` (`HeapClient`) and `stores` (`StoreClient`). A runtime is defined by the guarantees its clients keep together, not by how many databases it uses.

- **Follow-on writes.** Where this specification requires one write to accompany another, such as the wakes for a store commit, the second MUST be durable once the first commits and MUST be applied eventually. A runtime MAY make both in one transaction or use an outbox.
- **Waiter deletion.** A store or effect waiter MUST be deleted atomically with the heap write that records its step's result. Waiters are therefore stored with step records. A store kept in another database reaches its waiters through the follow-on rule above.
- **Fencing.** Heap step records and lease tokens MUST be checked in one place: a fenced heap write checks the lease token and writes in one atomic action. Other state MAY be kept elsewhere under the guarantees above.
- **Clock.** Every client MUST read time from the runtime's clock (`RuntimeOptions.clock`, default `Date.now`), exposed as `Runtime.clock`. No client operation takes the current time as a parameter. Delay and retry steps read their wake times from the same clock.

`SqliteRuntime` and `MemoryRuntime` keep every guarantee in single transactions.

The `ExecutionClient` contract that wakes rely on:

- Execution IDs MUST be unique across the runtime and MUST never be reused, whatever the delivery outcome. `admit` returns `EXECUTION_ID_CONFLICT` for an ID in use, and `INVALID_EXECUTION_EVENT` for `params` or `context` values that `durableValueCodec` cannot encode, or `context` keys that are not strings; it MUST NOT store a lossy copy.
- Admission MUST create the record as `admitted` and make it due immediately, all-or-nothing.
- A wake names an execution and a due time; it carries no copy of the event. `requestWake` for an unknown execution returns `EXECUTION_NOT_FOUND` and creates nothing; for a terminal execution it returns `ignored`.
- Wakes not covered by a lease MUST merge into one due time, the earliest requested. `claimDue` MUST return an execution at most once per result, however many wakes it has.
- Acknowledgement clears the wakes the delivery covered. The next due time is the earlier of the outcome's `wakeAt` and any wake requested after the claim. An unacknowledged delivery's wakes stay pending.
- `completed` and `failed` are immutable. A failed outcome's error MUST keep its `name`, `message`, `code`, `cause` and durable fields, and revive as its registered class. A completed result that `durableValueCodec` cannot encode MUST be recorded as `failed` with `WorkflowValueError` (`INVALID_STEP_VALUE`). The state machine's outcome codec does all of this.
- Records, pending wakes and leases MUST survive a restart.

### Leases

`claimDue({ limit, duration })` grants a lease, `{ executionId, token, expiresAt }`, on each execution it returns.

- `claimDue` MUST return at most `limit` leases, each for a due execution with no live lease, earliest due time first.
- An execution MUST have at most one live lease at any time, across every runtime sharing the backend.
- Each claim MUST give the execution a token greater than every earlier token for that execution.
- The record's status MUST be `running` while a lease is live. When the lease ends without a terminal acknowledgement, the status returns to `suspended` if an earlier delivery was acknowledged as suspended, and to `admitted` otherwise.
- `renew` with the current token MUST extend `expiresAt` to `duration` from now. A lease is lost only when a higher token is issued or the lease has been released or acknowledged. An expired lease that has not been claimed again stays current: its renewals and fenced writes succeed.
- An expired lease makes the execution claimable again, once it is due and the redelivery delay has passed.
- `release` with the current token MUST end the lease without acknowledging an outcome.
- `acknowledge` with the current token MUST record the outcome and end the lease, all-or-nothing.

### Redelivery delay

- A delivery that ends by `release`, or by lease expiry followed by another claim, is unacknowledged and MUST add one to `unacknowledgedDeliveryCount`. Any acknowledgement MUST reset it to zero.
- While `unacknowledgedDeliveryCount` is greater than zero, the execution MUST NOT be claimable until a non-zero redelivery delay has passed since the delivery ended. The delay MUST NOT decrease while `unacknowledgedDeliveryCount` grows. The bundled runtimes start at 1 second, double, and cap at 5 minutes (`redeliveryDelay`).

### Fencing

Every write that could conflict with the current holder's writes is fenced: `HeapClient.writeStep`, `renew`, `release` and `acknowledge`.

- A fenced write MUST be accepted only if its token is current, and the check and the write MUST be atomic. A rejected fenced write MUST change nothing and MUST return `{ status: "lost" }`.
- Safety MUST NOT depend on clocks. Clocks decide only when an execution becomes claimable again; tokens decide whose writes count.
- `writeStep` MUST be idempotent for the current holder. Rewriting an existing step record MUST succeed without changing it, and MUST return the record as stored, so the driver can detect a different value and end the delivery as a retry.
- Deleting a step's waiters is part of the fenced heap write that records its result: a rejected write MUST leave them in place.

Store mutations with a step receipt, store creation, and wake requests are not fenced. A receipt or a store identity already makes each take effect once, whichever holder commits it, and a stale wake causes at most one extra delivery that replay absorbs. Fencing does not make `step.run` exactly-once: a stale holder may run a function's external side effects before its step write is rejected.

### Starts

`start({ requestId, workflowId, params })` admits a target execution on behalf of the caller step named by `requestId` (`{ executionId, stepKey }`).

- `start` MUST return `INVALID_START_PARAMETERS`, and admit nothing, for an empty workflow ID, for `params` that are not a plain object, and for `params` that `durableValueCodec` cannot encode.
- A new start MUST admit the target and record the start request all-or-nothing. The target is `admitted` and due immediately, has the caller's `context`, and has `parent` set to `requestId`. The parent link is immutable; executions admitted with `admit` have none.
- Target execution IDs MUST follow the admission uniqueness rules: two start requests never receive the same ID, and a target never reuses an ID in use.
- A repeated request ID MUST return the first target's ID, without admitting another, when its workflow ID and canonical params match the recorded request, and `START_REQUEST_MISMATCH` otherwise, whatever the target's status. Missing params and `{}` do not match. Concurrent calls with one request ID MUST admit one target.
- `start` is not fenced. Start-request records MUST survive a restart, and are kept until the caller is pruned.

Runtime adapters MAY build on the storage-neutral transitions exported from `@yieldstar/core` (`prepareExecutionAdmission`, `prepareExecutionStart`, `matchStartRequest`, `createStartedExecution`, `requestExecutionWake`, `claimExecution`, `renewExecutionLease`, `releaseExecutionLease`, `acknowledgeExecution`, `isLeaseCurrent`, `nextClaimAt`) by applying each inside one atomic write. `registerExecutionClientConformance` from `@yieldstar/runtime-conformance` exercises these rules; this repository runs it against both bundled runtimes.

### Effects

`EffectClient` records external effects by `effectId` (RFC 005). `begin`, `settle` and `watch` are not fenced; they are idempotent by effect ID.

- `begin({ operation, effectId, input, executionId, stepKey })` MUST create a pending effect before returning `new`. For an existing effect it MUST return `pending` or `settled` with the stored result when `operation` and the canonical encoding of `input` match, and `EFFECT_REQUEST_MISMATCH` otherwise, without changing the effect. Concurrent calls with one effect ID MUST create one effect.
- `settle({ operation, effectId, result })` MUST settle a pending effect once, and wake every waiting execution in the same atomic write. A later call with an equal canonical result returns the settled result. A different result MUST keep the first, return `conflict` with both values, and store a permanent conflict report; the bundled runtimes store one report per distinct conflicting result.
- `watch({ effectId, executionId, stepKey })` MUST register one waiter per effect, execution and step, however often it is repeated, and request no timed wake. If the effect is already settled, it MUST wake the execution immediately, every time it is called.
- Wakes are pending wakes on the execution record and follow the store wake rules above. A waiter MUST stay registered until the fenced heap write that records its step's result deletes it; a stale holder's rejected write deletes nothing.
- Values MUST be stored with `durableValueCodec`, so `undefined`, errors and error-shaped plain objects keep their type. `getEffect` returns the record with every conflict report.
- Effects, conflict reports and waiters MUST survive a restart. Effect records are never deleted with an execution.
- A request with invalid values, a `settle` or `watch` for an unknown effect, a `settle` with a different `operation`, and stored data that cannot be decoded MUST throw `EffectClientInvariantError` (`EFFECT_RUNTIME_INVARIANT`). Any other rejection is treated as the client being unavailable.

Adapters MAY build on `prepareEffectBegin`, `prepareEffectSettle`, `prepareEffectWatch`, `createEffectState`, `matchEffectBegin`, `settleEffect` and `toEffectRecord` from `@yieldstar/core`, applying each inside one atomic write. `registerEffectClientConformance` exercises these rules.

## Connector surface

Connector authors SHOULD extend `CasStoreClient`, which implements `getStore`, `updateStore`, `updateStoreFrom`, `takeFromStore` and `deleteStoreFrom`. They implement `listStores`, `deleteStore` and `registerWaiter` plus these protected primitives:

- `readStore` returns the current detached snapshot, or `undefined` when the logical store does not exist. It never creates a store.
- `insertStore` inserts a supplied version-zero snapshot unless the logical store exists, and returns the store's snapshot after the write: the supplied one, or the existing one when another writer created the store first.
- `getAppliedStoreStep` reads a previously committed step receipt.
- `commitStoreMutation` compares the expected instance and version, or inserts a created store, commits the next state, records an optional step receipt, and requests wakes for the waiters the commit satisfies, as one atomic action.
- `commitStoreDeletion` compares the expected instance and version, deletes the store and its waiters, and records an optional step receipt, as one atomic action.

A connector MAY override `createInstanceId`, which names a created instance; the default is `crypto.randomUUID()`.

A connector MUST treat `(definition.name, id)` as a logical store key. A physical store instance has an opaque, non-empty, UUID-compatible lowercase hexadecimal-and-hyphen `instanceId` and a monotonically increasing integer `version`, beginning at zero. Deleting and recreating a logical store MUST produce a new `instanceId` whose initial state is version zero. Store states and returned results MUST be detached values: changing a value returned to or supplied by a caller MUST NOT mutate persisted state. A connector MUST persist store states and step receipts so that they read back exactly as `durableValueCodec` decodes them, for example with `encodeStoreValue` and `decodeStoreValue`: `undefined` properties keep their keys and errors keep their registered class. `validateStoreState` rejects a state that is not a durable value with `WorkflowValueError` (`INVALID_STEP_VALUE`) before any commit, so a rejected state MUST leave the store unchanged.

## Missing stores

Every store definition declares `initial(id)`, the state a logical store starts with. There is no creation operation: `getStore`, `updateStore`, `updateStoreFrom`, `takeFromStore` and `deleteStoreFrom` first create a missing store from `definition.initial(id)`, in the same atomic write as the operation. `listStores`, `deleteStore` and `registerWaiter` never create a store.

- `initial` MUST be evaluated, and its state schema-validated, only when the operation finds the store missing, and never while a storage transaction is held. A receipt hit returns before `initial` is evaluated.
- Concurrent or repeated operations on a missing store MUST record exactly one initial state for each logical store key. Callers that lose the creation race operate on the winner's instance, so a losing initial state is discarded.
- A created store is version zero of a new instance. An operation that creates and mutates a store in one write commits version one with the operation's state, so its result has `previousVersion` 0; `getStore` commits version zero.
- An unmatched take on a missing store still creates it, so a waiter registered from its result observes an instance that exists. A conditional update or delete on a missing store creates it and returns a conflict with the new instance.
- If `initial`, its validation, or the operation's callbacks throw, nothing is created.
- A store deleted between operations is created again from `initial` by the next operation, as a new instance.

`CasStoreClient` implements these rules. It evaluates `initial` outside any transaction and passes the result to `insertStore`, or to `commitStoreMutation` as an `expected` snapshot with `created: true`.

## Listing and deletion

`listStores` MUST return the logical IDs for one definition name in deterministic ascending text order; qualification verifies ordinal ordering for ASCII IDs. `deleteStore` MUST be idempotent. Both `deleteStore` and a successful `deleteStoreFrom` MUST remove the waiters of the deleted physical instance, so they cannot wake on writes to a recreated instance. Deletion silently drops those waiters without requesting a wake.

## Compare-and-swap mutations

`commitStoreMutation` MUST linearize on both `expected.instanceId` and `expected.version`.

- If both match, the connector MUST store `nextState`, increment the version by exactly one, atomically record the optional receipt and request the wakes of matching waiters, and return `committed`.
- If `expected.created` is true and the logical store does not exist, the connector MUST insert it under `expected.instanceId` with `nextState` at version `expected.version + 1`, with the same receipt and wakes, and return `committed`.
- If either differs while the logical store still exists, or `expected.created` is true and the logical store exists, it MUST make no change and return `conflict` with a current detached snapshot.
- If `expected.created` is false and no current instance exists, it MUST make no change and return `missing`. `CasStoreClient` then reads again and creates the store from `initial`.
- If the optional step receipt already exists, it MUST make no change and return `already-applied` with the recorded result. Receipt lookup takes precedence over the CAS comparison.

`commitStoreDeletion` follows the same rules for the existing instance: `committed` after deleting it with its waiters and receipt, `conflict` when its instance or version differs, `missing` when it does not exist, and `already-applied` when its receipt exists. `insertStore` MUST be atomic with commits, so at most one insert or created commit succeeds for a logical store key.

Concurrent successful mutations against one physical instance MUST form a total order with contiguous versions. `CasStoreClient` retries a normal update or matched take after a conflict. Consequently, updaters, selectors, and claims MUST be synchronous, deterministic, and side-effect-free: they MAY execute more than once before one public operation returns. Connectors MUST NOT hold a storage transaction while application callbacks execute.

`updateStoreFrom` and `deleteStoreFrom` do not retry a new operation after a conflict. Their callbacks can still have run before a racing conflict is observed. Missing or stale instance IDs MUST never affect a recreated physical store. `StoreDeleteFromResult` has no not-found outcome: a missing store is created first, so the result is a conflict.

## Exactly-once step receipts

A `StoreStepId` is scoped by `(storeName, storeId, executionId, stepKey)`. For a mutating update, a matched take, or a successful conditional delete with a step ID, the connector MUST commit the operation result receipt atomically with the mutation. A retry with the same identity MUST return the recorded result verbatim without executing application callbacks or changing the store version.

Receipt lookup precedes store creation and snapshot existence, instance, and version checks for every operation, as well as for `commitStoreMutation` and `commitStoreDeletion`. Replaying a committed operation therefore returns its receipt without creating the store, even after the logical store has been deleted or recreated, and a crash after a commit that created a store neither creates it again nor applies the operation twice.

Receipt uniqueness MUST hold under concurrent duplicate submissions: at most one mutation commits and every submitter observes the same recorded result. Receipts are ledger entries for a logical store key, not a physical instance, and MUST remain authoritative after deletion and recreation. This prevents a retried workflow step from affecting a new instance.

An unmatched take performs no mutation and MUST NOT record a receipt. It returns the current `instanceId`, `version`, and tracked read paths so replay can re-evaluate the selector after a wake.

Calls without a step ID are not exactly-once. If their outcome is uncertain, callers must read and reconcile rather than blindly retry.

## Waiters and wakes

A waiter records the waiting `executionId` and `stepKey`, the physical `instanceId`, the observed `sinceVersion`, and the selector read paths. It MUST NOT carry a copy of the workflow event; every delivery reads the event from the execution record. Registration and commits for one logical store MUST be linearizable with these outcomes:

- If registration linearizes before a later intersecting mutation, that mutation requests a wake for the waiter's execution.
- If a mutation or instance replacement linearizes before registration and makes the supplied observation stale, registration requests an immediate wake.

This coordination closes the lost-wakeup gap between an unmatched take and waiter registration. A connector MAY conservatively wake when it cannot prove that a stale change was unrelated. Spurious wakes are safe because workflow replay re-evaluates the selector; missed wakes are not safe.

“Linearizable” here means that each registration and commit must have an observable outcome equivalent to one single ordering of those operations. The suite exercises stale-before-register, register-before-commit, single-client races, and declared shared-client races; as with any finite conformance suite, those samples do not exhaustively prove every possible concurrent history.

For a current waiter, a commit requests a wake only when the new version is greater than `sinceVersion` and a changed path intersects a read path by prefix. `CasStoreClient` is responsible for deriving changed paths for replacement updates and array mutations before it calls the connector. Connector implementations MUST persist and match the supplied paths without losing intersections. Over-reporting paths is allowed; under-reporting is not.

Wakes follow the runtime guarantees above:

- Once a commit or stale registration is durable, the wakes it requires MUST be durable too and MUST be applied. A crash MUST NOT leave a commit without its wakes.
- A wake does not consume its waiter. The waiter MUST stay registered, and keep waking its execution on later intersecting commits, until the heap write that records its step's result deletes it. Recording a different step's result MUST leave it in place.
- Any number of wakes for one execution, from one or many commits and waiters, collapse into one due execution because they merge on the execution record.
- A wake for an execution with no record, or with a terminal record, changes nothing.

## Failure boundaries

A rejected public promise does not prove that no commit occurred. Exactly-once recovery is available only by repeating the call with the same step ID; otherwise the caller must read and reconcile.

Validation failures, a throwing `initial`, and asynchronous updater or claim callbacks MUST leave state, receipts, and wakes unchanged, and create no store.

Schema failures MUST surface as `StoreValidationError` (`validateStoreState` throws it for connectors that use it), or as errors with that `name`. Workflow code can catch it. Operations create missing stores, so no store client throws `StoreNotFoundError`; the class stays registered so recorded failures still decode. Every other error a store client throws is treated as an infrastructure error: the delivery ends without an outcome, its lease is released unacknowledged, and the runtime delivers it again after the redelivery delay.

## Running the suite

See [`@yieldstar/runtime-conformance`](../packages/runtime-conformance/README.md) for the factory API and a minimal Vitest example. The YieldStar CI runs the same artifact against `MemoryRuntime` and `SqliteRuntime` under Bun and Node. SQLite declares shared-client and durable-restart capabilities, and also runs the execution and effect suites over separate connections to one database file; the in-memory runtime qualifies only for process-local use.
