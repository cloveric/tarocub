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
        { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        { log: (message) => messages.push(String(message ?? "")) },
        {
          registerAppImpl,
          generateQRCode: (url) => qrUrls.push(url),
        },
      );

      expect(envPath).toBe(path.join(stateDir, "lark.env"));
      expect(qrUrls).toEqual(["https://open.feishu.cn/qr"]);
      expect(registerAppImpl).toHaveBeenCalledWith(expect.objectContaining({
        source: "cc-telegram-bridge",
      }));
      const saved = await readFile(envPath, "utf8");
      expect(saved).toContain('LARK_APP_ID="cli_personal"');
      expect(saved).toContain('LARK_APP_SECRET="secret-personal"');
      expect(saved).toContain('LARK_DOMAIN="feishu"');
      expect(saved).toContain(`CCTB_LARK_STATE_DIR="${stateDir}"`);
      expect(saved).toContain('CODEX_TELEGRAM_INSTANCE="lark"');
      expect(messages.join("\n")).toContain("Operator open_id: ou_operator");
      expect(messages.join("\n")).not.toContain("secret-personal");
    } finally {
      await removeTempRoot(tempDir);
    }
  });
});
