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
    const request = vi.fn(async (payload: { url: string }) => {
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
});
