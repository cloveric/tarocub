import { Client, Domain } from "@larksuiteoapi/node-sdk";

import { redactLarkSensitiveText } from "./redaction.js";

// Core scopes for a working chat bot: receive/send messages, interactive cards,
// and basic Docs. Verified (2026-05-30) to be AUTO-GRANTED by Feishu's
// PersonalAgent QR registration, so a fresh scan needs ZERO manual console work.
// These block service start if somehow missing.
export const REQUIRED_LARK_SCOPES = [
  "im:chat:create",
  "im:message.group_at_msg.include_bot:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.p2p_msg:readonly",
  "im:message.reactions:write_only",
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:resource",
  "cardkit:card:read",
  "cardkit:card:write",
  "docx:document:create",
  "docx:document:readonly",
  "docx:document:write_only",
  "drive:drive.metadata:readonly",
  "docs:document.comment:read",
  "docs:document.comment:create",
] as const;

// Advanced scopes that the PersonalAgent QR registration does NOT auto-grant.
// They power opt-in features (ordinary group messages, Sheets, doc permission
// granting, full chat management). Surfaced as optional — they do NOT block
// setup; add them in the console only when you enable those features.
export const OPTIONAL_LARK_SCOPES = [
  "im:message",
  "im:message.group_msg",
  "im:chat",
  "im:chat.members:read",
  "docs:permission.member:create",
  "sheets:spreadsheet:create",
  "sheets:spreadsheet:read",
  "sheets:spreadsheet:write_only",
  "sheets:spreadsheet.meta:read",
] as const;

export const REQUIRED_LARK_USER_SCOPES = [
  "im:chat:create_by_user",
] as const;

export const REQUIRED_LARK_CALLBACKS = [
  "card.action.trigger",
] as const;

export const REQUIRED_LARK_EVENTS = [
  "im.message.receive_v1",
] as const;

export const OPTIONAL_LARK_EVENTS = [
  "drive.notice.comment_add_v1",
] as const;

export const LARK_APP_SUBSCRIPTION_PATCH_SCOPES = [
  "application:application",
  "admin:app.category:update",
] as const;

export interface LarkProvisioningLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface LarkProvisioningResult {
  grantedScopes: string[];
  missingScopes: string[];
  unauthorizedScopes: string[];
  /** Advanced scopes (OPTIONAL_LARK_SCOPES) not configured/granted — non-blocking. */
  missingOptionalScopes: string[];
  subscribedCallbacks: string[];
  missingCallbacks: string[];
  subscribedEvents: string[];
  missingEvents: string[];
  missingOptionalEvents: string[];
  canPatchSubscriptions: boolean;
  subscriptionPatchScopeOptions: string[];
  applied: boolean;
  patchedSubscriptions: boolean;
}

export async function provisionLarkApp(input: {
  appId: string;
  appSecret: string;
  domain?: string;
  logger?: LarkProvisioningLogger;
  client?: LarkProvisioningClient;
}): Promise<LarkProvisioningResult> {
  const client = input.client ?? createProvisioningClient(input);
  const before = await readLarkAppProvisioning(client, input.appId);
  let applied = false;
  let patchedSubscriptions = false;

  if (before.unauthorizedScopes.length > 0) {
    input.logger?.log(`Requesting Lark admin approval for ${before.unauthorizedScopes.length} unauthorized scope(s).`);
    const applyResult = await withLarkProvisioningTimeout(client.application.scope.apply());
    if (applyResult.code !== 0 && applyResult.code !== 212002 && applyResult.code !== 212004) {
      throw new Error(`Lark scope apply failed: ${applyResult.code ?? "unknown"} ${applyResult.msg ?? ""}`.trim());
    }
    applied = applyResult.code === 0 || applyResult.code === 212004;
  }

  // Feishu gates subscription PATCH behind app-management scopes. Without
  // one of those scopes we report the gap instead of producing a noisy 400.
  if (
    before.canPatchSubscriptions &&
    (before.missingCallbacks.length > 0 || before.missingEvents.length > 0 || before.missingOptionalEvents.length > 0)
  ) {
    await patchLarkAppSubscriptions(client, input.appId, before);
    patchedSubscriptions = true;
  }

  const after = await readLarkAppProvisioning(client, input.appId);
  return {
    ...(patchedSubscriptions ? assumePatchedSubscriptionsVisible(after, before) : after),
    applied,
    patchedSubscriptions,
  };
}

