import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createServiceDependenciesForInstance,
  parseServiceInstanceName,
  pollTelegramUpdatesOnce,
  pollTelegramUpdates,
  processTelegramUpdates,
  readInstanceBotTokenFromEnvFile,
  _resetEnqueuedUpdateIds,
} from "../src/service.js";
import { ChatQueue } from "../src/runtime/chat-queue.js";
import { Bridge } from "../src/runtime/bridge.js";
import { classifyFailure } from "../src/runtime/error-classification.js";
import { handleNormalizedTelegramMessage } from "../src/telegram/delivery.js";
import { normalizeUpdate } from "../src/telegram/update-normalizer.js";
import {
  renderCategorizedErrorMessage,
  renderErrorMessage,
  renderWorkingMessage,
} from "../src/telegram/message-renderer.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { ProcessClaudeAdapter } from "../src/codex/claude-adapter.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import * as auditLog from "../src/state/audit-log.js";
import { AccessStore } from "../src/state/access-store.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { JsonStore } from "../src/state/json-store.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Condition was not met in time");
}

function createZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(contents, "utf8"));
  }

  return zip.toBuffer();
}

function replaceBufferContents(buffer: Buffer, search: string, replace: string): Buffer {
  const searchBytes = Buffer.from(search, "utf8");
  const replaceBytes = Buffer.from(replace, "utf8");

  if (searchBytes.length !== replaceBytes.length) {
    throw new Error("replacement must preserve byte length");
  }

  const patched = Buffer.from(buffer);
  let offset = 0;
  while (offset <= patched.length - searchBytes.length) {
    const foundAt = patched.indexOf(searchBytes, offset);
    if (foundAt === -1) {
      break;
    }

    replaceBytes.copy(patched, foundAt);
    offset = foundAt + searchBytes.length;
  }

  return patched;
}

afterEach(async () => {
  _resetEnqueuedUpdateIds();
  await rm(path.join(os.tmpdir(), "ignored"), { recursive: true, force: true });
  await rm(path.join(os.tmpdir(), "runtime-state.json"), { force: true });
});

describe("parseServiceInstanceName", () => {
  it("defaults to the default instance", () => {
    expect(parseServiceInstanceName([])).toBe("default");
  });

  it("reads a named instance from --instance", () => {
    expect(parseServiceInstanceName(["--instance", "alpha"])).toBe("alpha");
  });

  it("reads a named instance from --instance=", () => {
    expect(parseServiceInstanceName(["--instance=beta"])).toBe("beta");
  });
});

