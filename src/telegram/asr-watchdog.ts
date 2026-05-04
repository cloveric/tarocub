import { spawn } from "node:child_process";

export interface AsrWatchdog {
  recordSuccess(): void;
  recordFailure(error?: unknown): Promise<void>;
}

export interface AsrWatchdogOptions {
  serviceCommand?: string;
  restartAfterFailures?: number;
  restartCooldownMs?: number;
  now?: () => number;
  spawnService?: (command: string) => void | Promise<void>;
  logger?: Pick<Console, "warn">;
}

const DEFAULT_RESTART_AFTER_FAILURES = 2;
const DEFAULT_RESTART_COOLDOWN_MS = 60_000;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function buildAsrServiceShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: { ComSpec?: string } = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", command],
  };
}

function defaultSpawnService(command: string): void {
  const invocation = buildAsrServiceShellInvocation(command);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: "ignore",
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  child.unref();
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

export function createAsrWatchdog(options: AsrWatchdogOptions = {}): AsrWatchdog {
  const serviceCommand = options.serviceCommand?.trim();
  const restartAfterFailures = Math.max(1, options.restartAfterFailures ?? DEFAULT_RESTART_AFTER_FAILURES);
  const restartCooldownMs = Math.max(0, options.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS);
  const now = options.now ?? (() => Date.now());
  const spawnService = options.spawnService ?? defaultSpawnService;
  const logger = options.logger ?? console;

  let consecutiveFailures = 0;
  let lastRestartAt = Number.NEGATIVE_INFINITY;
  let restartInFlight: Promise<void> | null = null;

  async function restart(error: unknown): Promise<void> {
    if (!serviceCommand) {
      return;
    }

    const currentTime = now();
    if (currentTime - lastRestartAt < restartCooldownMs) {
      return;
    }

    if (restartInFlight) {
      await restartInFlight;
      return;
    }

    lastRestartAt = currentTime;
    consecutiveFailures = 0;
    logger.warn(`ASR watchdog starting repair command after failure: ${summarizeError(error)}`);

    restartInFlight = (async () => {
      await spawnService(serviceCommand);
    })()
      .catch((spawnError) => {
        logger.warn(`ASR watchdog repair command failed to start: ${summarizeError(spawnError)}`);
      })
      .finally(() => {
        restartInFlight = null;
      });

    await restartInFlight;
  }

  return {
    recordSuccess(): void {
      consecutiveFailures = 0;
    },
    async recordFailure(error?: unknown): Promise<void> {
      consecutiveFailures += 1;
      if (consecutiveFailures < restartAfterFailures) {
        return;
      }

      await restart(error);
    },
  };
}

export function createAsrWatchdogFromEnv(env: NodeJS.ProcessEnv = process.env): AsrWatchdog {
  return createAsrWatchdog({
    serviceCommand: env.ASR_SERVICE_COMMAND,
    restartAfterFailures: parsePositiveInteger(env.ASR_RESTART_AFTER_FAILURES, DEFAULT_RESTART_AFTER_FAILURES),
    restartCooldownMs: parsePositiveInteger(env.ASR_RESTART_COOLDOWN_MS, DEFAULT_RESTART_COOLDOWN_MS),
  });
}
