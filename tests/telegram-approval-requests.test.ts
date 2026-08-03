import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingTelegramApprovalsForTest,
  handleTelegramApprovalCommand,
  requestTelegramApproval,
} from "../src/telegram/approval-requests.js";
import { normalizeUpdate } from "../src/telegram/update-normalizer.js";

function createApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms = 100): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for approval")), ms);
    }),
  ]);
}

describe("telegram approval requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearPendingTelegramApprovalsForTest();
  });

  it("normalizes approval callback queries into approval commands", () => {
    const normalized = normalizeUpdate({
      callback_query: {
        id: "callback-1",
        data: "approval:abc123:once",
        from: { id: 456 },
        message: {
          chat: { id: 123, type: "private" },
        },
      },
    });

    expect(normalized).toMatchObject({
      chatId: 123,
      userId: 456,
      text: "/approval abc123 once",
      callbackQueryId: "callback-1",
      attachments: [],
    });
  });

  it("resolves a pending request from an approval callback button", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: {
          command: "npm test",
          description: "Run tests",
        },
        permissionSuggestions: [],
      },
    });

    const keyboard = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard;
    const callbackData = keyboard?.[0]?.[0]?.callbackData;
    expect(callbackData).toMatch(/^approval:[^:]+:once$/);
    const approvalId = callbackData!.split(":")[1]!;

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: `/approval ${approvalId} once`,
        callbackQueryId: "callback-1",
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once" });
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1");
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "Approved once. Claude is resuming...", { inlineKeyboard: null });
  });

  it("labels Kimi approvals and resume messages accurately", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "kimi",
        toolName: "Bash",
        toolInput: { command: "pwd" },
      },
    });
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Kimi Code is requesting permission");

    await handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "/approve",
        attachments: [],
      },
      api,
    });

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once" });
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "Approved once. Kimi is resuming...", { inlineKeyboard: null });
  });

  it("renders Kimi AskUserQuestion options and returns the selected answer", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "kimi",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [{
            question: "Which environment?",
            header: "Environment",
            multi_select: false,
            options: [{ label: "staging" }, { label: "production" }],
          }],
        },
      },
    });

    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Which environment?");
    const keyboard = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard;
    expect(keyboard?.map((row: Array<{ text: string }>) => row[0]?.text)).toEqual([
      "staging",
      "production",
      "Skip",
    ]);
    const callbackData = keyboard?.[1]?.[0]?.callbackData as string;
    expect(callbackData).toMatch(/^approval:[^:]+:answer:0:1$/);

    const normalized = normalizeUpdate({
      callback_query: {
        id: "callback-answer",
        data: callbackData,
        from: { id: 456 },
        message: { chat: { id: 123, type: "private" } },
      },
    });
    expect(normalized?.text).toMatch(/^\/approval [^ ]+ answer-0-1$/);
    await handleTelegramApprovalCommand({ normalized: normalized!, api });

    await expect(pending).resolves.toEqual({
      behavior: "allow",
      scope: "once",
      updatedInput: {
        questions: [{
          question: "Which environment?",
          header: "Environment",
          multi_select: false,
          options: [{ label: "staging" }, { label: "production" }],
        }],
        answers: { "Which environment?": "production" },
      },
    });
    expect(api.editMessage).toHaveBeenCalledWith(
      123,
      11,
      "Selected “production”. Kimi is resuming...",
      { inlineKeyboard: null },
    );
  });

  it("keys Claude AskUserQuestion answers by question text rather than the display header", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [{
            question: "Continue deployment?",
            header: "Deployment",
            multiSelect: false,
            options: [{ label: "Yes" }, { label: "No" }],
          }],
        },
      },
    });
    const callbackData = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard?.[0]?.[0]?.callbackData as string;
    const normalized = normalizeUpdate({
      callback_query: {
        id: "callback-claude-answer",
        data: callbackData,
        from: { id: 456 },
        message: { chat: { id: 123, type: "private" } },
      },
    });

    await handleTelegramApprovalCommand({ normalized: normalized!, api });

    await expect(pending).resolves.toEqual({
      behavior: "allow",
      scope: "once",
      // updatedInput REPLACES the tool input (claude-stream-adapter forwards it
      // verbatim), so it must carry the original questions alongside the
      // answers — a bare {answers} stripped `questions` from what the CLI ran.
      updatedInput: {
        questions: [{
          question: "Continue deployment?",
          header: "Deployment",
          multiSelect: false,
          options: [{ label: "Yes" }, { label: "No" }],
        }],
        answers: { "Continue deployment?": "Yes" },
      },
    });
  });

  it("collects every AskUserQuestion answer sequentially instead of dropping later questions", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            { question: "Which style?", header: "Style", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
            { question: "How many pages?", header: "Pages", multiSelect: false, options: [{ label: "9" }, { label: "12" }] },
          ],
        },
      },
    });
    const keyboard = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard as Array<Array<{ text: string; callbackData: string }>>;
    const labels = keyboard.flat().map((button) => button.text);
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Question 1/2");
    expect(labels).toContain("A");
    expect(labels).toContain("B");
    expect(labels).not.toContain("9");
    const first = keyboard.flat().find((button) => button.text === "A")!;
    const firstNormalized = normalizeUpdate({
      callback_query: {
        id: "callback-multi-q",
        data: first.callbackData,
        from: { id: 456 },
        message: { chat: { id: 123, type: "private" } },
      },
    });
    await handleTelegramApprovalCommand({ normalized: firstNormalized!, api });

    const secondEdit = api.editMessage.mock.calls.at(-1)!;
    expect(secondEdit[2]).toContain("Question 2/2");
    expect(secondEdit[2]).toContain("How many pages?");
    const secondKeyboard = secondEdit[3]?.inlineKeyboard as Array<Array<{ text: string; callbackData: string }>>;
    const twelve = secondKeyboard.flat().find((button) => button.text === "12")!;
    const secondNormalized = normalizeUpdate({
      callback_query: {
        id: "callback-multi-q-2",
        data: twelve.callbackData,
        from: { id: 456 },
        message: { chat: { id: 123, type: "private" } },
      },
    });
    await handleTelegramApprovalCommand({ normalized: secondNormalized!, api });

    await expect(pending).resolves.toEqual({
      behavior: "allow",
      scope: "once",
      updatedInput: {
        questions: [
          { question: "Which style?", header: "Style", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
          { question: "How many pages?", header: "Pages", multiSelect: false, options: [{ label: "9" }, { label: "12" }] },
        ],
        answers: { "Which style?": "A", "How many pages?": "12" },
      },
    });
    expect(api.editMessage).toHaveBeenLastCalledWith(
      123,
      11,
      "Answers submitted. Claude is resuming...",
      { inlineKeyboard: null },
    );
  });

  it("toggles multiple AskUserQuestion choices and submits them together", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [{
            question: "Which outputs?",
            header: "Outputs",
            multiSelect: true,
            options: [{ label: "PDF" }, { label: "DOCX" }, { label: "XLSX" }],
          }],
        },
      },
    });

    const click = async (callbackData: string, callbackQueryId: string) => {
      const normalized = normalizeUpdate({
        callback_query: {
          id: callbackQueryId,
          data: callbackData,
          from: { id: 456 },
          message: { chat: { id: 123, type: "private" } },
        },
      });
      await handleTelegramApprovalCommand({ normalized: normalized!, api });
    };

    const initialKeyboard = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard as Array<Array<{ text: string; callbackData: string }>>;
    expect(initialKeyboard.flat().map((button) => button.text)).toEqual(["PDF", "DOCX", "XLSX", "Submit (0)", "Skip"]);
    await click(initialKeyboard[0]![0]!.callbackData, "toggle-pdf");
    let updatedKeyboard = api.editMessage.mock.calls.at(-1)![3]?.inlineKeyboard as Array<Array<{ text: string; callbackData: string }>>;
    expect(updatedKeyboard.flat().map((button) => button.text)).toContain("✓ PDF");
    expect(updatedKeyboard.flat().map((button) => button.text)).toContain("Submit (1)");

    await click(updatedKeyboard[2]![0]!.callbackData, "toggle-xlsx");
    updatedKeyboard = api.editMessage.mock.calls.at(-1)![3]?.inlineKeyboard as Array<Array<{ text: string; callbackData: string }>>;
    expect(updatedKeyboard.flat().map((button) => button.text)).toContain("✓ XLSX");
    const submit = updatedKeyboard.flat().find((button) => button.text === "Submit (2)")!;
    await click(submit.callbackData, "submit-outputs");

    await expect(pending).resolves.toEqual({
      behavior: "allow",
      scope: "once",
      updatedInput: {
        questions: [{
          question: "Which outputs?",
          header: "Outputs",
          multiSelect: true,
          options: [{ label: "PDF" }, { label: "DOCX" }, { label: "XLSX" }],
        }],
        answers: { "Which outputs?": "PDF, XLSX" },
      },
    });
    expect(api.editMessage).toHaveBeenLastCalledWith(
      123,
      11,
      "Answers submitted. Claude is resuming...",
      { inlineKeyboard: null },
    );
  });

  it("does not treat /approve as an answer to AskUserQuestion", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "kimi",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [{ question: "Pick one", header: "Choice", options: [{ label: "A" }] }],
        },
      },
    });

    await handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "/approve",
        attachments: [],
      },
      api,
    });
    expect(api.sendMessage).toHaveBeenLastCalledWith(123, "Choose one of the question buttons.");
    await expect(withTimeout(pending, 20)).rejects.toThrow("timed out waiting for approval");
  });

  it("resolves the oldest pending request from /approve session", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Edit",
        toolInput: {
          file_path: "/tmp/example.txt",
        },
        permissionSuggestions: [],
      },
    });

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "/approve session",
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "Approved for this turn. Claude is resuming...", { inlineKeyboard: null });
  });

  it("resolves the oldest pending request for the same chat and user", async () => {
    const api = createApi();
    const otherUserPending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 999,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "first" },
      },
    });
    const otherApprovalId = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard?.[0]?.[0]?.callbackData!.split(":")[1]!;
    const myPending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "second" },
      },
    });

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "/approve session",
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(withTimeout(myPending)).resolves.toEqual({ behavior: "allow", scope: "session" });

    await handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 999,
        chatType: "private",
        text: `/approval ${otherApprovalId} deny`,
        attachments: [],
      },
      api,
    });
    await expect(otherUserPending).resolves.toEqual({ behavior: "deny" });
  });

  it("resolves /approve against the current forum topic only", async () => {
    const api = createApi();
    const topic10Pending = requestTelegramApproval({
      api,
      chatId: -100123,
      messageThreadId: 10,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "topic-10" },
      },
    });
    const topic20Pending = requestTelegramApproval({
      api,
      chatId: -100123,
      messageThreadId: 20,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "topic-20" },
      },
    });
    expect(api.sendMessage.mock.calls[0]?.[2]).toMatchObject({ messageThreadId: 10 });
    expect(api.sendMessage.mock.calls[1]?.[2]).toMatchObject({ messageThreadId: 20 });

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: -100123,
        userId: 456,
        chatType: "supergroup",
        messageThreadId: 20,
        conversationKey: "chat:-100123:topic:20",
        text: "/approve session",
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(withTimeout(topic20Pending)).resolves.toEqual({ behavior: "allow", scope: "session" });
    await expect(withTimeout(topic10Pending, 20)).rejects.toThrow("timed out waiting for approval");
  });

  it("does not treat /approve argument substrings as session approvals", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      },
    });

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "/approve do not sessionize this",
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once" });
  });

  it("resolves /deny with an explicit approval id", async () => {
    const api = createApi();
    const firstPending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "first" },
      },
    });
    const firstApprovalId = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard?.[0]?.[0]?.callbackData!.split(":")[1]!;
    const secondPending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "second" },
      },
    });

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: `/deny ${firstApprovalId}`,
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(firstPending).resolves.toEqual({ behavior: "deny" });
    await expect(withTimeout(secondPending)).rejects.toThrow("timed out waiting for approval");
  });

  it("renders Codex approval prompts and decisions as Codex", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "codex",
        toolName: "Codex full-auto turn (grants the WHOLE turn, not one command)",
        toolInput: {
          prompt: "Delete temp.txt",
        },
      },
    });

    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("Codex is requesting permission.");
    const keyboard = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard;
    const approvalId = keyboard?.[0]?.[0]?.callbackData!.split(":")[1]!;

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: `/approval ${approvalId} once`,
        attachments: [],
      },
      api,
    })).resolves.toBe(true);

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once" });
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "Approved once. Codex is resuming...", { inlineKeyboard: null });
  });

  it("does not let a different Telegram user approve the request", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Write",
        toolInput: {
          file_path: "/tmp/example.txt",
        },
        permissionSuggestions: [],
      },
    });

    const keyboard = api.sendMessage.mock.calls[0]?.[2]?.inlineKeyboard;
    const approvalId = keyboard?.[0]?.[0]?.callbackData!.split(":")[1]!;

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 999,
        chatType: "private",
        text: `/approval ${approvalId} once`,
        attachments: [],
      },
      api,
    })).resolves.toBe(true);
    expect(api.sendMessage).toHaveBeenLastCalledWith(123, "This approval request belongs to another Telegram user.");

    await handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: `/approval ${approvalId} deny`,
        attachments: [],
      },
      api,
    });
    await expect(pending).resolves.toEqual({ behavior: "deny" });
  });

  it("denies and clears a pending request when the abort signal fires", async () => {
    const api = createApi();
    const abortController = new AbortController();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      abortSignal: abortController.signal,
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: {
          command: "npm test",
        },
      },
    });

    abortController.abort();
    await expect(pending).resolves.toEqual({ behavior: "deny" });
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "Approval canceled (denied).", { inlineKeyboard: null });

    await expect(handleTelegramApprovalCommand({
      normalized: {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "/approve",
        attachments: [],
      },
      api,
    })).resolves.toBe(true);
    expect(api.sendMessage).toHaveBeenLastCalledWith(123, "No pending approval.");
  });

  it("edits the approval prompt when the request expires", async () => {
    vi.useFakeTimers();
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: {
          command: "npm test",
        },
      },
    });

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ behavior: "deny" });
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "Approval expired (denied).", { inlineKeyboard: null });
  });
});
