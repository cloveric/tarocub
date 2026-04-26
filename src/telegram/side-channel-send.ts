import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { deliverTelegramResponse } from "./response-delivery.js";
import type { TelegramApi } from "./api.js";
import type { Locale } from "./message-renderer.js";

export interface SideChannelSendPayload {
  message?: string;
  images: string[];
  files: string[];
}

export interface SideChannelSendEnv {
  [key: string]: string | undefined;
  CCTB_SEND_URL?: string;
  CCTB_SEND_TOKEN?: string;
  CCTB_SEND_COMMAND?: string;
}

export interface SideChannelSendServer {
  url: string;
  token: string;
  getSentFilePaths: () => string[];
  close: () => Promise<void>;
}

export interface SideChannelSendServerOptions {
  api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">;
  chatId: number;
  inboxDir: string;
  workspaceOverride?: string;
  requestOutputDir?: string;
  locale: Locale;
}

const MAX_SIDE_CHANNEL_BODY_BYTES = 64 * 1024;
const MAX_SIDE_CHANNEL_FILES = 20;
const SIDE_CHANNEL_CLOSE_TIMEOUT_MS = 1000;

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function assertAbsoluteFilePaths(paths: string[]): void {
  const relativePath = paths.find((filePath) => !isAbsoluteFilePath(filePath));
  if (relativePath) {
    throw new Error(`File paths must be absolute: ${relativePath}`);
  }
}

