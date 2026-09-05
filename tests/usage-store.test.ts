import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { childProcessTestEnv, removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { UsageStore } from "../src/state/usage-store.js";
import { JsonStore } from "../src/state/json-store.js";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
// Repo root derived from this test file, so the spawned-subprocess tests work from
// any checkout (any user, any folder name — not a hardcoded /Users/.../cc-telegram-bridge).
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcImportUrl = (rel: string): string => pathToFileURL(path.join(repoRoot, rel)).href;

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: childProcessTestEnv() }, (error) => {
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
      await removeTempRoot(stateDir);
    }
  });

  it("fails closed on corrupt usage state when no last-good backup exists", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await writeFile(path.join(stateDir, "usage.json"), "null\n", "utf8");
      await expect(store.load()).rejects.toThrow("Usage state is corrupt");
      await expect(store.load()).rejects.toThrow("Usage state is corrupt");
      const files = await readdir(stateDir);
      expect(files).toContain("usage.json");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("fails closed on invalid usage counters", async () => {
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

      await expect(store.load()).rejects.toThrow("Usage state is corrupt");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("restores a corrupt primary ledger from the last-good snapshot", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await store.record({ inputTokens: 10, outputTokens: 2, costUsd: 0.25 });
      await writeFile(path.join(stateDir, "usage.json"), "{bad json\n", "utf8");

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        totalInputTokens: 10,
        totalOutputTokens: 2,
        totalCostUsd: 0.25,
        requestCount: 1,
      }));
      const files = await readdir(stateDir);
      expect(files.some((f) => f.includes("usage.json.corrupt.") && f.endsWith(".bak"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      await removeTempRoot(stateDir);
    }
  });

  it("does not overwrite concurrent usage recorded during corruption recovery", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(stateDir, "usage.json");
    const store = new UsageStore(stateDir);
    let releaseFirstQuarantine!: () => void;
    let firstQuarantineStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstQuarantineStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirstQuarantine = resolve; });
    const original = JsonStore.prototype.quarantineCurrentFile;
    let calls = 0;
    const quarantineSpy = vi.spyOn(JsonStore.prototype, "quarantineCurrentFile").mockImplementation(async function (
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await store.record({ inputTokens: 10, outputTokens: 1, costUsd: 0.1 });
      await writeFile(filePath, "{broken", "utf8");
      const load = store.load();
      await started;
      const record = store.record({ inputTokens: 5, outputTokens: 1, costUsd: 0.05 });
      await Promise.race([record.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 50))]);
      releaseFirstQuarantine();
      await Promise.all([load, record]);

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        totalInputTokens: 15,
        requestCount: 2,
        totalCostUsd: 0.15,
      }));
    } finally {
      releaseFirstQuarantine?.();
      errorSpy.mockRestore();
      quarantineSpy.mockRestore();
      await removeTempRoot(stateDir);
    }
  });

  it("rejects invalid turn usage before it can corrupt the persisted ledger", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await store.record({ inputTokens: 5, outputTokens: 1, costUsd: 0.1 });
      await expect(store.record({ inputTokens: Number.NaN, outputTokens: 1, costUsd: 0.1 }))
        .rejects.toThrow("invalid usage state");
      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        totalInputTokens: 5,
        requestCount: 1,
        totalCostUsd: 0.1,
      }));
    } finally {
      await removeTempRoot(stateDir);
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
      await removeTempRoot(stateDir);
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
      await removeTempRoot(stateDir);
    }
  });

  it("records completed turns whose engine did not return token details", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new UsageStore(stateDir);

    try {
      await store.recordUnmetered(new Date("2026-05-26T08:00:00.000Z"));

      await expect(store.load()).resolves.toMatchObject({
        requestCount: 0,
        unmeteredRequestCount: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        daily: {
          "2026-05-26": {
            requestCount: 0,
            unmeteredRequestCount: 1,
          },
        },
        monthly: {
          "2026-05": {
            requestCount: 0,
            unmeteredRequestCount: 1,
          },
        },
      });
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("serializes concurrent writes across separate processes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const scriptPath = path.join(stateDir, "record-usage.ts");
    try {
      await writeFile(scriptPath, [
        `import { UsageStore } from '${srcImportUrl("src/state/usage-store.ts")}';`,
        "(async () => {",
        "  const [dir, inputTokens, costUsd] = process.argv.slice(2);",
        "  const store = new UsageStore(dir);",
        "  await store.record({ inputTokens: Number(inputTokens), outputTokens: 1, costUsd: Number(costUsd) });",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      await Promise.all([
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, stateDir, "10", "0.1"], repoRoot),
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, stateDir, "20", "0.2"], repoRoot),
      ]);

      await expect(new UsageStore(stateDir).load()).resolves.toEqual(expect.objectContaining({
        totalInputTokens: 30,
        totalOutputTokens: 2,
        requestCount: 2,
        totalCostUsd: 0.3,
      }));
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
