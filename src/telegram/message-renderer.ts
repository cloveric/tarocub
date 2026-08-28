import type { FailureCategory } from "../runtime/error-classification.js";

export type Locale = "en" | "zh";
export type EngineName = "codex" | "claude" | "antigravity" | "kimi" | "deepseek";

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
  let fenceDelimiter = "```";

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    chunks.push(current);
    current = "";
  };

  const closeFenceSuffix = () => `${current.endsWith("\n") ? "" : "\n"}${fenceDelimiter}`;
  const reopenFence = () => {
    current = `${fenceOpener}\n`;
    // A reopened chunk must fit its worst-case closer and at least one content
    // unit. Otherwise appendWithinFence would close/reopen forever without
    // consuming any input.
    if (utf16Length(current) + utf16Length(fenceDelimiter) + 1 >= limit) {
      throw new RangeError("limit is too small to safely encode a fenced code block");
    }
  };

  const closeAndReopenFence = () => {
    const suffix = closeFenceSuffix();
    if (utf16Length(current) + utf16Length(suffix) > limit) {
      throw new RangeError("limit is too small to safely encode a fenced code block");
    }
    current += suffix;
    pushCurrent();
    reopenFence();
  };

  const appendWithinFence = (segment: string, closesFence: boolean) => {
    let remaining = segment;
    while (remaining) {
      const rawAvailable = limit - utf16Length(current);
      if (closesFence && utf16Length(remaining) <= rawAvailable) {
        current += remaining;
        return;
      }

      // Reserve the worst-case closer (newline + delimiter). The prefix we add
      // can change a previously newline-terminated chunk into a non-terminated
      // one, so calculating from the pre-append suffix can be one unit short.
      const available = limit - utf16Length(current) - utf16Length(fenceDelimiter) - 1;
      if (available <= 0) {
        closeAndReopenFence();
        continue;
      }
      // Same line-boundary preference inside a fence: if this code line cannot
      // finish in the current chunk but fits a fresh one, close/reopen now
      // instead of splitting the line across two cards.
      const freshAvailable = limit - utf16Length(`${fenceOpener}\n`) - utf16Length(fenceDelimiter) - 1;
      if (utf16Length(remaining) > available && utf16Length(remaining) <= freshAvailable) {
        closeAndReopenFence();
        continue;
      }
      if (utf16Length(remaining) <= available) {
        current += remaining;
        return;
      }
      const prefix = takeSafePrefixByUnits(remaining, available);
      if (utf16Length(prefix) > available) {
        throw new RangeError("limit is too small to safely encode this message chunk");
      }
      current += prefix;
      remaining = remaining.slice(prefix.length);
      closeAndReopenFence();
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
      // Prefer breaking at the line boundary we are already on: push the
      // partially-filled chunk and let this line start the next one. Splitting
      // mid-line/mid-word is reserved for a single line that alone exceeds the
      // limit (v0.1.203's fence-safe rewrite dropped this preference and long
      // prose started splitting inside words on both channels).
      if (current) {
        pushCurrent();
        continue;
      }
      const prefix = takeSafePrefixByUnits(remaining, available);
      if (utf16Length(prefix) > available) {
        throw new RangeError("limit is too small to safely encode this message chunk");
      }
      current += prefix;
      pushCurrent();
      remaining = remaining.slice(prefix.length);
    }
  };

  for (const segment of splitLineSegments(text)) {
    const lineWithoutNewline = segment.replace(/\r?\n$/, "");
    const trimmedLine = lineWithoutNewline.trimStart();
    const openingFence = !inFence ? trimmedLine.match(/^(`{3,}|~{3,})/)?.[1] : undefined;
    const closingFence = inFence ? trimmedLine.match(/^(`{3,}|~{3,})\s*$/)?.[1] : undefined;
    const closesFence = closingFence !== undefined &&
      closingFence[0] === fenceDelimiter[0] &&
      closingFence.length >= fenceDelimiter.length;

    if (openingFence !== undefined) {
      const delimiter = openingFence;
      const suffix = `${segment.endsWith("\n") ? "" : "\n"}${delimiter}`;
      if (current && utf16Length(current) + utf16Length(segment) + utf16Length(suffix) > limit) {
        pushCurrent();
      }
      if (utf16Length(segment) + utf16Length(suffix) > limit) {
        throw new RangeError("limit is too small to safely encode a fenced code block");
      }
      current += segment;
      inFence = true;
      fenceOpener = trimmedLine;
      fenceDelimiter = delimiter;
      continue;
    }

    if (inFence) {
      appendWithinFence(segment, closesFence);
    } else {
      appendPlain(segment);
    }

    if (closesFence) {
      inFence = false;
      fenceOpener = "```";
      fenceDelimiter = "```";
    }
  }

  if (current) {
    if (inFence) {
      const suffix = closeFenceSuffix();
      if (utf16Length(current) + utf16Length(suffix) > limit) {
        throw new RangeError("limit is too small to safely encode a fenced code block");
      }
      current += suffix;
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
      "/engine [claude|codex|kimi|deepseek|antigravity] - 切换引擎（切换后需重启实例）",
      "/effort [low|medium|high|xhigh|max|ultra|off] - 设置推理强度（Codex 5.6：Sol/Terra 支持 ultra，Luna 最高 max）",
      "/fast [on|off|status] - 开关 Codex Fast Mode（更快但消耗更多 credits）",
      "/goal <目标> - 设置默认无上限 goal；用 --budget 50k 加 token 预算，另支持 status/clear",
      "/model [名称|off] - 切换模型（加 [1m] 后缀启用 1M 上下文，如 opus[1m]）",
      "/group [status|allow|deny|on|off|all|at] - 管理群聊访问和监听模式；/group allow 启用当前群，/group all 监听普通消息，/group at 只响应 @/回复",
      "/btw <问题> - 旁问（不影响当前会话）",
      "/ask <实例> <提示> - 将任务委托给另一个 bot",
      "/board [list|add|desc|accept|priority|labels|check|assign|dep|limits|review|approve|reject|ready|run|start|fail|runs|block|unblock|done] - 管理持久化 Kanban 任务板",
      "/mini [status|here|order|parallel|verifier|role|crew|ask|fan|chain|verify] - 把当前群内不同 topic 组成 Mini Bus",
      "/fan <提示> - 并行查询多个 bot 并汇总结果",
      "/chain <提示> - 按配置顺序串联多个 bot",
      "/verify <提示> - 执行后自动让验证 bot 检查",
      "直接发送文件进行分析。支持语音/音视频：短音频走本地 Qwen ASR，长音频在已配置时走通义听悟。",
      "压缩包在摘要后会暂停；回复\"继续分析\"或点击 Continue Analysis 按钮继续。裸 /continue 恢复最近一个等待中的压缩包。",
      "/continue - 恢复最近等待的压缩包",
      "/resume - Claude/Kimi/DeepSeek Harness/Antigravity 扫描并按编号选择；Codex 用 /resume thread <id>；Kimi/DeepSeek 也可用 /resume session <id>",
      "/detach - 优先恢复到 /resume 前的对话；否则断开当前外部 session/thread/conversation",
      "/stop - 立即停止当前任务",
      "/context - 显示 Claude 或 DeepSeek Harness 上下文用量（用来决定何时 /compact）",
      "/usage - 显示本实例累计 token 和费用",
      "/compact - 压缩 Claude/Kimi/DeepSeek Harness 会话上下文（其他引擎请用 /reset）",
      "/ultrareview - 代码审查（仅 Claude Opus 4.7+，常配合 /resume 到本地项目使用）",
      "/reset - 清除当前聊天的会话",
      "/help - 显示此帮助",
    ].join("\n");
  }
  return [
    "Telegram commands:",
    "/status - show engine, session, and file task state",
    "/engine [claude|codex|kimi|deepseek|antigravity] - switch engine (restart required after changing)",
    "/effort [low|medium|high|xhigh|max|ultra|off] - set reasoning effort (Codex 5.6: Sol/Terra support ultra; Luna tops out at max)",
    "/fast [on|off|status] - toggle Codex Fast Mode (faster, higher credit use)",
    "/goal <goal> - set a goal; default is unbounded unless --budget is provided, plus status/clear",
    "/model [name|off] - switch model (append [1m] for 1M context, e.g. opus[1m])",
    "/group [status|allow|deny|on|off|all|at] - manage group access and listen mode; /group allow enables the current group, /group all listens to ordinary messages, /group at requires mentions/replies",
    "/btw <question> - side question without affecting session",
    "/ask <instance> <prompt> - delegate a task to another bot",
    "/board [list|add|desc|accept|priority|labels|check|assign|dep|limits|review|approve|reject|ready|run|start|fail|runs|block|unblock|done] - manage the durable Kanban task board",
    "/mini [status|here|order|parallel|verifier|role|crew|ask|fan|chain|verify] - compose group topics into a Mini Bus",
    "/fan <prompt> - query multiple bots in parallel and combine results",
    "/chain <prompt> - run a configured sequential bot chain",
    "/verify <prompt> - execute then auto-verify with the verifier bot",
    "Send files directly to analyze them. Voice/audio/video is supported: short media uses local Qwen ASR; long media uses Aliyun Tingwu when configured.",
    "Archives pause after summary; reply \"继续分析\" or press Continue Analysis to continue this archive. Bare /continue resumes the latest waiting archive.",
    "/continue - resume the latest waiting archive",
    "/resume - scan/pick Claude, Kimi, DeepSeek Harness, or Antigravity sessions; Codex uses /resume thread <id>; Kimi/DeepSeek also accept /resume session <id>",
    "/detach - restore the pre-/resume conversation when available; otherwise detach the current external session/thread/conversation",
    "/stop - immediately stop the current task",
    "/context - show Claude or DeepSeek Harness context fill level (helps decide when to /compact)",
    "/usage - show cumulative token & cost usage for this instance",
    "/compact - compact Claude/Kimi/DeepSeek Harness session context (use /reset for other engines)",
    "/ultrareview - dedicated code review (Claude Opus 4.7+ only; usually paired with /resume into a local project)",
    "/reset - clear the current chat session",
    "/help - show this help",
  ].join("\n");
}

