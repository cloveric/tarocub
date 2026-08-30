import { describe, expect, it, vi } from "vitest";

import { attachLarkMeetingSupport } from "../src/lark/vc/lark-integration.js";
import { DEFAULT_MEETING_CONFIG } from "../src/telegram/instance-config.js";
import { VcApiError, type LarkVcRequestClient } from "../src/lark/vc/vc-api.js";

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    rawClient: { request: vi.fn() } as unknown as LarkVcRequestClient,
    bridge: { handleAuthorizedMessage: vi.fn(async () => ({ text: "answer" })) },
    config: () => ({ ...DEFAULT_MEETING_CONFIG, enabled: true }),
    meetingChatId: () => 1,
    ...overrides,
  };
}

describe("attachLarkMeetingSupport — gating", () => {
  it("returns null when meeting.enabled is false (feature entirely inert)", () => {
    const support = attachLarkMeetingSupport(baseDeps({
      config: () => ({ ...DEFAULT_MEETING_CONFIG, enabled: false }),
    }) as never);
    expect(support).toBeNull();
  });

  it("constructs a manager only when enabled", () => {
    const support = attachLarkMeetingSupport(baseDeps() as never);
    expect(support).not.toBeNull();
    expect(support!.manager).toBeDefined();
  });
});

describe("/meeting command handling", () => {
  it("ignores non-meeting text", async () => {
    const support = attachLarkMeetingSupport(baseDeps() as never)!;
    expect(await support.handleMeetingCommand("hello", "en")).toBeNull();
  });

  it("reports no active meetings on /meeting status", async () => {
    const support = attachLarkMeetingSupport(baseDeps() as never)!;
    const reply = await support.handleMeetingCommand("/meeting status", "en");
    expect(reply).toContain("No active meetings");
  });

  it("validates the meeting number on /meeting join", async () => {
    const support = attachLarkMeetingSupport(baseDeps() as never)!;
    const reply = await support.handleMeetingCommand("/meeting join 42", "en");
    expect(reply).toContain("9-digit");
  });

  it("surfaces the beta-gate guidance when join hits ErrNotInGray", async () => {
    const request = vi.fn(async () => { throw new VcApiError(20017, "not in gray", "join"); });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    const reply = await support.handleMeetingCommand("/meeting join 123456789", "en");
    expect(reply).toContain("beta");
    expect(reply).toContain("early-bird");
  });

  it("joins a meeting and confirms with the trigger hint", async () => {
    const request = vi.fn(async (payload: { url: string; data?: Record<string, unknown> }) => {
      if (payload.url.endsWith("/join")) {
        return { data: { meeting: { id: "meet-long" } } };
      }
      return { data: { events: [], has_more: false } }; // polling
    });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    const reply = await support.handleMeetingCommand("/meeting join 123456789", "en");
    expect(reply).toContain("Joined meeting 123456789");
    await support.dispose();
  });

  it("never ends a meeting until the caller supplies the explicit confirm token", async () => {
    const request = vi.fn(async (payload: { url: string }) => {
      if (payload.url.endsWith("/join")) return { data: { meeting: { id: "meet-long" } } };
      if (payload.url.endsWith("/events")) return { data: { events: [], has_more: false } };
      return { data: {} };
    });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    await support.handleMeetingCommand("/meeting join 123456789", "en");

    const warning = await support.handleMeetingCommand("/meeting end", "en");

    expect(warning).toContain("confirm");
    expect(request.mock.calls.some(([payload]) => payload.url.endsWith("/end"))).toBe(false);
    await support.dispose();
  });

  it("ends the sole active meeting after explicit confirmation", async () => {
    const request = vi.fn(async (payload: { url: string }) => {
      if (payload.url.endsWith("/join")) return { data: { meeting: { id: "meet-long" } } };
      if (payload.url.endsWith("/events")) return { data: { events: [], has_more: false } };
      return { data: {} };
    });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    await support.handleMeetingCommand("/meeting join 123456789", "en");

    const reply = await support.handleMeetingCommand("/meeting end confirm", "en");

    expect(reply).toContain("Ended meeting 123456789");
    expect(request.mock.calls.some(([payload]) => payload.url.endsWith("/end"))).toBe(true);
    expect(support.manager.all()).toHaveLength(0);
  });

  it("invites selected users or all suggested Calendar attendees", async () => {
    const request = vi.fn(async (payload: { url: string }) => {
      if (payload.url.endsWith("/join")) return { data: { meeting: { id: "meet-long" } } };
      if (payload.url.endsWith("/events")) return { data: { events: [], has_more: false } };
      if (payload.url.endsWith("/invite")) return { data: { invited_count: 2, failed_count: 0 } };
      return { data: {} };
    });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    await support.handleMeetingCommand("/meeting join 123456789", "en");

    expect(await support.handleMeetingCommand("/meeting invite ou_a ou_b", "en"))
      .toContain("Invited 2");
    expect(await support.handleMeetingCommand("/meeting invite all", "en"))
      .toContain("Invited 2");
    expect(request.mock.calls.filter(([payload]) => payload.url.endsWith("/invite"))).toHaveLength(2);
    await support.dispose();
  });

  it("accepts native Lark @mentions as selected meeting invitees", async () => {
    const request = vi.fn(async (payload: { url: string; data?: Record<string, unknown> }) => {
      if (payload.url.endsWith("/join")) return { data: { meeting: { id: "meet-long" } } };
      if (payload.url.endsWith("/events")) return { data: { events: [], has_more: false } };
      if (payload.url.endsWith("/invite")) return { data: { invited_count: 1, failed_count: 0 } };
      return { data: {} };
    });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    await support.handleMeetingCommand("/meeting join 123456789", "en");

    const reply = await support.handleMeetingCommand(
      "/meeting invite @Alice",
      "en",
      { mentionOpenIds: ["ou_alice"] },
    );

    expect(reply).toContain("Invited 1");
    const inviteCall = request.mock.calls.find(([payload]) => payload.url.endsWith("/invite"));
    expect(inviteCall?.[0].data).toMatchObject({
      invitees: [{ id: "ou_alice", user_type: 1 }],
    });
    await support.dispose();
  });

  it("accepts selected invitees when the SDK strips mention placeholders from command text", async () => {
    const request = vi.fn(async (payload: { url: string; data?: Record<string, unknown> }) => {
      if (payload.url.endsWith("/join")) return { data: { meeting: { id: "meet-long" } } };
      if (payload.url.endsWith("/events")) return { data: { events: [], has_more: false } };
      if (payload.url.endsWith("/invite")) return { data: { invited_count: 1, failed_count: 0 } };
      return { data: {} };
    });
    const support = attachLarkMeetingSupport(baseDeps({
      rawClient: { request } as unknown as LarkVcRequestClient,
    }) as never)!;
    await support.handleMeetingCommand("/meeting join 123456789", "en");

    const reply = await support.handleMeetingCommand(
      "/meeting invite",
      "en",
      { mentionOpenIds: ["ou_alice"] },
    );

    expect(reply).toContain("Invited 1");
    await support.dispose();
  });
});
