import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import type { EngineApprovalDecision, EngineApprovalRequest } from "../codex/adapter.js";
import type { TelegramApi } from "./api.js";
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "./approval-timeouts.js";
import type { Locale } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type ApprovalApi = Pick<TelegramApi, "sendMessage" | "answerCallbackQuery"> & Partial<Pick<TelegramApi, "editMessage">>;
type ApprovalChoice = "once" | "session" | "deny";

interface PendingApproval {
  id: string;
  chatId: number;
  userId: number;
  locale: Locale;
  engine: EngineApprovalRequest["engine"];
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
  return engine === "codex" ? "Codex" : "Claude Code";
}

function renderEngineResumeName(engine: EngineApprovalRequest["engine"]): string {
  return engine === "codex" ? "Codex" : "Claude";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 20)}\n... [truncated]`;
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

function renderApprovalPrompt(request: EngineApprovalRequest, locale: Locale): string {
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

function resolvePending(pending: PendingApproval, choice: ApprovalChoice): EngineApprovalDecision {
  cleanupPending(pending);
  const decision: EngineApprovalDecision = choice === "deny"
    ? { behavior: "deny" }
    : { behavior: "allow", scope: choice };
  pending.resolve(decision);
  return decision;
}

function findOldestPendingForChatAndUser(chatId: number, userId: number): PendingApproval | undefined {
  return [...pendingApprovals.values()].find((pending) => pending.chatId === chatId && pending.userId === userId);
}

function parseApprovalCommand(text: string): { kind: "id"; id: string; choice: ApprovalChoice } | { kind: "chat"; choice: ApprovalChoice } | null {
  const trimmed = text.trim();
  const internal = trimmed.match(/^\/approval(?:@\w+)?\s+([A-Za-z0-9_-]+)\s+(once|session|deny)$/i);
  if (internal) {
    return {
      kind: "id",
      id: internal[1]!,
      choice: internal[2]!.toLowerCase() as ApprovalChoice,
    };
  }

  const approve = trimmed.match(/^\/approve(?:@\w+)?(?:\s+(.+))?$/i);
  if (approve) {
    const args = approve[1]?.toLowerCase() ?? "";
    return {
      kind: "chat",
      choice: /\b(?:session|turn|always)\b/i.test(args) ? "session" : "once",
    };
  }

  const denyById = trimmed.match(/^\/deny(?:@\w+)?\s+([A-Za-z0-9_-]+)$/i);
  if (denyById) {
    return {
      kind: "id",
      id: denyById[1]!,
      choice: "deny",
    };
  }

  if (/^\/deny(?:@\w+)?(?:\s|$)/i.test(trimmed)) {
    return {
      kind: "chat",
      choice: "deny",
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
  userId: number;
  locale: Locale;
  request: EngineApprovalRequest;
  abortSignal?: AbortSignal;
}): Promise<EngineApprovalDecision> {
  if (input.abortSignal?.aborted) {
    return { behavior: "deny" };
  }

  const id = randomUUID();
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
      userId: input.userId,
      locale: input.locale,
      engine: input.request.engine,
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

    pending.promptSent = input.api.sendMessage(input.chatId, renderApprovalPrompt(input.request, input.locale), {
      inlineKeyboard: [
        [
          { text: input.locale === "zh" ? "允许一次" : "Allow Once", callbackData: `approval:${id}:once` },
          { text: input.locale === "zh" ? "本轮允许" : "Allow This Turn", callbackData: `approval:${id}:session` },
        ],
        [
          { text: input.locale === "zh" ? "拒绝" : "Deny", callbackData: `approval:${id}:deny` },
        ],
      ],
    }).then((message) => {
      pending.promptMessageId = message.message_id;
    }).catch((error) => {
      cleanupPending(pending);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function deliverApprovalResolution(api: ApprovalApi, pending: PendingApproval, choice: ApprovalChoice): Promise<void> {
  const message = renderResolvedMessage(choice, pending.locale, pending.engine);
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
    : findOldestPendingForChatAndUser(input.normalized.chatId, input.normalized.userId);

  if (!pending) {
    await input.api.sendMessage(input.normalized.chatId, "No pending approval.");
    return true;
  }

  if (pending.chatId !== input.normalized.chatId) {
    await input.api.sendMessage(input.normalized.chatId, "This approval request belongs to another chat.");
    return true;
  }

  if (pending.userId !== input.normalized.userId) {
    await input.api.sendMessage(input.normalized.chatId, "This approval request belongs to another Telegram user.");
    return true;
  }

  resolvePending(pending, parsed.choice);
  await deliverApprovalResolution(input.api, pending, parsed.choice);
  return true;
}

export function clearPendingTelegramApprovalsForTest(): void {
  for (const pending of pendingApprovals.values()) {
    cleanupPending(pending);
  }
}
