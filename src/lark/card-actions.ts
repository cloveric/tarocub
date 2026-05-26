import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../codex/adapter.js";
import { recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { prepareArchiveContinueWorkflow } from "../runtime/file-workflow.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "../telegram/approval-timeouts.js";
import type { Locale } from "../telegram/message-renderer.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { renderLarkApprovalCard } from "./card-renderer.js";
import {
  applyLarkConfigCardAction,
  isLarkConfigCardActionValue,
  renderLarkConfigCard,
} from "./config-card.js";
import { deliverLarkResponse, sendLarkMarkdown } from "./delivery.js";
import { renderLarkUserFacingError } from "./errors.js";
import { safeSegment } from "./files.js";
import { assertStableLarkIdMappings } from "./id-map.js";
import { larkOperatorRawId } from "./identity.js";
import {
  renderLarkApprovalExpired,
  renderLarkBackgroundTaskHeader,
  renderLarkOperatorAccessDenied,
  renderLarkQueuedTaskSkipped,
  renderLarkStopResult,
  resolveLarkLocale,
} from "./locale.js";
import { larkAccessChatIdFromConversationKey, larkAccessConversationKeyFromConversationKey, stableLarkNumericId } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkServiceRuntime, PendingLarkApproval } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike, LarkSendOptions } from "./types.js";

type LarkApprovalChoice = "once" | "session" | "deny";

export type LarkApprovalTextCommandResult =
  | { handled: false }
  | {
    handled: true;
    outcome: "success" | "noop";
    choice: LarkApprovalChoice;
    requestId?: string;
    reason?: "no-pending" | "different-conversation";
  };

