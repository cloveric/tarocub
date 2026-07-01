// Proactive scope-gap detection for `/group all`.
//
// Enabling non-`@` group listening (`/group all`) only works if the Feishu/Lark
// app was granted `im:message.group_msg`. Without it, Feishu's event gateway
// pushes only @-bot group messages, so listen-all silently has no effect — the
// exact pitfall a fresh install hits. Instead of enabling it optimistically and
// leaving the operator to discover the silence + run `lark doctor`, we check the
// granted scopes at the moment they run `/group all` and, if the scope is
// missing, append inline grant guidance to the command reply.
//
// The check is best-effort: if we can't determine the scope state (no creds, API
// failure, timeout) we return "unknown" and stay silent rather than nag.
import { formatLarkPermissionConsoleUrl, inspectLarkAppProvisioning } from "./provisioning.js";

/** Scope that lets the app receive group messages that do NOT @ the bot. */
export const GROUP_MSG_SCOPE = "im:message.group_msg";

export type GroupMsgScopeStatus = "ok" | "missing" | "unknown";

const DEFAULT_SCOPE_CHECK_TIMEOUT_MS = 5000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // If the timeout wins the race, `promise` may still reject later with nothing
  // awaiting it — swallow that late rejection so it isn't an unhandled rejection.
  promise.catch(() => {});
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("scope check timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether the app currently has `im:message.group_msg` granted.
 * Returns "unknown" (never throws) when creds are absent or the lookup fails —
 * callers treat "unknown" as "don't nag".
 */
export async function checkGroupMsgScope(input: {
  appId?: string;
  appSecret?: string;
  domain?: string;
  timeoutMs?: number;
}): Promise<GroupMsgScopeStatus> {
  const appId = (input.appId ?? "").trim();
  const appSecret = (input.appSecret ?? "").trim();
  if (!appId || !appSecret) return "unknown";
  try {
    const result = await withTimeout(
      inspectLarkAppProvisioning({ appId, appSecret, domain: input.domain }),
      input.timeoutMs ?? DEFAULT_SCOPE_CHECK_TIMEOUT_MS,
    );
    return result.grantedScopes.includes(GROUP_MSG_SCOPE) ? "ok" : "missing";
  } catch {
    return "unknown";
  }
}

/**
 * Inline guidance appended to a `/group all` reply when `im:message.group_msg`
 * is not granted. Explains why listen-all won't work yet and how to fix it.
 */
export function renderGroupMsgScopeWarning(
  locale: "en" | "zh",
  appId?: string,
  domain?: string,
  instanceName?: string,
): string {
  const consoleUrl = appId ? formatLarkPermissionConsoleUrl(appId, domain) : undefined;
  const restartCommand = instanceName?.trim()
    ? `node dist/src/index.js lark service restart --instance ${instanceName.trim()}`
    : "node dist/src/index.js lark service restart --all";
  if (locale === "en") {
    const lines = [
      `⚠️ But this app hasn't been granted \`${GROUP_MSG_SCOPE}\` yet — non-\`@\` group messages won't actually arrive, so this switch has no effect until you grant it.`,
      `Fix: Developer Console → Permissions & Scopes → add \`im:message.group_msg\` → grant it (personal-edition apps take effect instantly; enterprise apps must publish a version). Then restart this instance: \`${restartCommand}\`.`,
      "Recheck: `node dist/src/index.js lark doctor`.",
    ];
    if (consoleUrl) lines.push(`Console: ${consoleUrl}`);
    return lines.join("\n");
  }
  const lines = [
    `⚠️ 但当前应用还没有 \`${GROUP_MSG_SCOPE}\` 权限——非 \`@\` 群消息其实收不到,这一步现在不会真正生效。`,
    `补权限:开发者后台 → 权限管理 → 添加 \`im:message.group_msg\` → 授权(个人版点"申请开通"即时生效;企业版需发布版本)。然后重启当前实例:\`${restartCommand}\`。`,
    "复查:`node dist/src/index.js lark doctor`。",
  ];
  if (consoleUrl) lines.push(`控制台:${consoleUrl}`);
  return lines.join("\n");
}
