import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonStore } from "../src/state/json-store.js";
import { ensureStateDirPermissions } from "../src/state/state-permissions.js";
import { removeTempRoot } from "./helpers/temp-files.js";

async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

// chmod is a no-op on Windows (state dirs there rely on the profile ACL).
describe.skipIf(process.platform === "win32")("state directory permissions", () => {
  it("creates a fresh state dir 0700 and its state files 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-state-perms-fresh-"));
    const stateDir = path.join(root, ".cctb", "default");

    try {
      await new JsonStore<{ chats: unknown[] }>(path.join(stateDir, "session.json")).write({ chats: [] });

      expect(await modeOf(stateDir)).toBe(0o700);
      expect(await modeOf(path.join(stateDir, "session.json"))).toBe(0o600);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("repairs a pre-existing world-readable state dir and stays idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-state-perms-repair-"));
    const cctbRoot = path.join(root, ".cctb");
    const stateDir = path.join(cctbRoot, "default");
    const jobDir = path.join(stateDir, "asr-jobs", "1700000000-voice.ogg");
    const sensitiveFiles = [
      path.join(stateDir, ".env"),
      path.join(stateDir, "lark.env"),
      path.join(stateDir, "access.json"),
      path.join(stateDir, "session.json"),
      path.join(stateDir, "config.json"),
      path.join(stateDir, "known-chats.json"),
      path.join(stateDir, "usage.json"),
      path.join(stateDir, "service.stderr.log"),
      path.join(stateDir, "service.lifecycle.log.jsonl"),
      path.join(stateDir, "service.lifecycle.log.jsonl.1"),
      path.join(stateDir, "cron", "jobs.json"),
      path.join(stateDir, "timers", "jobs.json"),
      path.join(jobDir, "stdout.log"),
      path.join(jobDir, "transcription.txt"),
      path.join(cctbRoot, "shared.env"),
    ];

    try {
      await mkdir(jobDir, { recursive: true, mode: 0o755 });
      await mkdir(path.join(stateDir, "cron"), { recursive: true, mode: 0o755 });
      await mkdir(path.join(stateDir, "timers"), { recursive: true, mode: 0o755 });
      // Simulate the world-readable layout live instances actually have.
      await chmod(stateDir, 0o755);
      await chmod(path.join(stateDir, "asr-jobs"), 0o755);
      await chmod(jobDir, 0o755);
      for (const filePath of sensitiveFiles) {
        await writeFile(filePath, "secret", { encoding: "utf8", mode: 0o644 });
        await chmod(filePath, 0o644);
      }

      await ensureStateDirPermissions(stateDir);

      expect(await modeOf(stateDir)).toBe(0o700);
      expect(await modeOf(path.join(stateDir, "asr-jobs"))).toBe(0o700);
      expect(await modeOf(jobDir)).toBe(0o700);
      for (const filePath of sensitiveFiles) {
        expect([filePath, await modeOf(filePath)]).toEqual([filePath, 0o600]);
      }

      // Idempotent: a second sweep neither throws nor loosens anything.
      await ensureStateDirPermissions(stateDir);
      expect(await modeOf(stateDir)).toBe(0o700);
      expect(await modeOf(path.join(stateDir, ".env"))).toBe(0o600);

      // And it repairs again after a regression (e.g. an older build re-created them).
      await chmod(stateDir, 0o755);
      await chmod(path.join(stateDir, ".env"), 0o644);
      await ensureStateDirPermissions(stateDir);
      expect(await modeOf(stateDir)).toBe(0o700);
      expect(await modeOf(path.join(stateDir, ".env"))).toBe(0o600);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("never throws on a missing state dir", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-state-perms-missing-"));
    try {
      await expect(ensureStateDirPermissions(path.join(root, "nope"))).resolves.toBeUndefined();
    } finally {
      await removeTempRoot(root);
    }
  });
});
