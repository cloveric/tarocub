import { randomUUID } from "node:crypto";

import type { Bridge } from "../runtime/bridge.js";
import { appendAuditEventBestEffort } from "../runtime/audit-events.js";
import { classifyFailure, getBusErrorSemantics } from "../runtime/error-classification.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import {
  checkBudgetAvailability,
  loadBudgetUsd,
  recordBridgeTurnUsage,
} from "../runtime/bridge-turn.js";
import { createBusErrorResponse, createBusTalkResponseEnvelope } from "./bus-protocol.js";
import type { BusTalkHandler, BusTalkResponse } from "./bus-server.js";

export function createBusTalkHandler(input: {
  bridge: Bridge;
  stateDir: string;
  instanceName: string;
}): BusTalkHandler {
  // Process-local synthetic chat IDs for bus turns, used only for timeline/audit
  // labelling. They must NOT key a persisted session: a per-process counter would
  // reset to -1 on restart and resume an unrelated previous bus session (context
  // bleed) while accumulating stored sessions without bound. Each bus turn instead
  // runs on a fresh ephemeral session via sessionIdOverride (never persisted/resumed),
  // minted as a logical `telegram-bus-<uuid>` id (see runBusTurn).
  let busSessionCounter = 0;

  const runBusTurn = async (req: Parameters<BusTalkHandler>[0]): Promise<BusTalkResponse> => {
    const startedAt = Date.now();
    const busChatId = -(++busSessionCounter);
    // The ephemeral id MUST carry the `telegram-` prefix: every adapter decides
    // fresh-vs-resume with isLogicalTelegramSessionId() (`startsWith("telegram-")`),
    // so a bare `bus-<uuid>` looked like an EXISTING engine session — Claude spawned
    // `-r bus-<uuid>` (CLI: "not a UUID", zero turns), process-Codex ran `exec resume`,
    // and Antigravity passed `--conversation`. `telegram-` is the shared logical-id
    // marker for "start a new engine session" (cron mints `telegram-cron-…` for the
    // same reason). It is still never persisted or resumed: sessionIdOverride bypasses
    // getOrCreateSession/bindSession entirely.
    const ephemeralSessionId = `telegram-bus-${randomUUID()}`;
    await appendTimelineEventBestEffort(input.stateDir, {
      type: "turn.started",
      instanceName: input.instanceName,
      channel: "bus",
      chatId: busChatId,
      userId: 0,
      metadata: {
        fromInstance: req.fromInstance,
        depth: req.depth,
      },
    }, "bus timeline event");
    const budgetUsd = await loadBudgetUsd(input.stateDir);
    const exhausted = await checkBudgetAvailability(input.stateDir, budgetUsd, "en");

    if (exhausted) {
      await appendAuditEventBestEffort(input.stateDir, {
        type: "bus.reply",
        instanceName: input.instanceName,
        outcome: "reply",
        detail: "budget exhausted",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
        },
      }, "bus audit event");
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "budget.blocked",
        instanceName: input.instanceName,
        channel: "bus",
        chatId: busChatId,
        userId: 0,
        detail: "budget exhausted",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          budgetUsd: exhausted.budgetUsd,
          totalCostUsd: exhausted.usage.totalCostUsd,
        },
      }, "bus timeline event");
      return createBusErrorResponse({
        fromInstance: input.instanceName,
        error: exhausted.message,
        errorCode: "budget_exhausted",
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    try {
      const result = await input.bridge.handleAuthorizedMessage({
        chatId: busChatId,
        userId: 0,
        chatType: "bus",
        text: req.prompt,
        files: [],
        sessionIdOverride: ephemeralSessionId,
      });

      const recorded = await recordBridgeTurnUsage(input.stateDir, result.usage, budgetUsd);
      await appendAuditEventBestEffort(input.stateDir, {
        type: "bus.handle",
        instanceName: input.instanceName,
        outcome: "success",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
          responseChars: result.text.length,
        },
      }, "bus audit event");
      if (recorded?.reachedBudget && budgetUsd !== undefined) {
        await appendAuditEventBestEffort(input.stateDir, {
          type: "bus.reply",
          instanceName: input.instanceName,
          outcome: "reply",
          detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
          metadata: {
            fromInstance: req.fromInstance,
            depth: req.depth,
            durationMs: Date.now() - startedAt,
          },
        }, "bus audit event");
        await appendTimelineEventBestEffort(input.stateDir, {
          type: "budget.threshold_reached",
          instanceName: input.instanceName,
          channel: "bus",
          chatId: busChatId,
          userId: 0,
          detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
          metadata: {
            fromInstance: req.fromInstance,
            depth: req.depth,
            totalCostUsd: recorded.usage.totalCostUsd,
            budgetUsd,
          },
        }, "bus timeline event");
      }

      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        instanceName: input.instanceName,
        channel: "bus",
        chatId: busChatId,
        userId: 0,
        outcome: "success",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          responseChars: result.text.length,
          durationMs: Date.now() - startedAt,
        },
      }, "bus timeline event");
      return createBusTalkResponseEnvelope({
        success: true,
        text: result.text,
        fromInstance: input.instanceName,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failureCategory = classifyFailure(error);
      const mapped = getBusErrorSemantics(failureCategory);
      await appendAuditEventBestEffort(input.stateDir, {
        type: "bus.handle",
        instanceName: input.instanceName,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
          failureCategory,
        },
      }, "bus audit event");
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        instanceName: input.instanceName,
        channel: "bus",
        chatId: busChatId,
        userId: 0,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
          failureCategory,
        },
      }, "bus timeline event");
      return createBusErrorResponse({
        fromInstance: input.instanceName,
        error: error instanceof Error ? error.message : String(error),
        errorCode: mapped.code,
        retryable: mapped.retryable,
        durationMs: Date.now() - startedAt,
      });
    }
  };

  return async (req): Promise<BusTalkResponse> => await runBusTurn(req);
}
