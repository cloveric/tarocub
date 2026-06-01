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

/**
 * Formats an ISO timestamp as wall-clock time in the given cron timezone, e.g.
 * "2026-06-01 13:00 (Asia/Shanghai)". Falls back to the default cron timezone
 * when none is given, and returns the raw value for an unparseable date. Used so
 * reminder confirmations and `/cron list` show local time, never raw UTC like
 * "2026-06-01T05:00:00.000Z" (which reads 8h off for a UTC+8 user).
 */
export function formatInCronTimezone(iso: string, timezone?: string): string {
  const tz = normalizeCronTimezone(timezone) ?? resolveDefaultCronTimezone();
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")} (${tz})`;
  } catch {
    return iso;
  }
}
