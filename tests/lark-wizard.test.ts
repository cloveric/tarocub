import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runLarkWizard } from "../src/lark/wizard.js";
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
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, LARK_DOMAIN: "feishu", CODEX_TELEGRAM_INSTANCE: "lark-alpha" },
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
      }));
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
      expect(saved).toContain('CODEX_TELEGRAM_INSTANCE="lark-alpha"');
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
});
