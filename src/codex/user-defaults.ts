import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodexUserDefaults {
  configPath: string;
  model?: string;
  effort?: string;
  warning?: string;
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : path.join(os.homedir(), ".codex");
}

function stripInlineComment(value: string): string {
  let inQuote: "\"" | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === "\"" || char === "'") && value[i - 1] !== "\\") {
      inQuote = inQuote === char ? null : inQuote ?? char;
      continue;
    }
    if (char === "#" && inQuote === null) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseTomlStringLiteral(value: string): string | undefined {
  const trimmed = stripInlineComment(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const parsed = trimmed.slice(1, -1);
    return parsed.trim() ? parsed.trim() : undefined;
  }
  return trimmed.trim() ? trimmed.trim() : undefined;
}

function readTopLevelTomlString(raw: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`);
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      return undefined;
    }
    const match = line.match(pattern);
    if (match?.[1]) {
      return parseTomlStringLiteral(match[1]);
    }
  }
  return undefined;
}

export async function loadCodexUserDefaults(): Promise<CodexUserDefaults> {
  const configPath = path.join(resolveCodexHome(), "config.toml");
  try {
    const raw = await readFile(configPath, "utf8");
    return {
      configPath,
      model: readTopLevelTomlString(raw, "model"),
      effort: readTopLevelTomlString(raw, "model_reasoning_effort"),
    };
  } catch (error) {
    return {
      configPath,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

export function renderCodexModelSetting(
  explicitModel: string | undefined,
  defaults: CodexUserDefaults | undefined,
  locale: "en" | "zh",
): string {
  if (explicitModel) {
    return explicitModel;
  }
  if (defaults?.model) {
    return locale === "zh" ? `默认（Codex config: ${defaults.model}）` : `default (Codex config: ${defaults.model})`;
  }
  return locale === "zh" ? "默认" : "default";
}

export function renderCodexEffortSetting(
  explicitEffort: string | undefined,
  defaults: CodexUserDefaults | undefined,
  locale: "en" | "zh",
): string {
  if (explicitEffort) {
    return explicitEffort;
  }
  if (defaults?.effort) {
    return locale === "zh" ? `默认（Codex config: ${defaults.effort}）` : `default (Codex config: ${defaults.effort})`;
  }
  return locale === "zh" ? "默认" : "default";
}
