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

describe("telegram approval requests", () => {
  afterEach(() => {
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

  it("renders Codex approval prompts and decisions as Codex", async () => {
    const api = createApi();
    const pending = requestTelegramApproval({
      api,
      chatId: 123,
      userId: 456,
      locale: "en",
      request: {
        engine: "codex",
        toolName: "Codex full-auto turn",
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
});
