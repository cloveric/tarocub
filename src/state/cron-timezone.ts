const FALLBACK_CRON_TIMEZONE = "UTC";

export function normalizeCronTimezone(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timezone = value.trim();
  if (!timezone) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return undefined;
  }
}

export function resolveDefaultCronTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeCronTimezone(env.CCTB_TIMEZONE) ??
    normalizeCronTimezone(env.TZ) ??
    normalizeCronTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    FALLBACK_CRON_TIMEZONE;
}