export async function inspectLarkAppProvisioning(input: {
  appId: string;
  appSecret: string;
  domain?: string;
  client?: LarkProvisioningClient;
}): Promise<LarkProvisioningResult> {
  const client = input.client ?? createProvisioningClient(input);
  const inspected = await readLarkAppProvisioning(client, input.appId);
  return {
    ...inspected,
    applied: false,
  };
}

export function formatLarkProvisioningResult(
  result: LarkProvisioningResult,
  options: { appId?: string; domain?: string } = {},
): string[] {
  const lines = [
    `Lark required scopes: ${result.missingScopes.length === 0 && result.unauthorizedScopes.length === 0 ? "ok" : "attention needed"}`,
    `Lark message event: ${result.missingEvents.length === 0 ? "ok" : "missing " + result.missingEvents.join(", ")}`,
    `Lark card callback: ${result.missingCallbacks.length === 0 ? "ok" : "missing " + result.missingCallbacks.join(", ")}`,
    `Lark doc-comment event: ${result.missingOptionalEvents.length === 0 ? "ok" : "missing " + result.missingOptionalEvents.join(", ")}`,
  ];
  if (result.applied) {
    lines.push("Lark scope approval request submitted; tenant admin approval may still be required.");
  }
  if (result.patchedSubscriptions) {
    lines.push("Lark websocket event/callback subscriptions updated.");
  }
  if (!result.canPatchSubscriptions && (result.missingCallbacks.length > 0 || result.missingEvents.length > 0 || result.missingOptionalEvents.length > 0)) {
    lines.push(`Cannot auto-patch Lark event/callback subscriptions; grant one app-management scope first: ${result.subscriptionPatchScopeOptions.join(" or ")}`);
  }
  if (result.unauthorizedScopes.length > 0) {
    lines.push(`Unauthorized scopes: ${result.unauthorizedScopes.join(", ")}`);
  }
  if (result.missingScopes.length > 0) {
    // Core scopes are normally auto-granted by the PersonalAgent QR registration,
    // so this should be rare; if it happens, it blocks the bot and needs fixing.
    lines.push(`Core scopes not present in app config: ${result.missingScopes.join(", ")}`);
    if (options.appId) {
      lines.push(`Permissions page: ${formatLarkPermissionConsoleUrl(options.appId, options.domain)}`);
    }
    lines.push(`Bulk import missing scopes JSON: ${formatLarkScopeImportJson(result.missingScopes)}`);
    lines.push("Run `node dist/src/index.js lark permissions --missing` to reprint only the currently missing scopes.");
    lines.push(...formatLarkScopeImportNextSteps(result.missingScopes, options));
  }
  if (result.missingOptionalScopes.length > 0) {
    // Advanced, opt-in scopes the QR registration does NOT auto-grant. They are
    // not required to run; surface them with a stable "Optional — " prefix so
    // doctor renders them as info (never a blocking warning).
    const optional: string[] = [
      `scopes (advanced features, not required to run): ${result.missingOptionalScopes.join(", ")}`,
    ];
    if (options.appId) {
      optional.push(`permissions page (only if you want these): ${formatLarkPermissionConsoleUrl(options.appId, options.domain)}`);
    }
    optional.push(`bulk-import JSON (only if you want these): ${formatLarkScopeImportJson(result.missingOptionalScopes)}`);
    if (result.missingOptionalScopes.includes("im:message.group_msg")) {
      optional.push("to receive ordinary (non-@) group messages (/group all), add im:message.group_msg, publish the app version, then rerun lark provision.");
    }
    if (result.missingOptionalScopes.includes("im:message") || result.missingOptionalScopes.includes("im:chat")) {
      optional.push("for broad group-message delivery and full chat management, add im:message and im:chat.");
    }
    if (result.missingOptionalScopes.includes("im:chat.members:read")) {
      optional.push("to resolve @name mentions to native at-tags in groups, add im:chat.members:read.");
    }
    if (result.missingOptionalScopes.includes("docs:permission.member:create")) {
      optional.push("to let created docs auto-grant back to the requester (instead of a Permission denied warning), add docs:permission.member:create.");
    }
    if (result.missingOptionalScopes.some((scope) => scope.startsWith("sheets:"))) {
      optional.push("to enable Feishu Sheets workflows, add the sheets:spreadsheet:* scopes; for user-backed Sheets also run `node dist/src/index.js lark auth start --scope \"sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read\"`.");
    }
    lines.push(...optional.map((line) => `Optional — ${line}`));
  }
  return lines;
}

