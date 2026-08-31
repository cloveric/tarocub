import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatCloudAsrDoctorChecks } from "../src/runtime/asr-cloud.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("cloud ASR doctor", () => {
  it("explains the official shared adapter when cloud ASR is disabled", () => {
    expect(formatCloudAsrDoctorChecks({})).toEqual([
      expect.stringContaining("bash scripts/install-tingwu-asr.sh"),
    ]);
    expect(formatCloudAsrDoctorChecks({})[0]).toContain("disabled (optional)");
  });

  it("validates the adapter contract without reading credential contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-doctor-"));
    const dir = path.join(root, "tingwu");
    try {
      await mkdir(path.join(dir, ".venv", "bin"), { recursive: true });
      await writeFile(path.join(dir, "tingwu_transcribe.py"), "# adapter\n");
      await writeFile(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(path.join(dir, ".env.local"), "DO_NOT_READ=sentinel-secret\n", { mode: 0o600 });

      const lines = formatCloudAsrDoctorChecks({
        TINGWU_ASR_DIR: dir,
        ASR_CLOUD_THRESHOLD_SECONDS: "1200",
      });

      expect(lines).toContain(`ok Cloud ASR adapter: shared external adapter ready at ${JSON.stringify(dir)}`);
      expect(lines).toContain(
        "ok Cloud ASR credential file: present and private (values/auth not inspected; verify with a real smoke test)",
      );
      expect(lines).toContain("ok Cloud ASR routing: media >= 1200s uses Tingwu; short media and cloud failures use local Qwen");
      expect(lines.join("\n")).not.toContain("sentinel-secret");
      expect(await readFile(path.join(dir, ".env.local"), "utf8")).toContain("sentinel-secret");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reports incomplete and unsafe workspace installations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-doctor-"));
    const dir = path.join(root, ".cctb", "bot", "workspace", "tingwu");
    try {
      await mkdir(dir, { recursive: true });
      const lines = formatCloudAsrDoctorChecks({ TINGWU_ASR_DIR: dir });
      expect(lines.some((line) => line.startsWith("fail Cloud ASR secrets boundary:"))).toBe(true);
      expect(lines.some((line) => line.includes("missing tingwu_transcribe.py, .venv/bin/python"))).toBe(true);
      expect(lines).toContain(
        "fail Cloud ASR credentials: .env.local is missing or empty; run `bash \"$TINGWU_ASR_DIR/configure_env.sh\"`.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("resolves symlinks before enforcing the workspace boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-doctor-"));
    const workspaceDir = path.join(root, ".cctb", "bot", "workspace", "tingwu");
    const alias = path.join(root, "apparently-safe");
    try {
      await mkdir(workspaceDir, { recursive: true });
      await symlink(workspaceDir, alias, "dir");

      expect(formatCloudAsrDoctorChecks({ TINGWU_ASR_DIR: alias }).some(
        (line) => line.startsWith("fail Cloud ASR secrets boundary:"),
      )).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects a non-executable virtualenv Python", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-doctor-"));
    const dir = path.join(root, "tingwu");
    try {
      await mkdir(path.join(dir, ".venv", "bin"), { recursive: true });
      await writeFile(path.join(dir, "tingwu_transcribe.py"), "# adapter\n");
      await writeFile(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n", { mode: 0o600 });

      expect(formatCloudAsrDoctorChecks({ TINGWU_ASR_DIR: dir }).some(
        (line) => line.includes("missing .venv/bin/python"),
      )).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("warns when the credential file is group-readable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-tingwu-doctor-"));
    const dir = path.join(root, "tingwu");
    try {
      await mkdir(path.join(dir, ".venv", "bin"), { recursive: true });
      await writeFile(path.join(dir, "tingwu_transcribe.py"), "# adapter\n");
      await writeFile(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(path.join(dir, ".env.local"), "placeholder=1\n", { mode: 0o640 });
      await chmod(path.join(dir, ".env.local"), 0o640);

      expect(formatCloudAsrDoctorChecks({ TINGWU_ASR_DIR: dir })).toContain(
        "warn Cloud ASR credentials: present but mode 640 is not private; run `chmod 600 \"$TINGWU_ASR_DIR/.env.local\"`",
      );
    } finally {
      await removeTempRoot(root);
    }
  });
});
