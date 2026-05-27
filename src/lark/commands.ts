import path from "node:path";

import type {
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
} from "../codex/adapter.js";
import {
  loadCodexUserDefaults,
  renderCodexEffortSetting,
  renderCodexModelSetting,
} from "../codex/user-defaults.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { CronStore } from "../state/cron-store.js";
import { FileWorkflowStore, type FileWorkflowStatus } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { UsageStore } from "../state/usage-store.js";
import { handleCronCommand, isCronCommand } from "../telegram/cron-commands.js";
import { handleLocalEngineTelegramCommand } from "../telegram/engine-commands.js";
import {
  applyEngineSelection,
  loadInstanceConfig,
  updateInstanceConfig,
  type EffortLevel,
  type GroupModeConfig,
  type InstanceConfig,
  type InstanceEngine,
} from "../telegram/instance-config.js";
import { renderUsageMessage, type Locale } from "../telegram/message-renderer.js";
import { handleLocalSessionTelegramCommand } from "../telegram/session-commands.js";
import type { NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import {
  handleLarkBoardCommand,
  handleLarkDelegationCommand,
  handleLarkMiniBusCommand,
} from "./bus.js";
import type { LarkCliStatus } from "./cli.js";
import { renderLarkResumeScanCard, renderLarkStatusCard } from "./command-cards.js";
import { isLarkConfigCommand, renderLarkConfigCard } from "./config-card.js";
import { sendLarkMarkdown } from "./delivery.js";
import { LarkGroupModeStore } from "./group-mode-store.js";
import { readRawLarkConfig, renderLarkCronRuntimeMissing, renderLarkUserAccessDenied, resolveLarkLocale } from "./locale.js";
import type { LarkNormalizedBridgeMessage } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike } from "./types.js";
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
  replyInThread?: boolean;
  locale?: Locale;
  request: EngineApprovalRequest;
  abortSignal?: AbortSignal;
}) => Promise<EngineApprovalDecision>;

export type LarkCommandInput = {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  requestApproval: RequestLarkApproval;
  requireMentionInGroup?: boolean;
  abortSignal?: AbortSignal;
};

export async function handleLarkSimpleCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const commandLocale = await resolveLarkLocale(input.stateDir);
  if (isHelpCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/help", renderLarkHelpMessage(commandLocale));
    return true;
  }

  if (isLarkConfigCommand(commandText)) {
    await input.channel.send(normalized.chatId, {
      card: await renderLarkConfigCard({
        stateDir: input.stateDir,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        larkChatId: normalized.chatId,
        bridgeChatId: normalized.bridgeAccessChatId,
        replyInThread: Boolean(normalized.threadId),
        locale: commandLocale,
        requireMentionInGroup: input.requireMentionInGroup,
      }),
    }, larkCommandReplyOptions(normalized));
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/config",
    });
    return true;
  }

  if (await handleLarkSessionCommand(input, normalized, commandText, commandLocale)) {
    return true;
  }

  const newGroupCommand = parseLarkNewGroupCommand(commandText);
  if (newGroupCommand) {
    await handleLarkNewGroupCommand(input, normalized, newGroupCommand, commandLocale);
    return true;
  }

  if (await handleLarkLocalEngineCommand(input, normalized, commandText, commandLocale)) {
    return true;
  }

  const goalCommand = parseLarkGoalCommand(commandText);
  if (goalCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const handled = await handleLarkGoalCommand(input, normalized, cfg, goalCommand, commandText, commandLocale);
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

  if (isGroupCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/group", await renderAndApplyLarkGroupCommand(input, normalized, commandText, commandLocale));
    return true;
  }

  if (isCronCommand(commandText)) {
    await handleLarkCronCommand(input, normalized, commandText, commandLocale);
    return true;
  }

  if (isStatusCommand(commandText)) {
    const markdown = await renderLarkStatusMessage(input.runtime, normalized, input.stateDir, commandLocale, input.requireMentionInGroup);
    await input.channel.send(normalized.chatId, {
      card: renderLarkStatusCard({
        markdown,
        locale: commandLocale,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        larkChatId: normalized.chatId,
        bridgeChatId: normalized.bridgeAccessChatId,
        replyInThread: Boolean(normalized.threadId),
      }),
    }, larkCommandReplyOptions(normalized));
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/status",
    });
    return true;
  }

  if (isUsageCommand(commandText)) {
    const usage = await new UsageStore(input.stateDir).load();
    await sendLarkCommandMarkdown(input, normalized, "/usage", renderUsageMessage(usage, commandLocale));
    return true;
  }

  const modelCommand = parseLarkModelCommand(commandText);
  if (modelCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkModelCommand(input.stateDir, cfg, modelCommand.model, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/model", message);
    return true;
  }

  const effortCommand = parseLarkEffortCommand(commandText);
  if (effortCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkEffortCommand(input.stateDir, cfg, effortCommand.level, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/effort", message);
    return true;
  }

  const fastCommand = parseLarkFastCommand(commandText);
  if (fastCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkFastCommand(input.stateDir, cfg, fastCommand.action, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/fast", message);
    return true;
  }

  const engineCommand = parseLarkEngineCommand(commandText);
  if (engineCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkEngineCommand(input.stateDir, cfg, engineCommand.engine, engineCommand.invalid, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/engine", message);
    return true;
  }

  const yoloCommand = parseLarkYoloCommand(commandText);
  if (yoloCommand) {
    const message = await handleLarkYoloCommand(input.stateDir, yoloCommand.action, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/yolo", message);
    return true;
  }

  return false;
}

export async function handleLarkGroupCommandBeforeAccess(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
  locale: Locale = "zh",
): Promise<boolean> {
  if (!isGroupCommand(commandText) || normalized.bridgeChatType !== "group" || !input.bridge.checkUserAuthorization) {
    return false;
  }

  const auth = await input.bridge.checkUserAuthorization({
    chatId: normalized.bridgeAccessChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    locale,
  });
  if (auth.kind !== "allow") {
    await input.channel.send(normalized.chatId, {
      text: formatLarkAccessReply(auth.text ?? renderLarkUserAccessDenied(locale)),
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "denied",
      detail: "/group",
      metadata: { rejected: "unauthorized-user" },
    });
    return true;
  }

  await sendLarkCommandMarkdown(input, normalized, "/group", await renderAndApplyLarkGroupCommand(input, normalized, commandText, locale));
  return true;
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
  await sendLarkMarkdown(input.channel, normalized.chatId, markdown, larkCommandReplyOptions(normalized));
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: command,
  });
}

function larkCommandReplyOptions(normalized: LarkNormalizedBridgeMessage): { replyTo: string; replyInThread: boolean } {
  return {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  };
}

export function isLarkLocalEngineCommand(text: string): boolean {
  return /^\/(?:compact|context|ultrareview)(?:\s|$)/i.test(text.trim());
}

async function handleLarkLocalEngineCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<boolean> {
  if (!isLarkLocalEngineCommand(commandText)) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  return await handleLocalEngineTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      engine: cfg.engine,
      model: cfg.model,
      resume: cfg.resume,
    },
    normalized: toSessionTelegramMessage(normalized, commandText),
    context: {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
          return { message_id: 0, text };
        },
      },
      channel: "lark",
      instanceName: "lark",
      abortSignal: input.abortSignal,
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
  locale: Locale,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  return await handleLocalSessionTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      engine: cfg.engine,
      resume: cfg.resume,
    },
    normalized: toSessionTelegramMessage(normalized, commandText),
    context: {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
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
    sendResumeScanResult: async ({ kind, visibleSessions }) => {
      await input.channel.send(normalized.chatId, {
        card: renderLarkResumeScanCard({
          kind,
          sessions: visibleSessions,
          locale,
          conversationKey: normalized.conversationKey,
          bridgeChatType: normalized.bridgeChatType,
          replyInThread: Boolean(normalized.threadId),
        }),
      }, larkCommandReplyOptions(normalized));
    },
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
    return normalizeLarkSlashCommandMention(text.trim());
  }
  return normalizeLarkSlashCommandMention(text.slice(contextEnd + "</lark_context>".length).trim());
}

