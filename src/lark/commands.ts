import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
} from "../codex/adapter.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { CronStore } from "../state/cron-store.js";
import { SessionStore } from "../state/session-store.js";
import { UsageStore } from "../state/usage-store.js";
import { handleCronCommand, isCronCommand } from "../telegram/cron-commands.js";
import { handleLocalEngineTelegramCommand } from "../telegram/engine-commands.js";
import {
  applyEngineSelection,
  loadInstanceConfig,
  updateInstanceConfig,
  type EffortLevel,
  type InstanceConfig,
  type InstanceEngine,
} from "../telegram/instance-config.js";
import { renderUsageMessage } from "../telegram/message-renderer.js";
import { handleLocalSessionTelegramCommand } from "../telegram/session-commands.js";
import type { NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import {
  handleLarkBoardCommand,
  handleLarkDelegationCommand,
  handleLarkMiniBusCommand,
} from "./bus.js";
import type { LarkNormalizedBridgeMessage } from "./message-normalizer.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike } from "./service.js";
import { appendLarkTimelineEvent } from "./timeline.js";

const VALID_LARK_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const LARK_ENGINE_CHOICES: InstanceEngine[] = ["claude", "codex", "antigravity"];

type RequestLarkApproval = (input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  replyTo?: string;
  request: EngineApprovalRequest;
  abortSignal?: AbortSignal;
}) => Promise<EngineApprovalDecision>;

export type LarkCommandInput = {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  requestApproval: RequestLarkApproval;
};

export async function handleLarkSimpleCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  if (isHelpCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/help", renderLarkHelpMessage());
    return true;
  }

  if (await handleLarkSessionCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleLarkLocalEngineCommand(input, normalized, commandText)) {
    return true;
  }

  const goalCommand = parseLarkGoalCommand(commandText);
  if (goalCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const handled = await handleLarkGoalCommand(input, normalized, cfg, goalCommand, commandText);
    if (handled !== null) {
      return handled;
    }
  }

  if (await handleLarkBoardCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleLarkMiniBusCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleLarkDelegationCommand(input, normalized, commandText)) {
    return true;
  }

  if (isCronCommand(commandText)) {
    await handleLarkCronCommand(input, normalized, commandText);
    return true;
  }

  if (isStatusCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/status", await renderLarkStatusMessage(input.runtime, normalized, input.stateDir));
    return true;
  }

  if (isUsageCommand(commandText)) {
    const usage = await new UsageStore(input.stateDir).load();
    await sendLarkCommandMarkdown(input, normalized, "/usage", renderUsageMessage(usage, "zh"));
    return true;
  }

  const modelCommand = parseLarkModelCommand(commandText);
  if (modelCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkModelCommand(input.stateDir, cfg, modelCommand.model);
    await sendLarkCommandMarkdown(input, normalized, "/model", message);
    return true;
  }

  const effortCommand = parseLarkEffortCommand(commandText);
  if (effortCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkEffortCommand(input.stateDir, cfg, effortCommand.level);
    await sendLarkCommandMarkdown(input, normalized, "/effort", message);
    return true;
  }

  const fastCommand = parseLarkFastCommand(commandText);
  if (fastCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkFastCommand(input.stateDir, cfg, fastCommand.action);
    await sendLarkCommandMarkdown(input, normalized, "/fast", message);
    return true;
  }

  const engineCommand = parseLarkEngineCommand(commandText);
  if (engineCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkEngineCommand(input.stateDir, cfg, engineCommand.engine, engineCommand.invalid);
    await sendLarkCommandMarkdown(input, normalized, "/engine", message);
    return true;
  }

  const yoloCommand = parseLarkYoloCommand(commandText);
  if (yoloCommand) {
    const message = await handleLarkYoloCommand(input.stateDir, yoloCommand.action);
    await sendLarkCommandMarkdown(input, normalized, "/yolo", message);
    return true;
  }

  return false;
}

