import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { CronJobInput, CronStore } from "../state/cron-store.js";
import { CronScheduler, validateCronExpression } from "./cron-scheduler.js";

// DEPRECATED: this helper server is no longer wired into per-turn dispatch.
// Engines should emit `[cron-add:...]` tags instead. The module is kept for
// one release as a rollback/debug aid while the cron protocol settles.
export interface CronHelperServer {
  url: string;
  token: string;
  close: () => Promise<void>;
}

export interface CronHelperServerOptions {
  store: CronStore;
  scheduler: CronScheduler;
  chatId: number;
  userId: number;
  chatType?: string;
  allowedActions?: readonly CronHelperAction[];
  logger?: Pick<Console, "error" | "warn">;
}

const MAX_CRON_HELPER_BODY_BYTES = 64 * 1024;
// 5s drain budget. cctb cron add via the engine bash tool typically completes
// in <200ms, but a turn finishing right while a request is mid-flight needs
// more than 1s of grace before we destroy the socket — otherwise the engine
// gets ECONNRESET and may surface that as a turn failure.
const CRON_HELPER_CLOSE_TIMEOUT_MS = 5000;

const VALID_ACTIONS = new Set(["add", "list"] as const);
type CronHelperAction = "add" | "list";

interface AddRequestBody {
  cronExpr?: unknown;
  runAt?: unknown;
  prompt?: unknown;
  description?: unknown;
  sessionMode?: unknown;
  mute?: unknown;
  silent?: unknown;
  timeoutMins?: unknown;
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
    if (size > MAX_CRON_HELPER_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function asString(value: unknown, field: string, { max }: { max?: number } = {}): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (max !== undefined && trimmed.length > max) {
    throw new Error(`${field} exceeds max length ${max}`);
  }
  return trimmed;
}

function asOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > max) {
    throw new Error(`${field} exceeds max length ${max}`);
  }
  return trimmed;
}

function parseRunAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("runAt must be an ISO timestamp string");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid runAt timestamp: "${value}"`);
  }
  if (date.getTime() <= Date.now()) {
    throw new Error("runAt must be in the future");
  }
  return date.toISOString();
}

function cronExprFromRunAt(iso: string): string {
  const date = new Date(iso);
  return [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    "*",
  ].join(" ");
}

function asOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function asOptionalSessionMode(value: unknown): "reuse" | "new_per_run" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value !== "reuse" && value !== "new_per_run") {
    throw new Error("sessionMode must be 'reuse' or 'new_per_run'");
  }
  return value;
}

function asOptionalTimeoutMins(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("timeoutMins must be an integer");
  }
  if (value < 0 || value > 24 * 60) {
    throw new Error("timeoutMins must be between 0 and 1440");
  }
  return value;
}

function buildAddInput(body: AddRequestBody, chatId: number, userId: number): CronJobInput {
  const runAt = parseRunAt(body.runAt);
  const hasCronExpr = body.cronExpr !== undefined && body.cronExpr !== null && body.cronExpr !== "";
  if (runAt && hasCronExpr) {
    throw new Error("use either cronExpr or runAt, not both");
  }

  let cronExpr: string;
  let runOnce = false;
  if (runAt) {
    cronExpr = cronExprFromRunAt(runAt);
    runOnce = true;
  } else {
    cronExpr = asString(body.cronExpr, "cronExpr", { max: 120 });
    if (validateCronExpression(cronExpr) === null) {
      throw new Error(`invalid cron expression: "${cronExpr}"`);
    }
  }
  const prompt = asString(body.prompt, "prompt", { max: 4000 });
  return {
    chatId,
    userId,
    chatType: "private",
    cronExpr,
    prompt,
    description: asOptionalString(body.description, "description", 200),
    runOnce,
    targetAt: runAt,
    sessionMode: asOptionalSessionMode(body.sessionMode),
    mute: asOptionalBoolean(body.mute, "mute"),
    silent: asOptionalBoolean(body.silent, "silent"),
    timeoutMins: asOptionalTimeoutMins(body.timeoutMins),
  };
}

function parseAction(pathname: string, expectedPrefix: string): CronHelperAction | null {
  if (!pathname.startsWith(expectedPrefix)) {
    return null;
  }
  const remainder = pathname.slice(expectedPrefix.length);
  const trimmed = remainder.startsWith("/") ? remainder.slice(1) : remainder;
  if (!trimmed || trimmed.includes("/")) {
    return null;
  }
  return VALID_ACTIONS.has(trimmed as CronHelperAction) ? (trimmed as CronHelperAction) : null;
}

async function handleAdd(
  body: unknown,
  options: CronHelperServerOptions,
): Promise<{ status: number; payload: unknown }> {
  if (!body || typeof body !== "object") {
    return { status: 400, payload: { ok: false, error: "request body must be a JSON object" } };
  }
  const input = {
    ...buildAddInput(body as AddRequestBody, options.chatId, options.userId),
    chatType: options.chatType ?? "private",
  };
  const record = await options.store.add(input);
  await options.scheduler.refresh();
  return { status: 200, payload: { ok: true, job: record } };
}

async function handleList(
  options: CronHelperServerOptions,
): Promise<{ status: number; payload: unknown }> {
  const jobs = await options.store.listByChat(options.chatId);
  return { status: 200, payload: { ok: true, jobs } };
}

export async function startCronHelperServer(
  options: CronHelperServerOptions,
): Promise<CronHelperServer> {
  const token = randomBytes(24).toString("base64url");
  const expectedPrefix = `/cron/${token}`;
  const sockets = new Set<Socket>();
  const logger = options.logger ?? console;
  const allowedActions = new Set<CronHelperAction>(options.allowedActions ?? [...VALID_ACTIONS]);

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const authHeader = req.headers.authorization;
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
      const action = parseAction(requestUrl.pathname, expectedPrefix);
      if (
        req.method !== "POST" ||
        action === null ||
        !bearer ||
        !safeEqual(bearer, token)
      ) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      const body = action === "list" ? null : await readJsonBody(req);
      if (!allowedActions.has(action)) {
        sendJson(res, 403, { ok: false, error: `cron action not allowed: ${action}` });
        return;
      }
      let result: { status: number; payload: unknown };
      switch (action) {
        case "add":
          result = await handleAdd(body, options);
          break;
        case "list":
          result = await handleList(options);
          break;
      }
      sendJson(res, result.status, result.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "request body too large" ? 413 : 400;
      try {
        sendJson(res, status, { ok: false, error: message });
      } catch (writeError) {
        logger.warn(`cron-helper: failed to send error response: ${String(writeError)}`);
      }
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
    throw new Error("cron helper server did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}${expectedPrefix}`,
    token,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          for (const socket of sockets) {
            socket.destroy();
          }
          resolve();
        }, CRON_HELPER_CLOSE_TIMEOUT_MS);
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
