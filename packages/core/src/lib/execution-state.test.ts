import { expect, test } from "vitest";
import { ReadOnlyMap } from "../utils/map";
import {
  createExecutionState,
  createStartedExecution,
  encodeExecutionEvent,
  matchStartRequest,
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
  ["class instance params", { workflowId: "w", params: new Date(0) }],
  ["params with undefined values", { workflowId: "w", params: { a: undefined } }],
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