async function sendLarkCommandMarkdown(
  input: {
    channel: LarkChannelLike;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  command: string,
  markdown: string,
): Promise<void> {
  await input.channel.send(normalized.chatId, { markdown }, {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  });
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: command,
  });
}

function isLarkLocalEngineCommand(text: string): boolean {
  return /^\/(?:compact|context|ultrareview)(?:\s|$)/i.test(text.trim());
}

async function handleLarkLocalEngineCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  if (!isLarkLocalEngineCommand(commandText)) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  return await handleLocalEngineTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale: "zh",
    cfg: {
      engine: cfg.engine,
      model: cfg.model,
      resume: cfg.resume,
    },
    normalized: toSessionTelegramMessage(normalized, commandText),
    context: {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          await input.channel.send(normalized.chatId, { markdown: text }, {
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
          });
          return { message_id: 0, text };
        },
      },
      channel: "lark",
      instanceName: "lark",
    },
    bridge: input.bridge,
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
  });
}

async function handleLarkSessionCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  return await handleLocalSessionTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale: "zh",
    cfg: {
      engine: cfg.engine,
      resume: cfg.resume,
    },
    normalized: toSessionTelegramMessage(normalized, commandText),
    context: {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          await input.channel.send(normalized.chatId, { markdown: text }, {
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
          });
          return { message_id: 0, text };
        },
      },
      channel: "lark",
      instanceName: "lark",
    },
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
    validateCodexThread: input.bridge.validateCodexThread?.bind(input.bridge),
    scanRecentSessions: input.runtime.sessionRuntime?.scanRecentSessions,
    scanRecentAntigravitySessions: input.runtime.sessionRuntime?.scanRecentAntigravitySessions,
  });
}

function toSessionTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType === "private" ? "private" : "supergroup",
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export function formatLarkAccessReply(text: string): string {
  if (text.includes("lark access pair")) {
    return text;
  }

  const code = extractPairingCode(text);
  if (!code) {
    return text;
  }

  return `${text}\n在本机运行：node dist/src/index.js lark access pair ${code}`;
}

function extractPairingCode(text: string): string | null {
  return text.match(/使用配对码\s+([A-Z0-9]{6,12})\s+配对/)?.[1] ??
    text.match(/Pair this private chat with code\s+([A-Z0-9]{6,12})/i)?.[1]?.toUpperCase() ??
    null;
}

export function extractLarkMessageBody(text: string): string {
  const contextEnd = text.indexOf("</lark_context>");
  if (contextEnd === -1) {
    return text.trim();
  }
  return text.slice(contextEnd + "</lark_context>".length).trim();
}

function isHelpCommand(text: string): boolean {
  return /^\/(?:help|start)(?:\s|$)/i.test(text.trim());
}

function isStatusCommand(text: string): boolean {
  return /^\/status(?:\s|$)/i.test(text.trim());
}

function isUsageCommand(text: string): boolean {
  return /^\/usage(?:\s|$)/i.test(text.trim());
}

function parseLarkModelCommand(text: string): { model: string } | null {
  const match = text.trim().match(/^\/model(?:\s+([\s\S]+))?$/i);
  return match ? { model: match[1]?.trim() ?? "" } : null;
}

function parseLarkEffortCommand(text: string): { level: string } | null {
  const match = text.trim().match(/^\/effort(?:\s+(\S+))?$/i);
  return match ? { level: match[1] ?? "" } : null;
}

function parseLarkFastCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/fast(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseLarkEngineCommand(text: string): { engine: string; invalid: boolean } | null {
  const match = text.trim().match(/^\/engine(?:\s+(.+))?$/i);
  if (!match) return null;
  const rawArgs = match[1]?.trim() ?? "";
  if (!rawArgs) {
    return { engine: "", invalid: false };
  }
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  return parts.length === 1 ? { engine: parts[0] ?? "", invalid: false } : { engine: "", invalid: true };
}

function parseLarkYoloCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/yolo(?:\s+(\S+))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() } : null;
}

type LarkGoalCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; objective: string; tokenBudget: number | null; explicitUnbounded: boolean }
  | { kind: "invalid"; reason: "invalid_budget" | "missing_objective" };

function parseLarkGoalTokenBudget(value: string): number | null {
  const normalized = value.trim().replace(/[,_]/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const budget = amount * scale;
  return Number.isSafeInteger(budget) && budget >= 1 ? budget : null;
}

function parseLarkSetGoal(rest: string): Extract<LarkGoalCommand, { kind: "set" | "invalid" }> {
  const unboundedMatch = rest.match(/^(?:--unbounded|--no-budget)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--unbounded|--no-budget)(?:$|\s+)/i.test(rest)) {
    const objective = unboundedMatch?.[1]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget: null, explicitUnbounded: true };
  }

  const budgetMatch = rest.match(/^(?:--budget|-b)(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--budget|-b)(?:$|=|\s+)/i.test(rest)) {
    const tokenBudget = budgetMatch ? parseLarkGoalTokenBudget(budgetMatch[1] ?? "") : null;
    if (!budgetMatch || tokenBudget === null) {
      return { kind: "invalid", reason: "invalid_budget" };
    }
    const objective = budgetMatch[2]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget, explicitUnbounded: false };
  }
  return { kind: "set", objective: rest, tokenBudget: null, explicitUnbounded: false };
}

function parseLarkGoalCommand(text: string): LarkGoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const rest = match[1]?.trim() ?? "";
  if (!rest || /^status$/i.test(rest)) return { kind: "status" };
  if (/^(clear|off|reset)$/i.test(rest)) return { kind: "clear" };
  return parseLarkSetGoal(rest);
}

export function isStopCommand(text: string): boolean {
  return /^\/stop(?:\s|$)/i.test(text.trim());
}

function renderLarkHelpMessage(): string {
  return [
    "**cc-telegram-bridge for Feishu/Lark**",
    "",
    "常用命令：",
    "- `/help`：显示这份帮助",
    "- `/status`：查看当前会话状态",
    "- `/usage`：查看本实例累计用量",
    "- `/model [名称|off]`：查看或设置模型",
    "- `/effort [low|medium|high|xhigh|max|off]`：查看或设置推理强度",
    "- `/fast [on|off|status]`：开关 Codex Fast Mode",
    "- `/engine [claude|codex|antigravity]`：查看或切换后端引擎",
    "- `/yolo [on|off|unsafe]`：查看或切换审批模式",
    "- `/context` / `/compact` / `/ultrareview`：Claude 本地上下文、压缩和深度代码审查命令",
    "- `/goal [status|clear|目标|--budget N 目标]`：管理当前会话 goal；默认无 token 预算",
    "- `/btw <问题>`：旁问，不影响当前会话",
    "- `/reset`：重置当前 Lark 会话",
    "- `/detach`：断开当前绑定的 Codex thread / Antigravity conversation",
    "- `/resume` / `/resume <编号>`：Claude 扫描并选择本地 session；Antigravity 扫描 recent conversation",
    "- `/resume thread <thread-id>`：绑定 Codex thread",
    "- `/resume conversation <conversation-id>`：显式绑定 Antigravity conversation",
    "- `/cron ...`：管理飞书侧定时提醒和任务",
    "- `/board ...`：管理持久任务板",
    "- `/mini ...`：把飞书群 thread 注册成轻量 peer，做 thread-to-thread 协作",
    "- `/ask <实例> <提示>`：委托给指定 peer bot 并内联返回结果",
    "- `/fan` / `/chain` / `/verify`：调用 Agent Bus 做并行、串联和验证",
    "- `/stop`：停止当前会话正在运行或排队的任务",
    "",
    "使用方式：直接发需求、文件、图片、音视频；群聊里默认需要 @bot 才会响应。",
    "复杂任务会以交互卡片流式更新，危险操作会发审批按钮。",
  ].join("\n");
}

