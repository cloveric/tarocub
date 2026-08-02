import path from "node:path";
import { mkdir } from "node:fs/promises";

import type {
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
} from "../codex/adapter.js";
import {
  loadCodexUserDefaults,
} from "../codex/user-defaults.js";
import {
  CODEX_EFFORT_COMPATIBILITY_EN,
  CODEX_EFFORT_COMPATIBILITY_ZH,
  CODEX_MODEL_CHOICES,
  isExtendedCodexEffort,
  knownCodexModelMaxEffort,
  knownCodexModelSupportsEffort,
} from "../codex/model-capabilities.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { renderEngineEffortSetting, renderEngineModelSetting } from "../runtime/engine-settings-display.js";
import type { ScannedSession } from "../runtime/session-scanner.js";
import { CronStore } from "../state/cron-store.js";
import { AccessStore } from "../state/access-store.js";
import { resolveApprovalMode } from "../state/approval-mode.js";
import { FileWorkflowStore, type FileWorkflowStatus } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { UsageStore } from "../state/usage-store.js";
import { handleCronCommand, isCronCommand } from "../telegram/cron-commands.js";
import { handleLocalEngineTelegramCommand } from "../telegram/engine-commands.js";
import {
  applyEngineSelection,
  CLAUDE_MODEL_CHOICES,
  KIMI_EFFORT_LEVELS,
  loadInstanceConfig,
  resolveInstanceWorkspacePath,
  updateInstanceConfig,
  type EffortLevel,
  type GroupModeConfig,
  type InstanceConfig,
  type InstanceEngine,
  type WorkspaceProfile,
  LARK_STEER_DEFAULT_WINDOW_SECONDS,
} from "../telegram/instance-config.js";
import {
  killInstanceGroupOrphans,
  killInstanceGroupProcess,
  listInstanceProcessGroup,
} from "../runtime/background-processes.js";
import { renderUsageMessage, type Locale } from "../telegram/message-renderer.js";
import { handleLocalSessionTelegramCommand } from "../telegram/session-commands.js";
import type { NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import {
  LarkGoalRunController,
  handleLarkBoardCommand,
  handleLarkDelegationCommand,
  handleLarkMiniBusCommand,
} from "./bus.js";
import type { LarkCliStatus } from "./cli.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import { isLarkAccountCommand, renderLarkAccountCard } from "./account-card.js";
import { renderLarkResumeScanCard, renderLarkStatusCard } from "./command-cards.js";
import { isLarkConfigCommand, renderLarkConfigCard } from "./config-card.js";
import { sendLarkMarkdown } from "./delivery.js";
import { LarkGroupModeStore } from "./group-mode-store.js";
import { checkGroupMsgScope, renderGroupMsgScopeWarning } from "./group-scope-check.js";
import { LarkKnownChatStore } from "./known-chats.js";
import { readRawLarkConfig, renderLarkCronRuntimeMissing, renderLarkUserAccessDenied, resolveLarkLocale } from "./locale.js";
import { stableLarkNumericId, type LarkNormalizedBridgeMessage } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import { renderLarkUserFacingError } from "./errors.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike } from "./types.js";
import { appendLarkTimelineEvent } from "./timeline.js";

const VALID_LARK_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LARK_ENGINE_CHOICES: InstanceEngine[] = ["claude", "codex", "kimi", "antigravity"];

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
  instanceName?: string;
  requestApproval: RequestLarkApproval;
  requireMentionInGroup?: boolean;
  abortSignal?: AbortSignal;
  // Live run-card factory, supplied by message-handler. Typed via an erased type-query
  // so commands.ts keeps no runtime import of message-handler.ts (which imports this
  // file — a direct import would be a cycle).
  createRunCard?: typeof import("./message-handler.js")["createLarkRunCardController"];
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

  if (isWorkspaceCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/ws", await renderAndApplyLarkWorkspaceCommand(
      input,
      normalized,
      commandText,
      commandLocale,
    ));
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

  if (isLarkInviteRemoveCommand(commandText)) {
    await handleLarkInviteRemoveCommand(input, normalized, commandText, commandLocale);
    return true;
  }

  if (isCronCommand(commandText)) {
    await handleLarkCronCommand(input, normalized, commandText, commandLocale);
    return true;
  }

  if (isLarkAccountCommand(commandText)) {
    const card = renderLarkAccountCard({
      ...(input.runtime.appInfo?.appId ? { appId: input.runtime.appInfo.appId } : {}),
      ...(input.runtime.appInfo?.domain ? { domain: input.runtime.appInfo.domain } : {}),
      ...(input.instanceName ? { instanceName: input.instanceName } : {}),
      stateDir: input.stateDir,
      locale: commandLocale,
    });
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: normalized.chatId,
      card,
      fallbackText: commandLocale === "en"
        ? "Current Lark app status (run `lark wizard` to switch apps)."
        : "当前飞书应用状态（更换 app 请运行 `lark wizard`）。",
      options: larkCommandReplyOptions(normalized),
      locale: commandLocale,
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/account",
    });
    return true;
  }

  if (isStatusCommand(commandText)) {
    const markdown = await renderLarkStatusMessage(input.runtime, normalized, input.stateDir, commandLocale, input.requireMentionInGroup);
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: normalized.chatId,
      card: renderLarkStatusCard({
        markdown,
        locale: commandLocale,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        larkChatId: normalized.chatId,
        bridgeChatId: normalized.bridgeAccessChatId,
        replyInThread: Boolean(normalized.threadId),
      }),
      fallbackText: markdown,
      options: larkCommandReplyOptions(normalized),
      locale: commandLocale,
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/status",
    });
    return true;
  }

  if (isUsageCommand(commandText)) {
    const usage = await new UsageStore(input.stateDir).load();
    let usageMessage = renderUsageMessage(usage, commandLocale);
    // Codex/Antigravity never report dollar cost, so a configured budgetUsd can
    // never trip. When one is set, say so honestly instead of silently implying
    // the cap protects this instance (Telegram /usage carries the same note).
    const usageCfg = await loadInstanceConfig(input.stateDir);
    if (usageCfg.budgetUsd !== undefined && usageCfg.engine !== "claude") {
      usageMessage = [usageMessage, renderLarkBudgetEngineNote(commandLocale)].join("\n");
    }
    await sendLarkCommandMarkdown(input, normalized, "/usage", usageMessage);
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

  const streamCommand = parseLarkStreamCommand(commandText);
  if (streamCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkStreamCommand(input.stateDir, cfg, streamCommand.action, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/stream", message);
    return true;
  }

  const timeoutCommand = parseLarkTimeoutCommand(commandText);
  if (timeoutCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkTimeoutCommand(input.stateDir, cfg, timeoutCommand.action, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/timeout", message);
    return true;
  }

  const steerCommand = parseLarkSteerCommand(commandText);
  if (steerCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkSteerCommand(input.stateDir, cfg, steerCommand.action, commandLocale);
    await sendLarkCommandMarkdown(input, normalized, "/steer", message);
    return true;
  }

  // /bg is dispatched pre-queue in the message handler (instance-scoped process
  // control must not be serialized behind the running turn), so it never reaches
  // here. The predicate/handler are exported for that path.

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
  const isAccessCommand = isGroupCommand(commandText) || isLarkInviteRemoveCommand(commandText);
  if (!isAccessCommand || normalized.bridgeChatType !== "group") {
    return false;
  }

  if (input.bridge.checkUserAuthorization) {
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
        detail: isGroupCommand(commandText) ? "/group" : extractLarkInviteRemoveCommandName(commandText),
        metadata: { rejected: "unauthorized-user" },
      });
      return true;
    }
  }

  if (isGroupCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/group", await renderAndApplyLarkGroupCommand(input, normalized, commandText, locale));
  } else {
    await handleLarkInviteRemoveCommand(input, normalized, commandText, locale);
  }
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
  // `/ultrareview` is the Claude deep-review path. NOTE: `/code-review` is NOT
  // implemented on either channel (no handler exists), so it must not be matched
  // here — matching it swallowed the message into a handler that returns false,
  // and it then reached the engine as plain prompt text anyway. Removed from the
  // predicate and from /help; use `/ultrareview` for the deep review path.
  // Claude-local engine command path.
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
      instanceName: input.instanceName ?? "lark",
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
      instanceName: input.instanceName ?? "lark",
    },
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
    validateCodexThread: input.bridge.validateCodexThread?.bind(input.bridge),
    scanRecentSessions: input.runtime.sessionRuntime?.scanRecentSessions,
    scanRecentAntigravitySessions: input.runtime.sessionRuntime?.scanRecentAntigravitySessions,
    sendResumeScanResult: async ({ kind, visibleSessions }) => {
      await sendLarkCardWithFallback({
        channel: input.channel,
        chatId: normalized.chatId,
        card: renderLarkResumeScanCard({
          kind,
          sessions: visibleSessions,
          locale,
          conversationKey: normalized.conversationKey,
          bridgeChatType: normalized.bridgeChatType,
          replyInThread: Boolean(normalized.threadId),
        }),
        fallbackText: renderLarkResumeFallback(kind, visibleSessions, locale),
        options: larkCommandReplyOptions(normalized),
        locale,
      });
    },
  });
}

