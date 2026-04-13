import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

import { resolveConfig, resolveInstanceStateDir, type EnvSource } from "./config.js";
import { Bridge } from "./runtime/bridge.js";
import { ProcessCodexAdapter } from "./codex/process-adapter.js";
import { ProcessClaudeAdapter } from "./codex/claude-adapter.js";
import { CodexAppServerAdapter } from "./codex/app-server-adapter.js";
import { ClaudeStreamAdapter } from "./codex/claude-stream-adapter.js";
import type { CodexAdapter } from "./codex/adapter.js";
import { AccessStore } from "./state/access-store.js";
import { appendAuditEvent } from "./state/audit-log.js";
import { SessionStore } from "./state/session-store.js";
import { RuntimeStateStore } from "./state/runtime-state.js";
import { TelegramApi } from "./telegram/api.js";
import { handleNormalizedTelegramMessage, type TelegramDeliveryContext } from "./telegram/delivery.js";
import { normalizeUpdate } from "./telegram/update-normalizer.js";
import { SessionManager } from "./runtime/session-manager.js";
import { normalizeInstanceName } from "./instance.js";
import { ChatQueue } from "./runtime/chat-queue.js";
import { classifyFailure } from "./runtime/error-classification.js";

export interface ServiceDependencies {
  api: TelegramApi;
  bridge: Bridge;
}

export interface TelegramServiceContext extends TelegramDeliveryContext {
  chatQueue?: ChatQueue;
}

export interface ResolvedInstanceEnv extends EnvSource {
  HOME?: string;
  USERPROFILE?: string;
  CODEX_TELEGRAM_INSTANCE: string;
  TELEGRAM_BOT_TOKEN: string;
}

export interface ResolvedBotIdentity {
  firstName: string;
  username?: string;
}

export function parseServiceInstanceName(argv: string[]): string {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--instance") {
      if (index + 1 >= argv.length) {
        throw new Error("Invalid instance name");
      }

      return normalizeInstanceName(argv[index + 1]);
    }

    if (argument.startsWith("--instance=")) {
      return normalizeInstanceName(argument.slice("--instance=".length));
    }
  }

  return "default";
}

function parseDotEnvValue(rawLine: string): string | null {
  const trimmed = rawLine.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (key !== "TELEGRAM_BOT_TOKEN") {
    return null;
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  if (!rawValue) {
    return null;
  }

  if (rawValue.startsWith("\"")) {
    return JSON.parse(rawValue) as string;
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
}

export async function readInstanceBotTokenFromEnvFile(env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR">): Promise<string | null> {
  const stateDir = resolveInstanceStateDir(env);
  const envPath = path.join(stateDir, ".env");

  try {
    const contents = await readFile(envPath, "utf8");

    for (const line of contents.split(/\r?\n/)) {
      const token = parseDotEnvValue(line);
      if (token !== null) {
        return token;
      }
    }
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return null;
}

export async function readConfiguredBotToken(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN">,
  instanceName: string,
): Promise<string | null> {
  if (env.TELEGRAM_BOT_TOKEN) {
    return env.TELEGRAM_BOT_TOKEN;
  }

  return readInstanceBotTokenFromEnvFile({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_INSTANCE: normalizeInstanceName(instanceName),
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
  });
}

export async function resolveServiceEnvForInstance(env: EnvSource, instanceName: string): Promise<ResolvedInstanceEnv> {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const baseEnv: {
    HOME?: string;
    USERPROFILE?: string;
    CODEX_HOME?: string;
    CODEX_TELEGRAM_INSTANCE: string;
    CODEX_TELEGRAM_STATE_DIR?: string;
    CODEX_EXECUTABLE?: string;
    CLAUDE_EXECUTABLE?: string;
  } = {
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_HOME: env.CODEX_HOME,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_EXECUTABLE: env.CODEX_EXECUTABLE,
    CLAUDE_EXECUTABLE: env.CLAUDE_EXECUTABLE,
  };

  const telegramBotToken = await readConfiguredBotToken(
    {
      HOME: env.HOME,
      USERPROFILE: env.USERPROFILE,
      CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
      CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    },
    normalizedInstanceName,
  );
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return {
    ...baseEnv,
    TELEGRAM_BOT_TOKEN: telegramBotToken,
  };
}

function resolveSharedCodexHome(env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_HOME">): string | null {
  if (env.CODEX_HOME?.trim()) {
    return env.CODEX_HOME.trim();
  }

  const homeDir = process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    return null;
  }

  return path.join(homeDir, ".codex");
}

async function copyIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }

    throw error;
  }
}