async function renderLarkStatusMessage(
  runtime: LarkServiceRuntime,
  normalized: LarkNormalizedBridgeMessage,
  stateDir: string,
): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  const session = await new SessionStore(path.join(stateDir, "session.json"))
    .findByConversationKeySafe(normalized.conversationKey);
  const currentSession = session.record;
  return [
    "**Lark conversation status**",
    "",
    `Engine: ${cfg.engine}`,
    `Model: ${cfg.model ?? "default"}`,
    `Effort: ${cfg.effort ?? "default"}`,
    `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`,
    `Conversation: ${normalized.conversationKey}`,
    `Chat type: ${normalized.bridgeChatType}`,
    session.warning
      ? `Session bound: unknown (${session.warning})`
      : `Session bound: ${currentSession ? "yes" : "no"}`,
    ...(cfg.engine === "codex" && currentSession ? [`Current thread: ${currentSession.codexSessionId}`] : []),
    ...(cfg.engine === "antigravity" && currentSession ? [`Current conversation: ${currentSession.codexSessionId}`] : []),
    `Active run: ${runtime.activeRuns.has(normalized.conversationKey) ? "yes" : "no"}`,
    `Pending approvals: ${runtime.pendingApprovals.size}`,
  ].join("\n");
}

function isSingleTokenLarkModelName(model: string): boolean {
  return !/\s/.test(model);
}

function renderLarkModelSelectionMessage(cfg: InstanceConfig): string {
  const current = cfg.model ?? "default";
  if (cfg.engine === "claude") {
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      "/model opus",
      "/model sonnet",
      "/model haiku",
      "/model off",
      "1M 上下文示例：/model opus[1m]",
    ].join("\n");
  }
  if (cfg.engine === "codex") {
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      "/model gpt-5.4",
      "/model gpt-5.3-codex",
      "/model o3",
      "/model off",
    ].join("\n");
  }
  return [
    `当前模型: ${current}`,
    "Antigravity 模型暂不能从 Lark 切换；请在本机交互式 agy 里使用 /model。",
  ].join("\n");
}

async function handleLarkModelCommand(stateDir: string, cfg: InstanceConfig, model: string): Promise<string> {
  if (cfg.engine === "antigravity") {
    return "Antigravity 模型切换暂不支持从 Lark 发起，因为 agy --print 不会运行交互式 /model 解析器。请在本机交互式 agy 里使用 /model；bridge 不会把 /model 当普通聊天转发给模型。";
  }
  if (!model) {
    return renderLarkModelSelectionMessage(cfg);
  }
  if (!isSingleTokenLarkModelName(model)) {
    return "用法: /model <单个模型名|off>";
  }
  if (model === "off" || model === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.model;
    });
    return "模型已恢复默认。";
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.model = model;
  });
  return `模型已设为 ${model}。`;
}

async function handleLarkEffortCommand(stateDir: string, cfg: InstanceConfig, level: string): Promise<string> {
  if (cfg.engine === "antigravity") {
    return "Antigravity 的 effort 由 agy CLI 原生控制；bridge 目前还没有可用的 effort 启动参数。模型选择请在本机交互式 agy 里使用 /model。";
  }
  if (!level) {
    return `当前 effort: ${cfg.effort ?? "default"}`;
  }
  if (level === "off" || level === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.effort;
    });
    return "Effort 已恢复默认。";
  }
  if (!VALID_LARK_EFFORT_LEVELS.includes(level as EffortLevel)) {
    return "用法: /effort [low|medium|high|xhigh|max|off]";
  }
  const effectiveLevel = cfg.engine !== "claude" && level === "max" ? "xhigh" : level;
  await updateInstanceConfig(stateDir, (config) => {
    config.effort = effectiveLevel;
  });
  return cfg.engine !== "claude" && level === "max"
    ? "Codex 不支持 max，已改用 xhigh。"
    : `Effort 已设为 ${level}。`;
}

