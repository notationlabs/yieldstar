# Introduction

Yieldstar is a workflow engine that provides a durable runtime for JavaScript generator functions.

Version 0.5 ships a resident-process runtime backed by SQLite. It runs on Bun or Node using the host's native SQLite driver and does not require a particular cloud platform.

Workflows are checkpointed with primitives such as `yield* step.run()` and `yield* step.delay()`. The runtime persists step results and resumes delayed, retried, or state-waiting workflows across process restarts.

```ts
import { workflow } from "yieldstar";

const checkout = workflow(async function* (step) {
  const order = yield* step.run(() => createOrder());
  yield* step.delay(30_000);
  const payment = yield* step.run(() => chargeCard(order.id));
  return yield* step.run(() => confirmOrder(order.id, payment.id));
});
```


## How it compares

|                       | **Yieldstar**                   | **Temporal**            | **Inngest**            | **Cloudflare Workflows**    |
| --------------------- | ------------------------------- | ----------------------- | ---------------------- | --------------------------- |
| **State persistence** | SQLite file                     | Temporal Server cluster | Inngest Cloud (SaaS)   | Cloudflare Durable Objects  |
| **Infrastructure**    | Process plus a file             | Multi-service cluster   | SaaS platform          | Cloudflare Workers platform |
| **Self-hostable**     | Yes, single service             | Yes, but complex        | No                     | No                          |
| **Embeddable**        | Yes                             | No                      | No                     | No                          |
| **Portability**       | Runs anywhere JS runs           | Needs Temporal Server   | Needs Inngest platform | Needs Cloudflare            |
| **Deployment safety** | Out-of-order step detection     | Manual versioning       | Manual versioning      | Manual versioning           |

## Execution model

The execution model works by replaying the generator. When a step completes, the runtime snapshots its return value to a persistent heap and either advances to the next step or yields control back to the orchestrator. When the orchestrator later resumes the workflow, the runtime feeds each previously completed step its stored result instead of re-executing it, so the generator picks up exactly where it stopped.

This differs from `await step.run()` engines such as Inngest and Cloudflare Workflows, which intercept Promises through platform-specific wrappers. 

Yieldstar uses `yield*`, JavaScript's native generator delegation, as a bi-directional protocol between the workflow and the runtime. 

## Packages

Yieldstar is a monorepo of composable packages:

| Package                         | Role                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `yieldstar`                     | Core SDK with `workflow`, `createWorkflowRouter`, `RetryableError`, and the local and HTTP SDKs |
| `@yieldstar/core`               | Base types, the `Runtime` contract, `WorkflowRunner`, and `ExecutionDispatcher`      |
| `@yieldstar/sqlite-runtime`     | `SqliteRuntime`: driver-agnostic SQLite execution records, heap, and stores           |
| `@yieldstar/worker-invoker`     | Subprocess invoker and worker process                                                |
| `@yieldstar/http-server`        | Runtime-neutral HTTP routes and middleware using standard `Request` and `Response`    |
| `@yieldstar/test-runtime`       | `MemoryRuntime`, the in-memory runtime used by Yieldstar's test tooling               |
| `@yieldstar/test-invoker`       | In-process invoker used by Yieldstar's test tooling                                   |
| `@yieldstar/test-utils`         | Test SDK and schema helpers used internally by this repository                        |
| `@yieldstar/runtime-conformance`  | Vitest qualification suites for third-party runtimes and store connectors            |

A runtime has three clients, and a dispatcher drives them:

- The **execution client** keeps one durable record per execution: its event, its status and outcome, and when it is next due.
- The **heap** stores step results so they survive restarts.
- The **store** client holds schema-validated shared state and the waiters of suspended workflows.
- The **dispatcher** (`ExecutionDispatcher`) claims due executions, hands each to an invoker, and records the outcome.
