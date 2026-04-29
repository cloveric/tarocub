import { defaultTelegramToolRegistry, type TelegramToolRegistry } from "./telegram-tool-registry.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type {
  ExecuteTelegramToolInput,
  TelegramToolResult,
} from "./telegram-tool-types.js";

export type {
  ExecuteTelegramToolInput,
  TelegramToolContext,
  TelegramToolDefinition,
  TelegramToolResult,
} from "./telegram-tool-types.js";

export async function executeTelegramTool(
  input: ExecuteTelegramToolInput,
  registry: TelegramToolRegistry = defaultTelegramToolRegistry,
): Promise<TelegramToolResult> {
  try {
    const result = await registry.execute(input);
    await appendTimelineEventBestEffort(input.context.stateDir, {
      type: "tool.executed",
      instanceName: input.context.instanceName,
      channel: "telegram",
      chatId: input.context.chatId,
      userId: input.context.userId,
      updateId: input.context.updateId,
      outcome: result.status ?? (result.ok ? "accepted" : "rejected"),
      detail: result.error,
      metadata: {
        toolName: input.name,
        status: result.status ?? (result.ok ? "accepted" : "rejected"),
        ok: result.ok,
      },
    }, "telegram tool execution timeline event");
    return result;
  } catch (error) {
    await appendTimelineEventBestEffort(input.context.stateDir, {
      type: "tool.executed",
      instanceName: input.context.instanceName,
      channel: "telegram",
      chatId: input.context.chatId,
      userId: input.context.userId,
      updateId: input.context.updateId,
      outcome: "rejected",
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        toolName: input.name,
        status: "rejected",
        ok: false,
      },
    }, "telegram tool execution timeline event");
    throw error;
  }
}