async function handleLarkFastCommand(stateDir: string, cfg: InstanceConfig, action: string): Promise<string> {
  if (cfg.engine !== "codex") {
    return "Fast Mode 仅 Codex 支持。";
  }
  if (action === "on" || action === "enable" || action === "fast") {
    await updateInstanceConfig(stateDir, (config) => {
      config.codexServiceTier = "fast";
    });
    return "Codex Fast Mode 已开启。支持的模型会更快，但会消耗更多 credits。";
  }
  if (action === "off" || action === "disable" || action === "standard" || action === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.codexServiceTier;
    });
    return "Codex Fast Mode 已关闭。";
  }
  if (action === "status") {
    return `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`;
  }
  return "用法: /fast [on|off|status]";
}

async function handleLarkEngineCommand(
  stateDir: string,
  cfg: InstanceConfig,
  engine: string,
  invalid: boolean,
): Promise<string> {
  if (!engine && !invalid) {
    return [
      `当前引擎：${cfg.engine}`,
      "用 /engine <名称> 选择引擎：",
      ...LARK_ENGINE_CHOICES.map((choice) => `/engine ${choice}`),
      "切换后请重启 Lark service 以生效。",
    ].join("\n");
  }
  if (invalid || !LARK_ENGINE_CHOICES.includes(engine as InstanceEngine)) {
    return "用法: /engine [claude|codex|antigravity]";
  }

  const selectedEngine = engine as InstanceEngine;
  const engineChanged = cfg.engine !== selectedEngine;
  let resetSessionBindings = false;
  if (engineChanged) {
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    resetSessionBindings = (await sessionStore.clearAll()) > 0;
  }

  let clearedModel = false;
  let enabledFullAuto = false;
  await updateInstanceConfig(stateDir, (config) => {
    const result = applyEngineSelection(config, selectedEngine);
    clearedModel = result.clearedModel;
    enabledFullAuto = result.enabledFullAuto;
  });

  const details: string[] = [];
  if (clearedModel) {
    details.push("已清除先前的模型覆盖");
  }
  if (resetSessionBindings) {
    details.push("已重置该实例的会话绑定");
  }
  if (enabledFullAuto) {
    details.push("Antigravity 已自动开启 YOLO/full-auto");
  }
  const suffix = details.length > 0 ? ` ${details.join("，")}。` : "";
  return `引擎已设为 ${selectedEngine}。${suffix}重启 Lark service 后生效。`;
}

async function handleLarkYoloCommand(stateDir: string, action: string): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  if (!action || action === "status") {
    const mode = (await readRawLarkConfig(stateDir)).approvalMode ?? "normal";
    const label = mode === "bypass"
      ? "YOLO UNSAFE（跳过审批和 sandbox）"
      : mode === "full-auto" ? "YOLO（full-auto，sandboxed）" : "off（普通审批流程）";
    return `当前 YOLO: ${label}`;
  }
  if (action === "on") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "full-auto";
    });
    return `YOLO mode ON（full-auto，sandboxed）。当前引擎：${cfg.engine}。`;
  }
  if (action === "off") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "normal";
    });
    return "YOLO mode OFF。已恢复普通审批流程。";
  }
  if (action === "unsafe") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "bypass";
    });
    return "YOLO UNSAFE 已开启。将跳过审批和 sandbox，请只在可信机器和可信 workspace 使用。";
  }
  return "用法: /yolo [on|off|unsafe|status]";
}

function renderLarkGoal(goal: CodexThreadGoal): string {
  const budget = goal.tokenBudget === null ? "无 token 预算" : `${goal.tokenBudget} token 预算`;
  return [
    `目标：${goal.objective}`,
    `状态：${goal.status}`,
    budget,
    `已用 ${goal.tokensUsed} tokens，${Math.round(goal.timeUsedSeconds)} 秒`,
  ].join("\n");
}

