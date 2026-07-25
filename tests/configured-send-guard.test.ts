import { mkdir, mkdtemp, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/commands/cli.js";
import { runConfiguredSendCommand, type SendCommandEnv } from "../src/commands/send.js";
import { SessionStore } from "../src/state/session-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

// `cctb send` used to fall back to a "configured instance" mode whenever the
// turn-scoped side channel was absent: it honoured `--instance <any>` (loading
// THAT instance's bot token off disk), `--chat <any>`, and delivered with
// allowAnyAbsolutePath. One prompt-injected turn on instance A could therefore
// exfiltrate any readable file as instance B's bot into any chat. The operator
// never runs `cctb send` by hand, so the unscoped path is refused outright.

const SIDE_CHANNEL_ENV = {
  CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
  CCTB_SEND_TOKEN: "turn-secret",
};

function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    sendVoice: vi.fn().mockResolvedValue({ message_id: 4 }),
  };
}

async function seedSingleChatSession(tempDir: string, instanceName = "default"): Promise<void> {
  await new SessionStore(path.join(tempDir, ".cctb", instanceName, "session.json")).upsert({
    telegramChatId: 84,
    codexSessionId: "telegram-84",
    status: "idle",
    updatedAt: new Date().toISOString(),
  });
}

describe("cctb send turn-scoped guard", () => {
  it("refuses without the turn side channel, without reading a bot token or sending", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-"));
    const readConfiguredBotToken = vi.fn().mockResolvedValue("bot-token");
    const createTelegramApi = vi.fn().mockReturnValue(fakeApi());
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await seedSingleChatSession(tempDir);

      await expect(runConfiguredSendCommand(["--message", "hello"], { USERPROFILE: tempDir }, {
        readConfiguredBotToken,
        createTelegramApi,
        deliverTelegramResponse,
      })).rejects.toThrow("cctb send requires the turn-scoped side channel");

      // Same refusal through the CLI entry point (the old fallback branch).
      await expect(runCli(["send", "--message", "hello"], {
        env: { USERPROFILE: tempDir },
        sendDeps: { readConfiguredBotToken, createTelegramApi, deliverTelegramResponse },
      })).rejects.toThrow("cctb send requires the turn-scoped side channel");

      expect(readConfiguredBotToken).not.toHaveBeenCalled();
      expect(createTelegramApi).not.toHaveBeenCalled();
      expect(deliverTelegramResponse).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("refuses when only half of the side-channel context is present", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-half-"));
    const readConfiguredBotToken = vi.fn().mockResolvedValue("bot-token");

    try {
      await expect(runConfiguredSendCommand(
        ["--message", "hello"],
        { USERPROFILE: tempDir, CCTB_SEND_URL: SIDE_CHANNEL_ENV.CCTB_SEND_URL },
        { readConfiguredBotToken },
      )).rejects.toThrow("cctb send requires the turn-scoped side channel");
      expect(readConfiguredBotToken).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("sends to the current turn's chat when the side channel is present", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-ok-"));
    const filePath = path.join(tempDir, "project", "chart.png");
    const api = fakeApi();
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "png", "utf8");
      await seedSingleChatSession(tempDir);

      const result = await runConfiguredSendCommand(
        ["--message", "Chart ready", "--file", filePath],
        { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
        {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
          deliverTelegramResponse,
        },
      );

      expect(result).toEqual({ chatId: 84, filesSent: 1 });
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        api,
        84,
        `Chart ready\n[send-file:${filePath}]`,
        path.join(tempDir, ".cctb", "default", "inbox"),
        path.join(tempDir, "project"),
        undefined,
        "en",
        expect.objectContaining({ onDeliveryRejected: expect.any(Function) }),
      );
      // The sandbox escape hatch is gone from this path.
      const options = deliverTelegramResponse.mock.calls[0]?.[7] as Record<string, unknown>;
      expect(options.allowAnyAbsolutePath).toBeUndefined();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects --instance and --chat overrides that leave the turn's own context", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-target-"));
    const readConfiguredBotToken = vi.fn().mockResolvedValue("bot-token");
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);
    const env: SendCommandEnv = { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV };

    try {
      await seedSingleChatSession(tempDir);

      await expect(runConfiguredSendCommand(
        ["--instance", "other-bot", "--message", "hello"],
        env,
        { readConfiguredBotToken, deliverTelegramResponse },
      )).rejects.toThrow('cctb send cannot target instance "other-bot"');

      await expect(runConfiguredSendCommand(
        ["--chat", "999", "--message", "hello"],
        env,
        { readConfiguredBotToken, deliverTelegramResponse },
      )).rejects.toThrow("cctb send cannot target another chat");

      await expect(runConfiguredSendCommand(
        ["--chat-id=999", "--message", "hello"],
        env,
        { readConfiguredBotToken, deliverTelegramResponse },
      )).rejects.toThrow("cctb send cannot target another chat");

      expect(readConfiguredBotToken).not.toHaveBeenCalled();
      expect(deliverTelegramResponse).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects cross-target overrides before touching the turn side channel in the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-cli-"));
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    try {
      vi.stubGlobal("fetch", fetchFn);

      await expect(runCli(["send", "--instance", "other-bot", "--message", "hi"], {
        env: { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
      })).rejects.toThrow('cctb send cannot target instance "other-bot"');

      await expect(runCli(["send", "--chat", "999", "--message", "hi"], {
        env: { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
      })).rejects.toThrow("cctb send cannot target another chat");

      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await removeTempRoot(tempDir);
    }
  });

  it("allows --instance when it names the turn's own instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-same-"));
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const messages: string[] = [];

    try {
      vi.stubGlobal("fetch", fetchFn);

      const handled = await runCli(["send", "--instance", "bot2", "--message", "hi"], {
        env: { USERPROFILE: tempDir, CODEX_TELEGRAM_INSTANCE: "bot2", ...SIDE_CHANNEL_ENV },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(messages).toEqual(["Sent via active Telegram turn."]);
    } finally {
      vi.unstubAllGlobals();
      await removeTempRoot(tempDir);
    }
  });

  it("surfaces rejection details when a requested file cannot be delivered", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-missing-"));
    const missingPath = path.join(tempDir, "project", "missing.pdf");
    const api = fakeApi();

    try {
      await mkdir(path.dirname(missingPath), { recursive: true });
      await seedSingleChatSession(tempDir);

      await expect(runConfiguredSendCommand(
        ["--file", missingPath],
        { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
        {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
        },
      )).rejects.toThrow(`1 file not delivered: ${missingPath} — not-found`);
      expect(api.sendMessage).toHaveBeenCalledWith(84, expect.stringContaining(missingPath));
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("fails with a readable error for oversized files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-large-"));
    const largePath = path.join(tempDir, "project", "large.bin");
    const api = fakeApi();

    try {
      await mkdir(path.dirname(largePath), { recursive: true });
      await writeFile(largePath, "");
      await truncate(largePath, 50_000_001);
      await seedSingleChatSession(tempDir);

      await expect(runConfiguredSendCommand(
        ["--file", largePath],
        { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
        {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
        },
      )).rejects.toThrow(`1 file not delivered: ${largePath} — too-large`);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith(84, expect.stringContaining("too large"));
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("cannot pick a chat when the instance has multiple sessions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-multi-"));

    try {
      const store = new SessionStore(path.join(tempDir, ".cctb", "default", "session.json"));
      const now = new Date().toISOString();
      await store.upsert({ telegramChatId: 84, codexSessionId: "telegram-84", status: "idle", updatedAt: now });
      await store.upsert({ telegramChatId: 85, codexSessionId: "telegram-85", status: "idle", updatedAt: now });

      await expect(runConfiguredSendCommand(
        ["--message", "hello"],
        { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
        {
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(fakeApi()),
        },
      )).rejects.toThrow("Multiple Telegram sessions found for this instance");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("rejects an absolute path outside the workspace sandbox", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-send-guard-sandbox-"));
    const outsidePath = path.join(tempDir, "outside", "id_rsa");
    const api = fakeApi();

    try {
      await mkdir(path.join(tempDir, "project"), { recursive: true });
      await mkdir(path.dirname(outsidePath), { recursive: true });
      await writeFile(outsidePath, "PRIVATE KEY", "utf8");
      await seedSingleChatSession(tempDir);

      await expect(runConfiguredSendCommand(
        ["--file", outsidePath],
        { USERPROFILE: tempDir, ...SIDE_CHANNEL_ENV },
        {
          cwd: path.join(tempDir, "project"),
          readConfiguredBotToken: vi.fn().mockResolvedValue("bot-token"),
          createTelegramApi: vi.fn().mockReturnValue(api),
        },
      )).rejects.toThrow(`1 file not delivered: ${outsidePath} — outside-workspace`);

      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });
});