export function renderTelegramStatusMessage(input: {
  engine: EngineName;
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
      ...(input.engine === "antigravity" && input.threadId ? [`当前 conversation：${input.threadId}`] : []),
      ...(input.engine === "kimi" && input.threadId ? [`当前 Kimi session：${input.threadId}`] : []),
      ...(input.engine === "deepseek" && input.threadId ? [`当前 DeepSeek Harness session：${input.threadId}`] : []),
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
    ...(input.engine === "antigravity" && input.threadId ? [`Current conversation: ${input.threadId}`] : []),
    ...(input.engine === "kimi" && input.threadId ? [`Current Kimi session: ${input.threadId}`] : []),
    ...(input.engine === "deepseek" && input.threadId ? [`Current DeepSeek Harness session: ${input.threadId}`] : []),
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
    unmeteredRequestCount?: number;
    lastUpdatedAt: string;
  },
  locale: Locale = "en",
): string {
  const unmeteredRequestCount = usage.unmeteredRequestCount ?? 0;
  if (usage.requestCount === 0 && unmeteredRequestCount === 0) {
    return locale === "zh"
      ? "暂无用量数据——处理完一轮请求后再查。"
      : "No usage data yet — run a request first.";
  }
  if (usage.requestCount === 0 && unmeteredRequestCount > 0) {
    const lastSeen = usage.lastUpdatedAt || "never";
    return locale === "zh"
      ? [
        `累计用量（本实例）：`,
        `• 可计量请求数：0`,
        `• 未返回 token 明细的请求：${unmeteredRequestCount.toLocaleString()}`,
        `• 说明：当前引擎完成了请求，但没有返回 token 明细；不会假算为 0。`,
        `• 最近更新：${lastSeen}`,
      ].join("\n")
      : [
        `Cumulative usage (this instance):`,
        `• Metered requests: 0`,
        `• Requests without token details: ${unmeteredRequestCount.toLocaleString()}`,
        `• Note: the current engine completed requests without returning token details; these are not counted as zero-token turns.`,
        `• Last updated: ${lastSeen}`,
      ].join("\n");
  }
  const cost = usage.totalCostUsd.toFixed(4);
  const lastSeen = usage.lastUpdatedAt || "never";
  if (locale === "zh") {
    return [
      `累计用量（本实例）：`,
      `• 请求数：${usage.requestCount.toLocaleString()}`,
      ...(unmeteredRequestCount > 0 ? [`• 未返回 token 明细的请求：${unmeteredRequestCount.toLocaleString()}`] : []),
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
    ...(unmeteredRequestCount > 0 ? [`• Requests without token details: ${unmeteredRequestCount.toLocaleString()}`] : []),
    `• Input tokens: ${usage.totalInputTokens.toLocaleString()}`,
    `• Output tokens: ${usage.totalOutputTokens.toLocaleString()}`,
    `• Cached tokens: ${usage.totalCachedTokens.toLocaleString()}`,
    `• Cost: $${cost}`,
    `• Last updated: ${lastSeen}`,
  ].join("\n");
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "");
}