function renderInvalidLarkGoalCommand(reason: "invalid_budget" | "missing_objective"): string {
  if (reason === "missing_objective") {
    return "请写目标，例如：/goal 写发布说明；如需限额，用 /goal --budget 50000 写发布说明。";
  }
  return "无效的 /goal token 预算。用法：--budget 50000 或 -b 50k。";
}

function toNativeLarkGoalCommandText(
  action: LarkGoalCommand,
  commandText: string,
  engine: "claude" | "antigravity",
): string | null {
  if (action.kind !== "set") {
    return commandText.trim();
  }
  if (action.tokenBudget === null) {
    return `/goal ${action.objective}`;
  }
  const engineName = engine === "antigravity" ? "Antigravity" : "Claude";
  return `/goal ${action.objective}\n\n[Bridge note: 用户请求 token 预算：${action.tokenBudget} tokens。原生 ${engineName} goal 可能只会把它当作指导，而不是强制预算。]`;
}

async function handleLarkGoalCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  cfg: InstanceConfig,
  action: LarkGoalCommand,
  commandText: string,
): Promise<boolean | null> {
  if (action.kind === "invalid") {
    await sendLarkCommandMarkdown(input, normalized, "/goal", renderInvalidLarkGoalCommand(action.reason));
    return true;
  }

  if (cfg.engine === "claude" || cfg.engine === "antigravity") {
    const nativeText = toNativeLarkGoalCommandText(action, commandText, cfg.engine);
    if (nativeText) {
      normalized.text = nativeText;
    }
    return null;
  }

  const goalInput = {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    workspaceOverride: cfg.resume?.workspacePath,
  };

  if (action.kind === "status") {
    if (!input.bridge.getThreadGoal) {
      await sendLarkCommandMarkdown(input, normalized, "/goal", "当前 runtime 不支持结构化 /goal status。");
      return true;
    }
    const { goal } = await input.bridge.getThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", goal ? renderLarkGoal(goal) : "当前聊天没有活跃 goal。");
    return true;
  }

  if (action.kind === "clear") {
    if (!input.bridge.clearThreadGoal) {
      await sendLarkCommandMarkdown(input, normalized, "/goal", "当前 runtime 不支持结构化 /goal clear。");
      return true;
    }
    const { cleared } = await input.bridge.clearThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", cleared ? "已清除当前 goal。" : "当前聊天没有可清除的 goal。");
    return true;
  }

  if (!input.bridge.setThreadGoal) {
    await sendLarkCommandMarkdown(input, normalized, "/goal", "当前 runtime 不支持结构化 /goal。");
    return true;
  }
  const { goal } = await input.bridge.setThreadGoal({
    ...goalInput,
    objective: action.objective,
    tokenBudget: action.tokenBudget,
  });
  await sendLarkCommandMarkdown(input, normalized, "/goal", goal ? `Goal 已设置。\n\n${renderLarkGoal(goal)}` : "Goal 已设置。");
  return true;
}

async function handleLarkCronCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<void> {
  if (!input.runtime.cronRuntime) {
    await sendLarkCommandMarkdown(input, normalized, "/cron", "Lark cron runtime 尚未启动。请重启 Lark service 后再试。");
    return;
  }

  const api = {
    sendMessage: async (_chatId: number, text: string): Promise<{ message_id: number }> => {
      await input.channel.send(normalized.chatId, { markdown: text }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return { message_id: 0 };
    },
  };

  await handleCronCommand(commandText, {
    api,
    store: input.runtime.cronRuntime.store as CronStore,
    scheduler: input.runtime.cronRuntime.scheduler as CronScheduler,
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    channel: "lark",
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    larkChatId: normalized.chatId,
    larkThreadId: normalized.threadId,
    larkMessageId: normalized.messageId,
    locale: "zh",
  });
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: "/cron",
  });
}

async function readRawLarkConfig(stateDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
