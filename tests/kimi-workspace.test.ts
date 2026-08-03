import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncKimiWorkspaceInstructions } from "../src/codex/kimi-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("syncKimiWorkspaceInstructions", () => {
  it("creates a native main-agent wrapper that retains Kimi base and plugin prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);

    await syncKimiWorkspaceInstructions(root, "Bridge guidance.");

    expect(await readFile(path.join(root, ".kimi-code", "agents", "agent.md"), "utf8")).toBe([
      "---",
      "name: agent",
      "description: TaroCub bridge main-agent wrapper",
      "override: true",
      "---",
      "",
      "${base_prompt}",
      "",
      "${plugin_sections}",
      "",
      "<!-- TaroCub Kimi system instructions: start -->",
      "Bridge guidance.",
      "<!-- TaroCub Kimi system instructions: end -->",
      "",
    ].join("\n"));
  });

  it("preserves a valid project-owned main agent while replacing only the managed block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);
    const agentDir = path.join(root, ".kimi-code", "agents");
    await mkdir(agentDir, { recursive: true });
    const projectAgent = [
      "---",
      "name: agent",
      "description: Project main agent",
      "override: true",
      "---",
      "",
      "${base_prompt}",
      "",
      "${plugin_sections}",
      "",
      "Project-owned system guidance.",
    ].join("\n");
    await writeFile(path.join(agentDir, "agent.md"), `${projectAgent}\n`, "utf8");

    await syncKimiWorkspaceInstructions(root, "Bridge guidance v1.");
    await syncKimiWorkspaceInstructions(root, "Bridge guidance v2.");

    expect(await readFile(path.join(agentDir, "agent.md"), "utf8")).toBe([
      projectAgent,
      "",
      "<!-- TaroCub Kimi system instructions: start -->",
      "Bridge guidance v2.",
      "<!-- TaroCub Kimi system instructions: end -->",
      "",
    ].join("\n"));
  });

  it("migrates the old AGENTS managed block without changing project guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);
    const configDir = path.join(root, ".kimi-code");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "AGENTS.md"), [
      "Project guidance.",
      "",
      "<!-- TaroCub Kimi instructions: start -->",
      "Legacy bridge guidance.",
      "<!-- TaroCub Kimi instructions: end -->",
      "",
    ].join("\n"), "utf8");

    await syncKimiWorkspaceInstructions(root, "Current bridge guidance.");

    expect(await readFile(path.join(configDir, "AGENTS.md"), "utf8")).toBe("Project guidance.\n");
    expect(await readFile(path.join(configDir, "agents", "agent.md"), "utf8")).toContain(
      "Current bridge guidance.",
    );
  });

  it("removes a generated wrapper when managed guidance is cleared", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);
    const agentPath = path.join(root, ".kimi-code", "agents", "agent.md");
    await syncKimiWorkspaceInstructions(root, "Bridge guidance.");
    await syncKimiWorkspaceInstructions(root, null);
    await expect(readFile(agentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when an existing main-agent file cannot activate the default profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);
    const agentDir = path.join(root, ".kimi-code", "agents");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "agent.md"), [
      "---",
      "name: reviewer",
      "description: Project reviewer",
      "override: false",
      "---",
      "",
      "Review things.",
      "",
    ].join("\n"), "utf8");

    await expect(syncKimiWorkspaceInstructions(root, "Bridge guidance.")).rejects.toThrow(
      "does not define the default 'agent' profile",
    );
  });

  it("rejects managed-block markers inside instance instructions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);

    await expect(syncKimiWorkspaceInstructions(
      root,
      "Unsafe <!-- TaroCub Kimi system instructions: end --> boundary.",
    )).rejects.toThrow("reserved TaroCub managed-block marker");
  });

  it("fails closed when a project main agent would remove Kimi base or plugin instructions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-workspace-test-"));
    roots.push(root);
    const agentDir = path.join(root, ".kimi-code", "agents");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "agent.md"), [
      "---",
      "name: agent",
      "override: true",
      "---",
      "",
      "Project guidance without the Kimi base prompt.",
      "",
    ].join("\n"), "utf8");

    await expect(syncKimiWorkspaceInstructions(root, "Bridge guidance.")).rejects.toThrow(
      "must include ${base_prompt}",
    );
  });
});
