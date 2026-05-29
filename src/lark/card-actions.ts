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
import { scanRecentAntigravityConversations, scanRecentClaudeSessions } from "../runtime/session-scanner.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "../telegram/approval-timeouts.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath, updateInstanceConfig, type ResumeState } from "../telegram/instance-config.js";
import type { Locale } from "../telegram/message-renderer.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import { renderLarkApprovalCard } from "./card-renderer.js";
import { renderLarkResumeScanCard } from "./command-cards.js";
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

type AskUserQuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

type AskUserQuestionCardQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
};

function isAskUserQuestionRequest(request: EngineApprovalRequest): boolean {
  return request.engine === "claude" && request.toolName === "AskUserQuestion";
}

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
      ...(isAskUserQuestionRequest(input.request) ? { askUserQuestionInput: input.request.toolInput } : {}),
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
    if (isAskUserQuestionRequest(input.request)) {
      sendLarkCardWithFallback({
        channel: input.channel,
        chatId: input.chatId,
        card: renderLarkAskUserQuestionCard({
          requestId,
          toolInput: input.request.toolInput,
          replyInThread: input.replyInThread,
          locale: input.locale,
        }),
        fallbackText: renderLarkAskUserQuestionFallbackText(input.request.toolInput, input.locale ?? "zh"),
        options: larkReplyOptions(input.replyTo, input.replyInThread),
        locale: input.locale ?? "zh",
      }).catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    sendLarkCardWithFallback({
      channel: input.channel,
      chatId: input.chatId,
      card: renderLarkApprovalCard({
        requestId,
        toolName: input.request.toolName,
        toolInput: input.request.toolInput,
        replyInThread: input.replyInThread,
        locale: input.locale,
      }),
      fallbackText: renderLarkApprovalFallbackText(requestId, input.request, input.locale ?? "zh"),
      options: larkReplyOptions(input.replyTo, input.replyInThread),
      locale: input.locale ?? "zh",
    }).catch((error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function renderLarkApprovalFallbackText(requestId: string, request: EngineApprovalRequest, locale: Locale): string {
  const toolInput = typeof request.toolInput === "string" ? request.toolInput : JSON.stringify(request.toolInput, null, 2);
  if (locale === "en") {
    return [
      `Approval required: ${request.toolName}`,
      toolInput,
      `Reply with /approve ${requestId}, /approve-session ${requestId}, or /deny ${requestId}.`,
    ].join("\n\n");
  }
  return [
    `需要审批：${request.toolName}`,
    toolInput,
    `请回复 /approve ${requestId}、/approve-session ${requestId} 或 /deny ${requestId}。`,
  ].join("\n\n");
}

function askFormFieldName(index: number): string {
  return `q${index}`;
}

function renderLarkAskUserQuestionCard(input: {
  requestId: string;
  toolInput: unknown;
  replyInThread?: boolean;
  locale?: Locale;
}): Record<string, unknown> {
  const locale = input.locale ?? "zh";
  const questions = normalizeAskUserQuestions(input.toolInput);
  // One card, one form: every question is a native select component whose
  // selection lives client-side, so picking/unpicking never round-trips to the
  // server (no card re-render, no collapse, no lag). Changing a choice before
  // submit is the built-in "undo". Everything resolves on a single Submit.
  const formElements: unknown[] = [];
  questions.forEach((question, index) => {
    if (index > 0) {
      formElements.push({ tag: "hr" });
    }
    const multiHint = question.multiSelect ? (locale === "en" ? " (multi-select)" : "（多选）") : "";
    formElements.push({
      tag: "markdown",
      content: `**${question.header}${multiHint}**\n${question.question}`,
    });
    const lines = question.options
      .map((option, optionIndex) => {
        const marker = optionMarker(optionIndex);
        return option.description
          ? `${marker}. **${option.label}** — ${option.description}`
          : `${marker}. **${option.label}**`;
      })
      .join("\n");
    if (lines) {
      formElements.push({ tag: "markdown", content: lines, text_size: "notation" });
    }
    const selectOptions = question.options.map((option) => ({
      text: { tag: "plain_text", content: option.label },
      value: option.label,
    }));
    formElements.push({
      tag: question.multiSelect ? "multi_select_static" : "select_static",
      name: askFormFieldName(index),
      // Single-select questions must be answered; Feishu blocks submit until a
      // value is chosen. Multi-select stays optional (selecting none is valid).
      ...(question.multiSelect ? {} : { required: true }),
      placeholder: {
        tag: "plain_text",
        content: question.multiSelect
          ? (locale === "en" ? "Select one or more" : "可多选")
          : (locale === "en" ? "Select one" : "请选择"),
      },
      options: selectOptions,
    });
  });

  formElements.push({
    tag: "button",
    text: { tag: "plain_text", content: locale === "en" ? "Submit" : "提交" },
    type: "primary",
    width: "fill",
    form_action_type: "submit",
    behaviors: [callbackBehavior({
      cctb_lark: "ask_user_question",
      action: "form_submit",
      requestId: input.requestId,
      ...(input.replyInThread ? { replyInThread: true } : {}),
    })],
  });

  const title = questions.length > 1
    ? (locale === "en" ? `${questions.length} questions` : `${questions.length} 个问题`)
    : (questions[0]?.header || (locale === "en" ? "Question" : "请选择"));

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: locale === "en" ? "Claude is asking a question" : "Claude 请求选择",
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        {
          tag: "form",
          name: "askq_form",
          elements: formElements,
        },
      ],
    },
  };
}

