import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { BoardStore } from "../src/state/board-store.js";
import { MiniBusStore } from "../src/state/mini-bus-store.js";
import { handleBoardTelegramCommand } from "../src/telegram/board-commands.js";
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

describe("handleBoardTelegramCommand", () => {
  it("creates and lists tasks from a forum topic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board add Draft launch plan", { messageThreadId: 21 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("B1"));

      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board list", { messageThreadId: 21 }),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("[todo] B1 Draft launch plan"));

      const tasks = await new BoardStore(root).listTasks();
      expect(tasks).toEqual([
        expect.objectContaining({
          id: "B1",
          title: "Draft launch plan",
          createdBy: expect.objectContaining({
            chatId: -100123,
            messageThreadId: 21,
            conversationKey: "chat:-100123:topic:21",
          }),
        }),
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("marks tasks done and reports promoted dependents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Design API",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.createTask({
      title: "Build API",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.addDependency("B2", "B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board done B1 design accepted"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("Done B1"));
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("Promoted: B2"));
      await expect(store.getTask("B2")).resolves.toMatchObject({ status: "ready" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("records failed runs and renders run history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Build worker",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.startTask("B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board fail B1 tests failed"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("Failed B1"));

      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board runs B1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("[failed] R1 tests failed"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("creates a planner task graph from the current agent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "```json\n{\"tasks\":[{\"key\":\"design\",\"title\":\"Design auth schema\",\"assignee\":\"planner\",\"acceptanceCriteria\":[\"schema reviewed\"]},{\"key\":\"build\",\"title\":\"Build auth API\",\"assignee\":\"backend\",\"dependsOn\":[\"design\"],\"labels\":[\"code\"]}]}\n```",
      }),
    };

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board plan Ship auth feature"),
        context: {
          api: api as never,
          instanceName: "default",
          bridge,
        } as never,
      })).resolves.toBe(true);

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("Ship auth feature"),
        files: [],
      }));
      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Created plan: B1, B2"));
      await expect(new BoardStore(root).getTask("B2")).resolves.toMatchObject({
        title: "Build auth API",
        assignee: "backend",
        dependencies: ["B1"],
        labels: ["code"],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("records heartbeats and recovers stale runs from commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Long worker",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.startTask("B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board heartbeat B1 still alive"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      })).resolves.toBe(true);

      await expect(store.getTask("B1")).resolves.toMatchObject({
        runs: [expect.objectContaining({ heartbeatNote: "still alive" })],
      });

      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board recover 0"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Recovered stale board runs: B1"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "blocked",
        runs: [expect.objectContaining({ status: "failed" })],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("configures worktree workspace metadata from commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Code task",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board worktree B1 /tmp/tarocub-board/B1 board/B1"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Workspace B1: worktree"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        workspace: {
          mode: "worktree",
          path: "/tmp/tarocub-board/B1",
          branch: "board/B1",
        },
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("configures absolute board workspace paths that contain spaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Workspace task",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    const workspacePath = path.join(root, "workspace with spaces");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized(`/board workspace B1 dir ${workspacePath}`),
        context: { api: api as never } as never,
      })).resolves.toBe(true);

      await expect(store.getTask("B1")).resolves.toMatchObject({
        workspace: {
          mode: "dir",
          path: workspacePath,
        },
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects relative board workspace paths from commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Workspace task",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board workspace B1 dir relative/project"),
        context: { api: api as never } as never,
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("workspace path must be absolute"));
      await expect(store.getTask("B1")).resolves.not.toHaveProperty("workspace");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("updates richer task cards from Telegram commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Ship docs",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });

    try {
      for (const text of [
        "/board desc B1 Document the Board workflow",
        "/board accept B1 README updated",
        "/board priority B1 high",
        "/board labels B1 docs board",
        "/board check B1 add Update README",
      ]) {
        await expect(handleBoardTelegramCommand({
          stateDir: root,
          startedAt: Date.now() - 10,
          locale: "en",
          normalized: normalized(text),
          context: {
            api: api as never,
            instanceName: "default",
          },
        })).resolves.toBe(true);
      }

      await expect(store.getTask("B1")).resolves.toMatchObject({
        description: "Document the Board workflow",
        acceptanceCriteria: ["README updated"],
        priority: "high",
        labels: ["docs", "board"],
        checklist: [expect.objectContaining({ id: "C1", text: "Update README", done: false })],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("configures WIP limits from Telegram commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board limits global 2"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      })).resolves.toBe(true);

      await expect(new BoardStore(root).getLimits()).resolves.toMatchObject({ global: 2 });
      expect(api.sendMessage).toHaveBeenCalledWith(-100123, expect.stringContaining("global=2"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("routes review gate commands through review before done", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    await store.createTask({
      title: "Build worker",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });

    try {
      await handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board review B1 on reviewer"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      });
      await store.startTask("B1");
      await handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board done B1 implementation ready"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      });

      await expect(store.getTask("B1")).resolves.toMatchObject({ status: "review" });

      await handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board approve B1"),
        context: {
          api: api as never,
          instanceName: "default",
        },
      });

      await expect(store.getTask("B1")).resolves.toMatchObject({ status: "done" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs a ready task on the assigned Mini Bus topic peer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "Draft is complete.",
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };
    const runQueuedBridgeTurn = vi.fn(async (_conversationKey: string, job: () => Promise<unknown>) => await job());
    const store = new BoardStore(root);
    const miniStore = new MiniBusStore(root);
    await miniStore.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 22,
      conversationKey: "chat:-100123:topic:22",
    });
    await store.createTask({
      title: "Draft launch copy",
      description: "Write concise launch copy for the README.",
      acceptanceCriteria: ["README copy is ready"],
      checklist: ["Write draft"],
      assignee: "writer",
      createdBy: {
        chatId: -100123,
        userId: 42,
        messageThreadId: 21,
        conversationKey: "chat:-100123:topic:21",
      },
    });
    await store.markReady("B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board run B1", { messageThreadId: 21 }),
        context: {
          api: api as never,
          instanceName: "default",
          bridge,
          cfg: {
            resume: { workspacePath: "/tmp/workspace" },
          },
          runQueuedBridgeTurn,
        } as never,
      })).resolves.toBe(true);

      expect(runQueuedBridgeTurn).toHaveBeenCalledWith("chat:-100123:topic:22", expect.any(Function));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: -100123,
        userId: 42,
        chatType: "bus",
        messageThreadId: 22,
        conversationKey: "chat:-100123:topic:22",
        locale: "en",
        files: [],
        workspaceOverride: "/tmp/workspace",
        text: expect.stringContaining("B1"),
      }));
      expect(bridge.handleAuthorizedMessage.mock.calls[0]![0].text).toContain("README copy is ready");
      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Ran B1 via Mini Bus writer"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "done",
        summary: "Draft is complete.",
        runs: [expect.objectContaining({ id: "R1", status: "done", summary: "Draft is complete." })],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not complete or promote a board run that was recovered while delegation was in flight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const store = new BoardStore(root);
    const miniStore = new MiniBusStore(root);
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        await store.recoverStaleRuns({
          olderThanMs: 0,
          now: new Date(Date.now() + 1000),
          reason: "manual board recovery",
        });
        return { text: "Late success should be ignored." };
      }),
    };
    await miniStore.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 22,
      conversationKey: "chat:-100123:topic:22",
    });
    const first = await store.createTask({
      title: "Draft launch copy",
      assignee: "writer",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    const second = await store.createTask({
      title: "Publish launch copy",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.addDependency(second.id, first.id);
    await store.markReady(first.id);

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board run B1"),
        context: {
          api: api as never,
          instanceName: "default",
          bridge,
        } as never,
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Run failed B1"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "blocked",
        blockedReason: "manual board recovery",
        runs: [expect.objectContaining({ id: "R1", status: "failed", error: "manual board recovery" })],
      });
      await expect(store.getTask("B2")).resolves.toMatchObject({ status: "todo" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("falls back to an Agent Bus instance when no Mini Bus peer matches the assignee", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const delegateToInstance = vi.fn().mockResolvedValue({
      success: true,
      fromInstance: "writer-bot",
      text: "Agent Bus result.",
    });
    const loadBusConfig = vi.fn().mockResolvedValue({
      peers: ["writer-bot"],
      maxDepth: 3,
      port: 0,
      secret: "secret",
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
    const store = new BoardStore(root);
    await store.createTask({
      title: "Review migration plan",
      assignee: "writer-bot",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.markReady("B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board run B1"),
        context: {
          api: api as never,
          instanceName: "default",
          delegateToInstance,
          loadBusConfig,
        } as never,
      })).resolves.toBe(true);

      expect(loadBusConfig).toHaveBeenCalledWith(root);
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "default",
        targetInstance: "writer-bot",
        depth: 0,
        stateDir: root,
        prompt: expect.stringContaining("Review migration plan"),
      }));
      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Ran B1 via Agent Bus writer-bot"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "done",
        summary: "Agent Bus result.",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not start a run when the assignee is not an executable Mini or Agent Bus target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const delegateToInstance = vi.fn();
    const store = new BoardStore(root);
    await store.createTask({
      title: "Ask Alice to review",
      assignee: "alice",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.markReady("B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board run B1"),
        context: {
          api: api as never,
          instanceName: "default",
          delegateToInstance,
          loadBusConfig: vi.fn().mockResolvedValue(null),
        } as never,
      })).resolves.toBe(true);

      expect(delegateToInstance).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Run failed B1"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "ready",
        runs: [],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("blocks a task when the assigned runner fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("engine failed")),
    };
    const store = new BoardStore(root);
    const miniStore = new MiniBusStore(root);
    await miniStore.upsertPeer({
      name: "writer",
      chatId: -100123,
      messageThreadId: 22,
      conversationKey: "chat:-100123:topic:22",
    });
    await store.createTask({
      title: "Draft launch copy",
      assignee: "writer",
      createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
    });
    await store.markReady("B1");

    try {
      await expect(handleBoardTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        normalized: normalized("/board run B1"),
        context: {
          api: api as never,
          instanceName: "default",
          bridge,
        } as never,
      })).resolves.toBe(true);

      expect(api.sendMessage).toHaveBeenLastCalledWith(-100123, expect.stringContaining("Run failed B1"));
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "blocked",
        blockedReason: "engine failed",
        runs: [expect.objectContaining({ id: "R1", status: "failed", error: "engine failed" })],
      });
    } finally {
      await removeTempRoot(root);
    }
  });
});
