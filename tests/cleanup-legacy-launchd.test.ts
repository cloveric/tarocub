import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("cleanup-legacy-launchd.sh", () => {
  it("removes every matching plist in --all mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-cleanup-"));
    const launchAgentsDir = path.join(tempDir, "Library", "LaunchAgents");
    const binDir = path.join(tempDir, "bin");
    const launchctlLog = path.join(tempDir, "launchctl.log");
    const plistA = path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.alpha.plist");
    const plistB = path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.default.plist");
    const fakeLaunchctl = path.join(binDir, "launchctl");
    const uid = process.getuid?.();

    try {
      await mkdir(launchAgentsDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(plistA, "<plist/>", "utf8");
      await writeFile(plistB, "<plist/>", "utf8");
      await writeFile(
        fakeLaunchctl,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${launchctlLog}"
`,
        "utf8",
      );
      await chmod(fakeLaunchctl, 0o755);

      const { stdout } = await execFileAsync("bash", ["scripts/cleanup-legacy-launchd.sh", "--all"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: tempDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      await expect(readFile(plistA, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(plistB, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const launchctlCalls = await readFile(launchctlLog, "utf8");
      expect(uid).toBeTypeOf("number");
      expect(launchctlCalls).toContain(`bootout gui/${uid} ${plistA}`);
      expect(launchctlCalls).toContain(`bootout gui/${uid} ${plistB}`);
      expect(stdout).toContain('Removed legacy launchd plist for instance "alpha".');
      expect(stdout).toContain('Removed legacy launchd plist for instance "default".');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
