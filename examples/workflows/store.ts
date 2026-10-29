import * as v from "valibot";
import { defineStore, workflow, type WorkflowEvent } from "yieldstar";

type ConversationParams = {
  conversationId: string;
  content: string;
};

const ConversationSchema = v.object({
  messages: v.array(
    v.object({
      id: v.string(),
      content: v.string(),
    })
  ),
});

const ConversationStore = defineStore("conversation", ConversationSchema, {
  initial: () => ({ messages: [] }),
});

export const storeWorkflow = workflow(async function* (
  step,
  event: WorkflowEvent<ConversationParams>
) {
  const conversation = yield* step.store(ConversationStore, {
    id: event.params.conversationId,
    initial: { messages: [] },
  });

  yield* conversation.update("append-message", (draft) => {
    draft.messages.push({
      id: crypto.randomUUID(),
      content: event.params.content,
    });
  });

  const snapshot = yield* conversation.get("read-conversation");
  return snapshot.state;
});