function renderLarkResumeFallback(
  kind: "claude" | "antigravity",
  sessions: ScannedSession[],
  locale: Locale,
): string {
  if (sessions.length === 0) {
    return locale === "en" ? `No recent ${kind} sessions found.` : `未找到最近的 ${kind} session。`;
  }
  const title = locale === "en" ? `Recent ${kind} sessions` : `最近的 ${kind} session`;
  return [
    title,
    ...sessions.slice(0, 10).map((session, index) => `${index + 1}. ${session.displayName} (${session.sessionId}) @ ${session.modifiedAt.toISOString()}`),
  ].join("\n");
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
  return match ? { level: match[1]?.toLowerCase() ?? "" } : null;
}

function parseLarkFastCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/fast(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseLarkStreamCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/stream(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseLarkTimeoutCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/timeout(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseLarkSteerCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/steer(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

type LarkBgCommand = { action: "list" } | { action: "kill"; pid: number } | { action: "killall" } | { action: "usage" };

export function isLarkBgCommand(text: string): boolean {
  return /^\/bg(?:\s|$)/i.test(text.trim());
}

/**
 * Pre-queue /bg entrypoint: instance-scoped background-process control that must
 * run independently of the conversation session (like /stop), so it is dispatched
 * ahead of chatQueue rather than inside the queued-turn path. Returns the reply
 * text, or null when the text is not a /bg command.
 */
export async function handleLarkBgCommandText(text: string, locale: Locale): Promise<string | null> {
  const command = parseLarkBgCommand(text);
  return command ? await handleLarkBgCommand(command, locale) : null;
}

function parseLarkBgCommand(text: string): LarkBgCommand | null {
  const match = text.trim().match(/^\/bg(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }
  const args = (match[1] ?? "").trim().toLowerCase();
  if (!args || args === "list") {
    return { action: "list" };
  }
  if (args === "killall") {
    return { action: "killall" };
  }
  const killMatch = args.match(/^kill\s+(\d+)$/);
  if (killMatch) {
    return { action: "kill", pid: Number(killMatch[1]) };
  }
  return { action: "usage" };
}

const LARK_BG_ROLE_LABELS: Record<"zh" | "en", Record<"engine" | "child" | "orphan", string>> = {
  zh: { engine: "引擎", child: "子进程", orphan: "孤儿" },
  en: { engine: "engine", child: "child", orphan: "orphan" },
};

async function handleLarkBgCommand(command: LarkBgCommand, locale: Locale): Promise<string> {
  const zh = locale === "zh";
  if (command.action === "usage") {
    return zh
      ? "用法：`/bg`（列出本实例的引擎/后台进程）· `/bg kill <pid>` 停掉指定进程树 · `/bg killall` 清掉所有孤儿后台进程"
      : "Usage: `/bg` (list this instance's engine/background processes) · `/bg kill <pid>` kill that process tree · `/bg killall` remove all orphaned background processes";
  }
  if (command.action === "kill") {
    const result = await killInstanceGroupProcess(command.pid);
    if (result.killed) {
      return zh ? `已停止进程树 pid=${command.pid} ✓` : `Killed process tree pid=${command.pid} ✓`;
    }
    if (result.reason === "not-in-group") {
      return zh
        ? `pid=${command.pid} 不在本实例的进程组里（可能已退出）。先用 /bg 看列表。`
        : `pid=${command.pid} is not in this instance's process group (it may have exited). Run /bg first.`;
    }
    if (result.reason === "is-service") {
      return zh ? "那是服务进程本体，不能从这里杀。" : "That is the service process itself; refusing.";
    }
    return zh ? "当前平台暂不支持 /bg。" : "/bg is not supported on this platform yet.";
  }
  if (command.action === "killall") {
    const result = await killInstanceGroupOrphans();
    if (result.unsupported) {
      return zh ? "当前平台暂不支持 /bg。" : "/bg is not supported on this platform yet.";
    }
    if (result.killedPids.length === 0) {
      return zh ? "没有孤儿后台进程，干净的 ✨" : "No orphaned background processes. Clean ✨";
    }
    return zh
      ? `已清理 ${result.killedPids.length} 个孤儿进程树：${result.killedPids.join(", ")}`
      : `Removed ${result.killedPids.length} orphaned process tree(s): ${result.killedPids.join(", ")}`;
  }

  const group = await listInstanceProcessGroup();
  if (group === null) {
    return zh ? "当前平台暂不支持 /bg。" : "/bg is not supported on this platform yet.";
  }
  if (group.length === 0) {
    return zh ? "本实例没有任何引擎/后台进程在跑。" : "No engine/background processes are running for this instance.";
  }
  const labels = LARK_BG_ROLE_LABELS[zh ? "zh" : "en"];
  const lines = group.slice(0, 15).map((proc) => {
    const cmd = proc.command.length > 70 ? `${proc.command.slice(0, 67)}...` : proc.command;
    return `- \`${proc.pid}\` · ${labels[proc.role]} · ${proc.rssMb}MB · ${proc.etime} · ${cmd}`;
  });
  const truncated = group.length > 15
    ? [zh ? `…共 ${group.length} 个，仅显示前 15` : `…${group.length} total, showing 15`]
    : [];
  const footer = zh
    ? "停止：`/bg kill <pid>` · 清理孤儿：`/bg killall`（孤儿 = 任务结束后仍残留的后台进程）"
    : "Kill one: `/bg kill <pid>` · sweep orphans: `/bg killall` (orphans = background work left behind after its turn ended)";
  const header = zh ? "**本实例进程组**（服务本体除外，按内存排序）" : "**Instance process group** (service itself excluded, sorted by memory)";
  return [header, ...lines, ...truncated, "", footer].join("\n");
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
      channel: input.channel,
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
      `**${name}** is connected to TaroCub.`,
      "",
      mode === "topic"
        ? "Use each topic as an isolated session, or send `/status` to inspect this conversation."
        : "Use replies/threads as isolated sessions, or send `/status` to inspect this conversation.",
    ].join("\n");
  }
  return [
    `**${name}** 这个${mode === "topic" ? "话题群" : "群"}已经接入 TaroCub。`,
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
      "**TaroCub for Feishu/Lark**",
      "",
      "Just message me to start — DMs work directly; in a group, @-mention me. You can also send files, images, or audio/video (audio/video is transcribed locally first). Most settings live in the interactive `/config` panel.",
      "",
      "**Session**",
      "- `/status` current conversation · `/stop` stop the current task (cancel a queued task from its queue card) · `/reset` reset the session",
      "- `/resume [n]` pick a local session (`/resume thread …` / `/resume conversation …` bind explicitly) · `/detach` unbind the current thread/conversation",
      "- `/goal […]` set a conversation goal · `/btw <q>` ask aside without touching the session · `/continue` resume a waiting archive analysis",
      "- `/q <message>` force a queued turn — while a Codex turn is running, plain text steers INTO it; `/q` runs it afterwards instead",
      "- `/bg` list this instance's engine/background processes · `/bg kill <pid>` · `/bg killall` sweep orphans",
      "",
      "**Settings**",
      "- `/config` interactive panel (recommended) · `/usage` usage · `/account` bound Feishu app",
      "- `/model` · `/effort` · `/engine [claude|codex|kimi|antigravity]` · `/fast` Codex Fast Mode · `/yolo` approval mode",
      "- `/stream [on|off]` typewriter streaming on run cards (off = full-card refresh)",
      "- `/timeout [on|off]` single-turn 60-min time cap (off = lift it for long tasks)",
      "- `/steer [on|off|<seconds>|unlimited]` mid-turn steering window (default 30s; later messages queue)",
      "",
      "**Workspace & groups**",
      "- `/ws list|save|use|remove` workspace directories",
      "- `/newgroup <name>` / `/newtopic <name>` create a group / topic group (you become its owner)",
      "- `/group [status|allow|deny|all|at]` group access & reply mode (`all` = reply without `@`, `at` = `@`-only)",
      "- `/invite group|user @person` · `/remove …` group/user access · `/cron …` reminders & scheduled tasks",
      "",
      "**Advanced & collaboration**",
      "- `/board …` durable kanban · `/mini …` link group threads as peers · `/ask <instance> <prompt>` delegate to another bot",
      "- `/fan` · `/chain` · `/verify` Agent Bus parallel / sequential / verification flows",
      "- `/context` · `/compact` · `/ultrareview` Claude context / compaction / deep review",
      "- `/approve [session]` · `/deny` handle approvals by text when card buttons are unavailable",
      "",
      "Full list: see the Slash Command Index in the README. Group messages need an `@` by default; `/group all` enables non-`@` replies (the app also needs `im:message` + `im:message.group_msg`). If non-`@` group messages still don't arrive, run `node dist/src/index.js lark doctor`.",
    ].join("\n");
  }

  return [
    "**TaroCub · 飞书/Lark**",
    "",
    "直接发消息就能用 —— 私聊直接发，群里 @我 触发。也能发文件、图片、音视频（音视频会先本地转写）。大部分设置走 `/config` 交互面板。",
    "",
    "**会话**",
    "- `/status` 当前会话 · `/stop` 停当前任务（排队任务在各自排队卡片上取消）· `/reset` 重置会话",
    "- `/resume [编号]` 选本地会话（`/resume thread …` / `/resume conversation …` 显式绑定）· `/detach` 解绑当前 thread/会话",
    "- `/goal […]` 设会话目标 · `/btw <问题>` 旁问不影响会话 · `/continue` 继续等待中的压缩包分析",
    "- `/q <消息>` 强制排队 — Codex 任务运行中纯文本会注入当前任务，`/q` 则排在后面单独执行",
    "- `/bg` 列出本实例引擎/后台进程 · `/bg kill <pid>` 停指定进程树 · `/bg killall` 清理孤儿后台进程",
    "",
    "**设置**",
    "- `/config` 交互配置面板（推荐）· `/usage` 用量 · `/account` 当前绑定的飞书应用",
    "- `/model` · `/effort` · `/engine [claude|codex|kimi|antigravity]` · `/fast` Codex 快速模式 · `/yolo` 审批模式",
    "- `/stream [on|off]` 回答卡片打字机流式开关（off = 整卡刷新）",
    "- `/timeout [on|off]` 单轮 60 分钟时间上限（off = 长任务放开上限）",
    "- `/steer [on|off|<秒数>|unlimited]` 任务中途引导的资格窗口（默认 30 秒，超窗排队）",
    "",
    "**工作区与群**",
    "- `/ws list|save|use|remove` 工作区目录",
    "- `/newgroup <名>` / `/newtopic <名>` 新建群 / 话题群（你是群主）",
    "- `/group [status|allow|deny|all|at]` 群授权与回复模式（`all`=不@也回，`at`=只@才回）",
    "- `/invite group|user @某人` · `/remove …` 群/用户授权 · `/cron …` 定时提醒与任务",
    "",
    "**进阶与协作**",
    "- `/board …` 持久任务板 · `/mini …` 把群 thread 注册成 peer 互联 · `/ask <实例> <提示>` 委托给别的 bot",
    "- `/fan` · `/chain` · `/verify` Agent Bus 并行 / 串联 / 验证",
    "- `/context` · `/compact` · `/ultrareview` Claude 上下文 / 压缩 / 深度审查",
    "- `/approve [session]` · `/deny` 卡片按钮不可用时用文字处理审批",
    "",
    "完整命令表见 README 的 Slash Command Index。群里普通消息默认要@；`/group all` 开非@（应用还需有 `im:message` + `im:message.group_msg`）。若开了非@群消息仍收不到，运行 `node dist/src/index.js lark doctor`。",
  ].join("\n");
}

function isGroupCommand(text: string): boolean {
  return /^\/group(?:\s|$)/i.test(text.trim());
}

function isWorkspaceCommand(text: string): boolean {
  return /^\/ws(?:\s|$)/i.test(text.trim());
}

function isLarkInviteRemoveCommand(text: string): boolean {
  return /^\/(?:invite|remove)(?:\s|$)/i.test(text.trim());
}

function extractLarkInviteRemoveCommandName(text: string): "/invite" | "/remove" {
  return /^\/remove(?:\s|$)/i.test(text.trim()) ? "/remove" : "/invite";
}

async function renderAndApplyLarkWorkspaceCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<string> {
  const words = commandText.trim().split(/\s+/);
  const action = (words[1] ?? "list").toLowerCase();
  const name = words[2];
  const cfg = await loadInstanceConfig(input.stateDir);
  const currentWorkspace = resolveInstanceWorkspacePath(cfg) ?? path.join(input.stateDir, "workspace");

  if (action === "list" || action === "status") {
    return renderLarkWorkspaceList(cfg.workspaceProfiles, currentWorkspace, locale);
  }

  if (action === "save") {
    const validation = validateWorkspaceProfileName(name, locale);
    if (validation) {
      return validation;
    }
    const rawProfilePath = words[3] ? words.slice(3).join(" ") : "";
    if (rawProfilePath && !path.isAbsolute(rawProfilePath)) {
      return locale === "en" ? "Workspace path must be absolute." : "工作区路径必须是绝对路径。";
    }
    const profilePath = rawProfilePath || currentWorkspace;
    await mkdir(profilePath, { recursive: true });
    await updateInstanceConfig(input.stateDir, (config) => {
      const profiles = normalizeWorkspaceProfiles(config.workspaceProfiles);
      upsertWorkspaceProfile(profiles, { name, path: profilePath, updatedAt: new Date().toISOString() });
      config.workspaceProfiles = profiles;
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/ws save",
      metadata: { workspaceName: name },
    });
    return locale === "en"
      ? `Saved workspace \`${name}\`:\n${profilePath}`
      : `已保存工作区 \`${name}\`：\n${profilePath}`;
  }

  if (action === "use") {
    const validation = validateWorkspaceProfileName(name, locale);
    if (validation) {
      return validation;
    }
    const profile = cfg.workspaceProfiles.find((item) => item.name === name);
    if (!profile) {
      return locale === "en" ? `Workspace \`${name}\` is not saved. Use \`/ws list\`.` : `工作区 \`${name}\` 尚未保存。可先用 \`/ws list\` 查看。`;
    }
    await mkdir(profile.path, { recursive: true });
    const removedSession = await new SessionStore(path.join(input.stateDir, "session.json"))
      .removeByConversationKeyRecovering(normalized.conversationKey)
      .then((result) => result.removed || result.repaired)
      .catch(() => false);
    await updateInstanceConfig(input.stateDir, (config) => {
      config.workspacePath = profile.path;
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/ws use",
      metadata: { workspaceName: name, removedSession },
    });
    const resetNote = removedSession
      ? (locale === "en" ? "The current session binding was reset to avoid stale project context." : "已重置当前会话绑定，避免新工作区沿用旧上下文。")
      : (locale === "en" ? "The next turn will use this workspace." : "下一轮会使用这个工作区。");
    return locale === "en"
      ? `Using workspace \`${name}\`:\n${profile.path}\n\n${resetNote}`
      : `已切换到工作区 \`${name}\`：\n${profile.path}\n\n${resetNote}`;
  }

  if (action === "remove" || action === "rm") {
    const validation = validateWorkspaceProfileName(name, locale);
    if (validation) {
      return validation;
    }
    let removed: WorkspaceProfile | undefined;
    await updateInstanceConfig(input.stateDir, (config) => {
      const profiles = normalizeWorkspaceProfiles(config.workspaceProfiles);
      removed = profiles.find((item) => item.name === name);
      config.workspaceProfiles = profiles.filter((item) => item.name !== name);
      if (removed && config.workspacePath === removed.path) {
        delete config.workspacePath;
      }
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: removed ? "success" : "noop",
      detail: "/ws remove",
      metadata: { workspaceName: name },
    });
    if (!removed) {
      return locale === "en" ? `Workspace \`${name}\` was not saved.` : `工作区 \`${name}\` 不存在。`;
    }
    return locale === "en" ? `Removed workspace \`${name}\`.` : `已移除工作区 \`${name}\`。`;
  }

  return locale === "en"
    ? "Usage: `/ws list`, `/ws save <name> [absolute-path]`, `/ws use <name>`, or `/ws remove <name>`."
    : "用法：`/ws list`、`/ws save <名称> [绝对路径]`、`/ws use <名称>`、`/ws remove <名称>`。";
}

function validateWorkspaceProfileName(name: string | undefined, locale: Locale): string | undefined {
  if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    return locale === "en"
      ? "Workspace names must use 1-64 letters, numbers, dots, underscores, or dashes, for example `/ws save demo /abs/path`."
      : "工作区名称只能使用 1-64 位字母、数字、点、下划线或短横线，例如 `/ws save demo /abs/path`。";
  }
  return undefined;
}

function normalizeWorkspaceProfiles(raw: unknown): WorkspaceProfile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is WorkspaceProfile => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const record = item as Record<string, unknown>;
      return typeof record.name === "string" && typeof record.path === "string";
    })
    .map((item) => ({
      name: item.name,
      path: item.path,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
    }));
}