function normalizeLarkSlashCommandMention(text: string): string {
  return text.replace(
    /^(\/[a-z][\w.-]*)(@[a-z0-9_][\w.-]*)?(?=\s|$)/i,
    "$1",
  );
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

type LarkNewGroupCommand =
  | { kind: "create"; mode: "group" | "topic"; name: string }
  | { kind: "invalid"; reason: "missing_name" };

function parseLarkNewGroupCommand(text: string): LarkNewGroupCommand | null {
  const trimmed = text.trim();
  const topicMatch = trimmed.match(/^\/newtopic(?:\s+([\s\S]+))?$/i);
  if (topicMatch) {
    const name = topicMatch[1]?.trim() ?? "";
    return name ? { kind: "create", mode: "topic", name } : { kind: "invalid", reason: "missing_name" };
  }

  const groupMatch = trimmed.match(/^\/newgroup(?:\s+([\s\S]+))?$/i);
  if (!groupMatch) return null;
  const rest = groupMatch[1]?.trim() ?? "";
  if (!rest) {
    return { kind: "invalid", reason: "missing_name" };
  }
  const topicPrefix = rest.match(/^(?:topic|--topic)(?:\s+([\s\S]+))?$/i);
  if (topicPrefix) {
    const name = topicPrefix[1]?.trim() ?? "";
    return name ? { kind: "create", mode: "topic", name } : { kind: "invalid", reason: "missing_name" };
  }
  return {
    kind: "create",
    mode: "group",
    name: rest,
  };
}

async function handleLarkNewGroupCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  command: LarkNewGroupCommand,
  locale: Locale,
): Promise<void> {
  if (command.kind === "invalid") {
    await sendLarkCommandMarkdown(input, normalized, "/newgroup", renderLarkNewGroupUsage(locale));
    return;
  }

  let created: Awaited<ReturnType<LarkServiceRuntime["createChat"]>>;
  try {
    created = await input.runtime.createChat({
      name: command.name,
      mode: command.mode,
      operatorOpenId: normalized.senderId,
    });
  } catch (error) {
    await sendLarkCommandMarkdown(input, normalized, "/newgroup", renderLarkNewGroupFailed(locale, error));
    return;
  }

  let welcomeWarning: string | undefined;
  try {
    await input.channel.send(created.chatId, {
      markdown: renderLarkNewGroupWelcome(command.name, command.mode, locale),
    });
  } catch (error) {
    welcomeWarning = redactLarkErrorDetail(error);
  }

  await sendLarkCommandMarkdown(
    input,
    normalized,
    "/newgroup",
    renderLarkNewGroupCreated({
      locale,
      mode: command.mode,
      name: created.name ?? command.name,
      chatId: created.chatId,
      shareLink: created.shareLink,
      welcomeWarning,
    }),
  );
}

function renderLarkNewGroupUsage(locale: Locale): string {
  return locale === "en"
    ? [
        "**Create a Lark chat**",
        "",
        "Usage:",
        "- `/newgroup <name>`: create a normal group chat",
        "- `/newgroup topic <name>` or `/newtopic <name>`: create a topic-style group",
        "",
        "The bridge will invite the requesting user when using bot identity.",
      ].join("\n")
    : [
        "**创建飞书会话**",
        "",
        "用法：",
        "- `/newgroup <名称>`：创建普通飞书群",
        "- `/newgroup topic <名称>` 或 `/newtopic <名称>`：创建飞书话题群",
        "",
        "默认用 bot 身份创建，并把发起人拉进新群。",
      ].join("\n");
}

function renderLarkNewGroupWelcome(name: string, mode: "group" | "topic", locale: Locale): string {
  if (locale === "en") {
    return [
      `**${name}** is connected to cc-telegram-bridge.`,
      "",
      mode === "topic"
        ? "Use each topic as an isolated session, or send `/status` to inspect this conversation."
        : "Use replies/threads as isolated sessions, or send `/status` to inspect this conversation.",
    ].join("\n");
  }
  return [
    `**${name}** 这个${mode === "topic" ? "话题群" : "群"}已经接入 cc-telegram-bridge。`,
    "",
    mode === "topic"
      ? "每个话题都可以作为独立 session 使用；发送 `/status` 可查看当前会话。"
      : "可以用 thread/reply 形成独立 session；发送 `/status` 可查看当前会话。",
  ].join("\n");
}

