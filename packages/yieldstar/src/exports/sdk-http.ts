import type {
  EventParamsOf,
  WorkflowRouter,
  TriggerEvent,
  WorkflowGeneratorReturnType,
  ExecutionAdmissionErrorCode,
} from "@yieldstar/core";
import { deserializeError } from "serialize-error";
import {
  ExecutionAdmissionError,
  errorWithOriginalStack,
} from "@yieldstar/core";

type TriggerAck = {
  executionId: string;
};

type TriggerResponse<W extends WorkflowRouter, K extends string & keyof W> = {
  executionId: string;
  ack: () => Promise<TriggerAck>;
  waitForResult: () => Promise<WorkflowGeneratorReturnType<W[K]>>;
};

const admissionErrorCodes: ExecutionAdmissionErrorCode[] = [
  "EXECUTION_ID_CONFLICT",
  "INVALID_EXECUTION_EVENT",
];

export function createHttpSdkFactory<W extends WorkflowRouter>() {
  return (params: {
    url: string;
    fetchOptions?: Omit<RequestInit, "body" | "method">;
  }) => {
    return {
      /**
       * Admits an execution through the trigger route. When `executionId` is
       * omitted the runtime chooses one, which the response carries.
       * @throws {ExecutionAdmissionError} on `409 Conflict` or an invalid event
       */
      async trigger<K extends string & keyof W>(
        event: TriggerEvent<K, EventParamsOf<W[K]>>
      ): Promise<TriggerResponse<W, K>> {
        const res = await fetch(`${params.url}/trigger`, {
          ...params.fetchOptions,
          method: "POST",
          body: JSON.stringify({
            executionId: event?.executionId,
            workflowId: event?.workflowId,
            params: event?.params,
            context: event?.context,
          }),
        });

        if (res.ok) {
          const ack = (await res.json()) as TriggerAck;
          return {
            executionId: ack.executionId,
            ack: async () => ack,
            waitForResult: () => this.waitForResult<K>(ack),
          };
        }

        const body = (await res.json().catch(() => undefined)) as
          | { code?: ExecutionAdmissionErrorCode; message?: string }
          | undefined;
        if (body?.code && admissionErrorCodes.includes(body.code)) {
          throw new ExecutionAdmissionError(body.code, body.message ?? res.statusText);
        }
        throw res.statusText;
      },
      async waitForResult<K extends string & keyof W>(
        ack: TriggerAck
      ): Promise<WorkflowGeneratorReturnType<W[K]>> {
        const res = await fetch(`${params.url}/events`, {
          method: "POST",
          body: JSON.stringify({ executionId: ack.executionId }),
          ...params.fetchOptions,
        });

        if (res.status === 500) {
          const error = await res.json();
          throw errorWithOriginalStack(
            deserializeError(error),
            this.waitForResult
          );
        }

        if (!res.ok) {
          throw res.statusText;
        }

        return res.json() as Promise<WorkflowGeneratorReturnType<W[K]>>;
      },
    };
  };
}
