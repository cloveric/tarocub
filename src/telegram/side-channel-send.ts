import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { executeTelegramTool } from "../tools/telegram-tool-executor.js";
import type { DeliveryAcceptedReceipt, DeliveryReceipts, DeliveryRejectedReceipt } from "./delivery-ledger.js";
import type { TelegramApi } from "./api.js";
import type { Locale } from "./message-renderer.js";
import { isAbsoluteFilePath } from "./file-paths.js";

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
  getDeliveryReceipts: () => DeliveryReceipts;
  close: () => Promise<void>;
}

interface RejectedDeliveryLike {
  path?: unknown;
  reason?: unknown;
  detail?: unknown;
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

export function formatRejectedDeliverySummary(rejected: readonly RejectedDeliveryLike[]): string {
  return rejected
    .map((receipt) => {
      const filePath = typeof receipt.path === "string" ? receipt.path : "";
      const reason = typeof receipt.reason === "string" ? receipt.reason : "";
      const detail = typeof receipt.detail === "string" && receipt.detail ? ` (${receipt.detail})` : "";
      if (!filePath || !reason) {
        return "";
      }
      return `${filePath} — ${reason}${detail}`;
    })
    .filter(Boolean)
    .join("; ");
}

function renderSideChannelHttpError(responseText: string, fallback: string): string {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      rejected?: unknown;
    };
    const message = typeof parsed.error === "string" && parsed.error.trim()
      ? parsed.error.trim()
      : fallback;
    const rejected = Array.isArray(parsed.rejected)
      ? formatRejectedDeliverySummary(parsed.rejected as RejectedDeliveryLike[])
      : "";
    return rejected ? `${message}: ${rejected}` : message;
  } catch {
    return trimmed;
  }
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
    throw new Error(renderSideChannelHttpError(text, `side-channel send failed with HTTP ${response.status}`));
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

