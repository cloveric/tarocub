import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ensureStateTreePermissions } from "../state/state-permissions.js";

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
//   ASR_CLOUD_TASK_TIMEOUT_SECONDS  — --timeout passed to the script AND the
//                                     child's wall-clock bound. Unset → the
//                                     script gets 7200 while the child is still
//                                     bounded at 900s (see below).
//   ASR_CLOUD_JOB_RETENTION_DAYS    — prune `asr-jobs/<id>/` dirs older than
//                                     this on each new job (default 7).

/** Per-call options the transcribe hooks may carry alongside the media path. */
export interface TranscribeMediaOptions {
  /**
   * The user's message text accompanying the media. Used for explicit routing
   * overrides: 强制云端转写 → cloud (when configured), 强制本地转写 → local.
   * May be the whole composed envelope — the override matcher strips the
   * bridge-generated parts before looking for a keyword.
   */
  messageText?: string;
  /** Instance state dir; cloud ASR job dirs live under `<stateDir>/asr-jobs/`. */
  stateDir?: string;
  /**
   * Cancels the entire transcription pipeline. Channel callers pass the active
   * turn signal through duration probing, local Qwen HTTP/CLI and chunking, or
   * the Tingwu child process, so `/stop` promptly releases the chat queue. The
   * bridge can abort an HTTP request, though the ASR server may finish an
   * already-running model kernel before it observes the disconnected client.
   */
  abortSignal?: AbortSignal;
}

export interface CloudAsrConfig {
  dir: string;
  pythonPath: string;
  scriptPath: string;
  thresholdSeconds: number;
  taskTimeoutSeconds: number;
  /**
   * Wall-clock bound for the child process itself, independent of the script's
   * own `--timeout`. Defaults to 15 minutes so a stuck cloud job cannot hold a
   * chat's queue slot for two hours; an explicit
   * ASR_CLOUD_TASK_TIMEOUT_SECONDS raises (or lowers) both together.
   */
  processWallClockSeconds: number;
  /** Job dirs under `asr-jobs/` older than this are pruned on each new job. */
  jobRetentionDays: number;
}

export interface CloudAsrEnv {
  TINGWU_ASR_DIR?: string;
  ASR_CLOUD_THRESHOLD_SECONDS?: string;
  ASR_CLOUD_TASK_TIMEOUT_SECONDS?: string;
  ASR_CLOUD_JOB_RETENTION_DAYS?: string;
}

export type CloudAsrOverride = "cloud" | "local" | null;

const DEFAULT_CLOUD_THRESHOLD_SECONDS = 900;
const DEFAULT_CLOUD_TASK_TIMEOUT_SECONDS = 7200;
/**
 * Default wall-clock bound for the child process. The script's own --timeout
 * defaults to 7200s (2h); killing the child only 60s after THAT meant one stuck
 * cloud job blocked the chat queue for over two hours with no feedback. The
 * verified script transcribes a 30-minute file in well under a minute, so 15
 * minutes is a generous bound. An operator who genuinely wants longer sets
 * ASR_CLOUD_TASK_TIMEOUT_SECONDS, which moves this bound with it.
 */
const DEFAULT_CLOUD_PROCESS_WALL_CLOCK_SECONDS = 900;
const DEFAULT_CLOUD_JOB_RETENTION_DAYS = 7;
/**
 * Grace period past the wall-clock bound before the child process is
 * force-killed. The script normally exits on its own timeout; the process kill
 * is a backstop against a hung interpreter.
 */
const CLOUD_PROCESS_KILL_GRACE_MS = 60_000;
/**
 * Raised when the caller's abort signal stops a cloud job. Distinct from a
 * cloud FAILURE: a cancelled turn must not silently restart the work on the
 * local engine — the operator asked for it to stop.
 */
export class CloudAsrCancelledError extends Error {
  readonly cancelled = true;
}

export function isCloudAsrCancelledError(error: unknown): boolean {
  return error instanceof CloudAsrCancelledError
    || (typeof error === "object" && error !== null && (error as { cancelled?: unknown }).cancelled === true);
}

/** SIGTERM → SIGKILL escalation delay when a job is aborted or times out. */
const CLOUD_PROCESS_HARD_KILL_DELAY_MS = 10_000;

