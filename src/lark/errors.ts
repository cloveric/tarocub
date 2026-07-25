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
  if (locale === "en") {
    if (category === "auth") {
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
      return "Error: Codex lost its backend connection (reconnect attempts exhausted). Please retry.";
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
    return "错误：Codex 连接后端失败（重连耗尽），请重试。";
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
