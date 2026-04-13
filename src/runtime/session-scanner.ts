import { readdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

function resolveHomeDir(): string {
  if (process.platform === "win32") {
    return process.env.USERPROFILE ?? process.env.HOME ?? "/";
  }
  return process.env.HOME ?? process.env.USERPROFILE ?? "/";
}

export interface ScannedSession {
  sessionId: string;
  dirName: string;
  workspacePath: string | null;
  modifiedAt: Date;
  displayName: string;
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decode a Claude project directory name back to the original workspace path.
 *
 * Claude encodes workspace paths by replacing `/` and `.` with `-`.
 * Decoding is ambiguous (e.g. `foo-bar` could be `foo/bar` or literal
 * `foo-bar`).  We prefer the **longest** dash-joined match at each step
 * so that project names containing dashes (e.g. `cc-telegram-bridge`) are
 * resolved correctly even when shorter sub-paths also exist on disk.
 */
export function tryDecodeWorkspacePath(dirName: string): string | null {
  if (!dirName.startsWith("-")) return null;

  const parts = dirName.slice(1).split("-");
  if (parts.length === 0) return null;

  let current = "";
  let i = 0;

  while (i < parts.length) {
    const segment = parts[i]!;

    if (segment === "" && i + 1 < parts.length) {
      // Double dash → original was a dot-prefixed name (e.g. .cctb, .foo-bar)
      // Try longest dash-joined match starting with dot prefix
      i++;
      let dotFound = false;
      for (let j = parts.length - 1; j >= i; j--) {
        const dotJoined = "." + parts.slice(i, j + 1).join("-");
        const candidate = current + "/" + dotJoined;
        if (isExistingDir(candidate)) {
          current = candidate;
          i = j + 1;
          dotFound = true;
          break;
        }
      }
      if (!dotFound) {
        // Fallback: take just the first segment with dot prefix
        current = current + "/." + parts[i]!;
        i++;
      }
      continue;
    }

    // Try longest dash-joined match first (e.g. "cc-telegram-bridge"),
    // then progressively shorter ones, then bare single segment.
    // This prevents "foo-bar" being split into "foo/bar" when a real
    // directory named "foo-bar" exists.
    let found = false;
    for (let j = parts.length - 1; j > i; j--) {
      const joined = parts.slice(i, j + 1).join("-");
      const candidate = current + "/" + joined;
      if (isExistingDir(candidate)) {
        current = candidate;
        i = j + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      // Single segment — accept as slash-separated path component
      current = current + "/" + segment;
      i++;
    }
  }

  return isExistingDir(current) ? current : null;
}

function extractDisplayName(dirName: string): string {
  const parts = dirName.slice(1).split("-").filter(Boolean);
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && projectsIdx < parts.length - 1) {
    return parts.slice(projectsIdx + 1).join("-");
  }
  return parts[parts.length - 1] ?? dirName;
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m ago`;
}

export function formatSessionList(sessions: ScannedSession[], locale: "en" | "zh"): string {
  if (sessions.length === 0) {
    return locale === "zh"
      ? "最近 1 小时内没有找到本地 session。"
      : "No local sessions found in the last hour.";
  }

  const header = locale === "zh" ? "最近的本地 session：" : "Recent local sessions:";
  const lines = sessions.map((s, i) => {
    const ago = formatTimeAgo(Date.now() - s.modifiedAt.getTime());
    const name = s.displayName;
    const idShort = s.sessionId.slice(0, 8);
    return `${i + 1}. [${name}] ${idShort}… (${ago})`;
  });
  const footer = locale === "zh"
    ? "\n回复 /resume <编号> 继续该 session。"
    : "\nReply /resume <number> to continue that session.";

  return [header, ...lines, footer].join("\n");
}

/**
 * Scan ~/.claude/projects/ for .jsonl session files modified within the given
 * time window.  Returns results sorted by modification time (newest first).
 */
export async function scanRecentClaudeSessions(hoursAgo: number = 1): Promise<ScannedSession[]> {
  const claudeHome = path.join(resolveHomeDir(), ".claude");
  const projectsDir = path.join(claudeHome, "projects");

  if (!existsSync(projectsDir)) {
    return [];
  }

  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const results: ScannedSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsDir, dirName);

    try {
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = path.join(dirPath, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) continue;

        const sessionId = file.slice(0, -6); // strip .jsonl
        const workspacePath = tryDecodeWorkspacePath(dirName);
        const displayName = extractDisplayName(dirName);

        results.push({ sessionId, dirName, workspacePath, modifiedAt: fileStat.mtime, displayName });
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return results;
}