function renderLarkNewGroupCreated(input: {
  locale: Locale;
  mode: "group" | "topic";
  name: string;
  chatId: string;
  shareLink?: string;
  welcomeWarning?: string;
}): string {
  const kind = input.mode === "topic"
    ? input.locale === "en" ? "topic chat" : "飞书话题群"
    : input.locale === "en" ? "Lark group" : "飞书群";
  const lines = input.locale === "en"
    ? [
        `Created ${kind}: ${input.name}`,
        `Chat ID: ${input.chatId}`,
      ]
    : [
        `已创建${kind}：${input.name}`,
        `Chat ID：${input.chatId}`,
      ];
  if (input.shareLink) {
    lines.push(input.locale === "en" ? `Link: ${input.shareLink}` : `链接：${input.shareLink}`);
  }
  if (input.welcomeWarning) {
    lines.push("");
    lines.push(input.locale === "en"
      ? `Created, but the welcome message failed to send: ${input.welcomeWarning}`
      : `已创建，但欢迎消息发送失败：${input.welcomeWarning}`);
  }
  return lines.join("\n");
}

function renderLarkNewGroupFailed(locale: Locale, error: unknown): string {
  const detail = redactLarkErrorDetail(error);
  return locale === "en"
    ? `Failed to create Lark chat: ${detail}\n\nCheck that the app has im:chat / im:chat:create and rerun lark provision. If chat creation is configured with user identity, also add im:chat:create_by_user.`
    : `创建飞书群失败：${detail}\n\n请检查应用是否已开通 im:chat / im:chat:create，并重新运行 lark provision。如果配置为用户身份建群，还需要 im:chat:create_by_user。`;
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

function renderLarkHelpMessage(locale: Locale = "zh"): string {
  if (locale === "en") {
    return [
      "**cc-telegram-bridge for Feishu/Lark**",
      "",
      "Common commands:",
      "- `/help`: show this help",
      "- `/status`: inspect the current conversation",
      "- `/usage`: show cumulative usage for this instance",
      "- `/model [name|off]`: inspect or set the model",
      "- `/effort [low|medium|high|xhigh|max|off]`: inspect or set reasoning effort",
      "- `/fast [on|off|status]`: toggle Codex Fast Mode",
      "- `/engine [claude|codex|antigravity]`: inspect or switch the backend engine",
      "- `/yolo [on|off|unsafe]`: inspect or switch approval mode",
      "- `/config`: open the interactive Lark settings panel",
      "- `/context` / `/compact` / `/ultrareview`: Claude context, compaction, and deep code-review commands",
      "- `/goal [status|clear|objective|--budget N objective]`: manage the current conversation goal; goals are unbounded by default",
      "- `/btw <question>`: ask a side question without touching the current session",
      "- `/reset`: reset the current Lark session",
      "- `/detach`: detach the current Codex thread or Antigravity conversation",
      "- `/resume` / `/resume <number>`: scan and select local Claude sessions; Antigravity scans recent conversations",
      "- `/resume thread <thread-id>`: bind a Codex thread",
      "- `/resume conversation <conversation-id>`: bind an Antigravity conversation explicitly",
      "- `/newgroup <name>` / `/newgroup topic <name>`: create a new Lark group or topic chat for a fresh project/session space",
      "- `/cron ...`: manage Lark-side reminders and scheduled tasks",
      "- `/group [status|allow|deny|on|off|all|at]`: manage the current Lark group and mention requirement",
      "- `/board ...`: manage the durable Kanban board",
      "- `/mini ...`: register Lark group threads as lightweight peers for thread-to-thread collaboration",
      "- `/ask <instance> <prompt>`: delegate to a peer bot and return the result inline",
      "- `/fan` / `/chain` / `/verify`: use Agent Bus parallel, sequential, and verification flows",
      "- `/stop`: stop the current running or queued task",
      "- `/continue`: continue the latest waiting archive analysis",
      "- `/approve [session]` / `/deny`: handle approval by text when card buttons are unavailable",
      "",
      "Input and output:",
      "- Send requests, files, images, audio, or video directly; audio/video is transcribed locally first.",
      "- Supports `[send-file:/abs/path]`, `[send-image:/abs/path]`, `send.audio`, `send.video`, `send.batch`, and related delivery tags.",
      "- Supports `lark.post`, `lark.choice`, `lark.card`, and `lark.doc.create` tool tags; choice/card buttons route back into the current conversation.",
      "- Feishu Docs comments that @mention the bot are answered in the comment thread with comment context.",
      "",
      "Runtime behavior:",
      "- Ordinary tasks return final answers directly; dangerous operations, card choices, and archive continuation use interactive cards.",
      "- Background task notifications return to the original Lark private chat, group, or thread.",
      "- Group messages require @bot by default; `/group all` enables ordinary messages, but the app must also have `im:message` and `im:message.group_msg`.",
      "- If group slash commands work but ordinary messages do not arrive, run `node dist/src/index.js lark doctor` to inspect missing permissions.",
    ].join("\n");
  }

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
    "- `/config`：打开飞书交互配置面板",
    "- `/context` / `/compact` / `/ultrareview`：Claude 本地上下文、压缩和深度代码审查命令",
    "- `/goal [status|clear|目标|--budget N 目标]`：管理当前会话 goal；默认无 token 预算",
    "- `/btw <问题>`：旁问，不影响当前会话",
    "- `/reset`：重置当前 Lark 会话",
    "- `/detach`：断开当前绑定的 Codex thread / Antigravity conversation",
    "- `/resume` / `/resume <编号>`：Claude 扫描并选择本地 session；Antigravity 扫描 recent conversation",
    "- `/resume thread <thread-id>`：绑定 Codex thread",
    "- `/resume conversation <conversation-id>`：显式绑定 Antigravity conversation",
    "- `/newgroup <名称>` / `/newgroup topic <名称>`：创建新的飞书群/话题群，作为新的项目或 session 空间",
    "- `/cron ...`：管理飞书侧定时提醒和任务",
    "- `/group [status|allow|deny|on|off|all|at]`：管理当前飞书群授权和是否需要 @bot 才响应",
    "- `/board ...`：管理持久任务板",
    "- `/mini ...`：把飞书群 thread 注册成轻量 peer，做 thread-to-thread 协作",
    "- `/ask <实例> <提示>`：委托给指定 peer bot 并内联返回结果",
    "- `/fan` / `/chain` / `/verify`：调用 Agent Bus 做并行、串联和验证",
    "- `/stop`：停止当前会话正在运行或排队的任务",
    "- `/continue`：继续最近一个等待中的压缩包分析",
    "- `/approve [session]` / `/deny`：卡片按钮不可用时，用文字处理当前审批",
    "",
    "输入和输出：",
    "- 直接发需求、文件、图片、音视频；音视频会先走本地 ASR 转写。",
    "- 支持 `[send-file:/abs/path]`、`[send-image:/abs/path]`、`send.audio`、`send.video`、`send.batch` 等发送标签。",
    "- 支持 `lark.post`、`lark.choice`、`lark.card`、`lark.doc.create` 工具标签；选择/卡片按钮会回到当前会话继续执行。",
    "- 飞书 Docs 评论 @bot 会读取评论上下文并在评论线程内回复。",
    "",
    "运行方式：",
    "- 普通任务直接返回最终结果；危险操作、卡片选择和压缩包继续分析会使用飞书交互卡片。",
    "- 后台任务完成通知会回到原始 Lark 私聊、群聊或 thread。",
    "- 群聊普通消息默认需要 @bot；`/group all` 可切到全量监听，但飞书应用必须额外拥有 `im:message` 和 `im:message.group_msg`。",
    "- 如果群里 slash 命令可用但普通消息收不到，先运行 `node dist/src/index.js lark doctor` 看缺失权限。",
  ].join("\n");
}

