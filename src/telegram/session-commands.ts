import { lstat, unlink } from "node:fs/promises";

import { SessionStateError } from "../runtime/session-manager.js";
import { formatSessionList, scanRecentClaudeSessions, type ScannedSession } from "../runtime/session-scanner.js";
import type { ResumeState } from "./instance-config.js";
import { renderSessionResetMessage, type Locale } from "./message-renderer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

export interface SessionCommandConfig {
  engine: "codex" | "claude";
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
  removeByChatId(chatId: number): Promise<boolean | void>;
  upsert(record: {
    telegramChatId: number;
    codexSessionId: string;
    status: "idle";
    updatedAt: string;
    suspendedPrevious?: {
      sessionId: string | null;
      resume: ResumeState | null;
    };
  }): Promise<void>;
}

const pendingResumeScans = new Map<number, ScannedSession[]>();

function isResetCommand(text: string): boolean {
  return /^\/reset(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

type ResumeCommand =
  | { kind: "scan" }
  | { kind: "pick"; pick: number }
  | { kind: "thread"; threadId: string }
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

function buildSuspendedPreviousSnapshot(input: {
  existingRecord: {
    codexSessionId: string;
    suspendedPrevious?: {
      sessionId: string | null;
      resume: ResumeState | null;
    };
  } | null;
  currentResume: ResumeState | undefined;
}): { sessionId: string | null; resume: ResumeState | null } {
  if (input.existingRecord?.suspendedPrevious) {
    return input.existingRecord.suspendedPrevious;
  }

  return {
    sessionId: input.existingRecord?.codexSessionId ?? null,
    resume: input.currentResume ?? null,
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
  validateCodexThread?: (threadId: string) => Promise<void>;
  scanRecentSessions?: (hours: number) => Promise<ScannedSession[]>;
  formatSessionListMessage?: (sessions: ScannedSession[], locale: Locale) => string;
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
    formatSessionListMessage = formatSessionList,
  } = input;

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

    await sessionStore.removeByChatId(normalized.chatId);

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

      const existing = await sessionStore.findByChatIdSafe(normalized.chatId);
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
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

    if (resumeCmd.kind === "invalid" || resumeCmd.kind === "thread") {
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
        resumeAuditText = locale === "zh"
          ? "最近 1 小时内没有找到本地 session。"
          : "No local sessions found in the last hour.";
        await context.api.sendMessage(normalized.chatId, resumeAuditText);
      } else {
        resumeAuditText = formatSessionListMessage(sessions, locale);
        pendingResumeScans.set(normalized.chatId, sessions);
        await context.api.sendMessage(normalized.chatId, resumeAuditText);
      }
    } else {
      const cached = pendingResumeScans.get(normalized.chatId);
      if (!cached || resumeCmd.pick < 1 || resumeCmd.pick > cached.length) {
        resumeAuditText = locale === "zh"
          ? "无效选择，请先发 /resume 扫描。"
          : "Invalid selection. Send /resume first to scan.";
        await context.api.sendMessage(normalized.chatId, resumeAuditText);
      } else {
        const picked = cached[resumeCmd.pick - 1]!;
        pendingResumeScans.delete(normalized.chatId);

        if (!picked.workspacePath) {
          resumeAuditText = locale === "zh"
            ? `无法解析 session 的工作区路径（${picked.dirName}）。`
            : `Cannot resolve workspace path for session (${picked.dirName}).`;
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        } else {
          const existing = await sessionStore.findByChatIdSafe(normalized.chatId);
          await sessionStore.upsert({
            telegramChatId: normalized.chatId,
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
    const current = await sessionStore.findByChatIdSafe(normalized.chatId);
    let detachMessage: string;
    if (current.record?.suspendedPrevious) {
      const previous = current.record.suspendedPrevious;
      if (previous.sessionId) {
        await sessionStore.upsert({
          telegramChatId: normalized.chatId,
          codexSessionId: previous.sessionId,
          status: "idle",
          updatedAt: new Date().toISOString(),
        });
      } else {
        await sessionStore.removeByChatId(normalized.chatId);
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

      await sessionStore.removeByChatId(normalized.chatId);
      await updateInstanceConfig((c) => { delete c.resume; });

      detachMessage = locale === "zh"
        ? "已断开恢复的 session，回到 bot 默认工作区。"
        : "Detached from resumed session. Back to default workspace.";
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else if (cfg.engine === "codex") {
      const removed = await sessionStore.removeByChatId(normalized.chatId);
      detachMessage = removed
        ? (locale === "zh"
          ? "已断开当前 Codex thread。下一条消息会新建 thread。"
          : "Detached from the current Codex thread. Next message will start a fresh thread.")
        : (locale === "zh"
          ? "当前没有绑定的 Codex thread。"
          : "No active Codex thread.");
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
