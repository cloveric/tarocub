import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it } from "vitest";

import { rotateInstanceLogs, rotateInstanceStructuredLogs, rotateOnAppendIfNeeded } from "../src/state/log-rotation.js";

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
      await removeTempRoot(stateDir);
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
      await removeTempRoot(stateDir);
    }
  });
});

describe("rotateOnAppendIfNeeded", () => {
  it("probes and rotates on the first append for an over-cap file", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "log-rotation-"));
    const filePath = path.join(stateDir, "probe-first.log.jsonl");

    try {
      await writeFile(filePath, "x".repeat(32), "utf8");

      const rotated = await rotateOnAppendIfNeeded(filePath, { maxBytes: 8, keepCount: 2 }, 100);

      expect(rotated).toBe(true);
      await expect(readFile(`${filePath}.1`, "utf8")).resolves.toBe("x".repeat(32));
      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("skips the size probe between intervals and rotates again at the Nth append", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "log-rotation-"));
    const filePath = path.join(stateDir, "probe-interval.log.jsonl");

    try {
      // Append 1 probes an under-cap file: no rotation.
      await writeFile(filePath, "ok", "utf8");
      expect(await rotateOnAppendIfNeeded(filePath, { maxBytes: 8, keepCount: 2 }, 3)).toBe(false);

      // The file grows over the cap, but appends 2 is off-interval: no probe.
      await writeFile(filePath, "y".repeat(32), "utf8");
      expect(await rotateOnAppendIfNeeded(filePath, { maxBytes: 8, keepCount: 2 }, 3)).toBe(false);
      await expect(readFile(filePath, "utf8")).resolves.toBe("y".repeat(32));

      // Append 3 hits the interval: probe fires and rotates.
      expect(await rotateOnAppendIfNeeded(filePath, { maxBytes: 8, keepCount: 2 }, 3)).toBe(true);
      await expect(readFile(`${filePath}.1`, "utf8")).resolves.toBe("y".repeat(32));
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
