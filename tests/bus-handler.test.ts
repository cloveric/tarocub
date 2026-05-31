import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { createBusTalkHandler } from "../src/bus/bus-handler.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import { BUS_PROTOCOL_CAPABILITIES, BUS_PROTOCOL_VERSION } from "../src/bus/bus-protocol.js";

describe("createBusTalkHandler", () => {
  it("records usage for successful bus turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bus-handler-"));
    await mkdir(root, { recursive: true });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "done",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cachedTokens: 2,
          costUsd: 0.33,
        },
      }),
    };

    try {
      const handler = createBusTalkHandler({
        bridge: bridge as never,
        stateDir: root,
        instanceName: "worker",
      });

      const result = await handler({
        fromInstance: "caller",
        prompt: "hello",
        depth: 0,
      });

      expect(result).toMatchObject({
        success: true,
        text: "done",
        fromInstance: "worker",
        protocolVersion: BUS_PROTOCOL_VERSION,
        capabilities: BUS_PROTOCOL_CAPABILITIES,
      });
      const usage = JSON.parse(await readFile(path.join(root, "usage.json"), "utf8"));
      expect(usage).toMatchObject({
        requestCount: 1,
        totalInputTokens: 11,
        totalOutputTokens: 7,
        totalCachedTokens: 2,
        totalCostUsd: 0.33,
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("appends a success audit event for bus turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bus-handler-"));
    await mkdir(root, { recursive: true });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "done",
      }),
    };

    try {
      const handler = createBusTalkHandler({
        bridge: bridge as never,
        stateDir: root,
        instanceName: "worker",
      });

      await handler({
        fromInstance: "caller",
        prompt: "hello",
        depth: 2,
      });

      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "bus.handle",
        instanceName: "worker",
        outcome: "success",
        metadata: expect.objectContaining({
          fromInstance: "caller",
          depth: 2,
          responseChars: 4,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("blocks bus turns when the budget is already exhausted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bus-handler-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ budgetUsd: 0.5 }),
      "utf8",
    );
    await writeFile(
      path.join(root, "usage.json"),
      JSON.stringify({
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCachedTokens: 0,
        totalCostUsd: 0.75,
        requestCount: 2,
        lastUpdatedAt: "2026-04-17T00:00:00.000Z",
      }),
      "utf8",
    );
    const bridge = {
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      const handler = createBusTalkHandler({
        bridge: bridge as never,
        stateDir: root,
        instanceName: "worker",
      });

      const result = await handler({
        fromInstance: "caller",
        prompt: "hello",
        depth: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Budget exhausted/);
      expect(result.errorCode).toBe("budget_exhausted");
      expect(result.retryable).toBe(false);
      expect(result.protocolVersion).toBe(BUS_PROTOCOL_VERSION);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "bus.reply",
        instanceName: "worker",
        outcome: "reply",
        detail: "budget exhausted",
        metadata: expect.objectContaining({
          fromInstance: "caller",
          depth: 0,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not cap concurrent bus turns by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bus-handler-"));
    await mkdir(root, { recursive: true });

    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            releases.push(() => {
              active -= 1;
              resolve({ text: "done" });
            });
          }),
      ),
    };

    try {
      const handler = createBusTalkHandler({
        bridge: bridge as never,
        stateDir: root,
        instanceName: "worker",
      });

      const total = 6;
      const inflight = Array.from({ length: total }, (_, i) =>
        handler({ fromInstance: "caller", prompt: `m${i}`, depth: 0 }),
      );

      // Bus is a local trusted control plane. By default it should not impose a
      // hidden process-wide cap; operators who want a global cap can use the
      // explicit TAROCUB_MAX_CONCURRENT_TURNS worker pool.
      const deadline = Date.now() + 8000;
      while (releases.length < total && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(releases.length).toBe(total);

      // Drain exactly `total` turns: releasing one frees a slot, which admits a
      // queued turn that then pushes its own release. Wait when none are pending
      // so we never exit early and leave a turn unresolved.
      let released = 0;
      while (released < total) {
        const release = releases.shift();
        if (release) {
          release();
          released += 1;
        } else {
          await new Promise((r) => setTimeout(r, 5));
        }
      }

      const results = await Promise.all(inflight);
      expect(results.every((r) => r.success)).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(total);
      expect(maxActive).toBe(total);
    } finally {
      await removeTempRoot(root);
    }
  }, 20000);

  it("appends an error audit event when the bus turn fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bus-handler-"));
    await mkdir(root, { recursive: true });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("unauthorized")),
    };

    try {
      const handler = createBusTalkHandler({
        bridge: bridge as never,
        stateDir: root,
        instanceName: "worker",
      });

      const result = await handler({
        fromInstance: "caller",
        prompt: "hello",
        depth: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("unauthorized");
      expect(result.errorCode).toBe("auth");
      expect(result.retryable).toBe(false);
      const events = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "bus.handle",
        instanceName: "worker",
        outcome: "error",
        detail: "unauthorized",
        metadata: expect.objectContaining({
          fromInstance: "caller",
          depth: 1,
          failureCategory: "auth",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });
});
