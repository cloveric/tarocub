import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("DeepSeek Harness plugin bundle", () => {
  it("publishes a native dsh bundle manifest that activates the TaroCub plugin", async () => {
    const rootPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as Record<string, any>;
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "deepseek-harness-plugin", "package.json"), "utf8"),
    ) as Record<string, any>;
    const patchPath = packageJson.dsh?.bundle?.patch;

    expect(rootPackageJson.dsh).toBeUndefined();
    expect(packageJson.name).toBe("tarocub-deepseek-harness-plugin");
    expect(packageJson.version).toBe(rootPackageJson.version);
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.main).toBe("./index.js");
    expect(patchPath).toBe("./cordis.patch.yml");
    const patch = await readFile(path.join(repoRoot, "deepseek-harness-plugin", patchPath), "utf8");
    expect(patch).toMatch(/^- insert:/m);
    expect(patch).toMatch(/^\s+- id: tarocub$/m);
    expect(patch).toMatch(new RegExp(`^\\s+name: ${packageJson.name}$`, "m"));
  });

  it("registers bounded companion guidance and a truthful /tarocub command", async () => {
    const plugin = await import(pathToFileURL(
      path.join(repoRoot, "deepseek-harness-plugin", "index.js"),
    ).href) as {
      name: string;
      inject: string[];
      apply: (ctx: Record<string, any>) => void;
    };
    const section = vi.fn();
    let registeredCommand: unknown;
    const register = vi.fn((command: unknown) => {
      registeredCommand = command;
      return () => {};
    });
    const effect = vi.fn((factory: () => unknown) => factory());

    plugin.apply({
      systemPrompt: { section },
      commands: { register },
      effect,
    });

    expect(plugin.name).toBe("tarocub");
    expect(plugin.inject).toEqual(["systemPrompt", "commands"]);
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: "integration:tarocub",
      text: expect.stringMatching(/separate local Feishu\/Lark-first bridge/i),
    }));
    expect(effect).toHaveBeenCalledTimes(1);
    const command = registeredCommand as {
      name: string;
      handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }>;
    };
    expect(command.name).toBe("tarocub");
    await expect(command.handler({ rawInput: "" })).resolves.toMatchObject({
      kind: "success",
      text: expect.stringMatching(/github\.com\/cloveric\/tarocub/i),
    });
    await expect(command.handler({ rawInput: "unexpected" })).resolves.toMatchObject({
      kind: "error",
    });
  });
});
