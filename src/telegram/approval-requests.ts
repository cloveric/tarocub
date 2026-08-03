import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import type { EngineApprovalDecision, EngineApprovalRequest } from "../codex/adapter.js";
import type { TelegramApi } from "./api.js";
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "./approval-timeouts.js";
import { getNormalizedTelegramConversationKey, getTelegramConversationKey } from "./conversation-key.js";
import type { Locale } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type ApprovalApi = Pick<TelegramApi, "sendMessage" | "answerCallbackQuery"> & Partial<Pick<TelegramApi, "editMessage">>;
type ApprovalChoice = "once" | "session" | "deny";
type ApprovalSelection =
  | { kind: "approval"; choice: ApprovalChoice }
  | { kind: "answer"; index: number };

interface ApprovalQuestion {
  answerKey: string;
  question: string;
  options: string[];
  /** The full original tool input, spread back into updatedInput on resolve. */
  root: Record<string, unknown>;
}

interface PendingApproval {
  id: string;
  chatId: number;
  messageThreadId?: number;
  userId: number;
  locale: Locale;
  engine: EngineApprovalRequest["engine"];
  question?: ApprovalQuestion;
  resolve: (decision: EngineApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  promptMessageId?: number;
  promptSent?: Promise<void>;
}

const pendingApprovals = new Map<string, PendingApproval>();

function renderEngineRequestName(engine: EngineApprovalRequest["engine"]): string {
  if (engine === "codex") return "Codex";
  if (engine === "kimi") return "Kimi Code";
  if (engine === "antigravity") return "Antigravity";
  return "Claude Code";
}

function renderEngineResumeName(engine: EngineApprovalRequest["engine"]): string {
  if (engine === "codex") return "Codex";
  if (engine === "kimi") return "Kimi";
  if (engine === "antigravity") return "Antigravity";
  return "Claude";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 20)}\n... [truncated]`;
}

function buttonLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}

function renderToolInputPreview(request: EngineApprovalRequest): string {
  const input = request.toolInput;
  if (
    request.toolName === "Bash" &&
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof (input as { command?: unknown }).command === "string"
  ) {
    const bashInput = input as { command: string; description?: unknown };
    const description = typeof bashInput.description === "string"
      ? `\nReason: ${bashInput.description}`
      : "";
    return `${bashInput.command}${description}`;
  }

  return inspect(input, {
    depth: 4,
    maxArrayLength: 20,
    breakLength: 100,
    compact: false,
  });
}

function extractApprovalQuestion(request: EngineApprovalRequest): ApprovalQuestion | undefined {
  if (request.toolName !== "AskUserQuestion") {
    return undefined;
  }
  const input = request.toolInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  if (questions.length > 1) {
    // The inline-button prompt can render exactly one question. Truncating a
    // multi-question ask to its first question silently dropped the rest, so a
    // multi-question input falls back to the generic Allow/Deny pre-approval,
    // which passes the ORIGINAL input through untouched and lets the engine
    // collect answers itself. (The Lark form card handles all questions; a
    // Telegram multi-question form is future work, not a truncation.)
    return undefined;
  }
  const first = questions[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }
  const record = first as { question?: unknown; header?: unknown; options?: unknown };
  const question = typeof record.question === "string" ? record.question.trim() : "";
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) {
          return [];
        }
        const label = (option as { label?: unknown }).label;
        return typeof label === "string" && label.trim() ? [label.trim()] : [];
      })
    : [];
  if (!question || options.length === 0) {
    return undefined;
  }
  const header = typeof record.header === "string" ? record.header.trim() : "";
  return {
    // Claude's AskUserQuestion contract keys `answers` by the full question
    // text. Kimi only consumes the selected value, so the same shape works for
    // both engines without making a display-only header part of the protocol.
    answerKey: question,
    question,
    options,
    root: { ...(input as Record<string, unknown>) },
  };
}

function renderApprovalPrompt(
  request: EngineApprovalRequest,
  locale: Locale,
  question?: ApprovalQuestion,
): string {
  if (question) {
    const engineName = renderEngineRequestName(request.engine);
    const options = question.options.map((option, index) => `${index + 1}. ${option}`);
    return locale === "zh"
      ? [`${engineName} 需要你的选择。`, "", question.question, "", ...options].join("\n")
      : [`${engineName} needs your input.`, "", question.question, "", ...options].join("\n");
  }
  const preview = truncate(renderToolInputPreview(request), 2600);
  const engineName = renderEngineRequestName(request.engine);
  const codexFullAutoNotice = request.engine === "codex"
    ? locale === "zh"
      ? "允许后，本次 Codex turn 会以 full-auto 继续执行；本 turn 内后续工具调用不会再次询问。"
      : "Approving lets this Codex turn continue in full-auto mode; later tool calls in this turn will not ask again."
    : undefined;
  if (locale === "zh") {
    return [
      `${engineName} 请求执行需要审批的操作。`,
      codexFullAutoNotice,
      "",
      `工具: ${request.toolName}`,
      request.cwd ? `目录: ${request.cwd}` : undefined,
      "",
      preview,
      "",
      "请选择：允许一次、本轮允许，或拒绝。",
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  return [
    `${engineName} is requesting permission.`,
    codexFullAutoNotice,
    "",
    `Tool: ${request.toolName}`,
    request.cwd ? `Cwd: ${request.cwd}` : undefined,
    "",
    preview,
    "",
    "Choose: allow once, allow for this turn, or deny.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderResolvedMessage(choice: ApprovalChoice, locale: Locale, engine: EngineApprovalRequest["engine"]): string {
  const engineName = renderEngineResumeName(engine);
  if (choice === "deny") {
    return locale === "zh" ? "已拒绝。" : "Denied.";
  }

  if (choice === "session") {
    return locale === "zh"
      ? `已允许本轮，${engineName} 正在继续...`
      : `Approved for this turn. ${engineName} is resuming...`;
  }

  return locale === "zh"
    ? `已允许一次，${engineName} 正在继续...`
    : `Approved once. ${engineName} is resuming...`;
}

function renderAnsweredMessage(answer: string, locale: Locale, engine: EngineApprovalRequest["engine"]): string {
  const engineName = renderEngineResumeName(engine);
  return locale === "zh"
    ? `已选择“${answer}”，${engineName} 正在继续...`
    : `Selected “${answer}”. ${engineName} is resuming...`;
}

function renderExpiredMessage(locale: Locale): string {
  return locale === "zh" ? "审批已过期（已拒绝）。" : "Approval expired (denied).";
}

function renderCanceledMessage(locale: Locale): string {
  return locale === "zh" ? "审批已取消（已拒绝）。" : "Approval canceled (denied).";
}

function cleanupPending(pending: PendingApproval): void {
  pendingApprovals.delete(pending.id);
  clearTimeout(pending.timer);
  if (pending.abortSignal && pending.abortHandler) {
    pending.abortSignal.removeEventListener("abort", pending.abortHandler);
  }
}

function resolvePending(pending: PendingApproval, selection: ApprovalSelection): EngineApprovalDecision {
  cleanupPending(pending);
  let decision: EngineApprovalDecision;
  if (selection.kind === "answer") {
    const answer = pending.question?.options[selection.index];
    decision = answer && pending.question
      ? {
          behavior: "allow",
          scope: "once",
          // updatedInput REPLACES the tool input (claude-stream-adapter
          // forwards it verbatim to canUseTool), so it must carry the original
          // fields — resolving with a bare {answers} stripped `questions` from
          // the input the CLI then executed. Same shape the Lark card resolves.
          updatedInput: { ...pending.question.root, answers: { [pending.question.answerKey]: answer } },
        }
      : { behavior: "deny" };
  } else {
    decision = selection.choice === "deny"
      ? { behavior: "deny" }
      : { behavior: "allow", scope: selection.choice };
  }
  pending.resolve(decision);
  return decision;
}

function pendingConversationKey(pending: Pick<PendingApproval, "chatId" | "messageThreadId">): string {
  return getTelegramConversationKey(pending.chatId, pending.messageThreadId);
}

function findOldestPendingForConversationAndUser(
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
): PendingApproval | undefined {
  const conversationKey = getTelegramConversationKey(chatId, messageThreadId);
  return [...pendingApprovals.values()].find(
    (pending) => pendingConversationKey(pending) === conversationKey && pending.userId === userId,
  );
}

function parseApprovalCommand(text: string):
  | { kind: "id"; id: string; selection: ApprovalSelection }
  | { kind: "chat"; selection: ApprovalSelection }
  | null {
  const trimmed = text.trim();
  const internal = trimmed.match(/^\/approval(?:@\w+)?\s+([A-Za-z0-9_-]+)\s+(once|session|deny|answer-(\d+))$/i);
  if (internal) {
    const value = internal[2]!.toLowerCase();
    return {
      kind: "id",
      id: internal[1]!,
      selection: value.startsWith("answer-")
        ? { kind: "answer", index: Number.parseInt(internal[3]!, 10) }
        : { kind: "approval", choice: value as ApprovalChoice },
    };
  }

  const approve = trimmed.match(/^\/approve(?:@\w+)?(?:\s+(.+))?$/i);
  if (approve) {
    const args = approve[1]?.toLowerCase() ?? "";
    return {
      kind: "chat",
      selection: {
        kind: "approval",
        choice: /\b(?:session|turn|always)\b/i.test(args) ? "session" : "once",
      },
    };
  }

  const denyById = trimmed.match(/^\/deny(?:@\w+)?\s+([A-Za-z0-9_-]+)$/i);
  if (denyById) {
    return {
      kind: "id",
      id: denyById[1]!,
      selection: { kind: "approval", choice: "deny" },
    };
  }

  if (/^\/deny(?:@\w+)?(?:\s|$)/i.test(trimmed)) {
    return {
      kind: "chat",
      selection: { kind: "approval", choice: "deny" },
    };
  }

  return null;
}

export function isTelegramApprovalCommand(text: string): boolean {
  return parseApprovalCommand(text) !== null;
}

export async function requestTelegramApproval(input: {
  api: ApprovalApi;
  chatId: number;
  messageThreadId?: number;
  userId: number;
  locale: Locale;
  request: EngineApprovalRequest;
  abortSignal?: AbortSignal;
}): Promise<EngineApprovalDecision> {
  if (input.abortSignal?.aborted) {
    return { behavior: "deny" };
  }

  const id = randomUUID();
  const question = extractApprovalQuestion(input.request);
  return await new Promise<EngineApprovalDecision>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingApprovals.get(id);
      if (!pending) {
        return;
      }
      cleanupPending(pending);
      pending.resolve({ behavior: "deny" });
      void deliverApprovalExpiration(input.api, pending).catch(() => undefined);
    }, TELEGRAM_APPROVAL_TIMEOUT_MS);

    const pending: PendingApproval = {
      id,
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      userId: input.userId,
      locale: input.locale,
      engine: input.request.engine,
      question,
      resolve,
      reject,
      timer,
      abortSignal: input.abortSignal,
    };

    if (input.abortSignal) {
      pending.abortHandler = () => {
        cleanupPending(pending);
        resolve({ behavior: "deny" });
        void deliverApprovalCancellation(input.api, pending).catch(() => undefined);
      };
      input.abortSignal.addEventListener("abort", pending.abortHandler, { once: true });
    }

    pendingApprovals.set(id, pending);

    const inlineKeyboard = question
      ? [
          ...question.options.map((option, index) => [{
            text: buttonLabel(option),
            callbackData: `approval:${id}:answer:${index}`,
          }]),
          [{ text: input.locale === "zh" ? "跳过" : "Skip", callbackData: `approval:${id}:deny` }],
        ]
      : [
          [
            { text: input.locale === "zh" ? "允许一次" : "Allow Once", callbackData: `approval:${id}:once` },
            { text: input.locale === "zh" ? "本轮允许" : "Allow This Turn", callbackData: `approval:${id}:session` },
          ],
          [{ text: input.locale === "zh" ? "拒绝" : "Deny", callbackData: `approval:${id}:deny` }],
        ];
    pending.promptSent = input.api.sendMessage(input.chatId, renderApprovalPrompt(input.request, input.locale, question), {
      inlineKeyboard,
    }).then((message) => {
      pending.promptMessageId = message.message_id;
    }).catch((error) => {
      cleanupPending(pending);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function deliverApprovalResolution(
  api: ApprovalApi,
  pending: PendingApproval,
  selection: ApprovalSelection,
): Promise<void> {
  const answer = selection.kind === "answer" ? pending.question?.options[selection.index] : undefined;
  const message = answer
    ? renderAnsweredMessage(answer, pending.locale, pending.engine)
    : renderResolvedMessage(
        selection.kind === "approval" ? selection.choice : "deny",
        pending.locale,
        pending.engine,
      );
  await pending.promptSent?.catch(() => undefined);

  if (api.editMessage && pending.promptMessageId !== undefined) {
    try {
      await api.editMessage(pending.chatId, pending.promptMessageId, message, { inlineKeyboard: null });
      return;
    } catch {
      // Fall back to a new message if Telegram refuses to edit the original prompt.
    }
  }

  await api.sendMessage(pending.chatId, message);
}

async function deliverApprovalExpiration(api: ApprovalApi, pending: PendingApproval): Promise<void> {
  const message = renderExpiredMessage(pending.locale);
  await deliverTerminalApprovalMessage(api, pending, message);
}

async function deliverApprovalCancellation(api: ApprovalApi, pending: PendingApproval): Promise<void> {
  const message = renderCanceledMessage(pending.locale);
  await deliverTerminalApprovalMessage(api, pending, message);
}

async function deliverTerminalApprovalMessage(api: ApprovalApi, pending: PendingApproval, message: string): Promise<void> {
  await pending.promptSent?.catch(() => undefined);

  if (api.editMessage && pending.promptMessageId !== undefined) {
    try {
      await api.editMessage(pending.chatId, pending.promptMessageId, message, { inlineKeyboard: null });
      return;
    } catch {
      // Fall back to a new message if Telegram refuses to edit the original prompt.
    }
  }

  await api.sendMessage(pending.chatId, message);
}

export async function handleTelegramApprovalCommand(input: {
  normalized: NormalizedTelegramMessage;
  api: ApprovalApi;
}): Promise<boolean> {
  const parsed = parseApprovalCommand(input.normalized.text);
  if (!parsed) {
    return false;
  }

  if (input.normalized.callbackQueryId) {
    try {
      await input.api.answerCallbackQuery(input.normalized.callbackQueryId);
    } catch {
      // Callback acknowledgements are advisory; still resolve the approval.
    }
  }

  const pending = parsed.kind === "id"
    ? pendingApprovals.get(parsed.id)
    : findOldestPendingForConversationAndUser(
      input.normalized.chatId,
      input.normalized.messageThreadId,
      input.normalized.userId,
    );

  if (!pending) {
    await input.api.sendMessage(input.normalized.chatId, "No pending approval.");
    return true;
  }

  if (pending.chatId !== input.normalized.chatId) {
    await input.api.sendMessage(input.normalized.chatId, "This approval request belongs to another chat.");
    return true;
  }

  if (pendingConversationKey(pending) !== getNormalizedTelegramConversationKey(input.normalized)) {
    await input.api.sendMessage(input.normalized.chatId, "This approval request belongs to another topic.");
    return true;
  }

  if (pending.userId !== input.normalized.userId) {
    await input.api.sendMessage(input.normalized.chatId, "This approval request belongs to another Telegram user.");
    return true;
  }

  if (pending.question && parsed.selection.kind === "approval" && parsed.selection.choice !== "deny") {
    await input.api.sendMessage(
      input.normalized.chatId,
      pending.locale === "zh" ? "请点击问题中的选项按钮。" : "Choose one of the question buttons.",
    );
    return true;
  }

  resolvePending(pending, parsed.selection);
  await deliverApprovalResolution(input.api, pending, parsed.selection);
  return true;
}

export function clearPendingTelegramApprovalsForTest(): void {
  for (const pending of pendingApprovals.values()) {
    cleanupPending(pending);
  }
}