function upsertWorkspaceProfile(profiles: WorkspaceProfile[], next: WorkspaceProfile): void {
  const index = profiles.findIndex((item) => item.name === next.name);
  if (index === -1) {
    profiles.push(next);
  } else {
    profiles[index] = next;
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
}

function renderLarkWorkspaceList(profiles: WorkspaceProfile[], currentWorkspace: string, locale: Locale): string {
  const lines = profiles.length > 0
    ? profiles.map((profile) => {
      const marker = profile.path === currentWorkspace ? " *" : "";
      return `- ${profile.name}${marker}: ${profile.path}`;
    })
    : [locale === "en" ? "- No saved workspaces." : "- 暂无已保存工作区。"];
  if (locale === "en") {
    return [
      `Current workspace: ${currentWorkspace}`,
      "",
      "Saved workspaces:",
      ...lines,
      "",
      "Commands: `/ws save <name> [absolute-path]`, `/ws use <name>`, `/ws remove <name>`.",
    ].join("\n");
  }
  return [
    `当前工作区：${currentWorkspace}`,
    "",
    "已保存工作区：",
    ...lines,
    "",
    "命令：`/ws save <名称> [绝对路径]`、`/ws use <名称>`、`/ws remove <名称>`。",
  ].join("\n");
}

async function handleLarkInviteRemoveCommand(
  input: LarkCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<void> {
  const words = commandText.trim().split(/\s+/);
  const command = words[0]?.toLowerCase() === "/remove" ? "remove" : "invite";
  const targetKind = words[1]?.toLowerCase() ?? "group";
  const detail = command === "remove" ? "/remove" : "/invite";

  if (targetKind === "group") {
    const groupCommand = command === "remove" ? "/group deny" : "/group allow";
    await sendLarkMarkdown(
      input.channel,
      normalized.chatId,
      await renderAndApplyLarkGroupCommand(input, normalized, groupCommand, locale),
      larkAccessCommandReplyOptions(normalized),
    );
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail,
      metadata: { target: "group" },
    });
    return;
  }

  if (targetKind !== "user") {
    await sendLarkMarkdown(
      input.channel,
      normalized.chatId,
      renderLarkInviteRemoveUsage(command, locale),
      larkAccessCommandReplyOptions(normalized),
    );
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "error",
      detail,
      metadata: { reason: "unsupported-target", target: targetKind },
    });
    return;
  }

  const target = extractFirstLarkMentionTarget(normalized.mentions);
  if (!target) {
    await sendLarkMarkdown(
      input.channel,
      normalized.chatId,
      renderLarkInviteRemoveMissingMention(command, locale),
      larkAccessCommandReplyOptions(normalized),
    );
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "error",
      detail,
      metadata: { reason: "missing-user-mention" },
    });
    return;
  }

  const accessStore = new AccessStore(path.join(input.stateDir, "access.json"));
  if (command === "remove") {
    await accessStore.revokeUser(target.bridgeUserId);
  } else {
    await accessStore.allowUser(target.bridgeUserId);
  }

  await sendLarkMarkdown(
    input.channel,
    normalized.chatId,
    renderLarkInviteRemoveUserResult(command, target.label, target.bridgeUserId, locale),
    larkAccessCommandReplyOptions(normalized),
  );
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail,
    metadata: {
      target: "user",
      userId: target.bridgeUserId,
    },
  });
}