const CLOUD_ASR_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
] as const;

/**
 * Build a minimal environment for the operator-controlled cloud ASR process.
 * Credentials are loaded by the official adapter from its own `.env.local`;
 * engine tokens, Lark/Telegram secrets, and process-injection variables must
 * never cross this child-process boundary.
 */
export function buildCloudAsrChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of CLOUD_ASR_CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) childEnv[key] = value;
  }
  return childEnv;
}

function parseExplicitPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  return parseExplicitPositiveNumber(value) ?? fallback;
}

/**
 * Read the cloud ASR configuration from env. Returns null when TINGWU_ASR_DIR
 * is unset/empty — the cloud path is then fully disabled.
 */
export function readCloudAsrConfig(env: CloudAsrEnv = process.env): CloudAsrConfig | null {
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

  // An explicit ASR_CLOUD_TASK_TIMEOUT_SECONDS is the operator saying "this is
  // how long a cloud job may take" — it drives both the script's --timeout and
  // the child's wall-clock bound. Unset keeps the script's generous 2h default
  // while still bounding the child at 15 minutes.
  const explicitTaskTimeout = parseExplicitPositiveNumber(env.ASR_CLOUD_TASK_TIMEOUT_SECONDS);

  return {
    dir,
    pythonPath,
    scriptPath: path.join(dir, "tingwu_transcribe.py"),
    thresholdSeconds: parsePositiveNumber(env.ASR_CLOUD_THRESHOLD_SECONDS, DEFAULT_CLOUD_THRESHOLD_SECONDS),
    taskTimeoutSeconds: explicitTaskTimeout ?? DEFAULT_CLOUD_TASK_TIMEOUT_SECONDS,
    processWallClockSeconds: explicitTaskTimeout ?? DEFAULT_CLOUD_PROCESS_WALL_CLOCK_SECONDS,
    jobRetentionDays: parsePositiveNumber(env.ASR_CLOUD_JOB_RETENTION_DAYS, DEFAULT_CLOUD_JOB_RETENTION_DAYS),
  };
}