export function parseSideChannelSendArgs(argv: string[]): SideChannelSendPayload {
  const images: string[] = [];
  const files: string[] = [];
  const messageParts: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--image") {
      const value = argv[++index];
      if (!value) throw new Error("--image requires a path");
      images.push(value);
      continue;
    }
    if (arg === "--file") {
      const value = argv[++index];
      if (!value) throw new Error("--file requires a path");
      files.push(value);
      continue;
    }
    if (arg === "--message" || arg === "-m") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a message`);
      messageParts.push(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error("Usage: send [--message <text>] [--image <path>] [--file <path>] [text]");
    }
    messageParts.push(arg);
  }

  const message = messageParts.join(" ").trim();
  if (!message && images.length === 0 && files.length === 0) {
    throw new Error("Usage: send [--message <text>] [--image <path>] [--file <path>] [text]");
  }
  if (images.length + files.length > MAX_SIDE_CHANNEL_FILES) {
    throw new Error(`Too many files: maximum ${MAX_SIDE_CHANNEL_FILES}`);
  }
  assertAbsoluteFilePaths([...images, ...files]);

  return {
    message: message || undefined,
    images,
    files,
  };
}

export async function runSideChannelSendCommand(
  argv: string[],
  options: {
    env?: SideChannelSendEnv;
    fetchFn?: typeof fetch;
    readStdin?: () => Promise<string>;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const url = env.CCTB_SEND_URL;
  if (!url) {
    throw new Error("CCTB_SEND_URL is not set; this command only works inside an active Telegram turn.");
  }

  let args = argv;
  const stdinIndex = args.indexOf("--stdin");
  if (stdinIndex !== -1) {
    const readStdin = options.readStdin ?? (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    });
    const stdinText = (await readStdin()).trim();
    args = [...args.slice(0, stdinIndex), ...args.slice(stdinIndex + 1), stdinText].filter(Boolean);
  }

  const payload = parseSideChannelSendArgs(args);
  const fetchImpl = options.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.CCTB_SEND_TOKEN) {
    headers.authorization = `Bearer ${env.CCTB_SEND_TOKEN}`;
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.trim() || `side-channel send failed with HTTP ${response.status}`);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_SIDE_CHANNEL_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizePayload(value: unknown): SideChannelSendPayload {
  if (!value || typeof value !== "object") {
    throw new Error("invalid JSON payload");
  }
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : undefined;
  const images = Array.isArray(record.images)
    ? record.images.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const files = Array.isArray(record.files)
    ? record.files.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

  if (!message && images.length === 0 && files.length === 0) {
    throw new Error("message or file is required");
  }
  if (images.length + files.length > MAX_SIDE_CHANNEL_FILES) {
    throw new Error(`too many files: maximum ${MAX_SIDE_CHANNEL_FILES}`);
  }
  assertAbsoluteFilePaths([...images, ...files]);

  return { message, images, files };
}

function payloadToDeliveryText(payload: SideChannelSendPayload): string {
  const lines: string[] = [];
  if (payload.message) {
    lines.push(payload.message);
  }
  for (const filePath of [...payload.images, ...payload.files]) {
    lines.push(`[send-file:${filePath}]`);
  }
  return lines.join("\n");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function uniqueFilePaths(payload: SideChannelSendPayload): string[] {
  return [...new Set([...payload.images, ...payload.files])];
}

export async function startSideChannelSendServer(options: SideChannelSendServerOptions): Promise<SideChannelSendServer> {
  const token = randomBytes(24).toString("base64url");
  const expectedPath = `/send/${token}`;
  const sentFilePaths = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      if (
        req.method !== "POST" ||
        requestUrl.pathname !== expectedPath ||
        (bearer && !safeEqual(bearer, token))
      ) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      const payload = normalizePayload(await readJsonBody(req));
      const requestedFilePaths = uniqueFilePaths(payload);
      const acceptedFilePaths = new Set<string>();
      const filesSent = await deliverTelegramResponse(
        options.api,
        options.chatId,
        payloadToDeliveryText(payload),
        options.inboxDir,
        options.workspaceOverride,
        options.requestOutputDir,
        options.locale,
        {
          source: "side-channel",
          onFileAccepted: (sourcePath) => {
            acceptedFilePaths.add(sourcePath);
            sentFilePaths.add(sourcePath);
          },
        },
      );
      if (acceptedFilePaths.size < requestedFilePaths.length) {
        const missingCount = requestedFilePaths.length - acceptedFilePaths.size;
        sendJson(res, 400, {
          ok: false,
          error: `${missingCount} file${missingCount === 1 ? "" : "s"} not delivered by side-channel send`,
          filesSent,
        });
        return;
      }
      sendJson(res, 200, { ok: true, filesSent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { ok: false, error: message });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("side-channel send server did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}${expectedPath}`,
    token,
    getSentFilePaths: () => [...sentFilePaths],
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          for (const socket of sockets) {
            socket.destroy();
          }
          resolve();
        }, SIDE_CHANNEL_CLOSE_TIMEOUT_MS);
        server.close((error) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function createSideChannelSendHelper(
  dirPath: string,
  cliCommand: string[] = [process.execPath, process.argv[1] ?? "dist/src/index.js", "send"],
  embeddedEnv?: Pick<SideChannelSendEnv, "CCTB_SEND_URL" | "CCTB_SEND_TOKEN">,
): Promise<string> {
  await mkdir(dirPath, { recursive: true });
  const helperPath = path.join(dirPath, process.platform === "win32" ? "cctb-send.cmd" : "cctb-send");
  if (process.platform === "win32") {
    const command = cliCommand.map((part) => `"${part.replace(/"/g, '""')}"`).join(" ");
    const envLines = [
      embeddedEnv?.CCTB_SEND_URL ? `set "CCTB_SEND_URL=${embeddedEnv.CCTB_SEND_URL}"` : "",
      embeddedEnv?.CCTB_SEND_TOKEN ? `set "CCTB_SEND_TOKEN=${embeddedEnv.CCTB_SEND_TOKEN}"` : "",
    ].filter(Boolean);
    await writeFile(helperPath, `@echo off\r\n${envLines.join("\r\n")}${envLines.length > 0 ? "\r\n" : ""}${command} %*\r\n`, "utf8");
    return helperPath;
  }

  const command = cliCommand.map(quoteSh).join(" ");
  const envLines = [
    embeddedEnv?.CCTB_SEND_URL ? `CCTB_SEND_URL=${quoteSh(embeddedEnv.CCTB_SEND_URL)}\nexport CCTB_SEND_URL` : "",
    embeddedEnv?.CCTB_SEND_TOKEN ? `CCTB_SEND_TOKEN=${quoteSh(embeddedEnv.CCTB_SEND_TOKEN)}\nexport CCTB_SEND_TOKEN` : "",
  ].filter(Boolean);
  await writeFile(helperPath, `#!/usr/bin/env sh\n${envLines.join("\n")}${envLines.length > 0 ? "\n" : ""}exec ${command} "$@"\n`, "utf8");
  await chmod(helperPath, 0o700);
  return helperPath;
}
