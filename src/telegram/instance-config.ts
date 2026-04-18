import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConfigFileSchema, EFFORT_LEVELS, formatSchemaError } from "../state/config-file-schema.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ResumeState {
  sessionId: string;
  dirName: string;
  workspacePath: string;
  /**
   * @deprecated Kept for backward compatibility. New /resume flows no longer
   * create a symlink because all bots share ~/.claude/ directly.
   */
  symlinkPath?: string;
}

export interface InstanceConfig {
  engine: "codex" | "claude";
  locale: "en" | "zh";
  verbosity: 0 | 1 | 2;
  budgetUsd: number | undefined;
  effort: EffortLevel | undefined;
  model: string | undefined;
  resume: ResumeState | undefined;
}

const VALID_EFFORT_LEVELS: EffortLevel[] = [...EFFORT_LEVELS];

function parseResumeState(raw: unknown): ResumeState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || typeof r.dirName !== "string" || typeof r.workspacePath !== "string") {
    return undefined;
  }
  return {
    sessionId: r.sessionId,
    dirName: r.dirName,
    workspacePath: r.workspacePath,
    symlinkPath: typeof r.symlinkPath === "string" ? r.symlinkPath : undefined,
  };
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  engine: "codex",
  locale: "en",
  verbosity: 1,
  budgetUsd: undefined,
  effort: undefined,
  model: undefined,
  resume: undefined,
};

export async function loadInstanceConfig(stateDir: string): Promise<InstanceConfig> {
  const configPath = path.join(stateDir, "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `Failed to read ${configPath}, falling back to defaults:`,
        error instanceof Error ? error.message : error,
      );
    }
    return { ...DEFAULT_INSTANCE_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      `Malformed ${configPath} (${error instanceof Error ? error.message : error}); running on defaults until this is repaired.`,
    );
    return { ...DEFAULT_INSTANCE_CONFIG };
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    console.error(
      `Malformed ${configPath} (${formatSchemaError(result.error)}); running on defaults until this is repaired.`,
    );
    return { ...DEFAULT_INSTANCE_CONFIG };
  }

  const config = result.data;

  const effort = VALID_EFFORT_LEVELS.includes(config.effort as EffortLevel) ? config.effort as EffortLevel : undefined;
  return {
    engine: config.engine === "claude" ? "claude" : "codex",
    locale: config.locale === "zh" ? "zh" : "en",
    verbosity: config.verbosity === 0 ? 0 : config.verbosity === 2 ? 2 : 1,
    budgetUsd: typeof config.budgetUsd === "number" && config.budgetUsd > 0 ? config.budgetUsd : undefined,
    effort,
    model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
    resume: parseResumeState(config.resume),
  };
}

export async function updateInstanceConfig(
  stateDir: string,
  updater: (config: Record<string, unknown>) => void,
): Promise<void> {
  const configPath = path.join(stateDir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    const existing = await readFile(configPath, "utf8");
    config = JSON.parse(existing) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  updater(config);
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    await rename(tempPath, configPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}
