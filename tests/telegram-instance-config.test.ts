import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInstanceConfig, updateInstanceConfig } from "../src/telegram/instance-config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadInstanceConfig", () => {
  it("returns defaults when config.json is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));

    try {
      await expect(loadInstanceConfig(root)).resolves.toEqual({
        engine: "codex",
        locale: "en",
        verbosity: 1,
        budgetUsd: undefined,
        effort: undefined,
        model: undefined,
        resume: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs and falls back to defaults for malformed config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(path.join(root, "config.json"), "{bad json\n", "utf8");

      await expect(loadInstanceConfig(root)).resolves.toEqual({
        engine: "codex",
        locale: "en",
        verbosity: 1,
        budgetUsd: undefined,
        effort: undefined,
        model: undefined,
        resume: undefined,
      });
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs and falls back to defaults for non-object config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(path.join(root, "config.json"), "null\n", "utf8");

      await expect(loadInstanceConfig(root)).resolves.toEqual({
        engine: "codex",
        locale: "en",
        verbosity: 1,
        budgetUsd: undefined,
        effort: undefined,
        model: undefined,
        resume: undefined,
      });
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes persisted config values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));

    try {
      await writeFile(
        path.join(root, "config.json"),
        JSON.stringify({
          engine: "claude",
          locale: "zh",
          verbosity: 2,
          budgetUsd: 10,
          effort: "high",
          model: " claude-sonnet ",
          resume: {
            sessionId: "session-1",
            dirName: "project-dir",
            workspacePath: "/tmp/workspace",
          },
        }),
        "utf8",
      );

      await expect(loadInstanceConfig(root)).resolves.toEqual({
        engine: "claude",
        locale: "zh",
        verbosity: 2,
        budgetUsd: 10,
        effort: "high",
        model: "claude-sonnet",
        resume: {
          sessionId: "session-1",
          dirName: "project-dir",
          workspacePath: "/tmp/workspace",
          symlinkPath: undefined,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("updateInstanceConfig", () => {
  it("creates config.json and preserves existing fields across updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));

    try {
      await updateInstanceConfig(root, (config) => {
        config.engine = "claude";
        config.locale = "zh";
      });
      await updateInstanceConfig(root, (config) => {
        config.model = "claude-opus";
      });

      const persisted = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        engine: "claude",
        locale: "zh",
        model: "claude-opus",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