function isEngineWorkspacePath(inputPath: string): boolean {
  const candidates = [path.resolve(inputPath)];
  try {
    candidates.push(realpathSync(inputPath));
  } catch {
    // The unresolved path is still useful for diagnosing an incomplete setup.
  }
  return candidates.some((candidate) => {
    const normalized = candidate.split(path.sep).join("/");
    return /\/\.cctb\/[^/]+\/workspace(?:\/|$)/.test(normalized);
  });
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(filePath: string): boolean {
  if (!isRegularFile(filePath)) {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function describePrivateFileMode(filePath: string): string | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const mode = statSync(filePath).mode & 0o777;
    return (mode & 0o077) === 0 ? null : mode.toString(8).padStart(3, "0");
  } catch {
    return null;
  }
}

/**
 * Render non-secret setup checks for operator-facing doctor output. This only
 * checks paths, file presence/size, and credential-file permissions; it never
 * reads `.env.local` or runs the operator-controlled adapter.
 */
export function formatCloudAsrDoctorChecks(env: CloudAsrEnv = process.env): string[] {
  const config = readCloudAsrConfig(env);
  if (!config) {
    return [
      "info Cloud ASR (Aliyun Tingwu): disabled (optional). Use the bundled shared adapter: `bash scripts/install-tingwu-asr.sh`.",
    ];
  }

  const checks: string[] = [];
  const displayDir = JSON.stringify(config.dir);
  if (isEngineWorkspacePath(config.dir)) {
    checks.push(
      `fail Cloud ASR secrets boundary: ${displayDir} is inside an engine workspace; reinstall with \`bash scripts/install-tingwu-asr.sh\` (default: ~/.tarocub-secrets/tingwu_asr).`,
    );
  }

  const missing: string[] = [];
  if (!isRegularFile(config.scriptPath)) {
    missing.push("tingwu_transcribe.py");
  }
  if (!isExecutableFile(config.pythonPath)) {
    missing.push(process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python");
  }
  if (missing.length > 0) {
    checks.push(
      `fail Cloud ASR adapter: incomplete at ${displayDir} (missing ${missing.join(", ")}); run \`bash scripts/install-tingwu-asr.sh --dir "$TINGWU_ASR_DIR"\`.`,
    );
  } else {
    checks.push(`ok Cloud ASR adapter: shared external adapter ready at ${displayDir}`);
  }

  const credentialsPath = path.join(config.dir, ".env.local");
  let credentialSize = 0;
  try {
    const credentialStat = statSync(credentialsPath);
    credentialSize = credentialStat.isFile() ? credentialStat.size : 0;
  } catch {
    // Missing/unreadable is reported below without opening the file.
  }
  if (credentialSize <= 0) {
    checks.push(
      "fail Cloud ASR credentials: .env.local is missing or empty; run `bash \"$TINGWU_ASR_DIR/configure_env.sh\"`.",
    );
  } else {
    const unsafeMode = describePrivateFileMode(credentialsPath);
    checks.push(
      unsafeMode
        ? `warn Cloud ASR credentials: present but mode ${unsafeMode} is not private; run \`chmod 600 "$TINGWU_ASR_DIR/.env.local"\``
        : "ok Cloud ASR credential file: present and private (values/auth not inspected; verify with a real smoke test)",
    );
  }

  checks.push(
    `ok Cloud ASR routing: media >= ${config.thresholdSeconds}s uses Tingwu; short media and cloud failures use local Qwen`,
  );
  return checks;
}

/**
 * Strip the bridge-composed parts of a message envelope so keyword matching
 * only sees what the HUMAN typed. The Lark normalizer wraps every turn in
 * `<lark_context>…</lark_context>` plus an `[audio:file_key name]` attachment
 * summary, and a forwarded bundle arrives inside
 * `<forwarded_lark_messages>` — a file NAMED "强制云端转写.m4a", or a forwarded
 * message quoting the keyword, must not silently reroute someone else's audio.
 */
function extractUserBodyText(messageText: string): string {
  return messageText
    .replace(/<lark_context>[\s\S]*?<\/lark_context>/g, " ")
    .replace(/<lark_comment_context>[\s\S]*?<\/lark_comment_context>/g, " ")
    .replace(/<forwarded_lark_messages>[\s\S]*?<\/forwarded_lark_messages>/g, " ")
    .replace(/^\[(?:image|file|audio|video):[^\]]*\]$/gm, " ");
}

/**
 * Detect an explicit routing override in the user's own message body. 强制本地转写
 * wins when both markers appear — forcing the always-available local path is
 * the safe interpretation of a conflicting request.
 *
 * The keyword must travel WITH the audio: as its caption, or as a text message
 * in the same attachment burst (the merged turn carries both). A keyword sent
 * as a separate later message is a new turn and cannot reroute a transcription
 * that already started.
 */
export function detectCloudAsrOverride(messageText: string | undefined): CloudAsrOverride {
  if (!messageText) {
    return null;
  }
  const body = extractUserBodyText(messageText);
  if (body.includes("强制本地转写")) {
    return "local";
  }
  if (body.includes("强制云端转写")) {
    return "cloud";
  }
  return null;
}

/**
 * Best-effort prune of stale `asr-jobs/<id>/` dirs. Each job keeps the raw
 * cloud payloads (a 20-minute job is ~688 KB and names OSS objects), so an
 * unpruned root grows without bound. Never throws: pruning must not be able to
 * fail a transcription.
 */
export async function pruneCloudAsrJobDirs(jobRootDir: string, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  let pruned = 0;
  try {
    const entries = await readdir(jobRootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(jobRootDir, entry.name);
      try {
        const stats = await stat(fullPath);
        if (stats.mtimeMs >= cutoff) {
          continue;
        }
        await rm(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
        pruned += 1;
      } catch {
        // One undeletable job dir must never block the rest (or the new job).
      }
    }
  } catch {
    // No job root yet (first cloud job) or an unreadable dir — nothing to prune.
  }
  return pruned;
}

function sanitizeJobIdSegment(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return sanitized || "media";
}

/**
 * Run the child process with stdout/stderr captured to files in the job dir
 * (they may mention signed URLs / task ids — never surface them in chat or
 * service logs). Resolves with the exit code; rejects on spawn failure, on the
 * wall-clock kill backstop, on abort, and on a log-capture stream error. Error
 * messages deliberately contain no stderr content and no env-derived values
 * beyond the job dir path.
 *
 * Exported for tests only (an unwritable job dir must reject through the normal
 * failure path, not kill the service with an uncaught stream error).
 */
export function runCloudAsrProcess(options: {
  pythonPath: string;
  args: string[];
  jobDir: string;
  killAfterMs: number;
  wallClockSeconds: number;
  abortSignal?: AbortSignal;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    if (options.abortSignal?.aborted) {
      reject(new CloudAsrCancelledError("cloud ASR transcription was cancelled before it started"));
      return;
    }

    // 0600: these logs can mention signed OSS URLs and task ids.
    const stdoutStream = createWriteStream(path.join(options.jobDir, "stdout.log"), { mode: 0o600 });
    const stderrStream = createWriteStream(path.join(options.jobDir, "stderr.log"), { mode: 0o600 });
    // No shell: array args only, so file names can never be interpreted.
    const child = spawn(options.pythonPath, options.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildCloudAsrChildEnv(),
    });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    let settled = false;
    let timedOut = false;
    const killChild = (): void => {
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, CLOUD_PROCESS_HARD_KILL_DELAY_MS);
      hardKill.unref();
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.killAfterMs);
    killTimer.unref();

    const onAbort = (): void => {
      // Kill first, then settle: the caller (a queued turn) gets its slot back
      // immediately instead of waiting out the wall-clock bound.
      killChild();
      finish(() => reject(new CloudAsrCancelledError(`cloud ASR transcription was cancelled; logs in ${options.jobDir}`)));
    };

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      // The streams may already be errored/destroyed; end() must never throw
      // out of the settle path.
      try { stdoutStream.end(); } catch { /* already destroyed */ }
      try { stderrStream.end(); } catch { /* already destroyed */ }
      settle();
    };

    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    // ENOSPC/EACCES/EMFILE on a pipe destination used to surface as an UNCAUGHT
    // exception (no 'error' listener) and took the whole Lark service down.
    // Route it through the normal failure path so the documented local-ASR
    // fallback actually happens.
    const onStreamError = (): void => {
      killChild();
      finish(() => reject(new Error(`cloud ASR could not write its job logs; job dir ${options.jobDir}`)));
    };
    stdoutStream.on("error", onStreamError);
    stderrStream.on("error", onStreamError);
    child.stdout.on("error", onStreamError);
    child.stderr.on("error", onStreamError);

    child.on("error", () => {
      finish(() => reject(new Error(`cloud ASR process failed to start; logs in ${options.jobDir}`)));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(
            `cloud ASR task timed out after ${options.wallClockSeconds}s; logs in ${options.jobDir}`,
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
 * for debugging, and dirs older than `jobRetentionDays` are pruned here.
 * Throws on any failure — callers fall back to local ASR.
 */
export async function transcribeViaTingwuCloud(audioPath: string, options: {
  config: CloudAsrConfig;
  jobRootDir: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { config, jobRootDir } = options;
  // randomUUID, not just the millisecond clock: every Feishu voice message
  // downloads as the SAME constant basename (`audio-1.ogg`), so two chats
  // transcribing in the same millisecond used to share one job dir and could
  // read back each other's transcription.txt.
  const jobId = `${Date.now()}-${sanitizeJobIdSegment(path.basename(audioPath))}-${randomUUID()}`;
  const jobDir = path.join(jobRootDir, jobId);
  await pruneCloudAsrJobDirs(jobRootDir, config.jobRetentionDays);
  // 0700: the job dir keeps the raw cloud payloads (signed URLs, transcripts).
  await mkdir(jobDir, { recursive: true, mode: 0o700 });

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
    killAfterMs: config.processWallClockSeconds * 1000 + CLOUD_PROCESS_KILL_GRACE_MS,
    wallClockSeconds: config.processWallClockSeconds,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });

  // The python script writes transcripts/raw payloads with its own umask; tighten
  // the whole job dir before anything else can read them.
  await ensureStateTreePermissions(jobDir);

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
