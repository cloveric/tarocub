import { classifyFailure } from "../runtime/error-classification.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import { applyEngineSelection } from "./instance-config.js";
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

function parseEngineCommand(text: string): { engine: string; invalid: boolean } | null {
  const match = text.trim().match(/^\/engine(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  const rawArgs = match[1]?.trim() ?? "";
  if (!rawArgs) {
    return { engine: "", invalid: false };
  }
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) {
    return { engine: "", invalid: true };
  }
  return { engine: parts[0] ?? "", invalid: false };
}

function renderEngineSwitchMessage(input: {
  locale: Locale;
  previousEngine?: "claude" | "codex";
  engine: "claude" | "codex";
  clearedModel: boolean;
  resetSessionBindings: boolean;
  resetSessionBindingFailed: boolean;
}): string {
  const { locale, previousEngine, engine, clearedModel, resetSessionBindings, resetSessionBindingFailed } = input;

  if (locale === "zh") {
    if (resetSessionBindingFailed) {
      return `未能切换到 ${engine}：该实例的会话绑定未能先清除。当前引擎仍是 ${previousEngine ?? engine}。`;
    }
    if (clearedModel && resetSessionBindings) {
      return `引擎已设为 ${engine}。已清除先前的模型覆盖，并重置该实例的会话绑定。重启此实例后生效。`;
    }
    if (clearedModel) {
      return `引擎已设为 ${engine}。已清除先前的模型覆盖。重启此实例后生效。`;
    }
    if (resetSessionBindings) {
      return `引擎已设为 ${engine}。已重置该实例的会话绑定。重启此实例后生效。`;
    }
    return `引擎已设为 ${engine}。重启此实例后生效。`;
  }

  if (resetSessionBindingFailed) {
    return `Could not switch to ${engine} because this instance's session bindings could not be reset first. Engine remains ${previousEngine ?? engine}.`;
  }
  if (clearedModel && resetSessionBindings) {
    return `Engine set to ${engine}. Cleared the previous model override and reset this instance's session bindings. Restart this instance to apply.`;
  }
  if (clearedModel) {
    return `Engine set to ${engine}. Cleared the previous model override. Restart this instance to apply.`;
  }
  if (resetSessionBindings) {
    return `Engine set to ${engine}. Reset this instance's session bindings. Restart this instance to apply.`;
  }
  return `Engine set to ${engine}. Restart this instance to apply.`;
}

export interface EngineCommandConfig {
  engine: "codex" | "claude";
  model?: string;
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
  clearAll(): Promise<number>;
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
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
}): Promise<boolean> {
  const { stateDir, startedAt, locale, cfg, normalized, context, bridge, sessionStore, updateInstanceConfig } = input;

  const engineCmd = parseEngineCommand(normalized.text);
  if (engineCmd) {
    let engineMessage: string;
    if (!engineCmd.engine && !engineCmd.invalid) {
      engineMessage = locale === "zh"
        ? [
            `当前引擎：${cfg.engine}`,
            "用 /engine <名称> 选择引擎：",
            "/engine claude",
            "/engine codex",
            "切换后重启此实例以生效。",
          ].join("\n")
        : [
            `Current engine: ${cfg.engine}`,
            "Choose an engine with /engine <name>:",
            "/engine claude",
            "/engine codex",
            "Restart this instance after switching to apply the change.",
          ].join("\n");
      await context.api.sendMessage(normalized.chatId, engineMessage);
    } else if (engineCmd.invalid || (engineCmd.engine !== "claude" && engineCmd.engine !== "codex")) {
      engineMessage = locale === "zh"
        ? "用法: /engine [claude|codex]"
        : "Usage: /engine [claude|codex]";
      await context.api.sendMessage(normalized.chatId, engineMessage);
    } else {
      const engineChanged = cfg.engine !== engineCmd.engine;
      let clearedModel = false;
      let resetSessionBindings = false;
      let resetSessionBindingFailed = false;
      if (engineChanged) {
        try {
          await sessionStore.clearAll();
          resetSessionBindings = true;
        } catch (error) {
          resetSessionBindingFailed = true;
          console.error(
            `Failed to clear instance session bindings after switching engine to ${engineCmd.engine}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      if (!resetSessionBindingFailed) {
        await updateInstanceConfig((config) => {
          const result = applyEngineSelection(config, engineCmd.engine as "claude" | "codex");
          clearedModel = result.clearedModel;
        });
      }
      engineMessage = renderEngineSwitchMessage({
        locale,
        previousEngine: cfg.engine,
        engine: engineCmd.engine,
        clearedModel,
        resetSessionBindings,
        resetSessionBindingFailed,
      });
      await context.api.sendMessage(normalized.chatId, engineMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "engine",
      responseText: engineMessage,
      metadata: { value: engineCmd.engine || "query" },
    });
    return true;
  }

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