export function formatLarkPermissionConsoleUrl(appId: string, domain?: string): string {
  const host = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  return `${host}/app/${encodeURIComponent(appId)}/auth`;
}

export function formatLarkTenantScopeImportJson(scopes: readonly string[]): string {
  return JSON.stringify({ scopes: { tenant: [...scopes] } });
}

export function formatLarkScopeImportJson(scopes: readonly string[]): string {
  const userScopeSet = new Set<string>(REQUIRED_LARK_USER_SCOPES);
  const tenant = scopes.filter((scope) => !userScopeSet.has(scope));
  const user = scopes.filter((scope) => userScopeSet.has(scope));
  return JSON.stringify({
    scopes: {
      ...(tenant.length > 0 ? { tenant } : {}),
      ...(user.length > 0 ? { user } : {}),
    },
  });
}

export function formatLarkScopeImportNextSteps(
  scopes: readonly string[],
  options: { appId?: string; domain?: string } = {},
): string[] {
  if (scopes.length === 0) {
    return [];
  }
  const lines = [
    "Next permission steps:",
    options.appId
      ? `1. Open app permissions page: ${formatLarkPermissionConsoleUrl(options.appId, options.domain)}`
      : "1. Open Feishu/Lark Developer Console -> your app -> Permissions -> bulk import/open.",
    `2. Paste this JSON: ${formatLarkScopeImportJson(scopes)}`,
    "3. Publish the app version and wait for tenant/admin approval if Feishu asks for it.",
    "4. Rerun `node dist/src/index.js lark provision`, then rerun `node dist/src/index.js lark doctor`.",
  ];
  if (scopes.includes("im:chat") || scopes.includes("im:chat:create")) {
    lines.push("5. Smoke test `/newgroup CCTB smoke test` in Lark if chat-creation scopes were missing.");
  }
  return lines;
}

async function readLarkAppProvisioning(client: LarkProvisioningClient, appId: string): Promise<Omit<LarkProvisioningResult, "applied">> {
  const [scopeResult, appResult] = await Promise.all([
    callLarkProvisioningApi(() => client.application.scope.list(), "Lark scope list"),
    callLarkProvisioningApi(() => client.application.application.get({
      params: { lang: "zh_cn", user_id_type: "open_id" },
      path: { app_id: appId },
    }), "Lark app get"),
  ]);
  if (scopeResult.code !== 0) {
    throw new Error(`Lark scope list failed: ${scopeResult.code ?? "unknown"} ${scopeResult.msg ?? ""}`.trim());
  }
  if (appResult.code !== 0) {
    throw new Error(`Lark app get failed: ${appResult.code ?? "unknown"} ${appResult.msg ?? ""}`.trim());
  }

  const scopes = scopeResult.data?.scopes ?? [];
  const scopeStatus = new Map(scopes.map((scope) => [scope.scope_name, scope.grant_status]));
  const grantedScopes = scopes
    .filter((scope) => scope.grant_status === 1)
    .map((scope) => scope.scope_name)
    .sort();
  const missingScopes = REQUIRED_LARK_SCOPES.filter((scope) => !scopeStatus.has(scope));
  const unauthorizedScopes = REQUIRED_LARK_SCOPES.filter((scope) => scopeStatus.has(scope) && scopeStatus.get(scope) !== 1);
  const missingOptionalScopes = OPTIONAL_LARK_SCOPES.filter((scope) => scopeStatus.get(scope) !== 1);
  const canPatchSubscriptions = LARK_APP_SUBSCRIPTION_PATCH_SCOPES.some((scope) => scopeStatus.get(scope) === 1);
  const app = appResult.data?.app;
  const subscribedCallbacks = app?.callback_info?.subscribed_callbacks ?? app?.callback?.subscribed_callbacks ?? [];
  const subscribedEvents = app?.event?.subscribed_events
    ?? await readLarkAppVersionSubscribedEvents(client, appId, app?.online_version_id)
    ?? [];

  return {
    grantedScopes,
    missingScopes,
    unauthorizedScopes,
    missingOptionalScopes,
    subscribedCallbacks,
    missingCallbacks: REQUIRED_LARK_CALLBACKS.filter((callback) => !subscribedCallbacks.includes(callback)),
    subscribedEvents,
    missingEvents: REQUIRED_LARK_EVENTS.filter((event) => !subscribedEvents.includes(event)),
    missingOptionalEvents: OPTIONAL_LARK_EVENTS.filter((event) => !subscribedEvents.includes(event)),
    canPatchSubscriptions,
    subscriptionPatchScopeOptions: [...LARK_APP_SUBSCRIPTION_PATCH_SCOPES],
    patchedSubscriptions: false,
  };
}

