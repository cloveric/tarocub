import {
  renderCodexEffortSetting,
  renderCodexModelSetting,
  type CodexUserDefaults,
} from "../codex/user-defaults.js";
import type { InstanceEngine } from "../telegram/instance-config.js";
import type { Locale } from "../telegram/message-renderer.js";

export function renderEngineModelSetting(
  engine: InstanceEngine,
  explicitModel: string | undefined,
  codexDefaults: CodexUserDefaults | undefined,
  locale: Locale,
): string {
  if (engine === "codex") {
    return renderCodexModelSetting(explicitModel, codexDefaults, locale);
  }
  if (explicitModel) {
    return explicitModel;
  }
  if (engine === "claude") {
    return locale === "zh"
      ? "默认（Claude CLI 默认；未设置 --model 覆盖）"
      : "default (Claude CLI default; no --model override)";
  }
  return locale === "zh" ? "默认" : "default";
}

export function renderEngineEffortSetting(
  engine: InstanceEngine,
  explicitEffort: string | undefined,
  codexDefaults: CodexUserDefaults | undefined,
  locale: Locale,
): string {
  if (engine === "codex") {
    return renderCodexEffortSetting(explicitEffort, codexDefaults, locale);
  }
  if (explicitEffort) {
    return explicitEffort;
  }
  if (engine === "claude") {
    return locale === "zh"
      ? "默认（Claude CLI 默认；未设置 --effort 覆盖）"
      : "default (Claude CLI default; no --effort override)";
  }
  return locale === "zh" ? "默认" : "default";
}