function isGroupCommand(text: string): boolean {
  return /^\/group(?:\s|$)/i.test(text.trim());
}

async function renderAndApplyLarkGroupCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<string> {
  const action = commandText.trim().split(/\s+/)[1]?.toLowerCase() ?? "status";
  const store = new LarkGroupModeStore(input.stateDir);
  const isGroup = normalized.bridgeChatType === "group";
  if (isGroup && (action === "allow" || action === "add")) {
    await updateLarkGroupMode(input.stateDir, (groupMode) => {
      allowLarkGroup(groupMode, normalized.bridgeAccessChatId);
    });
  } else if (isGroup && (action === "deny" || action === "remove" || action === "rm")) {
    await updateLarkGroupMode(input.stateDir, (groupMode) => {
      groupMode.allowedChatIds = groupMode.allowedChatIds.filter((chatId) => chatId !== normalized.bridgeAccessChatId);
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => chatId !== normalized.bridgeAccessChatId);
    });
    await store.setListenAll(normalized.chatId, false);
  } else if (action === "on" || action === "enable") {
    await updateLarkGroupMode(input.stateDir, (groupMode) => {
      groupMode.enabled = true;
    });
  } else if (action === "off" || action === "disable") {
    await updateLarkGroupMode(input.stateDir, (groupMode) => {
      groupMode.enabled = false;
      groupMode.listenAllChatIds = [];
    });
    await store.clearListenAll();
  } else if (isGroup && (action === "all" || action === "listen-all")) {
    await updateLarkGroupMode(input.stateDir, (groupMode) => {
      allowLarkGroup(groupMode, normalized.bridgeAccessChatId);
      if (!groupMode.listenAllChatIds.includes(normalized.bridgeAccessChatId)) {
        groupMode.listenAllChatIds.push(normalized.bridgeAccessChatId);
      }
    });
    await store.setListenAll(normalized.chatId, true);
  } else if (
    isGroup &&
    (action === "at" || action === "mention" || action === "mentions" || action === "listen-mentions")
  ) {
    await updateLarkGroupMode(input.stateDir, (groupMode) => {
      allowLarkGroup(groupMode, normalized.bridgeAccessChatId);
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => chatId !== normalized.bridgeAccessChatId);
    });
    await store.setListenAll(normalized.chatId, false);
  }
  const listenAll = normalized.bridgeChatType === "group" ? await store.isListenAll(normalized.chatId) : false;
  const countListenAll = await store.countListenAll();
  const groupMode = (await loadInstanceConfig(input.stateDir)).groupMode;
  const groupAllowed = normalized.bridgeChatType === "group" && groupMode.allowedChatIds.includes(normalized.bridgeAccessChatId);
  const requiresMention = !groupMode.enabled || (input.requireMentionInGroup !== false && !listenAll);
  const status = renderLarkGroupModeStatus({
    locale,
    isGroup: normalized.bridgeChatType === "group",
    groupEnabled: groupMode.enabled,
    groupAllowed,
    bridgeChatId: normalized.bridgeAccessChatId,
    requiresMention,
    allowedCount: groupMode.allowedChatIds.length,
    listenAllCount: countListenAll,
  });
  if (action === "status") {
    return status;
  }
  if (action === "all" || action === "listen-all") {
    if (locale === "en") {
      return normalized.bridgeChatType === "group"
        ? `${status}\n\nCurrent group switched to ordinary group messages.`
        : `${status}\n\nSend /group all inside the Lark group you want to switch.`;
    }
    return normalized.bridgeChatType === "group"
      ? `${status}\n\n当前飞书群已切到：监听所有普通消息。`
      : `${status}\n\n请在要开启全量监听的飞书群里发送 /group all。`;
  }
  if (action === "at" || action === "mention" || action === "mentions" || action === "listen-mentions") {
    if (locale === "en") {
      return normalized.bridgeChatType === "group"
        ? `${status}\n\nCurrent group switched to @bot / mention-only mode.`
        : `${status}\n\nSend /group at inside the Lark group you want to switch.`;
    }
    return normalized.bridgeChatType === "group"
      ? `${status}\n\n当前飞书群已切到：只响应 @bot / mention。`
      : `${status}\n\n请在要恢复 @bot 模式的飞书群里发送 /group at。`;
  }
  if (action === "allow" || action === "add") {
    if (locale === "en") {
      return normalized.bridgeChatType === "group"
        ? `${status}\n\nAllowed current Lark group (${normalized.bridgeAccessChatId}). Only authorized users can still use it.`
        : `${status}\n\nSend /group allow inside the Lark group you want to enable.`;
    }
    return normalized.bridgeChatType === "group"
      ? `${status}\n\n已允许当前飞书群 (${normalized.bridgeAccessChatId})。群内仍只有已授权用户可使用。`
      : `${status}\n\n请在要启用的飞书群里发送 /group allow。`;
  }
  if (action === "deny" || action === "remove" || action === "rm") {
    if (locale === "en") {
      return normalized.bridgeChatType === "group"
        ? `${status}\n\nRemoved current Lark group (${normalized.bridgeAccessChatId}).`
        : `${status}\n\nSend /group deny inside the Lark group you want to remove.`;
    }
    return normalized.bridgeChatType === "group"
      ? `${status}\n\n已移除当前飞书群 (${normalized.bridgeAccessChatId})。`
      : `${status}\n\n请在要移除的飞书群里发送 /group deny。`;
  }
  if (action === "on" || action === "enable") {
    if (locale === "en") {
      return `${status}\n\nLark group mode is now on.`;
    }
    return `${status}\n\nLark 群聊模式已开启。`;
  }
  if (action === "off" || action === "disable") {
    if (locale === "en") {
      return `${status}\n\nLark group mode is now off.`;
    }
    return `${status}\n\nLark 群聊模式已关闭。`;
  }
  if (locale === "en") {
    return [
      status,
      "",
      "Lark supports `/group status|allow|deny|on|off|all|at`.",
    ].join("\n");
  }
  return [
    status,
    "",
    "Lark 支持 `/group status|allow|deny|on|off|all|at`。",
  ].join("\n");
}

