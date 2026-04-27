import { mkdir, readFile, realpath } from "node:fs/promises";
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
import {
  TurnDeliveryLedger,
  type DeliveryAcceptedReceipt,
  type DeliveryReceipts,
  type DeliveryRejectedReceipt,
} from "./delivery-ledger.js";
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
  deliveredFilesBeforeError?: string[];
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

function countInlineFileBlocks(text: string): number {
  return Array.from(text.matchAll(/```file:[^\n]+\n[\s\S]*?```/g)).length;
}

const DEFERRED_DELIVERY_REPLY_PATTERNS = [
  /等(?:待)?[\s\S]{0,16}通知/i,
  /(?:batch|批量|后台)[\s\S]{0,32}(?:通知|notify|notification)/i,
  /(?:wait|waiting)[\s\S]{0,24}(?:notify|notification|batch)/i,
  /(?:notify you|will notify|i'll notify)[\s\S]{0,24}(?:later|when|once)?/i,
];
const DEFERRED_DELIVERY_IN_PROGRESS_PATTERNS = [
  /(?:batch|批量|批处理)[\s\S]{0,48}(?:跑起来|跑起來|启动|啟動|started|running|in progress|生成中|处理中|處理中)/i,
  /(?:P\s*\d+\s*[-到至]\s*P?\s*\d+|P\s*\d+\s*(?:\+|和|与|與)\s*P?\s*\d+)[\s\S]{0,64}(?:batch|跑起来|跑起來|启动|啟動|started|running|in progress|生成中|处理中|處理中)/i,
  /(?:图片|圖片|图文|圖文|image|images|files?|交付物|deliverables?)[\s\S]{0,64}(?:后台|後台|background|生成中|处理中|處理中|running|in progress)/i,
  /(?:batch|批量|批处理|P\s*\d+|图片|圖片|图文|圖文|image|images|files?|交付物|deliverables?)[\s\S]{0,96}(?:\d+\s*(?:分钟|分鐘|分|minutes?|mins?)|稍后|稍後|一会儿|一會兒|later|after)[\s\S]{0,64}(?:check|检查|檢查|回来|回來|主动|主動|继续|繼續|再看|复查|複查|发|發|发送|傳|传|deliver|send)/i,
];
const DELIVERABLE_REQUEST_PATTERNS = [
  /(?:生成|制作|製作|做|写|寫|撰写|撰寫|画|畫|绘制|繪製|出图|出圖|制图|製圖|导出|導出|保存|发送|發送|发给|發給|交付|增强|增強|放大|修复|修復|转换|轉換)[\s\S]{0,64}(?:图片|圖片|图文|圖文|图|圖|照片|海报|海報|文件|报告|報告|PPT|PDF|Word|Excel|表格|image|images|photo|poster|file|files|report|slides?|deck|pdf|docx|pptx|xlsx|png|jpe?g|webp)/i,
  /(?:create|generate|draw|make|write|export|send|deliver|upscale|enhance|convert|save)[\s\S]{0,64}(?:image|images|photo|poster|file|files|report|slides?|deck|pdf|docx|pptx|xlsx|png|jpe?g|webp|图片|圖片|图文|圖文|文件|报告|報告)/i,
];
const TEXT_ONLY_CONTENT_REQUEST_PATTERNS = [
  /(?:生成|制作|製作|做|写|寫|撰写|撰寫)[\s\S]{0,64}(?:图片|圖片|图像|圖像|图|圖|image)[\s\S]{0,24}(?:描述|说明|說明|分析|报告|報告|提示词|提示詞|prompt|caption|description|analysis)/i,
  /(?:generate|create|write|make)[\s\S]{0,64}(?:report|summary|description|caption|prompt|analysis)/i,
];
const EXPLICIT_FILE_DELIVERY_REQUEST_PATTERN =
  /(?:文件|档案|檔案|保存|导出|導出|发送|發送|发给|發給|交付|下载|下載|file|export|send|deliver|save|download|pdf|docx|pptx|xlsx|png|jpe?g|webp|zip)/i;
const DELIVERABLE_COMPLETION_REPLY_PATTERNS = [
  /(?:已生成|生成(?:完成|好了)?|已做好|做好了|已保存|保存为|保存為|导出(?:完成)?|導出(?:完成)?|created|generated|saved|exported|ready)[\s\S]{0,80}(?:P\s*\d+|图片|圖片|图文|圖文|图|圖|文件|报告|報告|image|images|photo|poster|file|files|report|pdf|docx|pptx|xlsx|png|jpe?g|webp|\.(?:png|jpe?g|webp|pdf|docx|pptx|xlsx|zip|txt|md)\b)/i,
  /(?:P\s*\d+|图片|圖片|图文|圖文|图|圖|文件|报告|報告|image|images|photo|poster|file|files|report|pdf|docx|pptx|xlsx|png|jpe?g|webp|\.(?:png|jpe?g|webp|pdf|docx|pptx|xlsx|zip|txt|md)\b)[\s\S]{0,80}(?:已生成|生成(?:完成|好了)?|已做好|做好了|已保存|保存为|保存為|导出(?:完成)?|導出(?:完成)?|created|generated|saved|exported|ready)/i,
];
const EXPLANATORY_DEFERRED_DELIVERY_CONTEXT_PATTERN =
  /(?:出现类似|类似|例如|比如|不要|不能|不会|不是|不应该|拦截|机制|解释|截图|错误行为|根因|prompt|bridge|repair|example|quote|quoted|do not|don't|not valid)/i;
const MAX_DELIVERY_MANIFEST_EXPECTED_FILES = 20;
const DELIVERY_COUNT_NOUN_PATTERN =
  "(?:图片|圖片|图像|圖像|图|圖|照片|海报|海報|文件|报告|報告|文档|文檔|档案|檔案|image|images|photo|photos|picture|pictures|poster|posters|file|files|document|documents|report|reports|pdfs?|docx|pptx|xlsx|pngs?|jpe?gs?|webps?|zips?)";
const DELIVERY_COUNT_PATTERNS = [
  new RegExp(`(?<count>\\d{1,2})\\s*(?:张|張|个|個|份)?\\s*${DELIVERY_COUNT_NOUN_PATTERN}`, "i"),
  new RegExp(`(?<count>one|two|three|four|five|six|seven|eight|nine|ten)\\s+${DELIVERY_COUNT_NOUN_PATTERN}`, "i"),
  new RegExp(`(?<count>[一二两兩三四五六七八九十]{1,3})\\s*(?:张|張|个|個|份)?\\s*${DELIVERY_COUNT_NOUN_PATTERN}`),
];
const ENGLISH_COUNT_VALUES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const CHINESE_DIGIT_VALUES: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

interface DeliveryManifest {
  expectedFileCount?: number;
}

function parseChineseCount(value: string): number | undefined {
  if (value === "十") {
    return 10;
  }
  if (value.startsWith("十")) {
    return 10 + (CHINESE_DIGIT_VALUES[value.slice(1)] ?? 0);
  }
  const tensMatch = value.match(/^([一二两兩三四五六七八九])十([一二两兩三四五六七八九])?$/);
  if (tensMatch) {
    return CHINESE_DIGIT_VALUES[tensMatch[1]!]! * 10 + (tensMatch[2] ? CHINESE_DIGIT_VALUES[tensMatch[2]]! : 0);
  }
  return CHINESE_DIGIT_VALUES[value];
}

function parseDeliveryCount(value: string): number | undefined {
  const normalized = value.toLowerCase();
  const parsed = /^\d+$/.test(normalized)
    ? Number.parseInt(normalized, 10)
    : ENGLISH_COUNT_VALUES[normalized] ?? parseChineseCount(value);
  if (!parsed || parsed < 1 || parsed > MAX_DELIVERY_MANIFEST_EXPECTED_FILES) {
    return undefined;
  }
  return parsed;
}

function isDeferredDeliveryReply(text: string): boolean {
  const normalized = stripSendFileTags(text).trim();
  if (!normalized) {
    return false;
  }
  return normalized.split(/\r?\n/).some((line) => {
    if (EXPLANATORY_DEFERRED_DELIVERY_CONTEXT_PATTERN.test(line)) {
      return false;
    }
    return [
      ...DEFERRED_DELIVERY_REPLY_PATTERNS,
      ...DEFERRED_DELIVERY_IN_PROGRESS_PATTERNS,
    ].some((pattern) => pattern.test(line));
  });
}

function isLikelyDeliverableRequest(text: string): boolean {
  if (
    TEXT_ONLY_CONTENT_REQUEST_PATTERNS.some((pattern) => pattern.test(text)) &&
    !EXPLICIT_FILE_DELIVERY_REQUEST_PATTERN.test(text)
  ) {
    return false;
  }
  return DELIVERABLE_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function buildDeliveryManifest(requestText: string): DeliveryManifest {
  if (!isLikelyDeliverableRequest(requestText)) {
    return {};
  }
  for (const pattern of DELIVERY_COUNT_PATTERNS) {
    const match = pattern.exec(requestText);
    const count = match?.groups?.count ? parseDeliveryCount(match.groups.count) : undefined;
    if (count) {
      return { expectedFileCount: count };
    }
  }
  return {};
}

function isUndeliveredDeliverableCompletionReply(input: {
  requestText: string;
  responseText: string;
  hasFileDeliveryEvidence: boolean;
}): boolean {
  if (input.hasFileDeliveryEvidence || !isLikelyDeliverableRequest(input.requestText)) {
    return false;
  }
  const normalized = stripSendFileTags(input.responseText).trim();
  if (!normalized) {
    return false;
  }
  return normalized.split(/\r?\n/).some((line) => {
    if (EXPLANATORY_DEFERRED_DELIVERY_CONTEXT_PATTERN.test(line)) {
      return false;
    }
    return DELIVERABLE_COMPLETION_REPLY_PATTERNS.some((pattern) => pattern.test(line));
  });
}

function buildDeferredDeliveryRepairPrompt(previousText: string): string {
  return [
    "[Bridge delivery repair]",
    "Your previous reply ended the Telegram turn before completing requested file delivery:",
    previousText.trim(),
    "",
    "That is not valid in this Telegram bridge. Do not send that reply to the user.",
    "Continue the current task now. If a background command is still creating requested deliverables, wait for it or check it until it completes or fails.",
    "When the requested deliverable set is ready, deliver the files with the active side-channel send command or [send-file:] fallback.",
    "If the deliverables cannot be completed, report the failure or what is incomplete. Do not promise a later notification.",
  ].join("\n");
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

async function resolveExistingPath(filePath: string): Promise<string> {
  return await realpath(filePath).catch(() => filePath);
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
      onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
      onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
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
  const deliveryManifest = buildDeliveryManifest(requestText);

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
  const deliveryLedger = new TurnDeliveryLedger();
  const streamDeliveredFilePaths = new Set<string>();
  const streamPendingFilePaths = new Set<string>();
  const streamDeliveredTextFragments: string[] = [];
  const streamDeliveryPromises: Promise<void>[] = [];
  const syncSideChannelReceipts = () => {
    const getReceipts = (sideChannel as (SideChannelSendServer & {
      getDeliveryReceipts?: () => DeliveryReceipts;
    }) | undefined)?.getDeliveryReceipts;
    deliveryLedger.merge(getReceipts?.());
  };
  const getAlreadyDeliveredFilePaths = () => {
    syncSideChannelReceipts();
    return [
      ...(sideChannel?.getSentFilePaths() ?? []),
      ...streamDeliveredFilePaths,
      ...deliveryLedger.acceptedPaths(),
    ];
  };
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
        onDeliveryAccepted: (receipt) => {
          deliveryLedger.recordAccepted(receipt);
        },
        onDeliveryRejected: (receipt) => {
          deliveryLedger.recordRejected(receipt);
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
    const helperRoot = cfg.resume?.workspacePath
      ? path.join(cfg.resume.workspacePath, ".cctb-send", requestId)
      : resolveCctbSendDir(stateDir, requestId);
    await pruneStaleCctbSendDirs(stateDir, requestId, cfg.resume?.workspacePath);
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

  let turnError: unknown;
  try {
    const getAcceptedTelegramOutFilePaths = async (): Promise<string[]> => {
      if (!state.telegramOutDirPath) {
        return [];
      }
      const describedFiles = await describeTelegramOutFiles(state.telegramOutDirPath);
      const limitedFiles = applyTelegramOutLimits(describedFiles, {
        maxFiles: 5,
        maxFileBytes: 512_000,
        maxTotalBytes: 1_500_000,
      });
      return limitedFiles.accepted.map((file) => file.path);
    };
    const countDeliveryEvidence = async (responseText: string): Promise<number> => {
      const paths = new Set([
        ...getAlreadyDeliveredFilePaths(),
        ...extractSendFilePaths(responseText),
        ...(await getAcceptedTelegramOutFilePaths()),
      ]);
      return paths.size + countInlineFileBlocks(responseText);
    };
    const getDeliveryRepairReason = async (responseText: string): Promise<"deferred" | "undelivered" | undefined> => {
      await Promise.allSettled(streamDeliveryPromises);
      if (isDeferredDeliveryReply(responseText)) {
        return "deferred";
      }
      syncSideChannelReceipts();
      const deliveryEvidenceCount = await countDeliveryEvidence(responseText);
      const deliveryManifestSatisfied = !deliveryManifest.expectedFileCount ||
        deliveryEvidenceCount >= deliveryManifest.expectedFileCount;
      const hasFileDeliveryEvidence =
        deliveryEvidenceCount > 0 &&
        deliveryManifestSatisfied;
      if (isUndeliveredDeliverableCompletionReply({
        requestText,
        responseText,
        hasFileDeliveryEvidence,
      })) {
        return "undelivered";
      }
      return undefined;
    };
    const runEngineTurn = async (input: {
      text: string;
      files: string[];
      replyContext?: NormalizedTelegramMessage["replyContext"];
    }) => await context.bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
      text: input.text,
      replyContext: input.replyContext,
      files: input.files,
      onApprovalRequest: context.onApprovalRequest,
      onEngineEvent: handleEngineEvent,
      requestOutputDir: state.telegramOutDirPath,
      workspaceOverride: cfg.resume?.workspacePath,
      sideChannelCommand,
      extraEnv: sideChannelEnv,
      abortSignal: context.abortSignal,
    });

    result = await runEngineTurn({
      text: requestText,
      replyContext,
      files: requestFiles,
    });
    await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);

    let repairReason = await getDeliveryRepairReason(result.text);
    for (let repairAttempt = 1; repairAttempt <= 2 && repairReason; repairAttempt += 1) {
      await appendTimelineEventBestEffort(stateDir, {
        type: "turn.retried",
        instanceName: context.instanceName,
        channel: "telegram",
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "retry",
        detail: "deferred delivery repair",
        metadata: {
          repairAttempt,
          repairReason,
          responseChars: result.text.length,
        },
      });
      result = await runEngineTurn({
        text: buildDeferredDeliveryRepairPrompt(result.text),
        files: [],
        replyContext: undefined,
      });
      await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
      repairReason = await getDeliveryRepairReason(result.text);
    }

    if (repairReason) {
      state.failureHint = locale === "zh"
        ? "引擎提前结束了仍在生成或尚未交付的任务。bridge 已阻止发送未完成交付回复，请重试或继续追问当前任务。"
        : "The engine ended a deliverable-generating task before completing file delivery. The bridge blocked that reply; retry or continue the current task.";
      throw new Error("Engine returned a delivery-incomplete reply instead of completing deliverables");
    }

    await Promise.allSettled(streamDeliveryPromises);
    deliveredText = stripDeliveredStreamTextFragments(
      stripAlreadySentSideChannelTags(result.text, getAlreadyDeliveredFilePaths()),
      streamDeliveredTextFragments,
    );
    const postTurnDeliveryOptions = hasSendFileTag(deliveredText)
      ? {
        source: "post-turn" as const,
        onDeliveryAccepted: (receipt: Parameters<TurnDeliveryLedger["recordAccepted"]>[0]) => {
          deliveryLedger.recordAccepted(receipt);
        },
        onDeliveryRejected: (receipt: Parameters<TurnDeliveryLedger["recordRejected"]>[0]) => {
          deliveryLedger.recordRejected(receipt);
        },
      }
      : undefined;
    if (postTurnDeliveryOptions) {
      await deliverTelegramResponse(
        context.api,
        normalized.chatId,
        deliveredText,
        context.inboxDir,
        cfg.resume?.workspacePath,
        state.telegramOutDirPath,
        locale,
        postTurnDeliveryOptions,
      );
    } else {
      await deliverTelegramResponse(
        context.api,
        normalized.chatId,
        deliveredText,
        context.inboxDir,
        cfg.resume?.workspacePath,
        state.telegramOutDirPath,
        locale,
      );
    }
  } catch (error) {
    turnError = error;
  } finally {
    await Promise.allSettled(streamDeliveryPromises);
    if (turnError !== undefined) {
      const deliveredFilePaths = [...new Set(getAlreadyDeliveredFilePaths())];
      if (deliveredFilePaths.length > 0) {
        state.deliveredFilesBeforeError = deliveredFilePaths;
      }
    }
    await sideChannel?.close().catch(() => {});
  }

  if (turnError !== undefined) {
    throw turnError;
  }

  if (!result) {
    throw new Error("Telegram turn finished without an engine result");
  }

  if (state.telegramOutDirPath) {
    const describedFiles = await describeTelegramOutFiles(state.telegramOutDirPath);
    const alreadyDeliveredRealPaths = new Set(
      await Promise.all(getAlreadyDeliveredFilePaths().map((filePath) => resolveExistingPath(filePath))),
    );
    const limitedFiles = applyTelegramOutLimits(describedFiles, {
      maxFiles: 5,
      maxFileBytes: 512_000,
      maxTotalBytes: 1_500_000,
    });

    for (const file of limitedFiles.accepted) {
      const fileRealPath = await resolveExistingPath(file.path);
      if (alreadyDeliveredRealPaths.has(fileRealPath)) {
        continue;
      }
      const contents = await readFile(file.path);
      await sendTelegramOutFile(normalized.chatId, file.name, contents);
      deliveryLedger.recordAccepted({
        path: file.path,
        realPath: fileRealPath,
        fileName: file.name,
        bytes: contents.length,
        source: "telegram-out",
      });
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
