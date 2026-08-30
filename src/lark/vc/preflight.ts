// VC bot-in-meeting feasibility check. The feature is gated by a Feishu beta
// allowlist (灰度) on top of ordinary scopes, so before attempting a join we
// classify what is actually blocking us and give the operator an actionable
// next step instead of a raw error. Ported in spirit from zara's
// src/meeting/preflight.ts, minus the lark-cli shell-out (advisory only).

import { VcApiError } from "./vc-api.js";

/** Early-bird chat to request VC-bot beta access (from the lark-vc-agent skill). */
export const VC_MEETING_BETA_CHAT_URL =
  "https://go.larkoffice.com/join-chat/2f4nb0e1-fe00-4f67-bed7-25beaf533fbd";

/** App scopes the feature needs; granted independently (one does not imply the others). */
export const VC_MEETING_REQUIRED_SCOPES = [
  "vc:meeting.bot.join:write",
  "vc:meeting.bot.manage:write",
  "vc:meeting.message:write",
  "vc:meeting.meetingevent:read",
] as const;

const VC_MEETING_ENDPOINT_SCOPES: Readonly<Record<string, readonly string[]>> = {
  join: ["vc:meeting.bot.join:write"],
  leave: ["vc:meeting.bot.join:write"],
  invite: ["vc:meeting.bot.join:write"],
  end: ["vc:meeting.bot.manage:write"],
  message: ["vc:meeting.message:write"],
  events: ["vc:meeting.meetingevent:read"],
};

export type VcMeetingPreflight =
  | { status: "ok" }
  | { status: "not-in-beta"; betaChatUrl: string }
  | { status: "scope-missing"; missingScopes: string[]; consoleUrl?: string }
  | { status: "unknown"; detail: string };

/** Classify a VC API failure into an actionable preflight verdict. */
export function classifyVcMeetingError(error: unknown): VcMeetingPreflight {
  const vcError = error instanceof VcApiError ? error : undefined;
  if (vcError?.notInGray) {
    return { status: "not-in-beta", betaChatUrl: VC_MEETING_BETA_CHAT_URL };
  }
  if (vcError?.scopeMissing) {
    return {
      status: "scope-missing",
      missingScopes: [...(VC_MEETING_ENDPOINT_SCOPES[vcError.endpoint] ?? VC_MEETING_REQUIRED_SCOPES)],
    };
  }
  return {
    status: "unknown",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Human-facing explanation of a preflight verdict, for the /meeting status card. */
export function renderVcMeetingPreflight(preflight: VcMeetingPreflight, locale: "en" | "zh"): string {
  const zh = locale === "zh";
  switch (preflight.status) {
    case "ok":
      return zh ? "VC 入会权限就绪。" : "VC meeting access is ready.";
    case "not-in-beta":
      return zh
        ? `VC 机器人入会是飞书内测（灰度）功能，当前应用未开通。请加入早鸟群申请开通后再启用：${preflight.betaChatUrl}`
        : `Bot meeting attendance is a Feishu beta (allowlist) capability not yet enabled for this app. Request access via the early-bird chat, then enable it: ${preflight.betaChatUrl}`;
    case "scope-missing":
      return zh
        ? `缺少应用权限：${preflight.missingScopes.join("、")}。请在开发者后台开通后重试。`
        : `Missing app scopes: ${preflight.missingScopes.join(", ")}. Grant them in the developer console and retry.`;
    case "unknown":
      return zh
        ? `VC 入会检测未通过：${preflight.detail}`
        : `VC meeting preflight failed: ${preflight.detail}`;
  }
}
