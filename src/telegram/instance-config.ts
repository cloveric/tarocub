import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

import {
  ConfigFileSchema,
  EFFORT_LEVELS,
  formatSchemaError,
  type ConfigFile,
} from "../state/config-file-schema.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../state/approval-mode.js";
import { normalizeCronTimezone, resolveDefaultCronTimezone } from "../state/cron-timezone.js";
import { withFileMutex } from "../state/file-mutex.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type InstanceEngine = "codex" | "claude" | "antigravity";

export const DEFAULT_CLAUDE_MODEL = "opus[1m]";
export const DEFAULT_CLAUDE_EFFORT: EffortLevel = "xhigh";

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
  engine: InstanceEngine;
  locale: "en" | "zh";
  verbosity: 0 | 1 | 2;
  budgetUsd: number | undefined;
  effort: EffortLevel | undefined;
  model: string | undefined;
  codexServiceTier: "fast" | undefined;
  timezone: string;
  resume: ResumeState | undefined;
  workspacePath: string | undefined;
  workspaceProfiles: WorkspaceProfile[];
  groupMode: GroupModeConfig;
}

export interface WorkspaceProfile {
  name: string;
  path: string;
  updatedAt: string;
}

export interface GroupModeConfig {
  enabled: boolean;
  allowedChatIds: number[];
  listenAllChatIds: number[];
}

const VALID_EFFORT_LEVELS: EffortLevel[] = [...EFFORT_LEVELS];

function applyClaudeEngineDefaults(config: Record<string, unknown>, previousEngine: InstanceEngine | undefined): void {
  const modelOverride = typeof config.model === "string" && config.model.trim().length > 0
    ? config.model.trim()
    : undefined;
  const effortOverride = VALID_EFFORT_LEVELS.includes(config.effort as EffortLevel)
    ? config.effort as EffortLevel
    : undefined;

  if (previousEngine !== "claude" || modelOverride === undefined) {
    config.model = DEFAULT_CLAUDE_MODEL;
  } else {
    config.model = modelOverride;
  }
  if (previousEngine !== "claude" || effortOverride === undefined) {
    config.effort = DEFAULT_CLAUDE_EFFORT;
  }
}

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
  codexServiceTier: undefined,
  timezone: resolveDefaultCronTimezone(),
  resume: undefined,
  workspacePath: undefined,
  workspaceProfiles: [],
  groupMode: {
    enabled: true,
    allowedChatIds: [],
    listenAllChatIds: [],
  },
};

function parseGroupMode(raw: unknown): GroupModeConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_INSTANCE_CONFIG.groupMode;
  }
  const r = raw as Record<string, unknown>;
  const allowedChatIds = Array.isArray(r.allowedChatIds)
    ? [...new Set(r.allowedChatIds.filter((value): value is number => Number.isInteger(value)))]
    : [];
  const enabled = r.enabled === false ? false : true;
  const listenAllChatIds = enabled && Array.isArray(r.listenAllChatIds)
    ? [...new Set(r.listenAllChatIds.filter((value): value is number => Number.isInteger(value)))]
    : [];
  return {
    enabled,
    allowedChatIds,
    listenAllChatIds,
  };
}

function parseWorkspaceProfiles(raw: unknown): WorkspaceProfile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const profiles = new Map<string, WorkspaceProfile>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.path !== "string") {
      continue;
    }
    const name = record.name.trim();
    const profilePath = record.path.trim();
    if (!name || !profilePath) {
      continue;
    }
    profiles.set(name, {
      name,
      path: profilePath,
      updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt
        : new Date(0).toISOString(),
    });
  }
  return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveInstanceWorkspacePath(config: Pick<InstanceConfig, "workspacePath" | "resume">): string | undefined {
  return config.workspacePath ?? config.resume?.workspacePath;
}

export function applyEngineSelection(
  config: Record<string, unknown>,
  engine: InstanceEngine,
): { clearedModel: boolean; enabledFullAuto: boolean } {
  const previousEngine =
    config.engine === "claude" || config.engine === "codex" || config.engine === "antigravity"
      ? config.engine
      : undefined;
  const hadModelOverride = typeof config.model === "string" && config.model.trim().length > 0;

  config.engine = engine;

  const clearedModel = previousEngine !== undefined && previousEngine !== engine && hadModelOverride;
  if (clearedModel) {
    delete config.model;
  }
  if (engine !== "codex") {
    delete config.codexServiceTier;
  }
  if (engine === "claude") {
    applyClaudeEngineDefaults(config, previousEngine);
  }
  if (normalizeApprovalMode(config.approvalMode) === undefined) {
    config.approvalMode = DEFAULT_APPROVAL_MODE;
  }
  let enabledFullAuto = false;
  if (engine === "antigravity" && config.approvalMode === "normal") {
    enabledFullAuto = true;
    config.approvalMode = "full-auto";
  }

  return { clearedModel, enabledFullAuto };
}

