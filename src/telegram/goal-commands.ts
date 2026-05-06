import type { CodexThreadGoal } from "../codex/adapter.js";
import type { TelegramApi } from "./api.js";
import type { ResumeState } from "./instance-config.js";
import type { Locale } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type GoalAction =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; objective: string };

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
  return { kind: "set", objective: rest };
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
    await input.context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "只有 Codex 引擎支持 /goal。" : "Only the Codex engine supports /goal.",
    );
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
        locale === "zh" ? "当前 Codex runtime 不支持 /goal status。" : "This Codex runtime does not support /goal status.",
      );
      return true;
    }
    const { goal } = await input.context.bridge.getThreadGoal(baseGoalInput);
    await input.context.api.sendMessage(
      normalized.chatId,
      goal
        ? renderGoal(goal, locale)
        : locale === "zh" ? "当前聊天没有活跃 Codex goal。" : "No active Codex goal for this chat.",
    );
    return true;
  }

  if (action.kind === "clear") {
    if (!input.context.bridge.clearThreadGoal) {
      await input.context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? "当前 Codex runtime 不支持 /goal clear。" : "This Codex runtime does not support /goal clear.",
      );
      return true;
    }
    const { cleared } = await input.context.bridge.clearThreadGoal(baseGoalInput);
    await input.context.api.sendMessage(
      normalized.chatId,
      cleared
        ? locale === "zh" ? "已清除当前 Codex goal。" : "Codex goal cleared."
        : locale === "zh" ? "当前聊天没有可清除的 Codex goal。" : "No Codex goal to clear for this chat.",
    );
    return true;
  }

  if (!input.context.bridge.setThreadGoal) {
    await input.context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "当前 Codex runtime 不支持 /goal。" : "This Codex runtime does not support /goal.",
    );
    return true;
  }
  const { goal } = await input.context.bridge.setThreadGoal({
    ...baseGoalInput,
    objective: action.objective,
    tokenBudget: null,
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
