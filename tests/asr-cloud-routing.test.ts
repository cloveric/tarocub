import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { detectCloudAsrOverride, readCloudAsrConfig } from "../src/runtime/asr-cloud.js";
import { createDefaultTranscribeVoice } from "../src/telegram/message-input.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const CLOUD_TRANSCRIPT = "cloud transcript from tingwu";
const LOCAL_TRANSCRIPT = "local transcript";

/**
 * Install a FAKE Tingwu dir: `<dir>/tingwu_transcribe.py` plus an executable
 * `<dir>/.venv/bin/python` shell script that records its argv to
 * `<dir>/invocations.log` and (on success) writes transcription.txt into the
 * --out-dir it was given — mirroring the real verified script's contract.
 */
async function setupFakeTingwuDir(root: string, behavior: "success" | "fail"): Promise<{
  dir: string;
  invocationsPath: string;
}> {
  const dir = path.join(root, "tingwu");
  await mkdir(path.join(dir, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(dir, "tingwu_transcribe.py"), "# fake tingwu script (never executed as python)\n");
  const invocationsPath = path.join(dir, "invocations.log");

  const lines = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" >> '${invocationsPath}'`,
    "echo 'fake tingwu stdout'",
    "echo 'fake tingwu stderr' >&2",
  ];
  if (behavior === "fail") {
    lines.push("exit 1");
  } else {
    lines.push(
      'out=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--out-dir" ]; then out="$a"; fi',
      '  prev="$a"',
      "done",
      'mkdir -p "$out"',
      `printf '${CLOUD_TRANSCRIPT}' > "$out/transcription.txt"`,
      "exit 0",
    );
  }
  await writeFile(path.join(dir, ".venv", "bin", "python"), `${lines.join("\n")}\n`, { mode: 0o755 });

  return { dir, invocationsPath };
}

