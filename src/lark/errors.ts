import { classifyFailure } from "../runtime/error-classification.js";
import type { Locale } from "../telegram/message-renderer.js";

export function renderLarkUserFacingError(
  error: unknown,
  phase: "prepare" | "engine" | "tool",
  locale: Locale = "zh",
): string {
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

  switch (phase) {
    case "prepare":
      return "错误：准备飞书消息时失败，请稍后重试。";
    case "tool":
      return "错误：飞书工具执行失败，详细原因已记录到日志。";
    case "engine":
      return "错误：本轮运行失败，详细原因已记录到日志。";
  }
}
