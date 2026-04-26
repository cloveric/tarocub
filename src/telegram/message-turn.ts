import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  applyTelegramOutLimits as defaultApplyTelegramOutLimits,
  createTelegramOutDir as defaultCreateTelegramOutDir,
  describeTelegramOutFiles as defaultDescribeTelegramOutFiles,
  pruneStaleCctbSendDirs as defaultPruneStaleCctbSendDirs,
  resolveCctbSendDir,
} from "../runtime/telegram-out.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import {
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow as defaultPrepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow as defaultPrepareAttachmentWorkflow,
  type DownloadedAttachment,
  type FileWorkflowResult,
} from "../runtime/file-workflow.js";
import type { FileWorkflowStore } from "../state/file-workflow-store.js";
import { appendUpdateHandleAuditEventBestEffort, maybeReplyWithBudgetExhausted, recordTurnUsageAndBudgetAudit } from "./turn-bookkeeping.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import type { InlineKeyboardButton, TelegramApi } from "./api.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";
import type { EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import {
  createSideChannelSendHelper as defaultCreateSideChannelSendHelper,
  startSideChannelSendServer as defaultStartSideChannelSendServer,
  type SideChannelSendServer,
} from "./side-channel-send.js";

export interface WorkflowAwareTurnState {
  workflowRecordId?: string;
  archiveSummaryDelivered: boolean;
  failureHint?: string;
  telegramOutDirPath?: string;
}

export interface WorkflowAwareTurnConfig {
  engine: "codex" | "claude";
  budgetUsd?: number;
  resume?: {
    workspacePath: string;
  };
}

export interface WorkflowAwareTurnContext {
  api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto" | "getFile" | "downloadFile">;
  bridge: {
    supportsTurnScopedEnv?: boolean;
    handleAuthorizedMessage(input: {
      chatId: number;
      userId: number;
      chatType: string;
      locale: Locale;
      text: string;
      replyContext?: NormalizedTelegramMessage["replyContext"];
      files: string[];
      onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
      onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      requestOutputDir?: string;
      workspaceOverride?: string;
      sideChannelCommand?: string;
      extraEnv?: Record<string, string>;
      abortSignal?: AbortSignal;
    }): Promise<{
      text: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens?: number;
        costUsd?: number;
      };
    }>;
  };
  inboxDir: string;
  abortSignal?: AbortSignal;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  instanceName?: string;
  updateId?: number;
}

