import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import type { EngineApprovalDecision, EngineApprovalRequest } from "../codex/adapter.js";
import type { InlineKeyboardButton, TelegramApi } from "./api.js";
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "./approval-timeouts.js";
import { getNormalizedTelegramConversationKey, getTelegramConversationKey } from "./conversation-key.js";
import type { Locale } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type ApprovalApi = Pick<TelegramApi, "sendMessage" | "answerCallbackQuery"> & Partial<Pick<TelegramApi, "editMessage">>;
type ApprovalChoice = "once" | "session" | "deny";
type ApprovalSelection =
  | { kind: "approval"; choice: ApprovalChoice }
  | { kind: "answer"; questionIndex?: number; index: number }
  | { kind: "toggle"; questionIndex: number; index: number }
  | { kind: "submit"; questionIndex: number };

interface ApprovalQuestionItem {
  answerKey: string;
  header?: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

interface ApprovalQuestion {
  /** The full original tool input, spread back into updatedInput on resolve. */
  root: Record<string, unknown>;
  items: ApprovalQuestionItem[];
  currentIndex: number;
  answers: Record<string, string>;
  selectedIndices: Set<number>;
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
  const items: ApprovalQuestionItem[] = [];
  const answerKeys = new Set<string>();
  for (const value of questions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiSelect?: unknown;
      multi_select?: unknown;
    };
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option === "string") {
            return option.trim() ? [option.trim()] : [];
          }
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const label = (option as { label?: unknown }).label;
          return typeof label === "string" && label.trim() ? [label.trim()] : [];
        })
      : [];
    if (!question || options.length === 0 || answerKeys.has(question)) {
      return undefined;
    }
    answerKeys.add(question);
    const header = typeof record.header === "string" && record.header.trim()
      ? record.header.trim()
      : undefined;
    items.push({
      // Claude's AskUserQuestion contract keys `answers` by the full question
      // text. Kimi consumes the selected value from the same map.
      answerKey: question,
      header,
      question,
      options,
      multiSelect: record.multiSelect === true || record.multi_select === true,
    });
  }
  const root = { ...(input as Record<string, unknown>) };
  const existingAnswers = root.answers && typeof root.answers === "object" && !Array.isArray(root.answers)
    ? Object.fromEntries(Object.entries(root.answers as Record<string, unknown>).flatMap(([key, value]) => (
        typeof value === "string" ? [[key, value]] : []
      )))
    : {};
  return {
    root,
    items,
    currentIndex: 0,
    answers: existingAnswers,
    selectedIndices: new Set<number>(),
  };
}

function currentApprovalQuestion(question: ApprovalQuestion): ApprovalQuestionItem {
  return question.items[question.currentIndex]!;
}

