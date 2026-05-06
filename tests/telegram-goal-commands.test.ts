import { describe, expect, it, vi } from "vitest";

import { handleGoalTelegramCommand } from "../src/telegram/goal-commands.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

describe("handleGoalTelegramCommand", () => {
  it("sets a Codex thread goal from Telegram", async () => {
    const sendMessage = vi.fn();
    const setThreadGoal = vi.fn().mockResolvedValue({
      goal: {
        threadId: "thread-123",
        objective: "ship the release",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: {
        engine: "codex",
        resume: {
          sessionId: "session-1",
          dirName: "project",
          workspacePath: "/tmp/project",
        },
      },
      normalized: createNormalizedMessage("/goal ship the release"),
      context: {
        api: { sendMessage },
        bridge: { setThreadGoal },
      },
    });

    expect(handled).toBe(true);
    expect(setThreadGoal).toHaveBeenCalledWith({
      chatId: 123,
      userId: 456,
      chatType: "private",
      messageThreadId: undefined,
      conversationKey: undefined,
      objective: "ship the release",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
    });
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Goal set"));
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("ship the release"));
  });

  it("sets a Codex thread goal with an explicit token budget", async () => {
    const sendMessage = vi.fn();
    const setThreadGoal = vi.fn().mockResolvedValue({
      goal: {
        threadId: "thread-123",
        objective: "ship the release",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "codex" },
      normalized: createNormalizedMessage("/goal -b 50k ship the release"),
      context: {
        api: { sendMessage },
        bridge: { setThreadGoal },
      },
    });

    expect(handled).toBe(true);
    expect(setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
      objective: "ship the release",
      tokenBudget: 50_000,
    }));
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("50000 token budget"));
  });

  it("rejects invalid goal token budgets instead of treating them as objective text", async () => {
    const sendMessage = vi.fn();
    const setThreadGoal = vi.fn();

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "codex" },
      normalized: createNormalizedMessage("/goal --budget nope ship the release"),
      context: {
        api: { sendMessage },
        bridge: { setThreadGoal },
      },
    });

    expect(handled).toBe(true);
    expect(setThreadGoal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, "Invalid /goal token budget. Use --budget 50000 or -b 50k.");
  });

  it("keeps /goal status read-only when no goal exists", async () => {
    const sendMessage = vi.fn();
    const getThreadGoal = vi.fn().mockResolvedValue({ goal: null });
    const setThreadGoal = vi.fn();

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "codex" },
      normalized: createNormalizedMessage("/goal status"),
      context: {
        api: { sendMessage },
        bridge: { getThreadGoal, setThreadGoal },
      },
    });

    expect(handled).toBe(true);
    expect(getThreadGoal).toHaveBeenCalledTimes(1);
    expect(setThreadGoal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, "No active Codex goal for this chat.");
  });

  it("rejects /goal on non-Codex engines instead of forwarding it as ordinary text", async () => {
    const sendMessage = vi.fn();
    const setThreadGoal = vi.fn();

    const handled = await handleGoalTelegramCommand({
      locale: "zh",
      cfg: { engine: "claude" },
      normalized: createNormalizedMessage("/goal 写发布说明"),
      context: {
        api: { sendMessage },
        bridge: { setThreadGoal },
      },
    });

    expect(handled).toBe(true);
    expect(setThreadGoal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(123, "只有 Codex 引擎支持 /goal。");
  });
});