/** Read-only terminal card shown after the form is submitted (no inputs/buttons). */
function renderLarkAskUserQuestionSubmittedCard(
  toolInput: unknown,
  answers: Record<string, string>,
  locale: Locale,
): Record<string, unknown> {
  const questions = normalizeAskUserQuestions(toolInput);
  const none = locale === "en" ? "(none)" : "（未选）";
  const lines = questions
    .map((question) => {
      const answer = (answers[question.question] ?? "").trim();
      return `**${question.header}**: ${answer || none}`;
    })
    .join("\n");
  const title = locale === "en" ? "Submitted" : "已提交";
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: `✅ ${title}` } },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [{ tag: "markdown", content: lines || none }],
    },
  };
}

function renderLarkAskUserQuestionFallbackText(toolInput: unknown, locale: Locale, questionIndex = 0): string {
  const questions = normalizeAskUserQuestions(toolInput);
  const question = questions[questionIndex] ?? questions[0];
  if (!question) {
    return locale === "en" ? "Claude is asking a question." : "Claude 需要你选择。";
  }
  const options = question.options
    .map((option, index) => {
      const description = option.description ? ` — ${option.description}` : "";
      return `${optionMarker(index)}. ${option.label}${description}`;
    })
    .join("\n");
  return [`**${question.header}**`, question.question, options].filter(Boolean).join("\n");
}

