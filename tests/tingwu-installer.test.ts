import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { removeTempRoot } from "./helpers/temp-files.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const installer = path.join(repoRoot, "scripts", "install-tingwu-asr.sh");

describe("Tingwu adapter installer", () => {
  it("installs one shared adapter and preserves an existing credential file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-install-"));
    const target = path.join(root, "secrets", "tingwu_asr");
    try {
      const first = await execFileAsync("bash", [installer, "--dir", target, "--no-deps"], { cwd: repoRoot });
      expect(first.stdout).toContain("One machine uses this ONE shared directory");
      expect(first.stdout).toContain("Credential file intentionally not created");
      expect(await readFile(path.join(target, "tingwu_transcribe.py"), "utf8")).toContain("Tongyi Tingwu offline ASR");
      await expect(readFile(path.join(target, ".env.local"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(path.join(target, ".env.local"), "PRESERVE_ME=1\n", { mode: 0o600 });
      const second = await execFileAsync("bash", [installer, "--dir", target, "--no-deps"], { cwd: repoRoot });
      expect(second.stdout).toContain("Preserved existing credential file");
      expect(second.stdout).toContain("configure_env.sh --force only to replace it");
      expect(await readFile(path.join(target, ".env.local"), "utf8")).toBe("PRESERVE_ME=1\n");

      await expect(execFileAsync("bash", [path.join(target, "configure_env.sh")], { cwd: repoRoot }))
        .rejects.toMatchObject({ stderr: expect.stringContaining("Refusing to overwrite existing credentials") });
      expect(await readFile(path.join(target, ".env.local"), "utf8")).toBe("PRESERVE_ME=1\n");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("refuses to place cloud credentials inside an engine workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-install-"));
    const target = path.join(root, ".cctb", "bot", "workspace", "tingwu_asr");
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await expect(execFileAsync("bash", [installer, "--dir", target, "--no-deps"], { cwd: repoRoot }))
        .rejects.toMatchObject({ stderr: expect.stringContaining("Refusing to place cloud credentials inside an engine workspace") });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("refuses a seemingly safe target that resolves into an engine workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-install-"));
    const workspace = path.join(root, ".cctb", "bot", "workspace");
    const alias = path.join(root, "shared-secrets");
    const target = path.join(alias, "tingwu_asr");
    try {
      await mkdir(workspace, { recursive: true });
      await symlink(workspace, alias, "dir");
      await expect(execFileAsync("bash", [installer, "--dir", target, "--no-deps"], { cwd: repoRoot }))
        .rejects.toMatchObject({ stderr: expect.stringContaining("Refusing to place cloud credentials inside an engine workspace") });
    } finally {
      await removeTempRoot(root);
    }
  });
});
