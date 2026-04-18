import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
    }
  });
});
