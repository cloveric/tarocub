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
    const packageLock = JSON.parse(
      await readFile(path.join(repoRoot, "deepseek-harness-plugin", "package-lock.json"), "utf8"),
    ) as Record<string, any>;
    const patchPath = packageJson.dsh?.bundle?.patch;

    expect(rootPackageJson.dsh).toBeUndefined();
    expect(packageJson.name).toBe("tarocub-deepseek-harness-plugin");
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.[""]?.version).toBe(packageJson.version);
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.main).toBe("./index.js");
    expect(packageJson.private).toBe(true);
    expect(packageJson.tarocub).toEqual({
      searchMcp: true,
      searchMcpProtocol: 1,
      searchMcpEntrypoint: "./dist/search-mcp.js",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "dist/search-mcp.js",
      "README.md",
      "README.zh-CN.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "LICENSE",
    ]));
    expect(patchPath).toBe("./cordis.patch.yml");
    const patch = await readFile(path.join(repoRoot, "deepseek-harness-plugin", patchPath), "utf8");
    expect(patch).toMatch(/^- insert:/m);
    expect(patch).toMatch(/^\s+- id: tarocub$/m);
    expect(patch).toMatch(new RegExp(`^\\s+name: ${packageJson.name}$`, "m"));
    expect(patch).toMatch(/^\s+- id: mcp-cctb-search$/m);
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: cctb_search");
    expect(patch).toContain("command: !!js process.execPath");
    expect(patch).toContain(
      "new URL('./node_modules/tarocub-deepseek-harness-plugin/dist/search-mcp.js', baseUrl)",
    );
    expect(patch).toContain(
      "disabled: !!js process.env.TAROCUB_SEARCH_MCP_OWNER === 'bridge'",
    );
    expect(patch).toContain("failOnStartupError: false");
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

  it("ships complete bilingual operator and security documentation", async () => {
    const pluginRoot = path.join(repoRoot, "deepseek-harness-plugin");
    const [english, chinese, security, contributing, license, workflow] = await Promise.all([
      readFile(path.join(pluginRoot, "README.md"), "utf8"),
      readFile(path.join(pluginRoot, "README.zh-CN.md"), "utf8"),
      readFile(path.join(pluginRoot, "SECURITY.md"), "utf8"),
      readFile(path.join(pluginRoot, "CONTRIBUTING.md"), "utf8"),
      readFile(path.join(pluginRoot, "LICENSE"), "utf8"),
      readFile(path.join(pluginRoot, ".github", "workflows", "ci.yml"), "utf8"),
    ]);

    for (const readme of [english, chinese]) {
      expect(readme).toContain("github:cloveric/tarocub-deepseek-harness-plugin");
      expect(readme).toContain("web_search");
      expect(readme).toContain("web_extract");
      expect(readme).toContain("provider_status");
      expect(readme).toContain("health_check");
      expect(readme).toContain("BRAVE_API_KEY");
      expect(readme).toContain("TAVILY_API_KEY");
      expect(readme).toContain("dsh --profile web --dump-config");
      expect(readme).toContain("TAROCUB_SEARCH_MCP_OWNER");
    }
    expect(english).toContain("README.zh-CN.md");
    expect(chinese).toContain("README.md");
    expect(security).toMatch(/never.*log.*API key/is);
    expect(contributing).toContain("npm run verify");
    expect(contributing).toContain("git subtree");
    expect(license).toContain("MIT License");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run verify");
  });

  it("commits a deterministic bundle without trailing whitespace", async () => {
    const bundle = await readFile(
      path.join(repoRoot, "deepseek-harness-plugin", "dist", "search-mcp.js"),
      "utf8",
    );

    expect(bundle).not.toMatch(/[ \t]+$/m);
  });

  it("installs the plugin lockfile before verification and subtree publication", async () => {
    const script = await readFile(
      path.join(repoRoot, "scripts", "publish-deepseek-harness-plugin.sh"),
      "utf8",
    );
    const installIndex = script.indexOf('npm --prefix "$ROOT/$PREFIX" ci');
    const verifyIndex = script.indexOf('npm --prefix "$ROOT/$PREFIX" run verify');

    expect(installIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(installIndex);
  });
});
