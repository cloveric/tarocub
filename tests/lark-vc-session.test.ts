import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeetingConfig } from "../src/telegram/instance-config.js";
import type { LarkVcRequestClient } from "../src/lark/vc/vc-api.js";
import { MeetingSession } from "../src/lark/vc/session.js";
import type { RawActivityItem } from "../src/lark/vc/types.js";
import type { ChatActivity, TranscriptActivity } from "../src/lark/vc/types.js";

function cfg(over: Partial<MeetingConfig> = {}): MeetingConfig {
  return {
    enabled: true,
    autoJoinOnInvite: false,
    trigger: "@bot",
    transcriptKeep: 200,
    respondIn: "meeting",
    pollIntervalMs: 1000,
    summaryOnEnd: false,
    ...over,
  };
}

/** A client whose `request` never actually matters unless we poll. */
function idleClient(): LarkVcRequestClient & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ data: { events: [], has_more: false } }));
  return { request } as never;
}

/** A client that serves a scripted queue of events-poll pages, then empties. */
function pollClient(pages: Array<Record<string, unknown>>): LarkVcRequestClient & {
  request: ReturnType<typeof vi.fn>;
} {
  const queue = [...pages];
  const request = vi.fn(async () => {
    if (queue.length) return { data: queue.shift() };
    return { data: { events: [], has_more: false } };
  });
  return { request } as never;
}

function transcript(opts: {
  eventId?: string;
  meetingId?: string;
  sentenceId: string;
  text: string;
  openId?: string;
  name?: string;
  startMs?: number;
}): RawActivityItem {
  return {
    ...(opts.eventId ? { event_id: opts.eventId } : {}),
    activity_event_type: "transcript_received",
    meeting: { id: opts.meetingId ?? "m-1" },
    transcript_received_items: [
      {
        sentence_id: opts.sentenceId,
        text: opts.text,
        speaker: {
          ...(opts.openId ? { open_id: opts.openId } : {}),
          ...(opts.name ? { name: opts.name } : {}),
        },
        ...(opts.startMs !== undefined ? { start_time_ms: opts.startMs } : {}),
      },
    ],
  };
}

function chat(opts: {
  eventId?: string;
  meetingId?: string;
  messageId: string;
  content: string;
  openId?: string;
  name?: string;
}): RawActivityItem {
  return {
    ...(opts.eventId ? { event_id: opts.eventId } : {}),
    activity_event_type: "chat_received",
    meeting: { id: opts.meetingId ?? "m-1" },
    chat_received_items: [
      {
        message_id: opts.messageId,
        content: opts.content,
        sender: {
          ...(opts.openId ? { open_id: opts.openId } : {}),
          ...(opts.name ? { name: opts.name } : {}),
        },
      },
    ],
  };
}

describe("MeetingSession — dedup", () => {
  it("ingests an item with the same event_id only once", () => {
    const s = new MeetingSession({ client: idleClient(), meetingId: "m-1", meetingNo: "111111111", config: cfg() });
    const item = chat({ eventId: "e1", messageId: "msg-1", content: "hello" });
    s.handleActivity([item]);
    // Different content but the SAME event_id must still be dropped.
    s.handleActivity([{ ...item, chat_received_items: [{ message_id: "msg-2", content: "world" }] }]);
    expect(s.status().ingested).toBe(1);
  });

  it("falls back to a synthesized content key when event_id is absent", () => {
    const s = new MeetingSession({ client: idleClient(), meetingId: "m-1", meetingNo: "111111111", config: cfg() });
    const seen: ChatActivity[] = [];
    s.on("chat", (e) => seen.push(e));
    const a = chat({ messageId: "msg-1", content: "same", openId: "ou_x" });
    s.handleActivity([a]);
    s.handleActivity([structuredClone(a)]); // identical, no event_id → deduped
    expect(seen).toHaveLength(1);
    expect(s.status().ingested).toBe(1);
    // A different message is a distinct content key → ingested.
    s.handleActivity([chat({ messageId: "msg-2", content: "other", openId: "ou_x" })]);
    expect(seen).toHaveLength(2);
    expect(s.status().ingested).toBe(2);
  });
});

