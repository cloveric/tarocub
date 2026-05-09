import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { MiniBusStore } from "../src/state/mini-bus-store.js";
import { handleMiniBusTelegramCommand } from "../src/telegram/mini-bus-commands.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function normalized(text: string, input: Partial<NormalizedTelegramMessage> = {}): NormalizedTelegramMessage {
  const chatId = input.chatId ?? -100123;
  const messageThreadId = input.messageThreadId;
  return {
    chatId,
    userId: 42,
    chatType: "supergroup",
    text,
    attachments: [],
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    conversationKey: messageThreadId === undefined ? `chat:${chatId}` : `chat:${chatId}:topic:${messageThreadId}`,
    ...input,
  };
}

describe("handleMiniBusTelegramCommand", () => {
  it("registers the current topic as a named mini peer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini here planner", { messageThreadId: 21 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("planner"));

      const peers = await new MiniBusStore(root).listPeers(-100123);
      expect(peers).toEqual([
        expect.objectContaining({
          name: "planner",
          chatId: -100123,
          messageThreadId: 21,
          conversationKey: "chat:-100123:topic:21",
        }),
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("asks a registered topic peer without using the current topic session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    await new MiniBusStore(root).upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 31,
      conversationKey: "chat:-100123:topic:31",
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "writer answer" }),
    };
    const queuedBridgeTurns: string[] = [];
    const runQueuedBridgeTurn = async <T>(conversationKey: string, job: () => Promise<T>): Promise<T> => {
      queuedBridgeTurns.push(conversationKey);
      return await job();
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {
          resume: {
            sessionId: "resume-1",
            dirName: "project",
            workspacePath: "/tmp/workspace",
          },
        },
        normalized: normalized("/mini ask writer draft this", { messageThreadId: 22 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
          runQueuedBridgeTurn,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(queuedBridgeTurns).toEqual(["chat:-100123:topic:31"]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: -100123,
        chatType: "bus",
        messageThreadId: 31,
        conversationKey: "chat:-100123:topic:31",
        text: "draft this",
        workspaceOverride: "/tmp/workspace",
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Asking mini topic writer...");
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "[writer]\n\nwriter answer");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("fans out to all registered topic peers except the current topic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "planner",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 31,
      conversationKey: "chat:-100123:topic:31",
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({ text: "planner answer" })
        .mockResolvedValueOnce({ text: "writer answer" }),
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini fan compare options", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Querying 2 mini topics...");
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("[planner]\nplanner answer"));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("[writer]\nwriter answer"));

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "mini",
          action: "fan",
          miniTargets: ["planner", "writer"],
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs a mini chain across registered topic peers in order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "planner",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 31,
      conversationKey: "chat:-100123:topic:31",
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({ text: "plan" })
        .mockResolvedValueOnce({ text: "draft" }),
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini chain make a launch plan", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        conversationKey: "chat:-100123:topic:21",
        text: "make a launch plan",
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        conversationKey: "chat:-100123:topic:31",
        text: expect.stringContaining("plan"),
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Running chain across 2 mini topics...");
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("[Mini chain stage 1: planner]"));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("[Mini chain stage 2: writer]"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses explicit mini order for chain targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "planner",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 31,
      conversationKey: "chat:-100123:topic:31",
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({ text: "draft" })
        .mockResolvedValueOnce({ text: "plan" }),
    };
    const base = {
      stateDir: root,
      startedAt: Date.now() - 10,
      locale: "en" as const,
      cfg: {},
      context: {
        api: api as never,
        instanceName: "default",
        updateId: 81,
      },
      bridge: bridge as never,
    };

    try {
      await handleMiniBusTelegramCommand({
        ...base,
        normalized: normalized("/mini order writer planner", { messageThreadId: 99 }),
      });
      const handled = await handleMiniBusTelegramCommand({
        ...base,
        normalized: normalized("/mini chain make a launch plan", { messageThreadId: 99 }),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        conversationKey: "chat:-100123:topic:31",
        text: "make a launch plan",
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        conversationKey: "chat:-100123:topic:21",
        text: expect.stringContaining("draft"),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("tells the user when an explicit mini chain skips the current topic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "planner",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 31,
      conversationKey: "chat:-100123:topic:31",
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({ text: "draft" }),
    };

    try {
      await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini order planner writer", { messageThreadId: 21 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        bridge: bridge as never,
      });

      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini chain make a launch plan", { messageThreadId: 21 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Skipped current topic in mini chain: planner");
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "chat:-100123:topic:31",
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs mini verify through the current topic then the configured verifier", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "reviewer",
      chatId: -100123,
      messageThreadId: 41,
      conversationKey: "chat:-100123:topic:41",
    });
    await store.setVerifier(-100123, "reviewer");
    const approval = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({ text: "current answer" })
        .mockResolvedValueOnce({ text: "looks good" }),
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini verify solve this", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
          onApprovalRequest: approval,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        chatType: "supergroup",
        messageThreadId: 99,
        conversationKey: "chat:-100123:topic:99",
        text: "solve this",
        onApprovalRequest: approval,
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        chatType: "bus",
        messageThreadId: 41,
        conversationKey: "chat:-100123:topic:41",
        text: expect.stringContaining("current answer"),
        onApprovalRequest: approval,
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("[Mini verifier: reviewer]"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("configures mini crew role mappings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "research",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini role researcher research", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 84,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Mini crew role researcher: research");

      await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini status", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 85,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
      });
      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("crew roles: researcher=research"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs mini crew research-report using topic peers as fixed roles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "research",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "analyst",
      chatId: -100123,
      messageThreadId: 22,
      conversationKey: "chat:-100123:topic:22",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 23,
      conversationKey: "chat:-100123:topic:23",
    });
    await store.upsertPeer({
      name: "reviewer",
      chatId: -100123,
      messageThreadId: 24,
      conversationKey: "chat:-100123:topic:24",
    });
    const roleCommands = [
      "/mini role researcher research",
      "/mini role analyst analyst",
      "/mini role writer writer",
      "/mini role reviewer reviewer",
    ];
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({ text: "1. Market size?\n2. Adoption barriers?" })
        .mockResolvedValueOnce({ text: "Research A" })
        .mockResolvedValueOnce({ text: "Research B" })
        .mockResolvedValueOnce({ text: "Analysis C" })
        .mockResolvedValueOnce({ text: "Draft report" })
        .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" }),
    };

    try {
      for (const [index, command] of roleCommands.entries()) {
        await handleMiniBusTelegramCommand({
          stateDir: root,
          startedAt: Date.now() - 10,
          locale: "en",
          cfg: {},
          normalized: normalized(command, { messageThreadId: 99 }),
          context: {
            api: api as never,
            instanceName: "default",
            updateId: 90 + index,
          },
          bridge: bridge as never,
        });
      }

      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini crew research-report Analyze the market.", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 95,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(6);
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        chatType: "bus",
        messageThreadId: 21,
        conversationKey: "chat:-100123:topic:21",
        text: expect.stringContaining("Market size?"),
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(4, expect.objectContaining({
        messageThreadId: 22,
        conversationKey: "chat:-100123:topic:22",
        text: expect.stringContaining("Research A"),
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(5, expect.objectContaining({
        messageThreadId: 23,
        conversationKey: "chat:-100123:topic:23",
        text: expect.stringContaining("Analysis C"),
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenNthCalledWith(6, expect.objectContaining({
        messageThreadId: 24,
        conversationKey: "chat:-100123:topic:24",
        text: expect.stringContaining("Draft report"),
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Running research-report crew...");
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, "Draft report");

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "mini",
          action: "crew",
          workflow: "research-report",
          researcher: "research",
          analyst: "analyst",
          writer: "writer",
          reviewer: "reviewer",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("serializes mini crew calls to the same role topic instead of tripping the busy guard", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "research",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "analyst",
      chatId: -100123,
      messageThreadId: 22,
      conversationKey: "chat:-100123:topic:22",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 23,
      conversationKey: "chat:-100123:topic:23",
    });
    await store.upsertPeer({
      name: "reviewer",
      chatId: -100123,
      messageThreadId: 24,
      conversationKey: "chat:-100123:topic:24",
    });
    const roleCommands = [
      "/mini role researcher research",
      "/mini role analyst analyst",
      "/mini role writer writer",
      "/mini role reviewer reviewer",
    ];
    let researchCount = 0;
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: { messageThreadId?: number; text: string }) => {
        if (input.text.includes("decompose")) {
          return { text: "1. Market size?\n2. Adoption barriers?" };
        }
        if (input.messageThreadId === 21) {
          researchCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { text: `Research ${researchCount}` };
        }
        if (input.messageThreadId === 22) {
          return { text: "Analysis C" };
        }
        if (input.messageThreadId === 23) {
          return { text: "Draft report" };
        }
        if (input.messageThreadId === 24) {
          return { text: "VERDICT: PASS\nISSUES:\n- none" };
        }
        throw new Error(`unexpected input ${JSON.stringify(input)}`);
      }),
    };
    const busy = new Set<string>();
    const runQueuedBridgeTurn = async <T>(conversationKey: string, job: () => Promise<T>): Promise<T> => {
      if (busy.has(conversationKey)) {
        throw new Error(`target conversation is busy: ${conversationKey}`);
      }
      busy.add(conversationKey);
      try {
        return await job();
      } finally {
        busy.delete(conversationKey);
      }
    };

    try {
      for (const [index, command] of roleCommands.entries()) {
        await handleMiniBusTelegramCommand({
          stateDir: root,
          startedAt: Date.now() - 10,
          locale: "en",
          cfg: {},
          normalized: normalized(command, { messageThreadId: 99 }),
          context: {
            api: api as never,
            instanceName: "default",
            updateId: 100 + index,
          },
          bridge: bridge as never,
        });
      }

      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini crew research-report Analyze the market.", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 105,
          runQueuedBridgeTurn,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(researchCount).toBe(2);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        messageThreadId: 22,
        text: expect.stringContaining("Research 1"),
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        messageThreadId: 22,
        text: expect.stringContaining("Research 2"),
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("RESEARCH FAILED: target conversation is busy"),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects mini crew when multiple roles point at the same topic peer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new MiniBusStore(root);
    await store.upsertPeer({
      name: "research",
      chatId: -100123,
      messageThreadId: 21,
      conversationKey: "chat:-100123:topic:21",
    });
    await store.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 23,
      conversationKey: "chat:-100123:topic:23",
    });
    await store.upsertPeer({
      name: "reviewer",
      chatId: -100123,
      messageThreadId: 24,
      conversationKey: "chat:-100123:topic:24",
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      for (const [index, command] of [
        "/mini role researcher research",
        "/mini role analyst research",
        "/mini role writer writer",
        "/mini role reviewer reviewer",
      ].entries()) {
        await handleMiniBusTelegramCommand({
          stateDir: root,
          startedAt: Date.now() - 10,
          locale: "en",
          cfg: {},
          normalized: normalized(command, { messageThreadId: 99 }),
          context: {
            api: api as never,
            instanceName: "default",
            updateId: 110 + index,
          },
          bridge: bridge as never,
        });
      }

      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini crew research-report Analyze the market.", { messageThreadId: 99 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 115,
        },
        bridge: bridge as never,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("duplicate role peers"));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("audits missing mini peers instead of only replying", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini ask writer draft this", { messageThreadId: 22 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 83,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
      });

      expect(handled).toBe(true);
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "invalid",
        metadata: expect.objectContaining({
          command: "mini",
          action: "ask",
          miniTarget: "writer",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("requires a non-private chat for topic peer management", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleMiniBusTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: normalized("/mini here planner", {
          chatId: 123,
          chatType: "private",
          conversationKey: "chat:123",
        }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("inside a Telegram group"));
    } finally {
      await removeTempRoot(root);
    }
  });
});
