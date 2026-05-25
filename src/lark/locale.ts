import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Locale } from "../telegram/message-renderer.js";

export async function readRawLarkConfig(stateDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function resolveLarkLocale(stateDir: string): Promise<Locale> {
  const rawConfig = await readRawLarkConfig(stateDir);
  return rawConfig.locale === "en" ? "en" : "zh";
}

export function renderLarkBackgroundTaskHeader(locale: Locale): string {
  return locale === "en" ? "Background task completed" : "后台任务完成";
}
