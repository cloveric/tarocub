import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type TelegramOkResponse<T> = {
  ok: true;
  result: T;
};

type TelegramErrorResponse = {
  ok: false;
  description?: string;
};

type TelegramApiResponse<T> = TelegramOkResponse<T> | TelegramErrorResponse;

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Telegram API request aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Telegram API request aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTelegramApiResponse<T>(value: unknown): value is TelegramApiResponse<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("ok" in value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    return "result" in value;
  }

  if ("description" in value && typeof value.description !== "string") {
    return false;
  }

  return true;
}

async function extractTelegramErrorDetail<T>(response: Response, fallback: string): Promise<string> {
  try {
    const json = await response.json();
    if (isTelegramApiResponse<T>(json) && !json.ok && json.description) {
      return json.description;
    }
  } catch {
    // Fall back to the HTTP status line when the body is unreadable.
  }

  return fallback;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface TelegramFile {
  file_id?: string;
  file_path: string;
}

export interface TelegramBotIdentity {
  first_name: string;
  username?: string;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  return typeof value === "object" && value !== null && "message_id" in value && typeof value.message_id === "number";
}

function isTelegramFile(value: unknown): value is TelegramFile {
  return typeof value === "object" && value !== null && "file_path" in value && typeof value.file_path === "string";
}

function isTelegramBotIdentity(value: unknown): value is TelegramBotIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "first_name" in value &&
    typeof value.first_name === "string" &&
    (!("username" in value) || typeof value.username === "string")
  );
}

interface TelegramMessageOptions {
  inlineKeyboard?: InlineKeyboardButton[][];
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
}

function isTelegramUpdateArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export class TelegramApi {
  constructor(private readonly botToken: string) {}

  private buildUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private buildFileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
  }

  private async postJson<T>(
    method: string,
    body: Record<string, unknown>,
    validateResult?: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.postJsonOnce(method, body, validateResult, true, signal);
  }

  private async postJsonOnce<T>(
    method: string,
    body: Record<string, unknown>,
    validateResult: ((value: unknown) => value is T) | undefined,
    allowRetry: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(this.buildUrl(method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 429 && allowRetry) {
      let retryAfterSeconds = 5;
      try {
        const errorBody = await response.json() as { parameters?: { retry_after?: number } };
        if (typeof errorBody?.parameters?.retry_after === "number") {
          retryAfterSeconds = errorBody.parameters.retry_after;
        }
      } catch {
        // Use default retry_after
      }
      await delay(retryAfterSeconds * 1000, signal);
      return this.postJsonOnce(method, body, validateResult, false, signal);
    }

    if (!response.ok) {
      const detail = await extractTelegramErrorDetail<T>(response, `${response.status} ${response.statusText}`);
      throw new Error(`Telegram API request failed for ${method}: ${detail}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error(`Telegram API response was not valid JSON for ${method}`);
    }

    if (!isTelegramApiResponse<T>(json)) {
      throw new Error(`Telegram API response had an unexpected shape for ${method}`);
    }

    const payload = json;

    if (!payload.ok) {
      throw new Error(`Telegram API request failed for ${method}: ${payload.description ?? "unknown error"}`);
    }

    if (validateResult && !validateResult(payload.result)) {
      throw new Error(`Telegram API response had an unexpected result shape for ${method}`);
    }

    return payload.result;
  }

  async sendMessage(chatId: number, text: string, options?: TelegramMessageOptions): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options?.parseMode) {
      body.parse_mode = options.parseMode;
    }
    if (options?.inlineKeyboard) {
      body.reply_markup = {
        inline_keyboard: options.inlineKeyboard.map((row) =>
          row.map((button) => ({
            text: button.text,
            callback_data: button.callbackData,
          })),
        ),
      };
    }
    return this.postJson("sendMessage", body, isTelegramMessage);
  }

  async sendDocument(chatId: number, filename: string, contents: string | Uint8Array): Promise<TelegramMessage> {
    const boundary = `----cc-telegram-bridge-${Math.random().toString(16).slice(2)}`;
    const payload =
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = new Uint8Array(
      Buffer.concat([
        Buffer.from(head, "utf8"),
        Buffer.from(payload),
        Buffer.from(tail, "utf8"),
      ]),
    );

    const response = await fetch(this.buildUrl("sendDocument"), {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const detail = await extractTelegramErrorDetail<TelegramMessage>(response, `${response.status} ${response.statusText}`);
      throw new Error(`Telegram API request failed for sendDocument: ${detail}`);
    }

    const json = await response.json();
    if (!isTelegramApiResponse<TelegramMessage>(json) || !json.ok || !isTelegramMessage(json.result)) {
      throw new Error("Telegram API response had an unexpected shape for sendDocument");
    }

    return json.result;
  }

  async sendPhoto(chatId: number, filename: string, contents: Uint8Array, caption?: string): Promise<TelegramMessage> {
    const boundary = `----cc-telegram-bridge-${Math.random().toString(16).slice(2)}`;
    let head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    if (caption) {
      head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`;
    }
    const tail = `\r\n--${boundary}--\r\n`;
    const body = new Uint8Array(
      Buffer.concat([
        Buffer.from(head, "utf8"),
        Buffer.from(contents),
        Buffer.from(tail, "utf8"),
      ]),
    );

    const response = await fetch(this.buildUrl("sendPhoto"), {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const detail = await extractTelegramErrorDetail<TelegramMessage>(response, `${response.status} ${response.statusText}`);
      throw new Error(`Telegram API request failed for sendPhoto: ${detail}`);
    }

    const json = await response.json();
    if (!isTelegramApiResponse<TelegramMessage>(json) || !json.ok || !isTelegramMessage(json.result)) {
      throw new Error("Telegram API response had an unexpected shape for sendPhoto");
    }

    return json.result;
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    options?: TelegramMessageOptions,
  ): Promise<TelegramMessage> {
    return this.postJson("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options?.inlineKeyboard
        ? {
            reply_markup: {
              inline_keyboard: options.inlineKeyboard.map((row) =>
                row.map((button) => ({
                  text: button.text,
                  callback_data: button.callbackData,
                })),
              ),
            },
          }
        : {}),
    }, isTelegramMessage);
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.postJson("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
    });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.postJson("getFile", {
      file_id: fileId,
    }, isTelegramFile);
  }

  async downloadFile(filePath: string, destinationPath: string): Promise<void> {
    const response = await fetch(this.buildFileUrl(filePath), {
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Telegram API request failed for downloadFile: ${response.status} ${response.statusText}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, bytes);
  }

  async getUpdates(offset?: number, signal?: AbortSignal, timeoutSeconds = 30): Promise<unknown[]> {
    const body: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
    };
    if (offset !== undefined) {
      body.offset = offset;
    }

    return this.postJson("getUpdates", body, isTelegramUpdateArray, signal);
  }

  async getMe(): Promise<TelegramBotIdentity> {
    return this.postJson("getMe", {}, isTelegramBotIdentity);
  }

  async sendMediaGroup(chatId: number, photos: Array<{ filename: string; contents: Uint8Array; caption?: string }>): Promise<void> {
    const boundary = `----cc-telegram-bridge-${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];

    const media = photos.map((photo, index) => ({
      type: "photo" as const,
      media: `attach://photo${index}`,
      ...(photo.caption ? { caption: photo.caption } : {}),
    }));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="media"\r\n\r\n${JSON.stringify(media)}\r\n`,
      "utf8",
    ));

    for (let i = 0; i < photos.length; i++) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo${i}"; filename="${photos[i]!.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        "utf8",
      ));
      parts.push(Buffer.from(photos[i]!.contents));
      parts.push(Buffer.from("\r\n", "utf8"));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

    const response = await fetch(this.buildUrl("sendMediaGroup"), {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(Buffer.concat(parts)),
    });

    if (!response.ok) {
      const detail = await extractTelegramErrorDetail<unknown>(response, `${response.status} ${response.statusText}`);
      throw new Error(`Telegram API request failed for sendMediaGroup: ${detail}`);
    }
  }

  async sendChatAction(chatId: number, action: "typing" = "typing"): Promise<void> {
    await this.postJson("sendChatAction", { chat_id: chatId, action }, (v): v is true => v === true);
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.postJson("setMyCommands", { commands }, (v): v is true => v === true);
  }
}
