import { mkdtemp, readFile, readdir, mkdir, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { AccessStore } from "../src/state/access-store.js";
import {
  buildDetachedLarkSetupCommand,
  buildLarkServiceStartCommand,
  findLarkServiceProcessIdsFromPs,
  resolveLarkSetupTargetEnv,
  runCli,
} from "../src/commands/cli.js";
import { SessionStore } from "../src/state/session-store.js";
import { createArchive } from "../src/state/archive.js";
import { CronStore } from "../src/state/cron-store.js";
import { LarkGroupModeStore } from "../src/lark/group-mode-store.js";
import { resolveLarkServiceLockPath } from "../src/lark/service.js";
import { DEFAULT_INSTANCE_AGENT_INSTRUCTIONS, stripGeneratedTelegramTransportSection } from "../src/commands/access.js";

const REPO_ROOT = "C:\\Users\\hangw\\codex-telegram-channel";

describe("runCli", () => {
  it("keeps the generated Telegram transport prompt compact enough for every-turn use", () => {
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS.length).toBeLessThan(850);
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS.split("\n").length).toBeLessThanOrEqual(6);
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("## Telegram Transport");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain('"name":"send.file"');
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("send.image");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("send.batch");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("cron.add");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("cron.list");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("cron.remove");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("cron.toggle");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("web_extract");
    expect(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS).toContain("web_search");
  });

  it("configures the default instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "configure", "bot-token-123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Configured Telegram bot token for instance "default".']);

      const envPath = path.join(tempDir, ".cctb", "default", ".env");
      await expect(readFile(envPath, "utf8")).resolves.toBe('TELEGRAM_BOT_TOKEN="bot-token-123"\n');
      const agentPath = path.join(tempDir, ".cctb", "default", "agent.md");
      await expect(readFile(agentPath, "utf8")).resolves.toContain("## Telegram Transport");
      await expect(readFile(agentPath, "utf8")).resolves.toContain('"name":"send.file"');
      await expect(readFile(agentPath, "utf8")).resolves.toContain("Deliver: file/image");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("cctb send --file PATH");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("[send-file:<absolute path>]");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain(".telegram-out/current");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("CCTB_SEND_COMMAND");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain(".cctb-send/");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("- Telegram is plain text");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("configures a named instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "configure", "--instance", "alpha", "bot-token-456"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Configured Telegram bot token for instance "alpha".']);

      const envPath = path.join(tempDir, ".cctb", "alpha", ".env");
      await expect(readFile(envPath, "utf8")).resolves.toBe('TELEGRAM_BOT_TOKEN="bot-token-456"\n');
      const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
      await expect(readFile(agentPath, "utf8")).resolves.toContain("## Telegram Transport");
      await expect(readFile(agentPath, "utf8")).resolves.toContain("Deliver: file/image");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects an invalid instance name", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await expect(
        runCli(["telegram", "configure", "--instance", "..\\..\\x", "bot-token-456"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toThrow("Invalid instance name");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects missing configure token", async () => {
    await expect(runCli(["telegram", "configure"], { env: { USERPROFILE: "C:\\Users\\hangw" } })).rejects.toThrow(
      "Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>",
    );
  });

  it("prints configure help without writing a default token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "configure", "--help"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(["Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>"]);
      await expect(readFile(path.join(tempDir, ".cctb", "default", ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("returns false for non-CLI invocation", async () => {
    await expect(runCli(["ping"], { env: { USERPROFILE: "C:\\Users\\hangw" } })).resolves.toBe(false);
  });

  it("rejects unexpected positional args for status", async () => {
    await expect(
      runCli(["telegram", "status", "extra"], {
        env: { USERPROFILE: "C:\\Users\\hangw" },
      }),
    ).rejects.toThrow("Usage: telegram status [--instance <name>]");
  });

  it("reports Lark channel status without Telegram credentials", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["lark", "status"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages.join("\n")).toContain("Lark channel");
      expect(messages.join("\n")).toContain("App ID: configured");
      expect(messages.join("\n")).toContain("App Secret: configured");
      expect(messages.join("\n")).toContain(path.join(tempDir, "lark-state"));
      expect(messages.join("\n")).toContain("Service: not running");
      expect(messages.join("\n")).toContain("Run: node dist/src/index.js lark service start");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("lets explicit Lark --instance override an inherited Lark state dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inheritedStateDir = path.join(tempDir, ".cctb", "lark-one");
    const messages: string[] = [];

    try {
      const handled = await runCli(["lark", "status", "--instance", "lark-two"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: inheritedStateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkDetectCli: async () => ({ available: false }),
      } as Parameters<typeof runCli>[1] & {
        larkDetectCli: () => Promise<{ available: boolean; version?: string }>;
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("Instance: lark-two");
      expect(output).toContain(`State dir: ${path.join(tempDir, ".cctb", "lark-two")}`);
      expect(output).not.toContain(inheritedStateDir);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("lets explicit Lark env instance override an inherited stale state dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inheritedStateDir = path.join(tempDir, ".cctb", "lark-one");
    const messages: string[] = [];

    try {
      const handled = await runCli(["lark", "status"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_INSTANCE: "lark-two",
          CCTB_LARK_STATE_DIR: inheritedStateDir,
          CODEX_TELEGRAM_STATE_DIR: inheritedStateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkDetectCli: async () => ({ available: false }),
      } as Parameters<typeof runCli>[1] & {
        larkDetectCli: () => Promise<{ available: boolean; version?: string }>;
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("Instance: lark-two");
      expect(output).toContain(`State dir: ${path.join(tempDir, ".cctb", "lark-two")}`);
      expect(output).not.toContain(inheritedStateDir);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("loads Lark credentials from the generated lark.env file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "status"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("App ID: configured");
      expect(output).toContain("App Secret: configured");
      expect(output).toContain("Domain: feishu");
      expect(output).toContain(path.join(stateDir, "lark.env"));
      expect(output).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("reports a running Lark service lock in status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const lockDir = path.join(stateDir, "lark-service");
    const messages: string[] = [];

    try {
      await mkdir(lockDir, { recursive: true });
      await writeFile(path.join(lockDir, "instance.lock.json"), JSON.stringify({
        pid: process.pid,
        token: "test",
        acquiredAt: "2026-05-25T00:00:00.000Z",
      }));

      const handled = await runCli(["lark", "status"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkDetectCli: async () => ({ available: true, version: "lark-cli version 1.0.40" }),
      } as Parameters<typeof runCli>[1] & {
        larkDetectCli: () => Promise<{ available: boolean; version?: string }>;
      });

      expect(handled).toBe(true);
      const output = messages.join("\n");
      expect(output).toContain(`Service: running pid ${process.pid}`);
      expect(output).toContain("Inspect: node dist/src/index.js lark doctor");
      expect(output).toContain("Logs: node dist/src/index.js lark service logs");
      expect(output).not.toContain("Run: node dist/src/index.js lark service start");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("reports Lark operational state in status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "config.json"),
        JSON.stringify({
          engine: "codex",
          model: "gpt-5.4",
          effort: "xhigh",
          codexServiceTier: "fast",
          approvalMode: "full-auto",
          budgetUsd: 12.5,
          locale: "zh",
          verbosity: 2,
          timezone: "Asia/Shanghai",
          groupMode: {
            enabled: true,
            allowedChatIds: [111, 222],
            listenAllChatIds: [111],
          },
        }),
        "utf8",
      );
      await new LarkGroupModeStore(stateDir).setListenAll("oc_group", true);
      const cronStore = new CronStore(stateDir);
      await cronStore.add({
        channel: "lark",
        chatId: 111,
        userId: 333,
        cronExpr: "0 9 * * *",
        prompt: "daily briefing",
      });
      await cronStore.add({
        channel: "lark",
        chatId: 111,
        userId: 333,
        cronExpr: "0 10 * * *",
        prompt: "disabled briefing",
        enabled: false,
      });

      const handled = await runCli(["lark", "status"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("Engine: codex");
      expect(output).toContain("Model: gpt-5.4");
      expect(output).toContain("Effort: xhigh");
      expect(output).toContain("Codex Fast Mode: on");
      expect(output).toContain("Approval mode: YOLO/full-auto");
      expect(output).toContain("Budget: $12.50");
      expect(output).toContain("Locale: zh");
      expect(output).toContain("Verbosity: 2");
      expect(output).toContain("Timezone: Asia/Shanghai");
      expect(output).toMatch(/Lark CLI: available \(lark-cli version \d+\.\d+\.\d+\)/);
      expect(output).toContain("Allowed Lark groups: 2");
      expect(output).toContain("Listen-all Lark groups: 1");
      expect(output).toContain("Group-all platform scopes: require im:message and im:message.group_msg");
      expect(output).toContain("Lark cron jobs: 2 (enabled 1)");
      expect(output.indexOf("Listen-all Lark groups: 1")).toBeLessThan(output.indexOf("Group-all platform scopes: require im:message and im:message.group_msg"));
      expect(output.indexOf("Group-all platform scopes: require im:message and im:message.group_msg")).toBeLessThan(output.indexOf("Lark cron jobs: 2 (enabled 1)"));
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not report listen-all Lark groups as active while group mode is disabled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "config.json"),
        JSON.stringify({
          groupMode: {
            enabled: false,
            allowedChatIds: [111],
          },
        }),
        "utf8",
      );
      await new LarkGroupModeStore(stateDir).setListenAll("oc_group", true);

      await runCli(["lark", "status"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });

      const output = messages.join("\n");
      expect(output).toContain("Allowed Lark groups: 1");
      expect(output).toContain("Listen-all Lark groups: 0");
      expect(output).not.toContain("Group-all platform scopes: require im:message and im:message.group_msg");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("restarts the managed Lark service through the lark service command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const stop = vi.fn(async () => "stopped" as const);
    const start = vi.fn(async () => "started" as const);
    const waitUntilRunning = vi.fn(async () => undefined);

    try {
      const handled = await runCli(["lark", "service", "restart"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkServiceDeps: { start, stop, waitUntilRunning },
      });

      expect(handled).toBe(true);
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({
        stateDir,
        logPath: path.join(stateDir, "lark-service.log"),
      }));
      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        stateDir,
        logPath: path.join(stateDir, "lark-service.log"),
        entrypoint: expect.stringContaining(path.join("dist", "src", "index.js")),
      }));
      expect(waitUntilRunning).toHaveBeenCalledWith(expect.objectContaining({ stateDir }));
      expect(messages.join("\n")).toContain("Stopped Lark service.");
      expect(messages.join("\n")).toContain("Started Lark service.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("stops duplicate lockless Lark service processes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const killed = new Set<number>();
    const killProcess = vi.fn((pid: number) => {
      killed.add(pid);
    });

    try {
      const handled = await runCli(["lark", "service", "stop"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkServiceDeps: {
          findProcessIds: async () => [54321, 54322],
          isProcessAlive: (pid: number) => (pid === 54321 || pid === 54322) && !killed.has(pid),
          killProcess,
          sleep: async () => undefined,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(["Stopped Lark service."]);
      expect(killProcess).toHaveBeenCalledWith(54321);
      expect(killProcess).toHaveBeenCalledWith(54322);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("removes a stale Lark service lock when stopping a non-running service", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const lockPath = resolveLarkServiceLockPath(stateDir);
    const messages: string[] = [];

    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify({
        pid: 54321,
        token: "stale-token",
        acquiredAt: new Date().toISOString(),
      }));

      const handled = await runCli(["lark", "service", "stop"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkServiceDeps: {
          findProcessIds: async () => [],
          isProcessAlive: () => false,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(["Lark service is not running."]);
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not kill an unrelated legacy Lark tmux session when stopping an empty state dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const killTmuxSession = vi.fn(async () => undefined);

    try {
      const handled = await runCli(["lark", "service", "stop"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkServiceDeps: {
          findProcessIds: async () => [],
          isProcessAlive: () => false,
          killTmuxSession,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(["Lark service is not running."]);
      expect(killTmuxSession).toHaveBeenCalledWith(expect.stringMatching(/^cctb-lark-service-/));
      expect(killTmuxSession).not.toHaveBeenCalledWith("cctb-lark-service");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("removes the Lark service lock after stopping the locked process", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const lockPath = resolveLarkServiceLockPath(stateDir);
    const messages: string[] = [];
    const killed = new Set<number>();

    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify({
        pid: 54321,
        token: "locked-token",
        acquiredAt: new Date().toISOString(),
      }));

      const handled = await runCli(["lark", "service", "stop"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkServiceDeps: {
          findProcessIds: async () => [],
          isProcessAlive: (pid: number) => pid === 54321 && !killed.has(pid),
          killProcess: (pid: number) => {
            killed.add(pid);
          },
          killTmuxSession: async () => undefined,
          sleep: async () => undefined,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(["Stopped Lark service."]);
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("persists direct Lark credentials before starting the managed service", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const start = vi.fn(async () => "started" as const);
    const waitUntilRunning = vi.fn(async () => undefined);

    try {
      const handled = await runCli(["lark", "service", "start"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_direct",
          LARK_APP_SECRET: "direct-secret",
          LARK_DOMAIN: "feishu",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        larkServiceDeps: { start, waitUntilRunning },
      });

      expect(handled).toBe(true);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ stateDir }));
      await expect(readFile(path.join(stateDir, "lark.env"), "utf8")).resolves.toContain("LARK_APP_ID=\"cli_direct\"");
      await expect(readFile(path.join(stateDir, "lark.env"), "utf8")).resolves.toContain("LARK_APP_SECRET=\"direct-secret\"");
      await expect(readFile(path.join(stateDir, "lark.env"), "utf8")).resolves.toContain(`CCTB_LARK_STATE_DIR="${stateDir}"`);
      await expect(readFile(path.join(stateDir, "lark.env"), "utf8")).resolves.toContain("LARK_DOMAIN=\"feishu\"");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("builds managed Lark service commands with explicit state dir but no secrets", () => {
    const command = buildLarkServiceStartCommand({
      env: {
        USERPROFILE: "/Users/tester",
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "super-secret",
        CCTB_LARK_STATE_DIR: "/tmp/cctb lark",
        TAROCUB_INSTANCE: "lark-alpha",
      },
      stateDir: "/tmp/cctb lark",
      logPath: "/tmp/cctb lark/lark-service.log",
      entrypoint: "/repo/dist/src/index.js",
      cwd: "/repo",
    });

    expect(command).toContain("CCTB_LARK_STATE_DIR=");
    expect(command).toContain("TAROCUB_INSTANCE='lark-alpha'");
    expect(command).not.toContain("CODEX_TELEGRAM_INSTANCE");
    expect(command).toContain("/tmp/cctb lark");
    expect(command).toContain(" lark run ");
    expect(command).not.toContain("super-secret");
    expect(command).not.toContain("LARK_APP_SECRET");
  });

  it("prints Lark run help instead of starting the service from the CLI parser", async () => {
    const messages: string[] = [];

    const handled = await runCli(["lark", "run", "--help"], {
      env: { USERPROFILE: "/Users/tester" },
      logger: { log: (message) => messages.push(message) },
    });

    expect(handled).toBe(true);
    expect(messages).toEqual(["Usage: node dist/src/index.js lark run"]);
  });

  it("does not treat the tmux wrapper command as a duplicate Lark service process", () => {
    const entrypoint = "/repo/dist/src/index.js";
    const psOutput = [
      `87623 tmux new-session -d -s cctb-lark-service cd '/repo' && CCTB_LARK_STATE_DIR='/tmp/lark' CODEX_TELEGRAM_INSTANCE='lark' '/opt/homebrew/bin/node' '${entrypoint}' lark run >> '/tmp/lark/lark-service.log' 2>&1`,
      `87624 /opt/homebrew/bin/node ${entrypoint} lark run`,
      `87625 /bin/zsh -lc ps -axo pid=,command= | rg "lark run|cctb-lark-service" || true`,
    ].join("\n");

    expect(findLarkServiceProcessIdsFromPs(psOutput, {
      env: {},
      stateDir: "/tmp/lark",
      logPath: "/tmp/lark/lark-service.log",
      entrypoint,
      cwd: "/repo",
    }, 99999)).toEqual([87624]);
  });

  it("prints managed Lark service logs through the lark service command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const readLogs = vi.fn(async () => "first\nsecond");

    try {
      const handled = await runCli(["lark", "service", "logs", "5"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkServiceDeps: { readLogs },
      });

      expect(handled).toBe(true);
      expect(readLogs).toHaveBeenCalledWith({
        stateDir,
        logPath: path.join(stateDir, "lark-service.log"),
        tail: 5,
      });
      expect(messages).toEqual(["first\nsecond"]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("diagnoses Lark channel configuration without printing secrets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const inspectApp = vi.fn(async () => ({
      grantedScopes: ["im:message:send_as_bot"],
      missingScopes: [],
      unauthorizedScopes: [],
      subscribedCallbacks: ["card.action.trigger"],
      missingCallbacks: [],
      subscribedEvents: ["im.message.receive_v1", "drive.notice.comment_add_v1"],
      missingEvents: [],
      missingOptionalEvents: [],
      canPatchSubscriptions: true,
      subscriptionPatchScopeOptions: ["application:application", "admin:app.category:update"],
      applied: false,
      patchedSubscriptions: false,
    }));

    try {
      const handled = await runCli(["lark", "doctor"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "super-secret",
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
        larkInspectApp: inspectApp,
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(inspectApp).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_a",
        appSecret: "super-secret",
      }));
      expect(output).toContain("Lark channel doctor");
      expect(output).toContain("ok LARK_APP_ID");
      expect(output).toContain("ok LARK_APP_SECRET");
      expect(output).toContain("State dir:");
      expect(output).toContain("Service lock:");
      expect(output).toContain("ok Lark required scopes: ok");
      expect(output).toContain("ok Lark message event: ok");
      expect(output).toContain("ok Lark card callback: ok");
      expect(output).toContain("ok Lark doc-comment event: ok");
      expect(output).not.toContain("super-secret");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("redacts JSON-style Lark provisioning errors in doctor output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const inspectApp = vi.fn(async () => {
      throw new Error('failed with "client_secret":"json-secret" access_token: token-secret Authorization: Bearer bearer-secret');
    });

    try {
      const handled = await runCli(["lark", "doctor"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "super-secret",
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
        larkInspectApp: inspectApp,
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).not.toContain("json-secret");
      expect(output).not.toContain("token-secret");
      expect(output).not.toContain("bearer-secret");
      expect(output).toContain('"client_secret":"[redacted]"');
      expect(output).toContain("access_token: [redacted]");
      expect(output).toContain("Authorization: Bearer [redacted]");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("warns in Lark doctor when the service lock is stale", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const inspectApp = vi.fn(async () => ({
      grantedScopes: ["im:message:send_as_bot"],
      missingScopes: [],
      unauthorizedScopes: [],
      subscribedCallbacks: ["card.action.trigger"],
      missingCallbacks: [],
      subscribedEvents: ["im.message.receive_v1", "drive.notice.comment_add_v1"],
      missingEvents: [],
      missingOptionalEvents: [],
      canPatchSubscriptions: true,
      subscriptionPatchScopeOptions: ["application:application", "admin:app.category:update"],
      applied: false,
      patchedSubscriptions: false,
    }));

    try {
      await mkdir(path.dirname(resolveLarkServiceLockPath(stateDir)), { recursive: true });
      await writeFile(resolveLarkServiceLockPath(stateDir), JSON.stringify({
        pid: 54321,
        token: "stale-token",
        acquiredAt: new Date().toISOString(),
      }));

      const handled = await runCli(["lark", "doctor"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkInspectApp: inspectApp,
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("warn Service lock: stale pid 54321");
      expect(output).not.toContain("ok Service lock: stale pid 54321");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("uses the injected Lark app inspector for lark service doctor", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-service-doctor-"));
    const messages: string[] = [];
    const inspectApp = vi.fn(async () => ({
      grantedScopes: ["im:message:send_as_bot"],
      missingScopes: [],
      unauthorizedScopes: [],
      subscribedCallbacks: ["card.action.trigger"],
      missingCallbacks: [],
      subscribedEvents: ["im.message.receive_v1", "drive.notice.comment_add_v1"],
      missingEvents: [],
      missingOptionalEvents: [],
      canPatchSubscriptions: true,
      subscriptionPatchScopeOptions: ["application:application", "admin:app.category:update"],
      applied: false,
      patchedSubscriptions: false,
    }));

    try {
      const handled = await runCli(["lark", "service", "doctor"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "service-secret",
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
        larkInspectApp: inspectApp,
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(inspectApp).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_a",
        appSecret: "service-secret",
      }));
      expect(output).toContain("ok Lark card callback: ok");
      expect(output).not.toContain("service-secret");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("sends text and files through the Lark CLI send command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-send-"));
    const stateDir = path.join(tempDir, "lark-state");
    const filePath = path.join(tempDir, "report.txt");
    const messages: string[] = [];
    const send = vi.fn(async () => ({ messageId: "om_sent" }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(filePath, "report body");
      await writeFile(path.join(stateDir, "lark-chat-id-map.json"), JSON.stringify({
        "123": "lark:oc_auto",
      }));

      const handled = await runCli(["lark", "send", "--chat", "oc_auto", "--message", "hello", "--file", filePath], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "send-secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkSendDeps: {
          createChannel: vi.fn(() => ({
            send,
            stream: vi.fn(),
            downloadResource: vi.fn(),
          }) as never),
        },
      });

      expect(handled).toBe(true);
      expect(send).toHaveBeenCalledWith(
        "oc_auto",
        {
          file: {
            source: Buffer.from("report body"),
            fileName: "report.txt",
          },
        },
        undefined,
      );
      expect(send).toHaveBeenCalledWith(
        "oc_auto",
        { markdown: "hello" },
        undefined,
      );
      expect(messages).toEqual(["Sent to Lark chat oc_auto."]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("requires an explicit Lark chat target instead of guessing from saved chats", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-send-explicit-"));
    const stateDir = path.join(tempDir, "lark-state");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "lark-chat-id-map.json"), JSON.stringify({
        "123": "lark:oc_only_seen_chat",
      }));

      await expect(runCli(["lark", "send", "--message", "hello"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "send-secret",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        larkSendDeps: {
          createChannel: vi.fn(() => ({
            send: vi.fn(),
            stream: vi.fn(),
            downloadResource: vi.fn(),
          }) as never),
        },
      })).rejects.toThrow("lark send requires --chat <oc_xxx>");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("shows Lark CLI send usage without requiring configured credentials", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-send-help-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["lark", "send", "--help"], {
        env: {
          USERPROFILE: tempDir,
        },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages.join("\n")).toContain("Usage: lark send");
      expect(messages.join("\n")).toContain("--reply-to <message-id>");
      expect(messages.join("\n")).toContain("--thread");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("provisions an existing Lark app without printing secrets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
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
      patchedSubscriptions: true,
    }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "provision"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkProvisionApp: provisionApp,
      });

      expect(handled).toBe(true);
      expect(provisionApp).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_from_file",
        appSecret: "secret-from-file",
        domain: "feishu",
      }));
      const output = messages.join("\n");
      expect(output).toContain("Lark app provisioning");
      expect(output).toContain("Lark websocket event/callback subscriptions updated.");
      expect(output).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("serves Lark app secrets through the exec-provider protocol without extra output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-secrets-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "secrets", "get"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        stdinText: JSON.stringify({
          protocolVersion: 1,
          provider: "bridge",
          ids: ["app-cli_from_file", "app-missing"],
        }),
      } as Parameters<typeof runCli>[1] & { stdinText: string });

      expect(handled).toBe(true);
      expect(messages).toHaveLength(1);
      const parsed = JSON.parse(messages[0]!) as {
        protocolVersion: number;
        values: Record<string, string>;
        errors?: Record<string, { message: string }>;
      };
      expect(parsed.protocolVersion).toBe(1);
      expect(parsed.values).toEqual({ "app-cli_from_file": "secret-from-file" });
      expect(parsed.errors?.["app-missing"]?.message).toBe("not found");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("initializes lark-cli from bridge credentials without putting the app secret in argv or output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-cli-init-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({ stdout: "initialized\n", stderr: "" }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "cli", "init"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; stdinText?: string }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "init", "--app-id", "cli_from_file", "--app-secret-stdin", "--brand", "feishu"],
        stdinText: "secret-from-file\n",
      }));
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("--app-secret=secret-from-file");
      expect(messages.join("\n")).toContain("lark-cli config initialized from bridge credentials.");
      expect(messages.join("\n")).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("binds lark-cli through a lark-channel source wrapper without leaking the app secret to the child env", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-cli-bind-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async (_input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => ({ stdout: "bound\n", stderr: "" }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "cli", "bind", "--identity", "bot-only"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "bind", "--source", "lark-channel", "--app-id", "cli_from_file", "--identity", "bot-only"],
      }));
      const [bindCall] = runCommand.mock.calls;
      const childEnv = bindCall?.[0].env;
      expect(childEnv?.LARK_CHANNEL).toBe("1");
      expect(childEnv?.CCTB_LARK_STATE_DIR).toBe(stateDir);
      expect(childEnv).not.toHaveProperty("LARK_APP_SECRET");
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("secret-from-file");

      const sourceConfig = await readFile(path.join(tempDir, ".lark-channel", "config.json"), "utf8");
      expect(sourceConfig).toContain('"source": "exec"');
      expect(sourceConfig).toContain('"id": "app-cli_from_file"');
      expect(sourceConfig).not.toContain("secret-from-file");
      const wrapper = await readFile(path.join(tempDir, ".lark-channel", "secrets-getter"), "utf8");
      expect(wrapper).toContain("lark secrets get");
      expect(wrapper).toContain(stateDir);
      expect(wrapper).not.toContain("secret-from-file");
      expect(messages.join("\n")).toContain("lark-cli bound to bridge credentials with bot-only identity.");
      expect(messages.join("\n")).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("preflights lark-cli by installing on request and opting into user-default identity without leaking secrets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-cli-preflight-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => {
      if (input.file === "lark-cli" && input.args[0] === "--version") {
        throw new Error("spawn lark-cli ENOENT");
      }
      if (input.file === "npm") {
        return { stdout: "installed\n", stderr: "" };
      }
      return { stdout: "ok\n", stderr: "" };
    });

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "cli", "preflight", "--install", "--identity", "user-default"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "npm",
        args: ["install", "-g", "@larksuite/cli"],
      }));
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: [
          "config",
          "bind",
          "--source",
          "lark-channel",
          "--app-id",
          "cli_from_file",
          "--identity",
          "user-default",
        ],
      }));
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "default-as", "user"],
      }));
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "strict-mode", "off"],
      }));
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("secret-from-file");
      const output = messages.join("\n");
      expect(output).toContain("lark-cli preflight complete.");
      expect(output).toContain("identity: user-default");
      expect(output).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("switches lark-cli back to bot-only identity with a strict bot policy", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-cli-identity-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "cli", "identity", "bot-only"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "bind", "--source", "lark-channel", "--app-id", "cli_from_file", "--identity", "bot-only"],
      }));
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "default-as", "bot"],
      }));
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "strict-mode", "bot"],
      }));
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("secret-from-file");
      expect(messages.join("\n")).toContain("lark-cli identity set to bot-only.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("starts two-step Lark OAuth through lark-cli without blocking for browser approval", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-auth-start-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        verification_url: "https://open.feishu.cn/device",
        device_code: "device-123",
        user_code: "ABCD-EFGH",
        expires_in: 600,
      }),
      stderr: "",
    }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );
      const handled = await runCli(["lark", "auth", "start", "--recommend", "--domain", "docs,drive"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["auth", "login", "--no-wait", "--json", "--recommend", "--domain", "docs,drive"],
        env: expect.objectContaining({
          LARK_CHANNEL: "1",
          CCTB_LARK_STATE_DIR: stateDir,
        }),
      }));
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("secret-from-file");
      const output = messages.join("\n");
      expect(output).toContain("Lark OAuth started.");
      expect(output).toContain("https://open.feishu.cn/device");
      expect(output).toContain("Device code: device-123");
      expect(output).toContain("node dist/src/index.js lark auth finish device-123");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("runs an aggregate Lark setup flow without leaking the app secret", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-setup-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const inspectApp = vi.fn(async () => ({
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

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "setup", "--skip-wizard", "--install-cli", "--identity", "user-default", "--skip-provision"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
        larkInspectApp: inspectApp,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["config", "bind", "--source", "lark-channel", "--app-id", "cli_from_file", "--identity", "user-default"],
      }));
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["auth", "status", "--verify"],
      }));
      expect(inspectApp).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_from_file",
        appSecret: "secret-from-file",
        domain: "feishu",
      }));
      const output = messages.join("\n");
      expect(output).toContain("Lark setup complete.");
      expect(output).toContain("wizard: skipped");
      expect(output).toContain("lark-cli: ok");
      expect(output).toContain("doctor: ok");
      expect(output).not.toContain("secret-from-file");
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("builds a detached Lark setup command that keeps the QR wizard alive", () => {
    const stateDir = path.join(os.tmpdir(), "tarocub lark detached");
    const logPath = path.join(stateDir, "lark-setup.log");
    const command = buildDetachedLarkSetupCommand({
      cwd: "/repo with spaces",
      entrypoint: "/repo with spaces/dist/src/index.js",
      stateDir,
      logPath,
      env: {
        CCTB_LARK_INSTANCE: "ccfgg2",
        CCTB_LARK_STATE_DIR: stateDir,
      },
      args: ["--detached", "--install-cli", "--identity", "bot-only"],
    });

    expect(command).toContain("cd '/repo with spaces'");
    expect(command).toContain(`CCTB_LARK_STATE_DIR='${stateDir}'`);
    expect(command).toContain("CCTB_LARK_INSTANCE='ccfgg2'");
    expect(command).toContain("TAROCUB_INSTANCE='ccfgg2'");
    expect(command).toContain("env -u LARK_APP_ID -u LARK_APP_SECRET -u LARK_DOMAIN");
    expect(command).toContain("lark setup '--install-cli' '--identity' 'bot-only'");
    expect(command).toContain(`> '${logPath}' 2>&1`);
    expect(command).not.toContain("--detached");
  });

  it("drops a stale ambient Lark state dir when setup targets a different instance", () => {
    const env = resolveLarkSetupTargetEnv({
      HOME: "/Users/tester",
      CCTB_LARK_INSTANCE: "ccfgg3",
      CCTB_LARK_STATE_DIR: "/Users/tester/.cctb/ccfgg2",
      CODEX_TELEGRAM_STATE_DIR: "/Users/tester/.cctb/ccfgg2",
    });

    expect(env).toMatchObject({
      HOME: "/Users/tester",
      CCTB_LARK_INSTANCE: "ccfgg3",
    });
    expect(env.CCTB_LARK_STATE_DIR).toBeUndefined();
    expect(env.CODEX_TELEGRAM_STATE_DIR).toBeUndefined();
  });

  it("keeps an explicit matching Lark state dir when setup targets the same instance", () => {
    const env = resolveLarkSetupTargetEnv({
      HOME: "/Users/tester",
      CCTB_LARK_INSTANCE: "ccfgg3",
      CCTB_LARK_STATE_DIR: "/Users/tester/.cctb/ccfgg3",
    });

    expect(env.CCTB_LARK_STATE_DIR).toBe("/Users/tester/.cctb/ccfgg3");
  });

  it("prints the recommended Lark OAuth command when setup finds missing user identity", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-setup-auth-missing-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async (input: { args: string[] }) => {
      if (input.args.join(" ") === "auth status --verify") {
        throw new Error("User identity: missing");
      }
      return { stdout: "ok\n", stderr: "" };
    });
    const inspectApp = vi.fn(async () => ({
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

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "setup", "--skip-wizard", "--identity", "bot-only", "--skip-provision"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
        larkInspectApp: inspectApp,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      const output = messages.join("\n");
      expect(output).toContain("auth: attention needed");
      expect(output).toContain("node dist/src/index.js lark auth start --recommend --domain docs,drive");
      expect(output).toContain("sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read");
      expect(output).toContain("node dist/src/index.js lark auth finish <device-code>");
      expect(output).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("can start the managed Lark service as part of setup", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-setup-start-service-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const start = vi.fn(async () => "started" as const);
    const waitUntilRunning = vi.fn(async () => undefined);
    const inspectApp = vi.fn(async () => ({
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

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "setup", "--skip-wizard", "--skip-provision", "--skip-auth", "--start-service"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
        larkInspectApp: inspectApp,
        larkServiceDeps: { start, waitUntilRunning },
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        stateDir,
        logPath: path.join(stateDir, "lark-service.log"),
      }));
      expect(waitUntilRunning).toHaveBeenCalled();
      expect(messages.join("\n")).toContain("service: started");
      expect(messages.join("\n")).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not start the managed Lark service when setup still needs required Lark permissions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-setup-missing-permissions-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({ stdout: "ok\n", stderr: "" }));
    const start = vi.fn(async () => "started" as const);
    const waitUntilRunning = vi.fn(async () => undefined);
    const provisioning = {
      grantedScopes: ["im:message:send_as_bot"],
      missingScopes: ["im:message.group_msg"],
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
    };
    const provisionApp = vi.fn(async () => provisioning);
    const inspectApp = vi.fn(async () => provisioning);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );

      const handled = await runCli(["lark", "setup", "--skip-wizard", "--skip-auth", "--start-service"], {
        env: {
          HOME: tempDir,
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
        larkProvisionApp: provisionApp,
        larkInspectApp: inspectApp,
        larkServiceDeps: { start, waitUntilRunning },
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(start).not.toHaveBeenCalled();
      expect(waitUntilRunning).not.toHaveBeenCalled();
      const output = messages.join("\n");
      expect(output).toContain("provision: attention needed");
      expect(output).toContain("doctor: attention needed");
      expect(output).toContain("service: skipped (fix Lark permissions first)");
      expect(output).toContain('"im:message.group_msg"');
      expect(output).not.toContain("secret-from-file");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("finishes Lark OAuth by polling the device code in the foreground", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-lark-auth-finish-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const runCommand = vi.fn(async () => ({ stdout: "login ok\n", stderr: "" }));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "lark.env"),
        [
          'LARK_APP_ID="cli_from_file"',
          'LARK_APP_SECRET="secret-from-file"',
          `CCTB_LARK_STATE_DIR="${stateDir}"`,
          'LARK_DOMAIN="feishu"',
          "",
        ].join("\n"),
      );
      const handled = await runCli(["lark", "auth", "finish", "device-123"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
        larkRunCommand: runCommand,
      } as Parameters<typeof runCli>[1] & {
        larkRunCommand: (input: { file: string; args: string[]; env?: Record<string, string | undefined>; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
      });

      expect(handled).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        file: "lark-cli",
        args: ["auth", "login", "--device-code", "device-123"],
        env: expect.objectContaining({
          LARK_CHANNEL: "1",
          CCTB_LARK_STATE_DIR: stateDir,
        }),
        timeoutMs: 11 * 60 * 1000,
      }));
      expect(JSON.stringify(runCommand.mock.calls)).not.toContain("secret-from-file");
      expect(messages.join("\n")).toContain("Lark OAuth finished.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("prints a copyable Lark permission JSON without app credentials", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["lark", "permissions"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("Lark required scopes JSON");
      expect(output).toContain("Feishu/Lark Developer Console");
      expect(output).toContain("Permissions");
      expect(output).toContain("bulk import");
      expect(output).toContain("Publish the app version");
      expect(output).toContain("node dist/src/index.js lark provision");
      expect(output).toContain("node dist/src/index.js lark doctor");
      expect(output).toContain('"im:message.group_msg"');
      expect(output).toContain('"cardkit:card:write"');
      expect(output).toContain('"docs:permission.member:create"');
      expect(output).toContain('"docs:document.comment:create"');
      expect(output).not.toContain("secret");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("prints only currently missing Lark permissions when requested", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const inspectApp = vi.fn(async () => ({
      grantedScopes: ["im:message:send_as_bot"],
      missingScopes: ["im:message.group_msg"],
      unauthorizedScopes: ["docs:document.comment:create"],
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

    try {
      const handled = await runCli(["lark", "permissions", "--missing"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "super-secret",
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
        larkInspectApp: inspectApp,
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(inspectApp).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_a",
        appSecret: "super-secret",
      }));
      expect(output).toContain("Lark missing scopes JSON");
      expect(output).toContain('"im:message.group_msg"');
      expect(output).toContain('"tenant":["im:message.group_msg"]');
      expect(output).toContain("Publish the app version");
      expect(output).toContain("node dist/src/index.js lark provision");
      expect(output).toContain("node dist/src/index.js lark doctor");
      expect(output).not.toContain('"im:message:send_as_bot"');
      expect(output).not.toContain("super-secret");
      expect(output).toContain("Already configured but awaiting approval: docs:document.comment:create");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("falls back to the full Lark permission JSON when missing-scope inspection fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const inspectApp = vi.fn(async () => {
      throw new Error("Lark scope list failed: temporary token fetch failure");
    });

    try {
      const handled = await runCli(["lark", "permissions", "--missing"], {
        env: {
          USERPROFILE: tempDir,
          LARK_APP_ID: "cli_a",
          LARK_APP_SECRET: "super-secret",
          CCTB_LARK_STATE_DIR: path.join(tempDir, "lark-state"),
        },
        logger: { log: (message) => messages.push(message) },
        larkInspectApp: inspectApp,
      });

      const output = messages.join("\n");
      expect(handled).toBe(true);
      expect(output).toContain("Could not inspect currently missing scopes");
      expect(output).toContain("temporary token fetch failure");
      expect(output).toContain("Fallback full required scopes JSON");
      expect(output).toContain("im:message.reactions:write_only");
      expect(output).not.toContain("super-secret");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("manages Lark access in the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      const store = new AccessStore(path.join(stateDir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date(),
      });

      await runCli(["lark", "access", "pair", issued.code], {
        env: {
          USERPROFILE: tempDir,
          CODEX_TELEGRAM_INSTANCE: "bot6",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "access", "policy", "allowlist"], {
        env: {
          USERPROFILE: tempDir,
          CODEX_TELEGRAM_INSTANCE: "bot6",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "access", "allow", "84"], {
        env: {
          USERPROFILE: tempDir,
          CODEX_TELEGRAM_INSTANCE: "bot6",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "access", "status"], {
        env: {
          USERPROFILE: tempDir,
          CODEX_TELEGRAM_INSTANCE: "bot6",
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });

      expect((await store.getStatus()).pairedUsers).toBe(1);
      expect(await readFile(path.join(stateDir, "access.json"), "utf8")).toContain("84");
      await expect(readFile(path.join(stateDir, "agent.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(messages).toEqual([
        'Redeemed pairing code for instance "lark" and chat 84.',
        'Updated access policy for instance "lark" to "allowlist".',
        'Allowed chat 84 for instance "lark".',
        "Instance: lark\nPolicy: allowlist\nMulti-chat: off\nPaired users: 1\nAllowlist: 84\nPending pairs: none",
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("refuses to mutate default Lark access when no Lark app is configured", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const defaultLarkDir = path.join(tempDir, ".cctb", "lark");

    try {
      await expect(runCli(["lark", "access", "allow", "1315066031"], {
        env: { USERPROFILE: tempDir },
      })).rejects.toThrow("Set CCTB_LARK_INSTANCE=<name> or run lark setup first.");
      await expect(readFile(path.join(defaultLarkDir, "access.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("warns when allowing a Lark chat under pairing policy", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await runCli(["lark", "access", "allow", "1315066031"], {
        env: {
          USERPROFILE: tempDir,
          CCTB_LARK_STATE_DIR: stateDir,
        },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages).toEqual([
        'Allowed chat 1315066031 for instance "lark".',
        "Note: current policy is pairing; private chats still require `lark access pair <code>` to authorize the user.",
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("updates an existing .env file instead of replacing unrelated lines", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const envPath = path.join(tempDir, ".cctb", "default", ".env");
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, "EXTRA=1\nTELEGRAM_BOT_TOKEN=old-token\nKEEP=2\n", "utf8");
      const agentPath = path.join(tempDir, ".cctb", "default", "agent.md");
      await writeFile(agentPath, "custom instructions", "utf8");

      await runCli(["telegram", "configure", "new-token"], {
        env: { USERPROFILE: tempDir },
      });

      await expect(readFile(envPath, "utf8")).resolves.toBe("EXTRA=1\nKEEP=2\nTELEGRAM_BOT_TOKEN=\"new-token\"\n");
      await expect(readFile(agentPath, "utf8")).resolves.toBe("custom instructions");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("sends attachments through the configured instance when no active turn side-channel is present", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const filePath = path.join(tempDir, "project", "chart.png");
    const api = {
      sendMessage: vi.fn(),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
      sendVoice: vi.fn(),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "png", "utf8");
      await new SessionStore(path.join(tempDir, ".cctb", "default", "session.json")).upsert({
        telegramChatId: 84,
        codexSessionId: "telegram-84",
        status: "idle",
        updatedAt: new Date().toISOString(),
      });

      const handled = await runCli([
        "send",
        "--message",
        "Chart ready",
        "--file",
        filePath,
      ], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
        sendDeps: {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
          deliverTelegramResponse,
        },
      });

      expect(handled).toBe(true);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        api,
        84,
        `Chart ready\n[send-file:${filePath}]`,
        path.join(tempDir, ".cctb", "default", "inbox"),
        path.join(tempDir, "project"),
        undefined,
        "en",
        expect.objectContaining({
          allowAnyAbsolutePath: true,
        }),
      );
      expect(messages).toEqual(["Sent to Telegram chat 84 (1 file)."]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("surfaces configured send rejection details when a requested file cannot be delivered", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const missingPath = path.join(tempDir, "project", "missing.pdf");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await mkdir(path.dirname(missingPath), { recursive: true });

      await expect(runCli([
        "send",
        "--chat",
        "84",
        "--file",
        missingPath,
      ], {
        env: { USERPROFILE: tempDir },
        sendDeps: {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
        },
      })).rejects.toThrow(`1 file not delivered: ${missingPath} — not-found`);
      expect(api.sendMessage).toHaveBeenCalledWith(84, expect.stringContaining(missingPath));
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("fails configured send with a readable error for oversized files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const largePath = path.join(tempDir, "project", "large.bin");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await mkdir(path.dirname(largePath), { recursive: true });
      await writeFile(largePath, "");
      await truncate(largePath, 50_000_001);

      await expect(runCli([
        "send",
        "--chat",
        "84",
        "--file",
        largePath,
      ], {
        env: { USERPROFILE: tempDir },
        sendDeps: {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
        },
      })).rejects.toThrow(`1 file not delivered: ${largePath} — too-large`);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith(84, expect.stringContaining("too large"));
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("routes send through the active turn side-channel when CCTB_SEND_URL is set", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    try {
      vi.stubGlobal("fetch", fetchFn);

      const handled = await runCli([
        "send",
        "--instance",
        "bot2",
        "--chat",
        "84",
        "--message",
        "Chart ready",
        "--file",
        "/tmp/chart.png",
      ], {
        env: {
          USERPROFILE: tempDir,
          CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
          CCTB_SEND_TOKEN: "secret",
        },
        logger: {
          log: (message) => messages.push(message),
        },
        sendDeps: {
          readConfiguredBotToken: vi.fn().mockRejectedValue(new Error("configured fallback should not run")),
        },
      });

      expect(handled).toBe(true);
      expect(fetchFn).toHaveBeenCalledWith(
        "http://127.0.0.1:12345/send/token",
        expect.objectContaining({
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer secret",
          },
          body: JSON.stringify({
            message: "Chart ready",
            images: [],
            files: ["/tmp/chart.png"],
          }),
        }),
      );
      expect(messages).toEqual(["Sent via active Telegram turn."]);
    } finally {
      vi.unstubAllGlobals();
      await removeTempRoot(tempDir);
    }
  });

  it("validates send payload before requiring a configured bot token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await expect(runCli(["send"], {
        env: { USERPROFILE: tempDir },
      })).rejects.toThrow("Usage: send [--message <text>] [--image <path>] [--file <path>] [text]");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("requires --chat for configured send when an instance has multiple sessions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const store = new SessionStore(path.join(tempDir, ".cctb", "default", "session.json"));
      const now = new Date().toISOString();
      await store.upsert({
        telegramChatId: 84,
        codexSessionId: "telegram-84",
        status: "idle",
        updatedAt: now,
      });
      await store.upsert({
        telegramChatId: 85,
        codexSessionId: "telegram-85",
        status: "idle",
        updatedAt: now,
      });

      await expect(runCli(["send", "--message", "hello"], {
        env: { USERPROFILE: tempDir },
        sendDeps: {
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue({
            sendMessage: vi.fn(),
            sendDocument: vi.fn(),
            sendPhoto: vi.fn(),
      sendVoice: vi.fn(),
          }),
        },
      })).rejects.toThrow("Multiple Telegram sessions found; pass --chat <id>.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("redeems a pairing code for the default instance and rejects invalid codes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const accessPath = path.join(tempDir, ".cctb", "default", "access.json");
      const store = new AccessStore(accessPath);
      const issuedAt = new Date();
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: issuedAt,
      });

      const handled = await runCli(["telegram", "access", "pair", issued.code], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Redeemed pairing code for instance "default" and chat 84.']);
      expect((await store.getStatus()).pairedUsers).toBe(1);
      const agentPath = path.join(tempDir, ".cctb", "default", "agent.md");
      await expect(readFile(agentPath, "utf8")).resolves.toContain("## Telegram Transport");

      await expect(
        runCli(["telegram", "access", "pair", "ZZZZZZ"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toThrow('Pairing code "ZZZZZZ" is invalid or expired.');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("supports named-instance access policy, allow, revoke, and status commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const accessPath = path.join(tempDir, ".cctb", "alpha", "access.json");
      const store = new AccessStore(accessPath);
      await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      await runCli(["telegram", "access", "policy", "--instance", "alpha", "allowlist"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "access", "allow", "--instance", "alpha", "123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "access", "revoke", "--instance", "alpha", "123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "access", "allow", "--instance", "alpha", "123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(messages.slice(0, 4)).toEqual([
        'Updated access policy for instance "alpha" to "allowlist".',
        'Allowed chat 123 for instance "alpha".',
        'Revoked chat 123 for instance "alpha".',
        'Allowed chat 123 for instance "alpha".',
      ]);
      expect(messages[4]).toMatch(
        /^Instance: alpha\nPolicy: allowlist\nMulti-chat: off\nPaired users: 0\nAllowlist: 123\nPending pairs: [A-Z2-9]{8} chat 84 expires 2026-04-08T00:05:00\.000Z$/,
      );
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("supports toggling multi-chat per instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      await runCli(["telegram", "access", "multi", "--instance", "alpha", "on"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(messages).toEqual([
        'Set multi-chat for instance "alpha" to on.',
        "Instance: alpha\nPolicy: pairing\nMulti-chat: on\nPaired users: 0\nAllowlist: none\nPending pairs: none",
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("lists and shows session bindings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".cctb", "default", "session.json");
      const store = new SessionStore(sessionPath);
      await store.upsert({
        telegramChatId: 84,
        codexSessionId: "thread-abc",
        status: "idle",
        updatedAt: "2026-04-08T12:00:00.000Z",
      });

      await runCli(["telegram", "session", "list"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      await runCli(["telegram", "session", "show", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages[0]).toContain("Session bindings: 1");
      expect(messages[0]).toContain("chat 84 -> thread-abc");
      expect(messages[1]).toContain("Thread: thread-abc");
      expect(messages[1]).toContain("Status: idle");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("shows the current chat session for a single chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".cctb", "alpha", "session.json");
      const store = new SessionStore(sessionPath);
      await store.upsert({
        telegramChatId: 84,
        codexSessionId: "thread-123",
        status: "idle",
        updatedAt: "2026-04-08T12:00:00.000Z",
      });

      const handled = await runCli(["telegram", "session", "inspect", "--instance", "alpha", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Chat: 84");
      expect(messages[0]).toContain("Thread: thread-123");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects renaming a running instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "instance.lock.json"),
        JSON.stringify({ pid: 12345, token: "token", acquiredAt: new Date().toISOString() }),
        "utf8",
      );

      await expect(
        runCli(["telegram", "instance", "rename", "alpha", "beta"], {
          env: { USERPROFILE: tempDir },
          serviceDeps: {
            cwd: REPO_ROOT,
            isProcessAlive: (pid) => pid === 12345,
            isExpectedServiceProcess: (pid) => pid === 12345,
          },
        }),
      ).rejects.toThrow('Stop instance "alpha" before renaming it.');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not mark an instance as running in instance list when the pid belongs to a different process", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      await mkdir(stateDir, { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", ".restore-backup-alpha"), { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }), "utf8");
      await writeFile(
        path.join(stateDir, "instance.lock.json"),
        JSON.stringify({ pid: process.pid, token: "token", acquiredAt: new Date().toISOString() }),
        "utf8",
      );

      const handled = await runCli(["telegram", "instance", "list"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === process.pid,
          isExpectedServiceProcess: () => false,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual([
        "Instances (1):",
        "  - alpha [claude] stopped",
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects deleting a running instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "instance.lock.json"),
        JSON.stringify({ pid: 12345, token: "token", acquiredAt: new Date().toISOString() }),
        "utf8",
      );

      await expect(
        runCli(["telegram", "instance", "delete", "alpha", "--yes"], {
          env: { USERPROFILE: tempDir },
          serviceDeps: {
            cwd: REPO_ROOT,
            isProcessAlive: (pid) => pid === 12345,
            isExpectedServiceProcess: (pid) => pid === 12345,
          },
        }),
      ).rejects.toThrow('Stop instance "alpha" before deleting it.');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not delete an existing instance before restore validation succeeds", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "keep.txt"), "keep-me", "utf8");

      const badArchivePath = path.join(tempDir, "bad.cctb.gz");
      await writeFile(badArchivePath, "not-an-archive", "utf8");

      await expect(
        runCli(["telegram", "restore", badArchivePath, "--instance", "alpha", "--force"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toThrow();

      await expect(readFile(path.join(stateDir, "keep.txt"), "utf8")).resolves.toBe("keep-me");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("restores over an existing instance by validating first and then replacing it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const channelsDir = path.join(tempDir, ".cctb");
      const sourceDir = path.join(channelsDir, "source");
      const targetDir = path.join(channelsDir, "alpha");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(sourceDir, "access.json"), JSON.stringify({ allowlist: [1] }), "utf8");
      await writeFile(path.join(targetDir, "stale.txt"), "old", "utf8");

      const archivePath = path.join(tempDir, "backup.cctb.gz");
      await createArchive(sourceDir, archivePath);

      const handled = await runCli(["telegram", "restore", archivePath, "--instance", "alpha", "--force"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      await expect(readFile(path.join(targetDir, "access.json"), "utf8")).resolves.toContain('"allowlist"');
      await expect(readFile(path.join(targetDir, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(messages[0]).toContain('Restored instance "alpha"');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("degrades session inspection when session state is unreadable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".cctb", "alpha", "session.json");
      await mkdir(path.dirname(sessionPath), { recursive: true });
      await writeFile(sessionPath, "{not valid json", "utf8");

      const handled = await runCli(["telegram", "session", "inspect", "--instance", "alpha", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual([
        'Session state unreadable for instance "alpha".',
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("clears a file workflow upload by id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      const workflowPath = path.join(stateDir, "file-workflow.json");
      const uploadWorkspaceDir = path.join(stateDir, "workspace", ".telegram-files", "upload-123");
      await mkdir(stateDir, { recursive: true });
      await mkdir(uploadWorkspaceDir, { recursive: true });
      await writeFile(path.join(uploadWorkspaceDir, "artifact.txt"), "payload", "utf8");
      await writeFile(
        workflowPath,
        JSON.stringify({
          records: [
            {
              uploadId: "upload-123",
              chatId: 84,
              userId: 42,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "pending",
              createdAt: "2026-04-08T12:00:00.000Z",
              updatedAt: "2026-04-08T12:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "task", "clear", "--instance", "alpha", "upload-123"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Cleared task "upload-123"');
      const workflowState = JSON.parse(await readFile(workflowPath, "utf8")) as { records: unknown[] };
      expect(workflowState.records).toEqual([]);
      await expect(readFile(path.join(uploadWorkspaceDir, "artifact.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("reports when a file workflow upload is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "task", "clear", "--instance", "alpha", "missing-upload"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('No task found for "missing-upload"');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("repairs unreadable session state during session reset", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".cctb", "alpha", "session.json");
      await mkdir(path.dirname(sessionPath), { recursive: true });
      await writeFile(sessionPath, "{not valid json", "utf8");

      const handled = await runCli(["telegram", "session", "reset", "--instance", "alpha", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Session state was unreadable and has been reset for instance "alpha".');
      expect(JSON.parse(await readFile(sessionPath, "utf8"))).toEqual(expect.objectContaining({ chats: [] }));
      expect(await readdir(path.dirname(sessionPath))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^session\.json\.corrupt\..+\.bak$/)]),
      );
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not self-heal permission-denied session reset", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const removeSpy = vi.spyOn(SessionStore.prototype, "removeByChatIdRecovering");
    removeSpy.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    try {
      await expect(
        runCli(["telegram", "session", "reset", "--instance", "alpha", "84"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      removeSpy.mockRestore();
      await removeTempRoot(tempDir);
    }
  });

  it("resets the current chat session for a single chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".cctb", "alpha", "session.json");
      const store = new SessionStore(sessionPath);
      await store.upsert({
        telegramChatId: 84,
        codexSessionId: "thread-123",
        status: "idle",
        updatedAt: "2026-04-08T12:00:00.000Z",
      });

      const handled = await runCli(["telegram", "session", "reset", "--instance", "alpha", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Reset session for chat 84');
      await expect(store.findByChatId(84)).resolves.toBeNull();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("lists recent file workflow records", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      const workflowPath = path.join(stateDir, "file-workflow.json");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        workflowPath,
        JSON.stringify({
          records: [
            {
              uploadId: "upload-123",
              chatId: 84,
              userId: 42,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "pending",
              createdAt: "2026-04-08T12:00:00.000Z",
              updatedAt: "2026-04-08T14:00:00.000Z",
            },
            {
              uploadId: "upload-456",
              chatId: 84,
              userId: 42,
              kind: "document",
              status: "completed",
              sourceFiles: ["notes.txt"],
              derivedFiles: ["notes.md"],
              summary: "done",
              createdAt: "2026-04-08T13:00:00.000Z",
              updatedAt: "2026-04-08T13:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "task", "list", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Recent file workflow records: 2");
      expect(messages[0].indexOf("upload-123")).toBeLessThan(messages[0].indexOf("upload-456"));
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("surfaces unreadable workflow state during task list instead of pretending it is empty", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const workflowPath = path.join(tempDir, ".cctb", "alpha", "file-workflow.json");
      await mkdir(path.dirname(workflowPath), { recursive: true });
      await writeFile(workflowPath, "{not valid json", "utf8");

      const handled = await runCli(["telegram", "task", "list", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Recent file workflow records: unknown");
      expect(messages[0]).toContain("Warning: file workflow state unreadable");
      expect(messages[0]).not.toContain("Tasks: none");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("degrades task inspection when workflow state is unreadable without claiming absence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const workflowPath = path.join(tempDir, ".cctb", "alpha", "file-workflow.json");
      await mkdir(path.dirname(workflowPath), { recursive: true });
      await writeFile(workflowPath, "{not valid json", "utf8");

      const handled = await runCli(["telegram", "task", "inspect", "--instance", "alpha", "upload-123"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual([
        'Task state unreadable for instance "alpha".',
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("shows updated help wording for inspect-first session and task commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "help"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("session inspect [--instance <name>] <chat-id>");
      expect(messages[0]).not.toContain("session <list|inspect>");
      expect(messages[0]).not.toContain("session <list|show|inspect|reset>");
      expect(messages[0]).toContain("task inspect [--instance <name>] <upload-id>");
      expect(messages[0]).toContain("task clear [--instance <name>] <upload-id>");
      expect(messages[0]).toContain("lark send --chat <oc_xxx> [--reply-to <message-id>] [--thread]");
      expect(messages[0]).toContain("[--stdin]");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("uses inspect-first usage text for session command errors", async () => {
    await expect(
      runCli(["telegram", "session"], {
        env: { USERPROFILE: "C:\\Users\\hangw" },
      }),
    ).rejects.toThrow("Usage: telegram session <list|inspect|reset> ...");
  });

  it("keeps session parser compatibility for show while inspect remains the canonical help surface", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".cctb", "default", "session.json");
      const store = new SessionStore(sessionPath);
      await store.upsert({
        telegramChatId: 84,
        codexSessionId: "thread-abc",
        status: "idle",
        updatedAt: "2026-04-08T12:00:00.000Z",
      });

      const handled = await runCli(["telegram", "session", "show", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Thread: thread-abc");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("inspects a task with source files, extracted directory, and failure detail", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const stateDir = path.join(tempDir, ".cctb", "alpha");
      const workflowPath = path.join(stateDir, "file-workflow.json");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        workflowPath,
        JSON.stringify({
          records: [
            {
              uploadId: "upload-123",
              chatId: 84,
              userId: 42,
              kind: "archive",
              status: "failed",
              sourceFiles: ["repo.zip", "notes.txt"],
              derivedFiles: [],
              summary: "Extraction failed: archive is corrupt",
              extractedPath: "workspace/.telegram-files/upload-123/extracted",
              createdAt: "2026-04-08T12:00:00.000Z",
              updatedAt: "2026-04-08T12:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "task", "inspect", "--instance", "alpha", "upload-123"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Upload: upload-123");
      expect(messages[0]).toContain("Status: failed");
      expect(messages[0]).toContain("Chat: 84");
      expect(messages[0]).toContain("Kind: archive");
      expect(messages[0]).toContain("Source files: repo.zip, notes.txt");
      expect(messages[0]).toContain("Extracted directory: workspace/.telegram-files/upload-123/extracted");
      expect(messages[0]).toContain("Detail: Extraction failed: archive is corrupt");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("repairs unreadable workflow state during task clear", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const workflowPath = path.join(tempDir, ".cctb", "alpha", "file-workflow.json");
      await mkdir(path.dirname(workflowPath), { recursive: true });
      await writeFile(workflowPath, "{not valid json", "utf8");

      const handled = await runCli(["telegram", "task", "clear", "--instance", "alpha", "upload-123"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Task state was unreadable and has been reset for instance "alpha".');
      expect(JSON.parse(await readFile(workflowPath, "utf8"))).toEqual(expect.objectContaining({ records: [] }));
      expect(await readdir(path.dirname(workflowPath))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^file-workflow\.json\.corrupt\..+\.bak$/)]),
      );
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not self-heal permission-denied task clear", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const findSpy = vi.spyOn((await import("../src/state/file-workflow-store.js")).FileWorkflowStore.prototype, "find");
    findSpy.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EPERM" }));

    try {
      await expect(
        runCli(["telegram", "task", "clear", "--instance", "alpha", "upload-123"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toMatchObject({
        code: "EPERM",
      });
    } finally {
      findSpy.mockRestore();
      await removeTempRoot(tempDir);
    }
  });

  it("reads the audit tail for an instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const auditPath = path.join(tempDir, ".cctb", "default", "audit.log.jsonl");
      await mkdir(path.dirname(auditPath), { recursive: true });
      await writeFile(
        auditPath,
        ['{"type":"a"}', '{"type":"b"}', '{"type":"c"}'].join("\n") + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "audit", "2"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['{"type":"b"}\n{"type":"c"}']);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("filters audit output by chat and outcome", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const auditPath = path.join(tempDir, ".cctb", "default", "audit.log.jsonl");
      await mkdir(path.dirname(auditPath), { recursive: true });
      await writeFile(
        auditPath,
        [
          '{"timestamp":"2026-04-08T00:00:00.000Z","type":"update.handle","chatId":1,"outcome":"success"}',
          '{"timestamp":"2026-04-08T00:01:00.000Z","type":"update.handle","chatId":2,"outcome":"error"}',
          '{"timestamp":"2026-04-08T00:02:00.000Z","type":"update.handle","chatId":2,"outcome":"success"}',
        ].join("\n") + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "audit", "--chat", "2", "--outcome", "error"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual([
        '{"timestamp":"2026-04-08T00:01:00.000Z","type":"update.handle","chatId":2,"outcome":"error"}',
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("reads the timeline tail for an instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const timelinePath = path.join(tempDir, ".cctb", "default", "timeline.log.jsonl");
      await mkdir(path.dirname(timelinePath), { recursive: true });
      await writeFile(
        timelinePath,
        [
          '{"timestamp":"2026-04-08T00:00:00.000Z","type":"turn.started","channel":"telegram"}',
          '{"timestamp":"2026-04-08T00:00:01.000Z","type":"turn.completed","channel":"telegram","outcome":"success"}',
          '{"timestamp":"2026-04-08T00:00:02.000Z","type":"budget.blocked","channel":"telegram"}',
        ].join("\n") + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "timeline", "2"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual([
        '{"timestamp":"2026-04-08T00:00:01.000Z","type":"turn.completed","channel":"telegram","outcome":"success"}\n{"timestamp":"2026-04-08T00:00:02.000Z","type":"budget.blocked","channel":"telegram"}',
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("filters timeline output by channel and type", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const timelinePath = path.join(tempDir, ".cctb", "default", "timeline.log.jsonl");
      await mkdir(path.dirname(timelinePath), { recursive: true });
      await writeFile(
        timelinePath,
        [
          '{"timestamp":"2026-04-08T00:00:00.000Z","type":"turn.completed","channel":"telegram","outcome":"success","chatId":1}',
          '{"timestamp":"2026-04-08T00:00:01.000Z","type":"turn.completed","channel":"bus","outcome":"success","chatId":2}',
          '{"timestamp":"2026-04-08T00:00:02.000Z","type":"turn.retried","channel":"telegram","outcome":"retry","chatId":1}',
        ].join("\n") + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "timeline", "--channel", "telegram", "--type", "turn.completed"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual([
        '{"timestamp":"2026-04-08T00:00:00.000Z","type":"turn.completed","channel":"telegram","outcome":"success","chatId":1}',
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("reads Lark audit and timeline from the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "audit.log.jsonl"),
        [
          '{"timestamp":"2026-05-25T00:00:00.000Z","type":"lark.one","outcome":"success"}',
          '{"timestamp":"2026-05-25T00:00:01.000Z","type":"lark.two","outcome":"success"}',
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "timeline.log.jsonl"),
        [
          '{"timestamp":"2026-05-25T00:00:00.000Z","type":"turn.completed","channel":"telegram","outcome":"success"}',
          '{"timestamp":"2026-05-25T00:00:01.000Z","type":"turn.completed","channel":"lark","outcome":"success"}',
        ].join("\n") + "\n",
        "utf8",
      );

      await runCli(["lark", "audit", "1"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "timeline"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages).toEqual([
        '{"timestamp":"2026-05-25T00:00:01.000Z","type":"lark.two","outcome":"success"}',
        '{"timestamp":"2026-05-25T00:00:01.000Z","type":"turn.completed","channel":"lark","outcome":"success"}',
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("generates a Lark dashboard from the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];
    const dashboardPath = path.join(stateDir, "dashboard.html");
    const generateDashboard = vi.fn(async () => dashboardPath);

    try {
      const handled = await runCli(["lark", "dashboard"], {
        env: { USERPROFILE: tempDir, TAROCUB_INSTANCE: "lark-alpha", CODEX_TELEGRAM_INSTANCE: "bot6", CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
        dashboardDeps: { generateDashboard },
      });

      expect(handled).toBe(true);
      expect(generateDashboard).toHaveBeenCalledWith(expect.objectContaining({
        CODEX_TELEGRAM_STATE_DIR: stateDir,
        TAROCUB_INSTANCE: "lark-alpha",
        CODEX_TELEGRAM_INSTANCE: "lark-alpha",
      }));
      expect(messages).toEqual([`Dashboard generated: ${dashboardPath}`]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("lists Lark session bindings from the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
      await sessionStore.upsert({
        telegramChatId: 1001,
        codexSessionId: "lark-thread-1001",
        status: "idle",
        updatedAt: "2026-05-25T12:00:00.000Z",
      });

      const handled = await runCli(["lark", "session", "list"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: lark");
      expect(messages[0]).toContain("Session bindings: 1");
      expect(messages[0]).toContain("chat 1001 -> lark-thread-1001");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("inspects Lark file workflow records from the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: "lark-upload-1",
              chatId: 1001,
              userId: 2002,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["bundle.zip"],
              derivedFiles: [],
              summary: "Archive summary ready",
              extractedPath: "workspace/.lark-files/lark-upload-1/extracted",
              createdAt: "2026-05-25T12:00:00.000Z",
              updatedAt: "2026-05-25T12:00:00.000Z",
            },
          ],
        }) + "\n",
        "utf8",
      );

      const handled = await runCli(["lark", "task", "inspect", "lark-upload-1"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: lark");
      expect(messages[0]).toContain("Upload: lark-upload-1");
      expect(messages[0]).toContain("Status: awaiting_continue");
      expect(messages[0]).toContain("Source files: bundle.zip");
      expect(messages[0]).toContain("Extracted directory: workspace/.lark-files/lark-upload-1/extracted");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("uses Lark-specific usage text for Lark session and task errors", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");

    try {
      await expect(runCli(["lark", "session"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
      })).rejects.toThrow("Usage: lark session <list|inspect|reset> ...");

      await expect(runCli(["lark", "task", "inspect"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
      })).rejects.toThrow("Usage: lark task inspect <upload-id>");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("backs up the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const archivePath = path.join(tempDir, "lark-state.cctb.gz");
    const messages: string[] = [];

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "lark.env"), "LARK_APP_ID=cli_test\n", "utf8");

      const handled = await runCli(["lark", "backup", "--out", archivePath], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Backed up Lark state");
      await expect(readFile(archivePath)).resolves.toBeInstanceOf(Buffer);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("restores a Lark backup into the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sourceDir = path.join(tempDir, "source-lark");
    const targetDir = path.join(tempDir, "lark-state");
    const archivePath = path.join(tempDir, "source-lark.cctb.gz");
    const messages: string[] = [];

    try {
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(sourceDir, "lark.env"), "LARK_APP_ID=cli_restored\n", "utf8");
      await writeFile(path.join(targetDir, "stale.txt"), "old", "utf8");
      await createArchive(sourceDir, archivePath);

      const handled = await runCli(["lark", "restore", archivePath, "--force"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: targetDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      await expect(readFile(path.join(targetDir, "lark.env"), "utf8")).resolves.toContain("cli_restored");
      await expect(readFile(path.join(targetDir, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(messages[0]).toContain("Restored Lark state");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("manages Lark runtime configuration from Lark CLI aliases", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const messages: string[] = [];

    try {
      await runCli(["lark", "engine", "claude"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, TAROCUB_INSTANCE: "lark-alpha" },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "yolo", "on"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, TAROCUB_INSTANCE: "lark-alpha" },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "budget", "set", "12.5"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, TAROCUB_INSTANCE: "lark-alpha" },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "locale", "zh"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, TAROCUB_INSTANCE: "lark-alpha" },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "verbosity", "2"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, TAROCUB_INSTANCE: "lark-alpha" },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "usage"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir, TAROCUB_INSTANCE: "lark-alpha" },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages).toEqual(expect.arrayContaining([
        'Instance "lark-alpha": engine set to "claude". Restart the service to apply.',
        'Instance "lark-alpha": YOLO mode ON (full-auto, sandboxed). Codex will auto-approve within workspace.',
        'Instance "lark-alpha": budget set to $12.50. Bot will block new requests when the budget is exhausted.',
        'Instance "lark-alpha": locale set to "zh".',
        'Instance "lark-alpha": verbosity set to 2 (detailed (1s updates)).',
        'Instance "lark-alpha": no usage recorded yet.',
      ]));
      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as {
        approvalMode?: string;
        budgetUsd?: number;
        engine?: string;
        locale?: string;
        verbosity?: number;
      };
      expect(config).toMatchObject({
        approvalMode: "full-auto",
        budgetUsd: 12.5,
        engine: "claude",
        locale: "zh",
        verbosity: 2,
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("merges concurrent Lark runtime configuration writes without losing fields", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");

    try {
      await Promise.all([
        runCli(["lark", "engine", "claude"], {
          env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
          logger: { log: () => {} },
        }),
        runCli(["lark", "yolo", "on"], {
          env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
          logger: { log: () => {} },
        }),
        runCli(["lark", "budget", "set", "12.5"], {
          env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
          logger: { log: () => {} },
        }),
        runCli(["lark", "locale", "zh"], {
          env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
          logger: { log: () => {} },
        }),
        runCli(["lark", "verbosity", "2"], {
          env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
          logger: { log: () => {} },
        }),
      ]);

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as {
        approvalMode?: string;
        budgetUsd?: number;
        engine?: string;
        locale?: string;
        verbosity?: number;
      };
      expect(config).toMatchObject({
        approvalMode: "full-auto",
        budgetUsd: 12.5,
        engine: "claude",
        locale: "zh",
        verbosity: 2,
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("manages Lark agent instructions from the Lark state directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");
    const sourcePath = path.join(tempDir, "lark-agent.md");
    const messages: string[] = [];

    try {
      await writeFile(sourcePath, "Answer briefly in Chinese.", "utf8");

      await runCli(["lark", "instructions", "path"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "instructions", "set", sourcePath], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });
      await runCli(["lark", "instructions", "show"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages[0]).toBe(path.join(stateDir, "agent.md"));
      expect(messages[1]).toContain('Wrote instructions for instance "lark"');
      expect(messages[2]).toContain('Instance "lark" instructions:');
      expect(messages[2]).toContain("Answer briefly in Chinese.");
      await expect(readFile(path.join(stateDir, "agent.md"), "utf8")).resolves.toBe("Answer briefly in Chinese.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not run Telegram transport upgrades for Lark agent instructions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, "lark-state");

    try {
      await expect(runCli(["lark", "instructions", "upgrade"], {
        env: { USERPROFILE: tempDir, CCTB_LARK_STATE_DIR: stateDir },
      })).rejects.toThrow("Lark transport instructions are injected per turn");
      await expect(readFile(path.join(stateDir, "agent.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("strips only generated Telegram Transport instructions for Lark agent.md cleanup", () => {
    const stripped = stripGeneratedTelegramTransportSection([
      "# Personality",
      "Answer in Chinese.",
      "",
      DEFAULT_INSTANCE_AGENT_INSTRUCTIONS.trimEnd(),
      "",
      "## Other",
      "Keep this section.",
      "",
    ].join("\n"));

    expect(stripped.removed).toBe(true);
    expect(stripped.content).toContain("# Personality");
    expect(stripped.content).toContain("## Other");
    expect(stripped.content).not.toContain("## Telegram Transport");
  });

  it("shows, sets, and resolves the instructions path for an instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const sourcePath = path.join(tempDir, "source-agent.md");

    try {
      await writeFile(sourcePath, "You are bot alpha.", "utf8");

      await runCli(["telegram", "instructions", "set", "--instance", "alpha", sourcePath], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      await runCli(["telegram", "instructions", "path", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      await runCli(["telegram", "instructions", "show", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages[0]).toContain('Wrote instructions for instance "alpha"');
      expect(messages[1]).toBe(path.join(tempDir, ".cctb", "alpha", "agent.md"));
      expect(messages[2]).toContain('Instance "alpha" instructions:');
      expect(messages[2]).toContain("You are bot alpha.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("upgrades a legacy generated Telegram transport block", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
    const legacy = [
      "## Telegram Transport",
      "",
      "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.",
      "",
    ].join("\n");

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, legacy, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Upgraded instructions for instance "alpha"');
      const upgraded = await readFile(agentPath, "utf8");
      expect(upgraded).toContain('"name":"send.file"');
      expect(upgraded).not.toContain(", or one fenced");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("upgrades an older generated Telegram transport block that referenced telegram-out/current", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
    const legacy = [
      "## Telegram Transport",
      "",
      "Plain text only; ask in chat, not blocking prompt tools; deliver files with `telegram send --file PATH` / `telegram send --image PATH`, write disk outputs to `.telegram-out/current`, or use one fenced `file:name.ext` block for small text/code; never claim delivery by only naming a path.",
      "",
    ].join("\n");

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, legacy, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Upgraded instructions for instance "alpha"');
      const upgraded = await readFile(agentPath, "utf8");
      expect(upgraded).toContain('"name":"send.file"');
      expect(upgraded).not.toContain("cctb send --file PATH");
      expect(upgraded).not.toContain(".telegram-out/current");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("upgrades generated transport plus scheduled-task instructions without duplicating scheduled-task blocks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
    const legacy = [
      "## Telegram Transport",
      "",
      "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, use `[send-file:<absolute path>]` / `[send-image:<absolute path>]`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.",
      "",
      "## Scheduled Tasks",
      "",
      "For persistent recurring tasks that should send results back to this Telegram chat (\"every day at 9am summarize X\", \"每周一汇总…\"), use the Bash tool to call `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"<task>\"` (env `CCTB_CRON_URL` / `CCTB_CRON_TOKEN` are already set; PATH already has `cctb`). Run `cctb cron --help` to see all subcommands (list, delete, toggle, etc.). The user can also type `/cron ...` directly in chat. Do NOT use the Claude Code `schedule` skill (detached, output won't reach Telegram), the `loop` skill (single-session only, dies when turn ends), or system `crontab`/`at` (won't survive bot restart). `ScheduleWakeup` is acceptable only for short within-turn waits (<10 minutes).",
      "",
    ].join("\n");

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, legacy, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Upgraded instructions for instance "alpha"');
      const upgraded = await readFile(agentPath, "utf8");
      expect(upgraded).not.toContain("## Scheduled Tasks");
      expect(upgraded).toContain('[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]');
      expect(upgraded).not.toContain("cctb cron add");
      expect(upgraded).not.toContain("PATH already has `cctb`");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("upgrades the native-scheduler warning scheduled-task block back to the short generated block", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
    const legacy = [
      "## Telegram Transport",
      "",
      "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, use `[send-file:<absolute path>]` / `[send-image:<absolute path>]`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.",
      "",
      "## Scheduled Tasks",
      "",
      "For Telegram-delivered reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. If the user explicitly asks for a native/session-local scheduler, you may use Claude/Codex native schedule, cron, automation, reminder, loop, CronCreate, or ScheduleWakeup tools, but first state that those jobs are session-local and may not persist or deliver through Telegram. Do not claim a Telegram reminder is scheduled unless the `cctb cron` or `/cron` command succeeds.",
      "",
    ].join("\n");

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, legacy, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Upgraded instructions for instance "alpha"');
      const upgraded = await readFile(agentPath, "utf8");
      expect(upgraded).not.toContain("## Scheduled Tasks");
      expect(upgraded).toContain("Deliver: file/image");
      expect(upgraded).toContain('[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]');
      expect(upgraded).toContain("native schedulers only if explicitly asked");
      expect(upgraded).not.toContain("cctb cron add");
      expect(upgraded).not.toContain("CronCreate");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("removes duplicated generated scheduler residue from current agent instructions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const residue = "Use native/session-local schedulers only if the user explicitly asks for non-Telegram scheduling.";
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");

    try {
      await runCli(["telegram", "configure", "--instance", "alpha", "bot-token-456"], {
        env: { USERPROFILE: tempDir },
      });
      const current = await readFile(agentPath, "utf8");
      await writeFile(agentPath, `${current}\n${residue}\n\n## Local Notes\n\nKeep this note.\n`, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Upgraded instructions for instance "alpha"');
      const upgraded = await readFile(agentPath, "utf8");
      expect(upgraded).not.toContain(residue);
      expect(upgraded).toContain("## Local Notes\n\nKeep this note.");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not overwrite a custom Telegram transport block without --force", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
    const custom = "## Telegram Transport\n\nUse my private relay.\n";

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, custom, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("manual review required");
      await expect(readFile(agentPath, "utf8")).resolves.toBe(custom);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("force-upgrades a custom Telegram transport block while preserving other notes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, "# Notes\nkeep me\n\n## Telegram Transport\n\nUse my private relay.\n\n## Other\nalso keep me\n", "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha", "--force"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      const upgraded = await readFile(agentPath, "utf8");
      expect(messages[0]).toContain('Force-upgraded instructions for instance "alpha"');
      expect(messages[1]).toContain("Previous instructions backed up to");
      expect(upgraded).toContain("# Notes\nkeep me");
      expect(upgraded).toContain('"name":"send.file"');
      expect(upgraded).toContain("## Other\nalso keep me");
      expect(upgraded).not.toContain("Use my private relay");
      const backupName = (await readdir(path.dirname(agentPath))).find((name) => name.startsWith("agent.md.bak."));
      expect(backupName).toBeDefined();
      await expect(readFile(path.join(path.dirname(agentPath), backupName ?? ""), "utf8")).resolves.toContain("Use my private relay");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("dry-runs an instructions upgrade without writing files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const agentPath = path.join(tempDir, ".cctb", "alpha", "agent.md");
    const legacy = "## Telegram Transport\n\nPlain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.\n";

    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(agentPath, legacy, "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--instance", "alpha", "--dry-run"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Would upgrade instructions for instance "alpha"');
      await expect(readFile(agentPath, "utf8")).resolves.toBe(legacy);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("upgrades all instance instruction files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const legacy = "## Telegram Transport\n\nPlain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.\n";

    try {
      await mkdir(path.join(tempDir, ".cctb", "alpha"), { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", "beta"), { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", ".restore-backup-alpha"), { recursive: true });
      await writeFile(path.join(tempDir, ".cctb", "alpha", "agent.md"), legacy, "utf8");
      await writeFile(path.join(tempDir, ".cctb", "beta", "agent.md"), "custom", "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--all"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('Upgraded instructions for instance "alpha"'),
        expect.stringContaining('Appended Telegram transport instructions for instance "beta"'),
      ]));
      await expect(readFile(path.join(tempDir, ".cctb", "alpha", "agent.md"), "utf8")).resolves.toContain('"name":"send.file"');
      await expect(readFile(path.join(tempDir, ".cctb", "beta", "agent.md"), "utf8")).resolves.toContain('"name":"send.file"');
      await expect(readFile(path.join(tempDir, ".cctb", ".restore-backup-alpha", "agent.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("skips Lark-only state directories when upgrading all Telegram instructions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const legacy = "## Telegram Transport\n\nPlain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.\n";

    try {
      await mkdir(path.join(tempDir, ".cctb", "alpha"), { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", "lark-only"), { recursive: true });
      await writeFile(path.join(tempDir, ".cctb", "alpha", ".env"), 'TELEGRAM_BOT_TOKEN="token"\n', "utf8");
      await writeFile(path.join(tempDir, ".cctb", "alpha", "agent.md"), legacy, "utf8");
      await writeFile(path.join(tempDir, ".cctb", "lark-only", "lark.env"), "LARK_APP_ID=cli_x\n", "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--all"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('Upgraded instructions for instance "alpha"'),
      ]));
      expect(messages.join("\n")).not.toContain("lark-only");
      await expect(readFile(path.join(tempDir, ".cctb", "alpha", "agent.md"), "utf8")).resolves.toContain('"name":"send.file"');
      await expect(readFile(path.join(tempDir, ".cctb", "lark-only", "agent.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("continues upgrading all instances when one instance fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const legacy = "## Telegram Transport\n\nPlain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.\n";

    try {
      await mkdir(path.join(tempDir, ".cctb", "alpha"), { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", "bad", "agent.md"), { recursive: true });
      await mkdir(path.join(tempDir, ".cctb", "custom"), { recursive: true });
      await writeFile(path.join(tempDir, ".cctb", "alpha", "agent.md"), legacy, "utf8");
      await writeFile(path.join(tempDir, ".cctb", "custom", "agent.md"), "## Telegram Transport\n\nUse my private relay.\n", "utf8");

      const handled = await runCli(["telegram", "instructions", "upgrade", "--all"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('Upgraded instructions for instance "alpha"'),
        expect.stringContaining('Failed to upgrade instructions for instance "bad"'),
        expect.stringContaining('Instance "custom" instructions: manual review required'),
        expect.stringContaining("Summary: upgraded 1, current 0, skipped custom 1, failed 1."),
      ]));
      await expect(readFile(path.join(tempDir, ".cctb", "alpha", "agent.md"), "utf8")).resolves.toContain('"name":"send.file"');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("reports when instance instructions are missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "instructions", "show", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toBe('Instance "alpha": no instructions configured (agent.md not found).');
      expect(messages[1]).toContain(path.join(tempDir, ".cctb", "alpha", "agent.md"));
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("sets and reads the engine for an instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      await runCli(["telegram", "engine", "claude", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      const handled = await runCli(["telegram", "engine", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toBe('Instance "alpha": engine set to "claude". Restart the service to apply.');
      expect(messages[1]).toBe('Instance "alpha": engine = claude');

      const configPath = path.join(tempDir, ".cctb", "alpha", "config.json");
      await expect(readFile(configPath, "utf8")).resolves.toContain('"engine": "claude"');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("sets Antigravity as an instance engine via CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "engine", "antigravity", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toBe('Instance "alpha": engine set to "antigravity". Restart the service to apply.');

      const configPath = path.join(tempDir, ".cctb", "alpha", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        engine: "antigravity",
        approvalMode: "bypass",
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("clears incompatible model overrides when switching engines", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const configPath = path.join(tempDir, ".cctb", "alpha", "config.json");

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ engine: "claude", model: "opus" }, null, 2) + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "engine", "codex", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toBe(
        'Instance "alpha": engine set to "codex". Cleared the previous model override. Restart the service to apply.',
      );
      await expect(readFile(configPath, "utf8")).resolves.not.toContain('"model"');
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("clears session bindings when switching engines via CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");

    try {
      const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
      await sessionStore.upsert({
        telegramChatId: 123,
        codexSessionId: "thread-old",
        status: "idle",
        updatedAt: "2026-04-22T00:00:00.000Z",
      });

      const handled = await runCli(["telegram", "engine", "claude", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toBe(
        'Instance "alpha": engine set to "claude". Reset this instance\'s session bindings. Restart the service to apply.',
      );
      await expect(sessionStore.findByChatId(123)).resolves.toBeNull();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("keeps the old engine when CLI session bindings cannot be reset first", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const configPath = path.join(tempDir, ".cctb", "alpha", "config.json");
    const clearAllSpy = vi.spyOn(SessionStore.prototype, "clearAll").mockRejectedValue(new Error("session store unavailable"));

    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ engine: "claude", model: "opus" }, null, 2) + "\n",
        "utf8",
      );

      await expect(runCli(["telegram", "engine", "codex", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      })).rejects.toThrow("Could not switch to codex because this instance's session bindings could not be reset first. Engine remains claude.");

      await expect(readFile(configPath, "utf8")).resolves.toContain('"engine": "claude"');
      expect(messages).toEqual([]);
    } finally {
      clearAllSpy.mockRestore();
      await removeTempRoot(tempDir);
    }
  });
});