describe("MeetingSession — transcript buffer", () => {
  it("overwrites a growing sentence in place by sentence_id", () => {
    const s = new MeetingSession({ client: idleClient(), meetingId: "m-1", meetingNo: "111111111", config: cfg() });
    s.handleActivity([transcript({ eventId: "e1", sentenceId: "s1", text: "你好", name: "Alice" })]);
    s.handleActivity([transcript({ eventId: "e2", sentenceId: "s1", text: "你好世界", name: "Alice" })]);
    expect(s.status().transcriptLines).toBe(1);
    expect(s.recentTranscript()).toEqual(["Alice: 你好世界"]);
  });

  it("drops the bot's own transcribed speech (self-echo)", () => {
    const bot = "ou_bot";
    const s = new MeetingSession({
      client: idleClient(),
      meetingId: "m-1",
      meetingNo: "111111111",
      botOpenId: bot,
      config: cfg(),
    });
    const heard: TranscriptActivity[] = [];
    s.on("transcript", (e) => heard.push(e));
    s.handleActivity([transcript({ eventId: "e1", sentenceId: "s1", text: "机器人说话", openId: bot, name: "Bot" })]);
    s.handleActivity([transcript({ eventId: "e2", sentenceId: "s2", text: "真人说话", openId: "ou_h", name: "Human" })]);
    // Self-echo never reaches the buffer or the subscribers; the human line does.
    expect(s.status().transcriptLines).toBe(1);
    expect(s.recentTranscript()).toEqual(["Human: 真人说话"]);
    expect(heard.map((e) => e.text)).toEqual(["真人说话"]);
  });

  it("renders `说话人: 内容` oldest-first and honors the keep bound", () => {
    const s = new MeetingSession({
      client: idleClient(),
      meetingId: "m-1",
      meetingNo: "111111111",
      config: cfg({ transcriptKeep: 3 }),
    });
    for (let i = 1; i <= 5; i += 1) {
      s.handleActivity([transcript({ eventId: `e${i}`, sentenceId: `s${i}`, text: `line${i}`, name: `U${i}` })]);
    }
    // Buffer bounded to transcriptKeep=3, holding the most recent sentences.
    expect(s.status().transcriptLines).toBe(3);
    expect(s.recentTranscript()).toEqual(["U3: line3", "U4: line4", "U5: line5"]);
    // recentTranscript(keep) slices to the last N, oldest-first.
    expect(s.recentTranscript(2)).toEqual(["U4: line4", "U5: line5"]);
  });
});

describe("MeetingSession — events & status", () => {
  it("emits a typed 'chat' event", () => {
    const s = new MeetingSession({ client: idleClient(), meetingId: "m-1", meetingNo: "111111111", config: cfg() });
    const got: ChatActivity[] = [];
    s.on("chat", (e) => got.push(e));
    s.handleActivity([chat({ eventId: "e1", messageId: "msg-1", content: "在吗", openId: "ou_h", name: "Human" })]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "chat", content: "在吗", from: { id: "ou_h", name: "Human" } });
  });

  it("prefixes unhandled/unparsed activity types with `?` in eventCounts", () => {
    const s = new MeetingSession({ client: idleClient(), meetingId: "m-1", meetingNo: "111111111", config: cfg() });
    s.handleActivity([transcript({ eventId: "e1", sentenceId: "s1", text: "hi", name: "A" })]);
    // Unknown type yields no normalized events → counted under `?<type>`.
    s.handleActivity([{ event_id: "e2", activity_event_type: "mystery_v9", meeting: { id: "m-1" } }]);
    const counts = s.status().eventCounts;
    expect(counts.transcript_received).toBe(1);
    expect(counts["?mystery_v9"]).toBe(1);
    expect(counts.mystery_v9).toBeUndefined();
  });
});

describe("MeetingSession — polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("backs off base×2 per idle round", async () => {
    const client = idleClient();
    const s = new MeetingSession({ client, meetingId: "m-1", meetingNo: "111111111", config: cfg({ pollIntervalMs: 1000 }) });
    s.startPolling();
    await vi.advanceTimersByTimeAsync(0); // first tick at delay 0
    expect(client.request).toHaveBeenCalledTimes(1);
    // After one idle round the gap is base×2 = 2000ms, not base.
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    // Next idle round doubles again to 4000ms (next poll at t=6000).
    await vi.advanceTimersByTimeAsync(3999);
    expect(client.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(3);
    s.dispose();
  });

  it("caps the idle backoff at 10s", async () => {
    const client = idleClient();
    const s = new MeetingSession({ client, meetingId: "m-1", meetingNo: "111111111", config: cfg({ pollIntervalMs: 6000 }) });
    s.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(1);
    // base×2 = 12000 would exceed the cap → clamped to 10000.
    await vi.advanceTimersByTimeAsync(9999);
    expect(client.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it("re-polls immediately when a page reports has_more", async () => {
    const client = pollClient([
      { events: [transcript({ eventId: "e1", sentenceId: "s1", text: "a", name: "A" })], has_more: true },
    ]);
    const s = new MeetingSession({ client, meetingId: "m-1", meetingNo: "111111111", config: cfg({ pollIntervalMs: 1000 }) });
    s.startPolling();
    // Both the first poll and the has_more-triggered re-poll land at ~t=0.
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it("ingests poll pages under both `events` and `meeting_activity_items`", async () => {
    const client = pollClient([
      { events: [transcript({ eventId: "e1", sentenceId: "s1", text: "aaa", name: "A" })], has_more: true },
      { meeting_activity_items: [transcript({ eventId: "e2", sentenceId: "s2", text: "bbb", name: "B" })], has_more: false },
    ]);
    const s = new MeetingSession({ client, meetingId: "m-1", meetingNo: "111111111", config: cfg({ pollIntervalMs: 1000 }) });
    s.startPolling();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.status().transcriptLines).toBe(2);
    expect(s.recentTranscript()).toEqual(["A: aaa", "B: bbb"]);
    s.dispose();
  });

  it("hands over from poll to push: the first push stops the poller", async () => {
    const client = idleClient();
    const s = new MeetingSession({ client, meetingId: "m-1", meetingNo: "111111111", config: cfg({ pollIntervalMs: 1000 }) });
    s.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(s.status().source).toBe("poll");
    s.markPushActive();
    expect(s.status().source).toBe("push");
    // Poller is torn down; no further polls fire no matter how far we advance.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.request).toHaveBeenCalledTimes(1);
    s.dispose();
  });
});