async function seedIsolatedCodexHome(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_HOME">,
  engineHomePath: string,
): Promise<void> {
  const sharedCodexHome = resolveSharedCodexHome(env);
  if (!sharedCodexHome) {
    return;
  }

  if (path.resolve(sharedCodexHome) === path.resolve(engineHomePath)) {
    return;
  }

  await mkdir(engineHomePath, { recursive: true });
  await Promise.all([
    copyIfExists(path.join(sharedCodexHome, "auth.json"), path.join(engineHomePath, "auth.json")),
    copyIfExists(path.join(sharedCodexHome, "config.toml"), path.join(engineHomePath, "config.toml")),
  ]);
}

function resolveSharedClaudeHome(env: Pick<EnvSource, "HOME" | "USERPROFILE">): string | null {
  const homeDir = process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    return null;
  }

  return homeDir;
}

function computeConfigDirHash(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

function execFileAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function propagateMacOsKeychainCredential(engineHomePath: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const resolvedPath = path.resolve(engineHomePath);
  const hash = computeConfigDirHash(resolvedPath);
  const targetService = `Claude Code-credentials-${hash}`;
  const sourceService = "Claude Code-credentials";

  let sourcePassword: string;
  try {
    const result = await execFileAsync("security", [
      "find-generic-password", "-s", sourceService, "-w",
    ]);
    sourcePassword = result.stdout.trimEnd();
    if (!sourcePassword) {
      return;
    }
  } catch {
    return;
  }

  // Always sync — source token may have been refreshed since last start
  const account = process.env.USER ?? "claude";
  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-s", targetService,
      "-a", account,
      "-w", sourcePassword,
      "-U",
    ]);
  } catch {
    // Keychain write failed (e.g. locked keychain) — user will need to run claude login manually
  }
}

async function seedIsolatedClaudeConfig(
  env: Pick<EnvSource, "HOME" | "USERPROFILE">,
  engineHomePath: string,
): Promise<void> {
  const sharedClaudeHome = resolveSharedClaudeHome(env);
  if (!sharedClaudeHome) {
    return;
  }

  await mkdir(engineHomePath, { recursive: true });
  await Promise.all([
    copyIfExists(path.join(sharedClaudeHome, ".claude.json"), path.join(engineHomePath, ".claude.json")),
    copyIfExists(path.join(sharedClaudeHome, ".claude", ".credentials.json"), path.join(engineHomePath, ".credentials.json")),
    propagateMacOsKeychainCredential(engineHomePath),
  ]);
}

export type EngineType = "codex" | "claude";
type ApprovalMode = "normal" | "full-auto" | "bypass";

export async function readInstanceEngine(configPath: string): Promise<EngineType> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { engine?: string };
    if (parsed.engine === "claude") {
      return "claude";
    }
    return "codex";
  } catch {
    return "codex";
  }
}

export async function readApprovalMode(configPath: string): Promise<ApprovalMode> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { approvalMode?: string };
    if (parsed.approvalMode === "full-auto" || parsed.approvalMode === "bypass") {
      return parsed.approvalMode;
    }

    return "normal";
  } catch {
    return "normal";
  }
}

export function resolveEngineRuntime(engine: EngineType, approvalMode: ApprovalMode): "app-server" | "process" {
  if (engine === "claude") {
    return "process";
  }

  if (approvalMode !== "normal") {
    return "process";
  }

  return "app-server";
}

function resolveClaudeExecutable(env: EnvSource): string {
  if (env.CLAUDE_EXECUTABLE) {
    return env.CLAUDE_EXECUTABLE;
  }

  if (process.platform === "win32") {
    const appData =
      env.APPDATA ??
      (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);

    if (appData) {
      const windowsClaudeCmd = path.join(appData, "npm", "claude.cmd");
      if (existsSync(windowsClaudeCmd)) {
        return windowsClaudeCmd;
      }

      const windowsClaudeShim = path.join(appData, "npm", "claude.ps1");
      if (existsSync(windowsClaudeShim)) {
        return windowsClaudeShim;
      }
    }
  }

  return "claude";
}

