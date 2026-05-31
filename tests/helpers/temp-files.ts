import { rm } from "node:fs/promises";
import os from "node:os";

const UNIX_SOCKET_SAFE_TMPDIR_LENGTH = 80;

export async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

export function resolveShortTempDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CCTB_TEST_TMPDIR?.trim();
  if (explicit) {
    return explicit;
  }

  const current = env.TMPDIR || env.TEMP || env.TMP || os.tmpdir();
  if (process.platform !== "win32" && current.length > UNIX_SOCKET_SAFE_TMPDIR_LENGTH) {
    return "/tmp";
  }

  return current;
}

export function childProcessTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const tempDir = resolveShortTempDir(env);
  return {
    ...env,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };
}
