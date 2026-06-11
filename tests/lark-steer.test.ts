import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeTempRoot } from "./helpers/temp-files.js";

// The queued file-turn detaches post-turn attachment cleanup that can still be
// writing when the test ends; under full-suite load the stock 5x20ms retry in
// removeTempRoot is occasionally not enough (ENOTEMPTY). Retry longer, then
// swallow: leftover tmp garbage must not fail the suite.
async function cleanupTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await removeTempRoot(root);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  await removeTempRoot(root).catch(() => undefined);
}

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
      await cleanupTempRoot(stateDir);
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
      await cleanupTempRoot(stateDir);
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
      await cleanupTempRoot(stateDir);
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
      await cleanupTempRoot(stateDir);
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
      await cleanupTempRoot(stateDir);
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
      await cleanupTempRoot(stateDir);
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
      handleAuthorizedMessage: vi.fn(async (_input: { text: string }) => ({ text: "done" })),
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
      const turnText = bridge.handleAuthorizedMessage.mock.calls[0][0].text;
      expect(turnText).toContain("干完当前的再做这个任务");
      expect(turnText).not.toContain("/q ");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("/q preserves $-sequences in the payload (no replacement-string corruption)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-q-dollar-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string }) => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        // $$ / $& / $` are JS replacement-string specials; a naive .replace would
        // mangle them. The literal payload must reach the engine untouched.
        message: fakeLarkMessage({ messageId: "om_q_dollar", content: "/q price $$100 and $& and $`" }),
      });

      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const turnText = bridge.handleAuthorizedMessage.mock.calls[0][0].text;
      expect(turnText).toContain("price $$100 and $& and $`");
      expect(turnText).not.toContain("/q ");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("/q@botname strips the mention-shaped prefix and never leaks it into the prompt", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-q-mention-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string }) => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        // The /q@bot form: extractLarkMessageBody normalizes commandText to "/q …",
        // so the old substring .replace no-op'd and "/q@bot" leaked into the prompt.
        message: fakeLarkMessage({ messageId: "om_q_mention", content: "/q@tarocub_bot 排在后面再做" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const turnText = bridge.handleAuthorizedMessage.mock.calls[0][0].text;
      expect(turnText).toContain("排在后面再做");
      expect(turnText).not.toContain("/q@tarocub_bot");
      expect(turnText).not.toContain("/q ");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("/q never enters batch mode: it queues as its own turn instead of being merged", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-q-batch-"));
    // Batching ON with a long window and preempt ON: a plain message would batch
    // and the merged batch would preempt the running turn. A /q must do neither.
    const runtime = createLarkServiceRuntime({ queuePolicy: { batchWindowMs: 10_000, preempt: true } });
    const active = { abortController: new AbortController() };
    runtime.activeRuns.set("lark:oc_chat", active);
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string }) => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_q_batch", content: "/q 干完当前的再做这个" }),
      });

      // /q runs as its own queued turn immediately — never parked in a batch...
      expect(runtime.pendingBatches.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      // ...never steered...
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      // ...and its no-preempt guarantee holds: the running turn was not aborted.
      expect(active.abortController.signal.aborted).toBe(false);
      const turnText = bridge.handleAuthorizedMessage.mock.calls[0][0].text;
      expect(turnText).toContain("干完当前的再做这个");
      expect(turnText).not.toContain("/q ");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("bare /q from an unauthorized sender gets no usage text", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-q-bare-denied-"));
    const runtime = createLarkServiceRuntime();
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
        message: fakeLarkMessage({ messageId: "om_q_bare_denied", content: "/q" }),
      });

      const sentTexts = channel.send.mock.calls.map((call) => JSON.stringify(call[1]));
      // The usage hint is gated behind access now: an unauthorized sender must
      // not see it — only the denial reply.
      expect(sentTexts.some((text) => text.includes("/q <"))).toBe(false);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await cleanupTempRoot(stateDir);
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
      await cleanupTempRoot(stateDir);
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

      // Wait until round 2/3 have taken their queue decisions (poll instead of
      // a fixed sleep — attachment staging can be slow under full-suite load).
      const deadline = Date.now() + 10_000;
      while (runtime.chatQueue.pendingCount("lark:oc_chat") < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
      expect(runtime.chatQueue.pendingCount("lark:oc_chat")).toBe(2);

      // The running turn finishes; the backlog drains in order: file, then text.
      releaseRunningTurn();
      await Promise.all([round2, round3]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
      expect(turnOrder).toEqual(["file", "text"]);
    } finally {
      releaseRunningTurn();
      await cleanupTempRoot(stateDir);
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
