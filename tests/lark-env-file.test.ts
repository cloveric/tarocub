import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLarkRuntimeConfig } from "../src/lark/config.js";
import { loadLarkRuntimeEnv, resolveLarkStateDir, writeLarkEnvFile } from "../src/lark/env-file.js";

describe("Lark env files", () => {
  it("uses CCTB_LARK_INSTANCE as the Lark-specific state directory selector", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tarocub-lark-env-"));
    const instanceName = "ccfgg1";
    const stateDir = path.join(tempDir, ".cctb", instanceName);

    try {
      expect(resolveLarkStateDir({
        USERPROFILE: tempDir,
        CCTB_LARK_INSTANCE: instanceName,
        CODEX_TELEGRAM_STATE_DIR: path.join(tempDir, ".cctb", "bot6"),
      })).toBe(stateDir);
      expect(resolveLarkRuntimeConfig({
        USERPROFILE: tempDir,
        CCTB_LARK_INSTANCE: instanceName,
        CODEX_TELEGRAM_STATE_DIR: path.join(tempDir, ".cctb", "bot6"),
        LARK_APP_ID: "cli_lark",
        LARK_APP_SECRET: "secret",
      }).stateDir).toBe(stateDir);

      const envPath = await writeLarkEnvFile({
        USERPROFILE: tempDir,
        CCTB_LARK_INSTANCE: instanceName,
      }, {
        appId: "cli_lark",
        appSecret: "secret",
        domain: "feishu",
      });

      expect(envPath).toBe(path.join(stateDir, "lark.env"));
      const saved = await readFile(envPath, "utf8");
      expect(saved).toContain('CCTB_LARK_STATE_DIR="');
      expect(saved).toContain('.cctb/ccfgg1');
      expect(saved).toContain('CCTB_LARK_INSTANCE="ccfgg1"');
      expect(saved).toContain('TAROCUB_INSTANCE="ccfgg1"');

      const loaded = await loadLarkRuntimeEnv({
        USERPROFILE: tempDir,
        CCTB_LARK_INSTANCE: instanceName,
      });
      expect(loaded.CCTB_LARK_STATE_DIR).toBe(stateDir);
      expect(loaded.CCTB_LARK_INSTANCE).toBe(instanceName);
      expect(loaded.TAROCUB_INSTANCE).toBe(instanceName);
      expect(loaded.LARK_APP_ID).toBe("cli_lark");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses legacy TAROCUB_INSTANCE as the Lark state directory selector", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tarocub-lark-env-"));
    const instanceName = "lark2";
    const stateDir = path.join(tempDir, ".cctb", instanceName);

    try {
      const envPath = await writeLarkEnvFile({
        USERPROFILE: tempDir,
        TAROCUB_INSTANCE: instanceName,
      }, {
        appId: "cli_lark2",
        appSecret: "secret",
        domain: "feishu",
      });
      expect(envPath).toBe(path.join(stateDir, "lark.env"));

      const legacyOnlyEnv = [
        "LARK_APP_ID=\"cli_lark2\"",
        "LARK_APP_SECRET=\"secret\"",
        `CCTB_LARK_STATE_DIR=\"${stateDir}\"`,
        `TAROCUB_INSTANCE=\"${instanceName}\"`,
        "",
      ].join("\n");
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "lark.env"), legacyOnlyEnv, "utf8");

      expect(resolveLarkStateDir({
        USERPROFILE: tempDir,
        TAROCUB_INSTANCE: instanceName,
      })).toBe(stateDir);

      const loaded = await loadLarkRuntimeEnv({
        USERPROFILE: tempDir,
        TAROCUB_INSTANCE: instanceName,
      });
      expect(loaded.CCTB_LARK_STATE_DIR).toBe(stateDir);
      expect(loaded.CCTB_LARK_INSTANCE).toBe(instanceName);
      expect(loaded.TAROCUB_INSTANCE).toBe(instanceName);
      expect(loaded.LARK_APP_ID).toBe("cli_lark2");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
