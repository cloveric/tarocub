import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { handleSimpleLocalTelegramCommand } from "../src/telegram/simple-commands.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

describe("handleSimpleLocalTelegramCommand", () => {
  it("handles /help and writes command audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/help"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringMatching(/\/reset|\/status/));
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "help",
          chunkCount: expect.any(Number),
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("handles /effort updates through the config mutator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = {};
      mutate(cfg);
      expect(cfg.effort).toBe("high");
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/effort high"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Effort set to high.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps Codex /effort max unchanged for GPT-5.6 models", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = {};
      mutate(cfg);
      expect(cfg.effort).toBe("max");
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/effort max"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Effort set to max.");

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "effort",
          value: "max",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("accepts case-insensitive Codex /effort ultra", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = {};
      mutate(cfg);
      expect(cfg.effort).toBe("ultra");
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", model: "gpt-5.6-terra" },
        normalized: createNormalizedMessage("/effort Ultra"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Effort set to ultra.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects ultra for GPT-5.6 Luna without changing config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", model: "gpt-5.6-luna", effort: "max" },
        normalized: createNormalizedMessage("/effort ultra"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "gpt-5.6-luna does not support ultra; its highest effort is max.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects switching an ultra instance to GPT-5.6 Luna", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", model: "gpt-5.6-sol", effort: "ultra" },
        normalized: createNormalizedMessage("/model gpt-5.6-luna"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "gpt-5.6-luna supports up to max, which is incompatible with current effort ultra; change /effort first.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps Claude /effort max unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = {};
      mutate(cfg);
      expect(cfg.effort).toBe("max");
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/effort max"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Effort set to max.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects Claude /effort ultra without changing config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/effort ultra"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Claude does not support ultra; use max for its highest effort.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not pretend to set Antigravity effort through bridge config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/effort high"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Antigravity effort is controlled by the native agy CLI; the bridge does not expose an effort startup flag yet. For model selection, open agy locally and use /model there.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("enables Codex fast mode through the config mutator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = {};
      mutate(cfg);
      expect(cfg.codexServiceTier).toBe("fast");
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/fast on"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Codex Fast Mode enabled. Supported models run faster but consume more credits.",
      );

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "fast",
          value: "fast",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /fast for Claude instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/fast on"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Fast Mode is Codex-only.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("disables Codex fast mode through /fast off", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = { codexServiceTier: "fast" };
      mutate(cfg);
      expect(cfg.codexServiceTier).toBeUndefined();
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", codexServiceTier: "fast" },
        normalized: createNormalizedMessage("/fast off"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 83,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Codex Fast Mode disabled.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reports Codex fast mode status without mutating config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", codexServiceTier: "fast" },
        normalized: createNormalizedMessage("/fast status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 84,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Codex Fast Mode: on");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps malformed /fast commands local instead of forwarding them to the engine", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/fast on extra"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 85,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Usage: /fast [on|off|status]");

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "fast",
          value: "invalid",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("shows Claude model choices on bare /model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/model"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Current model: default",
          "Choose a model with /model <name>:",
          "/model fable",
          "/model opus",
          "/model sonnet",
          "/model haiku",
          "/model off",
          "1M context example: /model opus[1m]",
        ].join("\n"),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("shows Codex model choices on bare /model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/model"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Current model: default",
          "Choose a model with /model <name>:",
          "/model gpt-5.6-sol",
          "/model gpt-5.6-terra",
          "/model gpt-5.6-luna",
          "/model gpt-5.5",
          "/model off",
          "Sol/Terra support max and ultra; Luna supports max but not ultra.",
        ].join("\n"),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("blocks Antigravity /model before it can be sent to agy --print as chat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();
    const normalized = createNormalizedMessage("/model@cloveric17bot Gemini 3.5 Flash High");

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized,
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(normalized.text).toBe("/model@cloveric17bot Gemini 3.5 Flash High");
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Antigravity model switching is not available from Telegram because agy --print does not run the interactive /model parser. Open agy locally and use /model there; the bridge will not forward /model as a chat prompt.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects multi-token /model values for Codex before they can break startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/model foo bar"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Usage: /model <single-token-name|off>",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("returns false for non-simple commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/not-a-simple-command"),
        context: {
          api: { sendMessage: vi.fn() } as never,
          instanceName: "default",
          updateId: 79,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("handles /status via the injected status snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const resolveStatus = vi.fn().mockResolvedValue({
      engine: "claude",
      sessionBound: true,
      threadId: null,
      blockingTasks: 2,
      waitingTasks: 1,
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig: vi.fn(),
        resolveStatus,
      });

      expect(handled).toBe(true);
      expect(resolveStatus).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Engine: claude",
          "Session bound: yes",
          "Blocking file tasks: 2",
          "Waiting file tasks: 1",
        ].join("\n"),
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "status",
          responseChars: expect.any(Number),
          chunkCount: 1,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("includes the current Codex thread id in /status when available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const resolveStatus = vi.fn().mockResolvedValue({
      engine: "codex",
      sessionBound: true,
      threadId: "thread-123",
      blockingTasks: 0,
      waitingTasks: 0,
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        updateInstanceConfig: vi.fn(),
        resolveStatus,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Engine: codex",
          "Session bound: yes",
          "Current thread: thread-123",
          "Blocking file tasks: 0",
          "Waiting file tasks: 0",
        ].join("\n"),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("includes the current Antigravity conversation id in /status when available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const resolveStatus = vi.fn().mockResolvedValue({
      engine: "antigravity",
      sessionBound: true,
      threadId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
      blockingTasks: 0,
      waitingTasks: 0,
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        updateInstanceConfig: vi.fn(),
        resolveStatus,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Engine: antigravity",
          "Session bound: yes",
          "Current conversation: fdfc8ab1-7936-4599-98b0-d8ba2593c250",
          "Blocking file tasks: 0",
          "Waiting file tasks: 0",
        ].join("\n"),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("handles /status defensively when no status resolver is wired", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Status handler is not wired for this command path.");
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "status",
          rejected: "status-handler-not-wired",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });
});
