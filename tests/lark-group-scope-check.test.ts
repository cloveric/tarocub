import { describe, expect, it, vi } from "vitest";

// Keep everything real except the network-hitting inspect call.
vi.mock("../src/lark/provisioning.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lark/provisioning.js")>();
  return { ...actual, inspectLarkAppProvisioning: vi.fn() };
});

import { inspectLarkAppProvisioning } from "../src/lark/provisioning.js";
import {
  GROUP_MSG_SCOPE,
  checkGroupMsgScope,
  renderGroupMsgScopeWarning,
} from "../src/lark/group-scope-check.js";

const mockInspect = vi.mocked(inspectLarkAppProvisioning);
const grantedResult = (scopes: string[]) => ({ grantedScopes: scopes }) as never;

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
    expect(w).toContain("lark service restart");
    expect(w).toContain("lark doctor");
    expect(w).toContain("控制台");
  });

  it("localizes to English", () => {
    const w = renderGroupMsgScopeWarning("en", "cli_x", "feishu");
    expect(w).toContain(GROUP_MSG_SCOPE);
    expect(w).toContain("Console:");
    expect(w).not.toContain("控制台");
  });

  it("omits the console line when the appId is unknown", () => {
    const w = renderGroupMsgScopeWarning("zh");
    expect(w).toContain(GROUP_MSG_SCOPE);
    expect(w).not.toContain("控制台");
  });
});
