// Feishu VC "bot in-meeting" REST layer — ported from zara's
// lark-coding-agent-bridge (src/meeting/api.ts), adapted to TaroCub's Lark
// channel (calls go through the SDK Client's generic request() escape hatch,
// since @larksuiteoapi/node-sdk exposes no typed client.vc.v1.bot.* surface).
//
// GATING / FEASIBILITY (read before wiring this up): every endpoint here needs
// application scopes that are behind a Feishu **beta allowlist** (灰度):
//   - vc:meeting.bot.join:write     (join / leave)
//   - vc:meeting.message:write      (post into the meeting)
//   - vc:meeting.meetingevent:read  (read in-meeting events)
// Granting the scopes is NOT enough — an app outside the allowlist gets
// error 20017 / ErrNotInGray no matter what (see VcApiError.notInGray). Whether
// a personal-edition (个人版) PersonalAgent app can enter this allowlist at all
// is unconfirmed. This module is therefore inert until the operator's app is in
// the beta; nothing calls it unless meeting.enabled is set AND preflight passes.

/** Minimal shape of the SDK Client's generic request escape hatch. */
export interface LarkVcRequestClient {
  request<T = unknown>(payload: {
    method: string;
    url: string;
    data?: Record<string, unknown>;
    params?: Record<string, unknown>;
  }): Promise<T>;
}

const BASE = "/open-apis/vc/v1/bots";

/** Feishu meeting numbers are exactly 9 digits; the long meeting.id is separate. */
export function isMeetingNo(value: string): boolean {
  return /^\d{9}$/.test(value.trim());
}

export class VcApiError extends Error {
  constructor(
    readonly code: number | undefined,
    readonly feishuMessage: string | undefined,
    readonly endpoint: string,
  ) {
    super(`Feishu VC ${endpoint} failed: code=${code ?? "?"} ${feishuMessage ?? ""}`.trim());
    this.name = "VcApiError";
  }

  /**
   * Error 20017 = the app is not in the VC-bot beta allowlist. Granting scopes
   * cannot fix it — the operator must request beta access via the early-bird
   * chat. Distinguished so callers can surface the join-chat URL instead of a
   * generic failure.
   */
  get notInGray(): boolean {
    return this.code === 20017;
  }

  /** 99991672 / non-empty missing_scopes = ordinary scope not yet applied. */
  get scopeMissing(): boolean {
    return this.code === 99991672;
  }
}

/**
 * Extract the real Feishu error code from a rejected request. The SDK surfaces
 * a non-2xx as a bare "status code 400"; the actual code/msg live in the
 * response body, so dig them out before classifying.
 */
export function asVcApiError(error: unknown, endpoint: string): VcApiError {
  if (error instanceof VcApiError) {
    return error;
  }
  const body = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (body && typeof body === "object") {
    const record = body as { code?: unknown; msg?: unknown };
    const code = typeof record.code === "number" ? record.code : undefined;
    const msg = typeof record.msg === "string" ? record.msg : undefined;
    return new VcApiError(code, msg, endpoint);
  }
  return new VcApiError(undefined, error instanceof Error ? error.message : String(error), endpoint);
}

export interface JoinMeetingResult {
  /** The long meeting id required by every subsequent bot call (NOT the 9-digit no.). */
  meetingId: string;
}

/** POST /vc/v1/bots/join — join by 9-digit meeting number (+ optional password). */
export async function joinMeeting(
  client: LarkVcRequestClient,
  meetingNo: string,
  password?: string,
): Promise<JoinMeetingResult> {
  if (!isMeetingNo(meetingNo)) {
    throw new VcApiError(undefined, `meeting number must be 9 digits, got "${meetingNo}"`, "join");
  }
  try {
    const res = await client.request<{ data?: { meeting?: { id?: string } } }>({
      method: "POST",
      url: `${BASE}/join`,
      data: {
        join_type: 1, // fixed by protocol
        join_identify: { meeting_no: meetingNo, ...(password ? { password } : {}) },
      },
    });
    const meetingId = res?.data?.meeting?.id;
    if (!meetingId) {
      throw new VcApiError(undefined, "join succeeded but returned no meeting id", "join");
    }
    return { meetingId };
  } catch (error) {
    throw asVcApiError(error, "join");
  }
}

/** POST /vc/v1/bots/leave — leave by long meeting id. Idempotent at the call site. */
export async function leaveMeeting(client: LarkVcRequestClient, meetingId: string): Promise<void> {
  try {
    await client.request({ method: "POST", url: `${BASE}/leave`, data: { meeting_id: meetingId } });
  } catch (error) {
    throw asVcApiError(error, "leave");
  }
}

/** POST /vc/v1/bots/message — post a text message (弹幕) into the meeting. */
export async function sendMeetingText(
  client: LarkVcRequestClient,
  meetingId: string,
  content: string,
): Promise<void> {
  try {
    await client.request({
      method: "POST",
      url: `${BASE}/message`,
      data: { meeting_id: meetingId, msg_type: "text", content },
    });
  } catch (error) {
    throw asVcApiError(error, "message");
  }
}

export interface PullMeetingEventsResult {
  /** Raw activity items; field name drifts across API revisions, so both are accepted. */
  items: unknown[];
  pageToken?: string;
  hasMore: boolean;
}

/**
 * GET /vc/v1/bots/events — poll in-meeting activity (primary lane until push
 * arrives, then gap-fill). The SDK drops GET bodies, so query args MUST go in
 * `params`; the events field is `events` on some revisions and
 * `meeting_activity_items` on others.
 */
export async function pullMeetingEvents(
  client: LarkVcRequestClient,
  meetingId: string,
  pageToken?: string,
  pageSize = 100,
): Promise<PullMeetingEventsResult> {
  try {
    const res = await client.request<{
      data?: {
        events?: unknown[];
        meeting_activity_items?: unknown[];
        page_token?: string;
        has_more?: boolean;
      };
    }>({
      method: "GET",
      url: `${BASE}/events`,
      params: {
        meeting_id: meetingId,
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const data = res?.data ?? {};
    return {
      items: data.events ?? data.meeting_activity_items ?? [],
      ...(typeof data.page_token === "string" ? { pageToken: data.page_token } : {}),
      hasMore: data.has_more === true,
    };
  } catch (error) {
    throw asVcApiError(error, "events");
  }
}
