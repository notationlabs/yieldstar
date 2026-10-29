import {
  StepDelay,
  StepError,
  StepResult,
  StepResponse,
  StepStoreWait,
  WorkflowResult,
} from "@yieldstar/core";
import { isErrorLike, serializeError, deserializeError } from "serialize-error";

export function serializeStepResponse(data: StepResponse): string {
  const replaceErrors = (key: string, value: any) => {
    if (value instanceof Error) {
      return serializeError(value);
    }
    return value;
  };

  return JSON.stringify(data, replaceErrors);
}

export function deserializeStepResponse(jsonString: string): StepResponse {
  const reviveErrors = (key: string, value: any) => {
    if (isErrorLike(value)) {
      return deserializeError(value);
    }
    return value;
  };

  const stepResponse = JSON.parse(jsonString, reviveErrors);

  switch (stepResponse.type) {
    case "step-error":
      const { err, ...params } = stepResponse;
      return new StepError(stepResponse.err, params);
    case "step-delay":
      return new StepDelay(stepResponse.wakeAt);
    case "step-result":
      return new StepResult(stepResponse.result);
    case "store-wait":
      return new StepStoreWait();
    case "workflow-result":
      return new WorkflowResult(stepResponse.result);
    default:
      throw new Error("Unknown step result type: " + stepResponse.type);
  }
}
