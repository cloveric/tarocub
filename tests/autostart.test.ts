import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function loadAutostartModule() {
  return import("../src/commands/autostart.js");
}

describe("runAutostartCommand", () => {
  it("syncs a single instance into a launch agent plist and loads it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-autostart-"));
    const messages: string[] = [];
    const actions: string[] = [];

    try {
      await mkdir(path.join(tempDir, ".cctb", "alpha"), { recursive: true });
      const { runAutostartCommand } = await loadAutostartModule();

      const handled = await runAutostartCommand(
        ["autostart", "sync", "--instance", "alpha"],
        {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CODEX_HOME: path.join(tempDir, ".codex"),
          CLAUDE_CONFIG_DIR: path.join(tempDir, ".claude"),
        },
        { log: (message) => messages.push(message) },
        {
          cwd: "C:\\Users\\hangw\\codex-telegram-channel",
          nodePath: "/usr/local/bin/node",
          uid: 501,
          pathEnv: "/usr/bin:/bin",
          bootout: async () => {
            actions.push("bootout");
          },
          bootstrap: async (label) => {
            actions.push(`bootstrap:${label}`);
          },
          enable: async (label) => {
            actions.push(`enable:${label}`);
          },
          kickstart: async (label) => {
            actions.push(`kickstart:${label}`);
          },
          inspect: async () => ({
            loaded: true,
            running: true,
            pid: 12345,
          }),
        },
      );

      expect(handled).toBe(true);
      expect(actions).toEqual([
        "bootout",
        "bootstrap:com.cloveric.cc-telegram-bridge.alpha",
        "enable:com.cloveric.cc-telegram-bridge.alpha",
        "kickstart:com.cloveric.cc-telegram-bridge.alpha",
      ]);
      expect(messages).toEqual(['Synced autostart for instance "alpha".']);

      const plistPath = path.join(tempDir, "Library", "LaunchAgents", "com.cloveric.cc-telegram-bridge.alpha.plist");
      const plist = await readFile(plistPath, "utf8");
      expect(plist).toContain("<string>com.cloveric.cc-telegram-bridge.alpha</string>");
      expect(plist).toContain("<string>--instance</string>");
      expect(plist).toContain("<string>alpha</string>");
      expect(plist).toContain(path.join(tempDir, ".codex"));
      expect(plist).toContain(path.join(tempDir, ".claude"));
      expect(plist).toContain("/usr/local/bin/node");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("syncs all instances and prunes stale launch agents", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-autostart-"));
    const messages: string[] = [];
    const actions: string[] = [];

    try {
      await mkdir(path.join(tempDir, ".cctb", "alpha"), { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", "beta"), { recursive: true });
      const launchAgentsDir = path.join(tempDir, "Library", "LaunchAgents");
      await mkdir(launchAgentsDir, { recursive: true });
      await writeFile(
        path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.gamma.plist"),
        "<plist></plist>",
        "utf8",
      );

      const { runAutostartCommand } = await loadAutostartModule();

      const handled = await runAutostartCommand(
        ["autostart", "sync", "--prune"],
        {
          HOME: tempDir,
          USERPROFILE: tempDir,
        },
        { log: (message) => messages.push(message) },
        {
          cwd: "/repo",
          nodePath: "/usr/bin/node",
          uid: 501,
          pathEnv: "/usr/bin:/bin",
          bootout: async (plistPath) => {
            actions.push(`bootout:${path.basename(plistPath)}`);
          },
          bootstrap: async (label) => {
            actions.push(`bootstrap:${label}`);
          },
          enable: async (label) => {
            actions.push(`enable:${label}`);
          },
          kickstart: async (label) => {
            actions.push(`kickstart:${label}`);
          },
          inspect: async () => ({
            loaded: false,
            running: false,
            pid: null,
          }),
        },
      );

      expect(handled).toBe(true);
      expect(actions).toEqual([
        "bootout:com.cloveric.cc-telegram-bridge.alpha.plist",
        "bootstrap:com.cloveric.cc-telegram-bridge.alpha",
        "enable:com.cloveric.cc-telegram-bridge.alpha",
        "kickstart:com.cloveric.cc-telegram-bridge.alpha",
        "bootout:com.cloveric.cc-telegram-bridge.beta.plist",
        "bootstrap:com.cloveric.cc-telegram-bridge.beta",
        "enable:com.cloveric.cc-telegram-bridge.beta",
        "kickstart:com.cloveric.cc-telegram-bridge.beta",
        "bootout:com.cloveric.cc-telegram-bridge.gamma.plist",
      ]);
      expect(messages).toEqual(['Synced autostart for 2 instances and pruned 1 stale entry.']);

      await expect(
        readFile(path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.gamma.plist"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports autostart status for managed and stale entries", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-autostart-"));
    const messages: string[] = [];

    try {
      await mkdir(path.join(tempDir, ".cctb", "alpha"), { recursive: true });
      const launchAgentsDir = path.join(tempDir, "Library", "LaunchAgents");
      await mkdir(launchAgentsDir, { recursive: true });
      await writeFile(
        path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.alpha.plist"),
        "<plist></plist>",
        "utf8",
      );
      await writeFile(
        path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.gamma.plist"),
        "<plist></plist>",
        "utf8",
      );

      const { runAutostartCommand } = await loadAutostartModule();

      const handled = await runAutostartCommand(
        ["autostart", "status"],
        {
          HOME: tempDir,
          USERPROFILE: tempDir,
        },
        { log: (message) => messages.push(message) },
        {
          inspect: async (label) => ({
            loaded: label.endsWith(".alpha"),
            running: label.endsWith(".alpha"),
            pid: label.endsWith(".alpha") ? 222 : null,
          }),
        },
      );

      expect(handled).toBe(true);
      expect(messages).toEqual([
        "Autostart entries (2):",
        "  - alpha managed=yes loaded=yes running=yes pid=222",
        "  - gamma managed=no loaded=no running=no pid=none",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes an autostart entry for an instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-autostart-"));
    const messages: string[] = [];
    const actions: string[] = [];

    try {
      const launchAgentsDir = path.join(tempDir, "Library", "LaunchAgents");
      await mkdir(launchAgentsDir, { recursive: true });
      await writeFile(
        path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.alpha.plist"),
        "<plist></plist>",
        "utf8",
      );

      const { runAutostartCommand } = await loadAutostartModule();

      const handled = await runAutostartCommand(
        ["autostart", "remove", "--instance", "alpha"],
        {
          HOME: tempDir,
          USERPROFILE: tempDir,
        },
        { log: (message) => messages.push(message) },
        {
          bootout: async (plistPath) => {
            actions.push(`bootout:${path.basename(plistPath)}`);
          },
        },
      );

      expect(handled).toBe(true);
      expect(actions).toEqual(["bootout:com.cloveric.cc-telegram-bridge.alpha.plist"]);
      expect(messages).toEqual(['Removed autostart for instance "alpha".']);
      await expect(
        readFile(path.join(launchAgentsDir, "com.cloveric.cc-telegram-bridge.alpha.plist"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses pid and running state from launchctl print output", async () => {
    const { parseLaunchctlPrintStatus } = await loadAutostartModule();

    const status = parseLaunchctlPrintStatus(`gui/501/com.cloveric.cc-telegram-bridge.default = {
	state = running
	pid = 52427
}`);

    expect(status).toEqual({
      loaded: true,
      running: true,
      pid: 52427,
    });
  });
});
