import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runLarkScopeAddWizard, runLarkWizard } from "../src/lark/wizard.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("runLarkWizard", () => {
  it("registers a PersonalAgent app and stores credentials in lark.env", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-wizard-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const qrUrls: string[] = [];
    const initLarkCli = vi.fn(async () => undefined);
    const provisionApp = vi.fn(async () => ({
      grantedScopes: ["im:message:send_as_bot"],
      missingScopes: [],
      unauthorizedScopes: [],
      missingOptionalScopes: [],
      subscribedCallbacks: ["card.action.trigger"],
      missingCallbacks: [],
      subscribedEvents: ["im.message.receive_v1"],
      missingEvents: [],
      missingOptionalEvents: [],
      canPatchSubscriptions: true,
      subscriptionPatchScopeOptions: ["application:application", "admin:app.category:update"],
      applied: false,
      patchedSubscriptions: false,
    }));
    const registerAppImpl = vi.fn(async (options: {
      onQRCodeReady: (info: { url: string; expireIn: number }) => void;
      onStatusChange?: (info: { status: "polling" | "slow_down" | "domain_switched" }) => void;
    }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr", expireIn: 600 });
      options.onStatusChange?.({ status: "domain_switched" });
      return {
        client_id: "cli_personal",
        client_secret: "secret-personal",
        user_info: {
          open_id: "ou_operator",
          tenant_brand: "feishu" as const,
        },
      };
    });

    try {
      const envPath = await runLarkWizard(
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, LARK_DOMAIN: "feishu", TAROCUB_INSTANCE: "lark-alpha" },
        { log: (message) => messages.push(String(message ?? "")) },
        {
          registerAppImpl,
          generateQRCode: (url) => qrUrls.push(url),
          provisionApp,
          initLarkCli,
        },
      );

      expect(envPath).toBe(path.join(stateDir, "lark.env"));
      expect(qrUrls).toEqual(["https://open.feishu.cn/qr"]);
      expect(registerAppImpl).toHaveBeenCalledWith(expect.objectContaining({
        domain: "accounts.feishu.cn",
        source: "tarocub",
        // The /group all pair rides into the confirm page of the same scan, so
        // a new bot is born with it instead of needing a console visit later.
        addons: {
          scopes: {
            tenant: expect.arrayContaining([
              "im:message",
              "im:message.group_msg",
              // Required scopes ride along too: the platform template is
              // server-side and dropped docx:document:create once already.
              "docx:document:create",
              "im:message:send_as_bot",
              "cardkit:card:write",
            ]),
          },
        },
      }));
      expect(registerAppImpl.mock.calls[0]?.[0]).not.toHaveProperty("appId");
      expect(provisionApp).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_personal",
        appSecret: "secret-personal",
        domain: "feishu",
      }));
      expect(initLarkCli).toHaveBeenCalledWith({
        appId: "cli_personal",
        appSecret: "secret-personal",
        brand: "feishu",
        stateDir,
        homeDir: tempDir,
      });
      const saved = await readFile(envPath, "utf8");
      expect(saved).toContain('LARK_APP_ID="cli_personal"');
      expect(saved).toContain('LARK_APP_SECRET="secret-personal"');
      expect(saved).toContain('LARK_DOMAIN="feishu"');
      expect(saved).toContain(`CCTB_LARK_STATE_DIR="${stateDir}"`);
      expect(saved).toContain('TAROCUB_INSTANCE="lark-alpha"');
      expect(saved).not.toContain("CODEX_TELEGRAM_INSTANCE");
      expect(messages.join("\n")).toContain("Operator open_id: ou_operator");
      expect(messages.join("\n")).toContain("Lark required scopes: ok");
      expect(messages.join("\n")).toContain("lark-cli bound to bridge credentials through the lark-channel source.");
      expect(messages.join("\n")).toContain("requires lark-cli >= 1.0.41");
      expect(messages.join("\n")).toContain("For user-backed Docs/Drive/Sheets actions");
      expect(messages.join("\n")).toContain("node dist/src/index.js lark cli identity user-default");
      expect(messages.join("\n")).toContain("sheets:spreadsheet:create");
      expect(messages.join("\n")).toContain("node dist/src/index.js lark auth status --verify");
      expect(messages.join("\n")).not.toContain("secret-personal");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("fails fast when the registration server never returns a QR (no infinite hang)", async () => {
    vi.useFakeTimers();
    try {
      // Registration that never resolves and never produces a QR (timeoutless socket).
      const registerAppImpl = vi.fn(() => new Promise<never>(() => {}));
      const promise = runLarkWizard(
        { LARK_DOMAIN: "feishu" },
        { log: () => undefined },
        { registerAppImpl, generateQRCode: () => undefined, provisionApp: vi.fn(), initLarkCli: vi.fn() },
      );
      promise.catch(() => undefined); // avoid unhandled-rejection noise before we assert
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(promise).rejects.toThrow(/Could not reach the Lark registration server/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints lark-cli install guidance when wizard CLI binding cannot run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-wizard-cli-missing-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const initLarkCli = vi.fn(async () => {
      throw new Error("spawn lark-cli ENOENT");
    });
    const registerAppImpl = vi.fn(async (options: {
      onQRCodeReady: (info: { url: string; expireIn: number }) => void;
    }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr", expireIn: 600 });
      return {
        client_id: "cli_personal",
        client_secret: "secret-personal",
        user_info: {
          open_id: "ou_operator",
          tenant_brand: "feishu" as const,
        },
      };
    });

    try {
      await runLarkWizard(
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, LARK_DOMAIN: "feishu" },
        { log: (message) => messages.push(String(message ?? "")) },
        {
          registerAppImpl,
          generateQRCode: () => undefined,
          provisionApp: vi.fn(async () => ({
            grantedScopes: [],
            missingScopes: [],
            unauthorizedScopes: [],
            missingOptionalScopes: [],
            subscribedCallbacks: ["card.action.trigger"],
            missingCallbacks: [],
            subscribedEvents: ["im.message.receive_v1"],
            missingEvents: [],
            missingOptionalEvents: [],
            canPatchSubscriptions: true,
            subscriptionPatchScopeOptions: ["application:application", "admin:app.category:update"],
            applied: false,
            patchedSubscriptions: false,
          })),
          initLarkCli,
        },
      );

      const output = messages.join("\n");
      expect(output).toContain("lark-cli init skipped: spawn lark-cli ENOENT");
      expect(output).toContain("Full Lark-native functionality requires lark-cli >= 1.0.41");
      expect(output).toContain("node dist/src/index.js lark cli preflight --install --identity bot-only");
      expect(output).toContain("node dist/src/index.js lark cli bind --identity bot-only");
      expect(output).toContain("After binding, switch to user-default");
      expect(output).not.toContain("secret-personal");
    } finally {
      await removeTempRoot(tempDir);
    }
  });
  it("adds scopes to the existing app through the QR update flow without touching saved credentials", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-scopes-"));
    const stateDir = path.join(tempDir, "lark-state");
    await mkdir(stateDir, { recursive: true });
    const envPath = path.join(stateDir, "lark.env");
    await writeFile(envPath, 'LARK_APP_ID="cli_existing"\nLARK_APP_SECRET="secret-existing"\nLARK_DOMAIN="feishu"\n', "utf8");
    const messages: string[] = [];
    const provisionApp = vi.fn(async () => ({
      grantedScopes: ["im:message", "im:message.group_msg"],
      missingScopes: [],
      unauthorizedScopes: [],
      missingOptionalScopes: [],
      subscribedCallbacks: ["card.action.trigger"],
      missingCallbacks: [],
      subscribedEvents: ["im.message.receive_v1"],
      missingEvents: [],
      missingOptionalEvents: [],
      canPatchSubscriptions: true,
      subscriptionPatchScopeOptions: [],
      applied: true,
      patchedSubscriptions: false,
    }));
    const registerAppImpl = vi.fn(async (options: {
      appId?: string;
      addons?: { scopes?: { tenant?: string[] } };
      onQRCodeReady: (info: { url: string; expireIn: number }) => void;
    }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr-update", expireIn: 600 });
      return { client_id: "cli_existing", client_secret: "secret-existing" };
    });
    try {
      const outcome = await runLarkScopeAddWizard(
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        ["im:message", "im:message.group_msg", "im:message"],
        { log: (message) => messages.push(String(message ?? "")) },
        { registerAppImpl, generateQRCode: () => undefined, provisionApp },
      );
      expect(outcome).toEqual({ appId: "cli_existing", scopes: ["im:message", "im:message.group_msg"] });
      expect(registerAppImpl).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_existing",
        addons: { scopes: { tenant: ["im:message", "im:message.group_msg"] } },
      }));
      expect(provisionApp).toHaveBeenCalledWith(expect.objectContaining({ appId: "cli_existing", appSecret: "secret-existing" }));
      expect(await readFile(envPath, "utf8")).toContain('LARK_APP_SECRET="secret-existing"');
      expect(messages.join("\n")).toContain("lark service restart --defer");
      expect(messages.join("\n")).not.toContain("secret-existing");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("refuses to proceed when the scan authorized a different app", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-scopes-"));
    const stateDir = path.join(tempDir, "lark-state");
    await mkdir(stateDir, { recursive: true });
    const envPath = path.join(stateDir, "lark.env");
    await writeFile(envPath, 'LARK_APP_ID="cli_existing"\nLARK_APP_SECRET="secret-existing"\n', "utf8");
    const provisionApp = vi.fn();
    const registerAppImpl = vi.fn(async (options: { onQRCodeReady: (info: { url: string; expireIn: number }) => void }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr-update", expireIn: 600 });
      return { client_id: "cli_other", client_secret: "secret-other" };
    });
    try {
      await expect(runLarkScopeAddWizard(
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        ["im:message.group_msg"],
        { log: () => undefined },
        { registerAppImpl, generateQRCode: () => undefined, provisionApp },
      )).rejects.toThrow(/authorized app cli_other, not the configured cli_existing/);
      expect(provisionApp).not.toHaveBeenCalled();
      expect(await readFile(envPath, "utf8")).toContain('LARK_APP_ID="cli_existing"');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects an empty scope list and a missing credential file up front", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-scopes-"));
    const stateDir = path.join(tempDir, "lark-state");
    await mkdir(stateDir, { recursive: true });
    const registerAppImpl = vi.fn();
    try {
      await expect(runLarkScopeAddWizard(
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        ["   "],
        { log: () => undefined },
        { registerAppImpl: registerAppImpl as never },
      )).rejects.toThrow(/No scopes given/);
      await expect(runLarkScopeAddWizard(
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        ["im:message"],
        { log: () => undefined },
        { registerAppImpl: registerAppImpl as never },
      )).rejects.toThrow(/run `lark wizard` first/);
      expect(registerAppImpl).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });
});
