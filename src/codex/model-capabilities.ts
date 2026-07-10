import type { EffortLevel } from "../state/config-file-schema.js";

export const CODEX_MODEL_CHOICES = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
] as const;

export const CODEX_EFFORT_COMPATIBILITY_EN = "Sol/Terra support max and ultra; Luna supports max but not ultra.";
export const CODEX_EFFORT_COMPATIBILITY_ZH = "Sol/Terra 支持 max 和 ultra；Luna 支持 max，但不支持 ultra。";

const CODEX_MODEL_MAX_EFFORT: Readonly<Record<string, EffortLevel>> = {
  "gpt-5.6-sol": "ultra",
  "gpt-5.6-terra": "ultra",
  "gpt-5.6-luna": "max",
  "gpt-5.5": "xhigh",
  "gpt-5.4": "xhigh",
  "gpt-5.4-mini": "xhigh",
  "gpt-5.3-codex-spark": "xhigh",
};

const EFFORT_RANK: Readonly<Record<EffortLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultra: 5,
};

export function knownCodexModelSupportsEffort(model: string | undefined, effort: EffortLevel): boolean | undefined {
  if (!model) return undefined;
  const maxEffort = CODEX_MODEL_MAX_EFFORT[model.trim().toLowerCase()];
  if (!maxEffort) return undefined;
  return EFFORT_RANK[effort] <= EFFORT_RANK[maxEffort];
}

export function knownCodexModelMaxEffort(model: string | undefined): EffortLevel | undefined {
  if (!model) return undefined;
  return CODEX_MODEL_MAX_EFFORT[model.trim().toLowerCase()];
}

export function isExtendedCodexEffort(effort: EffortLevel | undefined): effort is "max" | "ultra" {
  return effort === "max" || effort === "ultra";
}
