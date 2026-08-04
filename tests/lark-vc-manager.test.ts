import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeetingConfig } from "../src/telegram/instance-config.js";
import type { LarkVcRequestClient } from "../src/lark/vc/vc-api.js";
import { MeetingManager, VC_BOT_EVENTS, extractActivityItems } from "../src/lark/vc/manager.js";
import type { MeetingSession } from "../src/lark/vc/session.js";
import type { RawActivityItem } from "../src/lark/vc/types.js";

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

interface RequestPayload {
  method: string;
  url: string;
  data?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

/** A client that answers join by echoing `mid-<no>`, and stubs the rest. */
function makeClient(): LarkVcRequestClient & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (payload: RequestPayload) => {
    if (payload.url.endsWith("/join")) {
      const identify = payload.data?.join_identify as { meeting_no?: string } | undefined;
      return { data: { meeting: { id: `mid-${identify?.meeting_no}` } } };
    }
    if (payload.url.endsWith("/events")) return { data: { events: [], has_more: false } };
    return {};
  });
  return { request } as never;
}

function transcript(meetingId: string, sentenceId: string, text: string): RawActivityItem {
  return {
    event_id: `${meetingId}-${sentenceId}`,
    activity_event_type: "transcript_received",
    meeting: { id: meetingId },
    transcript_received_items: [{ sentence_id: sentenceId, text, speaker: { name: "U" } }],
  };
}

function joinCalls(client: { request: ReturnType<typeof vi.fn> }): RequestPayload[] {
  return client.request.mock.calls.map((c) => c[0] as RequestPayload).filter((p) => p.url.endsWith("/join"));
}

function leaveCalls(client: { request: ReturnType<typeof vi.fn> }): RequestPayload[] {
  return client.request.mock.calls.map((c) => c[0] as RequestPayload).filter((p) => p.url.endsWith("/leave"));
}

// Fake timers keep each joined session's poller inert (setTimeout never fires),
// so the manager tests stay deterministic and free of background polling.
describe("MeetingManager — lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("join creates a session, fires onSession and returns it", async () => {
    const client = makeClient();
    const created: MeetingSession[] = [];
    const mgr = new MeetingManager({ client, config: () => cfg(), onSession: (s) => created.push(s) });
    const session = await mgr.join("123456789");
    expect(session.meetingId).toBe("mid-123456789");
    expect(session.meetingNo).toBe("123456789");
    expect(created).toEqual([session]);
    expect(mgr.get("mid-123456789")).toBe(session);
    expect(joinCalls(client)).toHaveLength(1);
  });

  it("join dedups a live session for the same meeting number", async () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg() });
    const first = await mgr.join("123456789");
    const second = await mgr.join("123456789");
    expect(second).toBe(first);
    expect(joinCalls(client)).toHaveLength(1); // no second REST join
    expect(mgr.all()).toHaveLength(1);
  });

  it("passes the bot open_id into new sessions for self-echo filtering", async () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg(), botOpenId: () => "ou_bot" });
    const session = await mgr.join("123456789");
    session.handleActivity([
      {
        event_id: "x1",
        activity_event_type: "transcript_received",
        meeting: { id: session.meetingId },
        transcript_received_items: [{ sentence_id: "s1", text: "echo", speaker: { open_id: "ou_bot" } }],
      },
    ]);
    expect(session.status().transcriptLines).toBe(0); // self-echo dropped
  });

  it("leave removes the session and calls the REST leave", async () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg() });
    await mgr.join("123456789");
    await expect(mgr.leave("mid-123456789")).resolves.toBe(true);
    expect(mgr.all()).toHaveLength(0);
    expect(leaveCalls(client)).toHaveLength(1);
    expect(leaveCalls(client)[0]?.data).toMatchObject({ meeting_id: "mid-123456789" });
    // Idempotent: leaving an unknown/gone meeting is a no-op.
    await expect(mgr.leave("mid-123456789")).resolves.toBe(false);
    expect(leaveCalls(client)).toHaveLength(1);
  });

  it("leaveAll drops and leaves every session", async () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg() });
    await mgr.join("123456789");
    await mgr.join("987654321");
    await mgr.leaveAll();
    expect(mgr.all()).toHaveLength(0);
    expect(leaveCalls(client)).toHaveLength(2);
  });

  it("handleEnded fires onEnded(meetingId, session), removes it, marks ended", async () => {
    const client = makeClient();
    const ended: Array<[string, MeetingSession]> = [];
    const mgr = new MeetingManager({ client, config: () => cfg(), onEnded: (id, s) => ended.push([id, s]) });
    const session = await mgr.join("123456789");
    expect(mgr.handleEnded("mid-123456789")).toBe(true);
    expect(ended).toEqual([["mid-123456789", session]]);
    expect(session.ended).toBe(true);
    expect(mgr.all()).toHaveLength(0);
    expect(leaveCalls(client)).toHaveLength(0); // ended != leave; no REST leave
    expect(mgr.handleEnded("mid-123456789")).toBe(false); // idempotent
  });

  it("dispose stops sessions WITHOUT leaving the meetings (reconnect)", async () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg() });
    await mgr.join("123456789");
    mgr.dispose();
    expect(mgr.all()).toHaveLength(0);
    expect(leaveCalls(client)).toHaveLength(0); // reconnect must not leave
  });
});

