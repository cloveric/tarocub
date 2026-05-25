import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_LARK_CALLBACKS,
  REQUIRED_LARK_EVENTS,
  REQUIRED_LARK_SCOPES,
  formatLarkProvisioningResult,
  provisionLarkApp,
  type LarkProvisioningClient,
} from "../src/lark/provisioning.js";

describe("provisionLarkApp", () => {
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
          msg: "Access denied with Authorization: Bearer secret-token and app_secret=secret-personal",
        },
      },
    });

    await expect(provisionLarkApp({ appId: "cli_app", appSecret: "secret-personal", client }))
      .rejects.toThrow("99991672 Access denied with Authorization: Bearer [redacted] and app_secret=[redacted]");
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
