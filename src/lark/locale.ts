import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";
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

/** Shared with the Telegram channel so the two cannot disagree on a status. */
export function renderLarkBackgroundTaskHeader(locale: Locale, status?: string): string {
  return renderBackgroundTaskHeader(locale, status);
}

export function renderLarkStopResult(stopped: boolean, locale: Locale): string {
  if (locale === "en") {
    return stopped ? "Stopped." : "No active task.";
  }
  return stopped ? "已停止。" : "当前没有正在运行的任务。";
}

export function renderLarkQueuedTaskSkipped(locale: Locale): string {
  return locale === "en" ? "Queued task skipped." : "已跳过排队中的任务。";
}

export function renderLarkConversationQueueWait(locale: Locale): string {
  return locale === "en"
    ? "Another task is still running in this conversation. This message is queued; send `/stop` if the previous task is stuck."
    : "同一个会话里还有任务在运行，这条消息已排队；如果前一个任务卡住，请发送 `/stop` 取消。";
}

export function renderLarkTurnPoolWait(locale: Locale): string {
  return locale === "en"
    ? "All AI worker slots are busy. This message is queued and will continue when capacity frees up."
    : "当前 AI worker 名额已满，这条消息已排队；有空位后会继续处理。";
}

export function renderLarkMediaTranscriptionFailure(locale: Locale): string {
  return locale === "en"
    ? "Audio/video transcription failed. Please send text or a shorter audio/video file."
    : "音视频转写失败，请发送文字消息或较短的音视频文件。";
}

export function renderLarkCronRuntimeMissing(locale: Locale): string {
  return locale === "en"
    ? "Lark cron runtime is not started. Restart the Lark service and try again."
    : "Lark cron runtime 尚未启动。请重启 Lark service 后再试。";
}

export function renderLarkApprovalExpired(locale: Locale): string {
  return locale === "en" ? "Approval expired (denied)." : "审批已过期，已拒绝。";
}

export function renderLarkChatAccessDenied(locale: Locale): string {
  return locale === "en" ? "Current chat is not authorized." : "当前聊天未获授权。";
}

export function renderLarkUserAccessDenied(locale: Locale): string {
  return locale === "en" ? "Current user is not authorized." : "当前用户未获授权。";
}

export function renderLarkOperatorAccessDenied(locale: Locale): string {
  return locale === "en" ? "Current operator is not authorized." : "当前操作者未获授权。";
}
