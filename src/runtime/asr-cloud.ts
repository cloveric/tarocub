import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// Long-audio cloud transcription via Aliyun Tongyi Tingwu.
//
// Short audio keeps the existing local ASR (HTTP server / CLI in
// src/telegram/message-input.ts); audio at or above a duration threshold is
// routed here, which shells out to the operator's verified standalone python
// script (`<TINGWU_ASR_DIR>/tingwu_transcribe.py`). That script owns the whole
// cloud lifecycle itself: OSS upload, signed URL, CreateTask, polling, result
// download, and OSS temp-object cleanup. It also loads its own secrets from
// `<TINGWU_ASR_DIR>/.env.local` — the bridge must never read, copy, or log
// that file or any credential-bearing env value.
//
// Env config (read at CALL time, so toggling needs no restart):
//   TINGWU_ASR_DIR                  — dir containing tingwu_transcribe.py and
//                                     .venv/. Unset/empty → cloud path fully
//                                     disabled (zero behavior change).
//   ASR_CLOUD_THRESHOLD_SECONDS     — duration >= threshold routes to cloud
//                                     (default 900 = 15 minutes).
//   ASR_CLOUD_TASK_TIMEOUT_SECONDS  — --timeout passed to the script; the
//                                     child process is killed shortly after
//                                     (default 7200).

/** Per-call options the transcribe hooks may carry alongside the media path. */
export interface TranscribeMediaOptions {
  /**
   * The user's message text accompanying the media. Used for explicit routing
   * overrides: 强制云端转写 → cloud (when configured), 强制本地转写 → local.
   */
  messageText?: string;
  /** Instance state dir; cloud ASR job dirs live under `<stateDir>/asr-jobs/`. */
  stateDir?: string;
}

export interface CloudAsrConfig {
  dir: string;
  pythonPath: string;
  scriptPath: string;
  thresholdSeconds: number;
  taskTimeoutSeconds: number;
}

export type CloudAsrOverride = "cloud" | "local" | null;

const DEFAULT_CLOUD_THRESHOLD_SECONDS = 900;
const DEFAULT_CLOUD_TASK_TIMEOUT_SECONDS = 7200;
/**
 * Grace period past the script's own --timeout before the child process is
 * force-killed. The script normally exits on its own timeout; the process kill
 * is a backstop against a hung interpreter.
 */
const CLOUD_PROCESS_KILL_GRACE_MS = 60_000;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read the cloud ASR configuration from env. Returns null when TINGWU_ASR_DIR
 * is unset/empty — the cloud path is then fully disabled.
 */
export function readCloudAsrConfig(env: NodeJS.ProcessEnv = process.env): CloudAsrConfig | null {
  const dir = (env.TINGWU_ASR_DIR ?? "").trim();
  if (!dir) {
    return null;
  }

  const posixPython = path.join(dir, ".venv", "bin", "python");
  const windowsPython = path.join(dir, ".venv", "Scripts", "python.exe");
  const pythonPath = existsSync(posixPython)
    ? posixPython
    : existsSync(windowsPython)
      ? windowsPython
      : posixPython;

  return {
    dir,
    pythonPath,
    scriptPath: path.join(dir, "tingwu_transcribe.py"),
    thresholdSeconds: parsePositiveNumber(env.ASR_CLOUD_THRESHOLD_SECONDS, DEFAULT_CLOUD_THRESHOLD_SECONDS),
    taskTimeoutSeconds: parsePositiveNumber(env.ASR_CLOUD_TASK_TIMEOUT_SECONDS, DEFAULT_CLOUD_TASK_TIMEOUT_SECONDS),
  };
}

/**
 * Detect an explicit routing override in the user's message text. 强制本地转写
 * wins when both markers appear — forcing the always-available local path is
 * the safe interpretation of a conflicting request.
 */
export function detectCloudAsrOverride(messageText: string | undefined): CloudAsrOverride {
  if (!messageText) {
    return null;
  }
  if (messageText.includes("强制本地转写")) {
    return "local";
  }
  if (messageText.includes("强制云端转写")) {
    return "cloud";
  }
  return null;
}

function sanitizeJobIdSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return sanitized || "media";
}

/**
 * Run the child process with stdout/stderr captured to files in the job dir
 * (they may mention signed URLs / task ids — never surface them in chat or
 * service logs). Resolves with the exit code; rejects on spawn failure or on
 * the kill-backstop timeout. Error messages deliberately contain no stderr
 * content and no env-derived values beyond the job dir path.
 */
function runCloudAsrProcess(options: {
  pythonPath: string;
  args: string[];
  jobDir: string;
  killAfterMs: number;
  taskTimeoutSeconds: number;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdoutStream = createWriteStream(path.join(options.jobDir, "stdout.log"));
    const stderrStream = createWriteStream(path.join(options.jobDir, "stderr.log"));
    // No shell: array args only, so file names can never be interpreted.
    const child = spawn(options.pythonPath, options.args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    let settled = false;
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10_000);
      hardKill.unref();
    }, options.killAfterMs);
    killTimer.unref();

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      stdoutStream.end();
      stderrStream.end();
      settle();
    };

    child.on("error", () => {
      finish(() => reject(new Error(`cloud ASR process failed to start; logs in ${options.jobDir}`)));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(
            `cloud ASR task timed out after ${options.taskTimeoutSeconds}s; logs in ${options.jobDir}`,
          ));
          return;
        }
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  });
}

/**
 * Transcribe one media file via the operator's verified Tingwu script.
 * Creates `<jobRootDir>/<sanitized id>/`, invokes
 * `.venv/bin/python tingwu_transcribe.py --file … --source-language auto
 * --wait --poll-interval 5 --timeout <secs> --out-dir <job dir>`, and reads
 * back `<job dir>/transcription.txt`. The job dir (raw JSON, logs) is kept
 * for debugging. Throws on any failure — callers fall back to local ASR.
 */
export async function transcribeViaTingwuCloud(audioPath: string, options: {
  config: CloudAsrConfig;
  jobRootDir: string;
}): Promise<string> {
  const { config, jobRootDir } = options;
  const jobId = `${Date.now()}-${sanitizeJobIdSegment(path.basename(audioPath))}`;
  const jobDir = path.join(jobRootDir, jobId);
  await mkdir(jobDir, { recursive: true });

  const args = [
    config.scriptPath,
    "--file",
    audioPath,
    "--source-language",
    "auto",
    "--wait",
    "--poll-interval",
    "5",
    "--timeout",
    String(config.taskTimeoutSeconds),
    "--out-dir",
    jobDir,
  ];

  const exitCode = await runCloudAsrProcess({
    pythonPath: config.pythonPath,
    args,
    jobDir,
    killAfterMs: config.taskTimeoutSeconds * 1000 + CLOUD_PROCESS_KILL_GRACE_MS,
    taskTimeoutSeconds: config.taskTimeoutSeconds,
  });

  if (exitCode !== 0) {
    throw new Error(`cloud ASR exited with code ${exitCode}; logs in ${jobDir}`);
  }

  let transcript: string;
  try {
    transcript = await readFile(path.join(jobDir, "transcription.txt"), "utf8");
  } catch {
    throw new Error(`cloud ASR produced no transcription.txt; logs in ${jobDir}`);
  }
  if (!transcript.trim()) {
    throw new Error(`cloud ASR produced an empty transcript; logs in ${jobDir}`);
  }
  return transcript.trim();
}
