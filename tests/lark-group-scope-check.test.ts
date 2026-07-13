import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep everything real except the network-hitting inspect call.
vi.mock("../src/lark/provisioning.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lark/provisioning.js")>();
  return { ...actual, inspectLarkAppProvisioning: vi.fn() };
});

import { inspectLarkAppProvisioning } from "../src/lark/provisioning.js";
import { handleLarkGroupCommandBeforeAccess } from "../src/lark/commands.js";
import { applyLarkConfigCardAction } from "../src/lark/config-card.js";
import {
  GROUP_MSG_SCOPE,
  checkGroupMsgScope,
  renderGroupMsgScopeWarning,
} from "../src/lark/group-scope-check.js";
import { normalizeLarkMessage } from "../src/lark/message-normalizer.js";
import { createLarkServiceRuntime } from "../src/lark/runtime.js";

const mockInspect = vi.mocked(inspectLarkAppProvisioning);
const grantedResult = (scopes: string[]) => ({ grantedScopes: scopes }) as never;

beforeEach(() => {
  mockInspect.mockReset();
});

describe("checkGroupMsgScope", () => {
  it("returns 'unknown' without hitting the API when creds are absent (never nags)", async () => {
    expect(await checkGroupMsgScope({ appId: "", appSecret: "" })).toBe("unknown");
    expect(await checkGroupMsgScope({ appId: "cli_x", appSecret: "  " })).toBe("unknown");
    expect(await checkGroupMsgScope({})).toBe("unknown");
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it("returns 'ok' when im:message.group_msg is granted", async () => {
    mockInspect.mockResolvedValueOnce(grantedResult(["im:message", GROUP_MSG_SCOPE]));
    expect(await checkGroupMsgScope({ appId: "cli_x", appSecret: "sek" })).toBe("ok");
  });

  it("returns 'missing' when the group-message scope is not granted", async () => {
    mockInspect.mockResolvedValueOnce(grantedResult(["im:message", "im:chat"]));
    expect(await checkGroupMsgScope({ appId: "cli_x", appSecret: "sek" })).toBe("missing");
  });

  it("returns 'unknown' (never throws) when the lookup fails", async () => {
    mockInspect.mockRejectedValueOnce(new Error("network down"));
    await expect(checkGroupMsgScope({ appId: "cli_x", appSecret: "sek" })).resolves.toBe("unknown");
  });

  it("returns 'unknown' when the lookup exceeds the timeout instead of hanging the command", async () => {
    mockInspect.mockImplementationOnce(() => new Promise(() => {})); // never settles
    await expect(
      checkGroupMsgScope({ appId: "cli_x", appSecret: "sek", timeoutMs: 20 }),
    ).resolves.toBe("unknown");
  });

  it("stays 'unknown' when the lookup rejects AFTER the timeout (late rejection is swallowed)", async () => {
    mockInspect.mockImplementationOnce(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late fail")), 60)),
    );
    await expect(
      checkGroupMsgScope({ appId: "cli_x", appSecret: "sek", timeoutMs: 15 }),
    ).resolves.toBe("unknown");
    // Let the late rejection fire; without the swallowing .catch it would surface
    // as an unhandled rejection in this run.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe("renderGroupMsgScopeWarning", () => {
  it("names the scope, the restart + doctor steps, and the console link (zh)", () => {
    const w = renderGroupMsgScopeWarning("zh", "cli_x", "feishu");
    expect(w).toContain(GROUP_MSG_SCOPE);
    expect(w).toContain("lark service restart --all");
    expect(w).toContain("lark doctor");
    expect(w).toContain("控制台");
  });

  it("targets the current instance when the instance name is known (zh)", () => {
    const w = renderGroupMsgScopeWarning("zh", "cli_x", "feishu", "ccfgg2");
    expect(w).toContain("lark service restart --instance ccfgg2");
    expect(w).not.toContain("lark service restart --all");
  });

  it("localizes to English", () => {
    const w = renderGroupMsgScopeWarning("en", "cli_x", "feishu", "ccfcc1");
    expect(w).toContain(GROUP_MSG_SCOPE);
    expect(w).toContain("lark service restart --instance ccfcc1");
    expect(w).toContain("Console:");
    expect(w).not.toContain("控制台");
  });

  it("omits the console line when the appId is unknown", () => {
    const w = renderGroupMsgScopeWarning("zh");
    expect(w).toContain(GROUP_MSG_SCOPE);
    expect(w).not.toContain("控制台");
  });
});

describe("group scope credential propagation", () => {
  it("uses runtime credentials for /group all when service secrets are absent from process.env", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-group-scope-runtime-"));
    const runtime = createLarkServiceRuntime();
    runtime.appInfo = { appId: "cli_runtime", appSecret: "runtime-secret", domain: "feishu" };
    const channel = { send: vi.fn(async () => ({ messageId: "sent_1" })) };
    const normalized = normalizeLarkMessage({
      messageId: "om_group_all",
      chatId: "oc_group",
      chatType: "group",
      senderId: "ou_user",
      content: "/group all",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    });
    mockInspect.mockResolvedValueOnce(grantedResult(["im:message"]));

    try {
      const handled = await handleLarkGroupCommandBeforeAccess({
        channel: channel as never,
        bridge: {
          checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
        } as never,
        runtime,
        stateDir,
        instanceName: "alpha",
        requestApproval: vi.fn() as never,
      }, normalized!, "/group all", "en");

      expect(handled).toBe(true);
      expect(mockInspect).toHaveBeenCalledWith({
        appId: "cli_runtime",
        appSecret: "runtime-secret",
        domain: "feishu",
      });
      expect(JSON.stringify(channel.send.mock.calls)).toContain(GROUP_MSG_SCOPE);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps runtime credentials on the config-card submit path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-group-scope-config-submit-"));
    mockInspect.mockResolvedValueOnce(grantedResult(["im:message"]));

    try {
      const result = await applyLarkConfigCardAction(stateDir, {
        cctb_lark: "config",
        action: "submit",
        conversationKey: "lark:oc_group",
        bridgeChatType: "group",
        larkChatId: "oc_group",
      }, "en", {
        engine: "codex",
        fast: "off",
        yolo: "off",
        locale: "en",
        group: "all",
      }, {
        appId: "cli_runtime",
        appSecret: "runtime-secret",
        domain: "feishu",
        instanceName: "alpha",
      });

      expect(mockInspect).toHaveBeenCalledWith({
        appId: "cli_runtime",
        appSecret: "runtime-secret",
        domain: "feishu",
      });
      expect(result).toContain(GROUP_MSG_SCOPE);
      expect(result).toContain("restart --instance alpha");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
