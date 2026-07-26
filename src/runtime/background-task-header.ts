import type { Locale } from "../telegram/message-renderer.js";

/**
 * Header for an out-of-band background-task notification, shared by both
 * channels so the two cannot drift apart on what a status means.
 *
 * The header MUST follow the reported status. A stopped or failed task
 * announced as "完成" contradicts its own body — the engine's text for a stopped
 * task explains that no completion record was found — and because the
 * notification is delivered as a reply to whatever the user last asked, a wrong
 * header reads as a wrong answer to that question.
 */
export function renderBackgroundTaskHeader(locale: Locale, status?: string): string {
  switch (status?.trim().toLowerCase()) {
    case "failed":
    case "error":
      return locale === "en" ? "Background task failed" : "后台任务失败";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "aborted":
      return locale === "en" ? "Background task stopped" : "后台任务已停止";
    default:
      return locale === "en" ? "Background task completed" : "后台任务完成";
  }
}
