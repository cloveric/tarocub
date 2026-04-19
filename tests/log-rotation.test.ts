import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { rotateInstanceLogs } from "../src/state/log-rotation.js";

describe("rotateInstanceLogs", () => {
  it("rotates timeline.log.jsonl alongside the other instance logs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "log-rotation-"));

    try {
      await writeFile(path.join(stateDir, "audit.log.jsonl"), "a".repeat(32), "utf8");
      await writeFile(path.join(stateDir, "timeline.log.jsonl"), "t".repeat(32), "utf8");

      const rotated = await rotateInstanceLogs(stateDir, { maxBytes: 8, keepCount: 2 });

      expect(rotated).toContain(path.join(stateDir, "audit.log.jsonl"));
      expect(rotated).toContain(path.join(stateDir, "timeline.log.jsonl"));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