function larkAccessCommandReplyOptions(normalized: LarkNormalizedBridgeMessage): { replyTo: string; replyInThread?: true } {
  return normalized.threadId
    ? { replyTo: normalized.messageId, replyInThread: true }
    : { replyTo: normalized.messageId };
}

function renderLarkInviteRemoveUsage(command: "invite" | "remove", locale: Locale): string {
  if (locale === "en") {
    return command === "invite"
      ? "Usage: `/invite group` or `/invite user @person`."
      : "Usage: `/remove group` or `/remove user @person`.";
  }
  return command === "invite"
    ? "用法：`/invite group` 或 `/invite user @某人`。"
    : "用法：`/remove group` 或 `/remove user @某人`。";
}

function renderLarkInviteRemoveMissingMention(command: "invite" | "remove", locale: Locale): string {
  if (locale === "en") {
    return command === "invite"
      ? "Mention the user to invite: `/invite user @person`."
      : "Mention the user to remove: `/remove user @person`.";
  }
  return command === "invite"
    ? "请 @ 要邀请的用户：`/invite user @某人`。"
    : "请 @ 要移除的用户：`/remove user @某人`。";
}

function renderLarkInviteRemoveUserResult(
  command: "invite" | "remove",
  label: string,
  userId: number,
  locale: Locale,
): string {
  if (locale === "en") {
    return command === "invite"
      ? `Invited user ${label} (${userId}).`
      : `Removed user ${label} (${userId}).`;
  }
  return command === "invite"
    ? `已邀请用户 ${label} (${userId})。`
    : `已移除用户 ${label} (${userId})。`;
}

