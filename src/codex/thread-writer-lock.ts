// Diagnose "thread <id> already has an active writer" by naming the process
// that actually holds the thread's writer lock.
//
// Codex serializes writers per thread with an advisory lock on
// `<CODEX_HOME>/thread-writer-locks/<threadId>.lock`. The lock lives in the
// HOLDING PROCESS, not on disk, so a conflict caused by another application
// (observed in the field: the ChatGPT desktop app's bundled app-server opens
// every recently-viewed thread and keeps its writer lock for the lifetime of
// the app) survives any number of bridge restarts. Without this diagnosis the
// operator sees a bare "turn failed" and cannot tell an external holder from a
// bridge-side leak — the difference between "quit that app" and "file a bug".
//
// Everything here is best-effort and read-only: it never takes the lock, and
// any probe failure degrades to "unknown holder".

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCK_DIR = "thread-writer-locks";
const PROBE_TIMEOUT_MS = 3_000;

export interface ThreadWriterLockHolder {
  pid: number;
  /** Raw command line of the holding process, when readable. */
  command?: string;
  /** True when the holder is this bridge's own app-server child. */
  isOwnChild: boolean;
  /** Recognizable app name for the operator ("ChatGPT 桌面应用" etc.). */
  appLabel?: string;
}

export function resolveThreadWriterLockPath(codexHome: string, threadId: string): string {
  return path.join(codexHome, LOCK_DIR, `${threadId}.lock`);
}

export function resolveCodexHome(engineHomePath: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return engineHomePath || env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Human-friendly app name for a known lock holder, or undefined when unknown. */
export function describeLockHolderApp(command: string): string | undefined {
  if (/ChatGPT\.app/i.test(command)) {
    return "ChatGPT 桌面应用";
  }
  if (/Codex\.app|Codex \(Service\)/i.test(command)) {
    return "Codex 桌面应用";
  }
  if (/\bcodex\b.*\bapp-server\b/i.test(command)) {
    return "另一个 Codex app-server";
  }
  if (/\bcodex\b/i.test(command)) {
    return "另一个 Codex 进程";
  }
  return undefined;
}

/**
 * Identify which process holds a thread's writer lock. Returns null when the
 * lock file does not exist, nothing holds it, or the probe is unavailable
 * (`lsof` missing, non-macOS/Linux, permission denied).
 */
export async function findThreadWriterLockHolder(input: {
  codexHome: string;
  threadId: string;
  ownPid?: number;
  execFileFn?: typeof execFileAsync;
}): Promise<ThreadWriterLockHolder | null> {
  if (process.platform === "win32") {
    return null;
  }
  const lockPath = resolveThreadWriterLockPath(input.codexHome, input.threadId);
  const run = input.execFileFn ?? execFileAsync;
  let stdout: string;
  try {
    // -t: pids only, one per line. Exit code 1 simply means "no holder".
    const result = await run("lsof", ["-t", lockPath], { timeout: PROBE_TIMEOUT_MS });
    stdout = result.stdout;
  } catch {
    return null;
  }
  const pids = stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  if (pids.length === 0) {
    return null;
  }
  // Prefer a holder that is NOT our own child: that is the actionable one.
  const ranked = [...pids].sort((a, b) => Number(a === input.ownPid) - Number(b === input.ownPid));
  const pid = ranked[0]!;
  let command: string | undefined;
  try {
    const { stdout: args } = await run("ps", ["-p", String(pid), "-o", "args="], { timeout: PROBE_TIMEOUT_MS });
    command = args.trim() || undefined;
  } catch {
    command = undefined;
  }
  const appLabel = command ? describeLockHolderApp(command) : undefined;
  return {
    pid,
    ...(command ? { command } : {}),
    isOwnChild: input.ownPid !== undefined && pid === input.ownPid,
    ...(appLabel ? { appLabel } : {}),
  };
}

/** Operator-facing explanation appended to the writer-conflict error. */
export function renderThreadWriterLockDiagnosis(holder: ThreadWriterLockHolder | null): string {
  if (!holder) {
    return "该会话线程被占用，但未能查到占用方（锁可能刚被释放）。稍后重试，或用 /reset 换一条新线程。";
  }
  if (holder.isOwnChild) {
    return `该会话线程仍被本 bot 自己的引擎进程（pid ${holder.pid}）占用，通常是上一轮尚未结束。稍等片刻重试，或 /stop 后再发。`;
  }
  const who = holder.appLabel ?? `另一个进程（pid ${holder.pid}）`;
  return `该会话线程的写入权被${who}占用（pid ${holder.pid}），重启本 bot 无效。`
    + `退出该应用即可恢复；或用 /reset 换一条新线程（会丢失该会话的 Codex 上下文）。`;
}
