import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { JsonStore } from "../src/state/json-store.js";
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
      await removeTempRoot(tempDir);
    }
  });

  it("does not quarantine a valid runtime file written during corruption recovery", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "runtime-state.json");
    let releaseFirstQuarantine!: () => void;
    let firstQuarantineStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstQuarantineStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirstQuarantine = resolve; });
    const original = JsonStore.prototype.quarantineCurrentFile;
    let calls = 0;
    const spy = vi.spyOn(JsonStore.prototype, "quarantineCurrentFile").mockImplementation(async function (
      this: JsonStore<unknown>,
      reason,
    ) {
      calls += 1;
      if (calls === 1) {
        firstQuarantineStarted();
        await gate;
      }
      return await original.call(this, reason);
    });

    try {
      await writeFile(filePath, "{broken", "utf8");
      const store = new RuntimeStateStore(filePath);
      const load = store.load();
      await started;
      const update = store.markHandledUpdateId(42);
      await Promise.race([update.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 50))]);
      releaseFirstQuarantine();
      await Promise.all([load, update]);

      await expect(store.load()).resolves.toMatchObject({ lastHandledUpdateId: 42 });
    } finally {
      releaseFirstQuarantine?.();
      spy.mockRestore();
      await removeTempRoot(tempDir);
    }
  });

  it("rejects (quarantines + resets) non-integer handled update ids", async () => {
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

      // Corrupt content is not accepted: it is quarantined and the watermark
      // resets so polling can't wedge on a bad write.
      const recovered = await store.load();
      expect(recovered.lastHandledUpdateId).toBeNull();
      expect(recovered.activeTurnCount).toBe(0);
      const files = await readdir(tempDir);
      expect(files.some((f) => f.includes("runtime-state.json.corrupt.") && f.endsWith(".bak"))).toBe(true);
    } finally {
      await removeTempRoot(tempDir);
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
      await removeTempRoot(tempDir);
    }
  });

  it("refreshes active turn activity without changing the original start time", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await store.markTurnStarted(new Date("2026-04-26T22:00:00.000Z"));
      await store.markTurnActivity(new Date("2026-04-26T22:05:00.000Z"));

      await expect(store.load()).resolves.toMatchObject({
        activeTurnCount: 1,
        activeTurnStartedAt: "2026-04-26T22:00:00.000Z",
        activeTurnUpdatedAt: "2026-04-26T22:05:00.000Z",
      });
    } finally {
      await removeTempRoot(tempDir);
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
      await removeTempRoot(tempDir);
    }
  });
});
