import os from "node:os";

const UNIX_SOCKET_SAFE_TMPDIR_LENGTH = 80;

export function childProcessTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = env.TMPDIR || env.TEMP || env.TMP || os.tmpdir();
  const tempDir = process.platform !== "win32" && current.length > UNIX_SOCKET_SAFE_TMPDIR_LENGTH
    ? "/tmp"
    : current;
  return {
    ...env,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };
}