async function createAdapter(
  env: EnvSource,
  config: ReturnType<typeof resolveConfig>,
  instructionsPath: string,
  configPath: string,
): Promise<CodexAdapter> {
  const engine = await readInstanceEngine(configPath);
  const workspacePath = path.join(config.stateDir, "workspace");
  const approvalMode = await readApprovalMode(configPath);

  if (engine === "claude") {
    const engineHomePath = path.join(config.stateDir, "engine-home");
    await mkdir(workspacePath, { recursive: true });
    await seedIsolatedClaudeConfig(env, engineHomePath);
    return new ClaudeStreamAdapter(resolveClaudeExecutable(env), {
      instructionsPath,
      configPath,
      workspacePath,
      engineHomePath,
    });
  }

  if (resolveEngineRuntime(engine, approvalMode) === "app-server") {
    const engineHomePath = path.join(config.stateDir, "engine-home");
    await mkdir(workspacePath, { recursive: true });
    await seedIsolatedCodexHome(env, engineHomePath);
    return new CodexAppServerAdapter(
      config.codexExecutable,
      workspacePath,
      undefined,
      undefined,
      instructionsPath,
      engineHomePath,
    );
  }

  const engineHomePath = path.join(config.stateDir, "engine-home");
  await mkdir(workspacePath, { recursive: true });
  await seedIsolatedCodexHome(env, engineHomePath);
  return new ProcessCodexAdapter(config.codexExecutable, undefined, undefined, instructionsPath, configPath, engineHomePath, workspacePath);
}

export async function createServiceDependencies(env: EnvSource): Promise<{ config: ReturnType<typeof resolveConfig>; api: TelegramApi; bridge: Bridge }> {
  const config = resolveConfig(env);
  const api = new TelegramApi(config.telegramBotToken);
  const accessStore = new AccessStore(config.accessStatePath);
  const sessionStore = new SessionStore(config.sessionStatePath);
  const instructionsPath = path.join(config.stateDir, "agent.md");
  const configPath = path.join(config.stateDir, "config.json");
  const adapter = await createAdapter(env, config, instructionsPath, configPath);
  const sessionManager = new SessionManager(sessionStore, adapter);
  const bridge = new Bridge(accessStore, sessionManager, adapter);

  return { config, api, bridge };
}

export async function createServiceDependenciesForInstance(
  env: EnvSource,
  instanceName: string,
): Promise<{ config: ReturnType<typeof resolveConfig>; api: TelegramApi; bridge: Bridge }> {
  return createServiceDependencies(await resolveServiceEnvForInstance(env, instanceName));
}

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "reset", description: "Reset conversation session" },
  { command: "compact", description: "Compress session context (Claude only)" },
  { command: "status", description: "Show current session status" },
  { command: "effort", description: "Set effort level (low/medium/high/max/off)" },
  { command: "model", description: "Set model (opus/sonnet/o3/off)" },
  { command: "btw", description: "Ask a side question without affecting session" },
  { command: "continue", description: "Continue a paused task" },
  { command: "ask", description: "Delegate to another bot instance" },
  { command: "fan", description: "Query multiple bots in parallel" },
  { command: "verify", description: "Execute then auto-verify with reviewer" },
  { command: "stop", description: "Stop the current running task" },
  { command: "help", description: "Show available commands" },
];

export async function registerBotCommands(api: TelegramApi): Promise<void> {
  try {
    await api.setMyCommands(BOT_COMMANDS);
  } catch {
    // Best effort — don't block service startup if this fails
  }
}

export async function lookupTelegramBotIdentity(api: TelegramApi): Promise<ResolvedBotIdentity> {
  const identity = await api.getMe();
  return {
    firstName: identity.first_name,
    username: identity.username,
  };
}

const defaultChatQueue = new ChatQueue();
const activeTasks = new Map<number, AbortController>();

export function abortChatTask(chatId: number): boolean {
  const controller = activeTasks.get(chatId);
  if (controller) {
    controller.abort();
    activeTasks.delete(chatId);
    return true;
  }
  return false;
}
const runtimeStateStoreCache = new Map<string, RuntimeStateStore>();

function getRuntimeStateStore(inboxDir: string): RuntimeStateStore {
  const runtimeStatePath = path.join(path.dirname(inboxDir), "runtime-state.json");
  const existing = runtimeStateStoreCache.get(runtimeStatePath);
  if (existing) {
    return existing;
  }

  const store = new RuntimeStateStore(runtimeStatePath);
  runtimeStateStoreCache.set(runtimeStatePath, store);
  return store;
}

