import { describe, expect, it, vi } from "vitest";

import {
  asVcApiError,
  endMeeting,
  inviteMeetingParticipants,
  isMeetingNo,
  joinMeeting,
  pullMeetingEvents,
  VcApiError,
  type LarkVcRequestClient,
} from "../src/lark/vc/vc-api.js";
import { classifyVcMeetingError, renderVcMeetingPreflight } from "../src/lark/vc/preflight.js";
import { DEFAULT_MEETING_CONFIG } from "../src/telegram/instance-config.js";

describe("VC meeting REST layer (ported from zara)", () => {
  it("accepts only 9-digit meeting numbers", () => {
    expect(isMeetingNo("123456789")).toBe(true);
    expect(isMeetingNo(" 123456789 ")).toBe(true);
    expect(isMeetingNo("12345678")).toBe(false);
    expect(isMeetingNo("1234567890")).toBe(false);
    expect(isMeetingNo("12345678a")).toBe(false);
  });

  it("join sends the fixed protocol shape and returns the long meeting id", async () => {
    const request = vi.fn(async () => ({ data: { meeting: { id: "meet-long-id" } } }));
    const client = { request } as unknown as LarkVcRequestClient;
    const result = await joinMeeting(client, "123456789", "pw");
    expect(result.meetingId).toBe("meet-long-id");
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      url: "/open-apis/vc/v1/bots/join",
      data: { join_type: 1, join_identify: { meeting_no: "123456789", password: "pw" } },
    });
  });

  it("rejects a non-9-digit meeting number before any request", async () => {
    const request = vi.fn();
    const client = { request } as unknown as LarkVcRequestClient;
    await expect(joinMeeting(client, "42")).rejects.toBeInstanceOf(VcApiError);
    expect(request).not.toHaveBeenCalled();
  });

  it("pullEvents puts args in params (GET bodies are dropped) and accepts both field names", async () => {
    // Old revision: `meeting_activity_items`.
    const request = vi.fn(async () => ({
      data: { meeting_activity_items: [{ a: 1 }], page_token: "tok", has_more: true },
    }));
    const client = { request } as unknown as LarkVcRequestClient;
    const res = await pullMeetingEvents(client, "meet-1", "prev", 100);
    expect(res.items).toEqual([{ a: 1 }]);
    expect(res.pageToken).toBe("tok");
    expect(res.hasMore).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      url: "/open-apis/vc/v1/bots/events",
      params: { meeting_id: "meet-1", page_size: 100, page_token: "prev" },
    });
  });

  it("invites selected users with the Agent bot protocol shape", async () => {
    const request = vi.fn(async () => ({
      data: {
        invited_count: 2,
        failed_count: 0,
        invite_results: [
          { id: "ou_a", status: 1 },
          { id: "ou_b", status: 1 },
        ],
      },
    }));
    const result = await inviteMeetingParticipants(
      { request } as unknown as LarkVcRequestClient,
      "7628568141510692381",
      { type: "selected", openIds: ["ou_a", "ou_b", "ou_a"] },
    );

    expect(result).toMatchObject({ invitedCount: 2, failedCount: 0, hasMore: false });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      url: "/open-apis/vc/v1/bots/invite",
      params: { user_id_type: "open_id" },
      data: {
        meeting_id: "7628568141510692381",
        invite_type: 2,
        invitees: [
          { id: "ou_a", user_type: 1 },
          { id: "ou_b", user_type: 1 },
        ],
      },
    });
  });

  it("rejects invalid or oversized invitee lists before calling Feishu", async () => {
    const request = vi.fn();
    const client = { request } as unknown as LarkVcRequestClient;
    await expect(inviteMeetingParticipants(client, "m1", { type: "selected", openIds: ["not-open-id"] }))
      .rejects.toBeInstanceOf(VcApiError);
    await expect(inviteMeetingParticipants(client, "m1", {
      type: "selected",
      openIds: Array.from({ length: 201 }, (_, index) => `ou_${index}`),
    })).rejects.toBeInstanceOf(VcApiError);
    expect(request).not.toHaveBeenCalled();
  });

  it("invites all suggested attendees without an invitee array", async () => {
    const request = vi.fn(async () => ({ data: { invited_count: 3, failed_count: 0, has_more: true } }));
    const result = await inviteMeetingParticipants(
      { request } as unknown as LarkVcRequestClient,
      "m1",
      { type: "all-suggested" },
    );
    expect(result.hasMore).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      url: "/open-apis/vc/v1/bots/invite",
      params: { user_id_type: "open_id" },
      data: { meeting_id: "m1", invite_type: 1 },
    });
  });

  it("ends a meeting through the host-only Agent bot endpoint", async () => {
    const request = vi.fn(async () => ({ data: {} }));
    await endMeeting({ request } as unknown as LarkVcRequestClient, "m1");
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      url: "/open-apis/vc/v1/bots/end",
      data: { meeting_id: "m1" },
    });
  });

  it("digs the real Feishu code out of the response body and flags the beta gate", () => {
    const raw = { response: { data: { code: 20017, msg: "not in gray" } } };
    const err = asVcApiError(raw, "join");
    expect(err.code).toBe(20017);
    expect(err.notInGray).toBe(true);
    expect(err.scopeMissing).toBe(false);
  });
});

describe("VC meeting preflight (feasibility gating)", () => {
  it("classifies the beta-allowlist error as not-in-beta with the early-bird chat", () => {
    const verdict = classifyVcMeetingError(new VcApiError(20017, "gray", "join"));
    expect(verdict.status).toBe("not-in-beta");
    expect(renderVcMeetingPreflight(verdict, "zh")).toContain("灰度");
    expect(renderVcMeetingPreflight(verdict, "en")).toContain("beta");
  });

  it("reports only the scope needed by the failing VC endpoint", () => {
    const verdict = classifyVcMeetingError(new VcApiError(99991672, "scope", "join"));
    expect(verdict.status).toBe("scope-missing");
    if (verdict.status === "scope-missing") {
      expect(verdict.missingScopes).toEqual(["vc:meeting.bot.join:write"]);
    }

    expect(classifyVcMeetingError(new VcApiError(99991672, "scope", "end"))).toEqual({
      status: "scope-missing",
      missingScopes: ["vc:meeting.bot.manage:write"],
    });
    expect(classifyVcMeetingError(new VcApiError(99991672, "scope", "invite"))).toEqual({
      status: "scope-missing",
      missingScopes: ["vc:meeting.bot.join:write"],
    });
  });

  it("falls back to unknown with a detail for other errors", () => {
    const verdict = classifyVcMeetingError(new Error("boom"));
    expect(verdict).toMatchObject({ status: "unknown", detail: "boom" });
  });
});

describe("meeting config is off by default", () => {
  it("defaults to disabled with sane values", () => {
    expect(DEFAULT_MEETING_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MEETING_CONFIG.respondIn).toBe("meeting");
    expect(DEFAULT_MEETING_CONFIG.transcriptKeep).toBe(200);
  });
});