function renderQuestionPrompt(
  engine: EngineApprovalRequest["engine"],
  locale: Locale,
  question: ApprovalQuestion,
): string {
  const item = currentApprovalQuestion(question);
  const engineName = renderEngineRequestName(engine);
  const progress = question.items.length > 1
    ? locale === "zh"
      ? `问题 ${question.currentIndex + 1}/${question.items.length}`
      : `Question ${question.currentIndex + 1}/${question.items.length}`
    : undefined;
  const title = item.header && item.header !== item.question ? item.header : undefined;
  const options = item.options.map((option, index) => {
    const selected = item.multiSelect && question.selectedIndices.has(index) ? "✓ " : "";
    return `${index + 1}. ${selected}${option}`;
  });
  const instruction = item.multiSelect
    ? locale === "zh" ? "可多选；选好后点击“提交选择”。" : "Select one or more, then tap Submit."
    : undefined;
  return [
    locale === "zh" ? `${engineName} 需要你的选择。` : `${engineName} needs your input.`,
    progress,
    "",
    title,
    item.question,
    "",
    ...options,
    instruction ? "" : undefined,
    instruction,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderQuestionKeyboard(id: string, locale: Locale, question: ApprovalQuestion) {
  const item = currentApprovalQuestion(question);
  const questionIndex = question.currentIndex;
  const rows = item.options.map((option, index) => [{
    text: buttonLabel(`${question.selectedIndices.has(index) ? "✓ " : ""}${option}`),
    callbackData: item.multiSelect
      ? `approval:${id}:toggle:${questionIndex}:${index}`
      : `approval:${id}:answer:${questionIndex}:${index}`,
  }]);
  if (item.multiSelect) {
    rows.push([{
      text: locale === "zh"
        ? `提交选择 (${question.selectedIndices.size})`
        : `Submit (${question.selectedIndices.size})`,
      callbackData: `approval:${id}:submit:${questionIndex}`,
    }]);
  }
  rows.push([{ text: locale === "zh" ? "跳过" : "Skip", callbackData: `approval:${id}:deny` }]);
  return rows;
}

function renderApprovalPrompt(
  request: EngineApprovalRequest,
  locale: Locale,
): string {
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

function renderAnswersSubmittedMessage(locale: Locale, engine: EngineApprovalRequest["engine"]): string {
  const engineName = renderEngineResumeName(engine);
  return locale === "zh"
    ? `答案已提交，${engineName} 正在继续...`
    : `Answers submitted. ${engineName} is resuming...`;
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

function settlePending(pending: PendingApproval, decision: EngineApprovalDecision): void {
  cleanupPending(pending);
  pending.resolve(decision);
}

type QuestionSelectionResult =
  | { kind: "invalid" }
  | { kind: "progress" }
  | { kind: "complete"; answer: string; decision: EngineApprovalDecision };

function applyQuestionSelection(
  question: ApprovalQuestion,
  selection: Exclude<ApprovalSelection, { kind: "approval" }>,
): QuestionSelectionResult {
  const questionIndex = selection.kind === "answer"
    ? selection.questionIndex ?? question.currentIndex
    : selection.questionIndex;
  if (questionIndex !== question.currentIndex) {
    return { kind: "invalid" };
  }
  const item = currentApprovalQuestion(question);

  if (selection.kind === "toggle") {
    if (!item.multiSelect || !item.options[selection.index]) {
      return { kind: "invalid" };
    }
    if (question.selectedIndices.has(selection.index)) {
      question.selectedIndices.delete(selection.index);
    } else {
      question.selectedIndices.add(selection.index);
    }
    return { kind: "progress" };
  }

  let answer: string | undefined;
  if (selection.kind === "submit") {
    if (!item.multiSelect || question.selectedIndices.size === 0) {
      return { kind: "invalid" };
    }
    answer = [...question.selectedIndices]
      .sort((left, right) => left - right)
      .map((index) => item.options[index])
      .filter((option): option is string => option !== undefined)
      .join(", ");
  } else {
    if (item.multiSelect) {
      return { kind: "invalid" };
    }
    answer = item.options[selection.index];
  }
  if (!answer) {
    return { kind: "invalid" };
  }

  question.answers[item.answerKey] = answer;
  if (question.currentIndex + 1 < question.items.length) {
    question.currentIndex += 1;
    question.selectedIndices.clear();
    return { kind: "progress" };
  }

  return {
    kind: "complete",
    answer,
    decision: {
      behavior: "allow",
      scope: "once",
      // updatedInput replaces the tool input in Claude's canUseTool callback,
      // so retain the original questions and merge every collected answer.
      updatedInput: { ...question.root, answers: { ...question.answers } },
    },
  };
}

function pendingConversationKey(pending: Pick<PendingApproval, "chatId" | "messageThreadId">): string {
  return getTelegramConversationKey(pending.chatId, pending.messageThreadId);
}

function sendPendingMessage(
  api: ApprovalApi,
  pending: PendingApproval,
  message: string,
  inlineKeyboard?: InlineKeyboardButton[][] | null,
) {
  if (inlineKeyboard === undefined && pending.messageThreadId === undefined) {
    return api.sendMessage(pending.chatId, message);
  }
  return api.sendMessage(pending.chatId, message, {
    ...(inlineKeyboard !== undefined ? { inlineKeyboard } : {}),
    ...(pending.messageThreadId !== undefined ? { messageThreadId: pending.messageThreadId } : {}),
  });
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
  const internal = trimmed.match(
    /^\/approval(?:@\w+)?\s+([A-Za-z0-9_-]+)\s+(once|session|deny|answer-\d+(?:-\d+)?|toggle-\d+-\d+|submit-\d+)$/i,
  );
  if (internal) {
    const value = internal[2]!.toLowerCase();
    let selection: ApprovalSelection;
    if (value.startsWith("answer-")) {
      const indices = value.slice("answer-".length).split("-").map((part) => Number.parseInt(part, 10));
      selection = indices.length === 1
        ? { kind: "answer", index: indices[0]! }
        : { kind: "answer", questionIndex: indices[0]!, index: indices[1]! };
    } else if (value.startsWith("toggle-")) {
      const [questionIndex, index] = value.slice("toggle-".length).split("-").map((part) => Number.parseInt(part, 10));
      selection = { kind: "toggle", questionIndex: questionIndex!, index: index! };
    } else if (value.startsWith("submit-")) {
      selection = { kind: "submit", questionIndex: Number.parseInt(value.slice("submit-".length), 10) };
    } else {
      selection = { kind: "approval", choice: value as ApprovalChoice };
    }
    return {
      kind: "id",
      id: internal[1]!,
      selection,
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
      ? renderQuestionKeyboard(id, input.locale, question)
      : [
          [
            { text: input.locale === "zh" ? "允许一次" : "Allow Once", callbackData: `approval:${id}:once` },
            { text: input.locale === "zh" ? "本轮允许" : "Allow This Turn", callbackData: `approval:${id}:session` },
          ],
          [{ text: input.locale === "zh" ? "拒绝" : "Deny", callbackData: `approval:${id}:deny` }],
        ];
    const prompt = question
      ? renderQuestionPrompt(input.request.engine, input.locale, question)
      : renderApprovalPrompt(input.request, input.locale);
    pending.promptSent = input.api.sendMessage(input.chatId, prompt, {
      inlineKeyboard,
      ...(input.messageThreadId !== undefined ? { messageThreadId: input.messageThreadId } : {}),
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
  message: string,
): Promise<void> {
  await pending.promptSent?.catch(() => undefined);

  if (api.editMessage && pending.promptMessageId !== undefined) {
    try {
      await api.editMessage(pending.chatId, pending.promptMessageId, message, { inlineKeyboard: null });
      return;
    } catch {
      // Fall back to a new message if Telegram refuses to edit the original prompt.
    }
  }

  await sendPendingMessage(api, pending, message);
}

async function deliverQuestionProgress(api: ApprovalApi, pending: PendingApproval): Promise<void> {
  const question = pending.question;
  if (!question) {
    return;
  }
  await pending.promptSent?.catch(() => undefined);
  const message = renderQuestionPrompt(pending.engine, pending.locale, question);
  const inlineKeyboard = renderQuestionKeyboard(pending.id, pending.locale, question);

  if (api.editMessage && pending.promptMessageId !== undefined) {
    try {
      await api.editMessage(pending.chatId, pending.promptMessageId, message, { inlineKeyboard });
      return;
    } catch {
      // Fall back to a fresh prompt, then bind subsequent edits to that message.
    }
  }

  const sent = await sendPendingMessage(api, pending, message, inlineKeyboard);
  pending.promptMessageId = sent.message_id;
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

  await sendPendingMessage(api, pending, message);
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

  if (pending.question) {
    if (parsed.selection.kind === "approval") {
      if (parsed.selection.choice !== "deny") {
        await sendPendingMessage(
          input.api,
          pending,
          pending.locale === "zh" ? "请点击问题中的选项按钮。" : "Choose one of the question buttons.",
        );
        return true;
      }
      settlePending(pending, { behavior: "deny" });
      await deliverApprovalResolution(
        input.api,
        pending,
        renderResolvedMessage("deny", pending.locale, pending.engine),
      );
      return true;
    }

    const singleAnswer = pending.question.items.length === 1
      && !currentApprovalQuestion(pending.question).multiSelect;
    const result = applyQuestionSelection(pending.question, parsed.selection);
    if (result.kind === "invalid" || result.kind === "progress") {
      await deliverQuestionProgress(input.api, pending);
      return true;
    }

    settlePending(pending, result.decision);
    await deliverApprovalResolution(
      input.api,
      pending,
      singleAnswer
        ? renderAnsweredMessage(result.answer, pending.locale, pending.engine)
        : renderAnswersSubmittedMessage(pending.locale, pending.engine),
    );
    return true;
  }

  if (parsed.selection.kind !== "approval") {
    await input.api.sendMessage(input.normalized.chatId, "No pending question.");
    return true;
  }
  const decision: EngineApprovalDecision = parsed.selection.choice === "deny"
    ? { behavior: "deny" }
    : { behavior: "allow", scope: parsed.selection.choice };
  settlePending(pending, decision);
  await deliverApprovalResolution(
    input.api,
    pending,
    renderResolvedMessage(parsed.selection.choice, pending.locale, pending.engine),
  );
  return true;
}

export function clearPendingTelegramApprovalsForTest(): void {
  for (const pending of pendingApprovals.values()) {
    cleanupPending(pending);
  }
}
