import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
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

      await runCli(["telegram", "configure", "new-token"], {
        env: { USERPROFILE: tempDir },
      });

      await expect(readFile(envPath, "utf8")).resolves.toBe("EXTRA=1\nKEEP=2\nTELEGRAM_BOT_TOKEN=\"new-token\"\n");
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
        /^Instance: alpha\nPolicy: allowlist\nPaired users: 0\nAllowlist: 123\nPending pairs: [A-Z2-9]{6} chat 84 expires 2026-04-08T00:05:00\.000Z$/,
      );
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
});