function renderLarkGroupModeStatus(input: {
  locale: Locale;
  isGroup: boolean;
  groupEnabled: boolean;
  groupAllowed: boolean;
  bridgeChatId: number;
  requiresMention: boolean;
  allowedCount: number;
  listenAllCount: number;
}): string {
  if (input.locale === "en") {
    return [
      "**Lark group mode**",
      "",
      `- Group mode: ${input.groupEnabled ? "on" : "off"}`,
      ...(input.isGroup ? [`- Current group: ${input.groupAllowed ? "allowed" : "not allowed"} (${input.bridgeChatId})`] : []),
      `- Current trigger: ${input.requiresMention ? "requires @bot / mention" : "accepts ordinary group messages"}`,
      `- Lark groups allowed: ${input.allowedCount}`,
      `- Lark groups listening to ordinary messages: ${input.listenAllCount}`,
      "- Access control: authorized users can use `/group allow|deny` inside a Lark group; CLI alias `lark access` still manages users/private chats.",
      "- Global default: `LARK_REQUIRE_MENTION_IN_GROUP=1` requires @bot unless this chat uses `/group all`.",
      "- Platform requirement: `/group all` also needs the Feishu/Lark app scopes `im:message` and `im:message.group_msg`; run `lark doctor` if ordinary group messages still do not arrive.",
    ].join("\n");
  }

  return [
    "**Lark 群聊模式**",
    "",
    `- 群聊模式：${input.groupEnabled ? "开启" : "关闭"}`,
    ...(input.isGroup ? [`- 当前群：${input.groupAllowed ? "已允许" : "未允许"} (${input.bridgeChatId})`] : []),
    `- 当前触发：${input.requiresMention ? "需要 @bot / mention" : "接受普通群消息"}`,
    `- 已允许的 Lark 群数：${input.allowedCount}`,
    `- 正在监听普通消息的 Lark 群数：${input.listenAllCount}`,
    "- 访问控制：授权用户可在 Lark 群内使用 `/group allow|deny`；CLI 侧仍用 `lark access` 管理用户/私聊。",
    "- 全局默认：`LARK_REQUIRE_MENTION_IN_GROUP=1` 时需要 @bot，除非当前群使用 `/group all`。",
    "- 平台要求：`/group all` 还需要飞书/Lark 应用权限 `im:message` 和 `im:message.group_msg`；普通群消息仍收不到时，请运行 `lark doctor` 检查。",
  ].join("\n");
}

async function updateLarkGroupMode(stateDir: string, updater: (groupMode: GroupModeConfig) => void): Promise<void> {
  await updateInstanceConfig(stateDir, (config) => {
    const groupMode = currentLarkGroupMode(config);
    updater(groupMode);
    config.groupMode = normalizeLarkGroupMode(groupMode);
  });
}

function currentLarkGroupMode(config: Record<string, unknown>): GroupModeConfig {
  const raw = typeof config.groupMode === "object" && config.groupMode !== null
    ? config.groupMode as Record<string, unknown>
    : {};
  return normalizeLarkGroupMode({
    enabled: raw.enabled === false ? false : true,
    allowedChatIds: Array.isArray(raw.allowedChatIds)
      ? raw.allowedChatIds.filter((value): value is number => Number.isInteger(value))
      : [],
    listenAllChatIds: Array.isArray(raw.listenAllChatIds)
      ? raw.listenAllChatIds.filter((value): value is number => Number.isInteger(value))
      : [],
  });
}

function normalizeLarkGroupMode(groupMode: GroupModeConfig): GroupModeConfig {
  return {
    enabled: groupMode.enabled,
    allowedChatIds: [...new Set(groupMode.allowedChatIds)],
    listenAllChatIds: groupMode.enabled ? [...new Set(groupMode.listenAllChatIds)] : [],
  };
}

function allowLarkGroup(groupMode: GroupModeConfig, chatId: number): void {
  groupMode.enabled = true;
  if (!groupMode.allowedChatIds.includes(chatId)) {
    groupMode.allowedChatIds.push(chatId);
  }
}

