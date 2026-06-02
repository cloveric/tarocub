import { describe, expect, it, vi } from "vitest";

import { LarkCliError, larkCliErrorFromExec } from "../src/lark/lark-cli-error.js";
import {
  detectLarkMissingScope,
  larkAppPermissionUrl,
  maybeSendLarkScopeAuthCard,
  renderLarkScopeAuthCard,
} from "../src/lark/scope-auth.js";

describe("detectLarkMissingScope", () => {
  it("detects the Feishu no-permission code embedded in a thrown message", () => {
    expect(detectLarkMissingScope(new Error("lark chat.create failed (code 99991672)"))).toEqual({ scope: null, kind: "scope" });
  });

  it("detects a direct numeric code on the error object", () => {
    const err = Object.assign(new Error("permission check"), { code: 99991672 });
    expect(detectLarkMissingScope(err)).toEqual({ scope: null, kind: "scope" });
  });

  it("extracts the scope from required_scope", () => {
    expect(detectLarkMissingScope(new Error("permission_grant=failed required_scope=docx:document message=nope")))
      .toEqual({ scope: "docx:document", kind: "scope" });
  });

  it("extracts an im:message:send style scope token from a permission error", () => {
    expect(detectLarkMissingScope(new Error("No permission: im:message:send_as_bot is not granted")))
      .toEqual({ scope: "im:message:send_as_bot", kind: "scope" });
  });

  it("detects Chinese permission wording", () => {
    expect(detectLarkMissingScope(new Error("操作失败：权限不足"))).toEqual({ scope: null, kind: "scope" });
  });

  it("returns null for unrelated errors", () => {
    expect(detectLarkMissingScope(new Error("network timeout"))).toBeNull();
    expect(detectLarkMissingScope(new Error("code 500 internal"))).toBeNull();
    expect(detectLarkMissingScope(undefined)).toBeNull();
  });

  it("does NOT misfire on generic non-scope failures (forbidden / access denied / 未授权)", () => {
    // The delivery hook tries scope detection for EVERY tool error, so a business rejection
    // that merely says "forbidden" must NOT be rendered as a "go authorize a scope" card —
    // only codes, required_scope, or an extractable scope token count as scope signals.
    expect(detectLarkMissingScope(new Error("Forbidden: bot not in chat"))).toBeNull();
    expect(detectLarkMissingScope(new Error("Request failed: access denied by recipient"))).toBeNull();
    expect(detectLarkMissingScope(new Error("操作未授权"))).toBeNull();
  });

  // Typed lark-cli envelope (>= 1.0.45) — the authoritative path for lark-cli failures.
  it("treats a typed no-permission lark-cli error as a missing scope (kind=scope)", () => {
    const err = new LarkCliError(
      { type: "authentication", subtype: "permission_denied", code: 99991672, message: "no permission" },
      "lark-cli docs +create failed",
    );
    expect(detectLarkMissingScope(err)).toEqual({ scope: null, kind: "scope" });
  });

  it("treats a typed token-type auth error as kind=auth (not a nameable scope) and carries the troubleshooter", () => {
    const err = new LarkCliError(
      { type: "authentication", subtype: "token_invalid", code: 99991668, message: "user access token not support", troubleshooter: "https://open.feishu.cn/search?code=99991668" },
      "lark-cli failed",
    );
    expect(detectLarkMissingScope(err)).toEqual({
      scope: null,
      kind: "auth",
      troubleshooter: "https://open.feishu.cn/search?code=99991668",
    });
  });

  it("names the scope from a typed auth error message when present", () => {
    const err = new LarkCliError(
      { type: "authentication", code: 99990000, message: "required_scope=docx:document not granted" },
      "lark-cli failed",
    );
    expect(detectLarkMissingScope(err)).toEqual({ scope: "docx:document", kind: "scope" });
  });

  it("does NOT fire for a non-auth lark-cli error (type=api)", () => {
    const err = new LarkCliError({ type: "api", subtype: "not_found", code: 404, message: "HTTP 404" }, "lark-cli failed");
    expect(detectLarkMissingScope(err)).toBeNull();
  });

  it("does not let a process exit code shadow the real lark permission code in the message", () => {
    // A rejected execFile that couldn't be parsed into a typed error still carries the real
    // lark code in its message; .code is the PROCESS exit status (3). The card must still fire
    // via the message code, not be masked by the exit code.
    const err = Object.assign(new Error("lark chat.create failed (code 99991672)"), { code: 3 });
    expect(detectLarkMissingScope(err)).toEqual({ scope: null, kind: "scope" });
  });

  it("does NOT fire on a bare prefix:token alone (no code, no permission wording)", () => {
    // "task:done:retry" is a coincidental token in an ordinary failure, not a scope error.
    expect(detectLarkMissingScope(new Error("step task:done:retry failed after timeout"))).toBeNull();
  });
});