export async function readValidatedConfigFile(configPath: string): Promise<ConfigFile> {
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
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      `Malformed ${configPath} (${error instanceof Error ? error.message : error}); running on defaults until this is repaired.`,
    );
    return {};
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    // One invalid field must not discard the WHOLE config (engine would silently
    // flip to codex, the group allowlist would empty, ...). Salvage field by field:
    // keep every known field that validates on its own, drop only the bad ones.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(
        `Malformed ${configPath} (${formatSchemaError(result.error)}); running on defaults until this is repaired.`,
      );
      return {};
    }
    const shape = ConfigFileSchema.shape as Record<string, z.ZodTypeAny | undefined>;
    const salvaged: Record<string, unknown> = {};
    const droppedFields: string[] = [];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const fieldSchema = shape[key];
      if (!fieldSchema) {
        // Unknown keys pass through, matching the schema's passthrough behavior.
        salvaged[key] = value;
        continue;
      }
      const fieldResult = fieldSchema.safeParse(value);
      if (fieldResult.success) {
        salvaged[key] = fieldResult.data;
      } else {
        droppedFields.push(key);
      }
    }
    console.error(
      `Malformed ${configPath} (${formatSchemaError(result.error)}); dropped invalid field(s) [${droppedFields.join(", ")}] and kept the rest until this is repaired.`,
    );
    return salvaged as ConfigFile;
  }

  return result.data;
}

export async function loadInstanceConfig(stateDir: string): Promise<InstanceConfig> {
  const configPath = path.join(stateDir, "config.json");
  const config = await readValidatedConfigFile(configPath);

  const effort = VALID_EFFORT_LEVELS.includes(config.effort as EffortLevel) ? config.effort as EffortLevel : undefined;
  return {
    engine: config.engine === "claude" || config.engine === "antigravity" ? config.engine : "codex",
    locale: config.locale === "zh" ? "zh" : "en",
    verbosity: config.verbosity === 0 ? 0 : config.verbosity === 2 ? 2 : 1,
    budgetUsd: typeof config.budgetUsd === "number" && config.budgetUsd > 0 ? config.budgetUsd : undefined,
    effort,
    model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
    codexServiceTier: config.codexServiceTier === "fast" ? "fast" : undefined,
    timezone: normalizeCronTimezone(config.timezone) ?? DEFAULT_INSTANCE_CONFIG.timezone,
    resume: parseResumeState(config.resume),
    workspacePath: typeof config.workspacePath === "string" && config.workspacePath.trim()
      ? config.workspacePath.trim()
      : undefined,
    workspaceProfiles: parseWorkspaceProfiles(config.workspaceProfiles),
    groupMode: parseGroupMode(config.groupMode),
  };
}

export async function updateInstanceConfig(
  stateDir: string,
  updater: (config: Record<string, unknown>) => void,
): Promise<void> {
  const configPath = path.join(stateDir, "config.json");
  await withFileMutex(configPath, async () => {
    let config: Record<string, unknown> = {};
    try {
      const existing = await readFile(configPath, "utf8");
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Missing file — start fresh.
      } else if (error instanceof SyntaxError) {
        // Corrupt JSON: loadInstanceConfig already tolerates this on the read
        // path (falls back to defaults), but throwing here would brick every
        // config-mutating command (/engine, /model, /budget, ...). Quarantine the
        // bad file and start fresh so commands work; the original is kept as .bak.
        await rename(configPath, `${configPath}.corrupt.${Date.now()}.bak`).catch(() => {});
        console.error(`Corrupt ${configPath}; quarantined and reset:`, error.message);
      } else {
        throw error; // transient I/O — don't clobber the intact file
      }
    }
    updater(config);
    const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    try {
      // fsync before rename (matching JsonStore.write) so a crash right after the
      // rename can't leave an empty/truncated config.json behind.
      const tempHandle = await open(tempPath, "r");
      try {
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }
      await rename(tempPath, configPath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  });
}