async function renderLarkStatusMessage(
  runtime: LarkServiceRuntime,
  normalized: LarkNormalizedBridgeMessage,
  stateDir: string,
  locale: Locale,
  requireMentionInGroup?: boolean,
): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  const codexDefaults = cfg.engine === "codex" ? await loadCodexUserDefaults() : undefined;
  const rawConfig = await readRawLarkConfig(stateDir);
  const session = await new SessionStore(path.join(stateDir, "session.json"))
    .findByConversationKeySafe(normalized.conversationKey);
  const currentSession = session.record;
  const workflowLines = await renderLarkWorkflowStatusLines(stateDir, normalized.bridgeChatId, locale);
  const groupModeLines = normalized.bridgeChatType === "group"
    ? await renderLarkGroupModeStatusLines(stateDir, normalized.chatId, cfg.groupMode.enabled, locale, requireMentionInGroup)
    : [];
  const larkCliStatus = await runtime.detectLarkCli().catch((error): LarkCliStatus => ({
    available: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  const activeRun = runtime.activeRuns.has(normalized.conversationKey);
  if (locale === "en") {
    return [
      "**Lark conversation status**",
      "",
      `Engine: ${cfg.engine}`,
      `Model: ${renderCodexModelSetting(cfg.model, codexDefaults, locale)}`,
      `Effort: ${renderCodexEffortSetting(cfg.effort, codexDefaults, locale)}`,
      `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`,
      `Approval mode: ${renderLarkApprovalModeStatus(rawConfig.approvalMode, locale)}`,
      `Budget: ${cfg.budgetUsd !== undefined ? `$${cfg.budgetUsd.toFixed(2)}` : "none"}`,
      `Locale: ${locale}`,
      `Verbosity: ${cfg.verbosity}`,
      `Timezone: ${cfg.timezone}`,
      `Lark CLI: ${renderLarkCliStatus(larkCliStatus, locale)}`,
      `Conversation: ${normalized.conversationKey}`,
      `Chat type: ${normalized.bridgeChatType}`,
      ...groupModeLines,
      session.warning
        ? `Session bound: unknown (${session.warning})`
        : `Session bound: ${currentSession ? "yes" : "no"}`,
      ...(cfg.engine === "codex" && currentSession ? [`Current thread: ${currentSession.codexSessionId}`] : []),
      ...(cfg.engine === "antigravity" && currentSession ? [`Current conversation: ${currentSession.codexSessionId}`] : []),
      ...workflowLines,
      `Active run: ${activeRun ? "yes" : "no"}`,
      `Pending approvals: ${runtime.pendingApprovals.size}`,
    ].join("\n");
  }

  return [
    "**Lark 会话状态**",
    "",
    `引擎：${cfg.engine}`,
    `模型：${renderCodexModelSetting(cfg.model, codexDefaults, locale)}`,
    `推理强度：${renderCodexEffortSetting(cfg.effort, codexDefaults, locale)}`,
    `Codex Fast Mode：${cfg.codexServiceTier === "fast" ? "开启" : "关闭"}`,
    `审批模式：${renderLarkApprovalModeStatus(rawConfig.approvalMode, locale)}`,
    `预算：${cfg.budgetUsd !== undefined ? `$${cfg.budgetUsd.toFixed(2)}` : "无"}`,
    `语言：${locale}`,
    `详细度：${cfg.verbosity}`,
    `时区：${cfg.timezone}`,
    `Lark CLI：${renderLarkCliStatus(larkCliStatus, locale)}`,
    `会话：${normalized.conversationKey}`,
    `聊天类型：${normalized.bridgeChatType}`,
    ...groupModeLines,
    session.warning
      ? `会话绑定：未知（${session.warning}）`
      : `会话绑定：${currentSession ? "是" : "否"}`,
    ...(cfg.engine === "codex" && currentSession ? [`当前 thread：${currentSession.codexSessionId}`] : []),
    ...(cfg.engine === "antigravity" && currentSession ? [`当前 conversation：${currentSession.codexSessionId}`] : []),
    ...workflowLines,
    `当前运行：${activeRun ? "是" : "否"}`,
    `待处理审批：${runtime.pendingApprovals.size}`,
  ].join("\n");
}

function renderLarkCliStatus(status: LarkCliStatus, locale: Locale): string {
  if (status.available) {
    return status.version
      ? locale === "en" ? `available (${status.version})` : `可用（${status.version}）`
      : locale === "en" ? "available" : "可用";
  }
  const detail = status.error ? ` (${truncateLarkStatusDetail(status.error)})` : "";
  return locale === "en" ? `unavailable${detail}` : `不可用${detail}`;
}

function truncateLarkStatusDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function renderLarkApprovalModeStatus(mode: unknown, locale: Locale): string {
  if (mode === "bypass") {
    return "YOLO unsafe/bypass";
  }
  if (mode === "full-auto") {
    return "YOLO/full-auto";
  }
  return locale === "en" ? "normal approvals" : "普通审批";
}

function isBlockingWorkflowStatus(status: FileWorkflowStatus): boolean {
  return status === "preparing" || status === "processing" || status === "failed";
}

async function renderLarkWorkflowStatusLines(stateDir: string, chatId: number, locale: Locale): Promise<string[]> {
  const workflowResult = await new FileWorkflowStore(stateDir).inspect();
  if (workflowResult.warning) {
    return locale === "en"
      ? [`Workflows: unknown (${workflowResult.warning})`]
      : [`工作流：未知（${workflowResult.warning}）`];
  }
  const records = workflowResult.state.records.filter((record) => record.chatId === chatId);
  const blocking = records.filter((record) => isBlockingWorkflowStatus(record.status)).length;
  const waiting = records.filter((record) => record.status === "awaiting_continue").length;
  return locale === "en"
    ? [
        `Blocking workflows: ${blocking}`,
        `Waiting workflows: ${waiting}`,
      ]
    : [
        `阻塞工作流：${blocking}`,
        `等待工作流：${waiting}`,
      ];
}

async function renderLarkGroupModeStatusLines(
  stateDir: string,
  chatId: string,
  groupModeEnabled: boolean,
  locale: Locale,
  requireMentionInGroup?: boolean,
): Promise<string[]> {
  const store = new LarkGroupModeStore(stateDir);
  const listenAll = groupModeEnabled && await store.isListenAll(chatId);
  const requiresMention = !groupModeEnabled || (requireMentionInGroup !== false && !listenAll);
  if (locale === "en") {
    const source = !groupModeEnabled
      ? "group mode disabled"
      : listenAll
      ? "/group all override"
      : requireMentionInGroup === false
        ? "global mention requirement disabled"
        : "default mention mode";
    return [
      `Group trigger: ${requiresMention ? "requires @bot / mention" : "accepts ordinary group messages"}`,
      `Group mode source: ${source}`,
    ];
  }
  const source = !groupModeEnabled
    ? "群聊模式已关闭"
    : listenAll
    ? "/group all override"
    : requireMentionInGroup === false
      ? "全局已关闭 @bot 要求"
      : "默认 @bot 模式";
  return [
    `群聊触发：${requiresMention ? "需要 @bot / mention" : "接受普通群消息"}`,
    `群聊模式来源：${source}`,
  ];
}

function isSingleTokenLarkModelName(model: string): boolean {
  return !/\s/.test(model);
}

function renderLarkModelSelectionMessage(cfg: InstanceConfig, locale: Locale): string {
  const current = cfg.model ?? "default";
  if (cfg.engine === "claude") {
    if (locale === "en") {
      return [
        `Current model: ${current}`,
        "Choose a model with /model <name>:",
        "/model opus",
        "/model sonnet",
        "/model haiku",
        "/model off",
        "1M context example: /model opus[1m]",
      ].join("\n");
    }
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
    if (locale === "en") {
      return [
        `Current model: ${current}`,
        "Choose a model with /model <name>:",
        "/model gpt-5.4",
        "/model gpt-5.3-codex",
        "/model o3",
        "/model off",
      ].join("\n");
    }
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      "/model gpt-5.4",
      "/model gpt-5.3-codex",
      "/model o3",
      "/model off",
    ].join("\n");
  }
  if (locale === "en") {
    return [
      `Current model: ${current}`,
      "Antigravity model switching is not available from Lark yet. Open interactive agy locally and use /model there.",
    ].join("\n");
  }
  return [
    `当前模型: ${current}`,
    "Antigravity 模型暂不能从 Lark 切换；请在本机交互式 agy 里使用 /model。",
  ].join("\n");
}

async function handleLarkModelCommand(
  stateDir: string,
  cfg: InstanceConfig,
  model: string,
  locale: Locale,
): Promise<string> {
  if (cfg.engine === "antigravity") {
    return locale === "en"
      ? "Antigravity model switching is not available from Lark because agy --print does not run the interactive /model parser. Open agy locally and use /model there; the bridge will not forward /model as a chat prompt."
      : "Antigravity 模型切换暂不支持从 Lark 发起，因为 agy --print 不会运行交互式 /model 解析器。请在本机交互式 agy 里使用 /model；bridge 不会把 /model 当普通聊天转发给模型。";
  }
  if (!model) {
    return renderLarkModelSelectionMessage(cfg, locale);
  }
  if (!isSingleTokenLarkModelName(model)) {
    return locale === "en" ? "Usage: /model <single-token-name|off>" : "用法: /model <单个模型名|off>";
  }
  if (model === "off" || model === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.model;
    });
    return locale === "en" ? "Model reset to default." : "模型已恢复默认。";
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.model = model;
  });
  return locale === "en" ? `Model set to ${model}.` : `模型已设为 ${model}。`;
}

