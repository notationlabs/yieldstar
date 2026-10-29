import type {
  EventParamsOf,
  WorkflowRouter,
  TriggerEvent,
  WorkflowGeneratorReturnType,
  ExecutionAdmissionErrorCode,
} from "@yieldstar/core";
import {
  ExecutionAdmissionError,
  durableValueCodec,
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
       * omitted the runtime chooses one, which the response carries. The body
       * is encoded with the durable value codec, so params and context reach
       * the runtime unchanged.
       * @throws {ExecutionAdmissionError} on `409 Conflict` or an invalid event,
       * including params or context the codec rejects, before any request
       */
      async trigger<K extends string & keyof W>(
        event: TriggerEvent<K, EventParamsOf<W[K]>>
      ): Promise<TriggerResponse<W, K>> {
        const request: Record<string, unknown> = { workflowId: event?.workflowId };
        if (event?.executionId !== undefined) request.executionId = event.executionId;
        if (event && "params" in event) request.params = event.params;
        if (event?.context !== undefined) request.context = event.context;
        const encoding = durableValueCodec.encode(request);
        if (encoding.status === "invalid") {
          throw new ExecutionAdmissionError(
            "INVALID_EXECUTION_EVENT",
            `Event cannot be stored without loss: ${encoding.message}`
          );
        }
        const res = await fetch(`${params.url}/trigger`, {
          ...params.fetchOptions,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoding.canonical,
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

        if (res.status !== 500 && !res.ok) {
          throw res.statusText;
        }

        const decoding = durableValueCodec.decode(await res.text());
        if (decoding.status === "invalid") {
          throw new Error(`Invalid workflow outcome: ${decoding.message}`);
        }

        if (res.status === 500) {
          const error =
            decoding.value instanceof Error
              ? decoding.value
              : new Error(String(decoding.value));
          // Thrown as revived, so it keeps its registered class and the
          // stack recorded where it was first thrown.
          throw error;
        }

        return decoding.value as WorkflowGeneratorReturnType<W[K]>;
      },
    };
  };
}
