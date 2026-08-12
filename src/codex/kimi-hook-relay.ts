import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";

export const KIMI_HOOK_RELAY_URL_ENV = "TAROCUB_KIMI_HOOK_URL";
export const KIMI_HOOK_RELAY_TOKEN_ENV = "TAROCUB_KIMI_HOOK_TOKEN";

const PLUGIN_ID = "tarocub-hook-relay";
const PLUGIN_VERSION = "2";
const MAX_HOOK_BODY_BYTES = 1024 * 1024;

export type KimiHookEvent =
  | {
      hookEventName: "TurnStarted";
      sessionId: string;
      cwd?: string;
      turnId: string;
      originKind: string;
      originName?: string;
      prompt?: string;
    }
  | {
      hookEventName: "Stop";
      sessionId: string;
      cwd?: string;
      stopHookActive?: boolean;
    }
  | {
      hookEventName: "StopFailure";
      sessionId: string;
      cwd?: string;
      errorType?: string;
      errorMessage?: string;
    }
  | {
      hookEventName: "Interrupt";
      sessionId: string;
      cwd?: string;
      turnId?: string;
      reason?: string;
    }
  | {
      hookEventName: "TaskStarted";
      sessionId: string;
      cwd?: string;
      taskId: string;
      kind?: string;
      description?: string;
      status?: string;
      detached?: boolean;
      startedAt?: number;
    }
  | {
      hookEventName: "Notification";
      sessionId: string;
      cwd?: string;
      notificationType: string;
      title?: string;
      body?: string;
      severity?: string;
      sourceKind?: string;
      sourceId: string;
    }
  | {
      hookEventName: "SubagentStop";
      sessionId: string;
      cwd?: string;
      agentName?: string;
      response?: string;
    };

type InstalledPluginRecord = Record<string, unknown> & {
  id: string;
  root: string;
  source: string;
  enabled: boolean;
  installedAt: string;
};

type InstalledPluginFile = {
  version: 1;
  plugins: InstalledPluginRecord[];
};

export type KimiHookRelayRuntime = {
  env: NodeJS.ProcessEnv;
  drainAcceptedEvents: () => Promise<void>;
  close: () => Promise<void>;
};

export function isKimiHookRelayVersionSupported(versionOutput: string): boolean {
  const match = versionOutput.match(/(?:^|\s)(\d+)\.(\d+)(?:\.\d+)?(?:\s|$)/);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 32);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requiredString(value: unknown): string | undefined {
  return optionalString(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalIdentifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return optionalString(value);
}

function optionalPromptText(value: unknown): string | undefined {
  const direct = optionalString(value);
  if (direct || !Array.isArray(value)) {
    return direct;
  }
  const parts = value.flatMap((block) => {
    if (typeof block === "string") {
      return [block];
    }
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return [];
    }
    const text = optionalString((block as Record<string, unknown>).text);
    return text ? [text] : [];
  });
  return optionalString(parts.join("\n"));
}

