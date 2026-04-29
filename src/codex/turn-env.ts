const ALLOWED_TURN_EXTRA_ENV_KEYS = new Set([
  "CCTB_SEND_URL",
  "CCTB_SEND_TOKEN",
  "CCTB_SEND_COMMAND",
  "PATH",
]);

const DEPRECATED_TURN_EXTRA_ENV_KEYS = [
  "CCTB_CRON_URL",
  "CCTB_CRON_TOKEN",
] as const;

export function mergeAllowedTurnExtraEnv(
  childEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...childEnv };
  for (const key of DEPRECATED_TURN_EXTRA_ENV_KEYS) {
    delete merged[key];
  }

  if (!extraEnv) {
    return merged;
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    if (ALLOWED_TURN_EXTRA_ENV_KEYS.has(key)) {
      merged[key] = value;
    }
  }
  return merged;
}
