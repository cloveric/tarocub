import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { redeliverRecoveredLarkObligations } from "../src/lark/delivery-recovery.js";
import {
  readDeliveryObligations,
  resolveDeliveryObligationsPath,
  type DeliveryObligationRecord,
} from "../src/state/delivery-obligation-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const DEAD_PID = 999_999_99;

async function seed(stateDir: string, rows: Array<Partial<DeliveryObligationRecord> & { id: string }>): Promise<void> {
  const full = rows.map((row) => ({
    channel: "lark" as const,
    chatId: "oc_chat",
    content: `content-${row.id}`,
    state: "attempting" as const,
    attempts: 0,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ownerPid: DEAD_PID,
    ...row,
  }));
  await writeFile(resolveDeliveryObligationsPath(stateDir), JSON.stringify({ obligations: full }), "utf8");
}

describe("redeliverRecoveredLarkObligations", () => {
  it("redelivers claimed rows: pending plainly, attempting with the ♻️ marker; marks delivered", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-recover-"));
    const sent: Array<{ to: string; markdown: string; opts: unknown }> = [];
    const channel = {
      send: vi.fn(async (to: string, input: unknown, opts?: unknown) => {
        sent.push({ to, markdown: (input as { markdown: string }).markdown, opts });
        return { messageId: "m" };
      }),
    };
    try {
      await seed(stateDir, [
        { id: "plain", state: "pending", replyTo: "om_orig", replyInThread: true },
        { id: "marked", state: "attempting" },
      ]);
      const result = await redeliverRecoveredLarkObligations({ channel, stateDir, locale: "zh" });
      expect(result).toEqual({ recovered: 2, failed: 0 });
      const plain = sent.find((entry) => entry.markdown.includes("content-plain"))!;
      const marked = sent.find((entry) => entry.markdown.includes("content-marked"))!;
      expect(plain.markdown).not.toContain("♻️");
      expect(plain.opts).toMatchObject({ replyTo: "om_orig", replyInThread: true });
      expect(marked.markdown).toContain("♻️");
      expect(marked.markdown).toContain("补发");
      const rows = await readDeliveryObligations(stateDir);
      expect(rows.every((row) => row.state === "delivered")).toBe(true);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("marks a failed redelivery failed (a later boot retries) and keeps going", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-recover-fail-"));
    const channel = {
      send: vi.fn(async (_to: string, input: unknown) => {
        if ((input as { markdown: string }).markdown.includes("content-bad")) {
          throw new Error("send exploded");
        }
        return { messageId: "m" };
      }),
    };
    try {
      await seed(stateDir, [
        { id: "bad", state: "pending", content: "content-bad" },
        { id: "good", state: "pending", content: "content-good" },
      ]);
      const result = await redeliverRecoveredLarkObligations({ channel, stateDir, locale: "en" });
      expect(result).toEqual({ recovered: 1, failed: 1 });
      const rows = await readDeliveryObligations(stateDir);
      expect(rows.find((row) => row.id === "bad")!.state).toBe("failed");
      expect(rows.find((row) => row.id === "good")!.state).toBe("delivered");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("does nothing when there is nothing to recover", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-recover-empty-"));
    const channel = { send: vi.fn() };
    try {
      const result = await redeliverRecoveredLarkObligations({ channel, stateDir, locale: "en" });
      expect(result).toEqual({ recovered: 0, failed: 0 });
      expect(channel.send).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