export function parseKimiHookEvent(input: unknown): KimiHookEvent | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const hookEventName = requiredString(raw.hook_event_name);
  const sessionId = requiredString(raw.session_id);
  if (!hookEventName || !sessionId) {
    return null;
  }
  const cwd = optionalString(raw.cwd);

  if (hookEventName === "TurnStarted") {
    const turnId = optionalIdentifier(raw.turn_id);
    const originKind = requiredString(raw.origin_kind);
    if (!turnId || !originKind) {
      return null;
    }
    const originName = optionalString(raw.origin_name);
    const prompt = optionalPromptText(raw.prompt);
    return {
      hookEventName,
      sessionId,
      turnId,
      originKind,
      ...(cwd ? { cwd } : {}),
      ...(originName ? { originName } : {}),
      ...(prompt ? { prompt } : {}),
    };
  }

  if (hookEventName === "Stop") {
    return {
      hookEventName,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(typeof raw.stop_hook_active === "boolean" ? { stopHookActive: raw.stop_hook_active } : {}),
    };
  }

  if (hookEventName === "StopFailure") {
    return {
      hookEventName,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(optionalString(raw.error_type) ? { errorType: optionalString(raw.error_type) } : {}),
      ...(optionalString(raw.error_message) ? { errorMessage: optionalString(raw.error_message) } : {}),
    };
  }

  if (hookEventName === "Interrupt") {
    return {
      hookEventName,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(optionalIdentifier(raw.turn_id) ? { turnId: optionalIdentifier(raw.turn_id) } : {}),
      ...(optionalString(raw.reason) ? { reason: optionalString(raw.reason) } : {}),
    };
  }

  if (hookEventName === "TaskStarted") {
    const taskId = requiredString(raw.task_id);
    if (!taskId) {
      return null;
    }
    return {
      hookEventName,
      sessionId,
      ...(cwd ? { cwd } : {}),
      taskId,
      ...(optionalString(raw.kind) ? { kind: optionalString(raw.kind) } : {}),
      ...(optionalString(raw.description) ? { description: optionalString(raw.description) } : {}),
      ...(optionalString(raw.status) ? { status: optionalString(raw.status) } : {}),
      ...(typeof raw.detached === "boolean" ? { detached: raw.detached } : {}),
      ...(optionalNumber(raw.started_at) !== undefined ? { startedAt: optionalNumber(raw.started_at) } : {}),
    };
  }

  if (hookEventName === "Notification") {
    const notificationType = requiredString(raw.notification_type);
    const sourceId = requiredString(raw.source_id);
    if (!notificationType || !sourceId) {
      return null;
    }
    return {
      hookEventName,
      sessionId,
      ...(cwd ? { cwd } : {}),
      notificationType,
      sourceId,
      ...(optionalString(raw.title) ? { title: optionalString(raw.title) } : {}),
      ...(optionalString(raw.body) ? { body: optionalString(raw.body) } : {}),
      ...(optionalString(raw.severity) ? { severity: optionalString(raw.severity) } : {}),
      ...(optionalString(raw.source_kind) ? { sourceKind: optionalString(raw.source_kind) } : {}),
    };
  }

  if (hookEventName === "SubagentStop") {
    return {
      hookEventName,
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(optionalString(raw.agent_name) ? { agentName: optionalString(raw.agent_name) } : {}),
      ...(optionalString(raw.response) ? { response: optionalString(raw.response) } : {}),
    };
  }

  // SessionHeartbeat is intentionally not accepted. ACP process/transport
  // closure already supplies liveness; a heartbeat is not evidence that a
  // turn or background task is making progress.
  return null;
}

function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_HOOK_BODY_BYTES) {
      throw new Error("Kimi hook payload exceeded the relay limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, statusCode: number, text: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function forwarderSource(): string {
  return `const url = process.env.${KIMI_HOOK_RELAY_URL_ENV};
const token = process.env.${KIMI_HOOK_RELAY_TOKEN_ENV};
if (!url || !token) process.exit(0);

const chunks = [];
let total = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  total += bytes.length;
  if (total > ${MAX_HOOK_BODY_BYTES}) process.exit(0);
  chunks.push(bytes);
}

try {
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tarocub-kimi-hook-token": token,
    },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(3000),
  });
} catch {
  // Observer hooks must never block or fail a Kimi turn when TaroCub exits.
}
`;
}

function relayManifest(command: string): string {
  return `${JSON.stringify({
    name: PLUGIN_ID,
    version: PLUGIN_VERSION,
    description: "Relays Kimi turn and background-task lifecycle events to a local TaroCub process.",
    hooks: [
      { event: "TurnStarted", command, timeout: 5 },
      { event: "Stop", command, timeout: 5 },
      { event: "StopFailure", command, timeout: 5 },
      { event: "Interrupt", command, timeout: 5 },
      { event: "TaskStarted", command, timeout: 5 },
      { event: "Notification", command, timeout: 5 },
      { event: "SubagentStop", command, timeout: 5 },
    ],
  }, null, 2)}\n`;
}

async function readInstalledPlugins(installedPath: string): Promise<InstalledPluginFile> {
  let text: string;
  try {
    text = await readFile(installedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, plugins: [] };
    }
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== "object"
    || parsed === null
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { plugins?: unknown }).plugins)
  ) {
    throw new Error(`Refusing to replace invalid Kimi plugin registry: ${installedPath}`);
  }
  return parsed as InstalledPluginFile;
}

