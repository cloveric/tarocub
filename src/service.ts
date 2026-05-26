import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, symlink, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

import { resolveBridgeConfig, resolveConfig, resolveInstanceStateDir, type EnvSource } from "./config.js";
import { Bridge } from "./runtime/bridge.js";
import { ProcessCodexAdapter } from "./codex/process-adapter.js";
import { ClaudeStreamAdapter } from "./codex/claude-stream-adapter.js";
import { ProcessAntigravityAdapter } from "./codex/antigravity-adapter.js";
import { CodexAppServerAdapter } from "./codex/app-server-adapter.js";
import type { CodexAdapter } from "./codex/adapter.js";
import { AccessStore } from "./state/access-store.js";
import { appendAuditEvent } from "./state/audit-log.js";
import { SessionStore } from "./state/session-store.js";
import { RuntimeStateStore } from "./state/runtime-state.js";
import { TelegramApi, withTelegramMessageThread } from "./telegram/api.js";
import { handleNormalizedTelegramMessage, type TelegramDeliveryContext } from "./telegram/delivery.js";
import { handleTelegramApprovalCommand, isTelegramApprovalCommand } from "./telegram/approval-requests.js";
import { normalizeUpdate, type NormalizedTelegramMessage } from "./telegram/update-normalizer.js";
import { getNormalizedTelegramConversationKey, getTelegramConversationLogScope } from "./telegram/conversation-key.js";
import { SessionManager } from "./runtime/session-manager.js";
import { normalizeInstanceName } from "./instance.js";
import { ChatQueue } from "./runtime/chat-queue.js";
import { classifyFailure } from "./runtime/error-classification.js";
import { loadInstanceConfig, readValidatedConfigFile } from "./telegram/instance-config.js";

export interface ServiceDependencies {
  api: TelegramApi;
  bridge: Bridge;
}

export interface TelegramServiceContext extends TelegramDeliveryContext {
  chatQueue?: ChatQueue;
  botUsername?: string;
}

export interface PollTelegramUpdatesOptions {
  botUsername?: string;
  fetchErrorRecycleThreshold?: number;
  recreateApi?: (api: TelegramApi) => TelegramApi;
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

async function appendTelegramDeliveryFailureAuditBestEffort(
  context: TelegramServiceContext,
  normalized: NonNullable<ReturnType<typeof normalizeUpdate>>,
  updateId: number | undefined,
  action: string,
  error: unknown,
): Promise<void> {
  try {
    await appendAuditEvent(path.dirname(context.inboxDir), {
      type: "telegram.delivery",
      instanceName: context.instanceName,
      chatId: normalized.chatId,
      ...getTelegramConversationLogScope(normalized),
      userId: normalized.userId,
      updateId,
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        action,
        failureCategory: classifyFailure(error),
      },
    });
  } catch {
    // Keep the polling loop alive even if audit persistence is unavailable.
  }
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

const INSTANCE_SERVICE_ENV_KEYS = new Set([
  "ASR_HTTP_URL",
  "ASR_CLI_PYTHON",
  "ASR_CLI_SCRIPT",
  "ASR_SERVICE_COMMAND",
  "ASR_RESTART_AFTER_FAILURES",
  "ASR_RESTART_COOLDOWN_MS",
]);

function parseDotEnvEntry(rawLine: string): { key: string; value: string } | null {
  const trimmed = rawLine.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!key) {
    return null;
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim();

  if (rawValue.startsWith("\"")) {
    return { key, value: JSON.parse(rawValue) as string };
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return { key, value: rawValue.slice(1, -1) };
  }

  return { key, value: rawValue };
}

function parseDotEnvValue(rawLine: string): string | null {
  const entry = parseDotEnvEntry(rawLine);
  if (entry === null || entry.key !== "TELEGRAM_BOT_TOKEN" || !entry.value) {
    return null;
  }

  return entry.value;
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

export async function readInstanceServiceEnvFromEnvFile(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR">,
): Promise<NodeJS.ProcessEnv> {
  const stateDir = resolveInstanceStateDir(env);
  const envPath = path.join(stateDir, ".env");
  const serviceEnv: NodeJS.ProcessEnv = {};

  try {
    const contents = await readFile(envPath, "utf8");

    for (const line of contents.split(/\r?\n/)) {
      const entry = parseDotEnvEntry(line);
      if (entry !== null && INSTANCE_SERVICE_ENV_KEYS.has(entry.key)) {
        serviceEnv[entry.key] = entry.value;
      }
    }
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return serviceEnv;
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
    APPDATA?: string;
    USERPROFILE?: string;
    CODEX_HOME?: string;
    CLAUDE_CONFIG_DIR?: string;
    CODEX_TELEGRAM_INSTANCE: string;
    CODEX_TELEGRAM_STATE_DIR?: string;
    CODEX_EXECUTABLE?: string;
    CLAUDE_EXECUTABLE?: string;
    ANTIGRAVITY_EXECUTABLE?: string;
  } = {
    HOME: env.HOME,
    APPDATA: env.APPDATA,
    USERPROFILE: env.USERPROFILE,
    CODEX_HOME: env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_EXECUTABLE: env.CODEX_EXECUTABLE,
    CLAUDE_EXECUTABLE: env.CLAUDE_EXECUTABLE,
    ANTIGRAVITY_EXECUTABLE: env.ANTIGRAVITY_EXECUTABLE,
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

async function symlinkIfMissing(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
    return; // already exists
  } catch {
    // doesn't exist — proceed
  }
  try {
    await lstat(sourcePath);
  } catch {
    return; // source doesn't exist
  }
  try {
    await symlink(sourcePath, targetPath);
  } catch {
    // symlink failed (e.g. Windows without dev mode)
  }
}

async function syncOrRemove(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT") {
      // Source doesn't exist — remove any stale destination so the consumer
      // falls through to alternate auth sources (e.g. keychain).
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(destinationPath);
      } catch {
        // Destination didn't exist or couldn't be removed — that's fine.
      }
      return;
    }
    throw error;
  }
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
    symlinkIfMissing(path.join(sharedCodexHome, "skills"), path.join(engineHomePath, "skills")),
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
    // Credentials: sync from source OR remove stale copy so Claude falls back
    // to the keychain entry propagated below. Without removal, an old
    // .credentials.json silently shadows the fresh keychain token and the bot
    // stays stuck on 401.
    syncOrRemove(path.join(sharedClaudeHome, ".claude", ".credentials.json"), path.join(engineHomePath, ".credentials.json")),
    propagateMacOsKeychainCredential(engineHomePath),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "skills"), path.join(engineHomePath, "skills")),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "plugins"), path.join(engineHomePath, "plugins")),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "settings.json"), path.join(engineHomePath, "settings.json")),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "settings.local.json"), path.join(engineHomePath, "settings.local.json")),
  ]);
}

