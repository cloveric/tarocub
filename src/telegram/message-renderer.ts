import type { FailureCategory } from "../runtime/error-classification.js";

export type Locale = "en" | "zh";

function utf16Length(text: string): number {
  return text.length;
}

function takeSafePrefixByUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) {
    return text;
  }

  let end = maxUnits;
  if (
    end > 0 &&
    end < text.length &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? "") &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")
  ) {
    end -= 1;
  }

  if (end <= 0) {
    return Array.from(text)[0] ?? "";
  }

  return text.slice(0, end);
}

function splitLineSegments(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const segments = text.match(/[^\n]*\n?|$/g)?.filter((value) => value.length > 0) ?? [];
  return segments.length > 0 ? segments : [text];
}

export function chunkTelegramMessage(text: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || !Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }

  if (utf16Length(text) <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  let inFence = false;
  let fenceOpener = "```";

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    chunks.push(current);
    current = "";
  };

  const appendWithinFence = (segment: string) => {
    let remaining = segment;
    while (remaining) {
      const closeFenceSuffix = current ? `${current.endsWith("\n") ? "" : "\n"}\`\`\`` : "```";
      const reopenPrefix = `${fenceOpener}\n`;
      const available = Math.max(1, limit - utf16Length(current) - utf16Length(closeFenceSuffix));
      if (utf16Length(remaining) <= available) {
        current += remaining;
        return;
      }
      const prefix = takeSafePrefixByUnits(remaining, available);
      current += prefix;
      current += closeFenceSuffix;
      pushCurrent();
      current = reopenPrefix;
      remaining = remaining.slice(prefix.length);
    }
  };

  const appendPlain = (segment: string) => {
    let remaining = segment;
    while (remaining) {
      const available = Math.max(1, limit - utf16Length(current));
      if (utf16Length(remaining) <= available) {
        current += remaining;
        return;
      }
      const prefix = takeSafePrefixByUnits(remaining, available);
      current += prefix;
      pushCurrent();
      remaining = remaining.slice(prefix.length);
    }
  };

  for (const segment of splitLineSegments(text)) {
    const lineWithoutNewline = segment.replace(/\r?\n$/, "");
    const isFenceLine = lineWithoutNewline.trimStart().startsWith("```");
    const nextLength = utf16Length(current) + utf16Length(segment);

    if (current && nextLength > limit) {
      if (inFence) {
        current += `${current.endsWith("\n") ? "" : "\n"}\`\`\``;
        pushCurrent();
        current = `${fenceOpener}\n`;
      } else {
        pushCurrent();
      }
    }

    if (inFence) {
      appendWithinFence(segment);
    } else {
      appendPlain(segment);
    }

    if (isFenceLine) {
      if (!inFence) {
        inFence = true;
        fenceOpener = lineWithoutNewline.trim();
      } else {
        inFence = false;
        fenceOpener = "```";
      }
    }
  }

  if (current) {
    if (inFence) {
      current += `${current.endsWith("\n") ? "" : "\n"}\`\`\``;
    }
    pushCurrent();
  }

  return chunks;
}

export function renderWorkingMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "收到，正在启动会话..." : "Received. Starting your session...";
}

export function renderErrorMessage(error: string, locale: Locale = "en"): string {
  return locale === "zh" ? `错误：${error}` : `Error: ${error}`;
}

export function renderSessionResetMessage(repaired = false, locale: Locale = "en"): string {
  if (locale === "zh") {
    return repaired
      ? "会话状态不可读，运维需要先修复实例会话状态才能重置此聊天。"
      : "当前聊天的会话已重置。";
  }
  return repaired
    ? "Session state was unreadable. An operator needs to repair the instance session state before this chat can be reset."
    : "Session reset for this chat.";
}

export function renderSessionStateErrorMessage(repairable: boolean, locale: Locale = "en"): string {
  if (locale === "zh") {
    return repairable
      ? "错误：会话状态当前不可读，运维需要修复会话状态后重试。"
      : "错误：会话状态当前不可用，运维需要恢复读取权限后重试。";
  }
  return repairable
    ? "Error: Session state is unreadable right now. The operator needs to repair session state and retry."
    : "Error: Session state is unavailable right now. The operator needs to restore read access and retry.";
}