async function writeFileAtomically(filePath: string, contents: string, mode: number): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", mode });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function ensureKimiHookRelayPlugin(engineHomePath: string): Promise<string> {
  const pluginsDir = path.join(engineHomePath, "plugins");
  const pluginRoot = path.join(pluginsDir, PLUGIN_ID);
  const forwarderPath = path.join(pluginRoot, "forward.mjs");
  const manifestPath = path.join(pluginRoot, "kimi.plugin.json");
  const installedPath = path.join(pluginsDir, "installed.json");
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  await chmod(pluginRoot, 0o700).catch(() => undefined);

  const command = `${shellQuote(process.execPath)} ${shellQuote(forwarderPath)}`;
  await writeFileAtomically(forwarderPath, forwarderSource(), 0o700);
  await chmod(forwarderPath, 0o700).catch(() => undefined);
  await writeFileAtomically(manifestPath, relayManifest(command), 0o600);

  await withFileMutex(installedPath, async () => {
    const installed = await readInstalledPlugins(installedPath);
    const existing = installed.plugins.find((plugin) => plugin.id === PLUGIN_ID);
    const now = new Date().toISOString();
    const registryChanged = !existing
      || existing.root !== pluginRoot
      || existing.source !== "local-path"
      || existing.enabled !== true
      || existing.originalSource !== pluginRoot;
    const record: InstalledPluginRecord = {
      ...(existing ?? {}),
      id: PLUGIN_ID,
      root: pluginRoot,
      source: "local-path",
      enabled: true,
      installedAt: existing?.installedAt ?? now,
      ...(registryChanged ? { updatedAt: now } : {}),
      originalSource: pluginRoot,
    };
    const plugins = existing
      ? installed.plugins.map((plugin) => plugin.id === PLUGIN_ID ? record : plugin)
      : [...installed.plugins, record];
    if (registryChanged) {
      const next = `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`;
      await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
      await writeFileAtomically(installedPath, next, 0o600);
    }
  }, { staleLockMs: 30_000 });

  return pluginRoot;
}

export async function startKimiHookRelay(options: {
  engineHomePath: string;
  onEvent: (event: KimiHookEvent) => void | Promise<void>;
}): Promise<KimiHookRelayRuntime> {
  await ensureKimiHookRelayPlugin(options.engineHomePath);
  const token = randomBytes(32).toString("hex");
  let eventChain = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const drainAcceptedEvents = async (): Promise<void> => {
    while (true) {
      const acceptedThrough = eventChain;
      await acceptedThrough;
      if (acceptedThrough === eventChain) {
        return;
      }
    }
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (closing) {
        reply(response, 503, "shutting down");
        return;
      }
      if (request.method !== "POST" || request.url !== "/kimi-hook") {
        reply(response, 404, "not found");
        return;
      }
      const header = request.headers["x-tarocub-kimi-hook-token"];
      const actualToken = Array.isArray(header) ? header[0] : header;
      if (!tokensEqual(actualToken, token)) {
        reply(response, 403, "forbidden");
        return;
      }
      const contentLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_HOOK_BODY_BYTES) {
        reply(response, 413, "payload too large");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readRequestBody(request)) as unknown;
      } catch {
        reply(response, 400, "invalid payload");
        return;
      }
      const event = parseKimiHookEvent(parsed);
      if (!event) {
        reply(response, 422, "unsupported hook event");
        return;
      }
      reply(response, 202, "accepted");
      eventChain = eventChain.then(async () => {
        await options.onEvent(event);
      }).catch(() => undefined);
    })();
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Kimi hook relay did not bind a TCP port");
  }

  return {
    env: {
      [KIMI_HOOK_RELAY_URL_ENV]: `http://127.0.0.1:${address.port}/kimi-hook`,
      [KIMI_HOOK_RELAY_TOKEN_ENV]: token,
    },
    drainAcceptedEvents,
    close: () => {
      if (closePromise) {
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
        });
        await drainAcceptedEvents();
      })();
      return closePromise;
    },
  };
}
