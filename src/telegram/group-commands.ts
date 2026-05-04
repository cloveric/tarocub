import type { Bridge } from "../runtime/bridge.js";
import type { GroupModeConfig } from "./instance-config.js";
import type { Locale } from "./message-renderer.js";
import { renderUnauthorizedMessage } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";

export function isGroupCommand(text: string): boolean {
  return /^\/group(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function parseGroupCommand(text: string): string {
  const match = text.trim().match(/^\/group(?:@\w+)?(?:\s+(.*))?$/i);
  return (match?.[1] ?? "status").trim().toLowerCase() || "status";
}

function currentGroupMode(config: Record<string, unknown>): GroupModeConfig {
  const raw = typeof config.groupMode === "object" && config.groupMode !== null
    ? config.groupMode as Record<string, unknown>
    : {};
  const allowedChatIds = Array.isArray(raw.allowedChatIds)
    ? raw.allowedChatIds.filter((value): value is number => Number.isInteger(value))
    : [];
  const listenAllChatIds = Array.isArray(raw.listenAllChatIds)
    ? raw.listenAllChatIds.filter((value): value is number => Number.isInteger(value))
    : [];
  return {
    enabled: raw.enabled === false ? false : true,
    allowedChatIds: [...new Set(allowedChatIds)],
    listenAllChatIds: [...new Set(listenAllChatIds)],
  };
}

function setGroupMode(config: Record<string, unknown>, groupMode: GroupModeConfig): void {
  config.groupMode = {
    enabled: groupMode.enabled,
    allowedChatIds: [...new Set(groupMode.allowedChatIds)],
    listenAllChatIds: [...new Set(groupMode.listenAllChatIds)],
  };
}

function allowCurrentGroup(groupMode: GroupModeConfig, chatId: number): void {
  groupMode.enabled = true;
  if (!groupMode.allowedChatIds.includes(chatId)) {
    groupMode.allowedChatIds.push(chatId);
  }
}

function renderGroupUsage(locale: Locale): string {
  return locale === "zh"
    ? "用法: /group [status|allow|deny|on|off|all|at]"
    : "Usage: /group [status|allow|deny|on|off|all|at]";
}

function renderGroupStatus(input: {
  locale: Locale;
  chatType: string;
  chatId: number;
  groupMode: GroupModeConfig;
}): string {
  const { locale, chatType, chatId, groupMode } = input;
  const currentAllowed = chatType !== "private" && groupMode.allowedChatIds.includes(chatId);
  const currentListenAll = chatType !== "private" && groupMode.listenAllChatIds.includes(chatId);
  if (locale === "zh") {
    return [
      `群聊模式：${groupMode.enabled ? "开启" : "关闭"}`,
      `已允许群数：${groupMode.allowedChatIds.length}`,
      chatType === "private" ? undefined : `当前群：${currentAllowed ? "已允许" : "未允许"} (${chatId})`,
      chatType === "private" ? undefined : `当前群监听：${currentListenAll ? "所有普通消息" : "需要 @/回复 bot"}`,
      "群里仍然只允许已授权 userId 使用 bot。",
      "同一 topic 内授权用户共享同一个会话上下文。",
    ].filter(Boolean).join("\n");
  }
  return [
    `Group mode: ${groupMode.enabled ? "on" : "off"}`,
    `Allowed groups: ${groupMode.allowedChatIds.length}`,
    chatType === "private" ? undefined : `Current group: ${currentAllowed ? "allowed" : "not allowed"} (${chatId})`,
    chatType === "private" ? undefined : `Current group listen mode: ${currentListenAll ? "all messages" : "mentions/replies only"}`,
    "Group messages still require an authorized userId.",
    "Authorized users share one session context within the same topic.",
  ].filter(Boolean).join("\n");
}

export async function handleGroupCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: {
    groupMode: GroupModeConfig;
  };
  normalized: NormalizedTelegramMessage;
  context: TelegramTurnContext & {
    bridge: Pick<Bridge, "checkUserAuthorization">;
    api: TelegramTurnContext["api"] & {
      leaveChat(chatId: number): Promise<unknown>;
    };
  };
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
}): Promise<boolean> {
  const { stateDir, startedAt, locale, cfg, normalized, context, updateInstanceConfig } = input;
  if (!isGroupCommand(normalized.text)) {
    return false;
  }

  const auth = await context.bridge.checkUserAuthorization({
    chatId: normalized.chatId,
    userId: normalized.userId,
    chatType: normalized.chatType,
    messageThreadId: normalized.messageThreadId,
    conversationKey: normalized.conversationKey,
    locale,
  });

  if (auth.kind !== "allow") {
    const message = auth.text ?? renderUnauthorizedMessage(locale);
    if (normalized.chatType === "private") {
      await context.api.sendMessage(normalized.chatId, message);
    }
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "group",
      responseText: message,
      metadata: {
        rejected: "unauthorized-user",
        silenced: normalized.chatType !== "private",
      },
    });
    return true;
  }

  const action = parseGroupCommand(normalized.text);
  let responseText: string;

  if (action === "status") {
    responseText = renderGroupStatus({
      locale,
      chatType: normalized.chatType,
      chatId: normalized.chatId,
      groupMode: cfg.groupMode,
    });
  } else if (action === "allow") {
    if (normalized.chatType === "private") {
      responseText = locale === "zh"
        ? "请在要启用的群聊里发送 /group allow。"
        : "Send /group allow inside the group you want to enable.";
    } else {
      await updateInstanceConfig((config) => {
        const groupMode = currentGroupMode(config);
        allowCurrentGroup(groupMode, normalized.chatId);
        setGroupMode(config, groupMode);
      });
      responseText = locale === "zh"
        ? `已允许当前群聊 (${normalized.chatId})。群内仍只有已授权 userId 可使用。`
        : `Allowed this group (${normalized.chatId}). Only authorized userIds can use the bot.`;
    }
  } else if (action === "deny" || action === "remove" || action === "rm") {
    if (normalized.chatType === "private") {
      responseText = locale === "zh"
        ? "请在要移除的群聊里发送 /group deny。"
        : "Send /group deny inside the group you want to remove.";
    } else {
      await updateInstanceConfig((config) => {
        const groupMode = currentGroupMode(config);
        groupMode.allowedChatIds = groupMode.allowedChatIds.filter((chatId) => chatId !== normalized.chatId);
        groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => chatId !== normalized.chatId);
        setGroupMode(config, groupMode);
      });
      responseText = locale === "zh"
        ? `已移除当前群聊 (${normalized.chatId})，bot 将退出。`
        : `Removed this group (${normalized.chatId}); leaving now.`;
      await context.api.sendMessage(normalized.chatId, responseText);
      await context.api.leaveChat(normalized.chatId).catch(() => {});
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "group",
        responseText,
        metadata: { action },
      });
      return true;
    }
  } else if (action === "on" || action === "enable") {
    await updateInstanceConfig((config) => {
      const groupMode = currentGroupMode(config);
      groupMode.enabled = true;
      setGroupMode(config, groupMode);
    });
    responseText = locale === "zh" ? "群聊模式已开启。" : "Group mode enabled.";
  } else if (action === "off" || action === "disable") {
    await updateInstanceConfig((config) => {
      const groupMode = currentGroupMode(config);
      groupMode.enabled = false;
      setGroupMode(config, groupMode);
    });
    responseText = locale === "zh" ? "群聊模式已关闭。" : "Group mode disabled.";
  } else if (action === "all" || action === "listen all" || action === "listen everything") {
    if (normalized.chatType === "private") {
      responseText = locale === "zh"
        ? "请在要开启全量监听的群聊里发送 /group all。"
        : "Send /group all inside the group you want to listen to.";
    } else {
      await updateInstanceConfig((config) => {
        const groupMode = currentGroupMode(config);
        allowCurrentGroup(groupMode, normalized.chatId);
        if (!groupMode.listenAllChatIds.includes(normalized.chatId)) {
          groupMode.listenAllChatIds.push(normalized.chatId);
        }
        setGroupMode(config, groupMode);
      });
      responseText = locale === "zh" ? "当前群监听模式：所有普通消息。" : "Current group listen mode: all messages.";
    }
  } else if (
    action === "listen mentions" ||
    action === "listen mention" ||
    action === "listen addressed" ||
    action === "listen replies" ||
    action === "at" ||
    action === "mentions" ||
    action === "mention" ||
    action === "addressed" ||
    action === "replies"
  ) {
    if (normalized.chatType === "private") {
      responseText = locale === "zh"
        ? "请在要恢复 @/回复模式的群聊里发送 /group at。"
        : "Send /group at inside the group you want to change.";
    } else {
      await updateInstanceConfig((config) => {
        const groupMode = currentGroupMode(config);
        allowCurrentGroup(groupMode, normalized.chatId);
        groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => chatId !== normalized.chatId);
        setGroupMode(config, groupMode);
      });
      responseText = locale === "zh" ? "当前群监听模式：只响应 @/回复 bot。" : "Current group listen mode: mentions/replies only.";
    }
  } else {
    responseText = renderGroupUsage(locale);
  }

  await context.api.sendMessage(normalized.chatId, responseText);
  await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
    startedAt,
    command: "group",
    responseText,
    metadata: { action },
  });
  return true;
}
