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
  it("sets an unbounded Codex thread goal by default", async () => {
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
      cfg: { engine: "codex" },
      normalized: createNormalizedMessage("/goal ship the release"),
      context: {
        api: { sendMessage },
        bridge: { setThreadGoal },
      },
    });

    expect(handled).toBe(true);
    expect(setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
      objective: "ship the release",
      tokenBudget: null,
    }));
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Budget: unbounded"));
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Goal usage: not recorded yet"));
  });

  it("sets an explicitly unbounded Codex thread goal from Telegram", async () => {
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
      normalized: createNormalizedMessage("/goal --unbounded ship the release"),
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
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Budget: 50000 tokens"));
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
    expect(sendMessage).toHaveBeenCalledWith(123, "No active goal for this chat.");
  });

  it("passes unbounded Claude goals through by default", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal 写发布说明");

    const handled = await handleGoalTelegramCommand({
      locale: "zh",
      cfg: { engine: "claude" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe("/goal 写发布说明");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lets explicitly unbounded Claude goals pass through to the native Claude Code slash command", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal --unbounded 写发布说明");

    const handled = await handleGoalTelegramCommand({
      locale: "zh",
      cfg: { engine: "claude" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe("/goal 写发布说明");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("strips Telegram bot usernames before passing Claude /goal through", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal@cloveric17bot 写发布说明");

    const handled = await handleGoalTelegramCommand({
      locale: "zh",
      cfg: { engine: "claude" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe("/goal 写发布说明");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("passes unbounded Antigravity goals through by default", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal run a long investigation");

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "antigravity" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe("/goal run a long investigation");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lets explicitly unbounded Antigravity goals pass through to the native agy slash command", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal --unbounded run a long investigation");

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "antigravity" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe("/goal run a long investigation");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("strips Telegram bot usernames before passing Antigravity /goal through", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal@cloveric17bot run a long investigation");

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "antigravity" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe("/goal run a long investigation");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("normalizes Antigravity /goal budgets into native goal guidance", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal@cloveric17bot -b 50k run a long investigation");

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "antigravity" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(false);
    expect(normalized.text).toBe(
      "/goal run a long investigation\n\n[Bridge note: requested token budget: 50000 tokens. Native Antigravity goals may treat this as guidance rather than an enforced budget.]",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid Antigravity /goal budgets before native pass-through", async () => {
    const sendMessage = vi.fn();
    const normalized = createNormalizedMessage("/goal --budget nope run a long investigation");

    const handled = await handleGoalTelegramCommand({
      locale: "en",
      cfg: { engine: "antigravity" },
      normalized,
      context: {
        api: { sendMessage },
        bridge: {},
      },
    });

    expect(handled).toBe(true);
    expect(normalized.text).toBe("/goal --budget nope run a long investigation");
    expect(sendMessage).toHaveBeenCalledWith(123, "Invalid /goal token budget. Use --budget 50000 or -b 50k.");
  });
});
