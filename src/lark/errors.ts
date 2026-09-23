import { classifyFailure } from "../runtime/error-classification.js";
import { formatLarkFileSize, isLarkAttachmentTooLargeError } from "./files.js";
import type { Locale } from "../telegram/message-renderer.js";

const ATTACHMENT_KIND_LABELS_ZH: Record<string, string> = {
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
};

/**
 * An oversize inbound attachment gets its own message: the generic file-workflow
 * text ("换一个文件") does not tell the user what actually happened, and the
 * generic prepare text ("准备飞书消息时失败") is actively misleading.
 */
function renderLarkAttachmentTooLarge(error: unknown, locale: Locale): string | undefined {
  if (!isLarkAttachmentTooLargeError(error)) {
    return undefined;
  }
  const size = formatLarkFileSize(error.attachmentBytes);
  const limit = formatLarkFileSize(error.limitBytes);
  if (locale === "en") {
    const kind = error.attachmentKind;
    return `This ${kind} is ${size}, over the ${limit} a Feishu bot can download. Please compress or split it and send again.`;
  }
  const kind = ATTACHMENT_KIND_LABELS_ZH[error.attachmentKind] ?? "文件";
  return `这个${kind} ${size}，超过飞书机器人可下载的上限（${limit}），请压缩或切分后再发。`;
}

export function renderLarkUserFacingError(
  error: unknown,
  phase: "prepare" | "engine" | "tool",
  locale: Locale = "zh",
): string {
  const tooLarge = renderLarkAttachmentTooLarge(error, locale);
  if (tooLarge) {
    return tooLarge;
  }
  const category = classifyFailure(error);
  const errorText = error instanceof Error ? `${error.name}\n${error.message}` : String(error);
  const isAntigravityAuth = category === "auth" && /(?:antigravity|\bagy\b)/i.test(errorText);
  const isKimiQuota = category === "engine-quota" && /(?:kimi|5-hour usage limit)/i.test(errorText);
  const isModelCapacity =
    category === "engine-backend" &&
    /(?:selected model is at capacity|no capacity available for model)/i.test(errorText);
  if (category === "engine-thread-locked") {
    // The adapter already produced an operator-actionable explanation (who
    // holds the lock, what to do). Surfacing it verbatim is the whole point —
    // a generic "run failed" is exactly what sent the operator hunting.
    const detail = error instanceof Error ? error.message.split("\n\n").slice(1).join("\n\n").trim() : "";
    const header = locale === "en"
      ? "Error: this conversation's Codex thread is locked by another writer."
      : "错误：该会话的 Codex 线程被其他写入方占用。";
    return detail ? `${header}\n${detail}` : header;
  }
  if (locale === "en") {
    if (category === "auth") {
      if (isAntigravityAuth) {
        return "Error: Antigravity authentication could not be refreshed. Run `agy` locally to sign in, then retry.";
      }
      return "Error: engine or Lark authentication has expired. Please sign in again and retry.";
    }
    if (category === "write-permission") {
      return "Error: the current runtime cannot write to disk. Please adjust permissions and retry.";
    }
    if (category === "file-workflow") {
      return "Error: file processing failed. Try a smaller or different file.";
    }
    if (category === "session-state") {
      return "Error: session state is unavailable. Reset the session or ask an operator to check state files.";
    }
    if (category === "workflow-state") {
      return "Error: workflow state is unavailable. Retry later or ask an operator to check the service.";
    }
    if (category === "engine-cli") {
      return "Error: engine runtime failed. Restart the instance and retry.";
    }
    if (category === "engine-backend") {
      return isModelCapacity
        ? "Error: the selected model is temporarily at capacity. Retry shortly or switch models; restarting the instance is not required."
        : "Error: the model backend is temporarily overloaded or disconnected. Please retry; restarting the instance is not required.";
    }
    if (category === "engine-quota") {
      return isKimiQuota
        ? "Error: Kimi's current 5-hour usage quota is exhausted. Wait for the usage window to reset, or purchase extra usage/upgrade; signing in again or restarting will not help."
        : "Error: the engine usage quota is exhausted. Wait for the quota window to reset or increase the account quota; signing in again or restarting will not help.";
    }
    if (category === "engine-timeout") {
      return "⏱️ This turn hit the single-turn time cap (60 min) and was stopped — not a crash, so restarting won't help. For a genuinely long task, send `/timeout off` to lift the cap and rerun, or split it into smaller steps.";
    }

    switch (phase) {
      case "prepare":
        return "Error: failed to prepare the Lark message. Please retry later.";
      case "tool":
        return "Error: Lark tool execution failed. Details were recorded in logs.";
      case "engine":
        return "Error: this turn failed. Details were recorded in logs.";
    }
  }

  if (category === "auth") {
    if (isAntigravityAuth) {
      return "错误：Antigravity 认证刷新失败。请先在本机运行 `agy` 完成登录，再重试。";
    }
    return "错误：引擎或飞书认证已失效，请重新登录后重试。";
  }
  if (category === "write-permission") {
    return "错误：当前运行环境没有写入权限，请调整权限后重试。";
  }
  if (category === "file-workflow") {
    return "错误：文件处理失败，请换一个文件或缩小文件后重试。";
  }
  if (category === "session-state") {
    return "错误：会话状态不可用，请重置会话或让运维检查状态文件。";
  }
  if (category === "workflow-state") {
    return "错误：工作流状态不可用，请稍后重试或让运维检查服务状态。";
  }
  if (category === "engine-cli") {
    return "错误：引擎运行失败，请重启实例后重试。";
  }
  if (category === "engine-backend") {
    return isModelCapacity
      ? "错误：所选模型当前容量已满。请稍后重试，或临时切换模型；无需重启实例。"
      : "错误：模型后端暂时过载或连接中断，请重试；无需重启实例。";
  }
  if (category === "engine-quota") {
    return isKimiQuota
      ? "错误：Kimi 当前 5 小时使用额度已用完。请等待额度窗口重置，或购买额外额度/升级套餐；重新登录或重启都无效。"
      : "错误：引擎使用额度已用完。请等待额度窗口重置或提高账户额度；重新登录或重启都无效。";
  }
  if (category === "engine-timeout") {
    return "⏱️ 本轮撞了单轮 60 分钟时间上限被自动终止——不是崩溃，重启没用。任务确实很长的话，发 `/timeout off` 放开上限后重跑，或把任务拆小。";
  }

  switch (phase) {
    case "prepare":
      return "错误：准备飞书消息时失败，请稍后重试。";
    case "tool":
      return "错误：飞书工具执行失败，详细原因已记录到日志。";
    case "engine":
      return "错误：本轮运行失败，详细原因已记录到日志。";
  }
}
