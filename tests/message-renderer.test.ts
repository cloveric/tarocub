import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TelegramApi } from "../src/telegram/api.js";
import { normalizeUpdate } from "../src/telegram/update-normalizer.js";
import {
  chunkTelegramMessage,
  renderAccessCheckMessage,
  renderAttachmentDownloadMessage,
  renderCategorizedErrorMessage,
  renderErrorMessage,
  renderExecutionMessage,
  renderTelegramHelpMessage,
  renderTelegramStatusMessage,
  renderPairingMessage,
  renderPrivateChatRequiredMessage,
  renderSessionStateErrorMessage,
  renderSessionResetMessage,
  renderUnauthorizedMessage,
  renderWorkingMessage,
} from "../src/telegram/message-renderer.js";

describe("chunkTelegramMessage", () => {
  it("splits long messages into fixed-size chunks", () => {
    const message = "a".repeat(5000);

    const chunks = chunkTelegramMessage(message, 4000);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(1000);
  });

  it("rejects non-positive limits", () => {
    expect(() => chunkTelegramMessage("hello", 0)).toThrow(RangeError);
  });

  it("rejects invalid numeric limits", () => {
    expect(() => chunkTelegramMessage("hello", Number.NaN)).toThrow(RangeError);
    expect(() => chunkTelegramMessage("hello", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => chunkTelegramMessage("hello", 3.5)).toThrow(RangeError);
  });

  it("does not split surrogate pairs across chunk boundaries", () => {
    const chunks = chunkTelegramMessage(`aaaa${"😀".repeat(2)}bbbb`, 6);

    expect(chunks).toEqual(["aaaa😀", "😀bbbb"]);
  });

  it("rejects limits that cannot safely encode a surrogate pair", () => {
    expect(() => chunkTelegramMessage("😀a", 1)).toThrow(RangeError);
  });

  it("closes and reopens fenced code blocks across chunk boundaries", () => {
    const message = ["before", "```js", "const answer = 42;", "```", "after"].join("\n");

    const chunks = chunkTelegramMessage(message, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("```js");
    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toMatch(/^```js/);
  });
});

describe("message rendering", () => {
  it("renders the working message", () => {
    expect(renderWorkingMessage()).toBe("Received. Starting your session...");
  });

  it("renders error messages", () => {
    expect(renderErrorMessage("boom")).toBe("Error: boom");
  });

  it("renders progress and access messages", () => {
    expect(renderAccessCheckMessage()).toBe("Checking access policy...");
    expect(renderAttachmentDownloadMessage(1)).toBe("Downloading 1 attachment...");
    expect(renderAttachmentDownloadMessage(2)).toBe("Downloading 2 attachments...");
    expect(renderExecutionMessage()).toBe("Working on your request...");
    expect(renderUnauthorizedMessage()).toBe("This chat is not authorized for this instance.");
    expect(renderPrivateChatRequiredMessage()).toBe("This bot only accepts private chats.");
    expect(renderPairingMessage("ABC123")).toBe("Pair this private chat with code ABC123");
  });

  it("renders categorized error and reset messages", () => {
    expect(renderSessionResetMessage()).toBe("Session reset for this chat.");
    expect(renderSessionResetMessage(true)).toBe(
      "Session state was unreadable. An operator needs to repair the instance session state before this chat can be reset.",
    );
    expect(renderSessionStateErrorMessage(true)).toBe(
      "Error: Session state is unreadable right now. The operator needs to repair session state and retry.",
    );
    expect(renderSessionStateErrorMessage(false)).toBe(
      "Error: Session state is unavailable right now. The operator needs to restore read access and retry.",
    );
    expect(renderCategorizedErrorMessage("write-permission", "write access denied")).toBe(
      "Error: File creation is blocked by the current write policy. Retry in a writable mode.",
    );
    expect(renderCategorizedErrorMessage("auth", "missing auth")).toBe(
      "Error: Engine authentication is missing or expired. Re-login for this instance and retry.",
    );
    expect(renderCategorizedErrorMessage("telegram-conflict", "409 conflict")).toBe(
      "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.",
    );
    expect(renderCategorizedErrorMessage("telegram-delivery", "sendMessage failed")).toBe(
      "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.",
    );
    expect(renderCategorizedErrorMessage("engine-cli", "engine failed to start")).toBe(
      "Error: The engine runtime failed. Restart the instance and retry.",
    );
    expect(renderCategorizedErrorMessage("file-workflow", "archive extraction failed")).toBe(
      "Error: File handling failed while preparing your request. Retry with a smaller or different file.",
    );
    expect(renderCategorizedErrorMessage("workflow-state", "invalid file workflow state")).toBe(
      "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.",
    );
    expect(renderCategorizedErrorMessage("session-state", "session store unavailable")).toBe(
      "Error: Session state is unavailable right now. The operator needs to repair session state and retry.",
    );
    expect(renderCategorizedErrorMessage("unknown", "boom")).toBe(
      "Error: An unexpected failure occurred. Reset the chat or retry the request.",
    );
  });

  it("renders Telegram help text", () => {
    const help = renderTelegramHelpMessage();
    expect(help).toContain("/status");
    expect(help).toContain("/ask <instance> <prompt>");
    expect(help).toContain("/reset");
    expect(help).toContain("/help");
  });

  it("renders Telegram status text", () => {
    expect(
      renderTelegramStatusMessage({
        engine: "codex",
        sessionBound: true,
        threadId: "thread-123",
        blockingTasks: 2,
        waitingTasks: 1,
      }),
    ).toContain("Engine: codex");
    expect(
      renderTelegramStatusMessage({
        engine: "codex",
        sessionBound: true,
        threadId: "thread-123",
        blockingTasks: 2,
        waitingTasks: 1,
      }),
    ).toContain("Session bound: yes");
    expect(
      renderTelegramStatusMessage({
        engine: "codex",
        sessionBound: true,
        threadId: "thread-123",
        blockingTasks: 2,
        waitingTasks: 1,
      }),
    ).toContain("Current thread: thread-123");
    expect(
      renderTelegramStatusMessage({
        engine: "codex",
        sessionBound: true,
        threadId: "thread-123",
        blockingTasks: 2,
        waitingTasks: 1,
      }),
    ).toContain("Blocking file tasks: 2");
    expect(
      renderTelegramStatusMessage({
        engine: "codex",
        sessionBound: true,
        threadId: "thread-123",
        blockingTasks: 2,
        waitingTasks: 1,
      }),
    ).toContain("Waiting file tasks: 1");
  });
});

describe("normalizeUpdate", () => {
  it("normalizes a message update", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "hello",
        },
      }),
    ).toEqual({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      attachments: [],
    });
  });

  it("extracts quoted reply context", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "reply",
          reply_to_message: {
            message_id: 99,
            text: "quoted text",
          },
        },
      }),
    ).toEqual({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "reply",
      replyContext: {
        messageId: 99,
        text: "quoted text",
      },
      attachments: [],
    });
  });

  it("extracts a document attachment", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "hello",
          document: {
            file_id: "doc-file",
            file_name: "report.pdf",
          },
        },
      }),
    ).toEqual({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      attachments: [
        {
          fileId: "doc-file",
          fileName: "report.pdf",
          kind: "document",
        },
      ],
    });
  });

  it("extracts the highest-resolution photo attachment", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          photo: [
            { file_id: "small" },
            { file_id: "large" },
          ],
        },
      }),
    ).toEqual({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "",
      replyContext: undefined,
      attachments: [
        {
          fileId: "large",
          kind: "photo",
        },
      ],
    });
  });

  it("returns null when required fields are missing", () => {
    expect(normalizeUpdate({})).toBeNull();
  });
});

describe("TelegramApi", () => {
  it("throws a stable error for non-OK responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ ok: false }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API request failed for sendMessage: 500 Internal Server Error",
    );

    fetchMock.mockRestore();
  });

  it("throws for ok-false API payloads", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: false, description: "bad request" }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API request failed for sendMessage: bad request",
    );

    fetchMock.mockRestore();
  });

  it("throws a stable error for ok-false payloads with malformed descriptions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: false, description: { detail: "x" } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API response had an unexpected shape for sendMessage",
    );

    fetchMock.mockRestore();
  });

  it("throws a stable error for malformed JSON responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.editMessage(1, 2, "hello")).rejects.toThrow(
      "Telegram API response was not valid JSON for editMessageText",
    );

    fetchMock.mockRestore();
  });

  it("throws a stable error for parsed payloads with the wrong shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => null,
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API response had an unexpected shape for sendMessage",
    );

    fetchMock.mockRestore();
  });

  it("returns the result array from getUpdates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: [{ update_id: 7 }] }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getUpdates()).resolves.toEqual([{ update_id: 7 }]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getUpdates", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 30, allowed_updates: ["message", "callback_query", "my_chat_member"] }),
    }));

    fetchMock.mockRestore();
  });

  it("passes offset to getUpdates when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: [] }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getUpdates(42)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getUpdates", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 30, allowed_updates: ["message", "callback_query", "my_chat_member"], offset: 42 }),
    }));

    fetchMock.mockRestore();
  });

  it("rejects malformed getUpdates results at the API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { update_id: 7 } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getUpdates()).rejects.toThrow(
      "Telegram API response had an unexpected result shape for getUpdates",
    );

    fetchMock.mockRestore();
  });

  it("returns typed message results from sendMessage and editMessage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: { message_id: 9, text: "working" } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: { message_id: 9, text: "done" } }),
      } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "working")).resolves.toEqual({ message_id: 9, text: "working" });
    await expect(api.editMessage(1, 9, "done")).resolves.toEqual({ message_id: 9, text: "done" });

    fetchMock.mockRestore();
  });

  it("rejects malformed message results at the API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: { message_id: "9" } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: {} }),
      } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "working")).rejects.toThrow(
      "Telegram API response had an unexpected result shape for sendMessage",
    );
    await expect(api.editMessage(1, 9, "done")).rejects.toThrow(
      "Telegram API response had an unexpected result shape for editMessageText",
    );

    fetchMock.mockRestore();
  });

  it("resolves getFile metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { file_id: "abc", file_path: "documents/file.pdf" } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getFile("abc")).resolves.toEqual({ file_id: "abc", file_path: "documents/file.pdf" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getFile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: "abc" }),
    });

    fetchMock.mockRestore();
  });

  it("rejects malformed getFile results at the API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { file_id: "abc", file_path: 42 } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getFile("abc")).rejects.toThrow(
      "Telegram API response had an unexpected result shape for getFile",
    );

    fetchMock.mockRestore();
  });

  it("downloads a file to disk", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new TextEncoder().encode("file-bytes").buffer,
    } as unknown as Response);

    const api = new TelegramApi("token");
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-download-"));
    const destinationPath = path.join(root, "nested", "file.bin");

    try {
      await api.downloadFile("documents/file.bin", destinationPath);

      await expect(readFile(destinationPath, "utf8")).resolves.toBe("file-bytes");
      expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/file/bottoken/documents/file.bin", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally {
      fetchMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads a document via multipart form data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { message_id: 17, text: "sent" } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendDocument(123, "report.txt", "hello file")).resolves.toEqual({
      message_id: 17,
      text: "sent",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0]!;
    expect(String((options as RequestInit).headers && (options as any).headers["Content-Type"])).toContain("multipart/form-data");

    fetchMock.mockRestore();
  });
});
