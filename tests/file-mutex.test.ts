import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withFileMutex } from "../src/state/file-mutex.js";
import { childProcessTestEnv, removeTempRoot } from "./helpers/temp-files.js";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcImportUrl = (rel: string): string => pathToFileURL(path.join(repoRoot, rel)).href;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawns a short-lived child and waits for it to exit, yielding a known-dead pid. */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn child for dead pid");
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

async function seedLock(lockPath: string, owner: Record<string, unknown>): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8");
}

function runMutexSubprocess(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, scriptPath, ...args], {
      cwd: repoRoot,
      env: childProcessTestEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mutex subprocess exited with ${code}: ${stderr}`));
      }
    });
  });
}

describe("withFileMutex stale-lock recovery", () => {
  it("keeps mutual exclusion when two processes race to recover the same stale lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    const logPath = path.join(dir, "sections.log");
    const scriptPath = path.join(dir, "hold-mutex.ts");
    try {
      const deadPid = await spawnDeadPid();
      await seedLock(`${targetPath}.lock`, {
        pid: deadPid,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        token: "stale-owner-token",
        host: os.hostname(),
      });

      await writeFile(scriptPath, [
        `import { withFileMutex } from '${srcImportUrl("src/state/file-mutex.ts")}';`,
        "import { appendFile } from 'node:fs/promises';",
        "(async () => {",
        "  const [target, log, label] = process.argv.slice(2);",
        "  await withFileMutex(target, async () => {",
        "    await appendFile(log, `start ${label}\\n`);",
        "    await new Promise((resolve) => setTimeout(resolve, 300));",
        "    await appendFile(log, `end ${label}\\n`);",
        "  }, { staleLockMs: 100 });",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      await Promise.all([
        runMutexSubprocess(scriptPath, [targetPath, logPath, "a"]),
        runMutexSubprocess(scriptPath, [targetPath, logPath, "b"]),
      ]);

      const events = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(events).toHaveLength(4);
      // Critical sections must never overlap: strict start/end alternation.
      expect(events[0]).toMatch(/^start /);
      expect(events[1]).toMatch(/^end /);
      expect(events[2]).toMatch(/^start /);
      expect(events[3]).toMatch(/^end /);
      expect(events[0]?.slice(6)).toBe(events[1]?.slice(4));
      expect(events[2]?.slice(6)).toBe(events[3]?.slice(4));
    } finally {
      await removeTempRoot(dir);
    }
  }, 60_000);

  it("does not steal a verifiably-alive owner's lock at the basic stale bound", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    const lockPath = `${targetPath}.lock`;
    try {
      // Live owner (this very process), older than staleLockMs but far younger than
      // the live-owner bound (staleLockMs * 20 = 2s).
      await seedLock(lockPath, {
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 500).toISOString(),
        token: "live-owner-token",
        host: os.hostname(),
      });

      let entered = false;
      const run = withFileMutex(targetPath, async () => {
        entered = true;
      }, { staleLockMs: 100 });

      await sleep(600);
      expect(entered).toBe(false);

      // Owner releases; the waiter must then proceed.
      await rm(lockPath, { recursive: true, force: true });
      await run;
      expect(entered).toBe(true);
    } finally {
      await removeTempRoot(dir);
    }
  }, 20_000);

  it("recovers a dead owner's lock promptly regardless of age", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    try {
      const deadPid = await spawnDeadPid();
      await seedLock(`${targetPath}.lock`, {
        pid: deadPid,
        acquiredAt: new Date().toISOString(),
        token: "dead-owner-token",
        host: os.hostname(),
      });

      let entered = false;
      await withFileMutex(targetPath, async () => {
        entered = true;
      }, { staleLockMs: 5_000 });
      expect(entered).toBe(true);
    } finally {
      await removeTempRoot(dir);
    }
  }, 20_000);

  it("retries (never throws) when a concurrent recoverer renames the winner's fresh lock dir away", async () => {
    // The audit race: the acquire loop mkdir's the lock dir, then — before its
    // writeFile(owner.json) lands — a concurrent stale-lock recoverer renames the
    // brand-new (still owner-less) dir to trash, judging it abandoned. writeFile
    // then throws ENOENT. The fix treats that ENOENT like EEXIST and re-enters the
    // loop; without it the winner's whole store write crashes.
    //
    // Reproduce faithfully with several real processes hammering the SAME lock at a
    // staleLockMs of 0: an owner-less fresh dir is then ALWAYS judged stale (age > 0),
    // so a peer renames it away in the mkdir→writeFile window. With the fix every
    // worker finishes its acquisitions; without it a worker exits non-zero on ENOENT.
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    const scriptPath = path.join(dir, "hammer-mutex.ts");
    try {
      await writeFile(scriptPath, [
        `import { withFileMutex } from '${srcImportUrl("src/state/file-mutex.ts")}';`,
        "(async () => {",
        "  const [target, iters] = process.argv.slice(2);",
        "  for (let i = 0; i < Number(iters); i += 1) {",
        // staleLockMs 0 makes a fresh, owner-less dir instantly recoverable, so
        // concurrent workers rename each other's just-mkdir'd dirs away.
        "    await withFileMutex(target, async () => {}, { staleLockMs: 0 });",
        "  }",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      // Six workers × 60 acquisitions: the ENOENT-in-acquire window is hit many
      // times over. Any unhandled rethrow exits a worker non-zero → rejects here.
      await Promise.all(
        Array.from({ length: 6 }, () => runMutexSubprocess(scriptPath, [targetPath, "60"])),
      );
    } finally {
      // The assertion (every worker exits 0) is already satisfied here. The
      // staleLockMs:0 rename-to-trash churn can leave a transient lock/trash dir
      // that races rm's recursive walk (ENOTEMPTY); it's incidental /tmp garbage,
      // never the thing under test, so don't let cleanup fail the run.
      await removeTempRoot(dir).catch(() => undefined);
    }
  }, 60_000);

  it("age-steals an unverifiable (other-host) owner at the basic stale bound", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    try {
      await seedLock(`${targetPath}.lock`, {
        pid: process.pid, // alive locally, but the record claims another host
        acquiredAt: new Date(Date.now() - 1_000).toISOString(),
        token: "other-host-token",
        host: "some-other-host.invalid",
      });

      let entered = false;
      await withFileMutex(targetPath, async () => {
        entered = true;
      }, { staleLockMs: 100 });
      expect(entered).toBe(true);
    } finally {
      await removeTempRoot(dir);
    }
  }, 20_000);
});
