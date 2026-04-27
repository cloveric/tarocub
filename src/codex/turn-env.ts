const ALLOWED_TURN_EXTRA_ENV_KEYS = new Set([
  "CCTB_SEND_URL",
  "CCTB_SEND_TOKEN",
  "CCTB_SEND_COMMAND",
  "PATH",
]);

export function mergeAllowedTurnExtraEnv(
  childEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  if (!extraEnv) {
    return childEnv;
  }

  const merged: NodeJS.ProcessEnv = { ...childEnv };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (ALLOWED_TURN_EXTRA_ENV_KEYS.has(key)) {
      merged[key] = value;
    }
  }
  return merged;
}
