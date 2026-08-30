import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import type { LarkServiceRuntime } from "../src/lark/runtime.js";
import { removeTempRoot } from "./helpers/temp-files.js";

async function runMeetingCommand(content: string, options: {
  runtime?: LarkServiceRuntime;
  deny?: boolean;
  mentions?: unknown[];
} = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-meeting-"));
  const sent: string[] = [];
  const channel = {
    botIdentity: { openId: "ou_bot", name: "Bot" },
    send: vi.fn(async (_to: string, payload: unknown) => {
      sent.push(JSON.stringify(payload));
      return { messageId: "sent_1" };
    }),
    stream: vi.fn(),
    updateCard: vi.fn(async () => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
  };
  const bridge = {
    checkAccess: vi.fn(async () => (options.deny
      ? { kind: "deny" as const, text: "denied" }
      : { kind: "allow" as const })),
    handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
  };
  try {
    const handled = await handleLarkMessage({
      channel,
      bridge,
      runtime: options.runtime ?? createLarkServiceRuntime(),
      stateDir,
      message: {
        messageId: "om_meeting",
        chatId: "oc_chat",
        chatType: "p2p",
        senderId: "ou_user",
        content,
        rawContentType: "text",
        resources: [],
        mentions: options.mentions ?? [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      },
    });
    return { handled, sent, bridge };
  } finally {
    await removeTempRoot(stateDir);
  }
}

describe("/meeting command routing", () => {
  it("replies with the enablement notice when meeting support is disabled (the default)", async () => {
    const { handled, sent, bridge } = await runMeetingCommand("/meeting status");
    expect(handled).toBe(true);
    expect(sent.join("\n")).toMatch(/disabled|未启用/);
    // Handled pre-queue as a command — never becomes an engine turn.
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });

  it("routes to the attached meeting support when present", async () => {
    const runtime = createLarkServiceRuntime();
    const handleMeetingCommand = vi.fn(async () => "Meeting 123456789: source poll");
    runtime.meetingSupport = { handleMeetingCommand, dispose: async () => undefined };
    const { handled, sent } = await runMeetingCommand("/meeting status", { runtime });
    expect(handled).toBe(true);
    expect(handleMeetingCommand).toHaveBeenCalledWith(
      "/meeting status",
      expect.stringMatching(/en|zh/),
      { mentionOpenIds: [] },
    );
    expect(sent.join("\n")).toContain("Meeting 123456789");
  });

  it("passes user mention open_ids to the meeting invite command and drops the bot routing mention", async () => {
    const runtime = createLarkServiceRuntime();
    const handleMeetingCommand = vi.fn(async () => "Invited 1");
    runtime.meetingSupport = { handleMeetingCommand, dispose: async () => undefined };

    await runMeetingCommand("/meeting invite @Alice", {
      runtime,
      mentions: [
        { id: { openId: "ou_bot" }, name: "Bot" },
        { id: { openId: "ou_alice" }, name: "Alice" },
      ],
    });

    expect(handleMeetingCommand).toHaveBeenCalledWith(
      "/meeting invite @Alice",
      expect.stringMatching(/en|zh/),
      { mentionOpenIds: ["ou_alice"] },
    );
  });

  it("does not intercept non-meeting words like /meetings", async () => {
    const runtime = createLarkServiceRuntime();
    const handleMeetingCommand = vi.fn(async () => "should not appear");
    runtime.meetingSupport = { handleMeetingCommand, dispose: async () => undefined };
    const { sent } = await runMeetingCommand("/meetings tomorrow", { runtime });
    expect(handleMeetingCommand).not.toHaveBeenCalled();
    expect(sent.join("\n")).not.toContain("should not appear");
  });

  it("denies /meeting to an unauthorized sender (no meeting state leaked)", async () => {
    const runtime = createLarkServiceRuntime();
    const handleMeetingCommand = vi.fn(async () => "secret meeting state");
    runtime.meetingSupport = { handleMeetingCommand, dispose: async () => undefined };
    const { sent } = await runMeetingCommand("/meeting status", { runtime, deny: true });
    expect(handleMeetingCommand).not.toHaveBeenCalled();
    expect(sent.join("\n")).not.toContain("secret meeting state");
  });
});
