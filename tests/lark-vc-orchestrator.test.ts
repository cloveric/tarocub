import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  answerInMeeting,
  attachMeetingAgent,
  matchTrigger,
  type MeetingOrchestratorDeps,
} from "../src/lark/vc/orchestrator.js";
import { DEFAULT_MEETING_CONFIG } from "../src/telegram/instance-config.js";
import type { MeetingSession } from "../src/lark/vc/session.js";

/** A fake session: an EventEmitter with the transcript/send surface the orchestrator uses. */
function fakeSession(transcript: string[] = []): MeetingSession & {
  emitChat(chat: Record<string, unknown>): void;
  sent: string[];
} {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const session = {
    meetingId: "meet-1",
    meetingNo: "123456789",
    recentTranscript: () => transcript,
    sendMessage: async (text: string) => { sent.push(text); },
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => emitter.off(event, listener),
    emitChat: (chat: Record<string, unknown>) => emitter.emit("chat", chat),
    sent,
  } as unknown as MeetingSession & { emitChat(chat: Record<string, unknown>): void; sent: string[] };
  return session;
}

function deps(overrides: Partial<MeetingOrchestratorDeps> = {}): MeetingOrchestratorDeps & { bridgeCalls: Array<{ text: string }> } {
  const bridgeCalls: Array<{ text: string }> = [];
  return {
    bridge: {
      handleAuthorizedMessage: async (input) => {
        bridgeCalls.push({ text: input.text });
        return { text: "AGENT ANSWER" };
      },
    },
    config: () => ({ ...DEFAULT_MEETING_CONFIG, enabled: true }),
    botName: () => "TaroCub",
    meetingChatId: () => 42,
    locale: () => "en",
    bridgeCalls,
    ...overrides,
  } as MeetingOrchestratorDeps & { bridgeCalls: Array<{ text: string }> };
}

describe("meeting trigger matching", () => {
  it("matches the configured trigger and @botName, stripping punctuation", () => {
    expect(matchTrigger("@bot hello", ["@bot"])).toBe("hello");
    expect(matchTrigger("@TaroCub: do it", ["@TaroCub"])).toBe("do it");
    expect(matchTrigger("random chatter", ["@bot"])).toBeUndefined();
    expect(matchTrigger("@bot", ["@bot"])).toBe("");
  });
});

describe("attachMeetingAgent — transcript is context, only an explicit ask triggers", () => {
  it("does NOT run on an untriggered chat message", async () => {
    const session = fakeSession();
    const d = deps();
    attachMeetingAgent(session, d);
    session.emitChat({ kind: "chat", from: { name: "Eric" }, content: "just discussing" });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.bridgeCalls).toHaveLength(0);
  });

  it("runs an agent turn on a triggered ask and feeds the transcript as context", async () => {
    const session = fakeSession(["Eric: 我们要不要上线", "Ann: 先测试"]);
    const d = deps();
    attachMeetingAgent(session, d);
    session.emitChat({ kind: "chat", from: { name: "Eric" }, content: "@TaroCub 总结一下" });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.bridgeCalls).toHaveLength(1);
    expect(d.bridgeCalls[0]!.text).toContain("Eric: 我们要不要上线"); // transcript context
    expect(d.bridgeCalls[0]!.text).toContain("总结一下"); // the ask
    expect(session.sent).toContain("AGENT ANSWER"); // broadcast into the meeting
  });

  it("interrupts on a stop word instead of running", async () => {
    const session = fakeSession();
    const d = deps();
    attachMeetingAgent(session, d);
    session.emitChat({ kind: "chat", from: { name: "Eric" }, content: "@TaroCub stop" });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.bridgeCalls).toHaveLength(0);
    expect(session.sent.some((s) => /Interrupted/.test(s))).toBe(true);
  });

  it("ignores an in-meeting reaction (messageType 3)", async () => {
    const session = fakeSession();
    const d = deps();
    attachMeetingAgent(session, d);
    session.emitChat({ kind: "chat", from: { name: "Eric" }, content: "@TaroCub 👍", messageType: 3 });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.bridgeCalls).toHaveLength(0);
  });
});

describe("answerInMeeting — respondIn routing", () => {
  it("respondIn=im posts to the origin chat, not into the meeting", async () => {
    const session = fakeSession(["ctx"]);
    const imSend = vi.fn(async () => undefined);
    const d = deps({
      config: () => ({ ...DEFAULT_MEETING_CONFIG, enabled: true, respondIn: "im" }),
      im: { send: imSend },
      originChatId: () => "oc_origin",
    });
    await answerInMeeting(session, "q", d, { deliver: "broadcast" });
    expect(imSend).toHaveBeenCalledWith("oc_origin", { markdown: "AGENT ANSWER" });
    expect(session.sent).toHaveLength(0); // not broadcast into the meeting
  });

  it("deliver=caller returns the answer and posts nothing", async () => {
    const session = fakeSession(["ctx"]);
    const d = deps();
    const answer = await answerInMeeting(session, "q", d, { deliver: "caller" });
    expect(answer).toBe("AGENT ANSWER");
    expect(session.sent).toHaveLength(0);
  });
});