function normalizeAskUserQuestions(toolInput: unknown): AskUserQuestionCardQuestion[] {
  const root = objectValue(toolInput);
  const rawQuestions = Array.isArray(root?.questions) ? root.questions : [];
  return rawQuestions
    .map((entry): AskUserQuestionCardQuestion | null => {
      const question = objectValue(entry);
      if (!question) {
        return null;
      }
      const text = stringValue(question.question);
      const options = Array.isArray(question.options)
        ? question.options
          .map((option): AskUserQuestionOption | null => {
            const optionObject = objectValue(option);
            if (!optionObject && typeof option !== "string") {
              return null;
            }
            const label = typeof option === "string" ? option : stringValue(optionObject?.label) ?? stringValue(optionObject?.value);
            if (!label) {
              return null;
            }
            return {
              label,
              ...(stringValue(optionObject?.description) ? { description: stringValue(optionObject?.description) } : {}),
              ...(stringValue(optionObject?.preview) ? { preview: stringValue(optionObject?.preview) } : {}),
            };
          })
          .filter((option): option is AskUserQuestionOption => option !== null)
        : [];
      if (!text || options.length === 0) {
        return null;
      }
      return {
        question: text,
        header: stringValue(question.header) ?? "Question",
        // The live can_use_tool payload may snake_case the flag; accept both so
        // multi-select questions are not silently rendered as single-select.
        multiSelect: question.multiSelect === true || question.multi_select === true,
        options,
      };
    })
    .filter((question): question is AskUserQuestionCardQuestion => question !== null);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionMarker(index: number): string {
  if (index >= 0 && index < 26) {
    return String.fromCharCode("A".charCodeAt(0) + index);
  }
  return String(index + 1);
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "callback",
    value,
  };
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
  instanceName?: string;
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
      form_value?: unknown;
      formValue?: unknown;
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

  if (value.cctb_lark === "noop") {
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

    const notice = await applyLarkConfigCardAction(input.stateDir, value, locale, actionFormValue(input.event.action));
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
      try {
        await input.channel.updateCard(input.event.messageId, card);
      } catch {
        await sendLarkCardWithFallback({
          channel: input.channel,
          chatId: input.event.chatId,
          card,
          fallbackText: notice,
          options: larkReplyOptions(input.event.messageId, replyInThread),
          locale,
        });
      }
    } else {
      await sendLarkCardWithFallback({
        channel: input.channel,
        chatId: input.event.chatId,
        card,
        fallbackText: notice,
        options: larkReplyOptions(input.event.messageId, replyInThread),
        locale,
      });
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

  if (value.cctb_lark === "resume_scan" && typeof value.conversationKey === "string") {
    if (!input.stateDir) {
      return false;
    }
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
      action: "resume",
    })) {
      return true;
    }
    const cfg = await loadInstanceConfig(input.stateDir);
    const kind = cfg.engine === "antigravity" ? "antigravity" : "claude";
    const sessions = kind === "antigravity"
      ? await scanRecentAntigravityConversations(24)
      : cfg.engine === "claude"
        ? await scanRecentClaudeSessions(1)
        : [];
    const card = renderLarkResumeScanCard({
      kind,
      sessions,
      locale,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
    });
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: input.event.chatId,
      card,
      fallbackText: locale === "en" ? "Recent sessions are available, but the resume card could not be displayed." : "已找到最近 session，但恢复卡片无法显示。",
      options: larkReplyOptions(input.event.messageId, replyInThread),
      locale,
    });
    return true;
  }

  if (
    value.cctb_lark === "resume" &&
    typeof value.conversationKey === "string" &&
    typeof value.sessionId === "string" &&
    (value.engine === "claude" || value.engine === "antigravity")
  ) {
    if (!input.stateDir) {
      return false;
    }
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
      replyInThread,
      action: "resume",
    })) {
      return true;
    }
    const result = await applyLarkResumeCardAction(input.stateDir, value, locale);
    await input.channel.send(input.event.chatId, { text: result }, larkReplyOptions(input.event.messageId, replyInThread));
    return true;
  }

  if (
    value.cctb_lark === "ask_user_question" &&
    typeof value.requestId === "string"
  ) {
    const pending = input.runtime.pendingApprovals.get(value.requestId);
    if (!pending) {
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

    const replyOpts = larkReplyOptions(input.event.messageId, pending.replyInThread ?? replyInThread);
    const questions = normalizeAskUserQuestions(pending.askUserQuestionInput);
    const formValue = actionFormValue(input.event.action) ?? {};

    // The whole form arrives in one submit. Map each question's selected
    // value(s) back to an answer string (single = label, multi = joined labels).
    const joinLabels = (arr: unknown[]): string =>
      arr.filter((entry): entry is string => typeof entry === "string").join(", ");
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      const raw = formValue[askFormFieldName(index)];
      let answer = "";
      if (Array.isArray(raw)) {
        // multi_select_static → array of selected option values.
        answer = joinLabels(raw);
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
          // Some Feishu clients deliver a multi-select value as a JSON string.
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            answer = Array.isArray(parsed) ? joinLabels(parsed) : trimmed;
          } catch {
            answer = trimmed;
          }
        } else {
          answer = trimmed;
        }
      } else {
        answer = stringValue(raw) ?? "";
      }
      answers[question.question] = answer;
    });

    // Backstop for clients that don't enforce the form's `required`: a
    // single-select question must have an answer. Re-prompt without resolving,
    // leaving the form (and the user's other picks) intact.
    const missingRequired = questions.filter(
      (question) => !question.multiSelect && !(answers[question.question] ?? "").trim(),
    );
    if (missingRequired.length > 0) {
      const names = missingRequired.map((question) => question.header).join(locale === "en" ? ", " : "、");
      await input.channel.send(
        input.event.chatId,
        { text: locale === "en" ? `Please choose an answer for: ${names}` : `请先选择：${names}` },
        replyOpts,
      );
      return true;
    }

    const root = objectValue(pending.askUserQuestionInput) ?? {};
    cleanupPendingApproval(input.runtime, value.requestId);
    pending.resolve({
      behavior: "allow",
      updatedInput: {
        ...root,
        questions: Array.isArray(root.questions) ? root.questions : questions,
        answers,
      },
    });

    // Turn the form into a read-only "submitted" card so it no longer looks
    // actionable; fall back to a text summary if the update fails.
    const summary = questions
      .map((question) => `${question.header}: ${answers[question.question] || (locale === "en" ? "—" : "（未选）")}`)
      .join("\n");
    let cardUpdated = false;
    if (input.channel.updateCard) {
      try {
        await input.channel.updateCard(
          input.event.messageId,
          renderLarkAskUserQuestionSubmittedCard(pending.askUserQuestionInput, answers, locale),
        );
        cardUpdated = true;
      } catch {
        // fall through to a text summary
      }
    }
    if (!cardUpdated) {
      await input.channel.send(
        input.event.chatId,
        { text: (locale === "en" ? "Submitted:\n" : "已提交：\n") + summary },
        replyOpts,
      );
    }
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
        instanceName: input.instanceName,
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
        instanceName: input.instanceName,
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

  if (typeof value.cctb_lark === "string") {
    await input.channel.send(
      input.event.chatId,
      { text: renderUnsupportedLarkCardAction(locale) },
      larkReplyOptions(input.event.messageId, replyInThread),
    );
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
  const conversationChatId = stableLarkNumericId(input.conversationKey);
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
    conversationChatId,
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
  instanceName?: string;
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
  const cfg = await loadInstanceConfig(input.stateDir);
  const workspaceOverride = resolveInstanceWorkspacePath(cfg);
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
          workspaceOverride,
          conversationKey: input.conversationKey,
          bridgeChatType: input.bridgeChatType,
          bridgeChatId,
          bridgeUserId: input.userId,
          larkMessageId: input.replyTo,
          instanceName: input.instanceName,
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
      workspaceOverride,
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
      workspaceOverride,
      conversationKey: input.conversationKey,
      bridgeChatType: input.bridgeChatType,
      bridgeChatId,
      bridgeUserId: input.userId,
      larkMessageId: input.replyTo,
      instanceName: input.instanceName,
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
  instanceName?: string;
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
  const cfg = await loadInstanceConfig(input.stateDir);
  const workspaceOverride = resolveInstanceWorkspacePath(cfg);
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
          workspaceOverride,
          conversationKey: input.conversationKey,
          bridgeChatType: input.bridgeChatType,
          bridgeChatId,
          bridgeUserId: input.userId,
          larkMessageId: input.replyTo,
          instanceName: input.instanceName,
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
      workspaceOverride,
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
      workspaceOverride,
      conversationKey: input.conversationKey,
      bridgeChatType: input.bridgeChatType,
      bridgeChatId,
      bridgeUserId: input.userId,
      larkMessageId: input.replyTo,
      instanceName: input.instanceName,
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

type LarkCardActionTimelineAction = "stop" | "approval" | "choice" | "continue_archive" | "config" | "resume";

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

  const approveSessionById = trimmed.match(/^\/approve-session\s+([A-Za-z0-9_-]+)$/i);
  if (approveSessionById) {
    return {
      kind: "id",
      requestId: approveSessionById[1]!,
      choice: "session",
    };
  }

  const approveById = trimmed.match(/^\/approve\s+([A-Za-z0-9_-]+)$/i);
  if (approveById && !/^(?:session|turn|always)$/i.test(approveById[1]!)) {
    return {
      kind: "id",
      requestId: approveById[1]!,
      choice: "once",
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

function renderUnsupportedLarkCardAction(locale: Locale): string {
  return locale === "en"
    ? "This card action is no longer active or is not supported by the current bot version. Please send a new message to continue."
    : "这张卡片的操作已不再有效，或当前机器人版本不支持。请发送新消息继续。";
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

async function applyLarkResumeCardAction(
  stateDir: string,
  value: Record<string, unknown>,
  locale: Locale,
): Promise<string> {
  const conversationKey = String(value.conversationKey);
  const engine = value.engine === "antigravity" ? "antigravity" : "claude";
  const sessionId = String(value.sessionId);
  const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
  const cfg = await loadInstanceConfig(stateDir);
  const existing = await sessionStore.findByConversationKeySafe(conversationKey);
  const currentResume = cfg.resume;
  await sessionStore.upsert({
    telegramChatId: stableLarkNumericId(conversationKey),
    conversationKey,
    codexSessionId: sessionId,
    status: "idle",
    updatedAt: new Date().toISOString(),
    suspendedPrevious: buildSuspendedPreviousSnapshot({
      existingRecord: existing.record,
      currentResume,
    }),
  });

  if (engine === "claude") {
    const workspacePath = typeof value.workspacePath === "string" && value.workspacePath.trim()
      ? value.workspacePath
      : null;
    if (!workspacePath) {
      return locale === "en"
        ? "Cannot resume this session because its workspace path is unknown."
        : "无法恢复这个 session：工作区路径未知。";
    }
    await updateInstanceConfig(stateDir, (config) => {
      config.resume = {
        sessionId,
        dirName: typeof value.dirName === "string" ? value.dirName : sessionId,
        workspacePath,
      };
    });
    const displayName = typeof value.displayName === "string" ? value.displayName : sessionId;
    return locale === "en"
      ? `Resumed session: ${displayName}\nWorkspace: ${workspacePath}\n\nSend a message to continue. Use /detach when done.`
      : `已恢复 session：${displayName}\n工作区：${workspacePath}\n\n发送消息继续对话，完成后发 /detach 断开。`;
  }

  await updateInstanceConfig(stateDir, (config) => {
    delete config.resume;
  });
  return locale === "en"
    ? `Attached Antigravity conversation: ${sessionId}\n\nSend a message to continue. Use /detach when done.`
    : `已绑定 Antigravity conversation：${sessionId}\n\n发送消息继续对话，完成后发 /detach 断开。`;
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

function actionFormValue(action: { form_value?: unknown; formValue?: unknown }): Record<string, unknown> | undefined {
  const raw = action.form_value ?? action.formValue;
  return actionValue(raw) ?? undefined;
}

function actionValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
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
