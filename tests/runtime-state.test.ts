import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeStateStore } from "../src/state/runtime-state.js";

describe("RuntimeStateStore", () => {
  it("returns default runtime state when file is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await expect(store.load()).resolves.toMatchObject({
        lastHandledUpdateId: null,
        activeTurnCount: 0,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects non-integer handled update ids", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "runtime-state.json");
    const store = new RuntimeStateStore(filePath);

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          lastHandledUpdateId: 123.5,
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid runtime state");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks active Telegram turns", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await store.markTurnStarted(new Date("2026-04-26T22:00:00.000Z"));
      await store.markTurnStarted(new Date("2026-04-26T22:01:00.000Z"));
      await expect(store.load()).resolves.toMatchObject({
        activeTurnCount: 2,
        activeTurnStartedAt: "2026-04-26T22:00:00.000Z",
        activeTurnUpdatedAt: "2026-04-26T22:01:00.000Z",
      });

      await store.markTurnCompleted(new Date("2026-04-26T22:02:00.000Z"));
      await expect(store.load()).resolves.toMatchObject({
        activeTurnCount: 1,
        activeTurnStartedAt: "2026-04-26T22:00:00.000Z",
        activeTurnUpdatedAt: "2026-04-26T22:02:00.000Z",
      });

      await store.markTurnCompleted(new Date("2026-04-26T22:03:00.000Z"));
      await expect(store.load()).resolves.toMatchObject({
        lastHandledUpdateId: null,
        activeTurnCount: 0,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resets stale active turns without losing the handled update offset", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await store.markHandledUpdateId(42);
      await store.markTurnStarted(new Date("2026-04-26T22:00:00.000Z"));
      await store.resetActiveTurns();

      await expect(store.load()).resolves.toMatchObject({
        lastHandledUpdateId: 42,
        activeTurnCount: 0,
      });
      const state = await store.load();
      expect(state.activeTurnStartedAt).toBeUndefined();
      expect(state.activeTurnUpdatedAt).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
