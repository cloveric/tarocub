import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyEngineSelection,
  loadInstanceConfig,
  updateInstanceConfig,
} from "../src/telegram/instance-config.js";
import { resolveDefaultCronTimezone } from "../src/state/cron-timezone.js";

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
        codexServiceTier: undefined,
        timezone: resolveDefaultCronTimezone(),
        resume: undefined,
        groupMode: {
          enabled: true,
          allowedChatIds: [],
          listenAllChatIds: [],
        },
      });
    } finally {
      await removeTempRoot(root);
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
        codexServiceTier: undefined,
        timezone: resolveDefaultCronTimezone(),
        resume: undefined,
        groupMode: {
          enabled: true,
          allowedChatIds: [],
          listenAllChatIds: [],
        },
      });
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await removeTempRoot(root);
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
        codexServiceTier: undefined,
        timezone: resolveDefaultCronTimezone(),
        resume: undefined,
        groupMode: {
          enabled: true,
          allowedChatIds: [],
          listenAllChatIds: [],
        },
      });
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await removeTempRoot(root);
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
          codexServiceTier: "fast",
          timezone: "Asia/Shanghai",
          resume: {
            sessionId: "session-1",
            dirName: "project-dir",
            workspacePath: "/tmp/workspace",
          },
          groupMode: {
            enabled: false,
            allowedChatIds: [-100123, -100123, 42.5],
            listenAllChatIds: [-100123, -100123, 42.5],
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
        codexServiceTier: "fast",
        timezone: "Asia/Shanghai",
        resume: {
          sessionId: "session-1",
          dirName: "project-dir",
          workspacePath: "/tmp/workspace",
          symlinkPath: undefined,
        },
        groupMode: {
          enabled: false,
          allowedChatIds: [-100123],
          listenAllChatIds: [],
        },
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects standard as a dead Codex service tier value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ codexServiceTier: "standard" }), "utf8");

      await expect(loadInstanceConfig(root)).resolves.toEqual({
        engine: "codex",
        locale: "en",
        verbosity: 1,
        budgetUsd: undefined,
        effort: undefined,
        model: undefined,
        codexServiceTier: undefined,
        timezone: resolveDefaultCronTimezone(),
        resume: undefined,
        groupMode: {
          enabled: true,
          allowedChatIds: [],
          listenAllChatIds: [],
        },
      });
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("preserves all fields across concurrent updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));

    try {
      await Promise.all(Array.from({ length: 20 }, async (_, index) => {
        await updateInstanceConfig(root, (config) => {
          config[`field${index}`] = index;
        });
      }));

      const persisted = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")) as Record<string, unknown>;
      for (let index = 0; index < 20; index++) {
        expect(persisted[`field${index}`]).toBe(index);
      }
    } finally {
      await removeTempRoot(root);
    }
  });
});

describe("applyEngineSelection", () => {
  it("applies the Claude default model and effort when selecting Claude for a fresh config", () => {
    const config: Record<string, unknown> = {};

    const result = applyEngineSelection(config, "claude");

    expect(result).toEqual({ clearedModel: false, enabledFullAuto: false });
    expect(config).toMatchObject({
      engine: "claude",
      model: "opus[1m]",
      effort: "xhigh",
    });
  });

  it("replaces incompatible model overrides with the Claude defaults when switching to Claude", () => {
    const config: Record<string, unknown> = {
      engine: "codex",
      model: "gpt-5.4",
      effort: "medium",
      codexServiceTier: "fast",
    };

    const result = applyEngineSelection(config, "claude");

    expect(result).toEqual({ clearedModel: true, enabledFullAuto: false });
    expect(config).toMatchObject({
      engine: "claude",
      model: "opus[1m]",
      effort: "xhigh",
    });
    expect(config.codexServiceTier).toBeUndefined();
  });

  it("preserves an existing Claude model override while filling a missing default effort", () => {
    const config: Record<string, unknown> = {
      engine: "claude",
      model: "sonnet[1m]",
    };

    const result = applyEngineSelection(config, "claude");

    expect(result).toEqual({ clearedModel: false, enabledFullAuto: false });
    expect(config).toMatchObject({
      engine: "claude",
      model: "sonnet[1m]",
      effort: "xhigh",
    });
  });

  it("defaults fresh engine selections to unsafe bypass, including Antigravity", () => {
    const config: Record<string, unknown> = {
      engine: "codex",
      model: "gpt-5.4",
      codexServiceTier: "fast",
    };

    const result = applyEngineSelection(config, "antigravity");

    expect(result).toEqual({ clearedModel: true, enabledFullAuto: false });
    expect(config).toMatchObject({
      engine: "antigravity",
      approvalMode: "bypass",
    });
    expect(config.model).toBeUndefined();
    expect(config.codexServiceTier).toBeUndefined();
  });

  it("keeps the old Antigravity safety upgrade when explicit normal approvals are selected", () => {
    const config: Record<string, unknown> = {
      engine: "codex",
      approvalMode: "normal",
    };

    const result = applyEngineSelection(config, "antigravity");

    expect(result).toEqual({ clearedModel: false, enabledFullAuto: true });
    expect(config.approvalMode).toBe("full-auto");
  });

  it("does not downgrade Antigravity bypass mode when preserving an unsafe YOLO choice", () => {
    const config: Record<string, unknown> = {
      engine: "codex",
      approvalMode: "bypass",
    };

    const result = applyEngineSelection(config, "antigravity");

    expect(result).toEqual({ clearedModel: false, enabledFullAuto: false });
    expect(config.approvalMode).toBe("bypass");
  });
});