export function renderTelegramHelpMessage(locale: Locale = "en"): string {
  if (locale === "zh") {
    return [
      "Telegram 命令：",
      "/status - 显示引擎、会话和文件任务状态",
      "/effort [low|medium|high|xhigh|max|off] - 设置推理强度（xhigh 仅 Opus 4.7）",
      "/model [名称|off] - 切换模型（加 [1m] 后缀启用 1M 上下文，如 opus[1m]）",
      "/btw <问题> - 旁问（不影响当前会话）",
      "/ask <实例> <提示> - 将任务委托给另一个 bot",
      "/fan <提示> - 并行查询多个 bot 并汇总结果",
      "/chain <提示> - 按配置顺序串联多个 bot",
      "/verify <提示> - 执行后自动让验证 bot 检查",
      "直接发送文件进行分析。支持语音消息（本地 ASR 转写）。",
      "压缩包在摘要后会暂停；回复\"继续分析\"或点击 Continue Analysis 按钮继续。裸 /continue 恢复最近一个等待中的压缩包。",
      "/continue - 恢复最近等待的压缩包",
      "/resume - Claude 扫描本地 session；Codex 用 /resume thread <thread-id>",
      "/detach - 优先恢复到 /resume 前的对话；否则断开恢复的 session 或当前 Codex thread",
      "/stop - 立即停止当前任务",
      "/context - 显示 Claude 上下文用量（仅 Claude；用来决定何时 /compact）",
      "/usage - 显示本实例累计 token 和费用",
      "/compact - 压缩当前会话上下文",
      "/ultrareview - 代码审查（仅 Claude Opus 4.7+，常配合 /resume 到本地项目使用）",
      "/reset - 清除当前聊天的会话",
      "/help - 显示此帮助",
    ].join("\n");
  }
  return [
    "Telegram commands:",
    "/status - show engine, session, and file task state",
    "/effort [low|medium|high|xhigh|max|off] - set reasoning effort level (xhigh is Opus 4.7 only)",
    "/model [name|off] - switch model (append [1m] for 1M context, e.g. opus[1m])",
    "/btw <question> - side question without affecting session",
    "/ask <instance> <prompt> - delegate a task to another bot",
    "/fan <prompt> - query multiple bots in parallel and combine results",
    "/chain <prompt> - run a configured sequential bot chain",
    "/verify <prompt> - execute then auto-verify with the verifier bot",
    "Send files directly to analyze them. Voice messages supported (local ASR).",
    "Archives pause after summary; reply \"继续分析\" or press Continue Analysis to continue this archive. Bare /continue resumes the latest waiting archive.",
    "/continue - resume the latest waiting archive",
    "/resume - Claude scan; use /resume thread <thread-id> for Codex",
    "/detach - restore the pre-/resume conversation when available; otherwise detach the resumed session or current Codex thread",
    "/stop - immediately stop the current task",
    "/context - show Claude context fill level (Claude only; helps decide when to /compact)",
    "/usage - show cumulative token & cost usage for this instance",
    "/compact - compress the current session context",
    "/ultrareview - dedicated code review (Claude Opus 4.7+ only; usually paired with /resume into a local project)",
    "/reset - clear the current chat session",
    "/help - show this help",
  ].join("\n");
}

export function renderTelegramStatusMessage(input: {
  engine: "codex" | "claude";
  sessionBound: boolean | null;
  threadId?: string | null;
  blockingTasks: number | null;
  waitingTasks: number | null;
  sessionWarning?: string;
  taskStateWarning?: string;
}, locale: Locale = "en"): string {
  const blockingTasksValue = input.blockingTasks ?? 0;
  const waitingTasksValue = input.waitingTasks ?? 0;
  const blockingTasks = Number.isFinite(blockingTasksValue) ? Math.max(0, Math.trunc(blockingTasksValue)) : 0;
  const waitingTasks = Number.isFinite(waitingTasksValue) ? Math.max(0, Math.trunc(waitingTasksValue)) : 0;

  if (locale === "zh") {
    return [
      `引擎：${input.engine}`,
      input.sessionWarning
        ? `会话绑定：未知（${input.sessionWarning}）`
        : `会话绑定：${input.sessionBound ? "是" : "否"}`,
      ...(input.engine === "codex" && input.threadId ? [`当前 thread：${input.threadId}`] : []),
      input.taskStateWarning
        ? `阻塞文件任务：未知（${input.taskStateWarning}）`
        : `阻塞文件任务：${blockingTasks}`,
      input.taskStateWarning
        ? `等待文件任务：未知（${input.taskStateWarning}）`
        : `等待文件任务：${waitingTasks}`,
    ].join("\n");
  }

  return [
    `Engine: ${input.engine}`,
    input.sessionWarning
      ? `Session bound: unknown (${input.sessionWarning})`
      : `Session bound: ${input.sessionBound ? "yes" : "no"}`,
    ...(input.engine === "codex" && input.threadId ? [`Current thread: ${input.threadId}`] : []),
    input.taskStateWarning
      ? `Blocking file tasks: unknown (${input.taskStateWarning})`
      : `Blocking file tasks: ${blockingTasks}`,
    input.taskStateWarning
      ? `Waiting file tasks: unknown (${input.taskStateWarning})`
      : `Waiting file tasks: ${waitingTasks}`,
  ].join("\n");
}

