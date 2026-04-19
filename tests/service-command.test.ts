import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/commands/cli.js";
import { resolveInstanceLockPath } from "../src/state/instance-lock.js";

import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("telegram service commands", () => {
  it("starts a named instance through the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const spawnDetached = vi.fn();
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      const handled = await runCli(["telegram", "service", "start", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          spawnDetached: (command, args, options) => {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(
              lockPath,
              JSON.stringify({
                pid: 12345,
                token: "token",
                acquiredAt: new Date().toISOString(),
              }),
              "utf8",
            );
            spawnDetached(command, args, options);
          },
          sleep: async () => {
            await Promise.resolve();
          },
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Started instance "alpha" with pid 12345.']);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      expect(spawnDetached).toHaveBeenCalledWith(
        process.execPath,
        [path.join(REPO_ROOT, "dist", "src", "index.js"), "--instance", "alpha"],
        {
          cwd: REPO_ROOT,
          stdoutPath: path.join(stateDir, "service.stdout.log"),
          stderrPath: path.join(stateDir, "service.stderr.log"),
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for a fresh lock before reporting a restart as started", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);
    let sleepCalls = 0;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 11111,
          token: "old-token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "start", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          spawnDetached: async () => {},
          sleep: async () => {
            sleepCalls += 1;
            if (sleepCalls === 2) {
              await writeFile(
                lockPath,
                JSON.stringify({
                  pid: 22222,
                  token: "new-token",
                  acquiredAt: new Date().toISOString(),
                }),
                "utf8",
              );
            }
          },
          isProcessAlive: (pid) => pid === 22222,
          isExpectedServiceProcess: (pid) => pid === 11111 || pid === 22222,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Started instance "alpha" with pid 22222.']);
      expect(sleepCalls).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports service status without a configured token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
      );

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Running: yes");
      expect(messages[0]).toContain("Pid: 12345");
      expect(messages[0]).toContain("Engine: codex");
      expect(messages[0]).toMatch(/Runtime: (process|app-server)/);
      expect(messages[0]).toContain("Allowlist count: 0");
      expect(messages[0]).toContain("Pending pair count: 0");
      expect(messages[0]).toContain("Session bindings: 0");
      expect(messages[0]).toContain("Audit events: 0");
      expect(messages[0]).toContain("Last success: none");
      expect(messages[0]).toContain("Last failure: none");
      expect(messages[0]).toContain("Blocking tasks: 0");
      expect(messages[0]).toContain("Awaiting continue tasks: 0");
      expect(messages[0]).toContain("Lock path:");
      expect(messages[0]).toContain("Bot token configured: no");
      expect(messages[0]).not.toContain("Bot identity:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a configured token and bot identity when lookup succeeds", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          fetchTelegramBotIdentity: async () => ({ firstName: "Channel Bot", username: "channel_bot" }),
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Bot token configured: yes");
      expect(messages[0]).toContain("Engine: codex");
      expect(messages[0]).toContain("Bot identity: Channel Bot (@channel_bot)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps status usable when bot identity lookup fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          fetchTelegramBotIdentity: async () => {
            throw new Error("temporary Telegram failure");
          },
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Bot token configured: yes");
      expect(messages[0]).toMatch(/Runtime: (process|app-server)/);
      expect(messages[0]).toContain("Bot identity lookup failed: temporary Telegram failure");
      expect(messages[0]).toContain("State dir:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns tailed service logs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "service", "logs", "--instance", "alpha", "2"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          readTextFile: async (filePath: string) =>
            filePath.endsWith("stdout.log") ? "line-1\nline-2\nline-3\n" : "err-1\nerr-2\nerr-3\n",
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("--- stdout ---");
      expect(messages[0]).not.toContain("line-1");
      expect(messages[0]).toContain("line-2");
      expect(messages[0]).toContain("line-3");
      expect(messages[0]).toContain("--- stderr ---");
      expect(messages[0]).not.toContain("err-1");
      expect(messages[0]).toContain("err-2");
      expect(messages[0]).toContain("err-3");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs service doctor with a health summary", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
      );
      await writeFile(
        path.join(stateDir, "audit.log.jsonl"),
        [
          '{"timestamp":"2026-04-08T10:00:00.000Z","type":"update.handle","outcome":"success"}',
          '{"timestamp":"2026-04-08T10:01:00.000Z","type":"update.handle","outcome":"error"}',
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "timeline.log.jsonl"),
        [
          '{"timestamp":"2026-04-08T10:00:30.000Z","type":"turn.completed","channel":"telegram","outcome":"success"}',
          '{"timestamp":"2026-04-08T10:00:45.000Z","type":"turn.retried","channel":"telegram","outcome":"retry","detail":"auth refresh"}',
          '{"timestamp":"2026-04-08T10:00:50.000Z","type":"budget.blocked","channel":"telegram","detail":"budget exhausted"}',
          '{"timestamp":"2026-04-08T10:00:55.000Z","type":"file.rejected","channel":"telegram","detail":"outside workspace"}',
          '{"timestamp":"2026-04-08T10:01:10.000Z","type":"crew.run.started","channel":"telegram","outcome":"success","metadata":{"workflow":"research-report","runId":"run-1"}}',
          '{"timestamp":"2026-04-08T10:02:10.000Z","type":"crew.run.completed","channel":"telegram","outcome":"success","metadata":{"workflow":"research-report","runId":"run-1"}}',
        ].join("\n") + "\n",
        "utf8",
      );
      await mkdir(path.join(stateDir, "crew-runs"), { recursive: true });
      await writeFile(
        path.join(stateDir, "crew-runs", "run-1.json"),
        JSON.stringify({
          runId: "run-1",
          workflow: "research-report",
          status: "completed",
          currentStage: "completed",
          coordinator: "alpha",
          chatId: 111,
          userId: 222,
          locale: "en",
          originalPrompt: "Analyze AI adoption.",
          createdAt: "2026-04-08T10:01:10.000Z",
          updatedAt: "2026-04-08T10:02:10.000Z",
          finalOutput: "Final report",
          stages: {},
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
          fetchTelegramBotIdentity: async () => ({ firstName: "Channel Bot", username: "channel_bot" }),
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Healthy: yes");
      expect(messages[0]).toContain("Engine: codex");
      expect(messages[0]).toMatch(/Runtime: (process|app-server)/);
      expect(messages[0]).toContain("ok build:");
      expect(messages[0]).toContain("ok token:");
      expect(messages[0]).toContain("ok service:");
      expect(messages[0]).toContain("ok identity:");
      expect(messages[0]).toContain("ok environment:");
      expect(messages[0]).toContain("ok legacy-launchd:");
      expect(messages[0]).toContain("ok audit:");
      expect(messages[0]).toContain("ok timeline:");
      expect(messages[0]).toContain("Timeline events: 6");
      expect(messages[0]).toContain("Last turn completion: 2026-04-08T10:00:30.000Z");
      expect(messages[0]).toContain("Last retry: 2026-04-08T10:00:45.000Z");
      expect(messages[0]).toContain("Incident counts: retries=1, budget blocks=1, file rejections=1, workflow failures=0, crew runs started=1, crew runs completed=1, crew runs failed=0");
      expect(messages[0]).toContain("Latest crew run: run-1 (research-report, completed/completed, updated 2026-04-08T10:02:10.000Z).");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports latest failure category and unresolved tasks in doctor output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "audit.log.jsonl"),
        [
          '{"timestamp":"2026-04-08T10:00:00.000Z","type":"update.handle","outcome":"success"}',
          '{"timestamp":"2026-04-08T10:01:00.000Z","type":"update.handle","outcome":"error","metadata":{"failureCategory":"write-permission"}}',
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: "one",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "processing",
              sourceFiles: ["a.txt"],
              derivedFiles: [],
              summary: "first",
              createdAt: "2026-04-08T09:00:00.000Z",
              updatedAt: "2026-04-08T09:00:00.000Z",
            },
            {
              uploadId: "two",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "preparing",
              sourceFiles: ["prep.txt"],
              derivedFiles: [],
              summary: "preparing",
              createdAt: "2026-04-08T09:00:30.000Z",
              updatedAt: "2026-04-08T09:00:30.000Z",
            },
            {
              uploadId: "three",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "awaiting_continue",
              sourceFiles: ["b.txt"],
              derivedFiles: [],
              summary: "second",
              createdAt: "2026-04-08T09:01:00.000Z",
              updatedAt: "2026-04-08T09:01:00.000Z",
            },
            {
              uploadId: "four",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "completed",
              sourceFiles: ["c.txt"],
              derivedFiles: [],
              summary: "third",
              createdAt: "2026-04-08T09:02:00.000Z",
              updatedAt: "2026-04-08T09:02:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Healthy: no");
      expect(messages[0]).toContain("Engine: codex");
      expect(messages[0]).toMatch(/Runtime: (process|app-server)/);
      expect(messages[0]).toContain("latest failure category: write-permission");
      expect(messages[0]).toContain("blocking tasks: 2");
      expect(messages[0]).toContain("awaiting continue: 1");
      expect(messages[0]).toContain("- fail tasks:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports environment mismatches in service doctor for shared engine env", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }), "utf8");

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
          readProcessEnvironment: async () => ({
            CLAUDE_CONFIG_DIR: "/tmp/legacy-claude-config",
          }),
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Healthy: no");
      expect(messages[0]).toContain("- fail environment:");
      expect(messages[0]).toContain(
        "running service exports CLAUDE_CONFIG_DIR=/tmp/legacy-claude-config while the current shell does not",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports legacy launchd plists in service doctor", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);
    const legacyPlist = path.join(
      tempDir,
      "Library",
      "LaunchAgents",
      "com.cloveric.cc-telegram-bridge.alpha.plist",
    );

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(path.dirname(legacyPlist), { recursive: true });
      await writeFile(legacyPlist, "<plist/>", "utf8");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir, HOME: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Healthy: no");
      expect(messages[0]).toContain("- fail legacy-launchd:");
      expect(messages[0]).toContain("bash scripts/cleanup-legacy-launchd.sh alpha");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports timeline summary in service status when timeline events exist", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "timeline.log.jsonl"),
        [
          '{"timestamp":"2026-04-08T11:00:00.000Z","type":"turn.completed","channel":"telegram","outcome":"success"}',
          '{"timestamp":"2026-04-08T11:02:00.000Z","type":"budget.blocked","channel":"telegram","detail":"budget exhausted"}',
          '{"timestamp":"2026-04-08T11:03:00.000Z","type":"workflow.failed","channel":"telegram","detail":"workflow marked failed"}',
          '{"timestamp":"2026-04-08T11:04:00.000Z","type":"crew.run.started","channel":"telegram","outcome":"success","metadata":{"workflow":"research-report","runId":"run-2"}}',
          '{"timestamp":"2026-04-08T11:05:00.000Z","type":"crew.run.failed","channel":"telegram","outcome":"error","metadata":{"workflow":"research-report","runId":"run-2"}}',
        ].join("\n") + "\n",
        "utf8",
      );
      await mkdir(path.join(stateDir, "crew-runs"), { recursive: true });
      await writeFile(
        path.join(stateDir, "crew-runs", "run-2.json"),
        JSON.stringify({
          runId: "run-2",
          workflow: "research-report",
          status: "failed",
          currentStage: "review",
          coordinator: "alpha",
          chatId: 111,
          userId: 222,
          locale: "en",
          originalPrompt: "Analyze AI adoption.",
          createdAt: "2026-04-08T11:04:00.000Z",
          updatedAt: "2026-04-08T11:05:00.000Z",
          lastError: "reviewer failed",
          stages: {},
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Timeline events: 5");
      expect(messages[0]).toContain("Last turn completion: 2026-04-08T11:00:00.000Z");
      expect(messages[0]).toContain("Last budget block: 2026-04-08T11:02:00.000Z");
      expect(messages[0]).toContain("Retry count: 0");
      expect(messages[0]).toContain("Budget block count: 1");
      expect(messages[0]).toContain("File rejection count: 0");
      expect(messages[0]).toContain("Workflow failure count: 1");
      expect(messages[0]).toContain("Crew runs started: 1");
      expect(messages[0]).toContain("Crew runs completed: 0");
      expect(messages[0]).toContain("Crew runs failed: 1");
      expect(messages[0]).toContain("Latest crew run: run-2 (research-report, failed/review, updated 2026-04-08T11:05:00.000Z)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps service status working when timeline state is unreadable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await mkdir(path.join(stateDir, "timeline.log.jsonl"));

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Timeline events: unknown (timeline log unreadable)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports timeline warnings in service doctor when timeline state is unreadable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await mkdir(path.join(stateDir, "timeline.log.jsonl"));

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("- fail timeline: Timeline events: unknown (timeline log unreadable).");
      expect(messages[0]).toContain("Healthy: no");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a poll conflict failure category in doctor output from the audit stream", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "audit.log.jsonl"),
        [
          '{"timestamp":"2026-04-08T10:00:00.000Z","type":"poll.fetch","outcome":"error","detail":"409 Conflict: terminated by other getUpdates request","metadata":{"failureCategory":"telegram-conflict"}}',
        ].join("\n") + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("latest failure category: telegram-conflict");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps doctor healthy when tasks are only waiting for manual continuation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: "archive-1",
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "archive summary",
              createdAt: "2026-04-08T09:00:00.000Z",
              updatedAt: "2026-04-08T09:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
          fetchTelegramBotIdentity: async () => ({ firstName: "Channel Bot", username: "channel_bot" }),
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Healthy: yes");
      expect(messages[0]).toContain("blocking tasks: 0");
      expect(messages[0]).toContain("awaiting continue: 1");
      expect(messages[0]).toContain("- ok tasks:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps service doctor working when file workflow state is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        "{not valid json",
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("unresolved tasks: unknown");
      expect(messages[0]).toContain("file workflow state unreadable");
      expect(messages[0]).toContain("- fail tasks: unresolved tasks: unknown (file workflow state unreadable).");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not relabel internal task-health failures as unreadable workflow state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);
    const inspectSpy = vi.spyOn((await import("../src/state/file-workflow-store.js")).FileWorkflowStore.prototype, "inspect");
    inspectSpy.mockRejectedValueOnce(new Error("workflow summary exploded"));

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );

      await expect(
        runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
          env: { USERPROFILE: tempDir },
          serviceDeps: {
            cwd: REPO_ROOT,
            isProcessAlive: (pid) => pid === 12345,
            isExpectedServiceProcess: (pid) => pid === 12345,
          },
        }),
      ).rejects.toThrow("workflow summary exploded");
    } finally {
      inspectSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports unknown unresolved tasks in service status when file workflow state is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(path.join(stateDir, "file-workflow.json"), "{not valid json", "utf8");

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Unresolved tasks: unknown (file workflow state unreadable)");
      expect(messages[0]).toContain("Blocking tasks: unknown (file workflow state unreadable)");
      expect(messages[0]).toContain("Awaiting continue tasks: unknown (file workflow state unreadable)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports blocking and awaiting-continue task counts in service status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: "one",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "processing",
              sourceFiles: ["a.txt"],
              derivedFiles: [],
              summary: "first",
              createdAt: "2026-04-08T09:00:00.000Z",
              updatedAt: "2026-04-08T09:00:00.000Z",
            },
            {
              uploadId: "two",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "preparing",
              sourceFiles: ["prep.txt"],
              derivedFiles: [],
              summary: "preparing",
              createdAt: "2026-04-08T09:00:30.000Z",
              updatedAt: "2026-04-08T09:00:30.000Z",
            },
            {
              uploadId: "three",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "awaiting_continue",
              sourceFiles: ["b.txt"],
              derivedFiles: [],
              summary: "second",
              createdAt: "2026-04-08T09:01:00.000Z",
              updatedAt: "2026-04-08T09:01:00.000Z",
            },
            {
              uploadId: "four",
              chatId: 100,
              userId: 100,
              kind: "document",
              status: "completed",
              sourceFiles: ["c.txt"],
              derivedFiles: [],
              summary: "third",
              createdAt: "2026-04-08T09:02:00.000Z",
              updatedAt: "2026-04-08T09:02:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Unresolved tasks: 3");
      expect(messages[0]).toContain("Blocking tasks: 2");
      expect(messages[0]).toContain("Awaiting continue tasks: 1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports unknown session bindings in service status when session state is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(path.join(stateDir, "session.json"), "{not valid json", "utf8");

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Session bindings: unknown (session state unreadable)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports session warnings in service doctor when session state is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await writeFile(path.join(stateDir, "session.json"), "{not valid json", "utf8");

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("- fail sessions: Session bindings: unknown (session state unreadable).");
      expect(messages[0]).toContain("Healthy: no");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stops a running instance through the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "default");
    const lockPath = resolveInstanceLockPath(stateDir);
    const killProcessTree = vi.fn();

    try {
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(stateDir, { recursive: true }).then(() =>
          fs.writeFile(
            lockPath,
            JSON.stringify({
              pid: 54321,
              token: "token",
              acquiredAt: new Date().toISOString(),
            }),
          ),
        ),
      );

      const handled = await runCli(["telegram", "service", "stop"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          isProcessAlive: (() => {
            let calls = 0;
            return (pid: number) => {
              calls += 1;
              return pid === 54321 && calls < 2;
            };
          })(),
          isExpectedServiceProcess: (pid) => pid === 54321,
          sleep: async () => {},
          killProcessTree,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Stopped instance "default".']);
      expect(killProcessTree).toHaveBeenCalledWith(54321);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("warns when stopping an instance that still has a legacy launchd plist", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);
    const legacyPlist = path.join(
      tempDir,
      "Library",
      "LaunchAgents",
      "com.cloveric.cc-telegram-bridge.alpha.plist",
    );

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(path.dirname(legacyPlist), { recursive: true });
      await writeFile(legacyPlist, "<plist/>", "utf8");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "stop", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir, HOME: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          killProcessTree: () => {},
          sleep: async () => {},
          isProcessAlive: (() => {
            let running = true;
            return (pid: number) => {
              if (pid !== 12345) {
                return false;
              }
              const current = running;
              running = false;
              return current;
            };
          })(),
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain('Stopped instance "alpha".');
      expect(messages[0]).toContain("legacy launchd plist still exists");
      expect(messages[0]).toContain("bash scripts/cleanup-legacy-launchd.sh alpha");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restarts an instance by stopping and then starting it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".cctb", "default");
    const lockPath = resolveInstanceLockPath(stateDir);
    const killProcessTree = vi.fn();
    const spawnDetached = vi.fn();
    let started = false;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 54321,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
      );

      const handled = await runCli(["telegram", "service", "restart"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => {
            if (pid === 54321) {
              return killProcessTree.mock.calls.length === 0;
            }

            return pid === 12345 && started;
          },
          isExpectedServiceProcess: (pid) => pid === 54321 || (pid === 12345 && started),
          killProcessTree,
          spawnDetached: (command, args, options) => {
            started = true;
            mkdir(stateDir, { recursive: true }).then(() =>
              writeFile(
                lockPath,
                JSON.stringify({
                  pid: 12345,
                  token: "token-2",
                  acquiredAt: new Date().toISOString(),
                }),
                "utf8",
              ),
            );
            spawnDetached(command, args, options);
          },
          sleep: async () => {},
        },
      });

      expect(handled).toBe(true);
      expect(killProcessTree).toHaveBeenCalledWith(54321);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      expect(messages).toEqual(['Started instance "default" with pid 12345.']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
