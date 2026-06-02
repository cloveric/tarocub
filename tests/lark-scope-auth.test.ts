import { describe, expect, it, vi } from "vitest";

import {
  detectLarkMissingScope,
  larkAppPermissionUrl,
  maybeSendLarkScopeAuthCard,
  renderLarkScopeAuthCard,
} from "../src/lark/scope-auth.js";

describe("detectLarkMissingScope", () => {
  it("detects the Feishu no-permission code embedded in a thrown message", () => {
    expect(detectLarkMissingScope(new Error("lark chat.create failed (code 99991672)"))).toEqual({ scope: null });
  });

  it("detects a direct numeric code on the error object", () => {
    const err = Object.assign(new Error("permission check"), { code: 99991672 });
    expect(detectLarkMissingScope(err)).toEqual({ scope: null });
  });

  it("extracts the scope from required_scope", () => {
    expect(detectLarkMissingScope(new Error("permission_grant=failed required_scope=docx:document message=nope")))
      .toEqual({ scope: "docx:document" });
  });

  it("extracts an im:message:send style scope token from a permission error", () => {
    expect(detectLarkMissingScope(new Error("No permission: im:message:send_as_bot is not granted")))
      .toEqual({ scope: "im:message:send_as_bot" });
  });

  it("detects Chinese permission wording", () => {
    expect(detectLarkMissingScope(new Error("操作失败：权限不足"))).toEqual({ scope: null });
  });

  it("returns null for unrelated errors", () => {
    expect(detectLarkMissingScope(new Error("network timeout"))).toBeNull();
    expect(detectLarkMissingScope(new Error("code 500 internal"))).toBeNull();
    expect(detectLarkMissingScope(undefined)).toBeNull();
  });
});

describe("larkAppPermissionUrl", () => {
  it("builds the Feishu (China) permissions URL by default", () => {
    expect(larkAppPermissionUrl("cli_abc", undefined)).toBe("https://open.feishu.cn/app/cli_abc/auth");
  });

  it("builds the Lark (international) URL when the domain is larksuite", () => {
    expect(larkAppPermissionUrl("cli_abc", "https://open.larksuite.com")).toBe("https://open.larksuite.com/app/cli_abc/auth");
  });

  it("returns null without an appId", () => {
    expect(larkAppPermissionUrl(undefined, undefined)).toBeNull();
  });
});

describe("renderLarkScopeAuthCard", () => {
  it("names the scope and links a primary auth button to the permissions console", () => {
    const card = renderLarkScopeAuthCard({ scope: "docx:document", appId: "cli_x", domain: undefined, locale: "zh" }) as {
      body: { elements: Array<{ tag: string; behaviors?: Array<{ default_url: string }> }> };
    };
    const json = JSON.stringify(card);
    expect(json).toContain("docx:document");
    expect(json).toContain("权限管理");
    const button = card.body.elements.find((e) => e.tag === "button");
    expect(button?.behaviors?.[0]?.default_url).toBe("https://open.feishu.cn/app/cli_x/auth");
  });

  it("falls back to a doctor hint when no appId is known (no button)", () => {
    const card = renderLarkScopeAuthCard({ scope: null, appId: undefined, domain: undefined, locale: "zh" }) as {
      body: { elements: Array<{ tag: string }> };
    };
    const hasButton = card.body.elements.some((e) => e.tag === "button");
    expect(hasButton).toBe(false);
    expect(JSON.stringify(card)).toContain("lark doctor");
  });
});

describe("maybeSendLarkScopeAuthCard", () => {
  it("sends an auth card and returns true for a scope error", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    const handled = await maybeSendLarkScopeAuthCard(
      { channel: { send }, chatId: "oc_1", appId: "cli_x", domain: undefined, locale: "zh" },
      new Error("required_scope=docx:document permission_grant=failed"),
    );
    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[1];
    expect(JSON.stringify(payload)).toContain("权限");
    expect(JSON.stringify(payload)).toContain("docx:document");
  });

  it("returns false and sends nothing for a non-scope error", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    const handled = await maybeSendLarkScopeAuthCard(
      { channel: { send }, chatId: "oc_1", appId: "cli_x", locale: "zh" },
      new Error("network timeout"),
    );
    expect(handled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns false when even the card cannot be delivered", async () => {
    const send = vi.fn().mockRejectedValue(new Error("send blew up"));
    const handled = await maybeSendLarkScopeAuthCard(
      { channel: { send }, chatId: "oc_1", appId: "cli_x", locale: "zh" },
      new Error("code 99991672 no permission"),
    );
    expect(handled).toBe(false);
  });
});
