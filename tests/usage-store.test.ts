import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { UsageStore } from "../src/state/usage-store.js";

describe("UsageStore", () => {
  it("returns default usage when usage.json is missing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await expect(store.load()).resolves.toEqual({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: 0,
        requestCount: 0,
        lastUpdatedAt: "",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects non-object persisted usage state", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await writeFile(path.join(stateDir, "usage.json"), "null\n", "utf8");
      await expect(store.load()).rejects.toThrow("invalid usage state");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects non-integer usage counters", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await writeFile(
        path.join(stateDir, "usage.json"),
        JSON.stringify({
          totalInputTokens: 11.5,
          totalOutputTokens: 7,
          totalCachedTokens: 2,
          totalCostUsd: 0.25,
          requestCount: 1,
          lastUpdatedAt: "2026-04-17T00:00:00.000Z",
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid usage state");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