async function readLarkAppVersionSubscribedEvents(
  client: LarkProvisioningClient,
  appId: string,
  versionId: string | undefined,
): Promise<string[] | undefined> {
  if (!versionId || !client.application.applicationAppVersion?.get) {
    return undefined;
  }
  const versionResult = await callLarkProvisioningApi(() => client.application.applicationAppVersion!.get({
    params: { lang: "zh_cn", user_id_type: "open_id" },
    path: { app_id: appId, version_id: versionId },
  }), "Lark app version get");
  if (versionResult.code !== 0) {
    throw new Error(`Lark app version get failed: ${versionResult.code ?? "unknown"} ${versionResult.msg ?? ""}`.trim());
  }
  const eventTypes = versionResult.data?.app_version?.event_infos
    ?.map((event) => event.event_type)
    .filter((event): event is string => Boolean(event));
  return eventTypes ? uniqueSorted(eventTypes) : undefined;
}

async function patchLarkAppSubscriptions(
  client: LarkProvisioningClient,
  appId: string,
  current: Omit<LarkProvisioningResult, "applied">,
): Promise<void> {
  const shouldPatchCallbacks = current.missingCallbacks.length > 0;
  const shouldPatchEvents = current.missingEvents.length > 0 || current.missingOptionalEvents.length > 0;
  const patchResult = await callLarkProvisioningApi(() => client.application.application.patch({
    params: { lang: "zh_cn" },
    path: { app_id: appId },
    data: {
      ...(shouldPatchCallbacks
        ? {
            callback_info: {
              callback_type: "websocket",
              subscribed_callbacks: uniqueSorted([...current.subscribedCallbacks, ...REQUIRED_LARK_CALLBACKS]),
            },
          }
        : {}),
      ...(shouldPatchEvents
        ? {
            event: {
              subscription_type: "websocket",
              subscribed_events: uniqueSorted([...current.subscribedEvents, ...REQUIRED_LARK_EVENTS, ...OPTIONAL_LARK_EVENTS]),
            },
          }
        : {}),
    },
  }), "Lark app subscription patch");
  if (patchResult.code !== 0) {
    throw new Error(`Lark app subscription patch failed: ${patchResult.code ?? "unknown"} ${patchResult.msg ?? ""}`.trim());
  }
}