function extractFirstLarkMentionTarget(mentions: unknown[]): { label: string; bridgeUserId: number } | null {
  for (const mention of mentions) {
    const record = isRecord(mention) ? mention : {};
    // The SDK includes the bot itself in mentions for commands such as
    // `@Bot /remove user @Alice`. Never treat that routing mention as the user
    // target, otherwise the command reports success while Alice remains allowed.
    if (record.isBot === true || record.is_bot === true) {
      continue;
    }
    const idRecord = isRecord(record.id) ? record.id : {};
    const rawId = firstString(
      idRecord.openId,
      idRecord.open_id,
      idRecord.userId,
      idRecord.user_id,
      idRecord.id,
      record.openId,
      record.open_id,
      record.userId,
      record.user_id,
      record.key,
    );
    if (!rawId) {
      continue;
    }
    const label = firstString(
      record.name,
      record.nameCn,
      record.name_cn,
      record.nameEn,
      record.name_en,
      record.text,
    ) ?? rawId;
    return {
      label,
      bridgeUserId: stableLarkNumericId(`user:${rawId}`),
    };
  }
  return null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
      groupMode.allowedChatIds = groupMode.allowedChatIds.filter((chatId) => !isCurrentLarkGroupNumericId(chatId, normalized));
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => !isCurrentLarkGroupNumericId(chatId, normalized));
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
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => !isCurrentLarkGroupNumericId(chatId, normalized));
    });
    await store.setListenAll(normalized.chatId, false);
  }
  const storedListenAll = normalized.bridgeChatType === "group" ? await store.isListenAll(normalized.chatId) : false;
  const countListenAll = await store.countListenAll();
  const groupMode = (await loadInstanceConfig(input.stateDir)).groupMode;
  const groupAllowed = normalized.bridgeChatType === "group" &&
    isConfiguredLarkGroupAllowed(groupMode, normalized.bridgeChatId, normalized.bridgeAccessChatId);
  const listenAll = normalized.bridgeChatType === "group" && groupMode.enabled && (
    storedListenAll || isConfiguredLarkListenAll(groupMode, normalized.bridgeChatId, normalized.bridgeAccessChatId)
  );
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
    if (normalized.bridgeChatType !== "group") {
      return locale === "en"
        ? `${status}\n\nSend /group all inside the Lark group you want to switch.`
        : `${status}\n\n请在要开启全量监听的飞书群里发送 /group all。`;
    }
    const base = locale === "en"
      ? `${status}\n\nCurrent group switched to ordinary group messages.`
      : `${status}\n\n当前飞书群已切到：监听所有普通消息。`;
    // Proactively warn if the app lacks im:message.group_msg — without it,
    // non-@ group messages never arrive, so listen-all has no effect. Best-effort:
    // "unknown" (no creds / API failure) stays silent.
    const scopeStatus = await checkGroupMsgScope({
      appId: input.runtime.appInfo?.appId ?? process.env.LARK_APP_ID,
      appSecret: input.runtime.appInfo?.appSecret ?? process.env.LARK_APP_SECRET,
      domain: input.runtime.appInfo?.domain,
    });
    if (scopeStatus === "missing") {
      const warning = renderGroupMsgScopeWarning(
        locale === "en" ? "en" : "zh",
        input.runtime.appInfo?.appId,
        input.runtime.appInfo?.domain,
        input.instanceName,
      );
      return `${base}\n\n${warning}`;
    }
    return base;
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
  const knownChat = await new LarkKnownChatStore(stateDir).get(normalized.conversationKey).catch(() => null);
  const session = await new SessionStore(path.join(stateDir, "session.json"))
    .findByConversationKeySafe(normalized.conversationKey);
  const currentSession = session.record;
  const workflowLines = await renderLarkWorkflowStatusLines(stateDir, normalized.bridgeChatId, locale);
  const groupModeLines = normalized.bridgeChatType === "group"
    ? await renderLarkGroupModeStatusLines({
      stateDir,
      chatId: normalized.chatId,
      bridgeChatId: normalized.bridgeChatId,
      bridgeAccessChatId: normalized.bridgeAccessChatId,
      groupMode: cfg.groupMode,
      locale,
      requireMentionInGroup,
    })
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
      `Model: ${renderEngineModelSetting(cfg.engine, cfg.model, codexDefaults, locale)}`,
      `Effort: ${renderEngineEffortSetting(cfg.engine, cfg.effort, codexDefaults, locale)}`,
      `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`,
      `Approval mode: ${renderLarkApprovalModeStatus(rawConfig.approvalMode, locale)}`,
      `Budget: ${cfg.budgetUsd !== undefined ? `$${cfg.budgetUsd.toFixed(2)}` : "none"}`,
      // Honest caveat: only Claude reports dollar cost, so on other engines the
      // configured cap is currently decorative — say so wherever it's shown.
      ...(cfg.budgetUsd !== undefined && cfg.engine !== "claude" ? [renderLarkBudgetEngineNote(locale)] : []),
      `Locale: ${locale}`,
      `Verbosity: ${cfg.verbosity}`,
      `Timezone: ${cfg.timezone}`,
      `Lark CLI: ${renderLarkCliStatus(larkCliStatus, locale)}`,
      `Current chat: ${knownChat?.label ?? normalized.chatId}`,
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
    `模型：${renderEngineModelSetting(cfg.engine, cfg.model, codexDefaults, locale)}`,
    `推理强度：${renderEngineEffortSetting(cfg.engine, cfg.effort, codexDefaults, locale)}`,
    `Codex Fast Mode：${cfg.codexServiceTier === "fast" ? "开启" : "关闭"}`,
    `审批模式：${renderLarkApprovalModeStatus(rawConfig.approvalMode, locale)}`,
    `预算：${cfg.budgetUsd !== undefined ? `$${cfg.budgetUsd.toFixed(2)}` : "无"}`,
    ...(cfg.budgetUsd !== undefined && cfg.engine !== "claude" ? [renderLarkBudgetEngineNote(locale)] : []),
    `语言：${locale}`,
    `详细度：${cfg.verbosity}`,
    `时区：${cfg.timezone}`,
    `Lark CLI：${renderLarkCliStatus(larkCliStatus, locale)}`,
    `当前聊天：${knownChat?.label ?? normalized.chatId}`,
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

/**
 * One-line caveat shown next to a configured budget on non-Claude engines:
 * Codex/Antigravity never report dollar cost, so the budgetUsd cap can never
 * trip there — pretending otherwise would be a false safety net.
 */
