import {
  CODEX_EFFORT_COMPATIBILITY_EN,
  CODEX_EFFORT_COMPATIBILITY_ZH,
  CODEX_MODEL_CHOICES,
  isExtendedCodexEffort,
  knownCodexModelMaxEffort,
  knownCodexModelSupportsEffort,
} from "../codex/model-capabilities.js";
import { EFFORT_LEVELS, type EffortLevel } from "../state/config-file-schema.js";
import { UsageStore } from "../state/usage-store.js";
import { renderRuntimeTimeoutMessage } from "../runtime/runtime-timeout-message.js";
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
import {
  ANTIGRAVITY_EFFORT_LEVELS,
  CLAUDE_MODEL_CHOICES,
  DEEPSEEK_EFFORT_LEVELS,
  KIMI_EFFORT_LEVELS,
  loadInstanceConfig,
  normalizeModelCommandInput,
  type InstanceEngine,
} from "./instance-config.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

const VALID_EFFORT_LEVELS: EffortLevel[] = [...EFFORT_LEVELS];

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
  return { level: match[1]?.toLowerCase() ?? "" };
}

function parseModelCommand(text: string): { model: string } | null {
  const match = text.trim().match(/^\/model(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { model: match[1]?.trim() ?? "" };
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

function parseTimeoutCommand(text: string): { action: "status" | "on" | "off" } | null {
  const match = text.trim().match(/^\/timeout(?:@\w+)?(?:\s+(on|off))?$/i);
  if (!match) return null;
  return { action: (match[1]?.toLowerCase() ?? "status") as "status" | "on" | "off" };
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
    disableRuntimeTimeout?: boolean;
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
            ...CLAUDE_MODEL_CHOICES.map((model) => `/model ${model}`),
            "/model off",
            "跟随最新 Opus 的别名：/model opus[1m]",
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Choose a model with /model <name>:",
            ...CLAUDE_MODEL_CHOICES.map((model) => `/model ${model}`),
            "/model off",
            "Latest Opus alias: /model opus[1m]",
          ].join("\n");
    }
    if (cfg.engine === "kimi") {
      return locale === "zh"
        ? [
            `当前模型: ${current}`,
            "用 /model <id> 设置当前 Kimi provider 配置实际提供的模型。",
            "/model off",
            "下一轮开始时会通过 ACP 校验该模型 ID。",
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Use /model <id> with a model advertised by your Kimi provider configuration.",
            "/model off",
            "Kimi validates the exact model ID through ACP when the next turn starts.",
          ].join("\n");
    }

    if (cfg.engine === "codex") {
      return locale === "zh"
        ? [
            `当前模型: ${current}`,
            "用 /model <名称> 选择模型：",
            ...CODEX_MODEL_CHOICES.map((model) => `/model ${model}`),
            "/model off",
            CODEX_EFFORT_COMPATIBILITY_ZH,
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Choose a model with /model <name>:",
            ...CODEX_MODEL_CHOICES.map((model) => `/model ${model}`),
            "/model off",
            CODEX_EFFORT_COMPATIBILITY_EN,
          ].join("\n");
    }

    if (cfg.engine === "deepseek") {
      return locale === "zh"
        ? [
            `当前模型: ${current}`,
            "用 /model <provider/model> 或 /model <model-id> 选择 DeepSeek Harness 提供的模型。",
            "/model off",
            "下一轮开始时，DeepSeek Harness 会通过 session model API 校验该选择。",
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Use /model <provider/model> or /model <model-id> with a model advertised by DeepSeek Harness.",
            "/model off",
            "DeepSeek Harness validates the selection through its session model API on the next turn.",
          ].join("\n");
    }

    if (cfg.engine === "antigravity") {
      return locale === "zh"
        ? [
            `当前模型: ${current}`,
            "用 /model <id> 设置 agy models 列出的模型；下一轮启动时由 agy 校验。",
            "/model off",
          ].join("\n")
        : [
            `Current model: ${current}`,
            "Use /model <id> with a model listed by agy models; agy validates it when the next turn starts.",
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
    let usageMessage = renderUsageMessage(usage, locale);
    // Non-Claude engines do not currently report dollar cost, so a configured budget can
    // never trip. When one is set, say so instead of silently implying the cap
    // protects this instance.
    const instanceConfig = await loadInstanceConfig(stateDir);
    const engine = cfg.engine ?? instanceConfig.engine;
    if (engine === "kimi") {
      usageMessage = [
        usageMessage,
        locale === "zh"
          ? `注意：Kimi ACP 当前不上报结构化的单轮 token 或费用；这些累计数据不包含 Kimi turn${instanceConfig.budgetUsd !== undefined ? "，已配置的预算上限也无法追踪它们" : ""}。`
          : `Note: Kimi ACP does not currently report structured per-turn tokens or cost; Kimi turns are excluded from these totals${instanceConfig.budgetUsd !== undefined ? " and the configured budget cap cannot track them" : ""}.`,
      ].join("\n");
    } else if (engine === "deepseek") {
      usageMessage = [
        usageMessage,
        locale === "zh"
          ? `注意：DeepSeek Harness 会上报 token 用量，但不上报美元费用${instanceConfig.budgetUsd !== undefined ? "；已配置的预算上限无法追踪或约束 DeepSeek turn" : ""}。`
          : `Note: DeepSeek Harness reports token usage but not dollar cost${instanceConfig.budgetUsd !== undefined ? "; the configured budget cap cannot track or constrain DeepSeek turns" : ""}.`,
      ].join("\n");
    } else if (instanceConfig.budgetUsd !== undefined && engine !== "claude") {
      usageMessage = [
        usageMessage,
        locale === "zh"
          ? "注意：Codex/Antigravity 引擎不上报美元成本，预算上限目前只对 Claude 生效。"
          : "Note: Codex/Antigravity engines do not report dollar costs; the budget cap currently only takes effect on the Claude engine.",
      ].join("\n");
    }
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

  const timeoutCmd = parseTimeoutCommand(normalized.text);
  if (timeoutCmd) {
    const currentlyEnabled = cfg.disableRuntimeTimeout !== true;
    let timeoutEnabled = currentlyEnabled;
    if (timeoutCmd.action !== "status") {
      timeoutEnabled = timeoutCmd.action === "on";
      await updateInstanceConfig((config) => {
        config.disableRuntimeTimeout = !timeoutEnabled;
      });
    }
    const timeoutMessage = renderRuntimeTimeoutMessage(cfg.engine, timeoutEnabled, timeoutCmd.action, locale);
    await context.api.sendMessage(normalized.chatId, timeoutMessage);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "timeout",
      responseText: timeoutMessage,
      metadata: { value: timeoutCmd.action === "status" ? (timeoutEnabled ? "on" : "off") : timeoutCmd.action },
    });
    return true;
  }

  const effortCmd = parseEffortCommand(normalized.text);
  if (effortCmd) {
    let effortMessage: string;
    let auditValue = effortCmd.level || "query";
    if (!effortCmd.level) {
      const current = cfg.effort ?? "default";
      effortMessage = locale === "zh" ? `当前 effort: ${current}` : `Current effort: ${current}`;
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (cfg.engine === "claude" && effortCmd.level === "ultra") {
      auditValue = "unsupported-claude-ultra";
      effortMessage = locale === "zh"
        ? "Claude 不支持 ultra；最高可用 max。"
        : "Claude does not support ultra; use max for its highest effort.";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (
      cfg.engine === "kimi" &&
      !KIMI_EFFORT_LEVELS.includes(effortCmd.level as (typeof KIMI_EFFORT_LEVELS)[number]) &&
      effortCmd.level !== "off" && effortCmd.level !== "default"
    ) {
      auditValue = "unsupported-kimi-effort";
      effortMessage = locale === "zh"
        ? "Kimi effort 仅支持 low、high、max 或 off。"
        : "Kimi effort supports only low, high, max, or off.";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (
      cfg.engine === "deepseek" &&
      !DEEPSEEK_EFFORT_LEVELS.includes(effortCmd.level as (typeof DEEPSEEK_EFFORT_LEVELS)[number]) &&
      effortCmd.level !== "off" && effortCmd.level !== "default"
    ) {
      auditValue = "unsupported-deepseek-effort";
      effortMessage = locale === "zh"
        ? "DeepSeek Harness effort 仅支持 low、high、max 或 off。"
        : "DeepSeek Harness effort supports only low, high, max, or off.";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (
      cfg.engine === "antigravity" &&
      !ANTIGRAVITY_EFFORT_LEVELS.includes(effortCmd.level as (typeof ANTIGRAVITY_EFFORT_LEVELS)[number]) &&
      effortCmd.level !== "off" && effortCmd.level !== "default"
    ) {
      auditValue = "unsupported-antigravity-effort";
      effortMessage = locale === "zh"
        ? "Antigravity effort 仅支持 low、medium、high 或 off。"
        : "Antigravity effort supports only low, medium, high, or off.";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (VALID_EFFORT_LEVELS.includes(effortCmd.level as EffortLevel) && cfg.engine === "codex") {
      const effort = effortCmd.level as EffortLevel;
      const support = knownCodexModelSupportsEffort(cfg.model, effort);
      if (support === false || (support === undefined && isExtendedCodexEffort(effort))) {
        const maxEffort = knownCodexModelMaxEffort(cfg.model);
        auditValue = support === false ? "unsupported-model-effort" : "unknown-model-effort";
        effortMessage = maxEffort
          ? locale === "zh"
            ? `${cfg.model} 不支持 ${effort}；最高可用 ${maxEffort}。`
            : `${cfg.model} does not support ${effort}; its highest effort is ${maxEffort}.`
          : locale === "zh"
            ? `请先选择明确兼容的模型再设置 ${effort}（例如 /model gpt-5.6-sol）。`
            : `Select an explicit compatible model before setting ${effort} (for example, /model gpt-5.6-sol).`;
        await context.api.sendMessage(normalized.chatId, effortMessage);
      } else {
        auditValue = effort;
        await updateInstanceConfig((c) => { c.effort = effort; });
        effortMessage = locale === "zh" ? `Effort 已设为 ${effort}。` : `Effort set to ${effort}.`;
        await context.api.sendMessage(normalized.chatId, effortMessage);
      }
    } else if (VALID_EFFORT_LEVELS.includes(effortCmd.level as EffortLevel)) {
      auditValue = effortCmd.level;
      await updateInstanceConfig((c) => { c.effort = effortCmd.level; });
      effortMessage = locale === "zh" ? `Effort 已设为 ${effortCmd.level}。` : `Effort set to ${effortCmd.level}.`;
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else if (effortCmd.level === "off" || effortCmd.level === "default") {
      await updateInstanceConfig((c) => { delete c.effort; });
      effortMessage = locale === "zh" ? "Effort 已恢复默认。" : "Effort reset to default.";
      await context.api.sendMessage(normalized.chatId, effortMessage);
    } else {
      effortMessage = locale === "zh"
        ? "用法: /effort [low|medium|high|xhigh|max|ultra|off]"
        : "Usage: /effort [low|medium|high|xhigh|max|ultra|off]";
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
    const normalizedModel = normalizeModelCommandInput(cfg.engine, modelCmd.model);
    let auditValue = normalizedModel || "query";
    if (!normalizedModel) {
      modelMessage = renderModelSelectionMessage();
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else if (!isSingleTokenModelName(normalizedModel)) {
      auditValue = "invalid";
      modelMessage = locale === "zh"
        ? "用法: /model <单个模型名|off>"
        : "Usage: /model <single-token-name|off>";
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else if (
      (normalizedModel === "off" || normalizedModel === "default") &&
      cfg.engine === "codex" &&
      isExtendedCodexEffort(cfg.effort as EffortLevel | undefined)
    ) {
      auditValue = "default-model-incompatible-effort";
      modelMessage = locale === "zh"
        ? `当前 effort 为 ${cfg.effort}，不能恢复默认模型；请先重置 /effort。`
        : `Cannot restore the default model while effort is ${cfg.effort}; reset /effort first.`;
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else if (normalizedModel === "off" || normalizedModel === "default") {
      await updateInstanceConfig((c) => { delete c.model; });
      modelMessage = locale === "zh" ? "模型已恢复默认。" : "Model reset to default.";
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else if (
      cfg.engine === "codex" &&
      cfg.effort &&
      VALID_EFFORT_LEVELS.includes(cfg.effort as EffortLevel) &&
      (knownCodexModelSupportsEffort(normalizedModel, cfg.effort as EffortLevel) === false ||
        (knownCodexModelSupportsEffort(normalizedModel, cfg.effort as EffortLevel) === undefined &&
          isExtendedCodexEffort(cfg.effort as EffortLevel)))
    ) {
      auditValue = "unsupported-model-effort";
      const maxEffort = knownCodexModelMaxEffort(normalizedModel);
      modelMessage = maxEffort
        ? locale === "zh"
          ? `${normalizedModel} 最高支持 ${maxEffort}，与当前 effort ${cfg.effort} 不兼容；请先调整 /effort。`
          : `${normalizedModel} supports up to ${maxEffort}, which is incompatible with current effort ${cfg.effort}; change /effort first.`
        : locale === "zh"
          ? `无法确认 ${normalizedModel} 是否支持 ${cfg.effort}；请先降低 /effort 或选择列表中的模型。`
          : `Compatibility between ${normalizedModel} and effort ${cfg.effort} is unknown; lower /effort or choose a listed model first.`;
      await context.api.sendMessage(normalized.chatId, modelMessage);
    } else {
      await updateInstanceConfig((c) => { c.model = normalizedModel; });
      modelMessage = locale === "zh" ? `模型已设为 ${normalizedModel}。` : `Model set to ${normalizedModel}.`;
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
