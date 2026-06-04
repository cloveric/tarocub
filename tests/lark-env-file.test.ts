import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLarkRuntimeConfig } from "../src/lark/config.js";
import { applyLarkEnvPassthrough, loadLarkRuntimeEnv, resolveLarkStateDir, writeLarkEnvFile } from "../src/lark/env-file.js";

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

  it("passes non-whitelisted lark.env keys (e.g. MCP tokens) through to the engine env", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tarocub-lark-env-"));
    const instanceName = "ccfgg1";
    const stateDir = path.join(tempDir, ".cctb", instanceName);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "lark.env"), [
        "# instance env",
        'LARK_APP_ID="cli_lark"',
        "LARK_APP_SECRET=secret",
        "IFIND_TOKEN=ifd-test-token-aaa",
        "OTHER_MCP_TOKEN=abc123",
        "KEEP_EXISTING=fromfile",
        "not a valid line without equals",
        "",
      ].join("\n"), "utf8");

      const target: NodeJS.ProcessEnv = { KEEP_EXISTING: "fromenv" };
      const applied = await applyLarkEnvPassthrough({
        USERPROFILE: tempDir,
        CCTB_LARK_INSTANCE: instanceName,
      }, target);

      // Non-whitelisted keys (MCP tokens) are passed through.
      expect(target.IFIND_TOKEN).toBe("ifd-test-token-aaa");
      expect(target.OTHER_MCP_TOKEN).toBe("abc123");
      expect([...applied].sort()).toEqual(["IFIND_TOKEN", "OTHER_MCP_TOKEN"]);
      // Whitelisted Lark keys are owned by loadLarkRuntimeEnv, not passed through here.
      expect(target.LARK_APP_ID).toBeUndefined();
      expect(target.LARK_APP_SECRET).toBeUndefined();
      // An existing env value always wins over the file.
      expect(target.KEEP_EXISTING).toBe("fromenv");
      expect(applied).not.toContain("KEEP_EXISTING");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns no passthrough keys when the instance lark.env is absent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tarocub-lark-env-"));
    try {
      const target: NodeJS.ProcessEnv = {};
      const applied = await applyLarkEnvPassthrough({
        USERPROFILE: tempDir,
        CCTB_LARK_INSTANCE: "missing-instance",
      }, target);
      expect(applied).toEqual([]);
      expect(Object.keys(target)).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves extra keys when regenerating lark.env on service start", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "tarocub-lark-env-"));
    const instanceName = "ccfgg1";
    const stateDir = path.join(tempDir, ".cctb", instanceName);
    const selector = { USERPROFILE: tempDir, CCTB_LARK_INSTANCE: instanceName };

    try {
      await writeLarkEnvFile(selector, { appId: "cli_lark", appSecret: "secret", domain: "feishu" });
      // Operator appends an MCP token to the instance env file.
      await writeFile(path.join(stateDir, "lark.env"), "\nIFIND_TOKEN=ifd-test-token-bbb\n", { flag: "a" });

      // A later service start regenerates lark.env (new secret) — the token must survive.
      await writeLarkEnvFile(selector, { appId: "cli_lark", appSecret: "secret2", domain: "feishu" });
      const saved = await readFile(path.join(stateDir, "lark.env"), "utf8");
      expect(saved).toContain("IFIND_TOKEN=");
      expect(saved).toContain('LARK_APP_SECRET="secret2"');

      // ...and the passthrough then surfaces it for the engine.
      const target: NodeJS.ProcessEnv = {};
      await applyLarkEnvPassthrough(selector, target);
      expect(target.IFIND_TOKEN).toBe("ifd-test-token-bbb");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