function defaultBuildContinueAnalysisKeyboard(uploadId: string): { inlineKeyboard: InlineKeyboardButton[][] } {
  return {
    inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${uploadId}` }]],
  };
}

function stripAlreadySentSideChannelTags(text: string, sentFilePaths: readonly string[]): string {
  if (sentFilePaths.length === 0) {
    return text;
  }
  const sent = new Set(sentFilePaths);
  return text
    .split(/\r?\n/)
    .map((line) => ({
      original: line,
      stripped: line.replace(/\[send-file:([^\]]+)\]/g, (tag, filePath: string) => sent.has(filePath.trim()) ? "" : tag),
    }))
    .filter(({ original, stripped }) => stripped.trim() || !original.trim())
    .map(({ stripped }) => stripped)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasSendFileTag(text: string): boolean {
  return /\[send-file:[^\]]+\]/.test(text);
}

function extractSendFilePaths(text: string): string[] {
  return Array.from(text.matchAll(/\[send-file:([^\]]+)\]/g), (match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function stripSendFileTags(text: string): string {
  return text.replace(/\[send-file:[^\]]+\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function stripDeliveredStreamTextFragments(text: string, fragments: readonly string[]): string {
  let next = text;
  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (!trimmed) {
      continue;
    }
    next = next.replace(trimmed, "");
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

export async function executeWorkflowAwareTelegramTurn(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: WorkflowAwareTurnConfig;
  normalized: NormalizedTelegramMessage;
  context: WorkflowAwareTurnContext;
  workflowStore: Pick<FileWorkflowStore, "update">;
  downloadedAttachments: DownloadedAttachment[];
  state: WorkflowAwareTurnState;
  prepareAttachmentWorkflow?: typeof defaultPrepareAttachmentWorkflow;
  prepareArchiveContinueWorkflow?: typeof defaultPrepareArchiveContinueWorkflow;
  createTelegramOutDir?: typeof defaultCreateTelegramOutDir;
  describeTelegramOutFiles?: typeof defaultDescribeTelegramOutFiles;
  applyTelegramOutLimits?: typeof defaultApplyTelegramOutLimits;
  pruneStaleCctbSendDirs?: typeof defaultPruneStaleCctbSendDirs;
  startSideChannelSendServer?: typeof defaultStartSideChannelSendServer;
  createSideChannelSendHelper?: typeof defaultCreateSideChannelSendHelper;
  buildContinueAnalysisKeyboard?: typeof defaultBuildContinueAnalysisKeyboard;
  deliverTelegramResponse: (
    api: WorkflowAwareTurnContext["api"],
    chatId: number,
    text: string,
    inboxDir: string,
    workspaceOverride: string | undefined,
    requestOutputDir: string | undefined,
    locale: Locale,
    options?: {
      onFileAccepted?: (sourcePath: string) => void;
      source?: "post-turn" | "side-channel" | "stream-event";
    },
  ) => Promise<number>;
  sendTelegramOutFile: (chatId: number, filename: string, contents: Uint8Array) => Promise<void>;
  updateWorkflowBestEffort?: (
    workflowStore: Pick<FileWorkflowStore, "update">,
    workflowRecordId: string,
    mutate: Parameters<FileWorkflowStore["update"]>[1],
  ) => Promise<void>;
}): Promise<void> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    normalized,
    context,
    workflowStore,
    downloadedAttachments,
    state,
    prepareAttachmentWorkflow = defaultPrepareAttachmentWorkflow,
    prepareArchiveContinueWorkflow = defaultPrepareArchiveContinueWorkflow,
    createTelegramOutDir = defaultCreateTelegramOutDir,
    describeTelegramOutFiles = defaultDescribeTelegramOutFiles,
    applyTelegramOutLimits = defaultApplyTelegramOutLimits,
    pruneStaleCctbSendDirs = defaultPruneStaleCctbSendDirs,
    startSideChannelSendServer = defaultStartSideChannelSendServer,
    createSideChannelSendHelper = defaultCreateSideChannelSendHelper,
    buildContinueAnalysisKeyboard = defaultBuildContinueAnalysisKeyboard,
    deliverTelegramResponse,
    sendTelegramOutFile,
    updateWorkflowBestEffort = async (store, workflowRecordId, mutate) => {
      try {
        await store.update(workflowRecordId, mutate);
      } catch {
        // bookkeeping-only best effort
      }
    },
  } = input;

  const workflowResult: FileWorkflowResult | null =
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
  state.failureHint = workflowResult?.failureHint;
  if (workflowResult?.workflowRecordId) {
    await appendTimelineEventBestEffort(stateDir, {
      type: "workflow.prepared",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      detail: downloadedAttachments.length > 0 ? "attachment workflow prepared" : "workflow prepared",
      metadata: {
        workflowRecordId: workflowResult.workflowRecordId,
        kind: workflowResult.kind,
      },
    });
  }

  const requestId = `${Date.now()}-${normalized.chatId}`;
  if (cfg.engine === "codex") {
    state.telegramOutDirPath = (await createTelegramOutDir(stateDir, requestId)).dirPath;
  }

  if (workflowResult?.kind === "reply") {
    state.workflowRecordId = workflowResult.workflowRecordId;
    const deliveryText = state.workflowRecordId ? boundArchiveSummaryForTelegram(workflowResult.text) : workflowResult.text;
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
    if (state.workflowRecordId) {
      state.archiveSummaryDelivered = true;
    }
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
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

  state.workflowRecordId = workflowResult?.workflowRecordId;
  const requestText = workflowResult?.kind === "direct" ? workflowResult.text : normalized.text;
  const requestFiles = workflowResult?.kind === "direct"
    ? [...workflowResult.files]
    : downloadedAttachments.map((attachment) => attachment.localPath);

  if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
    return;
  }

  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.started",
    instanceName: context.instanceName,
    channel: "telegram",
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    metadata: {
      attachments: normalized.attachments.length,
      workflowRecordId: state.workflowRecordId,
    },
  });

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
        // best effort
      }
    }
  }

  let sideChannel: SideChannelSendServer | undefined;
  let result: Awaited<ReturnType<WorkflowAwareTurnContext["bridge"]["handleAuthorizedMessage"]>> | undefined;
  let deliveredText = "";
  let sideChannelCommand: string | undefined;
  let sideChannelEnv: Record<string, string> | undefined;
  const streamDeliveredFilePaths = new Set<string>();
  const streamPendingFilePaths = new Set<string>();
  const streamDeliveredTextFragments: string[] = [];
  const streamDeliveryPromises: Promise<void>[] = [];
  const getAlreadyDeliveredFilePaths = () => [
    ...(sideChannel?.getSentFilePaths() ?? []),
    ...streamDeliveredFilePaths,
  ];
  const handleEngineEvent = (event: EngineStreamEvent): void => {
    void appendTimelineEventBestEffort(stateDir, {
      type: "engine.event",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      detail: event.type,
      metadata: {
        toolName: "toolName" in event ? event.toolName : undefined,
        textChars: "text" in event ? event.text.length : undefined,
        hasSendFileTag: event.type === "assistant_text" ? hasSendFileTag(event.text) : undefined,
      },
    });

    if (event.type !== "assistant_text" || !hasSendFileTag(event.text)) {
      return;
    }

    const eventText = stripAlreadySentSideChannelTags(event.text, getAlreadyDeliveredFilePaths());
    if (!eventText || !hasSendFileTag(eventText)) {
      return;
    }
    const eventFilePaths = extractSendFilePaths(eventText);
    const pendingOnlyPaths = eventFilePaths.filter((filePath) => !streamDeliveredFilePaths.has(filePath));
    if (pendingOnlyPaths.length > 0 && pendingOnlyPaths.every((filePath) => streamPendingFilePaths.has(filePath))) {
      return;
    }
    for (const filePath of pendingOnlyPaths) {
      streamPendingFilePaths.add(filePath);
    }
    const eventTextFragment = stripSendFileTags(eventText);

    const delivery = deliverTelegramResponse(
      context.api,
      normalized.chatId,
      eventText,
      context.inboxDir,
      cfg.resume?.workspacePath,
      state.telegramOutDirPath,
      locale,
      {
        source: "stream-event",
        onFileAccepted: (sourcePath) => {
          streamDeliveredFilePaths.add(sourcePath);
          streamPendingFilePaths.delete(sourcePath);
        },
      },
    ).then(() => {
      if (eventTextFragment) {
        streamDeliveredTextFragments.push(eventTextFragment);
      }
    }).catch((error) => {
      for (const filePath of pendingOnlyPaths) {
        streamPendingFilePaths.delete(filePath);
      }
      void appendTimelineEventBestEffort(stateDir, {
        type: "engine.event.delivery_failed",
        instanceName: context.instanceName,
        channel: "telegram",
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    streamDeliveryPromises.push(delivery);
  };
  try {
    sideChannel = await startSideChannelSendServer({
      api: context.api,
      chatId: normalized.chatId,
      inboxDir: context.inboxDir,
      workspaceOverride: cfg.resume?.workspacePath,
      requestOutputDir: state.telegramOutDirPath,
      locale,
    });
    await pruneStaleCctbSendDirs(stateDir, requestId);
    const helperRoot = cfg.resume?.workspacePath
      ? path.join(cfg.resume.workspacePath, ".cctb-send", requestId)
      : resolveCctbSendDir(stateDir, requestId);
    sideChannelCommand = await createSideChannelSendHelper(helperRoot, undefined, {
      CCTB_SEND_URL: sideChannel.url,
      CCTB_SEND_TOKEN: sideChannel.token,
    });
    if (context.bridge.supportsTurnScopedEnv !== false) {
      sideChannelEnv = {
        CCTB_SEND_URL: sideChannel.url,
        CCTB_SEND_TOKEN: sideChannel.token,
        CCTB_SEND_COMMAND: sideChannelCommand,
      };
    }
  } catch {
    await sideChannel?.close().catch(() => {});
    sideChannel = undefined;
    sideChannelCommand = undefined;
    sideChannelEnv = undefined;
  }

  try {
    result = await context.bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
      text: requestText,
      replyContext,
      files: requestFiles,
      onApprovalRequest: context.onApprovalRequest,
      onEngineEvent: handleEngineEvent,
      requestOutputDir: state.telegramOutDirPath,
      workspaceOverride: cfg.resume?.workspacePath,
      sideChannelCommand,
      extraEnv: sideChannelEnv,
      abortSignal: context.abortSignal,
    });

    await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);

    await Promise.allSettled(streamDeliveryPromises);
    deliveredText = stripDeliveredStreamTextFragments(
      stripAlreadySentSideChannelTags(result.text, getAlreadyDeliveredFilePaths()),
      streamDeliveredTextFragments,
    );
    await deliverTelegramResponse(
      context.api,
      normalized.chatId,
      deliveredText,
      context.inboxDir,
      cfg.resume?.workspacePath,
      state.telegramOutDirPath,
      locale,
    );
  } finally {
    await sideChannel?.close().catch(() => {});
  }

  if (!result) {
    throw new Error("Telegram turn finished without an engine result");
  }

  if (state.telegramOutDirPath) {
    const describedFiles = await describeTelegramOutFiles(state.telegramOutDirPath);
    const limitedFiles = applyTelegramOutLimits(describedFiles, {
      maxFiles: 5,
      maxFileBytes: 512_000,
      maxTotalBytes: 1_500_000,
    });

    for (const file of limitedFiles.accepted) {
      const contents = await readFile(file.path);
      await sendTelegramOutFile(normalized.chatId, file.name, contents);
    }
  }

  if (state.workflowRecordId) {
    await updateWorkflowBestEffort(workflowStore, state.workflowRecordId, (record) => {
      record.status = "completed";
    });
    await appendTimelineEventBestEffort(stateDir, {
      type: "workflow.completed",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      detail: "workflow marked completed",
      metadata: {
        workflowRecordId: state.workflowRecordId,
      },
    });
  }

  await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
    outcome: "success",
    metadata: {
      durationMs: Date.now() - startedAt,
      attachments: normalized.attachments.length,
      responseChars: deliveredText.length,
      chunkCount: chunkTelegramMessage(deliveredText).length,
    },
  });
}
