import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it } from "vitest";

import { CREW_RUN_TERMINAL_RETENTION_MS, CrewRunStore } from "../src/state/crew-run-store.js";

describe("CrewRunStore", () => {
  it("returns the latest run snapshot from crew-runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "crew-run-store-"));
    const stateDir = path.join(tempDir, "alpha");

    try {
      await mkdir(path.join(stateDir, "crew-runs"), { recursive: true });
      await writeFile(
        path.join(stateDir, "crew-runs", "older.json"),
        JSON.stringify({
          runId: "older",
          workflow: "research-report",
          status: "completed",
          currentStage: "completed",
          coordinator: "alpha",
          chatId: 1,
          userId: 2,
          locale: "en",
          originalPrompt: "older",
          createdAt: "2026-04-08T10:00:00.000Z",
          updatedAt: "2026-04-08T10:01:00.000Z",
          stages: {},
        }),
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "crew-runs", "newer.json"),
        JSON.stringify({
          runId: "newer",
          workflow: "research-report",
          status: "running",
          currentStage: "analysis",
          coordinator: "alpha",
          chatId: 1,
          userId: 2,
          locale: "en",
          originalPrompt: "newer",
          createdAt: "2026-04-08T10:02:00.000Z",
          updatedAt: "2026-04-08T10:03:00.000Z",
          stages: {},
        }),
        "utf8",
      );

      const store = new CrewRunStore(stateDir);
      const snapshot = await store.inspectLatest();
      expect(snapshot.warning).toBeUndefined();
      expect(snapshot.run).toMatchObject({
        runId: "newer",
        status: "running",
        currentStage: "analysis",
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("prunes only stale terminal runs and preserves active or unreadable recovery evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "crew-run-store-"));
    const stateDir = path.join(tempDir, "alpha");
    const runsDir = path.join(stateDir, "crew-runs");
    const now = Date.parse("2026-08-03T08:00:00.000Z");
    const makeRun = (runId: string, status: "running" | "completed", updatedAt: string) => ({
      runId,
      workflow: "research-report" as const,
      status,
      currentStage: status === "running" ? "analysis" as const : "completed" as const,
      coordinator: "alpha",
      chatId: 1,
      userId: 2,
      locale: "en" as const,
      originalPrompt: runId,
      createdAt: updatedAt,
      updatedAt,
      stages: {},
    });

    try {
      await mkdir(runsDir, { recursive: true });
      const staleAt = new Date(now - CREW_RUN_TERMINAL_RETENTION_MS - 1).toISOString();
      const recentAt = new Date(now - 60_000).toISOString();
      await writeFile(path.join(runsDir, "stale.json"), JSON.stringify(makeRun("stale", "completed", staleAt)), "utf8");
      await writeFile(path.join(runsDir, "recent.json"), JSON.stringify(makeRun("recent", "completed", recentAt)), "utf8");
      await writeFile(path.join(runsDir, "active.json"), JSON.stringify(makeRun("active", "running", staleAt)), "utf8");
      await writeFile(path.join(runsDir, "unreadable.json"), "{broken", "utf8");

      const store = new CrewRunStore(stateDir);
      await expect(store.pruneTerminalRuns(now)).resolves.toBe(1);
      expect((await readdir(runsDir)).sort()).toEqual([
        "active.json",
        "recent.json",
        "unreadable.json",
      ]);
    } finally {
      await removeTempRoot(tempDir);
    }
  });
});
