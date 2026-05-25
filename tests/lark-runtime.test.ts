import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Domain } from "@larksuiteoapi/node-sdk";

import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { resolveLarkServiceLockDir, runLarkService } from "../src/lark/service.js";

describe("runLarkService", () => {
  it("starts a Lark channel without requiring Telegram credentials", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-"));
    const abortController = new AbortController();
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const createChannel = vi.fn(() => channel);

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel,
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_a",
        appSecret: "secret",
        transport: "websocket",
        source: "cc-telegram-bridge",
        safety: {
          chatQueue: {
            enabled: false,
          },
        },
      }));
      expect(channel.on).toHaveBeenCalledWith("message", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("cardAction", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(channel.connect).toHaveBeenCalledTimes(1);
      expect(channel.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("maps short Lark domain names to SDK domain constants", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-domain-"));
    const abortController = new AbortController();
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const createChannel = vi.fn(() => channel);

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        LARK_DOMAIN: "feishu",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel,
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({
        domain: Domain.Feishu,
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate Lark service processes for the same state dir", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-lock-"));
    const lock = await acquireInstanceLock(resolveLarkServiceLockDir(stateDir));
    const createChannel = vi.fn();

    try {
      await expect(runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel,
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        logger: silentLogger(),
      })).rejects.toThrow("Lark service lock already held by pid");

      expect(createChannel).not.toHaveBeenCalled();
    } finally {
      await lock.release();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("releases the Lark service lock when channel startup fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-connect-fail-"));
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        throw new Error("websocket failed");
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await expect(runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        logger: silentLogger(),
      })).rejects.toThrow("websocket failed");

      await expect(readFile(path.join(resolveLarkServiceLockDir(stateDir), "instance.lock.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(channel.disconnect).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function silentLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}
