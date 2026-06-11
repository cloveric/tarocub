import { execFile } from "node:child_process";

import { killProcessTree } from "../codex/process-tree.js";

/**
 * Inventory of the instance's own process group. Engine workers, their tool
 * shells, and anything a turn left running in the background all share the
 * service's process group (verified live: a leaked research turn's ugrep
 * storm sat in the service pgid even after its worker re-parented to pid 1).
 * That makes the pgid a safe, instance-scoped boundary for listing and
 * killing bot-started background work without ever touching foreign
 * processes.
 */
export interface InstanceGroupProcess {
  pid: number;
  ppid: number;
  rssMb: number;
  etime: string;
  command: string;
  /**
   * engine — a direct child of the service (a live engine worker);
   * child  — reachable from the service through live parents (worker tools);
   * orphan — in the group but no live ancestry to the service (its worker
   *          died; this is the leak class /bg killall removes).
   */
  role: "engine" | "child" | "orphan";
}

// Full `command=` output on a busy host is large (verified live: ~27MB of
// argv across all processes), so the buffer must be generous — at 8MB execFile
// rejects with ENOBUFS and /bg silently dies. `command=` is kept (not the short
// `comm=`) because the search args are exactly what makes a leaked turn's worker
// recognizable in the listing; only the total size, not the line shape, was the bug.
const PS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-eo", "pid=,pgid=,ppid=,rss=,etime=,command="], { maxBuffer: PS_MAX_BUFFER_BYTES }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Exported for tests: the ps output buffer bound. */
export { PS_MAX_BUFFER_BYTES };

/**
 * Convert `ps` etime (`[[DD-]HH:]MM:SS` or `MM:SS`) to seconds. Returns null for
 * an unparseable value so callers can decline to compare rather than guess.
 */
export function parseEtimeSeconds(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) {
    return null;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export function parseInstanceProcessGroup(psOutput: string, servicePid: number): InstanceGroupProcess[] {
  interface Row { pid: number; pgid: number; ppid: number; rssKb: number; etime: string; command: string }
  const rows: Row[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      ppid: Number(match[3]),
      rssKb: Number(match[4]),
      etime: match[5],
      command: match[6].trim(),
    });
  }

  const serviceRow = rows.find((row) => row.pid === servicePid);
  if (!serviceRow) {
    return [];
  }
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));

  // The service's own ancestor chain (npm/sh/node wrappers that launched it).
  // In a foreground/dev launch these share the service's pgid, so without this
  // they'd be mislabeled "orphan" and a /bg killall would take down the service's
  // own parent. Walk upward across ALL rows (not just the group) and exclude them.
  const serviceAncestors = new Set<number>();
  let cursor: Row | undefined = rowsByPid.get(serviceRow.ppid);
  for (let hops = 0; cursor && hops <= 64 && !serviceAncestors.has(cursor.pid); hops += 1) {
    serviceAncestors.add(cursor.pid);
    cursor = rowsByPid.get(cursor.ppid);
  }

  // Anything that has been alive LONGER than the service cannot be background
  // work this service instance started — it predates us. Used to keep an older
  // wrapper/sibling in the same pgid out of the orphan (kill) class.
  const serviceEtimeSeconds = parseEtimeSeconds(serviceRow.etime);

  const group = rows.filter((row) => row.pgid === serviceRow.pgid && row.pid !== servicePid);
  const groupByPid = new Map(group.map((row) => [row.pid, row]));

  const reachesService = (row: Row, hops = 0): boolean => {
    if (row.ppid === servicePid) {
      return true;
    }
    if (hops > 32) {
      return false;
    }
    const parent = groupByPid.get(row.ppid);
    return parent ? reachesService(parent, hops + 1) : false;
  };

  const classify = (row: Row): "engine" | "child" | "orphan" => {
    if (row.ppid === servicePid) {
      return "engine";
    }
    if (reachesService(row)) {
      return "child";
    }
    // Guard the orphan class: never sweep the service's own ancestor chain, nor a
    // process that predates the service (parseEtimeSeconds === null → can't prove
    // it's older, so don't shield it). These would be wrappers/siblings, not the
    // leaked-background-work the orphan class is meant to capture.
    const rowEtimeSeconds = parseEtimeSeconds(row.etime);
    const olderThanService = serviceEtimeSeconds !== null
      && rowEtimeSeconds !== null
      && rowEtimeSeconds > serviceEtimeSeconds;
    if (serviceAncestors.has(row.pid) || olderThanService) {
      return "child";
    }
    return "orphan";
  };

  return group.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    rssMb: Math.round(row.rssKb / 1024),
    etime: row.etime,
    command: row.command.length > 120 ? `${row.command.slice(0, 117)}...` : row.command,
    role: classify(row),
  })).sort((a, b) => b.rssMb - a.rssMb);
}

/** null = unsupported platform (Windows). */
export async function listInstanceProcessGroup(): Promise<InstanceGroupProcess[] | null> {
  if (process.platform === "win32") {
    return null;
  }
  const psOutput = await runPs();
  return parseInstanceProcessGroup(psOutput, process.pid);
}

/**
 * Kill one process (and its subtree) from the instance's own group. The pid
 * is re-verified against a fresh inventory at kill time so a stale or
 * mistyped pid can never hit an unrelated process, and the service itself is
 * never a valid target.
 */
export async function killInstanceGroupProcess(pid: number): Promise<{ killed: boolean; reason: "ok" | "not-in-group" | "is-service" | "unsupported" }> {
  if (process.platform === "win32") {
    return { killed: false, reason: "unsupported" };
  }
  if (pid === process.pid) {
    return { killed: false, reason: "is-service" };
  }
  const group = await listInstanceProcessGroup();
  if (!group?.some((row) => row.pid === pid)) {
    return { killed: false, reason: "not-in-group" };
  }
  killProcessTree(pid);
  return { killed: true, reason: "ok" };
}

/** Kill every orphan in the group (the leaked-background-work class). */
export async function killInstanceGroupOrphans(): Promise<{ killedPids: number[]; unsupported: boolean }> {
  if (process.platform === "win32") {
    return { killedPids: [], unsupported: true };
  }
  const group = await listInstanceProcessGroup();
  const orphans = (group ?? []).filter((row) => row.role === "orphan");
  for (const orphan of orphans) {
    killProcessTree(orphan.pid);
  }
  return { killedPids: orphans.map((row) => row.pid), unsupported: false };
}
