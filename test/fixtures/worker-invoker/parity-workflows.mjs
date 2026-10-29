import { workflow } from "yieldstar";

export const parityRouter = {
  completes: workflow(async function* (step, event) {
    const doubled = yield* step.run("double", () => event.params.n * 2);
    return { doubled, requestId: event.context.get("requestId") };
  }),
  fails: workflow(async function* () {
    throw new TypeError("parity failure");
  }),
  suspends: workflow(async function* (step) {
    yield* step.delay("wait", 60_000);
    return "unreachable";
  }),
};
