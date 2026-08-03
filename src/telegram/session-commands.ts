import { lstat, realpath, stat, unlink } from "node:fs/promises";

import type { ExternalSessionInfo } from "../codex/adapter.js";
import { SessionStateError } from "../runtime/session-manager.js";
import {
  formatAntigravityConversationList,
  formatSessionList,
  MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS,
  scanRecentAntigravityConversations,
  scanRecentClaudeSessions,
  type ScannedSession,
} from "../runtime/session-scanner.js";
import type { InstanceEngine, ResumeState } from "./instance-config.js";
import { renderSessionResetMessage, type Locale } from "./message-renderer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";
import { isResetCommand } from "./command-detection.js";
import { getNormalizedTelegramConversationKey, getTelegramConversationKey } from "./conversation-key.js";

export interface SessionCommandConfig {
  engine: InstanceEngine;
  resume?: ResumeState;
}

export interface SessionCommandStore {
  inspect(): Promise<{ warning?: string; repairable?: boolean }>;
  findByChatIdSafe(chatId: number): Promise<{
    record: {
      codexSessionId: string;
      suspendedPrevious?: {
        sessionId: string | null;
        resume: ResumeState | null;
      };
    } | null;
    warning?: string;
    repairable?: boolean;
  }>;
  findByConversationKeySafe?(conversationKey: string): Promise<{
    record: {
      codexSessionId: string;
      suspendedPrevious?: {
        sessionId: string | null;
        resume: ResumeState | null;
      };
    } | null;
    warning?: string;
    repairable?: boolean;
  }>;
  removeByChatId(chatId: number): Promise<boolean | void>;
  removeByConversationKey?(conversationKey: string): Promise<boolean | void>;
  upsert(record: {
    telegramChatId: number;
    telegramThreadId?: number;
    conversationKey?: string;
    codexSessionId: string;
    status: "idle";
    updatedAt: string;
    suspendedPrevious?: {
      sessionId: string | null;
      resume: ResumeState | null;
    };
  }): Promise<void>;
}

const RESUME_SCAN_TTL_MS = 10 * 60 * 1000;
const ANTIGRAVITY_CONVERSATION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type PendingResumeScanKind = "claude" | "antigravity" | "kimi";

const pendingResumeScans = new Map<string, {
  kind: PendingResumeScanKind;
  scannedAt: number;
  sessions: ScannedSession[];
}>();

type ResumeCommand =
  | { kind: "scan" }
  | { kind: "pick"; pick: number }
  | { kind: "thread"; threadId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "invalid" };