export type EngineType = "codex" | "claude" | "antigravity";
type ApprovalMode = "normal" | "full-auto" | "bypass";
type CodexRuntime = "app-server" | "process";

export async function readInstanceRuntimeConfig(configPath: string): Promise<{
  engine: EngineType;
  approvalMode: ApprovalMode;
  codexRuntime: CodexRuntime | undefined;
}> {
  const parsed = await readValidatedConfigFile(configPath);
  const engine = parsed.engine === "claude" || parsed.engine === "antigravity" ? parsed.engine : "codex";
  const approvalMode =
    parsed.approvalMode === "normal" ||
    parsed.approvalMode === "full-auto" ||
    parsed.approvalMode === "bypass"
      ? parsed.approvalMode
      : engine === "antigravity" ? "full-auto" : "normal";
  return {
    engine,
    approvalMode,
    codexRuntime:
      parsed.codexRuntime === "process" || parsed.codexRuntime === "app-server"
        ? parsed.codexRuntime
        : undefined,
  };
}

export async function readInstanceEngine(configPath: string): Promise<EngineType> {
  return (await readInstanceRuntimeConfig(configPath)).engine;
}

export async function readApprovalMode(configPath: string): Promise<ApprovalMode> {
  return (await readInstanceRuntimeConfig(configPath)).approvalMode;
}

export function resolveEngineRuntime(
  engine: EngineType,
  _approvalMode: ApprovalMode,
  codexRuntime?: CodexRuntime,
): "app-server" | "process" | "stream" {
  if (engine === "claude") {
    return "stream";
  }
  if (engine === "antigravity") {
    return "process";
  }

  return codexRuntime ?? "app-server";
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

function resolveAntigravityExecutable(env: EnvSource, configuredExecutable: string): string {
  if (env.ANTIGRAVITY_EXECUTABLE) {
    return env.ANTIGRAVITY_EXECUTABLE;
  }
  return configuredExecutable;
}

/**
 * Recursively copy a directory tree, skipping symlinks and never
 * overwriting an existing destination file. Used to migrate a legacy
 * engine-home tree into the user's shared ~/.claude/ location without
 * clobbering anything that's already there.
 *
 * Safe to re-run; returns the number of files actually copied (0 if the
 * migration has already completed).
 */
async function copyTreeSkipExistingSkipSymlinks(src: string, dst: string): Promise<number> {
  let srcInfo;
  try {
    srcInfo = await lstat(src);
  } catch {
    return 0;
  }
  if (srcInfo.isSymbolicLink()) return 0;

  if (srcInfo.isFile()) {
    if (existsSync(dst)) return 0;
    try {
      await copyFile(src, dst);
      return 1;
    } catch {
      return 0;
    }
  }

  if (!srcInfo.isDirectory()) return 0;

  try {
    await mkdir(dst, { recursive: true });
  } catch {
    return 0;
  }

  let entries: string[];
  try {
    entries = await readdir(src);
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    total += await copyTreeSkipExistingSkipSymlinks(path.join(src, entry), path.join(dst, entry));
  }
  return total;
}

async function migrateClaudeEngineHomeIfPresent(
  stateDir: string,
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR">,
): Promise<void> {
  const engineProjectsDir = path.join(stateDir, "engine-home", "projects");
  if (!existsSync(engineProjectsDir)) return;

  // Mirror the resolution the spawned Claude CLI will actually use: an
  // explicit CLAUDE_CONFIG_DIR wins, otherwise fall back to ~/.claude.
  // Writing to the wrong root would leave files unreachable and defeat the
  // whole migration.
  let claudeConfigDir: string;
  if (env.CLAUDE_CONFIG_DIR) {
    claudeConfigDir = env.CLAUDE_CONFIG_DIR;
  } else {
    const homeDir =
      process.platform === "win32"
        ? env.USERPROFILE ?? env.HOME
        : env.HOME ?? env.USERPROFILE;
    if (!homeDir) return;
    claudeConfigDir = path.join(homeDir, ".claude");
  }

  const targetProjectsDir = path.join(claudeConfigDir, "projects");
  await mkdir(targetProjectsDir, { recursive: true });

  const migrated = await copyTreeSkipExistingSkipSymlinks(engineProjectsDir, targetProjectsDir);
  if (migrated > 0) {
    // Park the legacy directory so we don't redo the work next boot. Keep
    // it around as *.migrated-<timestamp> — evidence for the operator and
    // a cheap rollback path.
    const parkedPath = path.join(stateDir, `engine-home.migrated-${Date.now()}`);
    try {
      await rename(path.join(stateDir, "engine-home"), parkedPath);
    } catch {
      // If rename fails (permission, name clash) we just leave it —
      // copyTree is idempotent so next boot re-scans harmlessly.
    }
  }
}

/**
 * Build the childEnv passed to spawned engine processes.
 *
 * Starts from `process.env` so the child inherits the normal shell
 * environment (PATH, etc.), then overlays the explicit EnvSource that
 * callers of createServiceDependencies* may have provided. This keeps
 * programmatic callers honest: if they inject `CLAUDE_CONFIG_DIR` or
 * `CODEX_HOME` into the EnvSource, the spawned engine actually sees it —
 * not the ambient value on `process.env`.
 */
function buildAdapterChildEnv(env: EnvSource): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.TELEGRAM_BOT_TOKEN;
  delete childEnv.LARK_APP_SECRET;

  const overlay: Array<[keyof EnvSource, string]> = [
    ["HOME", "HOME"],
    ["APPDATA", "APPDATA"],
    ["USERPROFILE", "USERPROFILE"],
    ["CODEX_HOME", "CODEX_HOME"],
    ["CLAUDE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"],
    ["CODEX_TELEGRAM_INSTANCE", "CODEX_TELEGRAM_INSTANCE"],
    ["ANTIGRAVITY_EXECUTABLE", "ANTIGRAVITY_EXECUTABLE"],
  ];
  for (const [srcKey, dstKey] of overlay) {
    const injected = env[srcKey];
    if (injected !== undefined) {
      childEnv[dstKey] = injected;
    }
  }

  return childEnv;
}