export async function requestLarkApproval(input: {
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
}): Promise<EngineApprovalDecision> {
  if (input.abortSignal?.aborted) {
    return { behavior: "deny" };
  }

  const requestId = randomUUID();
  return await new Promise<EngineApprovalDecision>((resolve, reject) => {
    const cleanup = () => cleanupPendingApproval(input.runtime, requestId);
    const timer = setTimeout(() => {
      const pending = input.runtime.pendingApprovals.get(requestId);
      if (!pending) {
        return;
      }
      cleanup();
      pending.resolve({ behavior: "deny" });
      void input.channel.send(
        input.chatId,
        { text: renderLarkApprovalExpired(input.locale ?? "zh") },
        larkReplyOptions(input.replyTo, input.replyInThread),
      ).catch(() => undefined);
    }, TELEGRAM_APPROVAL_TIMEOUT_MS);

    const pending: PendingLarkApproval = {
      requestId,
      chatId: input.chatId,
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      ...(input.bridgeChatType ? { bridgeChatType: input.bridgeChatType } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.replyInThread ? { replyInThread: true } : {}),
      resolve,
      reject,
      timer,
      abortSignal: input.abortSignal,
    };

    if (input.abortSignal) {
      pending.abortHandler = () => {
        cleanup();
        resolve({ behavior: "deny" });
      };
      input.abortSignal.addEventListener("abort", pending.abortHandler, { once: true });
    }

    input.runtime.pendingApprovals.set(requestId, pending);
    input.channel.send(input.chatId, {
      card: renderLarkApprovalCard({
        requestId,
        toolName: input.request.toolName,
        toolInput: input.request.toolInput,
        replyInThread: input.replyInThread,
        locale: input.locale,
      }),
    }, larkReplyOptions(input.replyTo, input.replyInThread)).catch((error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function isLarkApprovalTextCommand(text: string): boolean {
  return parseLarkApprovalTextCommand(text) !== null;
}

export async function handleLarkApprovalTextCommand(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  messageId: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  replyInThread?: boolean;
  text: string;
  locale?: Locale;
}): Promise<LarkApprovalTextCommandResult> {
  const parsed = parseLarkApprovalTextCommand(input.text);
  if (!parsed) {
    return { handled: false };
  }
  const locale = input.locale ?? "zh";

  const pending = parsed.kind === "id"
    ? input.runtime.pendingApprovals.get(parsed.requestId)
    : findOldestPendingLarkApproval(input.runtime, input);
  if (!pending) {
    await input.channel.send(input.chatId, { text: renderApprovalNoPending(locale) }, larkReplyOptions(input.messageId, input.replyInThread));
    return { handled: true, outcome: "noop", choice: parsed.choice, reason: "no-pending" };
  }
  if (!pendingMatchesLarkConversation(pending, input)) {
    await input.channel.send(input.chatId, { text: renderApprovalDifferentConversation(locale) }, larkReplyOptions(input.messageId, input.replyInThread));
    return {
      handled: true,
      outcome: "noop",
      choice: parsed.choice,
      requestId: pending.requestId,
      reason: "different-conversation",
    };
  }

  cleanupPendingApproval(input.runtime, pending.requestId);
  pending.resolve(renderTextApprovalDecision(parsed.choice));
  await input.channel.send(input.chatId, { text: renderTextApprovalResolution(parsed.choice, locale) }, larkReplyOptions(input.messageId, input.replyInThread));
  return { handled: true, outcome: "success", choice: parsed.choice, requestId: pending.requestId };
}

export async function handleLarkCardAction(input: {
  channel: LarkChannelLike;
  bridge?: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir?: string;
  event: {
    messageId: string;
    chatId: string;
    operator?: {
      openId?: string;
      userId?: string;
      name?: string;
    };
    action: {
      value: unknown;
    };
  };
}): Promise<boolean> {
  const value = actionValue(input.event.action.value);
  if (!value) {
    return false;
  }
  const replyInThread = value.replyInThread === true;
  const locale = input.stateDir ? await resolveLarkLocale(input.stateDir) : "zh";

  if (value.cctb_lark === "stop" && typeof value.conversationKey === "string") {
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
      action: "stop",
    })) {
      return true;
    }
    const active = input.runtime.activeRuns.get(value.conversationKey);
    active?.abortController.abort();
    const skippedQueued = input.runtime.chatQueue.clearPending(value.conversationKey);
    await input.channel.send(input.event.chatId, { text: renderLarkStopResult(Boolean(active || skippedQueued), locale) }, {
      replyTo: input.event.messageId,
      ...(replyInThread ? { replyInThread: true } : {}),
    });
    return true;
  }

  if (isLarkConfigCardActionValue(value)) {
    if (!input.stateDir) {
      return false;
    }
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
      action: "config",
    })) {
      return true;
    }

    const notice = await applyLarkConfigCardAction(input.stateDir, value, locale);
    const bridgeChatId = typeof value.bridgeChatId === "number" && Number.isInteger(value.bridgeChatId)
      ? value.bridgeChatId
      : stableLarkNumericId(value.conversationKey);
    const card = await renderLarkConfigCard({
      stateDir: input.stateDir,
      conversationKey: value.conversationKey,
      bridgeChatType,
      larkChatId: typeof value.larkChatId === "string" ? value.larkChatId : input.event.chatId,
      bridgeChatId,
      replyInThread,
      locale: await resolveLarkLocale(input.stateDir),
      notice,
    });
    if (input.channel.updateCard) {
      await input.channel.updateCard(input.event.messageId, card);
    } else {
      await input.channel.send(input.event.chatId, { card }, larkReplyOptions(input.event.messageId, replyInThread));
    }
    await appendLarkCardActionTurnEvent({
      stateDir: input.stateDir,
      chatId: input.event.chatId,
      replyTo: input.event.messageId,
      conversationKey: value.conversationKey,
      bridgeChatType,
      userId: stableLarkNumericId(`user:${larkOperatorRawId(input.event.operator)}`),
    }, {
      type: "turn.completed",
      action: "config",
      outcome: "success",
      detail: "config",
      metadata: {
        configAction: value.action,
        configValue: value.value,
      },
    });
    return true;
  }

  if (
    value.cctb_lark === "approval" &&
    typeof value.requestId === "string" &&
    isApprovalDecision(value.decision)
  ) {
    const pending = input.runtime.pendingApprovals.get(value.requestId);
    if (!pending) {
      if (input.stateDir) {
        const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
        await appendLarkCardActionTurnEvent({
          stateDir: input.stateDir,
          chatId: input.event.chatId,
          replyTo: input.event.messageId,
          conversationKey: `lark:${input.event.chatId}`,
          bridgeChatType,
          userId: stableLarkNumericId(`user:${larkOperatorRawId(input.event.operator)}`),
        }, {
          type: "turn.completed",
          action: "approval",
          outcome: "noop",
          detail: "approval",
          metadata: {
            decision: value.decision,
            requestId: value.requestId,
            reason: "no-pending",
          },
        });
      }
      await input.channel.send(
        input.event.chatId,
        { text: renderApprovalNoPending(locale) },
        larkReplyOptions(input.event.messageId, replyInThread),
      );
      return true;
    }
    const approvalConversationKey = pending.conversationKey ?? `lark:${pending.chatId}`;
    const approvalBridgeChatType = pending.bridgeChatType ?? "private";
    if (
      !await ensureLarkCardActionAccess({
        ...input,
        conversationKey: approvalConversationKey,
        bridgeChatType: approvalBridgeChatType,
        replyInThread: pending.replyInThread ?? replyInThread,
        action: "approval",
      })
    ) {
      return true;
    }
    cleanupPendingApproval(input.runtime, value.requestId);
    pending.resolve(renderApprovalDecision(value.decision));
    await input.channel.send(
      input.event.chatId,
      { text: renderApprovalResolution(value.decision, locale) },
      larkReplyOptions(input.event.messageId, pending.replyInThread ?? replyInThread),
    );
    if (input.stateDir) {
      await appendLarkCardActionTurnEvent({
        stateDir: input.stateDir,
        chatId: input.event.chatId,
        replyTo: input.event.messageId,
        conversationKey: approvalConversationKey,
        bridgeChatType: approvalBridgeChatType,
        userId: stableLarkNumericId(`user:${larkOperatorRawId(input.event.operator)}`),
      }, {
        type: "turn.completed",
        action: "approval",
        outcome: "success",
        detail: "approval",
        metadata: {
          decision: value.decision,
          requestId: value.requestId,
        },
      });
    }
    return true;
  }

  if (value.cctb_lark === "choice" && typeof value.conversationKey === "string") {
    if (!input.bridge || !input.stateDir) {
      return false;
    }
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
      action: "choice",
    })) {
      return true;
    }
    const label = typeof value.label === "string" ? value.label : "choice";
    const choiceValue = typeof value.value === "string" ? value.value : JSON.stringify(value.value ?? label);
    const locale = await resolveLarkLocale(input.stateDir);
    const text = [
      "<lark_card_action>",
      `message_id: ${input.event.messageId}`,
      `operator_id: ${input.event.operator?.openId ?? input.event.operator?.userId ?? "unknown"}`,
      input.event.operator?.name ? `operator_name: ${input.event.operator.name}` : undefined,
      `choice_label: ${label}`,
      `choice_value: ${choiceValue}`,
      "</lark_card_action>",
      "",
      locale === "en" ? `The user clicked a Lark card button: ${label}` : `用户点击了飞书卡片按钮：${label}`,
      `value: ${choiceValue}`,
    ].filter((line): line is string => line !== undefined).join("\n");
    const userId = stableLarkNumericId(`user:${input.event.operator?.openId ?? input.event.operator?.userId ?? "unknown"}`);
    await input.runtime.chatQueue.enqueue(value.conversationKey, async () => {
      await runLarkCardChoice({
        channel: input.channel,
        bridge: input.bridge!,
        runtime: input.runtime,
        stateDir: input.stateDir!,
        chatId: input.event.chatId,
        replyTo: input.event.messageId,
        replyInThread,
        conversationKey: value.conversationKey as string,
        bridgeChatType,
        userId,
        text,
      });
      return true;
    }, {
      onSkipped: async () => {
        await appendLarkCardActionTurnEvent({
          stateDir: input.stateDir!,
          chatId: input.event.chatId,
          replyTo: input.event.messageId,
          conversationKey: value.conversationKey as string,
          bridgeChatType,
          userId,
        }, {
          type: "turn.completed",
          action: "choice",
          outcome: "skipped",
          detail: "queued turn skipped",
          metadata: { phase: "queue" },
        });
        await input.channel.send(input.event.chatId, { text: renderLarkQueuedTaskSkipped(locale) }, larkReplyOptions(input.event.messageId, replyInThread));
        return true;
      },
    });
    return true;
  }

  if (
    value.cctb_lark === "continue_archive" &&
    typeof value.conversationKey === "string" &&
    typeof value.uploadId === "string"
  ) {
    if (!input.bridge || !input.stateDir) {
      return false;
    }
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
      action: "continue_archive",
    })) {
      return true;
    }
    const userId = stableLarkNumericId(`user:${larkOperatorRawId(input.event.operator)}`);
    await input.runtime.chatQueue.enqueue(value.conversationKey, async () => {
      await runLarkArchiveContinueCardAction({
        channel: input.channel,
        bridge: input.bridge!,
        runtime: input.runtime,
        stateDir: input.stateDir!,
        chatId: input.event.chatId,
        replyTo: input.event.messageId,
        replyInThread,
        conversationKey: value.conversationKey as string,
        bridgeChatType,
        uploadId: value.uploadId as string,
        userId,
      });
      return true;
    }, {
      onSkipped: async () => {
        await appendLarkCardActionTurnEvent({
          stateDir: input.stateDir!,
          chatId: input.event.chatId,
          replyTo: input.event.messageId,
          conversationKey: value.conversationKey as string,
          bridgeChatType,
          userId,
        }, {
          type: "turn.completed",
          action: "continue_archive",
          outcome: "skipped",
          detail: "queued turn skipped",
          metadata: { phase: "queue" },
        });
        await input.channel.send(input.event.chatId, { text: renderLarkQueuedTaskSkipped(locale) }, larkReplyOptions(input.event.messageId, replyInThread));
        return true;
      },
    });
    return true;
  }

  return false;
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function larkReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): LarkSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }
  return replyInThread ? { replyTo, replyInThread: true } : { replyTo };
}

