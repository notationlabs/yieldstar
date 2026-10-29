import { registerErrorClass, workflow } from "yieldstar";

export class ParcelError extends Error {
  code = "PARCEL_LOST";
  constructor(parcel, options) {
    super(`parcel ${parcel} lost`, options);
    this.name = "ParcelError";
    this.parcel = parcel;
  }
}
registerErrorClass("ParcelError", ParcelError);

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
  "fails-with-class": workflow(async function* () {
    throw new ParcelError(7, { cause: new RangeError("too heavy") });
  }),
  "returns-values": workflow(async function* (step, event) {
    const error = yield* step.run("fail", async () => {
      try {
        throw new ParcelError(8);
      } catch (err) {
        return { err };
      }
    });
    return {
      params: event.params,
      context: [...event.context.entries()],
      error: error.err,
    };
  }),
};
