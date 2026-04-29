import { mkdtemp, readFile, readdir, rm, mkdir, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AccessStore } from "../src/state/access-store.js";
import { runCli } from "../src/commands/cli.js";
import { SessionStore } from "../src/state/session-store.js";
import { createArchive } from "../src/state/archive.js";

const REPO_ROOT = "C:\\Users\\hangw\\codex-telegram-channel";

describe("runCli", () => {
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
      await expect(readFile(agentPath, "utf8")).resolves.toContain("Plain text only");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("cctb send --file PATH");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("[send-file:<absolute path>]");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain(".telegram-out/current");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("CCTB_SEND_COMMAND");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain(".cctb-send/");
      await expect(readFile(agentPath, "utf8")).resolves.not.toContain("- Telegram is plain text");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
      await expect(readFile(agentPath, "utf8")).resolves.toContain("Plain text only");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects missing configure token", async () => {
    await expect(runCli(["telegram", "configure"], { env: { USERPROFILE: "C:\\Users\\hangw" } })).rejects.toThrow(
      "Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>",
    );
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates send payload before requiring a configured bot token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await expect(runCli(["send"], {
        env: { USERPROFILE: tempDir },
      })).rejects.toThrow("Usage: send [--message <text>] [--image <path>] [--file <path>] [text]");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
          }),
        },
      })).rejects.toThrow("Multiple Telegram sessions found; pass --chat <id>.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
    }
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      expect(upgraded.match(/## Scheduled Tasks/g)).toHaveLength(1);
      expect(upgraded).toContain('[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]');
      expect(upgraded).not.toContain("cctb cron add");
      expect(upgraded).not.toContain("PATH already has `cctb`");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
      expect(upgraded.match(/## Scheduled Tasks/g)).toHaveLength(1);
      expect(upgraded).toContain("For reminders or recurring tasks");
      expect(upgraded).toContain('[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]');
      expect(upgraded).toContain("Use native/session-local schedulers only if the user explicitly asks");
      expect(upgraded).not.toContain("cctb cron add");
      expect(upgraded).not.toContain("CronCreate");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