async function createAdapter(
  env: EnvSource,
  config: ReturnType<typeof resolveConfig>,
  instructionsPath: string,
  configPath: string,
): Promise<CodexAdapter> {
  const runtimeConfig = await readInstanceRuntimeConfig(configPath);
  const engine = runtimeConfig.engine;
  const workspacePath = path.join(config.stateDir, "workspace");
  const approvalMode = runtimeConfig.approvalMode;
  const engineRuntime = resolveEngineRuntime(engine, approvalMode, runtimeConfig.codexRuntime);
  const childEnv = buildAdapterChildEnv(env);

  if (engine === "claude") {
    // Bots no longer get a per-instance CLAUDE_CONFIG_DIR. Instead they
    // inherit whatever the parent env has — which is either unset (Claude
    // uses ~/.claude/) or whatever the user's own Claude CLI uses (custom
    // path via exported CLAUDE_CONFIG_DIR). Either way, all bots plus the
    // user's CLI end up pointing at the same directory, so OAuth refresh
    // tokens rotate cleanly across all of them.
    //
    // Trade-off: the blast radius is now the user's real config dir.
    // Sessions and auto-memory are still keyed by workspace path (each bot
    // has its own workspace/), so those stay per-bot in practice. But
    // anything the engine writes at the config-dir root (settings,
    // telemetry, MCP state, plugins cache) is shared with the user.
    // full-auto / bypass modes inherit that blast radius too — a bot cannot
    // corrupt only its own engine state anymore.
    //
    // One-shot migration for upgraders: if the legacy engine-home/projects/
    // exists, copy its .jsonl and memory files into ~/.claude/projects/
    // (never overwriting existing files) so bot conversation history and
    // auto-memory survive the upgrade.
    await migrateClaudeEngineHomeIfPresent(config.stateDir, env);
    await mkdir(workspacePath, { recursive: true });
    return new ClaudeStreamAdapter(resolveClaudeExecutable(env), {
      childEnv,
      instructionsPath,
      configPath,
      workspacePath,
    });
  }

  if (engine === "antigravity") {
    await mkdir(workspacePath, { recursive: true });
    return new ProcessAntigravityAdapter(
      resolveAntigravityExecutable(env, config.antigravityExecutable),
      childEnv,
      undefined,
      instructionsPath,
      configPath,
      workspacePath,
    );
  }

  // Same rationale and trade-offs as the Claude branch above: bots inherit
  // CODEX_HOME (or its absence) from the parent env, so they end up on the
  // same config dir as the user's main Codex CLI — avoiding the OAuth
  // refresh-token race at the cost of a wider blast radius.
  if (engineRuntime === "app-server") {
    await mkdir(workspacePath, { recursive: true });
    return new CodexAppServerAdapter(
      config.codexExecutable,
      workspacePath,
      childEnv,
      undefined,
      instructionsPath,
      undefined,
      configPath,
    );
  }

  await mkdir(workspacePath, { recursive: true });
  return new ProcessCodexAdapter(config.codexExecutable, childEnv, undefined, instructionsPath, configPath, undefined, workspacePath);
}