export function renderUsageMessage(
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCostUsd: number;
    requestCount: number;
    lastUpdatedAt: string;
  },
  locale: Locale = "en",
): string {
  if (usage.requestCount === 0) {
    return locale === "zh"
      ? "暂无用量数据——处理完一轮请求后再查。"
      : "No usage data yet — run a request first.";
  }
  const cost = usage.totalCostUsd.toFixed(4);
  const lastSeen = usage.lastUpdatedAt || "never";
  if (locale === "zh") {
    return [
      `累计用量（本实例）：`,
      `• 请求数：${usage.requestCount.toLocaleString()}`,
      `• 输入 tokens：${usage.totalInputTokens.toLocaleString()}`,
      `• 输出 tokens：${usage.totalOutputTokens.toLocaleString()}`,
      `• 缓存 tokens：${usage.totalCachedTokens.toLocaleString()}`,
      `• 花销：$${cost}`,
      `• 最近更新：${lastSeen}`,
    ].join("\n");
  }
  return [
    `Cumulative usage (this instance):`,
    `• Requests: ${usage.requestCount.toLocaleString()}`,
    `• Input tokens: ${usage.totalInputTokens.toLocaleString()}`,
    `• Output tokens: ${usage.totalOutputTokens.toLocaleString()}`,
    `• Cached tokens: ${usage.totalCachedTokens.toLocaleString()}`,
    `• Cost: $${cost}`,
    `• Last updated: ${lastSeen}`,
  ].join("\n");
}

export function renderCategorizedErrorMessage(category: FailureCategory, detail: string, locale: Locale = "en"): string {
  if (locale === "zh") {
    if (category === "write-permission") {
      return "错误：当前写入策略禁止创建文件，请在允许写入的模式下重试。";
    }
    if (category === "auth") {
      return "错误：引擎认证缺失或过期，请重新登录此实例后重试。";
    }
    if (category === "telegram-conflict") {
      return "错误：另一个 Telegram 轮询进程正在使用此 bot token，请停止重复的服务后重试。";
    }
    if (category === "telegram-delivery") {
      return "错误：Telegram 投递暂时不可用，请稍后重试。";
    }
    if (category === "engine-cli") {
      return "错误：引擎运行时失败，请重启实例后重试。";
    }
    if (category === "file-workflow") {
      return "错误：准备请求时文件处理失败，请尝试更小或不同的文件。";
    }
    if (category === "workflow-state") {
      return "错误：内部工作流状态当前不可用，请稍后重试或让运维检查服务状态。";
    }
    if (category === "session-state") {
      return "错误：会话状态当前不可用，运维需要修复会话状态后重试。";
    }
    if (category === "unknown") {
      return "错误：发生了意外故障，请重置聊天或重试请求。";
    }
    return "错误：发生了意外故障，请重试。";
  }

  if (category === "write-permission") {
    return "Error: File creation is blocked by the current write policy. Retry in a writable mode.";
  }
  if (category === "auth") {
    return "Error: Engine authentication is missing or expired. Re-login for this instance and retry.";
  }
  if (category === "telegram-conflict") {
    return "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.";
  }
  if (category === "telegram-delivery") {
    return "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.";
  }
  if (category === "engine-cli") {
    return "Error: The engine runtime failed. Restart the instance and retry.";
  }
  if (category === "file-workflow") {
    return "Error: File handling failed while preparing your request. Retry with a smaller or different file.";
  }
  if (category === "workflow-state") {
    return "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.";
  }
  if (category === "session-state") {
    return "Error: Session state is unavailable right now. The operator needs to repair session state and retry.";
  }
  if (category === "unknown") {
    return "Error: An unexpected failure occurred. Reset the chat or retry the request.";
  }

  return "Error: An unexpected failure occurred. Please retry.";
}

export function renderAccessCheckMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "正在检查访问权限..." : "Checking access policy...";
}

export function renderAttachmentDownloadMessage(count: number, locale: Locale = "en"): string {
  if (locale === "zh") {
    return `正在下载 ${count} 个附件...`;
  }
  return `Downloading ${count} attachment${count === 1 ? "" : "s"}...`;
}

export function renderExecutionMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "正在处理你的请求..." : "Working on your request...";
}

export function renderUnauthorizedMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "此聊天未被授权使用该实例。" : "This chat is not authorized for this instance.";
}

export function renderPrivateChatRequiredMessage(locale: Locale = "en"): string {
  return locale === "zh" ? "此 bot 只接受私聊。" : "This bot only accepts private chats.";
}

export function renderPairingMessage(code: string, locale: Locale = "en"): string {
  return locale === "zh" ? `使用配对码 ${code} 配对此私聊` : `Pair this private chat with code ${code}`;
}