async function readInvocationArgs(invocationsPath: string): Promise<string[]> {
  const content = await readFile(invocationsPath, "utf8");
  return content.split("\n").filter((line) => line !== "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** ffprobe seam: resolves the injected duration; rejects when duration is null. */
function fakeExecFileImpl(durationSeconds: number | null) {
  return vi.fn((
    file: string,
    _args: readonly string[],
    _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (file === "ffprobe") {
      if (durationSeconds === null) {
        callback(new Error("ffprobe unavailable in test"), "", "");
        return;
      }
      callback(null, `${durationSeconds}\n`, "");
      return;
    }
    callback(new Error(`unexpected command: ${file}`), "", "");
  });
}

function localHttpFetch() {
  return vi.fn(async () => ({
    ok: true,
    text: async () => LOCAL_TRANSCRIPT,
  }));
}

function buildTranscriber(options: {
  durationSeconds: number | null;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  fetchImpl?: ReturnType<typeof localHttpFetch>;
}) {
  const fetchImpl = options.fetchImpl ?? localHttpFetch();
  const transcribe = createDefaultTranscribeVoice({
    httpUrl: "http://127.0.0.1:8412/transcribe",
    cliPython: "",
    cliScript: "",
    fetchImpl: fetchImpl as never,
    watchdog: {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    },
    execFileImpl: fakeExecFileImpl(options.durationSeconds),
    ffprobePath: "ffprobe",
    ffmpegPath: "ffmpeg",
    // Keep the local path single-file so tests never need ffmpeg chunking.
    chunkAfterSeconds: 100_000,
    env: options.env,
    stateDir: options.stateDir,
  } as never);
  return { transcribe, fetchImpl };
}

describe("cloud ASR routing (Aliyun Tingwu)", () => {
  it("keeps under-threshold audio on local ASR without invoking the cloud script", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const stateDir = path.join(root, "state");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 60,
        env: { TINGWU_ASR_DIR: dir },
        stateDir,
      });

      await expect(transcribe("/tmp/short-note.m4a")).resolves.toBe(LOCAL_TRANSCRIPT);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await fileExists(invocationsPath)).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("routes at-threshold audio to the cloud script with the verified argument shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const stateDir = path.join(root, "state");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 900, // exactly the default threshold — >= routes cloud
        env: { TINGWU_ASR_DIR: dir },
        stateDir,
      });

      await expect(transcribe("/tmp/long-meeting.m4a")).resolves.toBe(CLOUD_TRANSCRIPT);

      expect(fetchImpl).not.toHaveBeenCalled();
      const args = await readInvocationArgs(invocationsPath);
      const jobDir = args[args.length - 1] ?? "";
      expect(args).toEqual([
        path.join(dir, "tingwu_transcribe.py"),
        "--file",
        "/tmp/long-meeting.m4a",
        "--source-language",
        "auto",
        "--wait",
        "--poll-interval",
        "5",
        "--timeout",
        "7200",
        "--out-dir",
        jobDir,
      ]);
      // Job dir lives under `<stateDir>/asr-jobs/` with stdout/stderr captured
      // to files (never surfaced in chat).
      expect(jobDir.startsWith(path.join(stateDir, "asr-jobs") + path.sep)).toBe(true);
      expect(await readFile(path.join(jobDir, "stdout.log"), "utf8")).toContain("fake tingwu stdout");
      expect(await readFile(path.join(jobDir, "stderr.log"), "utf8")).toContain("fake tingwu stderr");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("honors ASR_CLOUD_THRESHOLD_SECONDS and ASR_CLOUD_TASK_TIMEOUT_SECONDS overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const { transcribe } = buildTranscriber({
        durationSeconds: 120,
        env: {
          TINGWU_ASR_DIR: dir,
          ASR_CLOUD_THRESHOLD_SECONDS: "100",
          ASR_CLOUD_TASK_TIMEOUT_SECONDS: "300",
        },
        stateDir: path.join(root, "state"),
      });

      await expect(transcribe("/tmp/medium-note.m4a")).resolves.toBe(CLOUD_TRANSCRIPT);

      const args = await readInvocationArgs(invocationsPath);
      expect(args).toContain("--timeout");
      expect(args[args.indexOf("--timeout") + 1]).toBe("300");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("falls back to local ASR when the cloud script fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "fail");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 1200,
        env: { TINGWU_ASR_DIR: dir },
        stateDir: path.join(root, "state"),
      });

      await expect(transcribe("/tmp/long-meeting.m4a")).resolves.toBe(LOCAL_TRANSCRIPT);

      // Cloud was attempted first, then the local path ran.
      expect(await fileExists(invocationsPath)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // The fallback warn must not leak stderr content from the cloud job.
      const warnText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warnText).toContain("falling back to local ASR");
      expect(warnText).not.toContain("fake tingwu stderr");
    } finally {
      warnSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("behaves exactly like a local failure when cloud AND local both fail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { dir } = await setupFakeTingwuDir(root, "fail");
      const fetchImpl = vi.fn().mockRejectedValue(new Error("local ASR down")) as ReturnType<typeof localHttpFetch>;
      const { transcribe } = buildTranscriber({
        durationSeconds: 1200,
        env: { TINGWU_ASR_DIR: dir },
        stateDir: path.join(root, "state"),
        fetchImpl,
      });

      // Same terminal error the local path produces today (no CLI configured).
      await expect(transcribe("/tmp/long-meeting.m4a")).rejects.toThrow("ASR not configured");
    } finally {
      warnSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("forces short audio to the cloud on 强制云端转写", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 60,
        env: { TINGWU_ASR_DIR: dir },
        stateDir: path.join(root, "state"),
      });

      await expect(
        transcribe("/tmp/short-note.m4a", { messageText: "转写一下这段，强制云端转写" }),
      ).resolves.toBe(CLOUD_TRANSCRIPT);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await fileExists(invocationsPath)).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps long audio local on 强制本地转写", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 1200,
        env: { TINGWU_ASR_DIR: dir },
        stateDir: path.join(root, "state"),
      });

      await expect(
        transcribe("/tmp/long-meeting.m4a", { messageText: "强制本地转写" }),
      ).resolves.toBe(LOCAL_TRANSCRIPT);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await fileExists(invocationsPath)).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("never invokes the cloud when TINGWU_ASR_DIR is unset, even under override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { invocationsPath } = await setupFakeTingwuDir(root, "success");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 1200,
        env: {}, // feature OFF
        stateDir: path.join(root, "state"),
      });

      await expect(
        transcribe("/tmp/long-meeting.m4a", { messageText: "强制云端转写" }),
      ).resolves.toBe(LOCAL_TRANSCRIPT);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await fileExists(invocationsPath)).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps unknown-duration audio on local ASR (as today)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: null, // ffprobe fails → duration unknown
        env: { TINGWU_ASR_DIR: dir },
        stateDir: path.join(root, "state"),
      });

      await expect(transcribe("/tmp/mystery.m4a")).resolves.toBe(LOCAL_TRANSCRIPT);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await fileExists(invocationsPath)).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reads the cloud config at call time, not factory time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asr-cloud-routing-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "success");
      const env: NodeJS.ProcessEnv = {}; // unset at factory time
      const { transcribe, fetchImpl } = buildTranscriber({
        durationSeconds: 1200,
        env,
        stateDir: path.join(root, "state"),
      });

      await expect(transcribe("/tmp/long-meeting.m4a")).resolves.toBe(LOCAL_TRANSCRIPT);
      expect(await fileExists(invocationsPath)).toBe(false);

      env.TINGWU_ASR_DIR = dir; // enabled between calls — no rebuild
      await expect(transcribe("/tmp/long-meeting.m4a")).resolves.toBe(CLOUD_TRANSCRIPT);
      expect(await fileExists(invocationsPath)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempRoot(root);
    }
  });
});

describe("readCloudAsrConfig", () => {
  it("is disabled for unset or blank TINGWU_ASR_DIR and defaults its numbers", () => {
    expect(readCloudAsrConfig({})).toBeNull();
    expect(readCloudAsrConfig({ TINGWU_ASR_DIR: "   " })).toBeNull();

    const config = readCloudAsrConfig({ TINGWU_ASR_DIR: "/opt/tingwu" });
    expect(config).not.toBeNull();
    expect(config?.thresholdSeconds).toBe(900);
    expect(config?.taskTimeoutSeconds).toBe(7200);
    expect(config?.scriptPath).toBe(path.join("/opt/tingwu", "tingwu_transcribe.py"));
  });

  it("ignores invalid numeric overrides", () => {
    const config = readCloudAsrConfig({
      TINGWU_ASR_DIR: "/opt/tingwu",
      ASR_CLOUD_THRESHOLD_SECONDS: "not-a-number",
      ASR_CLOUD_TASK_TIMEOUT_SECONDS: "-5",
    });
    expect(config?.thresholdSeconds).toBe(900);
    expect(config?.taskTimeoutSeconds).toBe(7200);
  });
});

describe("detectCloudAsrOverride", () => {
  it("detects both overrides and lets 强制本地转写 win a conflict", () => {
    expect(detectCloudAsrOverride(undefined)).toBeNull();
    expect(detectCloudAsrOverride("普通消息")).toBeNull();
    expect(detectCloudAsrOverride("请 强制云端转写")).toBe("cloud");
    expect(detectCloudAsrOverride("请 强制本地转写")).toBe("local");
    expect(detectCloudAsrOverride("强制云端转写 强制本地转写")).toBe("local");
  });
});
