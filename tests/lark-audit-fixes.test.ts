import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createLarkServiceRuntime,
  handleLarkCardAction,
  handleLarkComment,
  handleLarkMessage,
  type LarkStreamControllerLike,
} from "../src/lark/service.js";
import {
  LARK_COMMENT_REPLY_MAX_BYTES,
  chunkLarkCommentReplyText,
} from "../src/lark/comment-handler.js";
import { renderLarkApprovalCard } from "../src/lark/card-renderer.js";
import { deliverLarkResponse } from "../src/lark/delivery.js";
import {
  classifyLarkTurnTermination,
  createLarkRunCardController,
} from "../src/lark/message-handler.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("lark audit fixes", () => {
  // Finding 1: one rejected delivery tag must not suppress the whole answer text.
  it("still delivers the answer text alongside the rejection notice when a send-file tag is rejected", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-rejected-tag-"));
    const channel = fakeChannel();

    try {
      await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: "这是答案正文。\n[send-file:/definitely/not/a/real/file.txt]",
        stateDir,
      });

      const payloads = channel.send.mock.calls.map((call) => call[1] as Record<string, unknown>);
      // The rejection notice is still sent…
      expect(payloads.some((payload) => JSON.stringify(payload).includes("文件未发送"))).toBe(true);
      // …and the cleaned answer text is delivered in addition, not suppressed.
      expect(payloads.some((payload) =>
        typeof payload.markdown === "string" && payload.markdown.includes("这是答案正文"))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 2: doc-comment reply chunking.
  it("chunks a long comment reply into UTF-8 byte-bounded pieces without losing content", () => {
    expect(chunkLarkCommentReplyText("short")).toEqual(["short"]);

    const text = Array.from(
      { length: 120 },
      (_, index) => `第${index + 1}行：这是一段比较长的中文内容，用来把回复撑到超过单条评论的字节预算。`,
    ).join("\n");
    const chunks = chunkLarkCommentReplyText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(LARK_COMMENT_REPLY_MAX_BYTES);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("delivers a long doc-comment answer as multiple sequential comment replies", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-comment-chunks-"));
    const longAnswer = Array.from(
      { length: 120 },
      (_, index) => `第${index + 1}段：这里是引擎生成的较长回答内容，必须完整回贴到评论里。`,
    ).join("\n");
    const replies: string[] = [];
    const commentClient = {
      getCommentContext: vi.fn(async () => ({ replies: [] })),
      createReply: vi.fn(async (input: { text: string }) => {
        replies.push(input.text);
      }),
    };
    const runtime = createLarkServiceRuntime({ commentClient });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: longAnswer })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime,
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(replies.length).toBeGreaterThan(1);
      for (const reply of replies) {
        expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(LARK_COMMENT_REPLY_MAX_BYTES);
      }
      expect(replies.join("")).toBe(longAnswer);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a delivery notice instead of an engine failure when posting the comment reply fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-comment-delivery-"));
    const longAnswer = Array.from(
      { length: 120 },
      (_, index) => `第${index + 1}段：这里是引擎生成的较长回答内容，必须完整回贴到评论里。`,
    ).join("\n");
    let createReplyCalls = 0;
    const posted: string[] = [];
    const commentClient = {
      getCommentContext: vi.fn(async () => ({ replies: [] })),
      createReply: vi.fn(async (input: { text: string }) => {
        createReplyCalls++;
        if (createReplyCalls === 2) {
          throw new Error("comment reply rejected");
        }
        posted.push(input.text);
      }),
    };
    const runtime = createLarkServiceRuntime({ commentClient });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: longAnswer })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime,
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      // The delivery-failure notice carries the first UNDELIVERED chunk…
      expect(posted.at(-1)).toContain("回贴到评论失败");
      expect(posted.at(-1)).toContain("第");
      // …and the generic engine error is never rendered for a delivery failure.
      expect(posted.some((text) => text.includes("运行失败"))).toBe(false);

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "success",
      }));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event.delivery_failed",
        outcome: "error",
      }));
      expect(timeline).not.toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "error",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("retries a transient Lark markdown chunk failure instead of losing the middle chunk", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-markdown-retry-"));
    const sentMarkdown: string[] = [];
    let sendCalls = 0;
    const channel = fakeChannel({
      send: vi.fn(async (_to: string, payload: { markdown?: string }) => {
        sendCalls++;
        if (sendCalls === 2) {
          throw new Error("temporary Lark send failure");
        }
        if (typeof payload.markdown === "string") {
          sentMarkdown.push(payload.markdown);
        }
        return { messageId: `sent_${sendCalls}` };
      }),
    });
    const chunks = [
      "A".repeat(3400),
      "B".repeat(3400),
      "C".repeat(3400),
    ];
    const text = chunks.join("\n\n");

    try {
      await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text,
        stateDir,
      });

      expect(channel.send).toHaveBeenCalledTimes(4);
      expect(sentMarkdown.join("")).toBe(text);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 3: card-choice runs claim activeRuns guarded, like /goal watchers.
  it("card choice attaches to a pursued /goal instead of killing it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-choice-goal-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const goal = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: goal, hasRunCard: true, goalWatch: true });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        // The pursuit must survive a card-triggered turn — same rule as ordinary
        // messages and crons (the turn attaches; it does not steal the slot).
        expect(goal.signal.aborted).toBe(false);
        return { text: "choice done" };
      }),
    };

    try {
      await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          messageId: "om_choice_goal",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "Option A",
              value: "A",
            },
          },
        },
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(goal.signal.aborted).toBe(false);
      // The goal still owns the slot after the card turn released its claim.
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(goal);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("card choice aborts a previous NON-goal holder and releases only its own claim", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-choice-claim-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const previous = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: previous, hasRunCard: true });
    const replacement = new AbortController();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        // The previous non-goal holder was aborted before this turn claimed the
        // slot — never silently orphaned.
        expect(previous.signal.aborted).toBe(true);
        // Simulate a newer run replacing the slot while this turn is running.
        runtime.activeRuns.set("lark:oc_chat", { abortController: replacement });
        return { text: "choice done" };
      }),
    };

    try {
      await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          messageId: "om_choice_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "Option A",
              value: "A",
            },
          },
        },
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(previous.signal.aborted).toBe(true);
      // The finally block must NOT clobber the newer claim.
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(replacement);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 4c: a stale queue-card stop tap must not abort the active run.
  it("treats a stale queue-card stop tap as a no-op instead of aborting the active run", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-stale-stop-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const active = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: active });

    try {
      await handleLarkCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          messageId: "om_stale_queue_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
              taskId: "om_no_longer_queued",
            },
          },
        },
      });

      expect(active.signal.aborted).toBe(false);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "该任务已不在队列中。" },
        expect.objectContaining({ replyTo: "om_stale_queue_card" }),
      );

      // A stop without a taskId (run-card stop button) still aborts the run.
      await handleLarkCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          messageId: "om_run_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
            },
          },
        },
      });
      expect(active.signal.aborted).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 4a: failed inline queue-card take-over recalls the orphan card.
  it("recalls the orphan inline queue card when the run-card take-over patch fails", async () => {
    const channel = fakeChannel({
      updateCard: vi.fn(async (messageId: string) => {
        if (messageId === "om_stale_wait_card") {
          throw new Error("patch rejected");
        }
      }),
    });

    const controller = await createLarkRunCardController({
      channel,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_msg",
      locale: "zh",
      existingCard: { messageId: "om_stale_wait_card" },
    });

    expect(channel.recallMessage).toHaveBeenCalledWith("om_stale_wait_card");
    // A fresh card replaced the orphan, so the controller is still live.
    expect(controller).toBeDefined();
  });

  // Finding 4b: a failed in-place queue-card refresh recalls the old card before
  // a fresh one replaces it.
  it("recalls the stale queue wait card when the in-place refresh fails and a fresh card is sent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-queue-wait-"));
    const runtime = createLarkServiceRuntime();
    runtime.queueCards.set("om_waited", { messageId: "om_old_wait_card" });
    runtime.chatQueue = {
      enqueue: async (
        _key: string,
        task: () => Promise<boolean>,
        options?: { onWait?: (event: { waitedMs: number; reason: string }) => void | Promise<void> },
      ) => {
        await options?.onWait?.({ waitedMs: 12_000, reason: "queue-busy" });
        return await task();
      },
      cancel: () => false,
      clearPending: () => undefined,
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel({
      updateCard: vi.fn(async (messageId: string) => {
        if (messageId === "om_old_wait_card") {
          throw new Error("patch rejected");
        }
      }),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_waited", content: "hello" }),
      });

      expect(channel.recallMessage).toHaveBeenCalledWith("om_old_wait_card");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 5: a failed batched merged turn must produce ONE error reply, not N.
  it("rejects only one waiter when a batched merged turn fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-batch-error-"));
    const runtime = createLarkServiceRuntime({ queuePolicy: { batchWindowMs: 150 } });
    const channel = fakeChannel();
    const bridge = {
      // Throws OUTSIDE the per-turn engine try/catch so the failure propagates to
      // the batch flush — previously rejecting every waiter (N error replies).
      checkAccess: vi.fn(async () => {
        throw new Error("boom-access");
      }),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
    };

    try {
      const settled = await Promise.allSettled([
        handleLarkMessage({
          channel,
          bridge,
          runtime,
          stateDir,
          message: fakeLarkMessage({ messageId: "om_batch_1", content: "first" }),
        }),
        handleLarkMessage({
          channel,
          bridge,
          runtime,
          stateDir,
          message: fakeLarkMessage({ messageId: "om_batch_2", content: "second" }),
        }),
      ]);

      // Both messages merged into ONE turn (single flush, single checkAccess).
      expect(bridge.checkAccess).toHaveBeenCalledTimes(1);
      const rejected = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as Error).message).toContain("boom-access");
      const fulfilled = settled.filter((entry): entry is PromiseFulfilledResult<boolean> => entry.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]!.value).toBe(true);
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "command.handled",
        outcome: "error",
        detail: "batch-merged",
        metadata: expect.objectContaining({
          larkMessageId: "om_batch_1",
          mergedInto: "om_batch_2",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 6: approval card header/summary localized like the button labels.
  it("localizes the approval card header and summary", () => {
    const zh = JSON.stringify(renderLarkApprovalCard({ requestId: "req_1", toolName: "Bash" }));
    expect(zh).toContain("请求审批");
    expect(zh).toContain("请求审批：Bash");
    expect(zh).not.toContain("Approval requested");

    const en = JSON.stringify(renderLarkApprovalCard({ requestId: "req_1", toolName: "Bash", locale: "en" }));
    expect(en).toContain("**Approval requested**");
    expect(en).toContain("Approval requested: Bash");
  });

  // Finding 7: engine-internal "aborted" errors are real failures unless the
  // caller's abort signal actually fired.
  it("classifies a bare 'aborted' error as interruption only when the signal fired", () => {
    expect(classifyLarkTurnTermination(new Error("Codex turn aborted"), undefined))
      .toEqual({ kind: "error" });
    expect(classifyLarkTurnTermination(new Error("turn pool wait aborted"), undefined))
      .toEqual({ kind: "error" });

    const aborted = new AbortController();
    aborted.abort();
    expect(classifyLarkTurnTermination(new Error("Codex turn aborted"), aborted.signal))
      .toEqual({ kind: "interrupted" });

    // Explicit user-stop messages stay message-based (the reaction layer has no signal).
    expect(classifyLarkTurnTermination(new Error("Task was stopped by user"), undefined))
      .toEqual({ kind: "interrupted" });
    expect(classifyLarkTurnTermination(new Error("the task was stopped"), undefined))
      .toEqual({ kind: "interrupted" });
    expect(classifyLarkTurnTermination(new Error("turn inactive after 5 minutes"), undefined))
      .toEqual({ kind: "idle_timeout", minutes: 5 });
  });

  // Finding 8: /help describes /stop accurately (current task only).
  it("describes /stop as stopping only the current task in /help", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-help-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_help", content: "/help" }),
      });

      const markdowns = channel.send.mock.calls
        .map((call) => (call[1] as { markdown?: string }).markdown)
        .filter((markdown): markdown is string => typeof markdown === "string");
      const help = markdowns.find((markdown) => markdown.includes("/stop"));
      expect(help).toBeDefined();
      expect(help).toContain("停当前任务");
      expect(help).toContain("排队任务在各自排队卡片上取消");
      expect(help).not.toContain("停当前/排队任务");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function fakeCommentEvent(overrides: Partial<{
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string;
  mentionedBot: boolean;
}> = {}) {
  return {
    fileToken: overrides.fileToken ?? "doc_token",
    fileType: overrides.fileType ?? "docx",
    commentId: overrides.commentId ?? "comment_1",
    operator: { openId: "ou_user" },
    mentionedBot: overrides.mentionedBot ?? true,
    timestamp: Date.now(),
    ...(overrides.replyId ? { replyId: overrides.replyId } : {}),
  };
}

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  content: string;
  threadId: string;
  mentionedBot: boolean;
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    senderId: "ou_user",
    ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    content: overrides.content ?? "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

type FakeLarkChannel = ReturnType<typeof baseFakeChannel>;

function fakeChannel(overrides: Partial<FakeLarkChannel> = {}): FakeLarkChannel {
  return {
    ...baseFakeChannel(),
    ...overrides,
  };
}

function baseFakeChannel() {
  return {
    send: vi.fn(async (_to: string, _payload: unknown, _options?: unknown) => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: LarkStreamControllerLike) => Promise<void>;
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
  };
}
