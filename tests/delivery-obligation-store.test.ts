import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DELIVERY_MAX_ATTEMPTS,
  computeObligationId,
  deliveryLedgerEnabled,
  markDeliveryAttempting,
  markDeliveryDelivered,
  markDeliveryFailed,
  readDeliveryObligations,
  recordDeliveryObligation,
  resolveDeliveryObligationsPath,
  sweepRecoverableDeliveries,
  type DeliveryObligationRecord,
} from "../src/state/delivery-obligation-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

// A pid that is certainly dead: pid 1 is launchd/init (alive but EPERM →
// treated alive), so synthesize a dead one by spawning nothing — very large
// pids beyond pid_max are never alive.
const DEAD_PID = 999_999_99;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cctb-ledger-"));
}

async function writeRow(stateDir: string, row: Partial<DeliveryObligationRecord> & { id: string }): Promise<void> {
  const filePath = resolveDeliveryObligationsPath(stateDir);
  const existing = await readDeliveryObligations(stateDir);
  const full: DeliveryObligationRecord = {
    channel: "lark",
    chatId: "oc_chat",
    content: "answer",
    state: "attempting",
    attempts: 0,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ownerPid: DEAD_PID,
    ...row,
  };
  await writeFile(filePath, JSON.stringify({ obligations: [...existing.filter((r) => r.id !== row.id), full] }), "utf8");
}

describe("delivery obligation store", () => {
  it("walks the happy lifecycle pending → attempting → delivered", async () => {
    const stateDir = await tempDir();
    try {
      const id = await recordDeliveryObligation(stateDir, {
        channel: "lark", chatId: "oc_chat", conversationKey: "lark:oc_chat", replyTo: "om_1", content: "final answer",
      });
      expect(id).toBeTruthy();
      await markDeliveryAttempting(stateDir, id!);
      await markDeliveryDelivered(stateDir, id!);
      const rows = await readDeliveryObligations(stateDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("delivered");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("re-recording the same turn+content is idempotent (same id, one row)", async () => {
    const stateDir = await tempDir();
    try {
      const a = await recordDeliveryObligation(stateDir, { channel: "lark", chatId: "oc", conversationKey: "k", replyTo: "m", content: "text" });
      const b = await recordDeliveryObligation(stateDir, { channel: "lark", chatId: "oc", conversationKey: "k", replyTo: "m", content: "text" });
      expect(a).toBe(b);
      expect(await readDeliveryObligations(stateDir)).toHaveLength(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("declines oversize content instead of bloating the state file", async () => {
    const stateDir = await tempDir();
    try {
      const id = await recordDeliveryObligation(stateDir, {
        channel: "lark", chatId: "oc", content: "x".repeat(250_000),
      });
      expect(id).toBeNull();
      expect(await readDeliveryObligations(stateDir)).toHaveLength(0);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("sweep claims dead-owner rows; pending redelivers plainly, attempting/failed carry the marker", async () => {
    const stateDir = await tempDir();
    try {
      await writeRow(stateDir, { id: "aaa", state: "pending" });
      await writeRow(stateDir, { id: "bbb", state: "attempting" });
      await writeRow(stateDir, { id: "ccc", state: "failed" });
      await writeRow(stateDir, { id: "ddd", state: "delivered" });
      const claimed = await sweepRecoverableDeliveries(stateDir);
      const byId = new Map(claimed.map((row) => [row.id, row]));
      expect(byId.size).toBe(3);
      expect(byId.get("aaa")!.needsMarker).toBe(false);
      expect(byId.get("bbb")!.needsMarker).toBe(true);
      expect(byId.get("ccc")!.needsMarker).toBe(true);
      expect(byId.get("aaa")!.attempts).toBe(1);
      // Claimed rows are re-stamped to this process.
      const rows = await readDeliveryObligations(stateDir);
      expect(rows.find((r) => r.id === "aaa")!.ownerPid).toBe(process.pid);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("never claims a row owned by a live process (a running service still owns it)", async () => {
    const stateDir = await tempDir();
    try {
      // Use pid 1 (launchd): alive forever, not our pid.
      await writeRow(stateDir, { id: "live", state: "attempting", ownerPid: 1 });
      expect(await sweepRecoverableDeliveries(stateDir)).toHaveLength(0);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("abandons rows over the attempts cap and rows older than the stale cutoff", async () => {
    const stateDir = await tempDir();
    try {
      await writeRow(stateDir, { id: "poison", state: "failed", attempts: DELIVERY_MAX_ATTEMPTS });
      await writeRow(stateDir, { id: "ancient", state: "pending", createdAt: Date.now() - 25 * 60 * 60_000 });
      const claimed = await sweepRecoverableDeliveries(stateDir);
      expect(claimed).toHaveLength(0);
      const rows = await readDeliveryObligations(stateDir);
      expect(rows.find((r) => r.id === "poison")!.state).toBe("abandoned");
      expect(rows.find((r) => r.id === "ancient")!.state).toBe("abandoned");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("survives a corrupt state file (best-effort, never throws)", async () => {
    const stateDir = await tempDir();
    try {
      await writeFile(resolveDeliveryObligationsPath(stateDir), "{not json", "utf8");
      expect(await sweepRecoverableDeliveries(stateDir)).toHaveLength(0);
      const id = await recordDeliveryObligation(stateDir, { channel: "lark", chatId: "oc", content: "recovers" });
      expect(id).toBeTruthy();
      const raw = await readFile(resolveDeliveryObligationsPath(stateDir), "utf8");
      expect(JSON.parse(raw).obligations).toHaveLength(1);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("markDeliveryFailed truncates the error and keeps the row for the next boot", async () => {
    const stateDir = await tempDir();
    try {
      const id = await recordDeliveryObligation(stateDir, { channel: "lark", chatId: "oc", content: "text" });
      await markDeliveryFailed(stateDir, id!, "boom ".repeat(500));
      const row = (await readDeliveryObligations(stateDir))[0]!;
      expect(row.state).toBe("failed");
      expect(row.lastError!.length).toBeLessThanOrEqual(500);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("computeObligationId separates threads and turns on the same chat", () => {
    expect(computeObligationId("lark:c1", "m1", "t")).not.toBe(computeObligationId("lark:c1", "m2", "t"));
    expect(computeObligationId("lark:c1:topic:x", "m1", "t")).not.toBe(computeObligationId("lark:c1", "m1", "t"));
  });

  it("deliveryLedgerEnabled honors the env kill-switch", () => {
    expect(deliveryLedgerEnabled({})).toBe(true);
    expect(deliveryLedgerEnabled({ CCTB_DELIVERY_LEDGER: "off" })).toBe(false);
    expect(deliveryLedgerEnabled({ CCTB_DELIVERY_LEDGER: "0" })).toBe(false);
    expect(deliveryLedgerEnabled({ CCTB_DELIVERY_LEDGER: "on" })).toBe(true);
  });
});