async function createBridgeDependenciesForConfig(
  env: EnvSource,
  config: ReturnType<typeof resolveConfig>,
): Promise<{ config: ReturnType<typeof resolveConfig>; bridge: Bridge }> {
  const accessStore = new AccessStore(config.accessStatePath);
  const sessionStore = new SessionStore(config.sessionStatePath);
  const instructionsPath = path.join(config.stateDir, "agent.md");
  const configPath = path.join(config.stateDir, "config.json");
  const adapter = await createAdapter(env, config, instructionsPath, configPath);
  const sessionManager = new SessionManager(sessionStore, adapter);
  const bridge = new Bridge(accessStore, sessionManager, adapter, {
    loadGroupMode: async () => (await loadInstanceConfig(config.stateDir)).groupMode,
  });

  return { config, bridge };
}

export async function createBridgeDependencies(env: EnvSource): Promise<{ config: ReturnType<typeof resolveConfig>; bridge: Bridge }> {
  return createBridgeDependenciesForConfig(env, resolveBridgeConfig(env));
}

export async function createServiceDependencies(env: EnvSource): Promise<{ config: ReturnType<typeof resolveConfig>; api: TelegramApi; bridge: Bridge }> {
  const config = resolveConfig(env);
  const api = new TelegramApi(config.telegramBotToken);
  const { bridge } = await createBridgeDependenciesForConfig(env, config);

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
  { command: "ultrareview", description: "Run a dedicated code review (Claude Opus 4.7+ only)" },
  { command: "status", description: "Show current session status" },
  { command: "context", description: "Show Claude context fill level (Claude only)" },
  { command: "usage", description: "Show cumulative token & cost usage for this instance" },
  { command: "effort", description: "Set effort level (low/medium/high/xhigh/max/off)" },
  { command: "fast", description: "Toggle Codex Fast Mode (on/off/status)" },
  { command: "goal", description: "Set an engine goal" },
  { command: "model", description: "Set model (opus/sonnet/o3/off; append [1m] for 1M context)" },
  { command: "group", description: "Manage Telegram group access (status/allow/deny/on/off)" },
  { command: "btw", description: "Ask a side question without affecting session" },
  { command: "continue", description: "Continue a paused task" },
  { command: "ask", description: "Delegate to another bot instance" },
  { command: "board", description: "Manage the durable Kanban task board" },
  { command: "mini", description: "Compose group topics into a Mini Bus" },
  { command: "fan", description: "Query multiple bots in parallel" },
  { command: "chain", description: "Run a configured sequential bot chain" },
  { command: "verify", description: "Execute then auto-verify with reviewer" },
  { command: "resume", description: "Resume Claude session, Codex thread, or Antigravity conversation" },
  { command: "detach", description: "Detach resumed session, Codex thread, or Antigravity conversation" },
  { command: "stop", description: "Stop the current running task" },
  { command: "cron", description: "List or manage scheduled tasks (e.g. /cron add 0 9 * * * morning summary)" },
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
const activeTasks = new Map<string | number, AbortController>();
const updateDedupStates = new Map<string, {
  enqueuedUpdateIds: Set<number>;
  completedOutOfOrderUpdateIds: Set<number>;
}>();
const stoppedTaskChats = new Set<string | number>();
const STOPPED_TASK_BOUNDARY = [
  "[Previous task was explicitly stopped by the user.]",
  "Do not continue or resume that stopped task unless the user's new message explicitly asks you to resume it.",
  "Treat the user's new message as a fresh request by default.",
].join("\n");

/** @internal — test-only reset for module-level dedup state */
export function _resetEnqueuedUpdateIds(): void {
  updateDedupStates.clear();
}

/** @internal — test-only reset for module-level stopped-task state */
export function _resetStoppedTaskChats(): void {
  stoppedTaskChats.clear();
}

export function abortChatTask(chatId: number | string, chatQueue: ChatQueue = defaultChatQueue): boolean {
  const controller = activeTasks.get(chatId);
  const hadPending = chatQueue.clearPending(chatId);
  if (controller) {
    controller.abort();
    activeTasks.delete(chatId);
    return true;
  }
  return hadPending;
}

function normalizedConversationKey(normalized: NormalizedTelegramMessage): string {
  return getNormalizedTelegramConversationKey(normalized);
}

function getUpdateDedupState(inboxDir: string): {
  enqueuedUpdateIds: Set<number>;
  completedOutOfOrderUpdateIds: Set<number>;
} {
  const stateKey = path.resolve(inboxDir);
  let state = updateDedupStates.get(stateKey);
  if (!state) {
    state = {
      enqueuedUpdateIds: new Set<number>(),
      completedOutOfOrderUpdateIds: new Set<number>(),
    };
    updateDedupStates.set(stateKey, state);
  }
  return state;
}

export async function runQueuedTelegramTurn(
  normalized: NormalizedTelegramMessage,
  context: TelegramDeliveryContext,
  chatQueue: ChatQueue = defaultChatQueue,
): Promise<void> {
  await chatQueue.enqueue(
    normalizedConversationKey(normalized),
    async () => {
      if (context.abortSignal?.aborted) {
        throw new Error("queued Telegram turn was aborted before execution");
      }
      const taskController = new AbortController();
      const forwardAbort = () => taskController.abort();
      context.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

      activeTasks.set(normalizedConversationKey(normalized), taskController);
      await getRuntimeStateStore(context.inboxDir).markTurnStarted();
      try {
        await handleNormalizedTelegramMessage(normalized, {
          ...context,
          abortSignal: taskController.signal,
          onTurnActivity: async () => {
            await getRuntimeStateStore(context.inboxDir).markTurnActivity();
          },
          runQueuedBridgeTurn: context.runQueuedBridgeTurn ?? (async (conversationKey, job) => {
            if (chatQueue.isBusy(conversationKey)) {
              throw new Error(`target conversation is busy: ${conversationKey}`);
            }
            return await chatQueue.enqueue(conversationKey, job);
          }),
        });
      } finally {
        context.abortSignal?.removeEventListener("abort", forwardAbort);
        if (activeTasks.get(normalizedConversationKey(normalized)) === taskController) {
          activeTasks.delete(normalizedConversationKey(normalized));
        }
        await getRuntimeStateStore(context.inboxDir).markTurnCompleted();
      }
    },
    {
      onSkipped: () => {
        throw new Error("queued Telegram turn was skipped before execution");
      },
    },
  );
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
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    /Telegram API request failed for getUpdates:.*409\s*Conflict/i.test(error.message) ||
    /409\s*Conflict:\s*terminated by other getUpdates request/i.test(error.message)
  );
}

