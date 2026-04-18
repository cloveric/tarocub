import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CrewRunStore } from "../src/state/crew-run-store.js";

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
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