describe("larkCliErrorFromExec (lark-cli exits nonzero + writes the typed envelope to stderr)", () => {
  // The exact shape a promisified child_process.execFile rejection has when lark-cli fails:
  // .code is the PROCESS exit status, the typed envelope is on .stderr, stdout is empty.
  const rejectionLike = (stderr: string, exitCode: number) =>
    Object.assign(new Error(`Command failed: lark-cli ...\n${stderr}`), { code: exitCode, stdout: "", stderr });

  it("recovers the typed LarkCliError from a rejected exec's stderr + keeps only the troubleshooter URL", () => {
    const stderr = JSON.stringify({
      ok: false,
      error: {
        type: "authentication",
        subtype: "token_invalid",
        code: 99991668,
        message: "user access token not support",
        troubleshooter: "排查建议查看(Troubleshooting suggestions): https://open.feishu.cn/search?from=openapi&code=99991668",
      },
    });
    const recovered = larkCliErrorFromExec(rejectionLike(stderr, 3), "lark-cli docs +create failed");
    expect(recovered).toBeInstanceOf(LarkCliError);
    const cliErr = recovered as LarkCliError;
    expect(cliErr.larkType).toBe("authentication");
    expect(cliErr.larkCode).toBe(99991668);
    // Only the URL is kept — the surrounding Chinese text + parens would break a card link.
    expect(cliErr.troubleshooter).toBe("https://open.feishu.cn/search?from=openapi&code=99991668");
  });

  it("recovered LarkCliError flows through detection to an auth card", () => {
    const stderr = JSON.stringify({ ok: false, error: { type: "authentication", code: 99991668, message: "user access token not support", troubleshooter: "see https://open.feishu.cn/search?code=99991668" } });
    const recovered = larkCliErrorFromExec(rejectionLike(stderr, 3), "fb");
    expect(detectLarkMissingScope(recovered)).toEqual({
      scope: null,
      kind: "auth",
      troubleshooter: "https://open.feishu.cn/search?code=99991668",
    });
  });

  it("returns an existing LarkCliError unchanged", () => {
    const original = new LarkCliError({ type: "authentication", code: 99991672 }, "x");
    expect(larkCliErrorFromExec(original, "fb")).toBe(original);
  });

  it("returns the original error when there is no parseable envelope", () => {
    const plain = Object.assign(new Error("Command failed: lark-cli (exit 1)"), { code: 1, stdout: "", stderr: "boom, not json" });
    expect(larkCliErrorFromExec(plain, "fb")).toBe(plain);
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

  it("uses an honest auth/permission framing + a troubleshooter link for kind=auth", () => {
    const card = renderLarkScopeAuthCard({
      scope: null,
      appId: "cli_x",
      domain: undefined,
      locale: "zh",
      kind: "auth",
      troubleshooter: "https://open.feishu.cn/search?code=99991668",
    });
    const json = JSON.stringify(card);
    // Honest wording (covers scope OR token), not a flat "missing scope" claim.
    expect(json).toContain("认证/权限");
    // Feishu's own troubleshooting link is surfaced...
    expect(json).toContain("https://open.feishu.cn/search?code=99991668");
    // ...and the permissions console button is still offered.
    expect(json).toContain("权限管理");
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
