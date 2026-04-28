import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { recoverLastHandledUpdateIdFromAudit } from "../src/state/runtime-state-recovery.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

describe("runtime state recovery", () => {
  it("recovers stale handled update watermark from successful audit events", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await store.markHandledUpdateId(858);
      await writeFile(
        path.join(tempDir, "audit.log.jsonl"),
        [
          JSON.stringify({ timestamp: "2026-04-28T00:00:00.000Z", type: "update.handle", updateId: 859, outcome: "success" }),
          JSON.stringify({ timestamp: "2026-04-28T00:01:00.000Z", type: "update.handle", updateId: 875, outcome: "success" }),
        ].join("\n"),
        "utf8",
      );

      await expect(recoverLastHandledUpdateIdFromAudit(tempDir, store)).resolves.toBe(875);
      await expect(store.load()).resolves.toMatchObject({ lastHandledUpdateId: 875 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads rotated audit logs when recovering the handled update watermark", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await store.markHandledUpdateId(41);
      await writeFile(
        path.join(tempDir, "audit.log.jsonl.1"),
        JSON.stringify({ timestamp: "2026-04-28T00:00:00.000Z", type: "update.skip", updateId: 42, outcome: "duplicate" }),
        "utf8",
      );

      await expect(recoverLastHandledUpdateIdFromAudit(tempDir, store)).resolves.toBe(42);
      await expect(store.load()).resolves.toMatchObject({ lastHandledUpdateId: 42 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recovers from large rotated audit logs without overflowing the call stack", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await store.markHandledUpdateId(875);
      // 160k events exceeds the V8 argument-spread range that broke recovery
      // on real rotated audit logs, while keeping the regression test fast.
      const auditLines = Array.from({ length: 160_000 }, (_, index) =>
        JSON.stringify({
          timestamp: "2026-04-28T00:00:00.000Z",
          type: "update.handle",
          updateId: index + 1,
          outcome: "success",
        }),
      );
      await writeFile(path.join(tempDir, "audit.log.jsonl.1"), auditLines.join("\n"), "utf8");

      await expect(recoverLastHandledUpdateIdFromAudit(tempDir, store)).resolves.toBe(160_000);
      await expect(store.load()).resolves.toMatchObject({ lastHandledUpdateId: 160_000 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not recover from failed update handle events", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(
        path.join(tempDir, "audit.log.jsonl"),
        JSON.stringify({ timestamp: "2026-04-28T00:00:00.000Z", type: "update.handle", updateId: 99, outcome: "error" }),
        "utf8",
      );

      await expect(recoverLastHandledUpdateIdFromAudit(tempDir, store)).resolves.toBeNull();
      await expect(store.load()).resolves.toMatchObject({ lastHandledUpdateId: null });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
