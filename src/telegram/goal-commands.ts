import type { CodexThreadGoal } from "../codex/adapter.js";
import type { TelegramApi } from "./api.js";
import type { ResumeState } from "./instance-config.js";
import type { Locale } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type GoalAction =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; objective: string; tokenBudget: number | null }
  | { kind: "invalid"; reason: "invalid_budget" | "missing_objective" };

function parseTokenBudget(value: string): number | null {
  const normalized = value.trim().replace(/[,_]/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const budget = amount * scale;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    return null;
  }
  return budget;
}

function parseSetGoal(rest: string): Extract<GoalAction, { kind: "set" | "invalid" }> {
  const budgetMatch = rest.match(/^(?:--budget|-b)(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--budget|-b)(?:$|=|\s+)/i.test(rest)) {
    const tokenBudget = budgetMatch ? parseTokenBudget(budgetMatch[1] ?? "") : null;
    if (!budgetMatch || tokenBudget === null) {
      return { kind: "invalid", reason: "invalid_budget" };
    }
    const objective = budgetMatch[2]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget };
  }

  return { kind: "set", objective: rest, tokenBudget: null };
}

function parseGoalCommand(text: string): GoalAction | null {
  const match = text.trim().match(/^\/goal(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  const rest = match[1]?.trim() ?? "";
  if (!rest || /^status$/i.test(rest)) {
    return { kind: "status" };
  }
  if (/^(clear|off|reset)$/i.test(rest)) {
    return { kind: "clear" };
  }
  return parseSetGoal(rest);
}

function toNativeGoalCommandText(text: string): string | null {
  const match = text.trim().match(/^\/goal(?:@\w+)?(\s+[\s\S]+)?$/i);
  if (!match) {
    return null;
  }
  return `/goal${match[1] ?? ""}`;
}

function renderInvalidGoalCommand(reason: "invalid_budget" | "missing_objective", locale: Locale): string {
  if (reason === "missing_objective") {
    return locale === "zh"
      ? "请在 token 预算后写目标，例如：/goal --budget 50000 写发布说明。"
      : "Add a goal after the token budget, for example: /goal --budget 50000 write release notes.";
  }
  return locale === "zh"
    ? "无效的 /goal token 预算。用法：--budget 50000 或 -b 50k。"
    : "Invalid /goal token budget. Use --budget 50000 or -b 50k.";
}

function renderGoal(goal: CodexThreadGoal, locale: Locale): string {
  const budget = goal.tokenBudget === null
    ? locale === "zh" ? "无 token 预算" : "no token budget"
    : locale === "zh" ? `${goal.tokenBudget} token 预算` : `${goal.tokenBudget} token budget`;
  const usage = locale === "zh"
    ? `已用 ${goal.tokensUsed} tokens，${Math.round(goal.timeUsedSeconds)} 秒`
    : `${goal.tokensUsed} tokens used, ${Math.round(goal.timeUsedSeconds)} seconds`;
  return locale === "zh"
    ? `目标：${goal.objective}\n状态：${goal.status}\n${budget}\n${usage}`
    : `Goal: ${goal.objective}\nStatus: ${goal.status}\n${budget}\n${usage}`;
}

export async function handleGoalTelegramCommand(input: {
  locale: Locale;
  cfg: {
    engine: "codex" | "claude";
    resume?: ResumeState;
  };
  normalized: NormalizedTelegramMessage;
  context: {
    api: Pick<TelegramApi, "sendMessage">;
    bridge: {
      getThreadGoal?(goalInput: {
        chatId: number;
        userId: number;
        chatType: string;
        messageThreadId?: number;
        conversationKey?: string;
        workspaceOverride?: string;
      }): Promise<{ goal: CodexThreadGoal | null }>;
      setThreadGoal?(goalInput: {
        chatId: number;
        userId: number;
        chatType: string;
        messageThreadId?: number;
        conversationKey?: string;
        objective: string;
        tokenBudget?: number | null;
        workspaceOverride?: string;
      }): Promise<{ goal: CodexThreadGoal | null }>;
      clearThreadGoal?(goalInput: {
        chatId: number;
        userId: number;
        chatType: string;
        messageThreadId?: number;
        conversationKey?: string;
        workspaceOverride?: string;
      }): Promise<{ cleared: boolean }>;
    };
  };
}): Promise<boolean> {
  const action = parseGoalCommand(input.normalized.text);
  if (!action) {
    return false;
  }

  const { locale, normalized } = input;
  if (input.cfg.engine !== "codex") {
    // Claude Code implements /goal as a native slash command in both -p and
    // stream-json modes. Let it pass through the ordinary engine path instead
    // of trying to emulate Codex's structured goal API here. Strip Telegram's
    // optional /goal@bot suffix because Claude only sees native slash commands.
    const nativeGoalText = toNativeGoalCommandText(input.normalized.text);
    if (nativeGoalText) {
      input.normalized.text = nativeGoalText;
    }
    return false;
  }

  if (action.kind === "invalid") {
    await input.context.api.sendMessage(normalized.chatId, renderInvalidGoalCommand(action.reason, locale));
    return true;
  }

  const baseGoalInput = {
    chatId: normalized.chatId,
    userId: normalized.userId,
    chatType: normalized.chatType,
    messageThreadId: normalized.messageThreadId,
    conversationKey: normalized.conversationKey,
    workspaceOverride: input.cfg.resume?.workspacePath,
  };

  if (action.kind === "status") {
    if (!input.context.bridge.getThreadGoal) {
      await input.context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? "当前 runtime 不支持结构化 /goal status。" : "This runtime does not support structured /goal status.",
      );
      return true;
    }
    const { goal } = await input.context.bridge.getThreadGoal(baseGoalInput);
    await input.context.api.sendMessage(
      normalized.chatId,
      goal
        ? renderGoal(goal, locale)
        : locale === "zh" ? "当前聊天没有活跃 goal。" : "No active goal for this chat.",
    );
    return true;
  }

  if (action.kind === "clear") {
    if (!input.context.bridge.clearThreadGoal) {
      await input.context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? "当前 runtime 不支持结构化 /goal clear。" : "This runtime does not support structured /goal clear.",
      );
      return true;
    }
    const { cleared } = await input.context.bridge.clearThreadGoal(baseGoalInput);
    await input.context.api.sendMessage(
      normalized.chatId,
      cleared
        ? locale === "zh" ? "已清除当前 goal。" : "Goal cleared."
        : locale === "zh" ? "当前聊天没有可清除的 goal。" : "No goal to clear for this chat.",
    );
    return true;
  }

  if (!input.context.bridge.setThreadGoal) {
    await input.context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "当前 runtime 不支持结构化 /goal。" : "This runtime does not support structured /goal.",
    );
    return true;
  }
  const { goal } = await input.context.bridge.setThreadGoal({
    ...baseGoalInput,
    objective: action.objective,
    tokenBudget: action.tokenBudget,
  });
  await input.context.api.sendMessage(
    normalized.chatId,
    goal
      ? locale === "zh"
        ? `Goal 已设置。\n\n${renderGoal(goal, locale)}`
        : `Goal set.\n\n${renderGoal(goal, locale)}`
      : locale === "zh" ? "Goal 已设置。" : "Goal set.",
  );
  return true;
}
