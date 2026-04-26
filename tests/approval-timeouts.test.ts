import { describe, expect, it } from "vitest";

import {
  APPROVAL_BRIDGE_FETCH_TIMEOUT_MS,
  TELEGRAM_APPROVAL_TIMEOUT_MS,
} from "../src/telegram/approval-timeouts.js";

describe("approval timeout boundaries", () => {
  it("lets Telegram approval expire before the MCP bridge fetch can time out", () => {
    expect(TELEGRAM_APPROVAL_TIMEOUT_MS).toBe(29 * 60 * 1000);
    expect(APPROVAL_BRIDGE_FETCH_TIMEOUT_MS).toBe(31 * 60 * 1000);
    expect(APPROVAL_BRIDGE_FETCH_TIMEOUT_MS).toBeGreaterThan(TELEGRAM_APPROVAL_TIMEOUT_MS);
  });
});
