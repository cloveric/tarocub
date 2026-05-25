import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { LarkNormalizedBridgeMessage } from "./message-normalizer.js";

export async function appendLarkTimelineEvent(
  stateDir: string,
  normalized: LarkNormalizedBridgeMessage,
  input: {
    type: Parameters<typeof appendTimelineEventBestEffort>[1]["type"];
    outcome?: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(stateDir, {
    type: input.type,
    channel: "lark",
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    conversationKey: normalized.conversationKey,
    outcome: input.outcome,
    detail: input.detail,
    metadata: {
      larkChatId: normalized.chatId,
      larkMessageId: normalized.messageId,
      bridgeChatType: normalized.bridgeChatType,
      ...input.metadata,
    },
  }, "Lark timeline event");
}