function assumePatchedSubscriptionsVisible(
  inspected: Omit<LarkProvisioningResult, "applied">,
  before: Omit<LarkProvisioningResult, "applied">,
): Omit<LarkProvisioningResult, "applied"> {
  const subscribedCallbacks = before.missingCallbacks.length > 0
    ? uniqueSorted([...inspected.subscribedCallbacks, ...before.subscribedCallbacks, ...REQUIRED_LARK_CALLBACKS])
    : inspected.subscribedCallbacks;
  const subscribedEvents = before.missingEvents.length > 0 || before.missingOptionalEvents.length > 0
    ? uniqueSorted([...inspected.subscribedEvents, ...before.subscribedEvents, ...REQUIRED_LARK_EVENTS, ...OPTIONAL_LARK_EVENTS])
    : inspected.subscribedEvents;
  return {
    ...inspected,
    subscribedCallbacks,
    missingCallbacks: REQUIRED_LARK_CALLBACKS.filter((callback) => !subscribedCallbacks.includes(callback)),
    subscribedEvents,
    missingEvents: REQUIRED_LARK_EVENTS.filter((event) => !subscribedEvents.includes(event)),
    missingOptionalEvents: OPTIONAL_LARK_EVENTS.filter((event) => !subscribedEvents.includes(event)),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The Lark SDK's default axios instance has no socket timeout, so a stalled
 * network leaves provisioning/doctor hanging forever with no output. Bound every
 * call so setup fails fast with an actionable message instead of appearing stuck.
 */
const PROVISIONING_API_TIMEOUT_MS = 20_000;

export async function withLarkProvisioningTimeout<T>(promise: Promise<T>, timeoutMs = PROVISIONING_API_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s (Feishu API unreachable — check your network/VPN and retry)`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function callLarkProvisioningApi<T extends { code?: number; msg?: string }>(call: () => Promise<T>, label: string): Promise<T> {
  try {
    return await withLarkProvisioningTimeout(call());
  } catch (error) {
    throw new Error(`${label} failed: ${describeLarkProvisioningError(error)}`);
  }
}

function describeLarkProvisioningError(error: unknown): string {
  const responseData = extractResponseData(error);
  const code = responseData?.code;
  const message = responseData?.msg ?? responseData?.message ?? (error instanceof Error ? error.message : String(error));
  const compact = String(message).replace(/\s+/g, " ").trim();
  return `${code !== undefined ? `${code} ` : ""}${redactLarkSensitiveText(compact)}`.trim();
}

function extractResponseData(error: unknown): { code?: unknown; msg?: unknown; message?: unknown } | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }
  const response = (error as { response?: { data?: unknown } }).response;
  return typeof response?.data === "object" && response.data !== null
    ? response.data as { code?: unknown; msg?: unknown; message?: unknown }
    : undefined;
}

function createProvisioningClient(input: { appId: string; appSecret: string; domain?: string }): LarkProvisioningClient {
  return new Client({
    appId: input.appId,
    appSecret: input.appSecret,
    ...(input.domain ? { domain: resolveProvisioningDomain(input.domain) } : {}),
    logger: silentLarkSdkLogger,
  }) as LarkProvisioningClient;
}

const silentLarkSdkLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function resolveProvisioningDomain(domain: string): Domain | string {
  const normalized = domain.trim().toLowerCase();
  if (normalized === "feishu") {
    return Domain.Feishu;
  }
  if (normalized === "lark") {
    return Domain.Lark;
  }
  return domain;
}

export interface LarkProvisioningClient {
  application: {
    scope: {
      list(): Promise<{
        code?: number;
        msg?: string;
        data?: {
          scopes?: Array<{
            scope_name: string;
            grant_status: number;
          }>;
        };
      }>;
      apply(): Promise<{
        code?: number;
        msg?: string;
      }>;
    };
    applicationAppVersion?: {
      get(payload: {
        params: {
          lang: "zh_cn" | "en_us" | "ja_jp";
          user_id_type?: "user_id" | "union_id" | "open_id";
        };
        path: {
          app_id: string;
          version_id: string;
        };
      }): Promise<{
        code?: number;
        msg?: string;
        data?: {
          app_version?: {
            event_infos?: Array<{
              event_type?: string;
            }>;
          };
        };
      }>;
    };
    application: {
      get(payload: {
        params: {
          lang: "zh_cn" | "en_us" | "ja_jp";
          user_id_type?: "user_id" | "union_id" | "open_id";
        };
        path: {
          app_id: string;
        };
      }): Promise<{
        code?: number;
        msg?: string;
        data?: {
          app?: {
            online_version_id?: string;
            callback?: {
              subscribed_callbacks?: string[];
            };
            callback_info?: {
              subscribed_callbacks?: string[];
            };
            event?: {
              subscribed_events?: string[];
            };
          };
        };
      }>;
      patch(payload: {
        data?: {
          event?: {
            subscription_type?: string;
            request_url?: string;
            subscribed_events?: string[];
          };
          callback_info?: {
            callback_type?: "webhook" | "websocket";
            request_url?: string;
            subscribed_callbacks?: string[];
          };
        };
        params: {
          lang: "zh_cn" | "en_us" | "ja_jp";
        };
        path: {
          app_id: string;
        };
      }): Promise<{
        code?: number;
        msg?: string;
      }>;
    };
  };
}