function renderLarkBudgetEngineNote(locale: Locale): string {
  return locale === "en"
    ? "Note: Codex/Antigravity engines do not report dollar cost; the budget cap currently only takes effect on Claude."
    : "注意：Codex/Antigravity 引擎不上报美元成本，预算上限目前只对 Claude 生效。";
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
  const resolved = resolveApprovalMode(mode);
  if (resolved === "bypass") {
    return "YOLO unsafe/bypass";
  }
  if (resolved === "full-auto") {
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

async function renderLarkGroupModeStatusLines(input: {
  stateDir: string;
  chatId: string;
  bridgeChatId: number;
  bridgeAccessChatId: number;
  groupMode: GroupModeConfig;
  locale: Locale;
  requireMentionInGroup?: boolean;
}): Promise<string[]> {
  const store = new LarkGroupModeStore(input.stateDir);
  const listenAll = input.groupMode.enabled && (
    await store.isListenAll(input.chatId) ||
    isConfiguredLarkListenAll(input.groupMode, input.bridgeChatId, input.bridgeAccessChatId)
  );
  const requiresMention = !input.groupMode.enabled || (input.requireMentionInGroup !== false && !listenAll);
  if (input.locale === "en") {
    const source = !input.groupMode.enabled
      ? "group mode disabled"
      : listenAll
      ? "/group all override"
      : input.requireMentionInGroup === false
        ? "global mention requirement disabled"
        : "default mention mode";
    return [
      `Group trigger: ${requiresMention ? "requires @bot / mention" : "accepts ordinary group messages"}`,
      `Group mode source: ${source}`,
    ];
  }
  const source = !input.groupMode.enabled
    ? "群聊模式已关闭"
    : listenAll
    ? "/group all override"
    : input.requireMentionInGroup === false
      ? "全局已关闭 @bot 要求"
      : "默认 @bot 模式";
  return [
    `群聊触发：${requiresMention ? "需要 @bot / mention" : "接受普通群消息"}`,
    `群聊模式来源：${source}`,
  ];
}

function isConfiguredLarkListenAll(groupMode: GroupModeConfig, bridgeChatId: number, bridgeAccessChatId: number): boolean {
  return groupMode.listenAllChatIds.includes(bridgeAccessChatId) || groupMode.listenAllChatIds.includes(bridgeChatId);
}

function isConfiguredLarkGroupAllowed(groupMode: GroupModeConfig, bridgeChatId: number, bridgeAccessChatId: number): boolean {
  return groupMode.allowedChatIds.includes(bridgeAccessChatId) || groupMode.allowedChatIds.includes(bridgeChatId);
}

function isCurrentLarkGroupNumericId(chatId: number, normalized: LarkNormalizedBridgeMessage): boolean {
  return chatId === normalized.bridgeAccessChatId || chatId === normalized.bridgeChatId;
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
        ...CLAUDE_MODEL_CHOICES.map((model) => `/model ${model}`),
        "/model off",
        "Latest Opus alias: /model opus[1m]",
      ].join("\n");
    }
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      ...CLAUDE_MODEL_CHOICES.map((model) => `/model ${model}`),
      "/model off",
      "跟随最新 Opus 的别名：/model opus[1m]",
    ].join("\n");
  }
  if (cfg.engine === "codex") {
    if (locale === "en") {
      return [
        `Current model: ${current}`,
        "Choose a model with /model <name>:",
        ...CODEX_MODEL_CHOICES.map((model) => `/model ${model}`),
        "/model off",
        CODEX_EFFORT_COMPATIBILITY_EN,
      ].join("\n");
    }
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      ...CODEX_MODEL_CHOICES.map((model) => `/model ${model}`),
      "/model off",
      CODEX_EFFORT_COMPATIBILITY_ZH,
    ].join("\n");
  }
  if (cfg.engine === "kimi") {
    return locale === "en"
      ? [
          `Current model: ${current}`,
          "Use /model <id> with a model advertised by your Kimi provider configuration.",
          "/model off",
          "Kimi validates the exact model ID through ACP when the next turn starts.",
        ].join("\n")
      : [
          `当前模型: ${current}`,
          "用 /model <id> 设置当前 Kimi provider 配置实际提供的模型。",
          "/model off",
          "下一轮开始时会通过 ACP 校验该模型 ID。",
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
    if (cfg.engine === "codex" && isExtendedCodexEffort(cfg.effort)) {
      return locale === "en"
        ? `Cannot restore the default model while effort is ${cfg.effort}; reset /effort first.`
        : `当前 effort 为 ${cfg.effort}，不能恢复默认模型；请先重置 /effort。`;
    }
    await updateInstanceConfig(stateDir, (config) => {
      delete config.model;
    });
    return locale === "en" ? "Model reset to default." : "模型已恢复默认。";
  }
  if (
    cfg.engine === "codex" &&
    cfg.effort &&
    (knownCodexModelSupportsEffort(model, cfg.effort) === false ||
      (knownCodexModelSupportsEffort(model, cfg.effort) === undefined && isExtendedCodexEffort(cfg.effort)))
  ) {
    const maxEffort = knownCodexModelMaxEffort(model);
    return maxEffort
      ? locale === "en"
        ? `${model} supports up to ${maxEffort}, which is incompatible with current effort ${cfg.effort}; change /effort first.`
        : `${model} 最高支持 ${maxEffort}，与当前 effort ${cfg.effort} 不兼容；请先调整 /effort。`
      : locale === "en"
        ? `Compatibility between ${model} and effort ${cfg.effort} is unknown; lower /effort or choose a listed model first.`
        : `无法确认 ${model} 是否支持 ${cfg.effort}；请先降低 /effort 或选择列表中的模型。`;
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
  if (cfg.engine === "claude" && level === "ultra") {
    return locale === "en"
      ? "Claude does not support ultra; use max for its highest effort."
      : "Claude 不支持 ultra；最高可用 max。";
  }
  if (cfg.engine === "kimi" && !KIMI_EFFORT_LEVELS.includes(level as (typeof KIMI_EFFORT_LEVELS)[number])) {
    return locale === "en"
      ? "Kimi effort supports only low, high, max, or off."
      : "Kimi effort 仅支持 low、high、max 或 off。";
  }
  if (!VALID_LARK_EFFORT_LEVELS.includes(level as EffortLevel)) {
    return locale === "en"
      ? "Usage: /effort [low|medium|high|xhigh|max|ultra|off]"
      : "用法: /effort [low|medium|high|xhigh|max|ultra|off]";
  }
  if (cfg.engine === "codex") {
    const effort = level as EffortLevel;
    const support = knownCodexModelSupportsEffort(cfg.model, effort);
    if (support === false || (support === undefined && isExtendedCodexEffort(effort))) {
      const maxEffort = knownCodexModelMaxEffort(cfg.model);
      return maxEffort
        ? locale === "en"
          ? `${cfg.model} does not support ${level}; its highest effort is ${maxEffort}.`
          : `${cfg.model} 不支持 ${level}；最高可用 ${maxEffort}。`
        : locale === "en"
          ? `Select an explicit compatible model before setting ${level} (for example, /model gpt-5.6-sol).`
          : `请先选择明确兼容的模型再设置 ${level}（例如 /model gpt-5.6-sol）。`;
    }
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.effort = level;
  });
  return locale === "en" ? `Effort set to ${level}.` : `Effort 已设为 ${level}。`;
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

// /stream toggles Lark element-level streaming (the native typewriter on run
// cards). Off = every update goes through the full-card patch path — the
// pre-v0.1.160 behavior. Instance-level, persisted; applies from the NEXT
// turn (the running turn's controller already captured the flag).
async function handleLarkStreamCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  const envOff = ["off", "0", "false"].includes((process.env.CCTB_LARK_ELEMENT_STREAM ?? "").trim().toLowerCase());
  const envNote = locale === "en"
    ? "\nNote: env CCTB_LARK_ELEMENT_STREAM=off currently force-disables streaming regardless of this setting."
    : "\n注意：环境变量 CCTB_LARK_ELEMENT_STREAM=off 当前强制关闭流式，此设置暂不生效。";
  if (action === "on" || action === "enable") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.larkElementStream;
    });
    return (locale === "en"
      ? "Element streaming (typewriter) enabled. Takes effect from the next turn."
      : "流式打字机已开启，下一轮回答生效。") + (envOff ? envNote : "");
  }
  if (action === "off" || action === "disable") {
    await updateInstanceConfig(stateDir, (config) => {
      config.larkElementStream = false;
    });
    return locale === "en"
      ? "Element streaming disabled — answers update via full-card refresh (the pre-typewriter behavior). Takes effect from the next turn."
      : "流式打字机已关闭，回答改回整卡刷新模式（打字机之前的行为），下一轮回答生效。";
  }
  if (action === "status") {
    const configured = cfg.larkElementStream !== false;
    const effective = configured && !envOff;
    if (locale === "en") {
      return `Element streaming (typewriter): ${effective ? "on" : "off"}${configured && envOff ? envNote : ""}`;
    }
    return `流式打字机：${effective ? "开启" : "关闭"}${configured && envOff ? envNote : ""}`;
  }
  return locale === "en" ? "Usage: /stream [on|off|status]" : "用法: /stream [on|off|status]";
}