function extractMembershipUpdate(update: unknown): {
  chatId?: number;
  userId?: number;
  chatType?: string;
  oldStatus?: string;
  newStatus?: string;
} | null {
  const membership = (update as { my_chat_member?: unknown })?.my_chat_member;
  if (!membership || typeof membership !== "object") {
    return null;
  }

  const chatId = (membership as { chat?: { id?: unknown } }).chat?.id;
  const chatType = (membership as { chat?: { type?: unknown } }).chat?.type;
  const userId = (membership as { from?: { id?: unknown } }).from?.id;
  const oldStatus = (membership as { old_chat_member?: { status?: unknown } }).old_chat_member?.status;
  const newStatus = (membership as { new_chat_member?: { status?: unknown } }).new_chat_member?.status;

  return {
    chatId: typeof chatId === "number" ? chatId : undefined,
    userId: typeof userId === "number" ? userId : undefined,
    chatType: typeof chatType === "string" ? chatType : undefined,
    oldStatus: typeof oldStatus === "string" ? oldStatus : undefined,
    newStatus: typeof newStatus === "string" ? newStatus : undefined,
  };
}

function isJoinedMembershipStatus(status?: string): boolean {
  return status === "member" || status === "administrator";
}

function normalizeBotUsername(username: string | undefined): string | undefined {
  const normalized = username?.trim().replace(/^@/, "").toLowerCase();
  return normalized ? normalized : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateMessage(update: unknown): Record<string, unknown> | undefined {
  const message = (update as { message?: unknown })?.message;
  return typeof message === "object" && message !== null ? message as Record<string, unknown> : undefined;
}

function messageMentionsBot(message: Record<string, unknown> | undefined, botUsername: string | undefined): boolean {
  const username = normalizeBotUsername(botUsername);
  if (!message || !username) {
    return false;
  }
  const text = typeof message.text === "string"
    ? message.text
    : typeof message.caption === "string"
      ? message.caption
      : "";
  if (new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(username)}\\b`, "i").test(text)) {
    return true;
  }
  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
  ];
  return entities.some((entity) => {
    if (typeof entity !== "object" || entity === null) {
      return false;
    }
    const e = entity as { type?: unknown; offset?: unknown; length?: unknown };
    if (e.type !== "mention" || typeof e.offset !== "number" || typeof e.length !== "number") {
      return false;
    }
    return text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username}`;
  });
}

function messageRepliesToBot(message: Record<string, unknown> | undefined, botUsername: string | undefined): boolean {
  const username = normalizeBotUsername(botUsername);
  if (!message || !username) {
    return false;
  }
  const reply = message.reply_to_message;
  if (typeof reply !== "object" || reply === null) {
    return false;
  }
  const from = (reply as { from?: unknown }).from;
  if (typeof from !== "object" || from === null) {
    return false;
  }
  const replyUsername = normalizeBotUsername((from as { username?: unknown }).username as string | undefined);
  return replyUsername === username;
}

function shouldIgnoreUnaddressedGroupMessage(
  update: unknown,
  normalized: NormalizedTelegramMessage,
  botUsername: string | undefined,
  requireMention: boolean,
): boolean {
  if (!requireMention) {
    return false;
  }
  if (normalized.chatType === "private" || normalized.chatType === "bus" || normalized.callbackQueryId) {
    return false;
  }
  if (/^\/\S/.test(normalized.text.trim())) {
    return false;
  }
  const username = normalizeBotUsername(botUsername);
  if (!username) {
    return false;
  }
  const message = updateMessage(update);
  return !messageMentionsBot(message, username) && !messageRepliesToBot(message, username);
}

