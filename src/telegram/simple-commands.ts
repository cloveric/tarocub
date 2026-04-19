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
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const VALID_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

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
  const match = text.trim().match(/^\/model(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!match) return null;
  return { model: match[1] ?? "" };
}

export async function handleSimpleLocalTelegramCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: {
    effort?: string;
    model?: string;
  };
  normalized: NormalizedTelegramMessage;
  context: TelegramTurnContext;
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
  resolveStatus?: (chatId: number) => Promise<{
    engine: "codex" | "claude";
    sessionBound: boolean | null;
    threadId?: string | null;
    blockingTasks: number | null;
    waitingTasks: number | null;
    sessionWarning?: string;
    taskStateWarning?: string;
  }>;
}): Promise<boolean> {
  const { stateDir, startedAt, locale, cfg, normalized, context, updateInstanceConfig, resolveStatus } = input;

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
    if (!effortCmd.level) {
      const current = cfg.effort ?? "default";
      effortMessage = locale === "zh" ? `当前 effort: ${current}` : `Current effort: ${current}`;
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (VALID_EFFORT_LEVELS.includes(effortCmd.level as EffortLevel)) {
      await updateInstanceConfig((c) => { c.effort = effortCmd.level; });
      effortMessage = locale === "zh" ? `Effort 已设为 ${effortCmd.level}。` : `Effort set to ${effortCmd.level}.`;
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
      metadata: { value: effortCmd.level || "query" },
    });
    return true;
  }

  const modelCmd = parseModelCommand(normalized.text);
  if (modelCmd) {
    let modelMessage: string;
    if (!modelCmd.model) {
      const current = cfg.model ?? "default";
      modelMessage = locale === "zh" ? `当前模型: ${current}` : `Current model: ${current}`;
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
      metadata: { value: modelCmd.model || "query" },
    });
    return true;
  }

  return false;
}
