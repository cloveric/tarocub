import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { rotateInstanceLogs, rotateInstanceStructuredLogs } from "../src/state/log-rotation.js";

describe("rotateInstanceLogs", () => {
  it("rotates timeline and service lifecycle logs alongside the other instance logs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "log-rotation-"));

    try {
      await writeFile(path.join(stateDir, "audit.log.jsonl"), "a".repeat(32), "utf8");
      await writeFile(path.join(stateDir, "timeline.log.jsonl"), "t".repeat(32), "utf8");
      await writeFile(path.join(stateDir, "service.lifecycle.log.jsonl"), "l".repeat(32), "utf8");

      const rotated = await rotateInstanceLogs(stateDir, { maxBytes: 8, keepCount: 2 });

      expect(rotated).toContain(path.join(stateDir, "audit.log.jsonl"));
      expect(rotated).toContain(path.join(stateDir, "timeline.log.jsonl"));
      expect(rotated).toContain(path.join(stateDir, "service.lifecycle.log.jsonl"));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rotate process stdout and stderr from in-process startup maintenance", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "log-rotation-"));

    try {
      await writeFile(path.join(stateDir, "audit.log.jsonl"), "a".repeat(32), "utf8");
      await writeFile(path.join(stateDir, "service.stdout.log"), "s".repeat(32), "utf8");
      await writeFile(path.join(stateDir, "service.stderr.log"), "e".repeat(32), "utf8");

      const rotated = await rotateInstanceStructuredLogs(stateDir, { maxBytes: 8, keepCount: 2 });

      expect(rotated).toContain(path.join(stateDir, "audit.log.jsonl"));
      expect(rotated).not.toContain(path.join(stateDir, "service.stdout.log"));
      expect(rotated).not.toContain(path.join(stateDir, "service.stderr.log"));
      await expect(stat(path.join(stateDir, "service.stdout.log.1"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(stateDir, "service.stderr.log.1"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