export function renderSideChannelDeliveryText(payload: SideChannelSendPayload): string {
  const lines: string[] = [];
  if (payload.message) {
    lines.push(payload.message);
  }
  for (const filePath of payload.images) {
    lines.push(`[send-image:${filePath}]`);
  }
  for (const filePath of payload.files) {
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
  const acceptedReceipts: DeliveryAcceptedReceipt[] = [];
  const rejectedReceipts: DeliveryRejectedReceipt[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      if (
        req.method !== "POST" ||
        requestUrl.pathname !== expectedPath ||
        !bearer ||
        !safeEqual(bearer, token)
      ) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      const payload = normalizePayload(await readJsonBody(req));
      const requestedFilePaths = uniqueFilePaths(payload);
      const acceptedFilePaths = new Set<string>();
      const requestAcceptedReceipts: DeliveryAcceptedReceipt[] = [];
      const requestRejectedReceipts: DeliveryRejectedReceipt[] = [];
      const result = await executeTelegramTool({
        name: "send.batch",
        payload,
        context: {
          cronRuntime: null,
          stateDir: path.dirname(options.inboxDir),
          chatId: options.chatId,
          userId: 0,
          locale: options.locale,
          delivery: {
            api: options.api,
            inboxDir: options.inboxDir,
            workspaceOverride: options.workspaceOverride,
            requestOutputDir: options.requestOutputDir,
            source: "side-channel",
            allowAnyAbsolutePath: true,
            onDeliveryAccepted: (receipt) => {
              acceptedFilePaths.add(receipt.path);
              sentFilePaths.add(receipt.path);
              acceptedReceipts.push(receipt);
              requestAcceptedReceipts.push(receipt);
            },
            onDeliveryRejected: (receipt) => {
              rejectedReceipts.push(receipt);
              requestRejectedReceipts.push(receipt);
            },
          },
        },
      });
      const filesSent = typeof result.metadata?.filesSent === "number" ? result.metadata.filesSent : 0;
      if (acceptedFilePaths.size < requestedFilePaths.length) {
        const missingCount = requestedFilePaths.length - acceptedFilePaths.size;
        sendJson(res, 400, {
          ok: false,
          error: result.error ?? `${missingCount} file${missingCount === 1 ? "" : "s"} not delivered by side-channel send`,
          filesSent,
          accepted: requestAcceptedReceipts,
          rejected: requestRejectedReceipts,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        filesSent,
        accepted: requestAcceptedReceipts,
        rejected: requestRejectedReceipts,
      });
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
    getDeliveryReceipts: () => ({
      accepted: [...acceptedReceipts],
      rejected: [...rejectedReceipts],
    }),
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

function defaultBridgeCliCommand(...args: string[]): string[] {
  return [
    process.execPath,
    path.resolve(process.argv[1] ?? "dist/src/index.js"),
    ...args,
  ];
}

async function writeFileIfChanged(filePath: string, contents: string): Promise<void> {
  try {
    if (await readFile(filePath, "utf8") === contents) {
      return;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(filePath, contents, "utf8");
}

async function secureSideChannelHelperDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmod(dirPath, 0o700);
  const parentPath = path.dirname(dirPath);
  if (path.basename(parentPath) === ".cctb-send") {
    await chmod(parentPath, 0o700);
  }
}

export async function createSideChannelSendHelper(
  dirPath: string,
  cliCommand: string[] = defaultBridgeCliCommand("send"),
  embeddedEnv?: Pick<SideChannelSendEnv, "CCTB_SEND_URL" | "CCTB_SEND_TOKEN">,
): Promise<string> {
  await secureSideChannelHelperDirectory(dirPath);
  const helperPath = path.join(dirPath, process.platform === "win32" ? "cctb-send.cmd" : "cctb-send");
  if (process.platform === "win32") {
    const command = cliCommand.map((part) => `"${part.replace(/"/g, '""')}"`).join(" ");
    const envLines = [
      embeddedEnv?.CCTB_SEND_URL ? `set "CCTB_SEND_URL=${embeddedEnv.CCTB_SEND_URL}"` : "",
      embeddedEnv?.CCTB_SEND_TOKEN ? `set "CCTB_SEND_TOKEN=${embeddedEnv.CCTB_SEND_TOKEN}"` : "",
    ].filter(Boolean);
    await writeFile(helperPath, `@echo off\r\n${envLines.join("\r\n")}${envLines.length > 0 ? "\r\n" : ""}${command} %*\r\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return helperPath;
  }

  const command = cliCommand.map(quoteSh).join(" ");
  const envLines = [
    embeddedEnv?.CCTB_SEND_URL ? `CCTB_SEND_URL=${quoteSh(embeddedEnv.CCTB_SEND_URL)}\nexport CCTB_SEND_URL` : "",
    embeddedEnv?.CCTB_SEND_TOKEN ? `CCTB_SEND_TOKEN=${quoteSh(embeddedEnv.CCTB_SEND_TOKEN)}\nexport CCTB_SEND_TOKEN` : "",
  ].filter(Boolean);
  await writeFile(helperPath, `#!/usr/bin/env sh\n${envLines.join("\n")}${envLines.length > 0 ? "\n" : ""}exec ${command} "$@"\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(helperPath, 0o700);
  return helperPath;
}

export async function createStableCctbCommandHelper(
  dirPath: string,
  cliCommand: string[] = defaultBridgeCliCommand(),
): Promise<string> {
  await mkdir(dirPath, { recursive: true });
  const helperPath = path.join(dirPath, process.platform === "win32" ? "cctb.cmd" : "cctb");

  if (process.platform === "win32") {
    const command = cliCommand.map((part) => `"${part.replace(/"/g, '""')}"`).join(" ");
    await writeFileIfChanged(helperPath, `@echo off\r\n${command} %*\r\n`);
    return helperPath;
  }

  const command = cliCommand.map(quoteSh).join(" ");
  await writeFileIfChanged(helperPath, `#!/usr/bin/env sh\nexec ${command} "$@"\n`);
  await chmod(helperPath, 0o700);
  return helperPath;
}
