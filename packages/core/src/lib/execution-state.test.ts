import { expect, test } from "vitest";
import { WorkflowValueError } from "../base/errors";
import { WorkflowStartError } from "../base/execution";
import { ReadOnlyMap } from "../utils/map";
import {
  acknowledgeExecution,
  claimExecution,
  createExecutionState,
  createStartedExecution,
  decodeExecutionEvent,
  decodeExecutionOutcome,
  encodeExecutionEvent,
  encodeExecutionOutcome,
  matchStartRequest,
  prepareExecutionAdmission,
  prepareExecutionStart,
  toExecutionRecord,
} from "./execution-state";

const requestId = { executionId: "caller", stepKey: "start:job" };

function prepare(request: { workflowId: string; params?: unknown }) {
  const prepared = prepareExecutionStart({ requestId, ...request } as never);
  if (!prepared.ok) throw new Error(prepared.result.message);
  return prepared.start;
}

test.each([
  ["an empty workflow ID", { workflowId: "" }],
  ["array params", { workflowId: "w", params: [] }],
  ["null params", { workflowId: "w", params: null }],
  ["string params", { workflowId: "w", params: "x" }],
  ["class instance params", { workflowId: "w", params: new WeakMap() }],
])("prepareExecutionStart rejects %s", (_label, request) => {
  const prepared = prepareExecutionStart({ requestId, ...request } as never);
  expect(prepared.ok).toBe(false);
  if (!prepared.ok) {
    expect(prepared.result.code).toBe("INVALID_START_PARAMETERS");
  }
});

test("prepareExecutionStart distinguishes missing params from an empty object", () => {
  expect(prepare({ workflowId: "w" }).params).toBeNull();
  expect(prepare({ workflowId: "w", params: {} }).params).toBe("{}");
});

test("matchStartRequest compares workflow ID and canonical params", () => {
  const caller = createExecutionState({
    executionId: "caller",
    workflowId: "parent",
    encoded: encodeExecutionEvent({ params: undefined, context: undefined }),
    now: 0,
  });
  const { startRequest } = createStartedExecution({
    start: prepare({ workflowId: "w", params: { a: 1, b: 2 } }),
    caller,
    now: 0,
  });

  expect(
    matchStartRequest(startRequest, prepare({ workflowId: "w", params: { b: 2, a: 1 } }))
  ).toEqual({ status: "accepted", executionId: startRequest.executionId });

  for (const request of [
    { workflowId: "other", params: { a: 1, b: 2 } },
    { workflowId: "w", params: { a: 1 } },
    { workflowId: "w", params: { a: 1, b: 2, c: undefined } },
    { workflowId: "w" },
  ]) {
    expect(matchStartRequest(startRequest, prepare(request))).toMatchObject({
      status: "rejected",
      code: "START_REQUEST_MISMATCH",
    });
  }
});

test("createStartedExecution admits the target with the caller's context and a parent link", () => {
  const caller = createExecutionState({
    executionId: "caller",
    workflowId: "parent",
    encoded: encodeExecutionEvent({
      params: undefined,
      context: new ReadOnlyMap(new Map([["tenant", "t-1"]])),
    }),
    now: 0,
  });
  const { target, startRequest } = createStartedExecution({
    start: prepare({ workflowId: "w", params: { n: -0, list: [1] } }),
    caller,
    now: 5,
  });

  expect(startRequest.executionId).toBe(target.executionId);
  expect(target.executionId).not.toBe("caller");
  expect(target.dueAt).toBe(5);

  const record = toExecutionRecord(target, 5);
  expect(record).toMatchObject({
    workflowId: "w",
    params: { list: [1], n: 0 },
    status: "admitted",
    parent: { executionId: "caller", stepKey: "start:job" },
  });
  expect(record.context.get("tenant")).toBe("t-1");

  const other = createStartedExecution({
    start: prepare({ workflowId: "w" }),
    caller,
    now: 5,
  });
  expect(other.target.executionId).not.toBe(target.executionId);
  expect(toExecutionRecord(other.target, 5).params).toBeUndefined();
});

test("records admitted without start have no parent", () => {
  const state = createExecutionState({
    executionId: "e",
    workflowId: "w",
    encoded: encodeExecutionEvent({ params: undefined, context: undefined }),
    now: 0,
  });
  expect(toExecutionRecord(state, 0)).not.toHaveProperty("parent");
});

test("start params keep undefined properties", () => {
  const caller = createExecutionState({
    executionId: "caller",
    workflowId: "parent",
    encoded: encodeExecutionEvent({ params: undefined, context: undefined }),
    now: 0,
  });
  const { target } = createStartedExecution({
    start: prepare({ workflowId: "w", params: { a: undefined } }),
    caller,
    now: 0,
  });
  const params = toExecutionRecord(target, 0).params;
  expect(params).toEqual({ a: undefined });
  expect(Object.keys(params!)).toEqual(["a"]);
});

