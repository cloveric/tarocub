import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Bridge } from "../runtime/bridge.js";
import {
  FileWorkflowPreparationError,
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow,
  type DownloadedAttachment,
} from "../runtime/file-workflow.js";
import {
  applyTelegramOutLimits,
  createTelegramOutDir,
  describeTelegramOutFiles,
} from "../runtime/telegram-out.js";
import { appendAuditEvent } from "../state/audit-log.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { UsageStore } from "../state/usage-store.js";
import { readFile } from "node:fs/promises";
import { SessionStore } from "../state/session-store.js";
import { SessionStateError } from "../runtime/session-manager.js";
import { delegateToInstance } from "../bus/bus-client.js";
import { loadBusConfig } from "../bus/bus-config.js";

type EffortLevel = "low" | "medium" | "high" | "max";

interface InstanceConfig {
  engine: "codex" | "claude";
  locale: "en" | "zh";
  verbosity: 0 | 1 | 2;
  budgetUsd: number | undefined;
  effort: EffortLevel | undefined;
  model: string | undefined;
}

const VALID_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

async function loadInstanceConfig(stateDir: string): Promise<InstanceConfig> {
  try {
    const raw = await readFile(path.join(stateDir, "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      engine?: string;
      locale?: string;
      verbosity?: number;
      budgetUsd?: number;
      effort?: string;
      model?: string;
    };
    const effort = VALID_EFFORT_LEVELS.includes(config.effort as EffortLevel) ? config.effort as EffortLevel : undefined;
    return {
      engine: config.engine === "claude" ? "claude" : "codex",
      locale: config.locale === "zh" ? "zh" : "en",
      verbosity: config.verbosity === 0 ? 0 : config.verbosity === 2 ? 2 : 1,
      budgetUsd: typeof config.budgetUsd === "number" && config.budgetUsd > 0 ? config.budgetUsd : undefined,
      effort,
      model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
    };
  } catch {
    return { engine: "codex", locale: "en", verbosity: 1, budgetUsd: undefined, effort: undefined, model: undefined };
  }
}

async function updateInstanceConfig(stateDir: string, updater: (config: Record<string, unknown>) => void): Promise<void> {
  const configPath = path.join(stateDir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch { /* start fresh */ }
  updater(config);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function appendAuditEventBestEffort(stateDir: string, event: Parameters<typeof appendAuditEvent>[1]): Promise<void> {
  try {
    await appendAuditEvent(stateDir, event);
  } catch (error) {
    console.error("Failed to persist audit event:", error instanceof Error ? error.message : error);
  }
}

async function updateWorkflowBestEffort(
  workflowStore: FileWorkflowStore,
  workflowRecordId: string,
  mutate: Parameters<FileWorkflowStore["update"]>[1],
): Promise<void> {
  try {
    await workflowStore.update(workflowRecordId, mutate);
  } catch {
    // Visible Telegram delivery already succeeded; workflow persistence is bookkeeping-only now.
  }
}

import {
  chunkTelegramMessage,
  renderCategorizedErrorMessage,
  renderErrorMessage,
  renderTelegramHelpMessage,
  renderTelegramStatusMessage,
  renderUnauthorizedMessage,
  renderSessionStateErrorMessage,
  renderSessionResetMessage,
} from "./message-renderer.js";
import { TelegramApi } from "./api.js";
import type { NormalizedTelegramAttachment, NormalizedTelegramMessage } from "./update-normalizer.js";

export interface TelegramDeliveryContext {
  api: TelegramApi;
  bridge: Bridge;
  inboxDir: string;
  instanceName?: string;
  updateId?: number;
  abortSignal?: AbortSignal;
  onAuthRetry?: () => Promise<void>;
  _authRetried?: boolean;
}

function wantsTelegramOut(text: string): boolean {
  return /(发.*文件|传.*文件|发送.*文件|导出.*文件|文件.*传|文件.*发|生成.*文件|generate.*file|send.*file|export.*file)/i.test(text);
}

function isResetCommand(text: string): boolean {
  return /^\/reset(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isCompactCommand(text: string): boolean {
  return /^\/compact(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(text.trim());
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

function parseBtwCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/btw(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseAskCommand(text: string): { targetInstance: string; prompt: string } | null {
  const match = text.trim().match(/^\/ask(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }
  return { targetInstance: match[1]!, prompt: match[2]!.trim() };
}

function parseFanCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/fan(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseVerifyCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/verify(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function isBlockingWorkflowStatus(status: "preparing" | "processing" | "awaiting_continue" | "completed" | "failed"): boolean {
  return status === "preparing" || status === "processing" || status === "failed";
}

function shouldUseNonRepairableResetSessionGuidance(
  error: unknown,
  failureCategory: ReturnType<typeof classifyFailure>,
  originalText: string,
): boolean {
  if (!isResetCommand(originalText)) {
    return false;
  }

  if (error instanceof SessionStateError) {
    return !error.repairable;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((((error as NodeJS.ErrnoException).code === "EACCES") || (error as NodeJS.ErrnoException).code === "EPERM"))
  ) {
    return true;
  }

  if (failureCategory === "session-state") {
    return true;
  }

  const errorText =
    error instanceof Error
      ? `${error.name}\n${error.message}`.toLowerCase()
      : String(error).toLowerCase();

  return (
    errorText.includes("session state") ||
    errorText.includes("session-store") ||
    errorText.includes("session store") ||
    errorText.includes("session binding")
  );
}

function inferExtension(attachment: NormalizedTelegramAttachment, telegramFilePath: string): string {
  const explicitExtension = attachment.fileName ? path.extname(attachment.fileName) : "";
  if (explicitExtension) {
    return explicitExtension;
  }

  const filePathExtension = path.extname(telegramFilePath);
  if (filePathExtension) {
    return filePathExtension;
  }

  if (attachment.kind === "photo") {
    return ".jpg";
  }

  if (attachment.kind === "voice") {
    return ".ogg";
  }

  return "";
}

function buildInboxFileName(attachment: NormalizedTelegramAttachment, telegramFilePath: string): string {
  const extension = inferExtension(attachment, telegramFilePath);
  const explicitBaseName = attachment.fileName ? path.basename(attachment.fileName, path.extname(attachment.fileName)) : "";
  const safeBaseName = explicitBaseName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (safeBaseName) {
    return `${attachment.fileId}-${safeBaseName}${extension}`;
  }

  return `${attachment.fileId}${extension}`;
}

function buildContinueAnalysisKeyboard(uploadId: string) {
  return {
    inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${uploadId}` }]],
  };
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

const ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
const ASR_CLI_PYTHON = path.join(process.env.HOME ?? "/", "projects/qwen3-asr/venv/bin/python3");
const ASR_CLI_SCRIPT = path.join(process.env.HOME ?? "/", "projects/qwen3-asr/transcribe.py");

async function transcribeVoice(audioPath: string): Promise<string> {
  try {
    const response = await fetch(ASR_HTTP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: audioPath }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const text = await response.text();
      if (text.trim()) return text.trim();
    }
  } catch {
    // HTTP server not running — fall back to CLI
  }

  return new Promise<string>((resolve, reject) => {
    execFile(ASR_CLI_PYTHON, [ASR_CLI_SCRIPT, audioPath], { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function downloadAttachments(
  api: TelegramApi,
  inboxDir: string,
  attachments: NormalizedTelegramAttachment[],
): Promise<DownloadedAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  await ensureInboxDirExists(inboxDir);
  const downloadedFiles: DownloadedAttachment[] = [];

  for (const attachment of attachments) {
    const telegramFile = await api.getFile(attachment.fileId);
    const destinationPath = path.join(inboxDir, buildInboxFileName(attachment, telegramFile.file_path));
    await api.downloadFile(telegramFile.file_path, destinationPath);
    downloadedFiles.push({
      attachment,
      localPath: destinationPath,
    });
  }

  return downloadedFiles;
}

async function sendMessageWithMarkdown(api: TelegramApi, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parseMode: "Markdown" });
  } catch {
    await api.sendMessage(chatId, text);
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

const IMAGE_SIZE_THRESHOLD = 2 * 1024 * 1024; // 2MB

async function sendFileOrPhoto(api: TelegramApi, chatId: number, filename: string, contents: Uint8Array | string): Promise<void> {
  const payload = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  // Large images (>2MB): use sendPhoto for Telegram-side compression (~500KB)
  // Small images (<2MB): use sendDocument to preserve original quality
  if (isImageFile(filename) && payload.length > IMAGE_SIZE_THRESHOLD) {
    try {
      await api.sendPhoto(chatId, filename, payload);
      return;
    } catch {
      // Fall back to sendDocument if sendPhoto fails
    }
  }
  await api.sendDocument(chatId, filename, contents);
}

async function deliverTelegramResponse(
  api: TelegramApi,
  chatId: number,
  text: string,
  inboxDir: string,
): Promise<void> {
  // Handle inline text file blocks
  const fileMatch = text.match(/```file:([^\n]+)\n([\s\S]*?)```/);
  if (fileMatch) {
    const [, fileName, fileBody] = fileMatch;
    await sendFileOrPhoto(api, chatId, fileName.trim(), fileBody);
    return;
  }

  // Extract file references from multiple formats:
  // 1. [send-file:/path]           — explicit bridge tag
  // 2. ![alt](/absolute/path.png)  — Markdown image
  // 3. [name](/absolute/path.ext)  — Markdown link to local file
  const filePatterns = [
    /\[send-file:([^\]]+)\]/g,
    /!\[[^\]]*\]\(((?:\/|[A-Za-z]:[\\/])[^)]+)\)/g,
    /(?<!!)\[[^\]]*\]\(((?:\/|[A-Za-z]:[\\/])[^)]+\.(?:png|jpg|jpeg|gif|webp|bmp|pdf|zip|tar|gz|svg))\)/gi,
  ];
  const filePaths: string[] = [];
  let cleanedText = text;
  for (const pattern of filePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const p = match[1]!.trim();
      if ((p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) && !filePaths.includes(p)) {
        filePaths.push(p);
      }
    }
  }
  if (filePaths.length > 0) {
    for (const pattern of filePatterns) {
      cleanedText = cleanedText.replace(pattern, "");
    }
    cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
  }

  // Send text response (if any remains after stripping file tags)
  if (cleanedText) {
    const chunks = chunkTelegramMessage(cleanedText);
    for (const chunk of chunks) {
      await sendMessageWithMarkdown(api, chatId, chunk);
    }
  }

  // Collect referenced files from disk
  const imageFiles: Array<{ filename: string; contents: Uint8Array }> = [];
  const otherFiles: Array<{ filename: string; contents: Uint8Array | string }> = [];

  const deliveryStateDir = path.dirname(inboxDir);
  const workspacePrefix = path.join(deliveryStateDir, "workspace") + path.sep;

  for (const filePath of filePaths) {
    try {
      const { realpath, lstat } = await import("node:fs/promises");
      const real = await realpath(filePath);
      if (!real.startsWith(workspacePrefix)) {
        continue;
      }
      const stats = await lstat(real);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 50_000_000) {
        continue;
      }
      const contents = await readFile(real);
      const fileName = path.basename(filePath);
      if (isImageFile(fileName)) {
        imageFiles.push({ filename: fileName, contents });
      } else {
        otherFiles.push({ filename: fileName, contents });
      }
    } catch {
      // File not found or unreadable — skip silently
    }
  }

  // Send all files (images + others) as documents to preserve original quality
  for (const file of [...imageFiles, ...otherFiles]) {
    await sendFileOrPhoto(api, chatId, file.filename, file.contents);
  }
}

export async function handleNormalizedTelegramMessage(
  normalized: NormalizedTelegramMessage,
  context: TelegramDeliveryContext,
): Promise<void> {
  const startedAt = Date.now();
  let responded = false;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let workflowRecordId: string | undefined;
  let archiveSummaryDelivered = false;
  let telegramOutDirPath: string | undefined;
  let failureHint: string | undefined;
  const stateDir = path.dirname(context.inboxDir);
  const workflowStore = new FileWorkflowStore(stateDir);
  const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
  const cfg = await loadInstanceConfig(stateDir);
  const locale = cfg.locale;

  const startTyping = () => {
    context.api.sendChatAction(normalized.chatId).catch(() => {});
    typingInterval = setInterval(() => {
      context.api.sendChatAction(normalized.chatId).catch(() => {});
    }, 4000);
  };
  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  };

  try {
    if (normalized.callbackQueryId) {
      try {
        await context.api.answerCallbackQuery(normalized.callbackQueryId);
      } catch {
        // Callback acks are advisory; continuation should still proceed.
      }
    }
    startTyping();

    const accessDecision = await context.bridge.checkAccess({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
    });

    if (accessDecision.kind === "reply" || accessDecision.kind === "deny") {
      stopTyping();
      await context.api.sendMessage(
        normalized.chatId,
        accessDecision.text ?? renderErrorMessage(renderUnauthorizedMessage(locale), locale),
      );
      await appendAuditEvent(path.dirname(context.inboxDir), {
        type: "update.reply",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "reply",
        detail: accessDecision.text,
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
        },
        });
      return;
    }

    if (isResetCommand(normalized.text)) {
      stopTyping();
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
      const resetMessage = renderSessionResetMessage(false, locale);
      await context.api.sendMessage(normalized.chatId, resetMessage);
      responded = true;
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: resetMessage.length,
          chunkCount: chunkTelegramMessage(resetMessage).length,
        },
      });
      return;
    }

    if (isCompactCommand(normalized.text)) {
      stopTyping();
      await context.api.sendMessage(normalized.chatId,
        locale === "zh" ? "正在压缩会话上下文..." : "Compacting session context...");

      try {
        const result = await context.bridge.handleAuthorizedMessage({
          chatId: normalized.chatId,
          userId: normalized.userId,
          chatType: normalized.chatType,
          locale,
          text: "/compact",
          files: [],
        });

        const compactMsg = locale === "zh"
          ? `上下文已压缩。\n\n${result.text}`
          : `Context compacted.\n\n${result.text}`;
        const chunks = chunkTelegramMessage(compactMsg);
        await context.api.sendMessage(normalized.chatId, chunks[0]!);
        responded = true;
        for (const chunk of chunks.slice(1)) {
          await context.api.sendMessage(normalized.chatId, chunk);
        }
      } catch {
        await sessionStore.removeByChatId(normalized.chatId);
        const fallbackMsg = locale === "zh"
          ? "引擎不支持 compact，已重置会话（效果相同）。"
          : "Engine does not support compact. Session reset instead (same effect).";
        await context.api.sendMessage(normalized.chatId, fallbackMsg);
        responded = true;
      }

      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: { durationMs: Date.now() - startedAt },
      });
      return;
    }

    if (isHelpCommand(normalized.text)) {
      stopTyping();
      const helpMessage = renderTelegramHelpMessage(locale);
      await context.api.sendMessage(normalized.chatId, helpMessage);
      responded = true;
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: helpMessage.length,
          chunkCount: chunkTelegramMessage(helpMessage).length,
        },
      });
      return;
    }

    if (isStatusCommand(normalized.text)) {
      stopTyping();
      const sessionResult = await sessionStore.findByChatIdSafe(normalized.chatId);
      const workflowResult = await workflowStore.inspect();
      const chatRecords = workflowResult.warning
        ? []
        : workflowResult.state.records.filter((record) => record.chatId === normalized.chatId);
      const blockingTasks = workflowResult.warning
        ? null
        : chatRecords.filter((record) => isBlockingWorkflowStatus(record.status)).length;
      const waitingTasks = workflowResult.warning
        ? null
        : chatRecords.filter((record) => record.status === "awaiting_continue").length;
      const statusMessage = renderTelegramStatusMessage({
        engine: cfg.engine,
        sessionBound: sessionResult.warning ? null : sessionResult.record !== null,
        blockingTasks,
        waitingTasks,
        sessionWarning: sessionResult.warning,
        taskStateWarning: workflowResult.warning,
      }, locale);
      await context.api.sendMessage(normalized.chatId, statusMessage);
      responded = true;
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: statusMessage.length,
          chunkCount: chunkTelegramMessage(statusMessage).length,
        },
      });
      return;
    }

    const effortCmd = parseEffortCommand(normalized.text);
    if (effortCmd) {
      stopTyping();
      if (!effortCmd.level) {
        const current = cfg.effort ?? "default";
        const msg = locale === "zh" ? `当前 effort: ${current}` : `Current effort: ${current}`;
        await context.api.sendMessage(normalized.chatId, msg);
      } else if (VALID_EFFORT_LEVELS.includes(effortCmd.level as EffortLevel)) {
        await updateInstanceConfig(stateDir, (c) => { c.effort = effortCmd.level; });
        const msg = locale === "zh" ? `Effort 已设为 ${effortCmd.level}。` : `Effort set to ${effortCmd.level}.`;
        await context.api.sendMessage(normalized.chatId, msg);
      } else if (effortCmd.level === "off" || effortCmd.level === "default") {
        await updateInstanceConfig(stateDir, (c) => { delete c.effort; });
        const msg = locale === "zh" ? "Effort 已恢复默认。" : "Effort reset to default.";
        await context.api.sendMessage(normalized.chatId, msg);
      } else {
        const msg = locale === "zh"
          ? "用法: /effort [low|medium|high|max|off]"
          : "Usage: /effort [low|medium|high|max|off]";
        await context.api.sendMessage(normalized.chatId, msg);
      }
      responded = true;
      await appendAuditEventBestEffort(stateDir, {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: { durationMs: Date.now() - startedAt, command: "effort", value: effortCmd.level || "query" },
      });
      return;
    }

    const modelCmd = parseModelCommand(normalized.text);
    if (modelCmd) {
      stopTyping();
      if (!modelCmd.model) {
        const current = cfg.model ?? "default";
        const msg = locale === "zh" ? `当前模型: ${current}` : `Current model: ${current}`;
        await context.api.sendMessage(normalized.chatId, msg);
      } else if (modelCmd.model === "off" || modelCmd.model === "default") {
        await updateInstanceConfig(stateDir, (c) => { delete c.model; });
        const msg = locale === "zh" ? "模型已恢复默认。" : "Model reset to default.";
        await context.api.sendMessage(normalized.chatId, msg);
      } else {
        await updateInstanceConfig(stateDir, (c) => { c.model = modelCmd.model; });
        const msg = locale === "zh" ? `模型已设为 ${modelCmd.model}。` : `Model set to ${modelCmd.model}.`;
        await context.api.sendMessage(normalized.chatId, msg);
      }
      responded = true;
      await appendAuditEventBestEffort(stateDir, {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: { durationMs: Date.now() - startedAt, command: "model", value: modelCmd.model || "query" },
      });
      return;
    }

    const btwCmd = parseBtwCommand(normalized.text);
    if (btwCmd) {
      // Keep typing running — engine execution follows
      try {
        const btwChatId = -(2_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
        const result = await context.bridge.handleAuthorizedMessage({
          chatId: btwChatId,
          userId: normalized.userId,
          chatType: "bus",
          locale,
          text: btwCmd.prompt,
          files: [],
        });
        const chunks = chunkTelegramMessage(result.text);
        await context.api.sendMessage(normalized.chatId, chunks[0]!);
        responded = true;
        for (const chunk of chunks.slice(1)) {
          await context.api.sendMessage(normalized.chatId, chunk);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const msg = locale === "zh" ? `旁问失败：${detail}` : `Side question failed: ${detail}`;
        await context.api.sendMessage(normalized.chatId, msg);
        responded = true;
      }
      stopTyping();
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: { durationMs: Date.now() - startedAt },
      });
      return;
    }

    const askCommand = parseAskCommand(normalized.text);
    if (askCommand) {
      stopTyping();
      const currentInstance = context.instanceName ?? "default";
      if (askCommand.targetInstance === currentInstance) {
        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? "不能委托给自己。" : "Cannot delegate to yourself.");
        responded = true;
        return;
      }

      const askLabel = locale === "zh"
        ? `正在转发给 ${askCommand.targetInstance}...`
        : `Delegating to ${askCommand.targetInstance}...`;
      await context.api.sendMessage(normalized.chatId, askLabel);

      try {
        const result = await delegateToInstance({
          fromInstance: currentInstance,
          targetInstance: askCommand.targetInstance,
          prompt: askCommand.prompt,
          depth: 0,
          stateDir,
        });

        const askResponse = locale === "zh"
          ? `[来自 ${askCommand.targetInstance}]\n\n${result.text}`
          : `[From ${askCommand.targetInstance}]\n\n${result.text}`;
        const chunks = chunkTelegramMessage(askResponse);
        await context.api.sendMessage(normalized.chatId, chunks[0]!);
        responded = true;
        for (const chunk of chunks.slice(1)) {
          await context.api.sendMessage(normalized.chatId, chunk);
        }

        await appendAuditEventBestEffort(stateDir, {
          type: "update.handle",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          outcome: "success",
          metadata: {
            durationMs: Date.now() - startedAt,
            delegatedTo: askCommand.targetInstance,
            responseChars: askResponse.length,
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const errorMsg = locale === "zh"
          ? `委托给 ${askCommand.targetInstance} 失败：${detail}`
          : `Delegation to ${askCommand.targetInstance} failed: ${detail}`;
        await context.api.sendMessage(normalized.chatId, errorMsg);
        responded = true;
        await appendAuditEventBestEffort(stateDir, {
          type: "update.handle",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          outcome: "error",
          detail,
          metadata: { durationMs: Date.now() - startedAt, delegatedTo: askCommand.targetInstance },
        });
      }
      return;
    }

    const fanCommand = parseFanCommand(normalized.text);
    if (fanCommand) {
      stopTyping();
      const busConfig = await loadBusConfig(stateDir);
      const targets = busConfig?.parallel ?? [];
      if (targets.length === 0) {
        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? "未配置 parallel bot。在 config.json 的 bus.parallel 中添加实例名。" : "No parallel bots configured. Add instance names to bus.parallel in config.json.");
        responded = true;
        return;
      }

      const currentInstance = context.instanceName ?? "default";
      await context.api.sendMessage(normalized.chatId,
        locale === "zh" ? `正在并行查询 ${targets.length + 1} 个 bot...` : `Querying ${targets.length + 1} bots in parallel...`);

      let fanOutcome: "success" | "error" = "success";
      try {
        const selfPromise = context.bridge.handleAuthorizedMessage({
          chatId: normalized.chatId,
          userId: normalized.userId,
          chatType: normalized.chatType,
          locale,
          text: fanCommand.prompt,
          files: [],
        })
          .then((r) => ({ name: currentInstance, text: r.text, error: null as string | null }))
          .catch((e) => ({ name: currentInstance, text: "", error: e instanceof Error ? e.message : String(e) }));

        const peerPromises = targets.map((target) =>
          delegateToInstance({ fromInstance: currentInstance, targetInstance: target, prompt: fanCommand.prompt, depth: 0, stateDir })
            .then((r) => ({ name: target, text: r.text, error: null as string | null }))
            .catch((e) => ({ name: target, text: "", error: e instanceof Error ? e.message : String(e) })),
        );

        const results = await Promise.all([selfPromise, ...peerPromises]);
        const sections: string[] = [];
        for (const r of results) {
          sections.push(r.error
            ? `[${r.name}] Error: ${r.error}`
            : `[${r.name}]\n${r.text}`);
        }

        const fanResponse = sections.join("\n\n---\n\n");
        const chunks = chunkTelegramMessage(fanResponse);
        await context.api.sendMessage(normalized.chatId, chunks[0]!);
        responded = true;
        for (const chunk of chunks.slice(1)) {
          await context.api.sendMessage(normalized.chatId, chunk);
        }
      } catch (error) {
        fanOutcome = "error";
        const detail = error instanceof Error ? error.message : String(error);
        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? `并行执行失败：${detail}` : `Parallel execution failed: ${detail}`);
        responded = true;
      }

      await appendAuditEventBestEffort(stateDir, {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: fanOutcome,
        metadata: { durationMs: Date.now() - startedAt, fanTargets: targets },
      });
      return;
    }

    const verifyCommand = parseVerifyCommand(normalized.text);
    if (verifyCommand) {
      stopTyping();
      const busConfig = await loadBusConfig(stateDir);
      const verifier = busConfig?.verifier;
      if (!verifier) {
        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? "未配置验证 bot。在 config.json 的 bus.verifier 中设置实例名。" : "No verifier configured. Set bus.verifier in config.json.");
        responded = true;
        return;
      }

      const currentInstance = context.instanceName ?? "default";
      if (verifier === currentInstance) {
        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? "验证 bot 不能是自己。" : "Verifier cannot be the same instance.");
        responded = true;
        return;
      }

      await context.api.sendMessage(normalized.chatId,
        locale === "zh" ? "正在执行..." : "Executing...");

      let verifyOutcome: "success" | "error" = "success";
      try {
        const result = await context.bridge.handleAuthorizedMessage({
          chatId: normalized.chatId,
          userId: normalized.userId,
          chatType: normalized.chatType,
          locale,
          text: verifyCommand.prompt,
          files: [],
        });

        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? `正在让 ${verifier} 验证...` : `Sending to ${verifier} for verification...`);

        const verifyResult = await delegateToInstance({
          fromInstance: currentInstance,
          targetInstance: verifier,
          prompt: locale === "zh"
            ? `请验证以下回复的正确性和质量：\n\n原始问题：${verifyCommand.prompt}\n\n回复：${result.text}`
            : `Please verify the correctness and quality of this response:\n\nOriginal question: ${verifyCommand.prompt}\n\nResponse: ${result.text}`,
          depth: 0,
          stateDir,
        });

        const verifyResponse = [
          locale === "zh" ? `[${currentInstance} 的回复]` : `[Response from ${currentInstance}]`,
          result.text,
          "",
          "---",
          "",
          locale === "zh" ? `[${verifier} 的验证]` : `[Verification by ${verifier}]`,
          verifyResult.text,
        ].join("\n");

        const chunks = chunkTelegramMessage(verifyResponse);
        await context.api.sendMessage(normalized.chatId, chunks[0]!);
        responded = true;
        for (const chunk of chunks.slice(1)) {
          await context.api.sendMessage(normalized.chatId, chunk);
        }
      } catch (error) {
        verifyOutcome = "error";
        const detail = error instanceof Error ? error.message : String(error);
        await context.api.sendMessage(normalized.chatId,
          locale === "zh" ? `验证流程失败：${detail}` : `Verification failed: ${detail}`);
        responded = true;
      }

      await appendAuditEventBestEffort(stateDir, {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: verifyOutcome,
        metadata: { durationMs: Date.now() - startedAt, verifier },
      });
      return;
    }

    const allDownloaded = await downloadAttachments(context.api, context.inboxDir, normalized.attachments);

    const voiceDownloads = allDownloaded.filter((d) => d.attachment.kind === "voice");
    const downloadedAttachments = allDownloaded.filter((d) => d.attachment.kind !== "voice");

    if (voiceDownloads.length > 0) {
      for (const voice of voiceDownloads) {
        try {
          const transcript = await transcribeVoice(voice.localPath);
          if (transcript) {
            normalized.text = normalized.text ? `${normalized.text}\n${transcript}` : transcript;
          }
        } catch {
          const fallbackMsg = locale === "zh" ? "语音转写失败，请发送文字消息。" : "Voice transcription failed. Please send a text message.";
          await context.api.sendMessage(normalized.chatId, fallbackMsg);
          responded = true;
          return;
        }
      }
    }

    const workflowResult =
      downloadedAttachments.length > 0
        ? await prepareAttachmentWorkflow({
            stateDir,
            chatId: normalized.chatId,
            userId: normalized.userId,
            text: normalized.text,
            downloadedAttachments,
          })
        : await prepareArchiveContinueWorkflow({
            stateDir,
            chatId: normalized.chatId,
            text: normalized.text,
            replyContext: normalized.replyContext,
          });
    failureHint = workflowResult?.failureHint;

    const engine = cfg.engine;
    if (engine === "codex" && wantsTelegramOut(normalized.text)) {
      telegramOutDirPath = (await createTelegramOutDir(stateDir, `${Date.now()}-${normalized.chatId}`)).dirPath;
    }

    if (workflowResult?.kind === "reply") {
      stopTyping();
      workflowRecordId = workflowResult.workflowRecordId;
      const deliveryText = workflowRecordId ? boundArchiveSummaryForTelegram(workflowResult.text) : workflowResult.text;
      const summaryMsg = await context.api.sendMessage(
        normalized.chatId,
        deliveryText,
        downloadedAttachments.length > 0 && workflowResult.workflowRecordId
          ? buildContinueAnalysisKeyboard(workflowResult.workflowRecordId)
          : undefined,
      );
      if (downloadedAttachments.length > 0 && workflowResult.workflowRecordId) {
        await workflowStore.update(workflowResult.workflowRecordId, (record) => {
          record.summaryMessageId = summaryMsg.message_id;
        });
      }
      if (workflowRecordId) {
        archiveSummaryDelivered = true;
        responded = true;
      }
      await appendAuditEventBestEffort(stateDir, {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: deliveryText.length,
          chunkCount: chunkTelegramMessage(deliveryText).length,
        },
      });
      return;
    }

    workflowRecordId = workflowResult?.workflowRecordId;
    const requestText = workflowResult?.kind === "direct" ? workflowResult.text : normalized.text;
    const requestFiles = workflowResult?.kind === "direct"
      ? workflowResult.files
      : downloadedAttachments.map((attachment) => attachment.localPath);

    // Typing indicator is already running from startTyping()

    if (cfg.budgetUsd !== undefined) {
      const usageStore = new UsageStore(stateDir);
      const usage = await usageStore.load();
      if (usage.totalCostUsd >= cfg.budgetUsd) {
        const budgetMsg = locale === "zh"
          ? `预算已用尽：$${usage.totalCostUsd.toFixed(4)} / $${cfg.budgetUsd.toFixed(2)}。使用 \`telegram budget set <usd>\` 提高预算或 \`telegram budget clear\` 清除。`
          : `Budget exhausted: $${usage.totalCostUsd.toFixed(4)} used of $${cfg.budgetUsd.toFixed(2)}. Raise the budget with \`telegram budget set <usd>\` or clear it with \`telegram budget clear\`.`;
        stopTyping();
        await context.api.sendMessage(normalized.chatId, budgetMsg);
        responded = true;
        await appendAuditEventBestEffort(stateDir, {
          type: "update.reply",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          outcome: "reply",
          detail: "budget exhausted",
        });
        return;
      }
    }

    const replyContext =
      workflowResult?.kind === "direct" &&
      (workflowResult.suppressReplyContext || workflowResult.text.includes("[Archive Analysis Context]"))
        ? undefined
        : normalized.replyContext;

    if (replyContext) {
      const quotedFileId = replyContext.photoFileId ?? replyContext.documentFileId;
      if (quotedFileId) {
        try {
          await ensureInboxDirExists(context.inboxDir);
          const telegramFile = await context.api.getFile(quotedFileId);
          const ext = replyContext.photoFileId
            ? ".jpg"
            : (replyContext.documentFileName ? path.extname(replyContext.documentFileName) : path.extname(telegramFile.file_path)) || "";
          const localPath = path.join(context.inboxDir, `quoted-${replyContext.messageId}${ext}`);
          await context.api.downloadFile(telegramFile.file_path, localPath);
          requestFiles.push(localPath);
        } catch {
          // Quoted attachment download is best-effort; continue without it
        }
      }
    }

    const result = await context.bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
      text: requestText,
      replyContext,
      files: requestFiles,
      requestOutputDir: telegramOutDirPath,
      abortSignal: context.abortSignal,
    });

    stopTyping();

    if (result.usage) {
      const usageStore = new UsageStore(stateDir);
      await usageStore.record({
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedTokens: result.usage.cachedTokens,
        costUsd: result.usage.costUsd,
      });

      if (cfg.budgetUsd !== undefined) {
        const postUsage = await usageStore.load();
        if (postUsage.totalCostUsd >= cfg.budgetUsd) {
          await appendAuditEventBestEffort(stateDir, {
            type: "update.reply",
            instanceName: context.instanceName,
            chatId: normalized.chatId,
            userId: normalized.userId,
            updateId: context.updateId,
            outcome: "reply",
            detail: `budget threshold reached: $${postUsage.totalCostUsd.toFixed(4)} / $${cfg.budgetUsd.toFixed(2)}`,
          });
        }
      }
    }

    await deliverTelegramResponse(context.api, normalized.chatId, result.text, context.inboxDir);
    responded = true;

    if (telegramOutDirPath) {
      const describedFiles = await describeTelegramOutFiles(telegramOutDirPath);
      const limitedFiles = applyTelegramOutLimits(describedFiles, {
        maxFiles: 5,
        maxFileBytes: 512_000,
        maxTotalBytes: 1_500_000,
      });

      for (const file of limitedFiles.accepted) {
        const contents = await readFile(file.path);
        await sendFileOrPhoto(context.api, normalized.chatId, file.name, contents);
      }
    }

    if (workflowRecordId) {
      await updateWorkflowBestEffort(workflowStore, workflowRecordId, (record) => {
        record.status = "completed";
      });
    }

    await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
      type: "update.handle",
      instanceName: context.instanceName,
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        attachments: normalized.attachments.length,
        responseChars: result.text.length,
        chunkCount: chunkTelegramMessage(result.text).length,
      },
    });
  } catch (error) {
    if (workflowRecordId === undefined && error instanceof FileWorkflowPreparationError) {
      workflowRecordId = error.workflowRecordId;
    }

    const classifiedError = error instanceof FileWorkflowPreparationError ? error.cause : error;
    const message = classifiedError instanceof Error ? classifiedError.message : String(classifiedError);
    const failureCategory = classifyFailure(classifiedError);

    // If user sent /stop, don't send an error message — /stop handler already notified them
    if (context.abortSignal?.aborted) {
      stopTyping();
      return;
    }

    if (failureCategory === "auth" && context.onAuthRetry && !context._authRetried) {
      try {
        await context.onAuthRetry();
        context._authRetried = true;
        return await handleNormalizedTelegramMessage(normalized, context);
      } catch {
        // Retry failed — fall through to normal error handling
      }
    }

    const errorMessage = shouldUseNonRepairableResetSessionGuidance(classifiedError, failureCategory, normalized.text)
      ? renderSessionStateErrorMessage(false, locale)
      : classifiedError instanceof SessionStateError
      ? renderSessionStateErrorMessage(classifiedError.repairable, locale)
      : failureHint
      ? `${renderCategorizedErrorMessage(failureCategory, message, locale)}\n${failureHint}`
      : renderCategorizedErrorMessage(failureCategory, message, locale);
    let workflowCleanupError: unknown;
    stopTyping();

    if (workflowRecordId) {
      try {
        if (!archiveSummaryDelivered) {
          await workflowStore.update(workflowRecordId, (record) => {
            if (
              record.status === "preparing" ||
              record.status === "processing" ||
              record.status === "awaiting_continue"
            ) {
              record.status = "failed";
            }
          });
        }
      } catch (cleanupError) {
        workflowCleanupError = cleanupError;
      }
    }

    if (!archiveSummaryDelivered) {
      await context.api.sendMessage(normalized.chatId, errorMessage);
    }

    await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
      type: "update.handle",
      instanceName: context.instanceName,
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      outcome: "error",
      detail: message,
      metadata: {
        durationMs: Date.now() - startedAt,
        attachments: normalized.attachments.length,
        failureCategory,
        workflowCleanupError:
          workflowCleanupError === undefined
            ? undefined
            : workflowCleanupError instanceof Error
              ? workflowCleanupError.message
              : String(workflowCleanupError),
      },
    });

  }
}
