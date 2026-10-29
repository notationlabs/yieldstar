::code-group

```ts [src/workflow.ts]
import { workflow } from "yieldstar"

export const summarise = workflow(async function* (step, event) {
  let draft = yield* step.run(() => llm(`Write a blog post about ${event.params.topic}`));

  for (let round = 0; ; round++) {
    const feedback = yield* step.run(`feedback:${round}`, () => getUserFeedback({ draft }));
    if (!feedback) break;
    draft = yield* step.run(`revise:${round}`, () => llm(`Improve:\n${draft}\nFeedback:${feedback}`));
  }

  return yield* step.run(() => publish(draft));
})
```

```ts [src/trigger.ts]
import { createLocalSdk } from "yieldstar";
import { runtime, invoker } from "./shared";
import type { Router } from "./router";

const sdk = createLocalSdk<Router>(runtime, { invoker });

const result = await sdk.triggerAndWait({
  workflowId: "summarise",
  params: { topic: "quantum computing" },
});

console.log(`Published to ${result.url}`);
```

::
