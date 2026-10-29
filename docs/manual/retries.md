# Retries

Yieldstar implements structured retries through `RetryableError`. Throwing this error inside a `step.run` tells the runtime to re-execute the step according to the supplied retry policy, including maximum attempt count and retry interval.

## Basic retry

```ts
import { RetryableError } from "yieldstar";

yield *
  step.run(async () => {
    const res = await fetch("https://api.example.com/charge");
    if (!res.ok) {
      throw new RetryableError("Payment failed", {
        maxAttempts: 5,
        retryInterval: 2000,
      });
    }
    return res.json();
  });
```

| Option          | Type     | Description                                                           |
| --------------- | -------- | --------------------------------------------------------------------- |
| `maxAttempts`   | `number` | Total number of times the step executes (including the first attempt) |
| `retryInterval` | `number` | Milliseconds between retry attempts                                   |

## How retries work

When a step throws a `RetryableError`, the runtime caches the error with `done: false`, marking the step as incomplete. The delivery ends as `suspended` with `wakeAt` set `retryInterval` milliseconds later, so the execution record becomes due again at that time, and the worker process terminates. On the next invocation, the runtime replays all cached steps until it reaches the incomplete one, clears the cached error, and re-executes the step function. This cycle repeats until the function either succeeds or exhausts `maxAttempts`.

Once all attempts are spent, the runtime throws the error into the workflow generator. You can catch it with a standard `try/catch` and run compensating logic:

```ts
try {
  yield *
    step.run(async () => {
      throw new RetryableError("flaky", { maxAttempts: 3, retryInterval: 1000 });
    });
} catch (err) {
  // all 3 attempts failed
  yield * step.run(() => markAsFailed());
}
```

## Non-retryable errors

Not every failure warrants a retry. Any error that is not a `RetryableError` completes the step immediately with that error, without suspending. The runtime stores the error and throws it into the workflow. If the workflow does not catch it, the execution record becomes `failed` with that error as its outcome.

```ts
yield *
  step.run(() => {
    throw new Error("fatal"); // no retry, thrown immediately
  });
```

## Retry via polling

For cases where a step needs to wait on an external condition rather than recover from a failure, `step.poll` wraps the retry mechanism in a predicate loop. It evaluates a function at a fixed interval and completes when the function returns `true`. If the function returns `false`, the poll throws a `RetryableError` internally with the configured policy. If it throws a regular error, the step fails without retrying.

```ts
yield * step.poll({ retryInterval: 1000, maxAttempts: 10 }, () => isReady());
```
