import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("lark mid-turn steering", () => {
  it("steers a plain text message into the active run instead of queueing a new turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-ok-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_steer", content: "也用英文写一版" }),
      });

      expect(handled).toBe(true);
      // The steered text is the same normalized form a queued turn would get:
      // the user's words verbatim plus the standard <lark_context> envelope.
      expect(bridge.steerActiveTurn).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("也用英文写一版"),
      }));
      // The steered message must NOT start a second turn.
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      // Ack reaction on the steered message.
      expect(channel.addReaction).toHaveBeenCalledWith("om_steer", "OK");
      const events = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "engine.event",
        outcome: "success",
        metadata: expect.objectContaining({ eventType: "engine.turn.steered" }),
      }));
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("falls back to the normal queue when the engine rejects the steer", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-fallback-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => false),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fallback", content: "follow-up" }),
      });

      expect(bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
      // The message is never lost: it goes through the queued-turn path.
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("does not steer when no turn is active", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-idle-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ content: "hello" }),
      });

      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("does not steer for an unauthorized sender (falls through to the denying path)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-denied-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "deny" as const, text: "denied" })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ content: "inject me" }),
      });

      // An unauthorized member must never inject text into a running turn.
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("does not steer a quoted reply (the quote is composed only on the queued path)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-quote-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = {
      ...fakeChannel(),
      fetchMessage: vi.fn(async () => ({
        messageId: "om_parent",
        msgType: "text",
        content: JSON.stringify({ text: "之前那段说明" }),
      })),
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          ...fakeLarkMessage({ content: "按这个再改一下" }),
          replyToMessageId: "om_parent",
        },
      });

      // Steering would silently drop the quoted text; quoted replies queue
      // normally so handleAuthorizedMessage can compose the quote.
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        replyContext: expect.objectContaining({ messageId: "om_parent" }),
      }));
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("does not steer when the conversation already has a queued backlog", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-backlog-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    runtime.chatQueue = {
      enqueue: vi.fn(async (_chatId: string, job: () => Promise<unknown>) => await job()),
      pendingCount: vi.fn(() => 2),
      clearPending: vi.fn(() => false),
      cancel: vi.fn(() => false),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ content: "keep my place in line" }),
      });

      // FIFO order is preserved: queued messages keep their position.
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("/q forces a queued turn even when steering is possible, and strips the prefix", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-q-escape-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_q", content: "/q 干完当前的再做这个任务" }),
      });

      // The user explicitly asked for sequencing: never steer.
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const turnText = (bridge.handleAuthorizedMessage.mock.calls[0][0] as { text: string }).text;
      expect(turnText).toContain("干完当前的再做这个任务");
      expect(turnText).not.toContain("/q ");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("bare /q replies with a usage hint instead of running a turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-q-bare-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_q_bare", content: "/q" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      const sentTexts = channel.send.mock.calls.map((call) => JSON.stringify(call[1]));
      expect(sentTexts.some((text) => text.includes("/q <"))).toBe(true);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("handles a mixed text→file→text sequence: steer once, then strict FIFO queueing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-mixed-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();

    // A long-running turn occupies the conversation queue, like a real
    // in-flight engine turn would.
    let releaseRunningTurn!: () => void;
    const runningTurn = new Promise<void>((resolve) => {
      releaseRunningTurn = resolve;
    });
    void runtime.chatQueue.enqueue("lark:oc_chat", async () => {
      await runningTurn;
    });
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });

    const turnOrder: string[] = [];
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        turnOrder.push(input.text.includes("note.txt") || input.text.includes("文件") ? "file" : "text");
        return { text: "done" };
      }),
    };

    try {
      // Round 1: plain text while the turn runs and the queue is empty → steers.
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_round1", content: "先补一句话" }),
      });
      expect(bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();

      // Round 2: a file → attachments never steer; it queues behind the turn.
      const round2 = handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          ...fakeLarkMessage({ messageId: "om_round2", content: "看这个文件" }),
          resources: [{ type: "file", fileKey: "file_1", fileName: "note.txt" }],
        },
      });
      // Round 3: plain text again — but the file already queued, so FIFO wins
      // over steering and this text queues BEHIND the file.
      const round3 = handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_round3", content: "然后再说一句" }),
      });

      // Give round 2/3 a moment to take their queue decisions.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
      expect(runtime.chatQueue.pendingCount("lark:oc_chat")).toBe(2);

      // The running turn finishes; the backlog drains in order: file, then text.
      releaseRunningTurn();
      await Promise.all([round2, round3]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
      expect(turnOrder).toEqual(["file", "text"]);
    } finally {
      releaseRunningTurn();
      await removeTempRoot(stateDir);
    }
  });
});

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  content: string;
  mentionedBot: boolean;
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    senderId: "ou_user",
    content: overrides.content ?? "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

function fakeChannel() {
  return {
    send: vi.fn(async (_to: string, _payload: unknown, _options?: unknown) => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: { messageId: string; current: object; update: () => Promise<void> }) => Promise<void>;
      };
    }) => {
      await input.card.producer({
        messageId: "stream_1",
        current: input.card.initial,
        update: async () => undefined,
      });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn(async (_messageId: string, _card?: unknown) => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
    addReaction: vi.fn(async (_messageId: string, _emojiType: string) => "reaction-1"),
  };
}
