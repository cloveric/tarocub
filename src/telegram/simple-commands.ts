import { UsageStore } from "../state/usage-store.js";
import {
  renderTelegramHelpMessage,
  renderTelegramStatusMessage,
  renderUsageMessage,
  type Locale,
} from "./message-renderer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import type { InstanceEngine } from "./instance-config.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const VALID_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function renderAntigravityNativeEffortMessage(locale: Locale): string {
  return locale === "zh"
    ? "Antigravity 的 effort 由 agy CLI 原生控制；bridge 目前还没有可用的 effort 启动参数。模型选择请使用 Antigravity 原生 /model picker。"
    : "Antigravity effort is controlled by the native agy CLI; the bridge does not expose an effort startup flag yet. Use Antigravity's native /model picker for model selection.";
}

function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isUsageCommand(text: string): boolean {
  return /^\/usage(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isStatusCommand(text: string): boolean {
  return /^\/status(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function parseEffortCommand(text: string): { level: string } | null {
  const match = text.trim().match(/^\/effort(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!match) return null;
  return { level: match[1] ?? "" };
}

function parseModelCommand(text: string): { model: string } | null {
  const match = text.trim().match(/^\/model(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { model: match[1]?.trim() ?? "" };
}

function toNativeModelCommandText(text: string): string | null {
  const match = text.trim().match(/^\/model(?:@\w+)?(\s+[\s\S]+)?$/i);
  if (!match) {
    return null;
  }
  return `/model${match[1]?.trim() ? ` ${match[1].trim()}` : ""}`;
}

function isSingleTokenModelName(model: string): boolean {
  return !/\s/.test(model);
}

function parseFastCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/fast(?:@\w+)?(?:\s+(.*))?$/i);
  if (!match) return null;
  const action = (match[1] ?? "").trim().toLowerCase();
  return { action: action || "status" };
}

export async function handleSimpleLocalTelegramCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: {
    engine?: InstanceEngine;
    effort?: string;
    model?: string;
    codexServiceTier?: "fast";
  };
  normalized: NormalizedTelegramMessage;
  context: TelegramTurnContext;
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
  resolveStatus?: (chatId: number) => Promise<{
    engine: InstanceEngine;
    sessionBound: boolean | null;
    threadId?: string | null;
    blockingTasks: number | null;
    waitingTasks: number | null;
    sessionWarning?: string;
    taskStateWarning?: string;
  }>;
}): Promise<boolean> {
  const { stateDir, startedAt, locale, cfg, normalized, context, updateInstanceConfig, resolveStatus } = input;

  const renderModelSelectionMessage = (): string => {
    const current = cfg.model ?? "default";

    if (cfg.engine === "claude") {
      return locale === "zh"
        ? [
            `当前模型: ${current}`,
            "用 /model <名称> 选择模型：",
            "/model opus",
            "/model sonnet",
            "/model haiku",
            "/model off",
            "1M 上下文示例：/model opus[1m]",
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Choose a model with /model <name>:",
            "/model opus",
            "/model sonnet",
            "/model haiku",
            "/model off",
            "1M context example: /model opus[1m]",
          ].join("\n");
    }

    if (cfg.engine === "codex") {
      return locale === "zh"
        ? [
            `当前模型: ${current}`,
            "用 /model <名称> 选择模型：",
            "/model gpt-5.4",
            "/model gpt-5.3-codex",
            "/model o3",
            "/model off",
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Choose a model with /model <name>:",
            "/model gpt-5.4",
            "/model gpt-5.3-codex",
            "/model o3",
            "/model off",
          ].join("\n");
    }

    return locale === "zh"
      ? [
          `当前模型: ${current}`,
          "用 /model <名称> 选择模型。",
          "示例：/model opus、/model gpt-5.4、/model off",
        ].join("\n")
      : [
          `Current model: ${current}`,
          "Choose a model with /model <name>.",
          "Examples: /model opus, /model gpt-5.4, /model off",
        ].join("\n");
  };

  if (isHelpCommand(normalized.text)) {
    const helpMessage = renderTelegramHelpMessage(locale);
    await context.api.sendMessage(normalized.chatId, helpMessage);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "help",
      responseText: helpMessage,
    });
    return true;
  }

  if (isUsageCommand(normalized.text)) {
    const usageStore = new UsageStore(stateDir);
    const usage = await usageStore.load();
    const usageMessage = renderUsageMessage(usage, locale);
    await context.api.sendMessage(normalized.chatId, usageMessage);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "usage",
      responseText: usageMessage,
    });
    return true;
  }

  if (isStatusCommand(normalized.text)) {
    if (!resolveStatus) {
      const statusMessage = locale === "zh"
        ? "当前命令路径未接入 /status 处理器。"
        : "Status handler is not wired for this command path.";
      await context.api.sendMessage(normalized.chatId, statusMessage);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "status",
        responseText: statusMessage,
        metadata: { rejected: "status-handler-not-wired" },
      });
      return true;
    }

    const status = await resolveStatus(normalized.chatId);
    const statusMessage = renderTelegramStatusMessage(status, locale);
    await context.api.sendMessage(normalized.chatId, statusMessage);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "status",
      responseText: statusMessage,
    });
    return true;
  }

  const effortCmd = parseEffortCommand(normalized.text);
  if (effortCmd) {
    let effortMessage: string;
    let auditValue = effortCmd.level || "query";
    if (cfg.engine === "antigravity") {
      effortMessage = renderAntigravityNativeEffortMessage(locale);
      auditValue = "unsupported-engine";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (!effortCmd.level) {
      const current = cfg.effort ?? "default";
      effortMessage = locale === "zh" ? `当前 effort: ${current}` : `Current effort: ${current}`;
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (VALID_EFFORT_LEVELS.includes(effortCmd.level as EffortLevel)) {
      const effectiveLevel = cfg.engine !== "claude" && effortCmd.level === "max" ? "xhigh" : effortCmd.level;
      auditValue = effectiveLevel;
      await updateInstanceConfig((c) => { c.effort = effectiveLevel; });
      effortMessage = cfg.engine !== "claude" && effortCmd.level === "max"
        ? cfg.engine === "codex"
          ? locale === "zh"
            ? "Codex 不支持 max，已改用 xhigh。"
            : "Codex does not support max effort; using xhigh instead."
          : locale === "zh"
            ? "当前引擎不支持 max，已改用 xhigh。"
            : "The current engine does not support max effort; using xhigh instead."
        : locale === "zh" ? `Effort 已设为 ${effortCmd.level}。` : `Effort set to ${effortCmd.level}.`;
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (effortCmd.level === "off" || effortCmd.level === "default") {
      await updateInstanceConfig((c) => { delete c.effort; });
      effortMessage = locale === "zh" ? "Effort 已恢复默认。" : "Effort reset to default.";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else {
      effortMessage = locale === "zh"
        ? "用法: /effort [low|medium|high|xhigh|max|off]"
        : "Usage: /effort [low|medium|high|xhigh|max|off]";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "effort",
      responseText: effortMessage,
      metadata: { value: auditValue },
    });
    return true;
  }

  const modelCmd = parseModelCommand(normalized.text);
  if (modelCmd) {
    let modelMessage: string;
    let auditValue = modelCmd.model || "query";
    if (cfg.engine === "antigravity") {
      const nativeModelText = toNativeModelCommandText(normalized.text);
      if (nativeModelText) {
        normalized.text = nativeModelText;
      }
      return false;
    } else if (!modelCmd.model) {
      modelMessage = renderModelSelectionMessage();
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else if (!isSingleTokenModelName(modelCmd.model)) {
      auditValue = "invalid";
      modelMessage = locale === "zh"
        ? "用法: /model <单个模型名|off>"
        : "Usage: /model <single-token-name|off>";
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else if (modelCmd.model === "off" || modelCmd.model === "default") {
      await updateInstanceConfig((c) => { delete c.model; });
      modelMessage = locale === "zh" ? "模型已恢复默认。" : "Model reset to default.";
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else {
      await updateInstanceConfig((c) => { c.model = modelCmd.model; });
      modelMessage = locale === "zh" ? `模型已设为 ${modelCmd.model}。` : `Model set to ${modelCmd.model}.`;
      await context.api.sendMessage(normalized.chatId, modelMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "model",
      responseText: modelMessage,
      metadata: { value: auditValue },
    });
    return true;
  }

  const fastCmd = parseFastCommand(normalized.text);
  if (fastCmd) {
    let fastMessage: string;
    let auditValue = fastCmd.action || "status";
    if (cfg.engine !== "codex") {
      fastMessage = locale === "zh" ? "Fast Mode 仅 Codex 支持。" : "Fast Mode is Codex-only.";
      await context.api.sendMessage(normalized.chatId, fastMessage);
      auditValue = "rejected-engine";
    } else if (fastCmd.action === "on" || fastCmd.action === "enable" || fastCmd.action === "fast") {
      await updateInstanceConfig((c) => { c.codexServiceTier = "fast"; });
      fastMessage = locale === "zh"
        ? "Codex Fast Mode 已开启。支持的模型会更快，但会消耗更多 credits。"
        : "Codex Fast Mode enabled. Supported models run faster but consume more credits.";
      await context.api.sendMessage(normalized.chatId, fastMessage);
      auditValue = "fast";
    } else if (fastCmd.action === "off" || fastCmd.action === "disable" || fastCmd.action === "standard" || fastCmd.action === "default") {
      await updateInstanceConfig((c) => { delete c.codexServiceTier; });
      fastMessage = locale === "zh" ? "Codex Fast Mode 已关闭。" : "Codex Fast Mode disabled.";
      await context.api.sendMessage(normalized.chatId, fastMessage);
      auditValue = "standard";
    } else if (fastCmd.action === "status") {
      const current = cfg.codexServiceTier === "fast" ? "on" : "off";
      fastMessage = locale === "zh" ? `Codex Fast Mode: ${current}` : `Codex Fast Mode: ${current}`;
      await context.api.sendMessage(normalized.chatId, fastMessage);
      auditValue = current;
    } else {
      auditValue = "invalid";
      fastMessage = locale === "zh"
        ? "用法: /fast [on|off|status]"
        : "Usage: /fast [on|off|status]";
      await context.api.sendMessage(normalized.chatId, fastMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "fast",
      responseText: fastMessage,
      metadata: { value: auditValue },
    });
    return true;
  }

  return false;
}
