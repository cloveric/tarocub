import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramApi } from "../src/telegram/api.js";

function okJsonResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ ok: true, result }),
    clone() {
      return this;
    },
  } as unknown as Response;
}

function rateLimitedResponse(retryAfterSeconds = 0): Response {
  return {
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    json: async () => ({ ok: false, parameters: { retry_after: retryAfterSeconds } }),
    clone() {
      return this;
    },
  } as unknown as Response;
}

function readMultipartBody(body: unknown): string {
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  return String(body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramApi.postJson retry", () => {
  it("retries a 429 then succeeds on the next attempt (sendMessage)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimitedResponse(0))
      .mockResolvedValueOnce(okJsonResponse({ message_id: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    const result = await api.sendMessage(123, "hi");

    expect(result).toEqual({ message_id: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient network error then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okJsonResponse({ message_id: 9 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    const result = await api.sendMessage(123, "hi");

    expect(result).toEqual({ message_id: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an aborted request", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    await expect(api.sendMessage(123, "hi")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("TelegramApi multipart retry", () => {
  it("retries a transient network error on sendDocument", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okJsonResponse({ message_id: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    const result = await api.sendDocument(123, "report.txt", "body");

    expect(result).toEqual({ message_id: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 on sendPhoto", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimitedResponse(0))
      .mockResolvedValueOnce(okJsonResponse({ message_id: 6 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    const result = await api.sendPhoto(123, "img.png", new Uint8Array([1, 2, 3]));

    expect(result).toEqual({ message_id: 6 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TelegramApi multipart caption sanitization", () => {
  it("strips CR/LF from a sendPhoto caption so it cannot forge a new form field", async () => {
    let capturedBody = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = readMultipartBody(init.body);
      return okJsonResponse({ message_id: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    const maliciousCaption = 'cover.png"\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n999\r\n';
    await api.sendPhoto(123, "cover.png", new Uint8Array([1]), maliciousCaption);

    // Find the caption part and assert it occupies a single line — no injected
    // CRLF, so it cannot introduce a second chat_id form field.
    const captionMarker = 'name="caption"\r\n\r\n';
    const captionStart = capturedBody.indexOf(captionMarker) + captionMarker.length;
    const captionEnd = capturedBody.indexOf("\r\n", captionStart);
    const captionValue = capturedBody.slice(captionStart, captionEnd);
    // No CRLF survives in the caption, so the injected text cannot start a new
    // MIME part (a form field requires a preceding CRLF + boundary).
    expect(captionValue).not.toContain("\n");
    expect(captionValue).not.toContain("\r");
    // The forged form-field header sequence (CRLF + Content-Disposition) the
    // attacker tried to smuggle must not exist anywhere in the caption region.
    expect(capturedBody.slice(captionStart)).not.toMatch(/\r\nContent-Disposition: form-data; name="chat_id"/);
  });

  it("truncates a sendPhoto caption longer than 1024 chars", async () => {
    let capturedBody = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = readMultipartBody(init.body);
      return okJsonResponse({ message_id: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new TelegramApi("token");
    const longCaption = "x".repeat(2000);
    await api.sendPhoto(123, "cover.png", new Uint8Array([1]), longCaption);

    const captionMarker = 'name="caption"\r\n\r\n';
    const captionStart = capturedBody.indexOf(captionMarker) + captionMarker.length;
    const captionEnd = capturedBody.indexOf("\r\n", captionStart);
    const captionValue = capturedBody.slice(captionStart, captionEnd);
    expect(captionValue.length).toBe(1024);
  });
});
