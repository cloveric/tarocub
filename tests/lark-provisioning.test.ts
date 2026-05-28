import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_LARK_CALLBACKS,
  REQUIRED_LARK_EVENTS,
  REQUIRED_LARK_SCOPES,
  formatLarkProvisioningResult,
  formatLarkScopeImportJson,
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

  it("requires the base bot message scope used by Feishu for message receive and send", async () => {
    const scopes = grantAllRequiredScopes().filter((scope) => scope.scope_name !== "im:message");
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

    expect(result.missingScopes).toEqual(["im:message"]);
    expect(formatted).toContain("Scopes not present in app config: im:message");
    expect(formatted).toContain("Lark message receive/send needs the base im:message scope");
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
    expect(formatted).toContain('Bulk import missing scopes JSON: {"scopes":{"tenant":["im:message.group_msg"]}}');
    expect(formatted).toContain("node dist/src/index.js lark permissions --missing");
    expect(formatted).toContain("then rerun lark provision and lark doctor");
    expect(formatted).not.toContain("recreate the app with the QR wizard");
  });

  it("prints a direct app permission console link when app id is available", async () => {
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
    const formatted = formatLarkProvisioningResult(result, { appId: "cli_app" }).join("\n");

    expect(formatted).toContain("Permissions page: https://open.feishu.cn/app/cli_app/auth");
    expect(formatted).toContain('Bulk import missing scopes JSON: {"scopes":{"tenant":["im:message.group_msg"]}}');
  });

  it("explains that Lark running feedback reactions need reaction write scope", async () => {
    const scopes = grantAllRequiredScopes().filter((scope) => scope.scope_name !== "im:message.reactions:write_only");
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

    expect(result.missingScopes).toEqual(["im:message.reactions:write_only"]);
    expect(formatted).toContain("Lark running feedback reactions require im:message.reactions:write_only");
  });

  it("includes the bot-mention group scope for Lark agent-to-agent workflows", () => {
    expect(REQUIRED_LARK_SCOPES).toContain("im:message");
    expect(REQUIRED_LARK_SCOPES).toContain("im:message.group_at_msg.include_bot:readonly");
    expect(formatLarkTenantScopeImportJson(REQUIRED_LARK_SCOPES)).toContain("\"im:message\"");
    expect(formatLarkTenantScopeImportJson(REQUIRED_LARK_SCOPES)).toContain("im:message.group_at_msg.include_bot:readonly");
  });

  it("includes chat creation scopes for Lark /newgroup workflows", () => {
    expect(REQUIRED_LARK_SCOPES).toContain("im:chat");
    expect(REQUIRED_LARK_SCOPES).toContain("im:chat:create");
    expect(REQUIRED_LARK_SCOPES).not.toContain("im:chat:create_by_user");
    expect(formatLarkScopeImportJson(REQUIRED_LARK_SCOPES)).toContain('"tenant":["im:chat","im:chat:create"');
    expect(formatLarkScopeImportJson(REQUIRED_LARK_SCOPES)).not.toContain("im:chat:create_by_user");
  });

  it("includes reaction write scope for Lark running feedback", () => {
    expect(REQUIRED_LARK_SCOPES).toContain("im:message.reactions:write_only");
    expect(formatLarkScopeImportJson(REQUIRED_LARK_SCOPES)).toContain("im:message.reactions:write_only");
  });

  it("does not describe /newgroup repair when only mention member-read scope is missing", async () => {
    const scopes = grantAllRequiredScopes()
      .filter((scope) => scope.scope_name !== "im:chat.members:read");
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

    expect(result.missingScopes).toEqual(["im:chat.members:read"]);
    expect(formatted).toContain("Lark @name mention resolution requires im:chat.members:read");
    expect(formatted).toContain("Add or bulk-import im:chat.members:read");
    expect(formatted).not.toContain("Lark /newgroup requires im:chat");
    expect(formatted).not.toContain("Smoke test `/newgroup CCTB smoke test`");
    expect(formatted).not.toContain("missing chat-creation scopes");
  });

  it("includes document permission scopes for lark.doc.create auto-grant", () => {
    expect(REQUIRED_LARK_SCOPES).toContain("docs:permission.member:create");
    expect(formatLarkScopeImportJson(REQUIRED_LARK_SCOPES)).toContain("docs:permission.member:create");
  });

  it("includes spreadsheet scopes for Lark Sheets workflows", () => {
    expect(REQUIRED_LARK_SCOPES).toContain("sheets:spreadsheet:create");
    expect(REQUIRED_LARK_SCOPES).toContain("sheets:spreadsheet:read");
    expect(REQUIRED_LARK_SCOPES).toContain("sheets:spreadsheet:write_only");
    expect(REQUIRED_LARK_SCOPES).toContain("sheets:spreadsheet.meta:read");
    expect(formatLarkScopeImportJson(REQUIRED_LARK_SCOPES)).toContain("sheets:spreadsheet:create");
  });

  it("explains that /newgroup needs the bot chat creation scopes", async () => {
    const scopes = grantAllRequiredScopes()
      .filter((scope) => scope.scope_name !== "im:chat");
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

    expect(result.missingScopes).toEqual(["im:chat"]);
    expect(formatted).toContain("Lark /newgroup requires im:chat and im:chat:create for bot-created project groups");
    expect(formatted).toContain("cannot create fresh Lark project groups");
    expect(formatted).toContain('Bulk import missing scopes JSON: {"scopes":{"tenant":["im:chat"]}}');
    expect(formatted).toContain("Feishu/Lark Developer Console -> your app -> Permissions -> bulk import/open");
    expect(formatted).toContain("Publish the app version");
    expect(formatted).toContain("Rerun `node dist/src/index.js lark provision`");
    expect(formatted).toContain("Smoke test `/newgroup CCTB smoke test`");
  });

  it("explains that lark.doc.create needs document collaborator grant permission", async () => {
    const scopes = grantAllRequiredScopes()
      .filter((scope) => scope.scope_name !== "docs:permission.member:create");
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

    expect(result.missingScopes).toEqual(["docs:permission.member:create"]);
    expect(formatted).toContain("Lark document creation needs docs:permission.member:create");
    expect(formatted).toContain("auto-grant the created document back to the requester");
    expect(formatted).toContain("Permission denied auto-grant warning");
    expect(formatted).toContain("user identity is missing");
  });

  it("explains that Lark Sheets workflows need spreadsheet scopes and user OAuth", async () => {
    const scopes = grantAllRequiredScopes()
      .filter((scope) => scope.scope_name !== "sheets:spreadsheet:create");
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

    expect(result.missingScopes).toEqual(["sheets:spreadsheet:create"]);
    expect(formatted).toContain("Lark Sheets workflows need spreadsheet create/read/write/meta scopes");
    expect(formatted).toContain("lark auth start --scope");
    expect(formatted).toContain("sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read");
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