function shouldSilenceGroupAccessReply(normalized: NormalizedTelegramMessage): boolean {
  return normalized.chatType !== "private" && normalized.chatType !== "bus";
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

async function appendPollFetchRecoveredAuditEventBestEffort(
  inboxDir: string,
  consecutiveErrors: number,
  threshold: number,
  offset?: number,
): Promise<void> {
  try {
    await appendAuditEvent(path.dirname(inboxDir), {
      type: "poll.fetch",
      updateId: offset,
      outcome: "recovered",
      detail: `Telegram API client recycled after ${consecutiveErrors} consecutive fetch errors`,
      metadata: {
        consecutiveErrors,
        threshold,
      },
    });
  } catch {
    // Recovery itself should continue even if audit persistence is unavailable.
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
  const queuedCompletions: Array<{
    updateId: number | undefined;
    completedOffset: number | undefined;
    run: Promise<unknown>;
  }> = [];
  let nextOffset: number | undefined;
  const chatQueue = context.chatQueue ?? defaultChatQueue;
  const runtimeStateStore = getRuntimeStateStore(context.inboxDir);
  const { enqueuedUpdateIds, completedOutOfOrderUpdateIds } = getUpdateDedupState(context.inboxDir);
  const runtimeState = await runtimeStateStore.load();
  let lastHandledUpdateId = runtimeState.lastHandledUpdateId;

  const flushCompletedUpdateIds = async (): Promise<void> => {
    const latestState = await runtimeStateStore.load();
    lastHandledUpdateId = latestState.lastHandledUpdateId;

    while (true) {
      const candidates = [...completedOutOfOrderUpdateIds]
        .filter((candidate) => lastHandledUpdateId === null || candidate > lastHandledUpdateId)
        .sort((a, b) => a - b);
      const nextCompletedUpdateId = candidates.find((candidate) => {
        for (const pendingUpdateId of enqueuedUpdateIds) {
          if (
            !completedOutOfOrderUpdateIds.has(pendingUpdateId) &&
            (lastHandledUpdateId === null || pendingUpdateId > lastHandledUpdateId) &&
            pendingUpdateId <= candidate
          ) {
            return false;
          }
        }
        return true;
      });

      if (nextCompletedUpdateId === undefined) {
        break;
      }

      await runtimeStateStore.markHandledUpdateId(nextCompletedUpdateId);
      lastHandledUpdateId = nextCompletedUpdateId;
      for (const completedUpdateId of [...completedOutOfOrderUpdateIds]) {
        if (completedUpdateId <= nextCompletedUpdateId) {
          completedOutOfOrderUpdateIds.delete(completedUpdateId);
        }
      }
    }
  };

  const markUpdateCompleted = async (updateId: number): Promise<void> => {
    const latestState = await runtimeStateStore.load();
    lastHandledUpdateId = latestState.lastHandledUpdateId;
    if (lastHandledUpdateId !== null && updateId <= lastHandledUpdateId) {
      completedOutOfOrderUpdateIds.delete(updateId);
      return;
    }

    completedOutOfOrderUpdateIds.add(updateId);
    await flushCompletedUpdateIds();
  };

  for (const update of updates) {
    const updateId = getUpdateId(update);
    const completedOffset = updateId === undefined ? undefined : updateId + 1;

    try {
      if (updateId !== undefined && enqueuedUpdateIds.has(updateId)) {
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      if (updateId !== undefined && completedOutOfOrderUpdateIds.has(updateId)) {
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

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
        const membershipUpdate = extractMembershipUpdate(update);
        if (updateId !== undefined) {
          await markUpdateCompleted(updateId);
        }
        if (membershipUpdate) {
          await appendAuditEvent(path.dirname(context.inboxDir), {
            type: "update.membership",
            instanceName: context.instanceName,
            chatId: membershipUpdate.chatId,
            userId: membershipUpdate.userId,
            updateId,
            outcome: "observed",
            detail: [membershipUpdate.oldStatus, membershipUpdate.newStatus].filter(Boolean).join(" -> ") || undefined,
            metadata: {
              oldStatus: membershipUpdate.oldStatus,
              newStatus: membershipUpdate.newStatus,
            },
          });
          if (
            membershipUpdate.chatId !== undefined &&
            membershipUpdate.userId !== undefined &&
            membershipUpdate.chatType !== undefined &&
            membershipUpdate.chatType !== "private" &&
            !isJoinedMembershipStatus(membershipUpdate.oldStatus) &&
            isJoinedMembershipStatus(membershipUpdate.newStatus)
          ) {
            try {
              const decision = await context.bridge.checkGroupJoin({
                chatId: membershipUpdate.chatId,
                userId: membershipUpdate.userId,
                chatType: membershipUpdate.chatType,
              });
              if (decision.kind !== "allow") {
                await context.api.leaveChat(membershipUpdate.chatId);
              } else {
                const locale = (await loadStopLocale(context.inboxDir)) === "zh" ? "zh" : "en";
                await context.api.sendMessage(
                  membershipUpdate.chatId,
                  locale === "zh"
                    ? "群聊已加入。发送 /group allow 启用当前群；未启用前不会处理普通消息。"
                    : "Joined this group. Send /group allow to enable it; ordinary messages are ignored until then.",
                ).catch(() => {});
              }
            } catch {
              await context.api.leaveChat(membershipUpdate.chatId).catch(() => {});
            }
          }
        } else {
          await appendAuditEvent(path.dirname(context.inboxDir), {
            type: "update.skip",
            instanceName: context.instanceName,
            updateId,
            outcome: "invalid",
          });
        }
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      const groupMode = normalized.chatType !== "private" && normalized.chatType !== "bus" && !normalized.callbackQueryId
        ? (await loadInstanceConfig(path.dirname(context.inboxDir))).groupMode
        : undefined;
      const requireMention = groupMode ? !groupMode.enabled || !groupMode.listenAllChatIds.includes(normalized.chatId) : true;
      if (shouldIgnoreUnaddressedGroupMessage(update, normalized, context.botUsername, requireMention)) {
        if (updateId !== undefined) {
          await markUpdateCompleted(updateId);
        }
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          ...getTelegramConversationLogScope(normalized),
          userId: normalized.userId,
          updateId,
          outcome: "ignored",
          detail: "group message was not addressed to this bot",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      if (!normalized.text && normalized.attachments.length === 0) {
        if (updateId !== undefined) {
          await markUpdateCompleted(updateId);
        }
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          ...getTelegramConversationLogScope(normalized),
          userId: normalized.userId,
          updateId,
          outcome: "empty",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      if (isTelegramApprovalCommand(normalized.text)) {
        const scopedApi = withTelegramMessageThread(context.api, normalized.messageThreadId);
        const locale = (await loadStopLocale(context.inboxDir)) === "zh" ? "zh" : "en";
        const accessDecision = await context.bridge.checkAccess({
          chatId: normalized.chatId,
          userId: normalized.userId,
          chatType: normalized.chatType,
          messageThreadId: normalized.messageThreadId,
          conversationKey: normalized.conversationKey,
          locale,
        });

        if (accessDecision.kind === "allow") {
          await handleTelegramApprovalCommand({ normalized, api: scopedApi });
        } else {
          if (normalized.callbackQueryId) {
            try {
              await scopedApi.answerCallbackQuery(normalized.callbackQueryId);
            } catch (error) {
              await appendTelegramDeliveryFailureAuditBestEffort(context, normalized, updateId, "approval.answerCallbackQuery", error);
            }
          }
          const msg = accessDecision.text ?? (locale === "zh" ? "当前聊天未获授权。" : "This chat is not authorized for this instance.");
          if (!shouldSilenceGroupAccessReply(normalized)) {
            try {
              await scopedApi.sendMessage(normalized.chatId, msg);
            } catch (error) {
              await appendTelegramDeliveryFailureAuditBestEffort(context, normalized, updateId, "approval.sendMessage", error);
            }
          }
        }
        nextOffset = advanceOffset(nextOffset, completedOffset);
        if (updateId !== undefined) {
          await markUpdateCompleted(updateId);
        }
        continue;
      }

      if (/^\/stop(?:@\w+)?(?:\s|$)/i.test(normalized.text.trim())) {
        const scopedApi = withTelegramMessageThread(context.api, normalized.messageThreadId);
        if (updateId !== undefined) {
          enqueuedUpdateIds.add(updateId);
        }
        try {
          const locale = (await loadStopLocale(context.inboxDir)) === "zh" ? "zh" : "en";
          const accessDecision = await context.bridge.checkAccess({
            chatId: normalized.chatId,
            userId: normalized.userId,
            chatType: normalized.chatType,
            messageThreadId: normalized.messageThreadId,
            conversationKey: normalized.conversationKey,
            locale,
          });

          const stopped = accessDecision.kind === "allow"
            ? abortChatTask(normalizedConversationKey(normalized), chatQueue)
            : false;
          if (stopped) {
            stoppedTaskChats.add(normalizedConversationKey(normalized));
          }

          const msg = accessDecision.kind === "allow"
            ? stopped
              ? locale === "zh" ? "已停止当前任务。" : "Current task stopped."
              : locale === "zh" ? "当前没有运行中的任务。" : "No task is currently running."
            : accessDecision.text ?? (locale === "zh" ? "当前聊天未获授权。" : "This chat is not authorized for this instance.");
          if (accessDecision.kind === "allow" || !shouldSilenceGroupAccessReply(normalized)) {
            try {
              await scopedApi.sendMessage(normalized.chatId, msg);
            } catch (error) {
              await appendTelegramDeliveryFailureAuditBestEffort(context, normalized, updateId, "stop.sendMessage", error);
            }
          }
          try {
            await appendAuditEvent(path.dirname(context.inboxDir), {
              type: "update.handle",
              instanceName: context.instanceName,
              chatId: normalized.chatId,
              ...getTelegramConversationLogScope(normalized),
              userId: normalized.userId,
              updateId,
              outcome: "success",
              metadata: {
                command: "stop",
                stopped,
              },
            });
          } catch {
            // Stopping a task is control-plane behavior; a late audit write failure
            // must not keep the Telegram update unacknowledged.
          }
          nextOffset = advanceOffset(nextOffset, completedOffset);
          if (updateId !== undefined) {
            await markUpdateCompleted(updateId);
          }
        } finally {
          if (updateId !== undefined) {
            enqueuedUpdateIds.delete(updateId);
          }
        }
        continue;
      }

      const shouldFenceStoppedTask =
        stoppedTaskChats.has(normalizedConversationKey(normalized)) &&
        !/^\/\S/.test(normalized.text.trim()) &&
        (normalized.text.trim().length > 0 || normalized.attachments.length > 0);
      if (!shouldFenceStoppedTask && stoppedTaskChats.has(normalizedConversationKey(normalized)) && /^\/\S/.test(normalized.text.trim())) {
        stoppedTaskChats.delete(normalizedConversationKey(normalized));
      }
      const effectiveNormalized = shouldFenceStoppedTask
        ? {
            ...normalized,
            text: normalized.text.trim().length > 0
              ? `${STOPPED_TASK_BOUNDARY}\n\nUser's new message:\n${normalized.text}`
              : `${STOPPED_TASK_BOUNDARY}\n\nThe user sent attachments without additional text.`,
          }
        : normalized;
      if (shouldFenceStoppedTask) {
        stoppedTaskChats.delete(normalizedConversationKey(normalized));
      }

      if (updateId !== undefined) {
        enqueuedUpdateIds.add(updateId);
      }
      const queuedRun = chatQueue.enqueue(normalizedConversationKey(normalized), async () => {
        const taskController = new AbortController();
        activeTasks.set(normalizedConversationKey(normalized), taskController);
        await runtimeStateStore.markTurnStarted();
        try {
          await handleNormalizedTelegramMessage(effectiveNormalized, {
            ...context,
            updateId,
            abortSignal: taskController.signal,
            onTurnActivity: async () => {
              await runtimeStateStore.markTurnActivity();
            },
            runQueuedBridgeTurn: context.runQueuedBridgeTurn ?? (async (conversationKey, job) => {
              if (chatQueue.isBusy(conversationKey)) {
                throw new Error(`target conversation is busy: ${conversationKey}`);
              }
              return await chatQueue.enqueue(conversationKey, job);
            }),
            onAuthRetry: async () => {
              // Both Claude and Codex now read the user's ~/.claude/ or
              // ~/.codex/ directly, so there is no per-bot credential copy
              // to re-propagate. The retry itself still happens — the
              // underlying CLI just reads the refreshed credential.
            },
          });
        } finally {
          activeTasks.delete(normalizedConversationKey(normalized));
          await runtimeStateStore.markTurnCompleted();
        }
      });
      queuedCompletions.push({
        updateId,
        completedOffset,
        run: queuedRun,
      });
    } catch (error) {
      if (updateId !== undefined) {
        await markUpdateCompleted(updateId);
        enqueuedUpdateIds.delete(updateId);
      }
      await appendUpdateHandleFailureAuditEventBestEffort(context.inboxDir, context.instanceName, error, updateId);
      logger.error(formatErrorMessage("Failed to handle Telegram update", error));
      nextOffset = advanceOffset(nextOffset, completedOffset);
      continue;
    }
  }

  for (const queued of queuedCompletions) {
    try {
      await queued.run;
      if (queued.updateId !== undefined) {
        await markUpdateCompleted(queued.updateId);
        enqueuedUpdateIds.delete(queued.updateId);
      }
      nextOffset = advanceOffset(nextOffset, queued.completedOffset);
    } catch (error) {
      if (queued.updateId !== undefined) {
        await markUpdateCompleted(queued.updateId);
        enqueuedUpdateIds.delete(queued.updateId);
      }
      await appendUpdateHandleFailureAuditEventBestEffort(
        context.inboxDir,
        context.instanceName,
        error,
        queued.updateId,
      );
      logger.error(formatErrorMessage("Failed to handle Telegram update", error));
      nextOffset = advanceOffset(nextOffset, queued.completedOffset);
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
  options: PollTelegramUpdatesOptions = {},
): Promise<{ offset: number | undefined; hadFetchError: boolean; hadUpdates: boolean; conflict: boolean }> {
  try {
    const updates = await api.getUpdates(offset, signal);
    // Fire-and-forget: process updates in background so polling loop can
    // immediately fetch new updates (needed for /stop to work mid-task).
    // Offset is NOT advanced here — processTelegramUpdates marks handled
    // updates in the runtime state store, and we read back the last handled
    // ID for the next poll to avoid message loss on crash.
    void processTelegramUpdates(updates, { api, bridge, inboxDir, botUsername: options.botUsername }, logger).catch((error) => {
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
  options: PollTelegramUpdatesOptions = {},
): Promise<void> {
  let currentApi = api;
  let offset: number | undefined;
  let backoffMs = 1000;
  const maxBackoffMs = 60000;
  const fetchErrorRecycleThreshold = Math.max(1, Math.floor(options.fetchErrorRecycleThreshold ?? 10));
  const recreateApi = options.recreateApi ?? ((current: TelegramApi) => current.recreate());
  let consecutiveFetchErrors = 0;

  while (!signal?.aborted) {
    const previousOffset = offset;
    const result = await pollTelegramUpdatesOnce(currentApi, bridge, inboxDir, logger, offset, signal, options);
    offset = result.offset;

    if (result.conflict) {
      break;
    }

    if (result.hadFetchError) {
      consecutiveFetchErrors += 1;
      if (consecutiveFetchErrors >= fetchErrorRecycleThreshold) {
        try {
          currentApi = recreateApi(currentApi);
          await appendPollFetchRecoveredAuditEventBestEffort(
            inboxDir,
            consecutiveFetchErrors,
            fetchErrorRecycleThreshold,
            offset,
          );
          consecutiveFetchErrors = 0;
        } catch (error) {
          logger.error(formatErrorMessage("Failed to recycle Telegram API client", error));
        }
      }
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    } else if (result.hadUpdates && result.offset !== previousOffset) {
      consecutiveFetchErrors = 0;
      // Got messages — poll again immediately for low latency
      backoffMs = 0;
    } else if (result.hadUpdates && result.offset === previousOffset) {
      consecutiveFetchErrors = 0;
      // We saw updates but did not advance the handled offset yet. That means
      // at least one update is still in flight, was deferred, or failed before
      // bookkeeping completed. Back off to avoid a tight loop that keeps
      // re-fetching the same update IDs immediately.
      backoffMs = 1000;
    } else {
      consecutiveFetchErrors = 0;
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