describe("MeetingManager — activity routing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("routes each item to its session by meeting.id and ignores unmanaged meetings", async () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg() });
    const a = await mgr.join("123456789"); // mid-123456789
    const b = await mgr.join("987654321"); // mid-987654321
    mgr.handleActivity([
      transcript("mid-123456789", "s1", "for-a"),
      transcript("mid-987654321", "s1", "for-b"),
      transcript("mid-000000000", "s1", "orphan"), // no session → ignored, no throw
    ]);
    expect(a.status().transcriptLines).toBe(1);
    expect(a.recentTranscript()).toEqual(["U: for-a"]);
    expect(b.recentTranscript()).toEqual(["U: for-b"]);
    // Routed push flips each touched session to the push source.
    expect(a.status().source).toBe("push");
    expect(b.status().source).toBe("push");
  });

  it("ignores non-array activity payloads without throwing", () => {
    const client = makeClient();
    const mgr = new MeetingManager({ client, config: () => cfg() });
    expect(() => mgr.handleActivity(undefined as never)).not.toThrow();
    expect(() => mgr.handleActivity({} as never)).not.toThrow();
  });
});

describe("MeetingManager — push hook", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeDispatcher() {
    const handles: Record<string, (d: unknown) => unknown> = {};
    return {
      register: vi.fn((h: Record<string, (d: unknown) => unknown>) => Object.assign(handles, h)),
      fire: (name: string, data: unknown) => handles[name]?.(data),
      handleNames: () => Object.keys(handles),
    };
  }

  it("registers the three vc.bot.* events and routes pushes through them", async () => {
    const client = makeClient();
    const invited: Array<[string, string | undefined]> = [];
    const ended: string[] = [];
    const mgr = new MeetingManager({
      client,
      config: () => cfg(),
      onInvited: (no, by) => invited.push([no, by]),
      onEnded: (id) => ended.push(id),
    });
    const session = await mgr.join("123456789");
    const disp = fakeDispatcher();

    const health = mgr.attachPush(disp);
    expect(health.hooked).toBe(true);
    expect(disp.handleNames().sort()).toEqual(
      [VC_BOT_EVENTS.activity, VC_BOT_EVENTS.ended, VC_BOT_EVENTS.invited].sort(),
    );

    // activity → routed + counted
    disp.fire(VC_BOT_EVENTS.activity, {
      meeting_activity_items: [transcript("mid-123456789", "s1", "hi")],
    });
    expect(session.status().transcriptLines).toBe(1);

    // invited → onInvited
    disp.fire(VC_BOT_EVENTS.invited, { meeting: { meeting_no: "555444333" }, operator: { open_id: "ou_boss" } });
    expect(invited).toEqual([["555444333", "ou_boss"]]);

    // ended → onEnded + removed
    disp.fire(VC_BOT_EVENTS.ended, { meeting: { id: "mid-123456789" } });
    expect(ended).toEqual(["mid-123456789"]);
    expect(mgr.all()).toHaveLength(0);

    // Every push bumped the health counter (3 fires).
    expect(mgr.pushHealth().received).toBe(3);
    expect(mgr.pushHealth().lastAt).toBeTypeOf("string");
  });

  it("falls back to poll-only when no dispatcher is provided", () => {
    const mgr = new MeetingManager({ client: makeClient(), config: () => cfg() });
    const health = mgr.attachPush(undefined);
    expect(health.hooked).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it("falls back to poll-only when the dispatcher has no register()", () => {
    const mgr = new MeetingManager({ client: makeClient(), config: () => cfg() });
    const health = mgr.attachPush({ nope: true });
    expect(health.hooked).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it("reports the reason and stays unhooked when register() throws", () => {
    const mgr = new MeetingManager({ client: makeClient(), config: () => cfg() });
    const health = mgr.attachPush({
      register: () => {
        throw new Error("boom");
      },
    });
    expect(health.hooked).toBe(false);
    expect(health.reason).toContain("boom");
  });
});

describe("extractActivityItems", () => {
  it("reads both field names and drops non-activity entries", () => {
    const good = transcript("m", "s1", "x");
    expect(extractActivityItems({ meeting_activity_items: [good] })).toEqual([good]);
    expect(extractActivityItems({ events: [good] })).toEqual([good]);
    // An entry with no activity type is filtered out.
    expect(extractActivityItems({ events: [good, { meeting: { id: "m" } }] })).toEqual([good]);
    expect(extractActivityItems({})).toEqual([]);
    expect(extractActivityItems(null)).toEqual([]);
  });
});