function extractDiagnosticHttpTarget(detail: string): string | undefined {
  const match = detail.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = new URL(stripTrailingUrlPunctuation(match[0]));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return `${parsed.hostname}${parsed.pathname}`.slice(0, 160);
  } catch {
    return undefined;
  }
}

function renderEngineName(engine: EngineName | undefined): "Codex" | "Claude" | "Kimi" | "DeepSeek" | "Antigravity" | undefined {
  if (engine === "codex") {
    return "Codex";
  }
  if (engine === "claude") {
    return "Claude";
  }
  if (engine === "kimi") {
    return "Kimi";
  }
  if (engine === "deepseek") {
    return "DeepSeek";
  }
  if (engine === "antigravity") {
    return "Antigravity";
  }
  return undefined;
}

function inferEngineName(detail: string, target: string | undefined, engine?: EngineName): "Codex" | "Claude" | "Kimi" | "DeepSeek" | "Antigravity" | "Engine" {
  const explicitEngineName = renderEngineName(engine);
  if (explicitEngineName) {
    return explicitEngineName;
  }

  const normalized = `${detail}\n${target ?? ""}`.toLowerCase();
  if (normalized.includes("codex")) {
    return "Codex";
  }
  if (normalized.includes("claude")) {
    return "Claude";
  }
  if (normalized.includes("kimi")) {
    return "Kimi";
  }
  if (normalized.includes("deepseek") || normalized.includes("dsh")) {
    return "DeepSeek";
  }
  if (normalized.includes("antigravity") || normalized.includes("agy")) {
    return "Antigravity";
  }
  return "Engine";
}

