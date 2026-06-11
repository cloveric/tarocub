import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { handleDelegationTelegramCommand } from "../src/telegram/delegation-commands.js";
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

describe("handleDelegationTelegramCommand", () => {
  it("handles successful /btw turns and records command audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "side answer" }),
    };

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/btw hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        bridge: bridge as never,
        loadBusConfig: vi.fn(),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "bus",
        text: "hello",
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(123, "side answer");
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "btw",
          responseChars: 11,
          chunkCount: 1,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /ask when delegating to the current instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/ask default hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn(),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Cannot delegate to yourself.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reports missing /fan parallel bots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/fan hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({}),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "No parallel bots configured. Add instance names to bus.parallel in config.json.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs /btw on a fresh ephemeral session", async () => {
    // Finding 3: /btw is a one-off side question and must not resume or persist a
    // session. It passes a sessionIdOverride which bypasses getOrCreateSession/bindSession.
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "side answer" });

    try {
      await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/btw hello"),
        context: { api: api as never, instanceName: "default", updateId: 77 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn(),
        delegateToInstance: vi.fn(),
      });

      const override = handleAuthorizedMessage.mock.calls[0]?.[0]?.sessionIdOverride;
      expect(override).toMatch(/^btw-/);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("excludes the current instance from /fan so it does not run twice", async () => {
    // Finding 6: the current instance already runs the prompt locally, so a self-listed
    // bus.parallel entry must be dropped from the peer fan-out.
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "local answer" });
    const delegateToInstance = vi.fn().mockResolvedValue({ text: "peer answer" });

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/fan hello"),
        context: { api: api as never, instanceName: "default", updateId: 79 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["default", "peer"] }),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      // Local turn runs exactly once; the only delegated peer is "peer", never "default".
      expect(handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({ targetInstance: "peer" }));
      expect(delegateToInstance).not.toHaveBeenCalledWith(expect.objectContaining({ targetInstance: "default" }));
      // "Querying N bots" counts self + remaining peers (1 + 1 = 2).
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Querying 2 bots in parallel...");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs a local-only fan when the only configured parallel target is the current instance", async () => {
    // Finding 6 + self-review: self is excluded from the peer fan-out so it never
    // runs twice, but a bus.parallel that lists ONLY the current instance still has
    // runnable content — it must run locally (once), not error as "unconfigured".
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "local answer" });
    const delegateToInstance = vi.fn();

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/fan hello"),
        context: { api: api as never, instanceName: "default", updateId: 79 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["default"] }),
        delegateToInstance,
      });

      expect(handled).toBe(true);
      // Runs locally exactly once, never delegates to itself, never errors.
      expect(handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).not.toHaveBeenCalled();
      const sent = api.sendMessage.mock.calls.map((call) => String(call[1]));
      expect(sent.some((text) => text.includes("No parallel bots configured"))).toBe(false);
      expect(sent.some((text) => text.includes("local answer"))).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reports missing /chain bots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/chain hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({}),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "No chain bots configured. Add instance names to bus.chain in config.json.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /verify when the verifier is the current instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/verify hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ verifier: "default" }),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Verifier cannot be the same instance.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs /chain sequentially across configured bots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "draft from reviewer" })
      .mockResolvedValueOnce({ text: "final from writer" });

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/chain improve this answer"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ chain: ["reviewer", "writer"] }),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(delegateToInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({
        fromInstance: "default",
        targetInstance: "reviewer",
        prompt: "improve this answer",
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(2, expect.objectContaining({
        fromInstance: "default",
        targetInstance: "writer",
        prompt: expect.stringContaining("draft from reviewer"),
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Running chain across 2 bots...");
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("[Chain stage 1: reviewer]"));
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("[Chain stage 2: writer]"));

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "chain",
          chainTargets: ["reviewer", "writer"],
          stageCount: 2,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /chain when the configured targets include the current instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/chain improve this answer"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ chain: ["reviewer", "default"] }),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Chain config cannot include the current instance. Remove self-targets from bus.chain.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });
});
