import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeStateStore } from "../src/state/runtime-state.js";

describe("RuntimeStateStore", () => {
  it("returns default runtime state when file is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new RuntimeStateStore(path.join(tempDir, "runtime-state.json"));

    try {
      await expect(store.load()).resolves.toEqual({
        lastHandledUpdateId: null,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects non-integer handled update ids", async () => {
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

      await expect(store.load()).rejects.toThrow("invalid runtime state");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