async function ensureLarkCardActionAccess(input: {
  channel: LarkChannelLike;
  bridge?: LarkBridgeLike;
  stateDir?: string;
  event: {
    chatId: string;
    messageId: string;
    operator?: {
      openId?: string;
      userId?: string;
      name?: string;
    };
  };
  conversationKey: string;
  bridgeChatType: "private" | "group";
  replyInThread?: boolean;
  action: LarkCardActionTimelineAction;
}): Promise<boolean> {
  if (!input.bridge?.checkAccess || !input.stateDir) {
    return true;
  }

  const operatorRawId = larkOperatorRawId(input.event.operator);
  const chatId = larkAccessChatIdFromConversationKey(input.conversationKey);
  const userId = stableLarkNumericId(`user:${operatorRawId}`);
  const accessConversationKey = larkAccessConversationKeyFromConversationKey(input.conversationKey);
  const locale = await resolveLarkLocale(input.stateDir);
  await assertStableLarkIdMappings(input.stateDir, [
    ["chat", stableLarkNumericId(input.conversationKey), input.conversationKey],
    ["chat", chatId, accessConversationKey],
    ["user", userId, operatorRawId],
  ]);

  const decision = await input.bridge.checkAccess({
    chatId,
    userId,
    chatType: input.bridgeChatType,
    conversationKey: input.conversationKey,
    locale,
  });
  if (decision.kind === "allow") {
    return true;
  }

  await input.channel.send(input.event.chatId, {
    text: decision.text ?? renderLarkOperatorAccessDenied(locale),
  }, larkReplyOptions(input.event.messageId, input.replyInThread));
  await appendLarkCardActionTurnEvent({
    stateDir: input.stateDir,
    chatId: input.event.chatId,
    replyTo: input.event.messageId,
    conversationKey: input.conversationKey,
    bridgeChatType: input.bridgeChatType,
    userId,
  }, {
    type: "turn.completed",
    action: input.action,
    outcome: "denied",
    detail: "access denied",
    metadata: { phase: "access" },
  });
  return false;
}