// /timeout toggles the single-turn runtime time cap (60 min). The cap auto-stops
// a turn that runs too long; lifting it lets a genuinely long task (full test
// suites, big migrations) run to completion, at the cost of no auto-recovery if
// a turn truly hangs. Instance-level, persisted; applies from the next turn.
// "on" = cap enforced (default, safe); "off" = cap lifted (long tasks allowed).
async function handleLarkTimeoutCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  // The single-turn cap only exists on Codex/Antigravity; the Claude adapter has
  // no turn timeout (it runs indefinitely). On Claude, say so honestly instead of
  // claiming a cap was lifted — the flag is still persisted so it applies if the
  // instance later switches to Codex.
  const claudeNote = cfg.engine === "claude"
    ? (locale === "en"
      ? " (Note: this instance runs Claude, which has no single-turn cap; this toggle only affects Codex/Antigravity.)"
      : "（注意：当前是 Claude 引擎，本就无单轮超时，此开关只对 Codex/Antigravity 生效。）")
    : "";
  if (action === "off" || action === "disable" || action === "long" || action === "unlimited") {
    await updateInstanceConfig(stateDir, (config) => {
      config.disableRuntimeTimeout = true;
    });
    return (locale === "en"
      ? "Single-turn time cap lifted — long tasks can run without the 60-min limit. Note: a truly hung turn won't auto-recover. Takes effect from the next turn."
      : "已放开单轮时间上限——长任务不再受 60 分钟限制。注意：真卡死的回合不会自动恢复。下一轮生效。") + claudeNote;
  }
  if (action === "on" || action === "enable" || action === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.disableRuntimeTimeout;
    });
    return (locale === "en"
      ? "Single-turn time cap re-enabled (60 min, default). Takes effect from the next turn."
      : "已恢复单轮时间上限（60 分钟，默认）。下一轮生效。") + claudeNote;
  }
  if (action === "status") {
    const lifted = cfg.disableRuntimeTimeout === true;
    if (locale === "en") {
      return `Single-turn time cap: ${lifted ? "lifted (no limit — /timeout on to restore)" : "60 min (default — /timeout off to lift for long tasks)"}` + claudeNote;
    }
    return `单轮时间上限：${lifted ? "已放开（无限制，/timeout on 恢复）" : "60 分钟（默认，长任务用 /timeout off 放开）"}` + claudeNote;
  }
  return locale === "en" ? "Usage: /timeout [on|off|status]" : "用法: /timeout [on|off|status]";
}

/**
 * /steer — mid-turn steering policy (instance-level, like /stream and /timeout).
 * A running turn accepts injected follow-ups only within its eligibility window
 * (default 30s); later messages queue as their own turn. `off` disables steering
 * entirely, `<seconds>` tunes the window, `unlimited` (=0) restores steer-any-time.
 */
