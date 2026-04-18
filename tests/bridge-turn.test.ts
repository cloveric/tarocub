import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBudgetUsd } from "../src/runtime/bridge-turn.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadBudgetUsd", () => {
  it("logs malformed config and returns undefined", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-turn-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(path.join(root, "config.json"), "{bad json\n", "utf8");

      await expect(loadBudgetUsd(root)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs non-object config and returns undefined", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-turn-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(path.join(root, "config.json"), "null\n", "utf8");

      await expect(loadBudgetUsd(root)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