function getUpdateId(update: unknown): number | undefined {
  if (typeof update !== "object" || update === null || !("update_id" in update)) {
    return undefined;
  }

  const updateId = (update as { update_id?: unknown }).update_id;
  if (typeof updateId !== "number") {
    return undefined;
  }

  return updateId;
}

function advanceOffset(currentOffset: number | undefined, completedOffset: number | undefined): number | undefined {
  if (completedOffset === undefined) {
    return currentOffset;
  }

  if (currentOffset === undefined) {
    return completedOffset;
  }

  return Math.max(currentOffset, completedOffset);
}

function formatErrorMessage(scope: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${scope}: ${message}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && /aborted/i.test(error.message)) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      typeof (error as { name?: unknown }).name === "string" &&
      ((error as { name: string }).name === "AbortError" || /abort/i.test((error as { name: string }).name)))
  );
}

function isConflictError(error: unknown): boolean {
  return error instanceof Error && /409\s*Conflict/i.test(error.message);
}

async function appendPollFetchFailureAuditEvent(inboxDir: string, error: unknown, offset?: number): Promise<void> {
  await appendAuditEvent(path.dirname(inboxDir), {
    type: "poll.fetch",
    updateId: offset,
    outcome: "error",
    detail: error instanceof Error ? error.message : String(error),
    metadata: {
      failureCategory: classifyFailure(error),
    },
  });
}

async function appendPollFetchFailureAuditEventBestEffort(
  inboxDir: string,
  error: unknown,
  offset?: number,
): Promise<void> {
  try {
    await appendPollFetchFailureAuditEvent(inboxDir, error, offset);
  } catch {
    // Poll fetch failures must still back off or terminate cleanly even if audit persistence fails.
  }
}