async function handleLarkEffortCommand(
  stateDir: string,
  cfg: InstanceConfig,
  level: string,
  locale: Locale,
): Promise<string> {
  if (cfg.engine === "antigravity") {
    return locale === "en"
      ? "Antigravity effort is controlled by the native agy CLI; the bridge does not expose an effort startup flag yet. For model selection, open agy locally and use /model there."
      : "Antigravity 的 effort 由 agy CLI 原生控制；bridge 目前还没有可用的 effort 启动参数。模型选择请在本机交互式 agy 里使用 /model。";
  }
  if (!level) {
    return locale === "en" ? `Current effort: ${cfg.effort ?? "default"}` : `当前 effort: ${cfg.effort ?? "default"}`;
  }
  if (level === "off" || level === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.effort;
    });
    return locale === "en" ? "Effort reset to default." : "Effort 已恢复默认。";
  }
  if (!VALID_LARK_EFFORT_LEVELS.includes(level as EffortLevel)) {
    return locale === "en"
      ? "Usage: /effort [low|medium|high|xhigh|max|off]"
      : "用法: /effort [low|medium|high|xhigh|max|off]";
  }
  const effectiveLevel = cfg.engine !== "claude" && level === "max" ? "xhigh" : level;
  await updateInstanceConfig(stateDir, (config) => {
    config.effort = effectiveLevel;
  });
  return cfg.engine !== "claude" && level === "max"
    ? locale === "en" ? "Codex does not support max effort; using xhigh instead." : "Codex 不支持 max，已改用 xhigh。"
    : locale === "en" ? `Effort set to ${level}.` : `Effort 已设为 ${level}。`;
}

async function handleLarkFastCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  if (cfg.engine !== "codex") {
    return locale === "en" ? "Fast Mode is Codex-only." : "Fast Mode 仅 Codex 支持。";
  }
  if (action === "on" || action === "enable" || action === "fast") {
    await updateInstanceConfig(stateDir, (config) => {
      config.codexServiceTier = "fast";
    });
    return locale === "en"
      ? "Codex Fast Mode enabled. Supported models run faster but consume more credits."
      : "Codex Fast Mode 已开启。支持的模型会更快，但会消耗更多 credits。";
  }
  if (action === "off" || action === "disable" || action === "standard" || action === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.codexServiceTier;
    });
    return locale === "en" ? "Codex Fast Mode disabled." : "Codex Fast Mode 已关闭。";
  }
  if (action === "status") {
    if (locale === "en") {
      return `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`;
    }
    return `Codex Fast Mode：${cfg.codexServiceTier === "fast" ? "开启" : "关闭"}`;
  }
  return locale === "en" ? "Usage: /fast [on|off|status]" : "用法: /fast [on|off|status]";
}

async function handleLarkEngineCommand(
  stateDir: string,
  cfg: InstanceConfig,
  engine: string,
  invalid: boolean,
  locale: Locale,
): Promise<string> {
  if (!engine && !invalid) {
    if (locale === "en") {
      return [
        `Current engine: ${cfg.engine}`,
        "Choose an engine with /engine <name>:",
        ...LARK_ENGINE_CHOICES.map((choice) => `/engine ${choice}`),
        "Restart the Lark service after switching for the change to take effect.",
      ].join("\n");
    }
    return [
      `当前引擎：${cfg.engine}`,
      "用 /engine <名称> 选择引擎：",
      ...LARK_ENGINE_CHOICES.map((choice) => `/engine ${choice}`),
      "切换后请重启 Lark service 以生效。",
    ].join("\n");
  }
  if (invalid || !LARK_ENGINE_CHOICES.includes(engine as InstanceEngine)) {
    return locale === "en" ? "Usage: /engine [claude|codex|antigravity]" : "用法: /engine [claude|codex|antigravity]";
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
    details.push(locale === "en" ? "cleared the previous model override" : "已清除先前的模型覆盖");
  }
  if (resetSessionBindings) {
    details.push(locale === "en" ? "reset this instance's session bindings" : "已重置该实例的会话绑定");
  }
  if (enabledFullAuto) {
    details.push(locale === "en" ? "enabled YOLO/full-auto for Antigravity" : "Antigravity 已自动开启 YOLO/full-auto");
  }
  if (locale === "en") {
    const suffix = details.length > 0 ? ` ${details.join("; ")}.` : "";
    return `Engine set to ${selectedEngine}.${suffix} Restart the Lark service for the change to take effect.`;
  }
  const suffix = details.length > 0 ? ` ${details.join("，")}。` : "";
  return `引擎已设为 ${selectedEngine}。${suffix}重启 Lark service 后生效。`;
}

