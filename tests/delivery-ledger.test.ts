import { describe, expect, it } from "vitest";

import { TurnDeliveryLedger } from "../src/telegram/delivery-ledger.js";

describe("TurnDeliveryLedger", () => {
  it("deduplicates accepted receipts by real path and rejected receipts by source/path/reason", () => {
    const ledger = new TurnDeliveryLedger();

    ledger.recordAccepted({
      path: "/tmp/link-a.txt",
      realPath: "/tmp/real.txt",
      fileName: "link-a.txt",
      bytes: 1,
      source: "stream-event",
    });
    ledger.recordAccepted({
      path: "/tmp/link-b.txt",
      realPath: "/tmp/real.txt",
      fileName: "link-b.txt",
      bytes: 2,
      source: "post-turn",
    });
    ledger.recordRejected({
      path: "/tmp/missing.txt",
      reason: "not-found",
      source: "stream-event",
    });
    ledger.recordRejected({
      path: "/tmp/missing.txt",
      reason: "not-found",
      source: "stream-event",
    });

    expect(ledger.accepted()).toEqual([
      expect.objectContaining({
        path: "/tmp/link-b.txt",
        realPath: "/tmp/real.txt",
        source: "post-turn",
      }),
    ]);
    expect(ledger.acceptedPaths()).toEqual(["/tmp/real.txt"]);
    expect(ledger.rejected()).toEqual([
      expect.objectContaining({
        path: "/tmp/missing.txt",
        reason: "not-found",
        source: "stream-event",
      }),
    ]);
  });
});
