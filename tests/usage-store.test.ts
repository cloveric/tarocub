import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { UsageStore } from "../src/state/usage-store.js";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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

  it("serializes concurrent writes across separate UsageStore instances", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const storeA = new UsageStore(stateDir);
    const storeB = new UsageStore(stateDir);

    try {
      await Promise.all([
        storeA.record({ inputTokens: 10, outputTokens: 1, costUsd: 0.1 }),
        storeB.record({ inputTokens: 20, outputTokens: 2, costUsd: 0.2 }),
        storeA.record({ inputTokens: 30, outputTokens: 3, costUsd: 0.3 }),
      ]);

      await expect(storeA.load()).resolves.toEqual(expect.objectContaining({
        totalInputTokens: 60,
        totalOutputTokens: 6,
        requestCount: 3,
        totalCostUsd: 0.6,
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records daily and monthly usage buckets for dashboard analytics", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await store.record(
        { inputTokens: 100, outputTokens: 40, cachedTokens: 20, costUsd: 0.01 },
        new Date("2026-04-29T10:00:00.000Z"),
      );
      await store.record(
        { inputTokens: 50, outputTokens: 10, cachedTokens: 5, costUsd: 0.02 },
        new Date("2026-05-01T00:00:00.000Z"),
      );

      await expect(store.load()).resolves.toMatchObject({
        requestCount: 2,
        daily: {
          "2026-04-29": {
            requestCount: 1,
            totalInputTokens: 100,
            totalOutputTokens: 40,
            totalCachedTokens: 20,
            totalCostUsd: 0.01,
          },
          "2026-05-01": {
            requestCount: 1,
            totalInputTokens: 50,
            totalOutputTokens: 10,
            totalCachedTokens: 5,
            totalCostUsd: 0.02,
          },
        },
        monthly: {
          "2026-04": {
            requestCount: 1,
            totalInputTokens: 100,
            totalOutputTokens: 40,
            totalCachedTokens: 20,
            totalCostUsd: 0.01,
          },
          "2026-05": {
            requestCount: 1,
            totalInputTokens: 50,
            totalOutputTokens: 10,
            totalCachedTokens: 5,
            totalCostUsd: 0.02,
          },
        },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes across separate processes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const scriptPath = path.join(stateDir, "record-usage.ts");
    try {
      await writeFile(scriptPath, [
        "import { UsageStore } from '/Users/cloveric/projects/cc-telegram-bridge/src/state/usage-store.ts';",
        "(async () => {",
        "  const [dir, inputTokens, costUsd] = process.argv.slice(2);",
        "  const store = new UsageStore(dir);",
        "  await store.record({ inputTokens: Number(inputTokens), outputTokens: 1, costUsd: Number(costUsd) });",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      await Promise.all([
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, stateDir, "10", "0.1"], "/Users/cloveric/projects/cc-telegram-bridge"),
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, stateDir, "20", "0.2"], "/Users/cloveric/projects/cc-telegram-bridge"),
      ]);

      await expect(new UsageStore(stateDir).load()).resolves.toEqual(expect.objectContaining({
        totalInputTokens: 30,
        totalOutputTokens: 2,
        requestCount: 2,
        totalCostUsd: 0.3,
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
