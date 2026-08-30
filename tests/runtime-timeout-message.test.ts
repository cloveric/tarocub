import { describe, expect, it } from "vitest";

import { renderRuntimeTimeoutMessage } from "../src/runtime/runtime-timeout-message.js";

describe("renderRuntimeTimeoutMessage Antigravity policy", () => {
  it("reports the aligned six-hour active cap", () => {
    expect(renderRuntimeTimeoutMessage("antigravity", true, "status", "en")).toContain(
      "6-hour hard cap and 30-minute inactivity watchdog",
    );
  });

  it("discloses agy's native seven-day ceiling when bridge watchdogs are disabled", () => {
    expect(renderRuntimeTimeoutMessage("antigravity", false, "off", "en")).toContain(
      "agy's 7-day native safety ceiling remains",
    );
    expect(renderRuntimeTimeoutMessage("antigravity", false, "status", "zh")).toContain(
      "agy 仍保留 7 天原生安全上限",
    );
  });
});
