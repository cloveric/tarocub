import path from "node:path";

import { acquireInstanceLock, resolveInstanceLockPath, type InstanceLockHandle } from "../state/instance-lock.js";

const LARK_SERVICE_LOCK_DIR = "lark-service";

export function resolveLarkServiceLockDir(stateDir: string): string {
  return path.join(stateDir, LARK_SERVICE_LOCK_DIR);
}

export function resolveLarkServiceLockPath(stateDir: string): string {
  return resolveInstanceLockPath(resolveLarkServiceLockDir(stateDir));
}

export async function acquireLarkServiceLock(stateDir: string): Promise<InstanceLockHandle> {
  try {
    return await acquireInstanceLock(resolveLarkServiceLockDir(stateDir));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Instance lock already held")) {
      throw new Error(error.message.replace("Instance lock", "Lark service lock"));
    }
    throw error;
  }
}
