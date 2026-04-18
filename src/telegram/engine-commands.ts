import { classifyFailure } from "../runtime/error-classification.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

function isCompactCommand(text: string): boolean {
  return /^\/compact(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isUltrareviewCommand(text: string): boolean {
  return /^\/ultrareview(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isContextCommand(text: string): boolean {
  return /^\/context(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export interface EngineCommandConfig {
  engine: "codex" | "claude";
  resume?: {
    workspacePath: string;
  };
}

export interface EngineCommandBridge {
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    locale: Locale;
    text: string;
    files: string[];
    workspaceOverride?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string }>;
}

export interface EngineCommandContext extends TelegramTurnContext {
  abortSignal?: AbortSignal;
}

export interface EngineCommandSessionStore {
  removeByChatId(chatId: number): Promise<boolean | void>;
}

export async function handleLocalEngineTelegramCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: EngineCommandConfig;
  normalized: NormalizedTelegramMessage;
  context: EngineCommandContext;
  bridge: EngineCommandBridge;
  sessionStore: EngineCommandSessionStore;
}): Promise<boolean> {
  const { stateDir, startedAt, locale, cfg, normalized, context, bridge, sessionStore } = input;

  if (isCompactCommand(normalized.text)) {
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "正在压缩会话上下文..." : "Compacting session context...",
    );

    let compactAuditText: string | undefined;
    try {
      const result = await bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        locale,
        text: "/compact",
        files: [],
        workspaceOverride: cfg.resume?.workspacePath,
      });

      const compactMsg = locale === "zh"
        ? `上下文已压缩。\n\n${result.text}`
        : `Context compacted.\n\n${result.text}`;
      compactAuditText = compactMsg;
      const chunks = chunkTelegramMessage(compactMsg);
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      if (classifyFailure(error) === "auth") {
        throw error;
      }
      await sessionStore.removeByChatId(normalized.chatId);
      const fallbackMsg = locale === "zh"
        ? "引擎不支持 compact，已重置会话（效果相同）。"
        : "Engine does not support compact. Session reset instead (same effect).";
      compactAuditText = fallbackMsg;
      await context.api.sendMessage(normalized.chatId, fallbackMsg);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "compact",
      responseText: compactAuditText,
    });
    return true;
  }

  if (isUltrareviewCommand(normalized.text)) {
    if (cfg.engine !== "claude") {
      const msg = locale === "zh"
        ? "/ultrareview 仅支持 Claude 引擎（Opus 4.7+）。"
        : "/ultrareview is only supported with the Claude engine (Opus 4.7+).";
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "ultrareview",
        responseText: msg,
        metadata: { rejected: "wrong-engine" },
      });
      return true;
    }

    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "正在进行代码审查..." : "Running code review...",
    );

    const result = await bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
      text: "/ultrareview",
      files: [],
      workspaceOverride: cfg.resume?.workspacePath,
      abortSignal: context.abortSignal,
    });

    const chunks = chunkTelegramMessage(result.text);
    await context.api.sendMessage(normalized.chatId, chunks[0]!);
    for (const chunk of chunks.slice(1)) {
      await context.api.sendMessage(normalized.chatId, chunk);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "ultrareview",
      responseText: result.text,
    });
    return true;
  }

  if (isContextCommand(normalized.text)) {
    if (cfg.engine !== "claude") {
      const msg = locale === "zh"
        ? "/context 仅支持 Claude 引擎。Codex 的上下文由服务端自管，无法本地查询。"
        : "/context is only supported with the Claude engine. Codex manages context server-side and does not expose this.";
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "context",
        responseText: msg,
        metadata: { rejected: "wrong-engine" },
      });
      return true;
    }

    const result = await bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
      text: "/context",
      files: [],
      workspaceOverride: cfg.resume?.workspacePath,
      abortSignal: context.abortSignal,
    });

    const chunks = chunkTelegramMessage(result.text);
    await context.api.sendMessage(normalized.chatId, chunks[0]!);
    for (const chunk of chunks.slice(1)) {
      await context.api.sendMessage(normalized.chatId, chunk);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "context",
      responseText: result.text,
    });
    return true;
  }

  return false;
}