test("execution events round trip through the codec", () => {
  const params = {
    missing: undefined,
    list: [1, undefined],
    tagged: { $type: "undefined" },
    report: { name: "launch", message: "Ship it", stack: "web" },
  };
  const context = new ReadOnlyMap(
    new Map<string, unknown>([
      ["tenant", "acme"],
      ["nothing", undefined],
    ])
  );
  const decoded = decodeExecutionEvent(encodeExecutionEvent({ params, context }));
  expect(decoded.params).toEqual(params);
  expect(Object.keys(decoded.params!)).toContain("missing");
  expect(decoded.params!.report).not.toBeInstanceOf(Error);
  expect([...decoded.context.entries()]).toEqual([
    ["tenant", "acme"],
    ["nothing", undefined],
  ]);

  const bare = decodeExecutionEvent(
    encodeExecutionEvent({ params: undefined, context: undefined })
  );
  expect(bare.params).toBeUndefined();
  expect(bare.context.size).toBe(0);
});

test.each([
  ["an invalid Date in params", { params: { at: new Date(Number.NaN) }, context: new Map() }],
  ["a WeakMap in context", { params: {}, context: new Map([["at", new WeakMap()]]) }],
  ["a number context key", { params: {}, context: new Map([[7, 1]]) }],
])("prepareExecutionAdmission rejects %s with INVALID_EXECUTION_EVENT", (_label, event) => {
  expect(prepareExecutionAdmission({ workflowId: "w", ...event })).toMatchObject({
    ok: false,
    code: "INVALID_EXECUTION_EVENT",
  });
});

class PaymentError extends Error {
  code = "DECLINED";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentError";
  }
}

test("failed outcomes keep the error's registered class, code and cause", () => {
  const error = new WorkflowStartError(
    "START_REQUEST_MISMATCH",
    "mismatch"
  );
  error.cause = new PaymentError("declined");
  const decoded = decodeExecutionOutcome(
    encodeExecutionOutcome({ status: "failed", error })
  );
  if (decoded.status !== "failed") throw new Error("expected failed");
  expect(decoded.error).toBeInstanceOf(WorkflowStartError);
  expect(decoded.error).toMatchObject({ code: "START_REQUEST_MISMATCH", message: "mismatch" });
  expect(decoded.error.stack).toBe(error.stack);
  const cause = decoded.error.cause as Error & { code?: string };
  expect([cause.name, cause.message, cause.code]).toEqual(["PaymentError", "declined", "DECLINED"]);
});

test("failed outcomes record a thrown non-error as Error(String(value))", () => {
  const decoded = decodeExecutionOutcome(
    encodeExecutionOutcome({ status: "failed", error: "boom" as unknown as Error })
  );
  if (decoded.status !== "failed") throw new Error("expected failed");
  expect(Object.getPrototypeOf(decoded.error)).toBe(Error.prototype);
  expect(decoded.error.message).toBe("boom");
});

test("completed outcomes keep errors and undefined in the result", () => {
  const result = { ok: false, error: new RangeError("r"), extra: undefined };
  const decoded = decodeExecutionOutcome(
    encodeExecutionOutcome({ status: "completed", result })
  );
  if (decoded.status !== "completed") throw new Error("expected completed");
  expect(decoded.result).toEqual(result);
  expect((decoded.result as typeof result).error).toBeInstanceOf(RangeError);
});

test("acknowledging a non-durable result records a failed outcome with INVALID_STEP_VALUE", () => {
  const admitted = createExecutionState({
    executionId: "e",
    workflowId: "w",
    encoded: encodeExecutionEvent({ params: undefined, context: undefined }),
    now: 0,
  });
  const { state, lease } = claimExecution(admitted, { now: 0, duration: 1_000 });
  const acknowledged = acknowledgeExecution(state, {
    lease,
    outcome: { status: "completed", result: { at: new WeakMap() } },
    now: 1,
  });
  expect(acknowledged.state.status).toBe("failed");
  const outcome = toExecutionRecord(acknowledged.state, 1).outcome;
  for (const recorded of [acknowledged.result, outcome]) {
    if (recorded?.status !== "failed") throw new Error("expected failed");
    expect(recorded.error).toBeInstanceOf(WorkflowValueError);
    expect(recorded.error).toMatchObject({
      code: "INVALID_STEP_VALUE",
      stepKey: "$$workflow-result$$",
    });
  }
});