function renderEngineDiagnosticDetail(detail: string, locale: Locale, engine?: EngineName): string | undefined {
  const normalized = detail.toLowerCase();
  const target = extractDiagnosticHttpTarget(detail);
  const engineName = inferEngineName(detail, target, engine);
  const isTransportFailure =
    normalized.includes("stream disconnected") ||
    normalized.includes("error sending request") ||
    normalized.includes("fetch failed");

  if (!isTransportFailure) {
    return undefined;
  }

  const targetPhrase =
    target === undefined
      ? ""
      : locale === "zh"
        ? `在调用 ${target} 时`
        : ` while calling ${target}`;

  return locale === "zh"
    ? `详情：${engineName} 传输流${targetPhrase}断开。上一轮还没有生成最终回答就失败了；这本身不能说明是浏览器或生图任务失败。`
    : `Details: ${engineName} transport stream disconnected${targetPhrase}. The previous turn failed before producing a final answer; this does not identify a browser or image-generation task by itself.`;
}

export function renderCategorizedErrorMessage(
  category: FailureCategory,
  detail: string,
  locale: Locale = "en",
  engine?: EngineName,
): string {
  const normalizedDetail = detail.toLowerCase();
  const isAntigravity = engine === "antigravity";
  const isUnsupportedAntigravityFlag =
    isAntigravity &&
    category === "engine-cli" &&
    (
      normalizedDetail.includes("flags provided but not defined") ||
      normalizedDetail.includes("unknown flag") ||
      normalizedDetail.includes("unknown shorthand flag") ||
      normalizedDetail.includes("flag provided but not defined")
    );
  const isTelegramFormattingError =
    category === "telegram-delivery" &&
    (
      normalizedDetail.includes("can't parse entities") ||
      normalizedDetail.includes("cannot parse entities") ||
      normalizedDetail.includes("parse entities")
    );
  const isTelegramAttachmentTooLargeError =
    category === "file-workflow" &&
    (
      normalizedDetail.includes("telegram attachment is too large to download via bot api") ||
      normalizedDetail.includes("getfile: bad request: file is too big")
    );
  const timeoutMinutes = detail.match(/(?:timed out|became inactive) after\s+(\d+)\s*minute/i)?.[1];

  if (locale === "zh") {
    if (category === "write-permission") {
      return "错误：当前写入策略禁止创建文件，请在允许写入的模式下重试。";
    }
    if (category === "auth") {
      if (isAntigravity) {
        return "错误：Antigravity 认证缺失或过期。请先在本机打开 Antigravity CLI 重新登录，然后重试这轮 Telegram 请求。";
      }
      return "错误：引擎认证缺失或过期，请重新登录此实例后重试。";
    }
    if (category === "telegram-conflict") {
      return "错误：另一个 Telegram 轮询进程正在使用此 bot token，请停止重复的服务后重试。";
    }
    if (category === "telegram-delivery") {
      return isTelegramFormattingError
        ? "错误：回复内容的格式被 Telegram 拒绝了。我已记录具体原因，请稍后重试或让运维检查日志。"
        : "错误：Telegram 投递暂时不可用，请稍后重试。";
    }
    if (category === "engine-backend") {
      return "错误：引擎服务暂时过载或连接中断，请稍后再试；无需重启实例。";
    }
    if (category === "engine-timeout") {
      const duration = timeoutMinutes ? `${timeoutMinutes} 分钟` : "配置的时限";
      return `错误：任务达到${duration}上限或长时间无响应，已自动停止。直接原样重试通常还会超时；请拆分任务，或先用 \`/timeout\` 调整时限。`;
    }
    if (category === "engine-cli") {
      if (isUnsupportedAntigravityFlag) {
        return "错误：Antigravity 拒绝了 CLI 启动参数。请更新 agy 或移除不支持的 bridge 设置后重试。";
      }
      return [
        "错误：引擎运行时失败，请重启实例后重试。",
        renderEngineDiagnosticDetail(detail, locale, engine),
      ].filter(Boolean).join("\n");
    }
    if (category === "file-workflow") {
      if (isTelegramAttachmentTooLargeError) {
        return "错误：这个附件太大，当前 Telegram Bot API 不能下载到 bot 端。请压缩到 20MB 以内，或发可访问链接/把文件放到 bot workspace 后再让我读取。";
      }
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
    if (isAntigravity) {
      return "Error: Antigravity authentication is missing or expired. Open Antigravity CLI locally, sign in again, then retry this Telegram turn.";
    }
    return "Error: Engine authentication is missing or expired. Re-login for this instance and retry.";
  }
  if (category === "telegram-conflict") {
    return "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.";
  }
  if (category === "telegram-delivery") {
    return isTelegramFormattingError
      ? "Error: Telegram rejected the reply formatting. The detailed parse error has been logged; retry the request or inspect the logs."
      : "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.";
  }
  if (category === "engine-backend") {
    return "Error: The engine backend is temporarily overloaded or disconnected. Retry later; restarting the instance is not required.";
  }
  if (category === "engine-timeout") {
    const duration = timeoutMinutes ? `${timeoutMinutes}-minute` : "configured";
    return `Error: The task hit the ${duration} runtime/inactivity limit and was stopped. Retrying unchanged will likely time out again; split the task or adjust \`/timeout\` first.`;
  }
  if (category === "engine-cli") {
    if (isUnsupportedAntigravityFlag) {
      return "Error: Antigravity rejected a CLI startup flag. Update agy or remove the unsupported bridge setting, then retry.";
    }
    return [
      "Error: The engine runtime failed. Restart the instance and retry.",
      renderEngineDiagnosticDetail(detail, locale, engine),
    ].filter(Boolean).join("\n");
  }
  if (category === "file-workflow") {
    if (isTelegramAttachmentTooLargeError) {
      return "Error: This attachment is too large for the current Telegram Bot API download path. Send a file under 20 MB, share a reachable link, or place the file in the bot workspace.";
    }
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

export function renderSingleChatLockedMessage(locale: Locale = "en"): string {
  return locale === "zh"
    ? "此实例已锁定到另一个聊天。若要允许多个聊天，请先显式开启 multi-chat。"
    : "This instance is locked to another chat. Enable multi-chat before pairing or allowing a different chat.";
}

export function renderPairingMessage(code: string, locale: Locale = "en"): string {
  return locale === "zh" ? `使用配对码 ${code} 配对此私聊` : `Pair this private chat with code ${code}`;
}
