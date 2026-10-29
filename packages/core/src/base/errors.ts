import { EffectClientInvariantError, WorkflowEffectError } from "./effect";
import { WorkflowStartError } from "./execution";

export type WorkflowValueErrorCode = "INVALID_STEP_VALUE" | "STEP_SCHEMA_INVALID";

/** The `stepKey` of a `WorkflowValueError` raised by an invalid workflow result. */
export const WORKFLOW_RESULT_STEP_KEY = "$$workflow-result$$";

/**
 * Thrown to workflow code when a step produces a value the durable value codec
 * rejects, or a step's schema rejects its decoded value. It is recorded as the
 * step's error, so replay throws it again.
 */
export class WorkflowValueError extends Error {
  readonly code: WorkflowValueErrorCode;
  readonly stepKey: string;

  constructor(code: WorkflowValueErrorCode, stepKey: string, message: string) {
    super(message);
    this.name = "WorkflowValueError";
    this.code = code;
    this.stepKey = stepKey;
  }
}

export type ErrorClass = abstract new (...args: any[]) => Error;

const errorClasses = new Map<string, ErrorClass>();

/**
 * Registers the class that decoding revives errors named `name` as, replacing
 * any class registered under that name. Registration is per process: a worker
 * that has not registered a class revives its errors as plain `Error`s with
 * the same name, message, code, cause and fields.
 */
export function registerErrorClass(name: string, errorClass: ErrorClass): void {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("Error class name must be a non-empty string");
  }
  if (
    typeof errorClass !== "function" ||
    !(errorClass.prototype instanceof Error || errorClass === Error)
  ) {
    throw new TypeError(`Error class "${name}" must extend Error`);
  }
  errorClasses.set(name, errorClass);
}

export function registeredErrorClass(name: string): ErrorClass | undefined {
  return errorClasses.get(name);
}

// Names are spelled out so a minifying bundler cannot change them.
const defaults: [string, ErrorClass][] = [
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
  ["ReferenceError", ReferenceError],
  ["EvalError", EvalError],
  ["URIError", URIError],
  ["AggregateError", AggregateError],
  ["WorkflowStartError", WorkflowStartError],
  ["WorkflowValueError", WorkflowValueError],
  ["WorkflowEffectError", WorkflowEffectError],
  ["EffectClientInvariantError", EffectClientInvariantError],
];
for (const [name, errorClass] of defaults) registerErrorClass(name, errorClass);
