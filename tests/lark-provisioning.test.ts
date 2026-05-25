import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_LARK_CALLBACKS,
  REQUIRED_LARK_EVENTS,
  REQUIRED_LARK_SCOPES,
  formatLarkProvisioningResult,
  formatLarkTenantScopeImportJson,
  inspectLarkAppProvisioning,
  provisionLarkApp,
  type LarkProvisioningClient,
} from "../src/lark/provisioning.js";

describe("provisionLarkApp", () => {
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

  it("reports required scopes that are not present in the app configuration", async () => {
    const scopes = grantAllRequiredScopes().filter((scope) => scope.scope_name !== "im:resource");
    const client = createProvisioningClientMock({
      scopes,
      apps: [
        appProvisioning({
          callbacks: [...REQUIRED_LARK_CALLBACKS],
          events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"],
        }),
      ],
    });

    const result = await provisionLarkApp({ appId: "cli_app", appSecret: "secret", client });

    expect(client.application.scope.apply).not.toHaveBeenCalled();
    expect(client.application.application.patch).not.toHaveBeenCalled();
    expect(result.missingScopes).toEqual(["im:resource"]);
    expect(formatLarkProvisioningResult(result).join("\n")).toContain("Scopes not present in app config: im:resource");
  });

  it("explains that group-all mode needs the ordinary group message scope", async () => {
    const scopes = grantAllRequiredScopes().filter((scope) => scope.scope_name !== "im:message.group_msg");
    const client = createProvisioningClientMock({
      scopes,
      apps: [
        appProvisioning({
          callbacks: [...REQUIRED_LARK_CALLBACKS],
          events: [...REQUIRED_LARK_EVENTS, "drive.notice.comment_add_v1"],
        }),
      ],
    });

    const result = await inspectLarkAppProvisioning({ appId: "cli_app", appSecret: "secret", client });
    const formatted = formatLarkProvisioningResult(result).join("\n");

    expect(result.missingScopes).toEqual(["im:message.group_msg"]);
    expect(formatted).toContain("Lark /group all requires im:message.group_msg");
    expect(formatted).toContain("ordinary group messages may not reach the bot");
    expect(formatted).toContain("not part of the PersonalAgent QR wizard default");
    expect(formatted).toContain("add or bulk-import im:message.group_msg");
    expect(formatted).toContain('Bulk import missing tenant scopes JSON: {"scopes":{"tenant":["im:message.group_msg"]}}');
    expect(formatted).toContain("node dist/src/index.js lark permissions --missing");
    expect(formatted).toContain("then rerun lark provision and lark doctor");
    expect(formatted).not.toContain("recreate the app with the QR wizard");
  });

  it("includes the bot-mention group scope for Lark agent-to-agent workflows", () => {
    expect(REQUIRED_LARK_SCOPES).toContain("im:message.group_at_msg.include_bot:readonly");
    expect(formatLarkTenantScopeImportJson(REQUIRED_LARK_SCOPES)).toContain("im:message.group_at_msg.include_bot:readonly");
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
