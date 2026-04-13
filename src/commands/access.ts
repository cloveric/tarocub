import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { joinStatePath, resolveInstanceStateDir } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { appendAuditEvent } from "../state/audit-log.js";

export interface InstanceTokenEnv {
  HOME?: string;
  USERPROFILE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
}

export interface PersistedInstanceToken {
  instanceName: string;
  stateDir: string;
  envPath: string;
}

export function resolveInstanceAccessStatePath(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return joinStatePath(stateDir, "access.json");
}

export async function writeInstanceBotToken(
  env: InstanceTokenEnv,
  instanceName: string,
  botToken: string,
): Promise<PersistedInstanceToken> {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });
  const envPath = joinStatePath(stateDir, ".env");
  const nextLine = `TELEGRAM_BOT_TOKEN=${JSON.stringify(botToken)}`;
  let contents = nextLine;

  try {
    const existing = await readFile(envPath, "utf8");
    const lines = existing.replace(/\r?\n$/, "").split(/\r?\n/);
    const mergedLines = lines.filter((line) => !line.startsWith("TELEGRAM_BOT_TOKEN="));
    mergedLines.push(nextLine);
    contents = mergedLines.join("\n");
    contents += "\n";
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }

    contents = `${nextLine}\n`;
  }

  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  await appendAuditEvent(stateDir, {
    type: "configure.token",
    instanceName: normalizedInstanceName,
    outcome: "success",
  });

  return { instanceName: normalizedInstanceName, stateDir, envPath };
}