async function loadStopLocale(inboxDir: string): Promise<string> {
  try {
    const raw = await readFile(path.join(path.dirname(inboxDir), "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { locale?: string };
    return cfg.locale === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

async function appendUpdateHandleFailureAuditEventBestEffort(
  inboxDir: string,
  instanceName: string | undefined,
  error: unknown,
  updateId?: number,
): Promise<void> {
  try {
    await appendAuditEvent(path.dirname(inboxDir), {
      type: "update.handle",
      instanceName,
      updateId,
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        failureCategory: classifyFailure(error),
      },
    });
  } catch {
    // Update handling errors still need to surface and stop processing even if audit persistence fails.
  }
}

export async function processTelegramUpdates(
  updates: unknown[],
  context: TelegramServiceContext,
  logger: Pick<Console, "error"> = console,
): Promise<number | undefined> {
  let nextOffset: number | undefined;
  const chatQueue = context.chatQueue ?? defaultChatQueue;
  const runtimeStateStore = getRuntimeStateStore(context.inboxDir);
  const runtimeState = await runtimeStateStore.load();
  let lastHandledUpdateId = runtimeState.lastHandledUpdateId;

  for (const update of updates) {
    const updateId = getUpdateId(update);
    const completedOffset = updateId === undefined ? undefined : updateId + 1;

    try {
      if (updateId !== undefined && lastHandledUpdateId !== null && updateId <= lastHandledUpdateId) {
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          updateId,
          outcome: "duplicate",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      const normalized = normalizeUpdate(update);
      if (!normalized) {
        if (updateId !== undefined) {
          await runtimeStateStore.markHandledUpdateId(updateId);
          lastHandledUpdateId = updateId;
        }
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          updateId,
          outcome: "invalid",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      if (!normalized.text && normalized.attachments.length === 0) {
        if (updateId !== undefined) {
          await runtimeStateStore.markHandledUpdateId(updateId);
          lastHandledUpdateId = updateId;
        }
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId,
          outcome: "empty",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      if (/^\/stop(?:@\w+)?(?:\s|$)/i.test(normalized.text.trim())) {
        const aborted = abortChatTask(normalized.chatId);
        const msg = aborted
          ? (await loadStopLocale(context.inboxDir)) === "zh" ? "已停止当前任务。" : "Current task stopped."
          : (await loadStopLocale(context.inboxDir)) === "zh" ? "当前没有运行中的任务。" : "No task is currently running.";
        try { await context.api.sendMessage(normalized.chatId, msg); } catch { /* best effort */ }
        nextOffset = advanceOffset(nextOffset, completedOffset);
        if (updateId !== undefined) {
          await runtimeStateStore.markHandledUpdateId(updateId);
          lastHandledUpdateId = updateId;
        }
        continue;
      }

      await chatQueue.enqueue(normalized.chatId, async () => {
        const taskController = new AbortController();
        activeTasks.set(normalized.chatId, taskController);
        try {
          await handleNormalizedTelegramMessage(normalized, {
            ...context,
            updateId,
            abortSignal: taskController.signal,
            onAuthRetry: async () => {
              const stateDir = path.dirname(context.inboxDir);
              const configPath = path.join(stateDir, "config.json");
              const engine = await readInstanceEngine(configPath);
              const engineHomePath = path.join(stateDir, "engine-home");
              if (engine === "claude") {
                await seedIsolatedClaudeConfig({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, engineHomePath);
              } else {
                await seedIsolatedCodexHome({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME }, engineHomePath);
              }
            },
          });
        } finally {
          activeTasks.delete(normalized.chatId);
        }
      });
      if (updateId !== undefined) {
        await runtimeStateStore.markHandledUpdateId(updateId);
        lastHandledUpdateId = updateId;
      }
      nextOffset = advanceOffset(nextOffset, completedOffset);
    } catch (error) {
      await appendUpdateHandleFailureAuditEventBestEffort(context.inboxDir, context.instanceName, error, updateId);
      logger.error(formatErrorMessage("Failed to handle Telegram update", error));
      nextOffset = advanceOffset(nextOffset, completedOffset);
      continue;
    }
  }

  return nextOffset;
}

export async function getLastHandledUpdateId(inboxDir: string): Promise<number | null> {
  const runtimeStateStore = getRuntimeStateStore(inboxDir);
  const state = await runtimeStateStore.load();
  return state.lastHandledUpdateId;
}

export async function pollTelegramUpdatesOnce(
  api: TelegramApi,
  bridge: Bridge,
  inboxDir: string,
  logger: Pick<Console, "error"> = console,
  offset?: number,
  signal?: AbortSignal,
): Promise<{ offset: number | undefined; hadFetchError: boolean; hadUpdates: boolean; conflict: boolean }> {
  try {
    const updates = await api.getUpdates(offset, signal);
    // Fire-and-forget: process updates in background so polling loop can
    // immediately fetch new updates (needed for /stop to work mid-task).
    // Offset is NOT advanced here — processTelegramUpdates marks handled
    // updates in the runtime state store, and we read back the last handled
    // ID for the next poll to avoid message loss on crash.
    void processTelegramUpdates(updates, { api, bridge, inboxDir }, logger).catch((error) => {
      logger.error(formatErrorMessage("Background update processing failed", error));
    });
    const lastHandled = await getLastHandledUpdateId(inboxDir);
    return {
      offset: lastHandled !== null ? lastHandled + 1 : offset,
      hadFetchError: false,
      hadUpdates: updates.length > 0,
      conflict: false,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        offset,
        hadFetchError: false,
        hadUpdates: false,
        conflict: false,
      };
    }

    if (isConflictError(error)) {
      await appendPollFetchFailureAuditEventBestEffort(inboxDir, error, offset);
      logger.error("409 Conflict: another process is polling this bot token. Shutting down to avoid duplicate replies.");
      return {
        offset,
        hadFetchError: true,
        hadUpdates: false,
        conflict: true,
      };
    }

    await appendPollFetchFailureAuditEventBestEffort(inboxDir, error, offset);
    logger.error(formatErrorMessage("Failed to fetch Telegram updates", error));
    return {
      offset,
      hadFetchError: true,
      hadUpdates: false,
      conflict: false,
    };
  }
}

export async function pollTelegramUpdates(
  api: TelegramApi,
  bridge: Bridge,
  inboxDir: string,
  logger: Pick<Console, "error"> = console,
  signal?: AbortSignal,
): Promise<void> {
  let offset: number | undefined;
  let backoffMs = 1000;
  const maxBackoffMs = 60000;

  while (!signal?.aborted) {
    const previousOffset = offset;
    const result = await pollTelegramUpdatesOnce(api, bridge, inboxDir, logger, offset, signal);
    offset = result.offset;

    if (result.conflict) {
      break;
    }

    if (result.hadFetchError) {
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    } else if (result.hadUpdates && result.offset !== previousOffset) {
      // Got messages — poll again immediately for low latency
      backoffMs = 0;
    } else {
      // No updates — long polling already waited ~30s on Telegram's side,
      // just a tiny gap before the next long-poll request
      backoffMs = 100;
    }

    if (backoffMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}
