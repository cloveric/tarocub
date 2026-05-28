import { existsSync } from "node:fs";
import path from "node:path";

import { normalizeInstanceName } from "./instance.js";
import type { AppConfig } from "./types.js";

export interface EnvSource {
  HOME?: string;
  APPDATA?: string;
  USERPROFILE?: string;
  CODEX_HOME?: string;
  CLAUDE_CONFIG_DIR?: string;
  TAROCUB_INSTANCE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
  CLAUDE_EXECUTABLE?: string;
  ANTIGRAVITY_EXECUTABLE?: string;
}

function resolveHomeDir(env: Pick<EnvSource, "HOME" | "USERPROFILE">): string | undefined {
  if (process.platform === "win32") {
    return env.USERPROFILE ?? env.HOME;
  }

  return env.HOME ?? env.USERPROFILE;
}

const isWindows = process.platform === "win32";

function normalizeExecutablePath(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function resolveDefaultCodexExecutable(env: EnvSource): string {
  if (env.CODEX_EXECUTABLE) {
    return normalizeExecutablePath(env.CODEX_EXECUTABLE);
  }

  if (isWindows) {
    const appData =
      env.APPDATA ??
      (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);

    if (appData) {
      const windowsCodexCmd = path.join(appData, "npm", "codex.cmd");
      if (existsSync(windowsCodexCmd)) {
        return windowsCodexCmd;
      }

      const windowsCodexShim = path.join(appData, "npm", "codex.ps1");
      if (existsSync(windowsCodexShim)) {
        return windowsCodexShim;
      }
    }
  }

  return "codex";
}

function resolveDefaultAntigravityExecutable(env: EnvSource): string {
  if (env.ANTIGRAVITY_EXECUTABLE) {
    return normalizeExecutablePath(env.ANTIGRAVITY_EXECUTABLE);
  }

  if (isWindows) {
    const appData =
      env.APPDATA ??
      (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);

    if (appData) {
      const windowsAntigravityCmd = path.join(appData, "npm", "agy.cmd");
      if (existsSync(windowsAntigravityCmd)) {
        return windowsAntigravityCmd;
      }

      const windowsAntigravityShim = path.join(appData, "npm", "agy.ps1");
      if (existsSync(windowsAntigravityShim)) {
        return windowsAntigravityShim;
      }
    }
  }

  return "agy";
}

export function joinStatePath(base: string, segment: string): string {
  return path.join(base, segment);
}

export function resolveInstanceStateDir(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "TAROCUB_INSTANCE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR"> = process.env,
): string {
  const instanceName = resolveInstanceName(env);

  if (env.CODEX_TELEGRAM_STATE_DIR) {
    return env.CODEX_TELEGRAM_STATE_DIR;
  }

  const homeDir = resolveHomeDir(env);
  if (!homeDir) {
    throw new Error(process.platform === "win32" ? "USERPROFILE or HOME is required" : "HOME or USERPROFILE is required");
  }

  return path.join(homeDir, ".cctb", instanceName);
}

export function resolveInstanceName(
  env: Pick<EnvSource, "TAROCUB_INSTANCE" | "CODEX_TELEGRAM_INSTANCE">,
  fallback = "default",
): string {
  return normalizeInstanceName(env.TAROCUB_INSTANCE ?? env.CODEX_TELEGRAM_INSTANCE ?? fallback);
}

export function resolveConfig(env: EnvSource = process.env): AppConfig {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return resolveBaseConfig(env, telegramBotToken);
}

export function resolveBridgeConfig(env: EnvSource = process.env): AppConfig {
  return resolveBaseConfig(env, env.TELEGRAM_BOT_TOKEN ?? "");
}

function resolveBaseConfig(env: EnvSource, telegramBotToken: string): AppConfig {
  const instanceName = resolveInstanceName(env);
  const stateDir = resolveInstanceStateDir(env);

  return {
    instanceName,
    telegramBotToken,
    stateDir,
    inboxDir: joinStatePath(stateDir, "inbox"),
    accessStatePath: joinStatePath(stateDir, "access.json"),
    sessionStatePath: joinStatePath(stateDir, "session.json"),
    runtimeLogPath: joinStatePath(stateDir, "runtime.log"),
    codexExecutable: resolveDefaultCodexExecutable(env),
    antigravityExecutable: resolveDefaultAntigravityExecutable(env),
  };
}
