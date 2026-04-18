import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
    }
  });

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
      await rm(root, { recursive: true, force: true });
    }
  });
});
