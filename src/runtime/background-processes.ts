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

function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-eo", "pid=,pgid=,ppid=,rss=,etime=,command="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
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

  return group.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    rssMb: Math.round(row.rssKb / 1024),
    etime: row.etime,
    command: row.command.length > 120 ? `${row.command.slice(0, 117)}...` : row.command,
    role: row.ppid === servicePid ? "engine" as const : reachesService(row) ? "child" as const : "orphan" as const,
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
