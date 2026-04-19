import { execFile } from "node:child_process";

type ExecFileFn = typeof execFile;
type KillFn = (pid: number, signal?: NodeJS.Signals | number) => void;
type ReadProcessIdentityFn = (pid: number, callback: (identity: string | null) => void) => void;

function readUnixProcessIdentity(execFileFn: ExecFileFn, pid: number, callback: (identity: string | null) => void): void {
  execFileFn("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
    if (error) {
      callback(null);
      return;
    }

    const identity = stdout.trim();
    callback(identity ? identity : null);
  });
}

export function killProcessTree(
  pid: number | undefined,
  input?: {
    execFileFn?: ExecFileFn;
    killFn?: KillFn;
    platform?: NodeJS.Platform;
    graceMs?: number;
    readIdentityFn?: ReadProcessIdentityFn;
  },
): void {
  if (!pid) {
    return;
  }

  const execFileFn = input?.execFileFn ?? execFile;
  const killFn = input?.killFn ?? ((targetPid: number, signal?: NodeJS.Signals | number) => process.kill(targetPid, signal));
  const platform = input?.platform ?? process.platform;
  const graceMs = input?.graceMs ?? 2_000;
  const readIdentityFn = input?.readIdentityFn ?? ((targetPid: number, callback: (identity: string | null) => void) => {
    readUnixProcessIdentity(execFileFn, targetPid, callback);
  });

  if (platform === "win32") {
    execFileFn("taskkill", ["/F", "/T", "/PID", String(pid)], () => {});
    return;
  }

  execFileFn("pgrep", ["-P", String(pid)], (_, stdout) => {
    if (stdout) {
      for (const childPid of stdout.trim().split(/\s+/)) {
        const parsed = Number(childPid);
        if (Number.isInteger(parsed) && parsed > 0) {
          killProcessTree(parsed, input);
        }
      }
    }

    try {
      killFn(pid, "SIGTERM");
    } catch {
      return;
    }

    readIdentityFn(pid, (initialIdentity) => {
      setTimeout(() => {
        if (!initialIdentity) {
          return;
        }

        readIdentityFn(pid, (currentIdentity) => {
          if (!currentIdentity || currentIdentity !== initialIdentity) {
            return;
          }

          try {
            killFn(pid, 0);
          } catch {
            return;
          }

          try {
            killFn(pid, "SIGKILL");
          } catch {
            // already gone
          }
        });
      }, graceMs);
    });
  });
}