async function runLarkCardChoice(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  chatId: string;
  replyTo: string;
  replyInThread?: boolean;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  userId: number;
  text: string;
}): Promise<void> {
  const abortController = new AbortController();
  const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(input.replyTo));
  const bridgeChatId = stableLarkNumericId(input.conversationKey);
  const locale = await resolveLarkLocale(input.stateDir);
  await mkdir(requestOutputDir, { recursive: true });
  input.runtime.activeRuns.set(input.conversationKey, { abortController });
  try {
    await appendLarkCardActionTurnEvent(input, {
      type: "turn.started",
      action: "choice",
    });
    const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
      await appendLarkCardActionEngineEvent(input, {
        type: "engine.event",
        action: "choice",
        detail: event.type,
        metadata: {
          toolName: "toolName" in event ? event.toolName : undefined,
          textChars: "text" in event ? event.text.length : undefined,
          status: "status" in event ? event.status : undefined,
        },
      });

      if (event.type !== "task_notification") {
        return;
      }

      const notificationText = [
        renderLarkBackgroundTaskHeader(locale),
        event.text.trim(),
      ].filter(Boolean).join("\n");
      try {
        await deliverLarkResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: input.chatId,
          replyTo: input.replyTo,
          replyInThread: input.replyInThread,
          text: notificationText,
          stateDir: input.stateDir,
          requestOutputDir,
          conversationKey: input.conversationKey,
          bridgeChatType: input.bridgeChatType,
          bridgeChatId,
          bridgeUserId: input.userId,
          larkMessageId: input.replyTo,
        });
      } catch (error) {
        await appendLarkCardActionEngineEvent(input, {
          type: "engine.event.delivery_failed",
          action: "choice",
          outcome: "error",
          detail: redactLarkErrorDetail(error),
          metadata: {
            eventType: event.type,
          },
        });
      }
    };
    const result = await input.bridge.handleAuthorizedMessage({
      chatId: larkAccessChatIdFromConversationKey(input.conversationKey),
      userId: input.userId,
      chatType: input.bridgeChatType,
      conversationKey: input.conversationKey,
      locale,
      text: input.text,
      files: [],
      requestOutputDir,
      abortSignal: abortController.signal,
      onApprovalRequest: async (request) => await requestLarkApproval({
        channel: input.channel,
        runtime: input.runtime,
        chatId: input.chatId,
        conversationKey: input.conversationKey,
        bridgeChatType: input.bridgeChatType,
        replyTo: input.replyTo,
        replyInThread: input.replyInThread,
        locale,
        request,
        abortSignal: request.abortSignal ?? abortController.signal,
      }),
      instructions: larkAgentInstructions(),
      onEngineEvent: handleEngineEvent,
    });
    await recordBridgeTurnUsage(input.stateDir, result.usage, undefined);
    await deliverLarkResponse({
      channel: input.channel,
      runtime: input.runtime,
      chatId: input.chatId,
      replyTo: input.replyTo,
      replyInThread: input.replyInThread,
      text: result.text,
      stateDir: input.stateDir,
      requestOutputDir,
      conversationKey: input.conversationKey,
      bridgeChatType: input.bridgeChatType,
      bridgeChatId,
      bridgeUserId: input.userId,
      larkMessageId: input.replyTo,
    });
    await appendLarkCardActionTurnEvent(input, {
      type: "turn.completed",
      action: "choice",
      outcome: "success",
      metadata: {
        responseChars: result.text.length,
      },
    });
  } catch (error) {
    await input.channel.send(input.chatId, {
      text: renderLarkUserFacingError(error, "engine", locale),
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    await appendLarkCardActionTurnEvent(input, {
      type: "turn.completed",
      action: "choice",
      outcome: "error",
      detail: redactLarkErrorDetail(error),
    });
  } finally {
    input.runtime.activeRuns.delete(input.conversationKey);
  }
}

async function runLarkArchiveContinueCardAction(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  chatId: string;
  replyTo: string;
  replyInThread?: boolean;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  uploadId: string;
  userId: number;
}): Promise<void> {
  const bridgeChatId = stableLarkNumericId(input.conversationKey);
  const workflowResult = await prepareArchiveContinueWorkflow({
    stateDir: input.stateDir,
    chatId: bridgeChatId,
    text: `/continue --upload ${input.uploadId}`,
  });
  if (!workflowResult) {
    await sendLarkMarkdown(input.channel, input.chatId, "没有等待继续分析的压缩包。", larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  if (workflowResult.kind === "reply") {
    await sendLarkMarkdown(input.channel, input.chatId, workflowResult.text, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }

  const abortController = new AbortController();
  const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(input.replyTo));
  const locale = await resolveLarkLocale(input.stateDir);
  await mkdir(requestOutputDir, { recursive: true });
  input.runtime.activeRuns.set(input.conversationKey, { abortController });
  try {
    await appendLarkCardActionTurnEvent(input, {
      type: "turn.started",
      action: "continue_archive",
      metadata: {
        uploadId: input.uploadId,
        workflowRecordId: workflowResult.workflowRecordId,
      },
    });
    const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
      await appendLarkCardActionEngineEvent(input, {
        type: "engine.event",
        action: "continue_archive",
        detail: event.type,
        metadata: {
          uploadId: input.uploadId,
          workflowRecordId: workflowResult.workflowRecordId,
          toolName: "toolName" in event ? event.toolName : undefined,
          textChars: "text" in event ? event.text.length : undefined,
          status: "status" in event ? event.status : undefined,
        },
      });

      if (event.type !== "task_notification") {
        return;
      }

      const notificationText = [
        renderLarkBackgroundTaskHeader(locale),
        event.text.trim(),
      ].filter(Boolean).join("\n");
      try {
        await deliverLarkResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: input.chatId,
          replyTo: input.replyTo,
          replyInThread: input.replyInThread,
          text: notificationText,
          stateDir: input.stateDir,
          requestOutputDir,
          conversationKey: input.conversationKey,
          bridgeChatType: input.bridgeChatType,
          bridgeChatId,
          bridgeUserId: input.userId,
          larkMessageId: input.replyTo,
        });
      } catch (error) {
        await appendLarkCardActionEngineEvent(input, {
          type: "engine.event.delivery_failed",
          action: "continue_archive",
          outcome: "error",
          detail: redactLarkErrorDetail(error),
          metadata: {
            uploadId: input.uploadId,
            workflowRecordId: workflowResult.workflowRecordId,
            eventType: event.type,
          },
        });
      }
    };
    const result = await input.bridge.handleAuthorizedMessage({
      chatId: larkAccessChatIdFromConversationKey(input.conversationKey),
      userId: input.userId,
      chatType: input.bridgeChatType,
      conversationKey: input.conversationKey,
      locale,
      text: workflowResult.text,
      files: workflowResult.files,
      requestOutputDir,
      abortSignal: abortController.signal,
      onApprovalRequest: async (request) => await requestLarkApproval({
        channel: input.channel,
        runtime: input.runtime,
        chatId: input.chatId,
        conversationKey: input.conversationKey,
        bridgeChatType: input.bridgeChatType,
        replyTo: input.replyTo,
        replyInThread: input.replyInThread,
        locale,
        request,
        abortSignal: request.abortSignal ?? abortController.signal,
      }),
      instructions: larkAgentInstructions(),
      onEngineEvent: handleEngineEvent,
    });
    await recordBridgeTurnUsage(input.stateDir, result.usage, undefined);
    await deliverLarkResponse({
      channel: input.channel,
      runtime: input.runtime,
      chatId: input.chatId,
      replyTo: input.replyTo,
      replyInThread: input.replyInThread,
      text: result.text,
      stateDir: input.stateDir,
      requestOutputDir,
      conversationKey: input.conversationKey,
      bridgeChatType: input.bridgeChatType,
      bridgeChatId,
      bridgeUserId: input.userId,
      larkMessageId: input.replyTo,
    });
    await appendLarkCardActionTurnEvent(input, {
      type: "turn.completed",
      action: "continue_archive",
      outcome: "success",
      metadata: {
        uploadId: input.uploadId,
        workflowRecordId: workflowResult.workflowRecordId,
        responseChars: result.text.length,
      },
    });
    if (workflowResult.workflowRecordId) {
      await new FileWorkflowStore(input.stateDir).update(workflowResult.workflowRecordId, (record) => {
        record.status = "completed";
      });
    }
  } catch (error) {
    await input.channel.send(input.chatId, {
      text: renderLarkUserFacingError(error, "engine", locale),
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    await appendLarkCardActionTurnEvent(input, {
      type: "turn.completed",
      action: "continue_archive",
      outcome: "error",
      detail: redactLarkErrorDetail(error),
      metadata: {
        uploadId: input.uploadId,
        workflowRecordId: workflowResult.workflowRecordId,
      },
    });
  } finally {
    input.runtime.activeRuns.delete(input.conversationKey);
  }
}

async function appendLarkCardActionEngineEvent(
  input: {
    stateDir: string;
    chatId: string;
    replyTo: string;
    conversationKey: string;
    bridgeChatType: "private" | "group";
    userId: number;
  },
  event: {
    type: "engine.event" | "engine.event.delivery_failed";
    action: LarkCardActionTimelineAction;
    outcome?: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(input.stateDir, {
    type: event.type,
    channel: "lark",
    chatId: stableLarkNumericId(input.conversationKey),
    userId: input.userId,
    conversationKey: input.conversationKey,
    outcome: event.outcome,
    detail: event.detail,
    metadata: {
      source: "card_action",
      action: event.action,
      larkChatId: input.chatId,
      larkMessageId: input.replyTo,
      bridgeChatType: input.bridgeChatType,
      ...event.metadata,
    },
  }, "Lark card action engine timeline event");
}

async function appendLarkCardActionTurnEvent(
  input: {
    stateDir: string;
    chatId: string;
    replyTo: string;
    conversationKey: string;
    bridgeChatType: "private" | "group";
    userId: number;
  },
  event: {
    type: "turn.started" | "turn.completed";
    action: LarkCardActionTimelineAction;
    outcome?: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(input.stateDir, {
    type: event.type,
    channel: "lark",
    chatId: stableLarkNumericId(input.conversationKey),
    userId: input.userId,
    conversationKey: input.conversationKey,
    outcome: event.outcome,
    detail: event.detail,
    metadata: {
      source: "card_action",
      action: event.action,
      larkChatId: input.chatId,
      larkMessageId: input.replyTo,
      bridgeChatType: input.bridgeChatType,
      ...event.metadata,
    },
  }, "Lark card action turn timeline event");
}

type LarkCardActionTimelineAction = "stop" | "approval" | "choice" | "continue_archive" | "config";

function extractButtonLabel(button: Record<string, unknown>): string {
  const text = payloadObject(button.text);
  const content = text && typeof text.content === "string" ? text.content.trim() : "";
  return content || "choice";
}

function cleanupPendingApproval(runtime: LarkServiceRuntime, requestId: string): void {
  const pending = runtime.pendingApprovals.get(requestId);
  if (!pending) {
    return;
  }
  runtime.pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.abortSignal && pending.abortHandler) {
    pending.abortSignal.removeEventListener("abort", pending.abortHandler);
  }
}

function parseLarkApprovalTextCommand(text: string):
  | { kind: "id"; requestId: string; choice: LarkApprovalChoice }
  | { kind: "chat"; choice: LarkApprovalChoice }
  | null {
  const trimmed = text.trim();
  const internal = trimmed.match(/^\/approval\s+([A-Za-z0-9_-]+)\s+(once|session|deny)$/i);
  if (internal) {
    return {
      kind: "id",
      requestId: internal[1]!,
      choice: internal[2]!.toLowerCase() as LarkApprovalChoice,
    };
  }

  const approve = trimmed.match(/^\/approve(?:\s+(.+))?$/i);
  if (approve) {
    const args = approve[1]?.toLowerCase() ?? "";
    return {
      kind: "chat",
      choice: /\b(?:session|turn|always)\b/i.test(args) ? "session" : "once",
    };
  }

  const denyById = trimmed.match(/^\/deny\s+([A-Za-z0-9_-]+)$/i);
  if (denyById) {
    return {
      kind: "id",
      requestId: denyById[1]!,
      choice: "deny",
    };
  }

  if (/^\/deny(?:\s|$)/i.test(trimmed)) {
    return {
      kind: "chat",
      choice: "deny",
    };
  }

  return null;
}

function findOldestPendingLarkApproval(
  runtime: LarkServiceRuntime,
  input: {
    chatId: string;
    conversationKey: string;
    bridgeChatType: "private" | "group";
  },
): PendingLarkApproval | undefined {
  return [...runtime.pendingApprovals.values()].find((pending) => pendingMatchesLarkConversation(pending, input));
}

function pendingMatchesLarkConversation(
  pending: PendingLarkApproval,
  input: {
    chatId: string;
    conversationKey: string;
    bridgeChatType: "private" | "group";
  },
): boolean {
  if (pending.conversationKey) {
    if (pending.conversationKey !== input.conversationKey) {
      return false;
    }
  } else if (pending.chatId !== input.chatId) {
    return false;
  }

  return pending.bridgeChatType === undefined || pending.bridgeChatType === input.bridgeChatType;
}

function renderTextApprovalDecision(choice: LarkApprovalChoice): EngineApprovalDecision {
  if (choice === "deny") {
    return { behavior: "deny" };
  }
  return {
    behavior: "allow",
    scope: choice,
  };
}

function renderApprovalNoPending(locale: Locale): string {
  return locale === "en" ? "No pending approval." : "没有待处理的审批。";
}

function renderApprovalDifferentConversation(locale: Locale): string {
  return locale === "en"
    ? "This approval request belongs to another Lark conversation."
    : "这个审批请求属于另一个飞书会话。";
}

function renderTextApprovalResolution(choice: LarkApprovalChoice, locale: Locale = "zh"): string {
  if (locale === "en") {
    if (choice === "deny") {
      return "Denied.";
    }
    return choice === "session" ? "Allowed for this turn." : "Allowed once.";
  }
  if (choice === "deny") {
    return "已拒绝。";
  }
  return choice === "session" ? "已允许本轮。" : "已允许一次。";
}

function actionValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function bridgeChatTypeFromValue(value: unknown): "private" | "group" {
  return value === "group" ? "group" : "private";
}

function isApprovalDecision(value: unknown): value is "allow_once" | "allow_session" | "deny" {
  return value === "allow_once" || value === "allow_session" || value === "deny";
}

function renderApprovalDecision(decision: "allow_once" | "allow_session" | "deny"): EngineApprovalDecision {
  if (decision === "deny") {
    return { behavior: "deny" };
  }
  return {
    behavior: "allow",
    scope: decision === "allow_session" ? "session" : "once",
  };
}

function renderApprovalResolution(decision: "allow_once" | "allow_session" | "deny", locale: Locale = "zh"): string {
  if (locale === "en") {
    if (decision === "deny") {
      return "Denied.";
    }
    return decision === "allow_session" ? "Allowed for this turn." : "Allowed once.";
  }
  if (decision === "deny") {
    return "已拒绝。";
  }
  return decision === "allow_session" ? "已允许本轮。" : "已允许一次。";
}
