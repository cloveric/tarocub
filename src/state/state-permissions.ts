import { chmod, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Instance state under `~/.cctb/<instance>/` holds bot tokens (.env, lark.env),
// pairing/access policy, session bindings and raw engine stderr. Historically the
// directory was created by whichever code path ran first, without a mode, so live
// instances ended up world-readable (dir 0755, `.env` 0644): any local process
// could read a bot token. Creation sites now pass explicit modes, and this module
// repairs directories that were created before that fix.
export const STATE_DIR_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;

/** Files inside the instance state dir that must never be world/group readable. */
const SENSITIVE_STATE_FILES = [
  ".env",
  "lark.env",
  "shared.env",
  "access.json",
  "session.json",
  "config.json",
  "known-chats.json",
  "lark-chat-id-map.json",
  "usage.json",
  "board.json",
  "file-workflow.json",
  path.join("cron", "jobs.json"),
  path.join("timers", "jobs.json"),
];

/** Whole subtrees whose contents are sensitive (dirs 0700, files 0600). */
const SENSITIVE_STATE_TREES = ["asr-jobs"];

/** Any log file: service.stderr.log is raw, unredacted engine stderr. */
const LOG_FILE_PATTERN = /\.log(?:\.jsonl)?(?:\.\d+)?$/i;

let warnedOnce = false;

function warnOnce(stateDir: string, error: unknown): void {
  if (warnedOnce) {
    return;
  }
  warnedOnce = true;
  console.warn(
    `Could not tighten permissions on state directory ${stateDir}:`,
    error instanceof Error ? error.message : error,
  );
}

async function chmodIfExists(targetPath: string, mode: number): Promise<void> {
  try {
    await chmod(targetPath, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw error;
  }
}

async function tightenTree(rootPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw error;
  }

  await chmodIfExists(rootPath, STATE_DIR_MODE);
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await tightenTree(entryPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    await chmodIfExists(entryPath, STATE_FILE_MODE);
  }
}

/**
 * Best-effort, idempotent permission repair for one subtree (dirs 0700, files
 * 0600). Used for directories whose contents are written by helper processes
 * with their own umask (cloud ASR job dirs). Never throws.
 */
export async function ensureStateTreePermissions(rootPath: string): Promise<void> {
  try {
    await tightenTree(rootPath);
  } catch (error) {
    warnOnce(rootPath, error);
  }
}

/**
 * Best-effort, idempotent permission repair for one state directory:
 * the directory itself becomes 0700, known credential/state files and every
 * log file become 0600, and sensitive subtrees (asr-jobs) are walked. Never
 * throws — a read-only or foreign-owned state dir must not take the bot down.
 */
export async function ensureStateDirPermissions(stateDir: string): Promise<void> {
  try {
    const stats = await stat(stateDir).catch(() => null);
    if (!stats?.isDirectory()) {
      return;
    }

    await chmodIfExists(stateDir, STATE_DIR_MODE);

    for (const relativePath of SENSITIVE_STATE_FILES) {
      await chmodIfExists(path.join(stateDir, relativePath), STATE_FILE_MODE);
    }

    // `shared.env` (shared engine credentials) lives in the parent `~/.cctb/`.
    await chmodIfExists(path.join(path.dirname(stateDir), "shared.env"), STATE_FILE_MODE);

    const entries = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) {
        continue;
      }
      await chmodIfExists(path.join(stateDir, entry.name), STATE_FILE_MODE);
    }

    for (const treeName of SENSITIVE_STATE_TREES) {
      await tightenTree(path.join(stateDir, treeName));
    }
  } catch (error) {
    warnOnce(stateDir, error);
  }
}
