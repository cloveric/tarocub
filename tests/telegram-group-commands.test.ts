import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleGroupCommand } from "../src/telegram/group-commands.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function normalized(text: string, input: Partial<NormalizedTelegramMessage> = {}): NormalizedTelegramMessage {
  return {
    chatId: -100123,
    userId: 42,
    chatType: "supergroup",
    text,
    attachments: [],
    ...input,
  };
}

describe("handleGroupCommand", () => {
  it("allows an authorized user to enable the current group", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = {};
      mutate(cfg);
      expect(cfg.groupMode).toEqual({
        enabled: true,
        allowedChatIds: [-100123],
        listenAllChatIds: [],
      });
    });

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: {
          groupMode: {
            enabled: true,
            allowedChatIds: [],
            listenAllChatIds: [],
          },
        },
        normalized: normalized("/group allow"),
        context: {
          api: api as never,
          bridge: {
            checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }),
          },
          instanceName: "default",
          updateId: 77,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("Allowed this group"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("silences unauthorized group management from non-private chats", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: {
          groupMode: {
            enabled: true,
            allowedChatIds: [],
            listenAllChatIds: [],
          },
        },
        normalized: normalized("/group allow", { userId: 999 }),
        context: {
          api: api as never,
          bridge: {
            checkUserAuthorization: vi.fn().mockResolvedValue({
              kind: "reply",
              text: "This chat is not authorized for this instance.",
            }),
          },
          instanceName: "default",
          updateId: 78,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still replies to unauthorized group management attempts in private chat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: {
          groupMode: {
            enabled: true,
            allowedChatIds: [],
            listenAllChatIds: [],
          },
        },
        normalized: normalized("/group allow", { chatId: 123, chatType: "private", userId: 999 }),
        context: {
          api: api as never,
          bridge: {
            checkUserAuthorization: vi.fn().mockResolvedValue({
              kind: "reply",
              text: "This chat is not authorized for this instance.",
            }),
          },
          instanceName: "default",
          updateId: 78,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "This chat is not authorized for this instance.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prompts when /group allow is sent from private chat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: { groupMode: { enabled: true, allowedChatIds: [], listenAllChatIds: [] } },
        normalized: normalized("/group allow", { chatId: 123, chatType: "private" }),
        context: {
          api: api as never,
          bridge: { checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }) },
          instanceName: "default",
          updateId: 79,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("inside the group"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the current group and leaves on /group deny", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = {
        groupMode: {
          enabled: true,
          allowedChatIds: [-100123, -100456],
          listenAllChatIds: [-100123],
        },
      };
      mutate(cfg);
      expect(cfg.groupMode).toEqual({
        enabled: true,
        allowedChatIds: [-100456],
        listenAllChatIds: [],
      });
    });

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: { groupMode: { enabled: true, allowedChatIds: [-100123, -100456], listenAllChatIds: [-100123] } },
        normalized: normalized("/group deny"),
        context: {
          api: api as never,
          bridge: { checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }) },
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("Removed this group"));
      expect(api.leaveChat).toHaveBeenCalledWith(-100123);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("toggles group mode and reports invalid usage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = { groupMode: { enabled: true, allowedChatIds: [-100123] } };
      mutate(cfg);
    });
    const base = {
      stateDir: root,
      startedAt: Date.now() - 5,
      locale: "en" as const,
      cfg: { groupMode: { enabled: true, allowedChatIds: [-100123], listenAllChatIds: [] } },
      context: {
        api: api as never,
        bridge: { checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }) },
        instanceName: "default",
        updateId: 81,
      },
      updateInstanceConfig,
    };

    try {
      await handleGroupCommand({ ...base, normalized: normalized("/group off") });
      await handleGroupCommand({ ...base, normalized: normalized("/group on") });
      await handleGroupCommand({ ...base, normalized: normalized("/group nope") });

      expect(updateInstanceConfig).toHaveBeenCalledTimes(2);
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Group mode disabled.");
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Group mode enabled.");
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Usage: /group [status|allow|deny|on|off|all|at]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("toggles whether ordinary group messages require mentioning the bot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = { groupMode: { enabled: true, allowedChatIds: [] } };
      mutate(cfg);
      expect(cfg.groupMode).toEqual({
        enabled: true,
        allowedChatIds: [-100123],
        listenAllChatIds: [-100123],
      });
    });

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: { groupMode: { enabled: true, allowedChatIds: [], listenAllChatIds: [] } },
        normalized: normalized("/group all"),
        context: {
          api: api as never,
          bridge: { checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }) },
          instanceName: "default",
          updateId: 83,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Current group listen mode: all messages.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores mention-only group listening with the short at command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = {
        groupMode: { enabled: true, allowedChatIds: [], listenAllChatIds: [] },
      };
      mutate(cfg);
      expect(cfg.groupMode).toEqual({
        enabled: true,
        allowedChatIds: [-100123],
        listenAllChatIds: [],
      });
    });

    try {
      const handled = await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: { groupMode: { enabled: true, allowedChatIds: [], listenAllChatIds: [] } },
        normalized: normalized("/group at"),
        context: {
          api: api as never,
          bridge: { checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }) },
          instanceName: "default",
          updateId: 84,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Current group listen mode: mentions/replies only.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports group status for the current group", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-group-command-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      leaveChat: vi.fn().mockResolvedValue(undefined),
    };

    try {
      await handleGroupCommand({
        stateDir: root,
        startedAt: Date.now() - 5,
        locale: "en",
        cfg: { groupMode: { enabled: true, allowedChatIds: [-100123], listenAllChatIds: [-100123] } },
        normalized: normalized("/group status"),
        context: {
          api: api as never,
          bridge: { checkUserAuthorization: vi.fn().mockResolvedValue({ kind: "allow" }) },
          instanceName: "default",
          updateId: 82,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("Current group listen mode: all messages"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