async function handleLarkSteerCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  const en = locale === "en";
  // Steering is implemented only by the Codex app-server adapter; on Claude the
  // setting persists but mid-turn messages always queue regardless. Say so
  // honestly instead of implying the toggle changes anything here.
  const claudeNote = cfg.engine === "claude"
    ? (en
      ? " (Note: this instance runs Claude, which doesn't support mid-turn steering — messages during a turn always queue; this setting only takes effect if the instance switches to Codex.)"
      : "（注意：当前是 Claude 引擎，不支持任务中途注入——进行中收到的消息本就一律排队；此设置仅在切换到 Codex 引擎后生效。）")
    : "";
  const describe = (enabled: boolean, windowSeconds: number): string => {
    if (!enabled) {
      return en
        ? "Steering: off — mid-turn messages always queue as their own turn (/steer on to re-enable)."
        : "引导：已关闭——任务进行中发的消息一律排队作为独立任务执行（/steer on 重新开启）。";
    }
    if (windowSeconds === 0) {
      return en
        ? "Steering: on, unlimited window — messages inject into the running turn at any time (/steer 30 to restore the window)."
        : "引导：开启，不限时——任何时刻发消息都注入当前任务（/steer 30 可恢复窗口限制）。";
    }
    return en
      ? `Steering: on, window ${windowSeconds}s — a running turn accepts steering only within its first ${windowSeconds}s; later messages queue. (/steer <seconds> to tune, /steer unlimited to lift, /steer off to disable)`
      : `引导：开启，资格窗口 ${windowSeconds} 秒——任务开跑 ${windowSeconds} 秒内的消息注入当前任务，之后的消息排队独立执行。（/steer <秒数> 调整，/steer unlimited 不限时，/steer off 关闭）`;
  };
  if (action === "off" || action === "disable") {
    await updateInstanceConfig(stateDir, (config) => {
      config.larkSteerEnabled = false;
    });
    return describe(false, cfg.larkSteerWindowSeconds ?? LARK_STEER_DEFAULT_WINDOW_SECONDS) + claudeNote;
  }
  if (action === "on" || action === "enable") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.larkSteerEnabled;
    });
    return describe(true, cfg.larkSteerWindowSeconds ?? LARK_STEER_DEFAULT_WINDOW_SECONDS) + claudeNote;
  }
  if (action === "unlimited" || action === "always" || action === "不限" || action === "0") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.larkSteerEnabled;
      config.larkSteerWindowSeconds = 0;
    });
    return describe(true, 0) + claudeNote;
  }
  if (action === "default" || action === "reset") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.larkSteerEnabled;
      delete config.larkSteerWindowSeconds;
    });
    return describe(true, LARK_STEER_DEFAULT_WINDOW_SECONDS) + claudeNote;
  }
  const secondsMatch = action.match(/^(\d+)\s*(s|秒)?$/) ?? action.match(/^(\d+)\s*(m|分|分钟)$/);
  if (secondsMatch) {
    const raw = Number.parseInt(secondsMatch[1]!, 10);
    const seconds = /m|分/.test(secondsMatch[2] ?? "") ? raw * 60 : raw;
    // Zero in ANY spelling (0s / 0秒 / 0m / 0分 / 0分钟) means unlimited, same
    // as the bare "0" alias above — `/steer 0s` used to error while `/steer 0`
    // lifted the window, which read as arbitrary.
    if (seconds === 0) {
      await updateInstanceConfig(stateDir, (config) => {
        delete config.larkSteerEnabled;
        config.larkSteerWindowSeconds = 0;
      });
      return describe(true, 0) + claudeNote;
    }
    if (seconds < 1 || seconds > 86_400) {
      return en ? "Window must be 1s–24h (or `unlimited`)." : "窗口需在 1 秒～24 小时之间（或用 `unlimited` 不限时）。";
    }
    await updateInstanceConfig(stateDir, (config) => {
      delete config.larkSteerEnabled;
      config.larkSteerWindowSeconds = seconds;
    });
    return describe(true, seconds) + claudeNote;
  }
  if (action === "status") {
    return describe(cfg.larkSteerEnabled !== false, cfg.larkSteerWindowSeconds ?? LARK_STEER_DEFAULT_WINDOW_SECONDS) + claudeNote;
  }
  return en
    ? "Usage: /steer [on|off|<seconds>|unlimited|default|status]"
    : "用法: /steer [on|off|<秒数>|unlimited|default|status]";
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
    return locale === "en" ? "Usage: /engine [claude|codex|kimi|antigravity]" : "用法: /engine [claude|codex|kimi|antigravity]";
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
    const mode = resolveApprovalMode((await readRawLarkConfig(stateDir)).approvalMode);
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
    // Claude/Antigravity have a NATIVE /goal (autonomous multi-turn pursuit with an
    // independent completion checker), so we just forward "/goal <objective>" as a
    // normal engine turn — no thread-goal API needed. Tag the turn with the
    // objective so its run card renders the 🎯 goal banner, matching the framing of
    // the Codex goal card instead of looking like an ordinary reply.
    if (action.kind === "set") {
      normalized.goalObjective = action.objective;
    }
    return null;
  }

  const goalInput = {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    workspaceOverride: resolveInstanceWorkspacePath(cfg),
  };
  // activeRuns key for this conversation — shared by the live watcher (which claims
  // it) and by clear (which aborts it), so a detached goal watcher participates in
  // the same single-active-run tracking as normal turns instead of running unguarded.
  const conversationKey = normalized.conversationKey ?? `lark:${normalized.chatId}`;

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
    // If a goal WATCHER is actively pursuing this conversation's goal, abort it first
    // so it stops cleanly — its abort path clears the goal in the engine and flips the
    // run card to interrupted. Guard on goalWatch so a normal turn sharing the
    // activeRuns slot is NOT killed (nor falsely reported "cleared") by /goal clear.
    const activeGoalRun = input.runtime.activeRuns.get(conversationKey);
    if (activeGoalRun?.goalWatch) {
      // End the PURSUIT specifically: abortGoal bypasses the stop routing that
      // would otherwise divert a plain abort() into an ordinary turn currently
      // running alongside the pursuit — /goal clear must kill the goal, never
      // that unrelated turn (which keeps running).
      if (activeGoalRun.abortController instanceof LarkGoalRunController) {
        activeGoalRun.abortController.abortGoal();
      } else {
        activeGoalRun.abortController.abort();
      }
      await sendLarkCommandMarkdown(input, normalized, "/goal", locale === "en"
        ? "Current goal cleared." : "已清除当前 goal。");
      return true;
    }
    const { cleared } = await input.bridge.clearThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", cleared
      ? locale === "en" ? "Current goal cleared." : "已清除当前 goal。"
      : locale === "en" ? "This chat has no goal to clear." : "当前聊天没有可清除的 goal。");
    return true;
  }

  // Live path: set the goal AND watch Codex's autonomous pursuit of it, streaming the
  // progress into a run card (Codex self-drives once the goal is set). The watch runs
  // detached so the command returns immediately while the card updates in the
  // background. Falls back to plain set-and-confirm when watch/CardKit is unavailable.
  if (input.bridge.watchThreadGoal && input.createRunCard) {
    const goalCfg = await loadInstanceConfig(input.stateDir);
    const runCard = await input.createRunCard({
      channel: input.channel,
      chatId: normalized.chatId,
      conversationKey,
      bridgeChatType: normalized.bridgeChatType ?? "private",
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      goalObjective: action.objective,
      elementStream: goalCfg.larkElementStream !== false,
    });
    if (runCard) {
      // Bind to the bridge: a bare `const fn = input.bridge.watchThreadGoal` loses
      // `this`, so the method's `this.adapter` would throw "Cannot read properties of
      // undefined (reading 'adapter')". (This is why /goal failed end-to-end while the
      // adapter passed in isolation.)
      const watchThreadGoal = input.bridge.watchThreadGoal.bind(input.bridge);
      const clearThreadGoal = input.bridge.clearThreadGoal?.bind(input.bridge);
      // Register the autonomous goal as the conversation's active run so /stop (and the
      // run card's stop button) can abort it — both flip activeRuns[key].abortController.
      // A LarkGoalRunController (bus.ts) rather than a plain AbortController: ordinary
      // turns arriving DURING the pursuit attach to it (claimLarkRunSlot) instead of
      // stealing the slot, and abort() routes to the attached turn first so the pursuit
      // survives everything except /stop-with-nothing-else-running and /goal clear.
      const abort = new LarkGoalRunController();
      // Active protection: the watcher runs detached (outside the chat queue), so abort
      // any run already active for this conversation before claiming the slot —
      // otherwise overwriting activeRuns would orphan it (untracked; /stop can't reach
      // it). A replaced PURSUIT is ended entirely (goal + any attached ordinary turn:
      // both would be orphaned by the overwrite). Guarantees exactly one tracked
      // active run per conversation.
      const previousActive = input.runtime.activeRuns.get(conversationKey)?.abortController;
      if (previousActive instanceof LarkGoalRunController) {
        previousActive.abortAll();
      } else {
        previousActive?.abort();
      }
      input.runtime.activeRuns.set(conversationKey, { abortController: abort, hasRunCard: true, goalWatch: true, startedAt: Date.now() });
      void (async () => {
        try {
          const { goal: watched } = await watchThreadGoal({
            ...goalInput,
            objective: action.objective,
            tokenBudget: action.tokenBudget,
            onEngineEvent: (event) => { void runCard.apply(event); },
            abortSignal: abort.signal,
          });
          if (abort.signal.aborted) {
            // Stopped: clear the goal so Codex halts its autonomous pursuit (aborting the
            // watcher alone only stops us listening), then flip the card to "已中断".
            try { await clearThreadGoal?.({ ...goalInput }); } catch { /* best-effort */ }
            await runCard.interrupt();
          } else {
            // Completed (watchThreadGoal only resolves at a terminal status). Clear the
            // goal from the Codex thread too — previously only the abort path cleared it,
            // so a finished goal stayed SET in the thread and was silently resumed by, or
            // bled into, later ordinary messages in the same thread.
            try { await clearThreadGoal?.({ ...goalInput }); } catch { /* best-effort */ }
            await runCard.finish(watched
              ? renderLarkGoal(watched, locale)
              : locale === "en" ? "Goal finished." : "Goal 已结束。");
          }
        } catch (error) {
          // Record the real reason so "详细原因已记录到日志" is actually true and the
          // failure is diagnosable from the timeline (the run card stays redacted).
          await appendLarkTimelineEvent(input.stateDir, normalized, {
            type: "command.handled",
            outcome: "error",
            detail: "/goal",
            metadata: { error: error instanceof Error ? (error.stack ?? error.message) : String(error) },
          }).catch(() => {});
          await runCard.fail(renderLarkUserFacingError(error, "engine", locale));
        } finally {
          // Release our slot only if a newer run hasn't already replaced it. If an
          // ordinary turn is still attached (it ran alongside the pursuit and the
          // pursuit ended first), PROMOTE it into the slot so /stop and the stop
          // buttons can still reach it for the rest of its run — its own guarded
          // release (claimLarkRunSlot) then cleans the promoted slot up.
          if (input.runtime.activeRuns.get(conversationKey)?.abortController === abort) {
            const concurrent = abort.liveConcurrentTurn();
            if (concurrent) {
              input.runtime.activeRuns.set(conversationKey, concurrent);
            } else {
              input.runtime.activeRuns.delete(conversationKey);
            }
          }
        }
      })();
      return true;
    }
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
