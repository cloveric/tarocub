import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyEngineSelection,
  loadInstanceConfig,
  readValidatedConfigFile,
  updateInstanceConfig,
} from "../src/telegram/instance-config.js";
import { resolveDefaultCronTimezone } from "../src/state/cron-timezone.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadInstanceConfig", () => {
  it("loads Codex GPT-5.6 ultra effort without dropping it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));

    try {
      await writeFile(
        path.join(root, "config.json"),
        JSON.stringify({ engine: "codex", model: "gpt-5.6-terra", effort: "ultra" }) + "\n",
        "utf8",
      );

      await expect(loadInstanceConfig(root)).resolves.toMatchObject({
        engine: "codex",
        model: "gpt-5.6-terra",
        effort: "ultra",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("drops a manually persisted extended effort when no compatible model is pinned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(
        path.join(root, "config.json"),
        JSON.stringify({ engine: "codex", effort: "max" }) + "\n",
        "utf8",
      );

      await expect(loadInstanceConfig(root)).resolves.toMatchObject({
        engine: "codex",
        model: undefined,
        effort: undefined,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Ignored incompatible effort max"));
    } finally {
      await removeTempRoot(root);
    }
  });

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
        workspacePath: undefined,
        workspaceProfiles: [],
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
        workspacePath: undefined,
        workspaceProfiles: [],
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
        workspacePath: undefined,
        workspaceProfiles: [],
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

  it("keeps valid fields and drops only the invalid ones when one field fails the schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(
        path.join(root, "config.json"),
        JSON.stringify({
          engine: "claude",
          locale: "zh",
          budgetUsd: "5", // invalid: must be a positive number
          model: "opus[1m]",
          groupMode: {
            enabled: true,
            allowedChatIds: [-100123],
            listenAllChatIds: [],
          },
          customFutureField: { keep: true },
        }),
        "utf8",
      );

      const config = await loadInstanceConfig(root);

      // One poisoned field must not flip the engine to codex or empty the allowlist.
      expect(config.engine).toBe("claude");
      expect(config.locale).toBe("zh");
      expect(config.model).toBe("opus[1m]");
      expect(config.groupMode.allowedChatIds).toEqual([-100123]);
      expect(config.budgetUsd).toBeUndefined();

      expect(errorSpy).toHaveBeenCalledOnce();
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).toContain("budgetUsd");
      expect(logged).toContain("dropped invalid field(s)");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("salvages unknown passthrough fields alongside valid known fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-instance-config-"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(
        path.join(root, "config.json"),
        JSON.stringify({
          engine: "antigravity",
          verbosity: "loud", // invalid
          timezone: "Asia/Shanghai",
          customFutureField: { keep: true },
        }),
        "utf8",
      );

      const salvaged = await readValidatedConfigFile(path.join(root, "config.json")) as Record<string, unknown>;
      expect(salvaged.engine).toBe("antigravity");
      expect(salvaged.timezone).toBe("Asia/Shanghai");
      expect(salvaged.verbosity).toBeUndefined(); // dropped
      expect(salvaged.customFutureField).toEqual({ keep: true }); // passthrough kept

      const config = await loadInstanceConfig(root);
      expect(config.engine).toBe("antigravity");
      expect(config.timezone).toBe("Asia/Shanghai");
      expect(config.verbosity).toBe(1); // dropped, falls back to default
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("verbosity");
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
          workspacePath: " /tmp/current-workspace ",
          workspaceProfiles: [
            { name: "demo", path: "/tmp/demo", updatedAt: "2026-01-01T00:00:00.000Z" },
            { name: "demo", path: "/tmp/demo-new", updatedAt: "2026-01-02T00:00:00.000Z" },
            { name: "", path: "/tmp/ignored" },
          ],
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
        workspacePath: "/tmp/current-workspace",
        workspaceProfiles: [
          { name: "demo", path: "/tmp/demo-new", updatedAt: "2026-01-02T00:00:00.000Z" },
        ],
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
        workspacePath: undefined,
        workspaceProfiles: [],
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
      model: "claude-opus-5[1m]",
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
      model: "claude-opus-5[1m]",
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

  it("pins the Codex default effort when selecting Codex, so it cannot drift with ~/.codex/config.toml", () => {
    const config: Record<string, unknown> = {};

    const result = applyEngineSelection(config, "codex");

    expect(result).toEqual({ clearedModel: false, enabledFullAuto: false });
    expect(config).toMatchObject({
      engine: "codex",
      effort: "xhigh",
    });
    // The codex model deliberately keeps following the engine's own default.
    expect(config.model).toBeUndefined();
  });

  it("pins the Codex effort when switching from Claude, but preserves a custom effort on re-selecting Codex", () => {
    const fromClaude: Record<string, unknown> = { engine: "claude", model: "opus[1m]", effort: "max" };
    applyEngineSelection(fromClaude, "codex");
    expect(fromClaude.effort).toBe("xhigh");

    const reselect: Record<string, unknown> = { engine: "codex", effort: "medium" };
    applyEngineSelection(reselect, "codex");
    expect(reselect.effort).toBe("medium");
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