describe("readInstanceBotTokenFromEnvFile", () => {
  it("reads TELEGRAM_BOT_TOKEN from the instance .env file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".cctb", "alpha", ".env");

    try {
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      await expect(
        readInstanceBotTokenFromEnvFile({
          USERPROFILE: root,
          CODEX_TELEGRAM_INSTANCE: "alpha",
        }),
      ).resolves.toBe("secret-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createServiceDependenciesForInstance", () => {
  it("does not mutate process.env.TELEGRAM_BOT_TOKEN directly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".cctb", "alpha", ".env");
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;

    try {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      expect(result.config.telegramBotToken).toBe("secret-token");
      expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    } finally {
      if (originalToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      }

      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the persistent Codex app-server adapter by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".cctb", "alpha", ".env");

    try {
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter).toBeInstanceOf(CodexAppServerAdapter);
      // Codex bots now share ~/.codex/ directly — same reasoning as Claude.
      expect((result.bridge as any).adapter.childEnv.CODEX_HOME).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honours CODEX_HOME injected through the EnvSource", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".cctb", "alpha", ".env");

    try {
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
          CODEX_HOME: "/tmp/custom-main-codex-home",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter.childEnv.CODEX_HOME).toBe("/tmp/custom-main-codex-home");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honours CLAUDE_CONFIG_DIR injected through the EnvSource", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CLAUDE_EXECUTABLE: "claude",
          CLAUDE_CONFIG_DIR: "/tmp/custom-main-claude-config",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter.childEnv.CLAUDE_CONFIG_DIR).toBe("/tmp/custom-main-claude-config");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create an engine-home for Codex instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const authPath = path.join(root, ".codex", "auth.json");
    const configTomlPath = path.join(root, ".codex", "config.toml");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(path.dirname(authPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(authPath, '{"access_token":"shared-token"}\n', "utf8");
      await writeFile(configTomlPath, 'model = "gpt-5.3-codex"\n', "utf8");

      await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      await expect(readFile(path.join(stateDir, "engine-home", "auth.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the process adapter when codex yolo mode is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter).toBeInstanceOf(ProcessCodexAdapter);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the Claude adapter when the instance engine is claude", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CLAUDE_EXECUTABLE: "claude",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter).toBeInstanceOf(ProcessClaudeAdapter);
      // Claude bots no longer isolate CLAUDE_CONFIG_DIR — they share the
      // user's ~/.claude/ so OAuth refresh tokens don't race across instances.
      expect((result.bridge as any).adapter.childEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create an engine-home for Claude instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");
    const globalClaudeDir = path.join(root, ".claude");
    const globalClaudeCredentialsPath = path.join(globalClaudeDir, ".credentials.json");
    const globalClaudeJsonPath = path.join(root, ".claude.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(globalClaudeDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");
      await writeFile(globalClaudeCredentialsPath, '{"claudeAiOauth":{"accessToken":"shared-token"}}\n', "utf8");
      await writeFile(globalClaudeJsonPath, '{"projects":{}}\n', "utf8");

      await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CLAUDE_EXECUTABLE: "claude",
        },
        "alpha",
      );

      // engine-home should not exist — nothing to seed anymore
      await expect(readFile(path.join(stateDir, "engine-home", ".credentials.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("polling helpers", () => {
  it("processes the same Telegram update only once across repeated polls", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      const update = {
        update_id: 42,
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "hello",
        },
      };

      await processTelegramUpdates(
        [update],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );
      await processTelegramUpdates(
        [update],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips updates whose update_id is lower than or equal to the last handled update", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await processTelegramUpdates(
        [
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "first",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      await processTelegramUpdates(
        [
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "duplicate",
            },
          },
          {
            update_id: 9,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "older",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps processing increasing update ids", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await processTelegramUpdates(
        [
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "first",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      await processTelegramUpdates(
        [
          {
            update_id: 11,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "second",
            },
          },
          {
            update_id: 12,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "third",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(3);
      expect(api.sendMessage).toHaveBeenCalledTimes(3);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advances offset past a failed update and continues processing", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi.fn().mockResolvedValue([
        {
          update_id: 10,
          message: {
            chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "first",
          },
        },
        {
          update_id: 11,
          message: {
            chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "second",
          },
        },
      ]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi
        .fn()
        .mockResolvedValueOnce({ text: "first result" })
        .mockRejectedValueOnce(new Error("boom")),
    };

    const result = await pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7);
    expect(result.hadFetchError).toBe(false);
    expect(result.hadUpdates).toBe(true);
    expect(result.conflict).toBe(false);

    // Wait for background processing to complete
    await new Promise((r) => setTimeout(r, 100));
    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
  });

  it("continues processing later updates after a failed update", async () => {
    const logger = {
      error: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ text: "second result" }),
    };

    await processTelegramUpdates(
      [
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "first",
          },
        },
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "second",
          },
        },
      ],
      {
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          editMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
        } as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
      logger,
    );

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
  });

  it("logs getUpdates failures without crashing the loop helper", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("temporary failure")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    await expect(
      pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
    ).resolves.toEqual({
      offset: 7,
      hadFetchError: true,
      hadUpdates: false,
      conflict: false,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });

  it("appends poll-side getUpdates failures to the audit stream with a failure category", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("temporary Telegram API failure")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        pollTelegramUpdatesOnce(api as never, bridge as never, inboxDir, logger, 7),
      ).resolves.toEqual({
        offset: 7,
        hadFetchError: true,
        hadUpdates: false,
        conflict: false,
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toEqual([
        expect.objectContaining({
          type: "poll.fetch",
          outcome: "error",
          detail: "temporary Telegram API failure",
          metadata: expect.objectContaining({
            failureCategory: "telegram-delivery",
          }),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generic poll failures best-effort when audit writing fails", async () => {
    const logger = {
      error: vi.fn(),
    };
    const appendSpy = vi.spyOn(auditLog, "appendAuditEvent").mockRejectedValue(new Error("audit write failed"));
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("temporary Telegram API failure")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
      ).resolves.toEqual({
        offset: 7,
        hadFetchError: true,
        hadUpdates: false,
        conflict: false,
      });

      expect(logger.error).toHaveBeenCalledWith("Failed to fetch Telegram updates: temporary Telegram API failure");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("treats aborted polling as a clean shutdown instead of a fetch failure", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("Telegram API request aborted")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    await expect(
      pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
    ).resolves.toEqual({
      offset: 7,
      hadFetchError: false,
      hadUpdates: false,
      conflict: false,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("appends poll conflicts to the audit stream with telegram-conflict classification", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("409 Conflict: terminated by other getUpdates request")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        pollTelegramUpdatesOnce(api as never, bridge as never, inboxDir, logger, 7),
      ).resolves.toEqual({
        offset: 7,
        hadFetchError: true,
        hadUpdates: false,
        conflict: true,
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toEqual([
        expect.objectContaining({
          type: "poll.fetch",
          outcome: "error",
          metadata: expect.objectContaining({
            failureCategory: "telegram-conflict",
          }),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps poll conflicts best-effort when audit writing fails", async () => {
    const logger = {
      error: vi.fn(),
    };
    const appendSpy = vi.spyOn(auditLog, "appendAuditEvent").mockRejectedValue(new Error("audit write failed"));
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("409 Conflict: terminated by other getUpdates request")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
      ).resolves.toEqual({
        offset: 7,
        hadFetchError: true,
        hadUpdates: false,
        conflict: true,
      });

      expect(logger.error).toHaveBeenCalledWith(
        "409 Conflict: another process is polling this bot token. Shutting down to avoid duplicate replies.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("does not enter immediate retry when updates failed before offset advanced", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi
        .fn()
        .mockResolvedValueOnce([
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "first",
            },
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const sleepCalls: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    try {
      const controller = new AbortController();
      let pollCount = 0;
      globalThis.setTimeout = (((handler: TimerHandler, timeout?: number) => {
        sleepCalls.push(Number(timeout ?? 0));
        if (typeof handler === "function") {
          queueMicrotask(() => handler());
        }
        pollCount += 1;
        if (pollCount >= 2) {
          controller.abort();
        }
        return {} as ReturnType<typeof setTimeout>;
      }) as unknown) as typeof setTimeout;

      await pollTelegramUpdates(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, controller.signal);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(sleepCalls[0]).toBe(100);
  });

  it("serializes same-chat updates through the service chat queue", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
    };
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const releaseFirstCall = createDeferred<void>();
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ text }: { text: string }) => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);

        if (text === "first") {
          await releaseFirstCall.promise;
        }

        activeCalls -= 1;
        return { text: `${text} done` };
      }),
    };
    const chatQueue = new ChatQueue();
    const firstRun = processTelegramUpdates(
      [
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "first",
          },
        },
      ],
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
        chatQueue,
      },
      logger,
    );
    const secondRun = processTelegramUpdates(
      [
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "second",
          },
        },
      ],
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
        chatQueue,
      },
      logger,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(maxConcurrentCalls).toBe(1);

    releaseFirstCall.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
    expect(maxConcurrentCalls).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("downloads attachments and passes local file paths to the bridge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi
        .fn()
        .mockResolvedValueOnce({ file_path: "docs/report.pdf" })
        .mockResolvedValueOnce({ file_path: "photos/pic.jpg" }),
      downloadFile: vi
        .fn()
        .mockImplementation(async (_filePath: string, destinationPath: string) => await writeFile(destinationPath, "x")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [
            { fileId: "doc-1", fileName: "report.pdf", kind: "document" },
            { fileId: "photo-1", kind: "photo" },
          ],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.getFile).toHaveBeenCalledTimes(2);
      expect(api.downloadFile).toHaveBeenCalledTimes(2);
      expect(api.sendChatAction).toHaveBeenCalledWith(123);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: expect.stringContaining("hello"),
        replyContext: undefined,
        files: [
          expect.stringContaining(path.join("workspace", ".telegram-files")),
          expect.stringContaining(path.join("workspace", ".telegram-files")),
        ],
      }));
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain("[Document Extract]");
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain("[Image Uploads]");
      await expect(readFile(path.join(inboxDir, "doc-1-report.pdf"), "utf8")).resolves.toBe("x");
      await expect(readFile(path.join(inboxDir, "photo-1.jpg"), "utf8")).resolves.toBe("x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("summarizes uploaded zip archives and waits for continue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "package.json": '{"name":"demo"}',
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, expect.stringContaining(
          "Reply \"继续分析\" or press Continue Analysis to continue this archive. Bare /continue resumes the latest waiting archive.",
        ),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: expect.stringMatching(/^continue-archive:/) }]],
        }),
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string; status: string; kind: string; summary: string }>;
      };
      expect(workflowState.records).toHaveLength(1);
      expect(workflowState.records[0]?.kind).toBe("archive");
      expect(workflowState.records[0]?.status).toBe("awaiting_continue");
      expect(workflowState.records[0]?.summary).toContain("README.md");
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, expect.stringContaining(
          "Reply \"继续分析\" or press Continue Analysis to continue this archive. Bare /continue resumes the latest waiting archive.",
        ),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${workflowState.records[0]?.uploadId}` }]],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows a continue-analysis shortcut button after archive summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string }>;
      };

      expect(api.sendMessage).toHaveBeenCalledWith(
        123, expect.stringContaining('Reply "继续分析"'),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${workflowState.records[0]?.uploadId}` }]],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a failed archive workflow record when extraction is rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/bad.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "not a zip archive", "utf8");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "bad.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{
          uploadId: string;
          status: string;
          kind: string;
          sourceFiles: string[];
          extractedPath?: string;
          summary: string;
        }>;
      };

      expect(workflowState.records).toHaveLength(1);
      expect(workflowState.records[0]).toEqual(expect.objectContaining({
        kind: "archive",
        status: "failed",
        extractedPath: expect.stringContaining(path.join("workspace", ".telegram-files")),
        sourceFiles: [expect.stringContaining(path.join("workspace", ".telegram-files"))],
        summary: expect.stringMatching(/invalid|zip|archive/i),
      }));
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: File handling failed while preparing your request. Retry with a smaller or different file.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects archive entries that escape into a sibling prefix directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const placeholderEntryName = "xxxxxxxxxxxxxxxxxxxxxxxxxx";
    const zipBuffer = replaceBufferContents(
      createZipBuffer({
        [placeholderEntryName]: "escape attempt",
        "README.md": "# hello",
      }),
      placeholderEntryName,
      "../extracted-evil/file.txt",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/evil.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "evil.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string; kind: string; summary: string }>;
      };

      expect(workflowState.records[0]).toEqual(
        expect.objectContaining({
          kind: "archive",
          status: "failed",
          summary: expect.stringMatching(/escapes target directory/i),
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues analysis for the latest uploaded archive when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "继续分析 看看结构",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 123,
          text: expect.stringContaining("[Archive Analysis Context]"),
          files: [],
        }),
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "看看结构",
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "Extracted files live under:",
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes the most recently updated waiting archive even when records are out of order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "archive-new",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-new.zip"],
            derivedFiles: [],
            summary: "archive summary new",
            extractedPath: "workspace/.telegram-files/archive-new/extracted",
            createdAt: "2026-04-10T00:05:00.000Z",
            updatedAt: "2026-04-10T00:05:00.000Z",
          },
          {
            uploadId: "archive-old",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-old.zip"],
            derivedFiles: [],
            summary: "archive summary old",
            extractedPath: "workspace/.telegram-files/archive-old/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/continue",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary new"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary old"),
        }),
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string; status: string }>;
      };
      expect(workflowState.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uploadId: "archive-new", status: "completed" }),
          expect.objectContaining({ uploadId: "archive-old", status: "awaiting_continue" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects new uploads when three archives are already waiting for continuation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "archive-1",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-1.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/archive-1/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            uploadId: "archive-2",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-2.zip"],
            derivedFiles: [],
            summary: "archive summary two",
            extractedPath: "workspace/.telegram-files/archive-2/extracted",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
          {
            uploadId: "archive-3",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-3.zip"],
            derivedFiles: [],
            summary: "archive summary three",
            extractedPath: "workspace/.telegram-files/archive-3/extracted",
            createdAt: "2026-04-10T00:02:00.000Z",
            updatedAt: "2026-04-10T00:02:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/note.txt" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "hello", "utf8");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "analyze this note",
          replyContext: undefined,
          attachments: [{ fileId: "doc-1", fileName: "note.txt", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Too many active file tasks for this chat. Wait for current tasks to finish or use /reset.",
        undefined,
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string; status: string }>;
      };
      expect(workflowState.records).toHaveLength(3);
      expect(workflowState.records.every((record) => record.status === "awaiting_continue")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a continued archive as failed when engine execution fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const continuationStarted = createDeferred<void>();
    const allowFailure = createDeferred<void>();
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async () => {
        continuationStarted.resolve();
        await allowFailure.promise;
        throw new Error("engine failed during continuation");
      }),
    };

    try {
      const continuationPromise = handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "继续分析 看看结构",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      await continuationStarted.promise;
      const inFlightState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(inFlightState.records[0]?.status).toBe("processing");

      allowFailure.resolve();

      await expect(continuationPromise).resolves.toBeUndefined();

      const finalState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(finalState.records[0]?.status).toBe("failed");
    } finally {
      allowFailure.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not mark a continued archive completed until Telegram delivery fully succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ engine: "codex" }) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockRejectedValue(new Error("sendDocument failed after response")),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }

        await writeFile(path.join(requestOutputDir, "report.txt"), "hello from workflow", "utf8");
        return { text: "continuation complete" };
      }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "继续分析 并生成文件发给我",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("failed");
      expect(api.sendMessage).toHaveBeenCalledWith(123, "continuation complete", expect.anything());
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still delivers the categorized Telegram error when workflow cleanup fails in catch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const updateSpy = vi.spyOn((await import("../src/state/file-workflow-store.js")).FileWorkflowStore.prototype, "update")
      .mockRejectedValue(new Error("workflow cleanup write failed"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("engine failed during continuation")),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "继续分析 看看结构",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        renderCategorizedErrorMessage(
          classifyFailure(new Error("engine failed during continuation")),
          "engine failed during continuation",
        ),
      );
    } finally {
      updateSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps archive-specific callback queries to the targeted /continue flow", async () => {
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 11, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:a0000000-0000-0000-0000-000000000001",
      },
    });

    expect(normalized).toEqual(expect.objectContaining({ text: "/continue --upload a0000000-0000-0000-0000-000000000001" }));
    expect(normalized?.replyContext).toBeUndefined();
  });

  it("continues the archive selected by the clicked callback when multiple archives are waiting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            uploadId: "b0000000-0000-0000-0000-000000000002",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-2.zip"],
            derivedFiles: [],
            summary: "archive summary two",
            extractedPath: "workspace/.telegram-files/b0000000-0000-0000-0000-000000000002/extracted",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 11, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:a0000000-0000-0000-0000-000000000001",
      },
    });

    try {
      await handleNormalizedTelegramMessage(
        normalized!,
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb-1");
      expect(api.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(api.sendMessage.mock.invocationCallOrder[0]);
      expect(api.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(api.sendMessage.mock.invocationCallOrder[0]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[Archive Analysis Context]"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary one"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          replyContext: undefined,
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          replyContext: expect.objectContaining({
            text: expect.stringContaining("Archive summary"),
          }),
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary two"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: "/continue" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues the clicked archive even when callback ack fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockRejectedValue(new Error("ack failed")),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 11, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:a0000000-0000-0000-0000-000000000001",
      },
    });

    try {
      await expect(
        handleNormalizedTelegramMessage(
          normalized!,
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb-1");
      expect(api.sendMessage).toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary one"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues the replied archive summary when older and newer archives are both waiting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            summaryMessageId: 41,
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            uploadId: "b0000000-0000-0000-0000-000000000002",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-2.zip"],
            derivedFiles: [],
            summary: "archive summary two",
            summaryMessageId: 42,
            extractedPath: "workspace/.telegram-files/b0000000-0000-0000-0000-000000000002/extracted",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "continued" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "继续分析 看看结构",
          replyContext: {
            messageId: 41,
            text: "archive summary one",
          },
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary one"),
          replyContext: undefined,
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary two"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replies with an already-completed message when a replied summary targets a completed archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "completed",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            summaryMessageId: 41,
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:02:00.000Z",
          },
          {
            uploadId: "b0000000-0000-0000-0000-000000000002",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-2.zip"],
            derivedFiles: [],
            summary: "archive summary two",
            summaryMessageId: 42,
            extractedPath: "workspace/.telegram-files/b0000000-0000-0000-0000-000000000002/extracted",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "continued" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "继续分析 看看结构",
          replyContext: {
            messageId: 41,
            text: "archive summary one",
          },
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "That archive has already completed continued analysis in this chat.",
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replies with an already-processing message when the targeted continue button is pressed again mid-run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "processing",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            summaryMessageId: 41,
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "continued" }),
    };
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 41, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:a0000000-0000-0000-0000-000000000001",
      },
    });

    try {
      await handleNormalizedTelegramMessage(normalized!, {
        api: api as never,
        bridge: bridge as never,
        inboxDir,
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "That archive is already being processed in this chat.",
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("guides targeted archive retries back to the same summary after continuation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            summaryMessageId: 41,
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("transient failure")),
    };
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 41, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:a0000000-0000-0000-0000-000000000001",
      },
    });

    try {
      await expect(
        handleNormalizedTelegramMessage(normalized!, {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        }),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        [
          "Error: An unexpected failure occurred. Reset the chat or retry the request.",
          "Retry this specific archive from its original summary: press Continue Analysis again there or reply \"继续分析\" to that summary.",
        ].join("\n"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed targeted /continue --upload syntax instead of resuming the latest archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            summaryMessageId: 41,
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "continued" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/continue --upload",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        'Malformed continue command. Use /continue, the Continue Analysis button, or reply "继续分析" to the archive summary.',
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a failed archive when the targeted continue button is pressed again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValueOnce(new Error("transient failure")).mockResolvedValueOnce({ text: "retry succeeded" }),
    };
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 41, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:a0000000-0000-0000-0000-000000000001",
      },
    });

    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            summaryMessageId: 41,
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    try {
      await expect(
        handleNormalizedTelegramMessage(normalized!, {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        }),
      ).resolves.toBeUndefined();

      const failedState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(failedState.records[0]?.status).toBe("failed");

      await handleNormalizedTelegramMessage(
        normalized!,
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          text: expect.stringContaining("[Archive Analysis Context]"),
        }),
      );

      const finalState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(finalState.records[0]?.status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores the archive summary message id for reply-based continuation targeting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const updateSpy = vi.spyOn(FileWorkflowStore.prototype, "update");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ summaryMessageId?: number; status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("awaiting_continue");
      expect(workflowState.records[0]?.summaryMessageId).toBe(11);
      expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(api.sendMessage.mock.invocationCallOrder.at(-1)!);
    } finally {
      updateSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a delivered archive summary visible when late bookkeeping fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const appendSpy = vi.spyOn(auditLog, "appendAuditEvent").mockRejectedValue(new Error("audit write failed"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, expect.stringContaining("Archive summary:"),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: expect.stringMatching(/^continue-archive:/) }]],
        }),
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string; summaryMessageId?: number }>;
      };
      expect(workflowState.records[0]?.status).toBe("awaiting_continue");
      expect(workflowState.records[0]?.summaryMessageId).toBe(11);
    } finally {
      appendSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replay a delivered continuation when the completed-state write fails late", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "a0000000-0000-0000-0000-000000000001",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/a0000000-0000-0000-0000-000000000001/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const updateSpy = vi.spyOn(FileWorkflowStore.prototype, "update").mockRejectedValue(new Error("workflow write failed"));
    const api = {
      getUpdates: vi.fn().mockResolvedValue([
        {
          update_id: 10,
          message: {
            chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "/continue",
          },
        },
      ]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "continuation complete" }),
    };

    try {
      const result = await pollTelegramUpdatesOnce(api as never, bridge as never, inboxDir, logger, 7);
      expect(result.hadFetchError).toBe(false);
      expect(result.hadUpdates).toBe(true);
      expect(result.conflict).toBe(false);

      // Wait for background processing to complete
      await new Promise((r) => setTimeout(r, 100));
      expect(api.sendMessage).toHaveBeenCalledWith(123, "continuation complete", expect.anything());
      expect(logger.error).not.toHaveBeenCalled();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("processing");
    } finally {
      updateSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds a long archive summary before sending it with the continue keyboard", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const manyFiles = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `src/feature-${String(index).padStart(3, "0")}/component-${String(index).padStart(3, "0")}.ts`,
        `export const value${index} = ${index};`,
      ]),
    );
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      ...manyFiles,
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      const summaryDelivery = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(summaryDelivery?.[1]).toContain("Reply \"继续分析\" or press Continue Analysis to continue this archive.");
      expect(summaryDelivery?.[1]).toContain("Bare /continue resumes the latest waiting archive.");
      expect((summaryDelivery?.[1] as string).length).toBeLessThanOrEqual(3900);
      expect(summaryDelivery?.[2]).toEqual(
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: expect.stringMatching(/^continue-archive:/) }]],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the archive summary message id even when summary delivery fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 11 })
        .mockRejectedValueOnce(new Error("message is too long"))
        .mockResolvedValueOnce({ message_id: 12 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string; summaryMessageId?: number }>;
      };
      expect(workflowState.records[0]?.summaryMessageId).toBe(11);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs archive workflow state when summary preparation fails before returning its workflow id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const invalidZipBuffer = Buffer.from("not a zip archive", "utf8");
    const updateSpy = vi.spyOn(FileWorkflowStore.prototype, "update");
    updateSpy.mockRejectedValueOnce(new Error("workflow state write failed"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, invalidZipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string; summary: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("failed");
      expect(workflowState.records[0]?.summary).toContain("Preparing archive summary");
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        renderCategorizedErrorMessage("file-workflow", "ignored"),
      );
    } finally {
      updateSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not append an archive summary record in processing state before delivery succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const appendSpy = vi.spyOn(FileWorkflowStore.prototype, "append");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 11 })
        .mockRejectedValueOnce(new Error("message is too long"))
        .mockResolvedValueOnce({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(appendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ status: "processing" }));
    } finally {
      appendSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders unreadable file-workflow state during upload as an internal recovery error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "file-workflow.json"), "{not valid json", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/report.pdf" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, "hello", "utf8");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "analyze this",
            replyContext: undefined,
            attachments: [{ fileId: "doc-1", fileName: "report.txt", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders unreadable file-workflow state during archive continuation as an internal recovery error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "file-workflow.json"), "{not valid json", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "继续分析",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects extracted text for supported document uploads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "docs/note.md" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "# Heading\nBody text");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "帮我总结",
          replyContext: undefined,
          attachments: [{ fileId: "doc-1", fileName: "note.md", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[Document Extract]"),
          files: expect.any(Array),
        }),
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "# Heading\nBody text",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages image uploads and forwards explicit image context to the bridge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/screenshot.jpg" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "img");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "看看这张图",
          replyContext: undefined,
          attachments: [{ fileId: "photo-1", kind: "photo" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[Image Uploads]"),
          files: [expect.stringContaining(path.join("workspace", ".telegram-files"))],
        }),
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "看看这张图",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows typing indicator and sends response as new message", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "final response" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(api.sendChatAction).toHaveBeenCalledWith(123);
    expect(api.sendMessage).toHaveBeenCalledWith(123, "final response", expect.anything());
    expect(api.editMessage).not.toHaveBeenCalled();
  });

  it("uses typing indicator instead of progress edits during engine execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "final response" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendChatAction).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "final response", expect.anything());
      expect(api.editMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resets only the current chat session when /reset is sent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            telegramChatId: 456,
            codexSessionId: "thread-keep",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(123, "Session reset for this chat.");
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual(expect.objectContaining({
        chats: [
          {
            telegramChatId: 456,
            codexSessionId: "thread-keep",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a concise status message for /status with blocking tasks called out separately", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-bound",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "one",
            chatId: 123,
            userId: 456,
            kind: "document",
            status: "processing",
            sourceFiles: ["a.txt"],
            derivedFiles: [],
            summary: "first",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            uploadId: "two",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "preparing",
            sourceFiles: ["prep.zip"],
            derivedFiles: [],
            summary: "preparing summary",
            createdAt: "2026-04-10T00:00:30.000Z",
            updatedAt: "2026-04-10T00:00:30.000Z",
          },
          {
            uploadId: "three",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["b.zip"],
            derivedFiles: [],
            summary: "second",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
          {
            uploadId: "four",
            chatId: 123,
            userId: 456,
            kind: "document",
            status: "failed",
            sourceFiles: ["c.txt"],
            derivedFiles: [],
            summary: "third failed",
            createdAt: "2026-04-10T00:02:00.000Z",
            updatedAt: "2026-04-10T00:02:00.000Z",
          },
          {
            uploadId: "five",
            chatId: 123,
            userId: 456,
            kind: "document",
            status: "completed",
            sourceFiles: ["d.txt"],
            derivedFiles: [],
            summary: "fourth",
            createdAt: "2026-04-10T00:03:00.000Z",
            updatedAt: "2026-04-10T00:03:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/status",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        [
          "Engine: codex",
          "Session bound: yes",
          "Blocking file tasks: 3",
          "Waiting file tasks: 1",
        ].join("\n"),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades /status when session and workflow state are unreadable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "session.json"), "{not valid json", "utf8");
    await writeFile(path.join(root, "file-workflow.json"), "{not valid json", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/status",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        [
          "Engine: codex",
          "Session bound: unknown (session state unreadable)",
          "Blocking file tasks: unknown (file workflow state unreadable)",
          "Waiting file tasks: unknown (file workflow state unreadable)",
        ].join("\n"),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies malformed session state on the normal message path as session-state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "session.json"), "{not valid json", "utf8");
    const accessStorePath = path.join(root, "access.json");
    const sessionStorePath = path.join(root, "session.json");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const adapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const accessStore = new AccessStore(accessStorePath);
    await accessStore.setPolicy("allowlist");
    await accessStore.allowChat(123);
    const sessionStore = new SessionStore(sessionStorePath);
    const sessionManager = new SessionManager(sessionStore, adapter as never);
    const bridge = new Bridge(accessStore, sessionManager, adapter as never);

    try {
      await processTelegramUpdates(
        [
          {
            update_id: 42,
            message: {
              message_id: 11,
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "hello",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Session state is unreadable right now. The operator needs to repair session state and retry.",
      );
      expect(adapter.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports permission-denied session state without suggesting reset on the normal message path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await mkdir(inboxDir, { recursive: true });
    const accessStorePath = path.join(root, "access.json");
    const sessionStorePath = path.join(root, "session.json");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const adapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const accessStore = new AccessStore(accessStorePath);
    await accessStore.setPolicy("allowlist");
    await accessStore.allowChat(123);
    const sessionStore = new SessionStore(sessionStorePath);
    const readSpy = vi.spyOn((sessionStore as unknown as { store: JsonStore<unknown> }).store, "read");
    readSpy.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const sessionManager = new SessionManager(sessionStore, adapter as never);
    const bridge = new Bridge(accessStore, sessionManager, adapter as never);

    try {
      await processTelegramUpdates(
        [
          {
            update_id: 42,
            message: {
              message_id: 11,
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "hello",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Session state is unavailable right now. The operator needs to restore read access and retry.",
      );
      expect(adapter.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns help text for /help", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/help",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, expect.stringContaining("/status"),
      );
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, expect.stringContaining("/ask"),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the /help success text in place when audit logging fails late", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateBlocker = path.join(root, "state-blocker");
    await writeFile(stateBlocker, "not a directory", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    await expect(
      handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/help",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir: path.join(stateBlocker, "inbox"),
        },
      ),
    ).resolves.toBeUndefined();

    expect(api.sendMessage).toHaveBeenLastCalledWith(
      123, expect.stringContaining("/help"),
    );
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps /status successful when late audit writing fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, "state");
    const inboxDir = path.join(stateDir, "inbox");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(path.join(stateDir, "audit.log.jsonl"));
    await writeFile(path.join(stateDir, "session.json"), JSON.stringify({ chats: [] }), "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "/status",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        [
          "Engine: codex",
          "Session bound: no",
          "Blocking file tasks: 0",
          "Waiting file tasks: 0",
        ].join("\n"),
      );
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps /reset successful when late audit writing fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, "state");
    const inboxDir = path.join(stateDir, "inbox");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(path.join(stateDir, "audit.log.jsonl"));
    await writeFile(
      path.join(stateDir, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "/reset",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(123, "Session reset for this chat.");
      expect(JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"))).toEqual(expect.objectContaining({ chats: [] }));
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reset session state when /reset is denied by access control", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "deny", text: "This chat is not authorized for this instance." }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(123, "This chat is not authorized for this instance.");
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows operator guidance when unreadable session state is encountered on /reset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "session.json"), "{not valid json", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "/reset",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Session state is unreadable right now. The operator needs to repair session state and retry.",
      );
      await expect(readFile(path.join(root, "session.json"), "utf8")).resolves.toBe("{not valid json");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows operator guidance when /reset hits non-repairable session-state read failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const readSpy = vi.spyOn(JsonStore.prototype, "read");
    readSpy.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "/reset",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Session state is unavailable right now. The operator needs to restore read access and retry.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps /reset on explicit session-state guidance when wrapped permission failures lose errno metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const inspectSpy = vi.spyOn(SessionStore.prototype, "inspect");
    inspectSpy.mockResolvedValueOnce({
      state: { chats: [] },
      warning: "session state unreadable",
      repairable: false,
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "/reset",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: Session state is unavailable right now. The operator needs to restore read access and retry.",
      );
      expect(api.sendMessage).not.toHaveBeenLastCalledWith(
        123, "Error: File creation is blocked by the current write policy. Retry in a writable mode.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      inspectSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reset session state when /reset is blocked by pairing access control", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "reply", text: "Pair this private chat with code ABC123" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.sendMessage).toHaveBeenLastCalledWith(123, "Pair this private chat with code ABC123");
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a write-permission error with recovery guidance", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("write access denied")),
    };
    const normalized = {
      chatId: 123,
      userId: 456,
      chatType: "private" as const,
      text: "hello",
      replyContext: undefined,
      attachments: [],
    };

    await expect(
      handleNormalizedTelegramMessage(normalized, {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      }),
    ).resolves.toBeUndefined();

    expect(api.sendMessage).toHaveBeenLastCalledWith(
      123, "Error: File creation is blocked by the current write policy. Retry in a writable mode.",
    );
  });

  it("edits the placeholder to an error message when the bridge throws", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(
      handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir: path.join(os.tmpdir(), "ignored"),
        },
      ),
    ).resolves.toBeUndefined();

    expect(api.sendMessage).toHaveBeenCalledWith(
      123, "Error: An unexpected failure occurred. Reset the chat or retry the request.",
    );
  });

  it("keeps the original request error when error-path audit persistence fails", async () => {
    const appendSpy = vi.spyOn(auditLog, "appendAuditEvent").mockRejectedValue(new Error("audit write failed"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "hello",
            replyContext: undefined,
            attachments: [],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir: path.join(os.tmpdir(), "ignored"),
          },
        ),
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123, "Error: An unexpected failure occurred. Reset the chat or retry the request.",
      );
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("records categorized failures in audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("Not logged in · Please run /login")),
    };
    const normalized = {
      chatId: 123,
      userId: 456,
      chatType: "private" as const,
      text: "hello",
      replyContext: undefined,
      attachments: [],
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(normalized, {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        }),
      ).resolves.toBeUndefined();

      const audit = await readFile(path.join(root, "audit.log.jsonl"), "utf8");
      expect(audit).toContain('"failureCategory":"auth"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chunks long responses by editing the placeholder with the first chunk and sending the rest", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "a".repeat(4500) }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(api.sendMessage).toHaveBeenCalledWith(123, "a".repeat(4000), expect.anything());
    expect(api.sendMessage).toHaveBeenCalledWith(123, "a".repeat(500), expect.anything());
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("sends a separate error message when a follow-up chunk fails", async () => {
    const api = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 11 })
        .mockRejectedValueOnce(new Error("send failed"))
        .mockResolvedValueOnce({ message_id: 12 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "a".repeat(4500) }),
    };

    await expect(
      handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir: path.join(os.tmpdir(), "ignored"),
        },
      ),
    ).resolves.toBeUndefined();

    expect(api.sendChatAction).toHaveBeenCalledWith(123);
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("passes quoted reply context to the bridge", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "reply",
        replyContext: {
          messageId: 77,
          text: "quoted text",
        },
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "reply",
      replyContext: {
        messageId: 77,
        text: "quoted text",
      },
      files: [],
    }));
  });

  it("sends a document when the model returns a file block", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi
        .fn()
        .mockResolvedValue({ text: "```file:report.txt\nhello world\n```" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "send file",
        replyContext: undefined,
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );
    expect(api.sendDocument).toHaveBeenCalledWith(123, "report.txt", "hello world\n");
  });

  it("sends files generated into codex telegram-out directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }

        await writeFile(path.join(requestOutputDir, "hello.txt"), "hello from codex", "utf8");
        return { text: "done" };
      }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "请生成一个文件并传给我",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestOutputDir: expect.stringContaining(path.join("workspace", ".telegram-out")),
        }),
      );
      expect(api.sendDocument).toHaveBeenCalledWith(
        123,
        "hello.txt",
        expect.any(Uint8Array),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create codex telegram-out directories for ordinary messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMediaGroup: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "你好",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestOutputDir: undefined,
        }),
      );
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
