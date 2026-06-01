import { describe, expect, it } from "vitest";

import { formatInCronTimezone } from "../src/state/cron-timezone.js";

describe("formatInCronTimezone", () => {
  it("renders a UTC instant as local wall-clock in the job timezone, never raw UTC", () => {
    // The operator's bug: a reminder stored as 2026-06-01T05:00:00Z showed as raw UTC
    // (8h off) instead of 13:00 Beijing. It must read as the local wall-clock.
    const out = formatInCronTimezone("2026-06-01T05:00:00.000Z", "Asia/Shanghai");
    expect(out).toBe("2026-06-01 13:00 (Asia/Shanghai)");
    expect(out).not.toContain("Z");
    expect(out).not.toContain("05:00");
  });

  it("honors other timezones", () => {
    // EDT (UTC-4) in June.
    expect(formatInCronTimezone("2026-06-01T05:00:00.000Z", "America/New_York"))
      .toBe("2026-06-01 01:00 (America/New_York)");
    expect(formatInCronTimezone("2026-06-01T05:00:00.000Z", "UTC"))
      .toBe("2026-06-01 05:00 (UTC)");
  });

  it("falls back to a valid default timezone when none is given", () => {
    expect(formatInCronTimezone("2026-06-01T05:00:00.000Z"))
      .toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)$/);
  });

  it("returns the raw value for an unparseable date instead of throwing", () => {
    expect(formatInCronTimezone("not-a-date", "Asia/Shanghai")).toBe("not-a-date");
  });
});