function parseResumeCommand(text: string): ResumeCommand | null {
  const match = text.trim().match(/^\/resume(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  const arg = match[1]?.trim();
  if (!arg) return { kind: "scan" };

  const threadMatch = arg.match(/^thread\s+(\S+)$/i);
  if (threadMatch?.[1]?.trim()) {
    return { kind: "thread", threadId: threadMatch[1].trim() };
  }

  const conversationMatch = arg.match(/^(?:conversation|conv)\s+(\S+)$/i);
  if (conversationMatch?.[1]?.trim()) {
    return { kind: "conversation", conversationId: conversationMatch[1].trim() };
  }

  const sessionMatch = arg.match(/^session\s+(\S+)$/i);
  if (sessionMatch?.[1]?.trim()) {
    return { kind: "session", sessionId: sessionMatch[1].trim() };
  }

  const num = Number(arg);
  if (!Number.isInteger(num) || num < 1) return { kind: "invalid" };
  return { kind: "pick", pick: num };
}

function isDetachCommand(text: string): boolean {
  return /^\/detach(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function resetPendingResumeScans(): void {
  pendingResumeScans.clear();
}

function getPendingResumeScan(conversationKey: string, kind: PendingResumeScanKind): ScannedSession[] | null {
  const entry = pendingResumeScans.get(conversationKey);
  if (!entry) {
    return null;
  }

  if (entry.kind !== kind || Date.now() - entry.scannedAt > RESUME_SCAN_TTL_MS) {
    pendingResumeScans.delete(conversationKey);
    return null;
  }

  return entry.sessions;
}

function isAntigravityConversationId(value: string): boolean {
  return ANTIGRAVITY_CONVERSATION_ID_PATTERN.test(value);
}

function buildSuspendedPreviousSnapshot(input: {
  existingRecord: {
    codexSessionId: string;
    suspendedPrevious?: {
      sessionId: string | null;
      resume: ResumeState | null;
    };
  } | null;
  currentResume: ResumeState | undefined;
}): { sessionId: string | null; resume: ResumeState | null } | undefined {
  if (input.existingRecord?.suspendedPrevious) {
    return input.existingRecord.suspendedPrevious;
  }

  if (!input.existingRecord?.codexSessionId && !input.currentResume) {
    return undefined;
  }

  return {
    sessionId: input.existingRecord?.codexSessionId ?? null,
    resume: input.currentResume ?? null,
  };
}

function findSessionForConversation(
  store: SessionCommandStore,
  normalized: NormalizedTelegramMessage,
): ReturnType<SessionCommandStore["findByChatIdSafe"]> {
  const conversationKey = getNormalizedTelegramConversationKey(normalized);
  return store.findByConversationKeySafe
    ? store.findByConversationKeySafe(conversationKey)
    : store.findByChatIdSafe(normalized.chatId);
}

function removeSessionForConversation(
  store: SessionCommandStore,
  normalized: NormalizedTelegramMessage,
): Promise<boolean | void> {
  const conversationKey = getNormalizedTelegramConversationKey(normalized);
  return store.removeByConversationKey
    ? store.removeByConversationKey(conversationKey)
    : store.removeByChatId(normalized.chatId);
}

function sessionScopeRecordFields(normalized: NormalizedTelegramMessage): {
  telegramThreadId?: number;
  conversationKey?: string;
} {
  const conversationKey = getNormalizedTelegramConversationKey(normalized);
  const defaultConversationKey = getTelegramConversationKey(normalized.chatId, normalized.messageThreadId);
  if (normalized.messageThreadId === undefined) {
    return conversationKey === defaultConversationKey ? {} : { conversationKey };
  }
  return {
    telegramThreadId: normalized.messageThreadId,
    conversationKey,
  };
}

export async function handleLocalSessionTelegramCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: SessionCommandConfig;
  normalized: NormalizedTelegramMessage;
  context: TelegramTurnContext;
  sessionStore: SessionCommandStore;
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
  validateCodexThread?: (
    threadId: string,
    input?: { workspaceOverride?: string },
  ) => Promise<ExternalSessionInfo | void>;
  scanRecentSessions?: (hours: number) => Promise<ScannedSession[]>;
  scanRecentAntigravitySessions?: (hours: number) => Promise<ScannedSession[]>;
  scanRecentKimiSessions?: () => Promise<ScannedSession[]>;
  formatSessionListMessage?: (sessions: ScannedSession[], locale: Locale) => string;
  formatAntigravityConversationListMessage?: (sessions: ScannedSession[], locale: Locale) => string;
  sendResumeScanResult?: (input: {
    kind: "claude" | "antigravity" | "kimi";
    sessions: ScannedSession[];
    visibleSessions: ScannedSession[];
    locale: Locale;
  }) => Promise<void>;
}): Promise<boolean> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    normalized,
    context,
    sessionStore,
    updateInstanceConfig,
    validateCodexThread,
    scanRecentSessions = scanRecentClaudeSessions,
    scanRecentAntigravitySessions = scanRecentAntigravityConversations,
    scanRecentKimiSessions,
    formatSessionListMessage = formatSessionList,
    formatAntigravityConversationListMessage = formatAntigravityConversationList,
    sendResumeScanResult,
  } = input;
  const conversationKey = getNormalizedTelegramConversationKey(normalized);

  if (isResetCommand(normalized.text)) {
    const inspectedState = await sessionStore.inspect();
    if (inspectedState.warning) {
      throw new SessionStateError(
        inspectedState.repairable
          ? "Session state is unreadable right now. The operator needs to repair session state and retry."
          : "Session state is unavailable right now. The operator needs to restore read access and retry.",
        inspectedState.repairable ?? false,
      );
    }

    await removeSessionForConversation(sessionStore, normalized);

    if (cfg.resume) {
      if (cfg.resume.symlinkPath) {
        try {
          const st = await lstat(cfg.resume.symlinkPath);
          if (st.isSymbolicLink()) await unlink(cfg.resume.symlinkPath);
        } catch {
          // ok
        }
      }
      await updateInstanceConfig((c) => { delete c.resume; });
    }

    const resetMessage = renderSessionResetMessage(false, locale);
    await context.api.sendMessage(normalized.chatId, resetMessage);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "reset",
      responseText: resetMessage,
    });
    return true;
  }

  const resumeCmd = parseResumeCommand(normalized.text);
  if (resumeCmd) {
    if (cfg.engine === "kimi") {
      if (resumeCmd.kind === "scan") {
        if (!scanRecentKimiSessions) {
          const msg = locale === "zh"
            ? "当前 Kimi runtime 未提供 session 列表。"
            : "This Kimi runtime does not provide session listing.";
          await context.api.sendMessage(normalized.chatId, msg);
          await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
            startedAt,
            command: "resume",
            responseText: msg,
            metadata: { engine: "kimi", rejected: "listing-unavailable" },
          });
          return true;
        }
        const sessions = (await scanRecentKimiSessions()).slice(0, MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS);
        if (sessions.length > 0) {
          pendingResumeScans.set(conversationKey, { kind: "kimi", scannedAt: Date.now(), sessions });
        } else {
          pendingResumeScans.delete(conversationKey);
        }
        const msg = sessions.length > 0
          ? [
              locale === "zh" ? "Kimi sessions：" : "Kimi sessions:",
              ...sessions.map((session, index) => `${index + 1}. [${session.displayName}] ${session.sessionId}`),
              locale === "zh" ? "\n回复 /resume <编号> 继续。" : "\nReply /resume <number> to continue.",
            ].join("\n")
          : (locale === "zh" ? "没有找到 Kimi session。" : "No Kimi sessions found.");
        if (sendResumeScanResult) {
          await sendResumeScanResult({ kind: "kimi", sessions, visibleSessions: sessions, locale });
        } else {
          await context.api.sendMessage(normalized.chatId, msg);
        }
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: "kimi", scanned: sessions.length },
        });
        return true;
      }

      let sessionId: string | null = null;
      let selectedSession: ScannedSession | undefined;
      if (resumeCmd.kind === "pick") {
        const cached = getPendingResumeScan(conversationKey, "kimi");
        if (!cached || resumeCmd.pick < 1 || resumeCmd.pick > cached.length) {
          const msg = locale === "zh"
            ? "无效选择，请先发 /resume 扫描 Kimi session。"
            : "Invalid selection. Send /resume first to scan Kimi sessions.";
          await context.api.sendMessage(normalized.chatId, msg);
          await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
            startedAt,
            command: "resume",
            responseText: msg,
            metadata: { engine: "kimi", rejected: "invalid-pick" },
          });
          return true;
        }
        selectedSession = cached[resumeCmd.pick - 1]!;
        sessionId = selectedSession.sessionId;
        pendingResumeScans.delete(conversationKey);
      } else if (resumeCmd.kind === "session") {
        sessionId = resumeCmd.sessionId;
      } else {
        const msg = locale === "zh"
          ? "用法: /resume、/resume <编号> 或 /resume session <session-id>"
          : "Usage: /resume, /resume <number>, or /resume session <session-id>";
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: "kimi", rejected: "invalid-kimi-arg" },
        });
        return true;
      }

      let validatedSession: ExternalSessionInfo | void;
      let workspacePath: string;
      try {
        if (!validateCodexThread) {
          throw new Error("external session validation unsupported");
        }
        validatedSession = await validateCodexThread(sessionId);
        const candidate = validatedSession?.cwd ?? selectedSession?.workspacePath;
        if (!candidate) {
          throw new Error("Kimi session workspace is unavailable");
        }
        workspacePath = await realpath(candidate);
        const workspaceInfo = await stat(workspacePath);
        if (!workspaceInfo.isDirectory()) {
          throw new Error("Kimi session workspace is not a directory");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const unsupported = /validation unsupported|listing unsupported/i.test(detail);
        const msg = unsupported
          ? (locale === "zh" ? "当前 Kimi runtime 无法验证 session id。" : "This Kimi runtime cannot validate session IDs.")
          : (locale === "zh" ? `无法加载 Kimi session：${sessionId}` : `Could not load Kimi session: ${sessionId}`);
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: {
            engine: "kimi",
            rejected: unsupported ? "session-validation-unavailable" : "session-load-failed",
          },
        });
        return true;
      }

      const existing = await findSessionForConversation(sessionStore, normalized);
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
        ...sessionScopeRecordFields(normalized),
        codexSessionId: sessionId,
        status: "idle",
        updatedAt: new Date().toISOString(),
        suspendedPrevious: buildSuspendedPreviousSnapshot({
          existingRecord: existing.record,
          currentResume: cfg.resume,
        }),
      });
      await updateInstanceConfig((c) => {
        c.resume = {
          sessionId,
          dirName: selectedSession?.dirName ?? sessionId,
          workspacePath,
        };
      });

      const msg = locale === "zh"
        ? `已绑定 Kimi session：${sessionId}\n工作区：${workspacePath}\n\n发送消息继续对话，完成后发 /detach 断开。`
        : `Attached Kimi session: ${sessionId}\nWorkspace: ${workspacePath}\n\nSend a message to continue. Use /detach when done.`;
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { engine: "kimi", sessionId },
      });
      return true;
    }

    if (cfg.engine === "antigravity") {
      if (resumeCmd.kind === "scan") {
        const sessions = await scanRecentAntigravitySessions(24);
        const selectableSessions = sessions.slice(0, MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS);
        const msg = formatAntigravityConversationListMessage(sessions, locale);
        if (selectableSessions.length > 0) {
          pendingResumeScans.set(conversationKey, {
            kind: "antigravity",
            scannedAt: Date.now(),
            sessions: selectableSessions,
          });
        } else {
          pendingResumeScans.delete(conversationKey);
        }
        if (sendResumeScanResult) {
          await sendResumeScanResult({
            kind: "antigravity",
            sessions,
            visibleSessions: selectableSessions,
            locale,
          });
        } else {
          await context.api.sendMessage(normalized.chatId, msg);
        }
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: "antigravity", scanned: sessions.length },
        });
        return true;
      }

      let pickedConversationId: string | null = null;
      if (resumeCmd.kind === "pick") {
        const cached = getPendingResumeScan(conversationKey, "antigravity");
        if (!cached || resumeCmd.pick < 1 || resumeCmd.pick > cached.length) {
          const msg = locale === "zh"
            ? "无效选择，请先发 /resume 扫描 Antigravity conversation。"
            : "Invalid selection. Send /resume first to scan Antigravity conversations.";
          await context.api.sendMessage(normalized.chatId, msg);
          await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
            startedAt,
            command: "resume",
            responseText: msg,
            metadata: { engine: "antigravity", rejected: "invalid-pick" },
          });
          return true;
        }
        pickedConversationId = cached[resumeCmd.pick - 1]!.sessionId;
        pendingResumeScans.delete(conversationKey);
      }

      if (resumeCmd.kind !== "conversation" && resumeCmd.kind !== "pick") {
        const msg = locale === "zh"
          ? "用法: /resume、/resume <编号> 或 /resume conversation <conversation-id>。"
          : "Usage: /resume, /resume <number>, or /resume conversation <conversation-id>.";
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { rejected: "invalid-antigravity-arg" },
        });
        return true;
      }

      const conversationId = pickedConversationId ?? (resumeCmd.kind === "conversation" ? resumeCmd.conversationId : null);
      if (!conversationId) {
        return true;
      }
      if (!isAntigravityConversationId(conversationId)) {
        const msg = locale === "zh"
          ? "Antigravity conversation id 无效。请使用 /resume 扫描最近 conversation，或发送 /resume conversation <uuid>。"
          : "Invalid Antigravity conversation id. Use /resume to scan recent conversations or /resume conversation <uuid>.";
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: "antigravity", rejected: "invalid-conversation-id" },
        });
        return true;
      }
      const existing = await findSessionForConversation(sessionStore, normalized);
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
        ...sessionScopeRecordFields(normalized),
        codexSessionId: conversationId,
        status: "idle",
        updatedAt: new Date().toISOString(),
        suspendedPrevious: buildSuspendedPreviousSnapshot({
          existingRecord: existing.record,
          currentResume: cfg.resume,
        }),
      });
      await updateInstanceConfig((c) => { delete c.resume; });

      const msg = locale === "zh"
        ? `已绑定 Antigravity conversation：${conversationId}\n\n发送消息继续对话，完成后发 /detach 断开。`
        : `Attached Antigravity conversation: ${conversationId}\n\nSend a message to continue. Use /detach when done.`;
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { conversationId },
      });
      return true;
    }

    if (cfg.engine === "codex") {
      if (resumeCmd.kind !== "thread") {
        const msg = locale === "zh"
          ? "Codex 请使用 /resume thread <thread-id>。普通 /resume 扫描仅适用于 Claude。"
          : "For Codex, use /resume thread <thread-id>. Plain /resume scan is Claude-only.";
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { rejected: "codex-requires-thread-id" },
        });
        return true;
      }

      try {
        if (!validateCodexThread) {
          throw new Error("codex thread validation unsupported");
        }
        await validateCodexThread(resumeCmd.threadId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const isNotFound = /could not resume thread|thread not found|no rollout found/i.test(detail);
        const isUnsupported = /validation unsupported/i.test(detail);
        const msg = isNotFound
          ? (locale === "zh"
            ? `未找到 Codex thread：${resumeCmd.threadId}\n\n请检查 thread id 后重试。`
            : `Codex thread not found: ${resumeCmd.threadId}\n\nCheck the thread ID and try again.`)
          : isUnsupported
            ? (locale === "zh"
              ? "当前 Codex runtime 无法为 /resume thread 验证外部 thread id。"
              : "This Codex runtime cannot validate external thread IDs for /resume thread.")
            : (locale === "zh"
              ? `验证 Codex thread 失败：${resumeCmd.threadId}`
              : `Could not validate Codex thread: ${resumeCmd.threadId}`);
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { rejected: isNotFound ? "thread-not-found" : "thread-validation-unavailable" },
        });
        return true;
      }

      const existing = await findSessionForConversation(sessionStore, normalized);
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
        ...sessionScopeRecordFields(normalized),
        codexSessionId: resumeCmd.threadId,
        status: "idle",
        updatedAt: new Date().toISOString(),
        suspendedPrevious: buildSuspendedPreviousSnapshot({
          existingRecord: existing.record,
          currentResume: cfg.resume,
        }),
      });
      await updateInstanceConfig((c) => { delete c.resume; });

      const msg = locale === "zh"
        ? `已绑定 Codex thread：${resumeCmd.threadId}\n\n发送消息继续对话，完成后发 /detach 断开。`
        : `Attached Codex thread: ${resumeCmd.threadId}\n\nSend a message to continue. Use /detach when done.`;
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { threadId: resumeCmd.threadId },
      });
      return true;
    }

    if (resumeCmd.kind === "invalid" || resumeCmd.kind === "thread" || resumeCmd.kind === "session" || resumeCmd.kind === "conversation") {
      const msg = locale === "zh"
        ? "用法: /resume [编号]\n先发 /resume 扫描，再发 /resume <编号> 选择。"
        : "Usage: /resume [number]\nSend /resume to scan, then /resume <number> to pick.";
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { rejected: "invalid-arg" },
      });
      return true;
    }

    let resumeAuditText: string | undefined;
    if (resumeCmd.kind === "scan") {
      const sessions = await scanRecentSessions(1);
      if (sessions.length === 0) {
        pendingResumeScans.delete(conversationKey);
        resumeAuditText = locale === "zh"
          ? "最近 1 小时内没有找到本地 session。"
          : "No local sessions found in the last hour.";
        if (sendResumeScanResult) {
          await sendResumeScanResult({
            kind: "claude",
            sessions: [],
            visibleSessions: [],
            locale,
          });
        } else {
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        }
      } else {
        resumeAuditText = formatSessionListMessage(sessions, locale);
        pendingResumeScans.set(conversationKey, {
          kind: "claude",
          scannedAt: Date.now(),
          sessions,
        });
        if (sendResumeScanResult) {
          await sendResumeScanResult({
            kind: "claude",
            sessions,
            visibleSessions: sessions,
            locale,
          });
        } else {
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        }
      }
    } else {
      const cached = getPendingResumeScan(conversationKey, "claude");
      if (!cached || resumeCmd.pick < 1 || resumeCmd.pick > cached.length) {
        resumeAuditText = locale === "zh"
          ? "无效选择，请先发 /resume 扫描。"
          : "Invalid selection. Send /resume first to scan.";
        await context.api.sendMessage(normalized.chatId, resumeAuditText);
      } else {
        const picked = cached[resumeCmd.pick - 1]!;
        pendingResumeScans.delete(conversationKey);

        if (!picked.workspacePath) {
          resumeAuditText = locale === "zh"
            ? `无法解析 session 的工作区路径（${picked.dirName}）。`
            : `Cannot resolve workspace path for session (${picked.dirName}).`;
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        } else {
          const existing = await findSessionForConversation(sessionStore, normalized);
          await sessionStore.upsert({
            telegramChatId: normalized.chatId,
            ...sessionScopeRecordFields(normalized),
            codexSessionId: picked.sessionId,
            status: "idle",
            updatedAt: new Date().toISOString(),
            suspendedPrevious: buildSuspendedPreviousSnapshot({
              existingRecord: existing.record,
              currentResume: cfg.resume,
            }),
          });
          await updateInstanceConfig((c) => {
            c.resume = {
              sessionId: picked.sessionId,
              dirName: picked.dirName,
              workspacePath: picked.workspacePath,
            };
          });

          resumeAuditText = locale === "zh"
            ? `已恢复 session：${picked.displayName}\n工作区：${picked.workspacePath}\n\n发送消息继续对话，完成后发 /detach 断开。`
            : `Resumed session: ${picked.displayName}\nWorkspace: ${picked.workspacePath}\n\nSend a message to continue. Use /detach when done.`;
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        }
      }
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "resume",
      responseText: resumeAuditText,
      metadata: { pick: resumeCmd.kind === "pick" ? resumeCmd.pick : null },
    });
    return true;
  }

  if (isDetachCommand(normalized.text)) {
    const current = await findSessionForConversation(sessionStore, normalized);
    let detachMessage: string;
    if (current.record?.suspendedPrevious) {
      const previous = current.record.suspendedPrevious;
      if (previous.sessionId) {
        await sessionStore.upsert({
          telegramChatId: normalized.chatId,
          ...sessionScopeRecordFields(normalized),
          codexSessionId: previous.sessionId,
          status: "idle",
          updatedAt: new Date().toISOString(),
        });
      } else {
        await removeSessionForConversation(sessionStore, normalized);
      }

      await updateInstanceConfig((c) => {
        if (previous.resume) {
          c.resume = previous.resume;
        } else {
          delete c.resume;
        }
      });

      detachMessage = cfg.engine === "codex"
        ? (locale === "zh"
          ? "已断开当前 Codex thread，并恢复到 /resume 之前的对话。"
          : "Detached from the current Codex thread and restored the previous conversation.")
        : cfg.engine === "antigravity"
          ? (locale === "zh"
            ? "已断开当前 Antigravity conversation，并恢复到 /resume 之前的对话。"
            : "Detached from the current Antigravity conversation and restored the previous conversation.")
          : cfg.engine === "kimi"
            ? (locale === "zh"
              ? "已断开当前 Kimi session，并恢复到 /resume 之前的对话。"
              : "Detached from the current Kimi session and restored the previous conversation.")
            : (locale === "zh"
              ? "已断开恢复的 session，并恢复到 /resume 之前的对话。"
              : "Detached from resumed session and restored the previous conversation.");
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else if (cfg.resume) {
      if (cfg.resume.symlinkPath) {
        try {
          const st = await lstat(cfg.resume.symlinkPath);
          if (st.isSymbolicLink()) await unlink(cfg.resume.symlinkPath);
        } catch {
          // ok
        }
      }

      await removeSessionForConversation(sessionStore, normalized);
      await updateInstanceConfig((c) => { delete c.resume; });

      detachMessage = locale === "zh"
        ? "已断开恢复的 session，回到 bot 默认工作区。"
        : "Detached from resumed session. Back to default workspace.";
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else if (cfg.engine === "codex" || cfg.engine === "antigravity" || cfg.engine === "kimi") {
      const removed = await removeSessionForConversation(sessionStore, normalized);
      if (cfg.engine === "codex") {
        detachMessage = removed
          ? (locale === "zh"
            ? "已断开当前 Codex thread。下一条消息会新建 thread。"
            : "Detached from the current Codex thread. Next message will start a fresh thread.")
          : (locale === "zh"
            ? "当前没有绑定的 Codex thread。"
            : "No active Codex thread.");
      } else if (cfg.engine === "antigravity") {
        detachMessage = removed
          ? (locale === "zh"
            ? "已断开当前 Antigravity conversation。下一条消息会新建 conversation。"
            : "Detached from the current Antigravity conversation. Next message will start a fresh conversation.")
          : (locale === "zh"
            ? "当前没有绑定的 Antigravity conversation。"
            : "No active Antigravity conversation.");
      } else {
        detachMessage = removed
          ? (locale === "zh"
            ? "已断开当前 Kimi session。下一条消息会新建 session。"
            : "Detached from the current Kimi session. Next message will start a fresh session.")
          : (locale === "zh"
            ? "当前没有绑定的 Kimi session。"
            : "No active Kimi session.");
      }
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else {
      detachMessage = locale === "zh"
        ? "当前没有恢复的 session。"
        : "No resumed session active.";
      await context.api.sendMessage(normalized.chatId, detachMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "detach",
      responseText: detachMessage,
    });
    return true;
  }

  return false;
}
