import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectInstanceSnapshots } from "../src/commands/dashboard.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("collectInstanceSnapshots", () => {
  it("uses CODEX_TELEGRAM_STATE_DIR as the dashboard source and does not treat a bare .env as a configured token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "claude" }), "utf8");
      await writeFile(path.join(customStateDir, ".env"), "EXTRA=1\n", "utf8");

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        name: "custom-alpha",
        stateDir: customStateDir,
        engine: "claude",
        botTokenConfigured: false,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not mark a custom-state instance as running when the pid is alive but not this service", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "instance.lock.json"),
        JSON.stringify({ pid: 12345, token: "token", acquiredAt: new Date().toISOString() }),
        "utf8",
      );

      const snapshots = await collectInstanceSnapshots(
        {
          USERPROFILE: tempDir,
          CODEX_TELEGRAM_STATE_DIR: customStateDir,
        },
        {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: () => false,
        },
      );

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        name: "custom-alpha",
        running: false,
        pid: null,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