async function handleLarkYoloCommand(stateDir: string, action: string, locale: Locale): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  if (!action || action === "status") {
    const mode = (await readRawLarkConfig(stateDir)).approvalMode ?? "normal";
    if (locale === "en") {
      const label = mode === "bypass" ? "unsafe/bypass" : mode === "full-auto" ? "full-auto" : "off";
      return `Current YOLO: ${label}`;
    }
    const label = mode === "bypass"
      ? "YOLO UNSAFE（跳过审批和 sandbox）"
      : mode === "full-auto" ? "YOLO（full-auto，sandboxed）" : "off（普通审批流程）";
    return `当前 YOLO: ${label}`;
  }
  if (action === "on") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "full-auto";
    });
    return locale === "en"
      ? `YOLO mode ON (full-auto, sandboxed). Current engine: ${cfg.engine}.`
      : `YOLO mode ON（full-auto，sandboxed）。当前引擎：${cfg.engine}。`;
  }
  if (action === "off") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "normal";
    });
    return locale === "en" ? "YOLO mode OFF. Normal approval flow restored." : "YOLO mode OFF。已恢复普通审批流程。";
  }
  if (action === "unsafe") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "bypass";
    });
    return locale === "en"
      ? "YOLO UNSAFE enabled. Approvals and sandboxing will be bypassed; use only on a trusted machine and workspace."
      : "YOLO UNSAFE 已开启。将跳过审批和 sandbox，请只在可信机器和可信 workspace 使用。";
  }
  return locale === "en" ? "Usage: /yolo [on|off|unsafe|status]" : "用法: /yolo [on|off|unsafe|status]";
}

function renderLarkGoal(goal: CodexThreadGoal, locale: Locale): string {
  if (locale === "en") {
    const budget = goal.tokenBudget === null ? "Budget: unbounded (no token limit set)" : `Budget: ${goal.tokenBudget} tokens`;
    const usage = goal.tokensUsed === 0 && Math.round(goal.timeUsedSeconds) === 0
      ? "Goal usage: not recorded yet"
      : `Goal usage: ${goal.tokensUsed} tokens, ${Math.round(goal.timeUsedSeconds)} seconds`;
    return [
      `Objective: ${goal.objective}`,
      `Status: ${goal.status}`,
      budget,
      usage,
    ].join("\n");
  }

  const budget = goal.tokenBudget === null ? "预算：不限制（未设置 token 上限）" : `预算：${goal.tokenBudget} token`;
  const usage = goal.tokensUsed === 0 && Math.round(goal.timeUsedSeconds) === 0
    ? "Goal 用量：尚未产生统计"
    : `Goal 用量：${goal.tokensUsed} tokens，${Math.round(goal.timeUsedSeconds)} 秒`;
  return [
    `目标：${goal.objective}`,
    `状态：${goal.status}`,
    budget,
    usage,
  ].join("\n");
}

function renderInvalidLarkGoalCommand(reason: "invalid_budget" | "missing_objective", locale: Locale): string {
  if (locale === "en") {
    if (reason === "missing_objective") {
      return "Write the goal, for example: /goal ship release notes. To add a limit, use /goal --budget 50000 ship release notes.";
    }
    return "Invalid /goal token budget. Use --budget 50000 or -b 50k.";
  }
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
  locale: Locale,
): Promise<boolean | null> {
  if (action.kind === "invalid") {
    await sendLarkCommandMarkdown(input, normalized, "/goal", renderInvalidLarkGoalCommand(action.reason, locale));
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
      await sendLarkCommandMarkdown(input, normalized, "/goal", locale === "en"
        ? "The current runtime does not support structured /goal status."
        : "当前 runtime 不支持结构化 /goal status。");
      return true;
    }
    const { goal } = await input.bridge.getThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", goal
      ? renderLarkGoal(goal, locale)
      : locale === "en" ? "This chat has no active goal." : "当前聊天没有活跃 goal。");
    return true;
  }

  if (action.kind === "clear") {
    if (!input.bridge.clearThreadGoal) {
      await sendLarkCommandMarkdown(input, normalized, "/goal", locale === "en"
        ? "The current runtime does not support structured /goal clear."
        : "当前 runtime 不支持结构化 /goal clear。");
      return true;
    }
    const { cleared } = await input.bridge.clearThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", cleared
      ? locale === "en" ? "Current goal cleared." : "已清除当前 goal。"
      : locale === "en" ? "This chat has no goal to clear." : "当前聊天没有可清除的 goal。");
    return true;
  }

  if (!input.bridge.setThreadGoal) {
    await sendLarkCommandMarkdown(input, normalized, "/goal", locale === "en"
      ? "The current runtime does not support structured /goal."
      : "当前 runtime 不支持结构化 /goal。");
    return true;
  }
  const { goal } = await input.bridge.setThreadGoal({
    ...goalInput,
    objective: action.objective,
    tokenBudget: action.tokenBudget,
  });
  await sendLarkCommandMarkdown(input, normalized, "/goal", goal
    ? locale === "en" ? `Goal set.\n\n${renderLarkGoal(goal, locale)}` : `Goal 已设置。\n\n${renderLarkGoal(goal, locale)}`
    : locale === "en" ? "Goal set." : "Goal 已设置。");
  return true;
}

async function handleLarkCronCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<void> {
  if (!input.runtime.cronRuntime) {
    await sendLarkCommandMarkdown(input, normalized, "/cron", renderLarkCronRuntimeMissing(locale));
    return;
  }

  const api = {
    sendMessage: async (_chatId: number, text: string): Promise<{ message_id: number }> => {
      await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
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
    locale,
  });
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: "/cron",
  });
}
