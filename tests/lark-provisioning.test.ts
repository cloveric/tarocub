import { describe, expect, it, vi } from "vitest";

import {
  OPTIONAL_LARK_SCOPES,
  REQUIRED_LARK_CALLBACKS,
  REQUIRED_LARK_EVENTS,
  REQUIRED_LARK_SCOPES,
  formatLarkProvisioningResult,
  formatLarkScopeImportJson,
  formatLarkTenantScopeImportJson,
  inspectLarkAppProvisioning,
  provisionLarkApp,
  withLarkProvisioningTimeout,
  type LarkProvisioningClient,
} from "../src/lark/provisioning.js";

describe("withLarkProvisioningTimeout", () => {
  it("rejects a stalled Feishu call with an actionable message instead of hanging", async () => {
    const stalled = new Promise<never>(() => {}); // never settles (timeoutless SDK socket)
    await expect(withLarkProvisioningTimeout(stalled, 20)).rejects.toThrow(/timed out.*network/i);
  });

  it("passes a fast call straight through", async () => {
    await expect(withLarkProvisioningTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });
});

describe("provisionLarkApp", () => {
  it("wraps SDK tenant token failures with the provisioning API label", async () => {
    const client = {
      application: {
        scope: {
          list: vi.fn(async () => {
            throw new TypeError("Cannot destructure property 'tenant_access_token' of '(intermediate value)' as it is undefined.");
          }),
          apply: vi.fn(async () => ({ code: 0 })),
        },
        application: {
          get: vi.fn(async () => ({
            code: 0,
            data: { app: {} },
          })),
          patch: vi.fn(async () => ({ code: 0 })),
        },
      },
    } as unknown as LarkProvisioningClient;

    await expect(inspectLarkAppProvisioning({ appId: "cli_app", appSecret: "secret", client })).rejects.toThrow(
      "Lark scope list failed: Cannot destructure property 'tenant_access_token'",
    );
  });

  it("inspects app surface without applying scopes or patching subscriptions", async () => {
    const client = createProvisioningClientMock({
      scopes: grantAllRequiredScopes(),
      apps: [
        appProvisioning({ callbacks: [], events: [] }),
      ],
    });

    const result = await inspectLarkAppProvisioning({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.scope.apply).not.toHaveBeenCalled();
    expect(client.application.application.patch).not.toHaveBeenCalled();
    expect(result.missingCallbacks).toEqual(["card.action.trigger"]);
    expect(result.missingEvents).toEqual(["im.message.receive_v1"]);
    expect(result.applied).toBe(false);
    expect(result.patchedSubscriptions).toBe(false);
  });

  it("reads websocket event subscriptions from the online app version when app get omits them", async () => {
    const client = {
      application: {
        scope: {
          list: vi.fn(async () => ({
            code: 0,
            data: {
              scopes: grantAllRequiredScopes(),
            },
          })),
          apply: vi.fn(async () => ({ code: 0 })),
        },
        application: {
          get: vi.fn(async () => ({
            code: 0,
            data: {
              app: {
                online_version_id: "oav_online",
                callback_info: {
                  callback_type: "websocket",
                  subscribed_callbacks: ["card.action.trigger"],
                },
              },
            },
          })),
          patch: vi.fn(async () => ({ code: 0 })),
        },
        applicationAppVersion: {
          get: vi.fn(async () => ({
            code: 0,
            data: {
              app_version: {
                event_infos: [
                  { event_type: "im.message.receive_v1" },
                  { event_type: "drive.notice.comment_add_v1" },
                ],
              },
            },
          })),
        },
      },
    } as unknown as LarkProvisioningClient;

    const result = await inspectLarkAppProvisioning({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.applicationAppVersion!.get).toHaveBeenCalledWith({
      params: { lang: "zh_cn", user_id_type: "open_id" },
      path: { app_id: "cli_app", version_id: "oav_online" },
    });
    expect(result.missingEvents).toEqual([]);
    expect(result.missingOptionalEvents).toEqual([]);
    expect(result.subscribedEvents).toEqual(["drive.notice.comment_add_v1", "im.message.receive_v1"]);
  });

  it("patches websocket message events and card callbacks after QR registration", async () => {
    const client = createProvisioningClientMock({
      scopes: [...grantAllRequiredScopes(), { scope_name: "application:application", grant_status: 1 }],
      apps: [
        appProvisioning({ callbacks: [], events: [] }),
        appProvisioning({
          callbacks: [...REQUIRED_LARK_CALLBACKS],
          events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"],
        }),
      ],
    });

    const result = await provisionLarkApp({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.application.patch).toHaveBeenCalledWith({
      params: { lang: "zh_cn" },
      path: { app_id: "cli_app" },
      data: {
        callback_info: {
          callback_type: "websocket",
          subscribed_callbacks: ["card.action.trigger"],
        },
        event: {
          subscription_type: "websocket",
          subscribed_events: ["drive.notice.comment_add_v1", "im.message.receive_v1"],
        },
      },
    });
    expect(result.missingCallbacks).toEqual([]);
    expect(result.missingEvents).toEqual([]);
    expect(result.missingOptionalEvents).toEqual([]);
    expect(result.patchedSubscriptions).toBe(true);
    expect(formatLarkProvisioningResult(result).join("\n")).toContain("Lark doc-comment event: ok");
  });

  it("trusts a successful subscription patch when app get omits event subscriptions", async () => {
    const client = createProvisioningClientMock({
      scopes: [...grantAllRequiredScopes(), { scope_name: "application:application", grant_status: 1 }],
      apps: [
        appProvisioning({ callbacks: [], events: [] }),
        appProvisioningWithoutEvents({ callbacks: [...REQUIRED_LARK_CALLBACKS] }),
      ],
    });

    const result = await provisionLarkApp({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.application.patch).toHaveBeenCalledTimes(1);
    expect(result.missingCallbacks).toEqual([]);
    expect(result.missingEvents).toEqual([]);
    expect(result.missingOptionalEvents).toEqual([]);
    expect(result.subscribedEvents).toEqual(["drive.notice.comment_add_v1", "im.message.receive_v1"]);
  });

  it("reports missing event subscriptions without patching when app management scope is unavailable", async () => {
    const client = createProvisioningClientMock({
      scopes: grantAllRequiredScopes(),
      apps: [
        appProvisioning({
          callbacks: [...REQUIRED_LARK_CALLBACKS],
          events: [],
        }),
      ],
    });

    const result = await provisionLarkApp({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.application.patch).not.toHaveBeenCalled();
    expect(result.missingEvents).toEqual(["im.message.receive_v1"]);
    expect(result.canPatchSubscriptions).toBe(false);
    expect(formatLarkProvisioningResult(result).join("\n")).toContain("grant one app-management scope first");
  });

  it("redacts provider error details when subscription patching fails", async () => {
    const client = createProvisioningClientMock({
      scopes: [...grantAllRequiredScopes(), { scope_name: "application:application", grant_status: 1 }],
      apps: [
        appProvisioning({ callbacks: [], events: [] }),
      ],
    });
    vi.mocked(client.application.application.patch).mockRejectedValueOnce({
      response: {
        data: {
          code: 99991672,
          msg: 'Access denied with Authorization: Bearer secret-token, app_secret=secret-personal, LARK_APP_SECRET=env-secret, "client_secret":"json-secret", access_token: token-secret',
        },
      },
    });

    await expect(provisionLarkApp({ appId: "cli_app", appSecret: "secret-personal", client }))
      .rejects.toThrow('99991672 Access denied with Authorization: Bearer [redacted], app_secret=[redacted], LARK_APP_SECRET=[redacted], "client_secret":"[redacted]", access_token: [redacted]');
  });

  it("requests admin approval for configured but unauthorized required scopes", async () => {
    const client = createProvisioningClientMock({
      scopes: grantAllRequiredScopes({ "im:resource": 2 }),
      apps: [
        appProvisioning({
          callbacks: [...REQUIRED_LARK_CALLBACKS],
          events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"],
        }),
        appProvisioning({
          callbacks: [...REQUIRED_LARK_CALLBACKS],
          events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"],
        }),
      ],
    });

    const result = await provisionLarkApp({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.scope.apply).toHaveBeenCalledTimes(1);
    expect(result.unauthorizedScopes).toEqual(["im:resource"]);
    expect(result.applied).toBe(true);
  });

  it("treats auto-granted core scopes as required-ok and advanced ones as optional (non-blocking)", async () => {
    // grantAllRequiredScopes grants exactly the core set Feishu auto-grants on
    // QR registration; the advanced scopes are not configured, so they land in
    // missingOptionalScopes and never block.
    const client = createProvisioningClientMock({
      scopes: grantAllRequiredScopes(),
      apps: [appProvisioning({ callbacks: [...REQUIRED_LARK_CALLBACKS], events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"] })],
    });

    const result = await inspectLarkAppProvisioning({ appId: "cli_app", appSecret: "secret", client });
    const formatted = formatLarkProvisioningResult(result).join("\n");

    expect(result.missingScopes).toEqual([]);
    expect(result.unauthorizedScopes).toEqual([]);
    expect(result.missingOptionalScopes).toEqual([...OPTIONAL_LARK_SCOPES]);
    expect(formatted).toContain("Lark required scopes: ok");
    expect(formatted).toContain("Optional — advanced features below are opt-in (none are auto-granted by the QR registration)");
  });

  it("reports a missing CORE scope as blocking", async () => {
    const scopes = grantAllRequiredScopes().filter((scope) => scope.scope_name !== "im:resource");
    const client = createProvisioningClientMock({
      scopes,
      apps: [appProvisioning({ callbacks: [...REQUIRED_LARK_CALLBACKS], events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"] })],
    });

    const result = await provisionLarkApp({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.scope.apply).not.toHaveBeenCalled();
    expect(result.missingScopes).toEqual(["im:resource"]);
    expect(formatLarkProvisioningResult(result).join("\n")).toContain("Core scopes not present in app config: im:resource");
  });

  it("surfaces advanced scopes as optional, grouped by feature, each with import JSON and a console link", async () => {
    const client = createProvisioningClientMock({
      scopes: grantAllRequiredScopes(),
      apps: [appProvisioning({ callbacks: [...REQUIRED_LARK_CALLBACKS], events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"] })],
    });

    const result = await inspectLarkAppProvisioning({ appId: "cli_app", appSecret: "secret", client });
    const formatted = formatLarkProvisioningResult(result, { appId: "cli_app" }).join("\n");

    expect(result.missingScopes).toEqual([]);
    expect(result.missingOptionalScopes).toContain("im:message.group_msg");
    expect(result.missingOptionalScopes).toContain("sheets:spreadsheet:create");
    expect(result.missingOptionalScopes).toContain("docs:permission.member:create");
    // Surfaced as optional (info) — never blocking. Stable "Optional — " prefix.
    expect(formatted).toContain("Optional — advanced features below are opt-in (none are auto-granted by the QR registration)");
    expect(formatted).toContain("Optional — permissions page (for any group above): https://open.feishu.cn/app/cli_app/auth");
    // One grouped line per feature family, each carrying its own import JSON.
    expect(formatted).toContain("Optional — ordinary (non-@) group messages — /group all:");
    expect(formatted).toContain("Optional — Feishu Sheets (spreadsheets):");
    expect(formatted).toContain("Optional — Calendar (events + free/busy):");
    expect(formatted).toContain("im:message.group_msg");
    expect(formatted).toContain("sheets:spreadsheet:create");
    // A fresh app's core scopes are still "ok".
    expect(formatted).toContain("Lark required scopes: ok");
  });

  it("keeps auto-granted scopes in REQUIRED (core) and advanced ones in OPTIONAL, disjoint", () => {
    for (const scope of [
      "im:chat:create", "im:message:send_as_bot", "im:message:readonly", "im:message.reactions:write_only",
      "im:resource", "cardkit:card:read", "cardkit:card:write", "docx:document:create",
      "docs:document.comment:create", "drive:drive.metadata:readonly",
    ]) {
      expect(REQUIRED_LARK_SCOPES).toContain(scope);
    }
    for (const scope of [
      "im:message", "im:message.group_msg", "im:chat", "im:chat.members:read",
      "docs:permission.member:create", "sheets:spreadsheet:create", "sheets:spreadsheet:read",
      "sheets:spreadsheet:write_only", "sheets:spreadsheet.meta:read",
    ]) {
      expect(OPTIONAL_LARK_SCOPES).toContain(scope);
      expect(REQUIRED_LARK_SCOPES).not.toContain(scope);
    }
    expect(REQUIRED_LARK_SCOPES.some((scope) => (OPTIONAL_LARK_SCOPES as readonly string[]).includes(scope))).toBe(false);
    expect(formatLarkScopeImportJson(OPTIONAL_LARK_SCOPES)).toContain("sheets:spreadsheet:create");
    expect(formatLarkScopeImportJson(OPTIONAL_LARK_SCOPES)).toContain("im:message.group_msg");
  });

  it("renders im:chat:create_by_user as a user-scope import instead of tenant-scope JSON", () => {
    expect(formatLarkScopeImportJson(["im:chat:create_by_user"])).toBe('{"scopes":{"user":["im:chat:create_by_user"]}}');
    expect(formatLarkTenantScopeImportJson(["im:chat:create_by_user"])).toBe('{"scopes":{"tenant":["im:chat:create_by_user"]}}');
  });
});

function createProvisioningClientMock(input: {
  scopes: Array<{ scope_name: string; grant_status: number }>;
  apps: Array<{
    callback_info: { callback_type: "websocket"; subscribed_callbacks: string[] };
    event?: { subscription_type: "websocket"; subscribed_events: string[] };
  }>;
}): LarkProvisioningClient {
  const appResults = input.apps.map((app) => ({
    code: 0,
    data: { app },
  }));
  let appResultIndex = 0;
  return {
    application: {
      scope: {
        list: vi.fn(async () => ({
          code: 0,
          data: {
            scopes: input.scopes,
          },
        })),
        apply: vi.fn(async () => ({ code: 0 })),
      },
      application: {
        get: vi.fn(async () => appResults[Math.min(appResultIndex++, appResults.length - 1)] ?? { code: 0, data: { app: appProvisioning({ callbacks: [], events: [] }) } }),
        patch: vi.fn(async () => ({ code: 0 })),
      },
    },
  };
}

function grantAllRequiredScopes(overrides: Record<string, number> = {}): Array<{ scope_name: string; grant_status: number }> {
  return REQUIRED_LARK_SCOPES.map((scope) => ({
    scope_name: scope,
    grant_status: overrides[scope] ?? 1,
  }));
}

function appProvisioning(input: { callbacks: string[]; events: string[] }): {
  callback_info: { callback_type: "websocket"; subscribed_callbacks: string[] };
  event: { subscription_type: "websocket"; subscribed_events: string[] };
} {
  return {
    callback_info: {
      callback_type: "websocket",
      subscribed_callbacks: input.callbacks,
    },
    event: {
      subscription_type: "websocket",
      subscribed_events: input.events,
    },
  };
}

function appProvisioningWithoutEvents(input: { callbacks: string[] }): {
  callback_info: { callback_type: "websocket"; subscribed_callbacks: string[] };
} {
  return {
    callback_info: {
      callback_type: "websocket",
      subscribed_callbacks: input.callbacks,
    },
  };
}
