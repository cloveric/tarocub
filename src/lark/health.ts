import { Domain } from "@larksuiteoapi/node-sdk";

import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { stableLarkNumericId } from "./message-normalizer.js";
import { redactLarkErrorDetail } from "./redaction.js";

export interface LarkReconnectableChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export type LarkHealthProbe = () => Promise<boolean>;

export interface LarkHealthMonitorOptions {
  stateDir: string;
  instanceName: string;
  channel: LarkReconnectableChannel;
  domain?: unknown;
  intervalMs?: number;
  failureThreshold?: number;
  probe?: LarkHealthProbe;
}

export interface LarkHealthMonitor {
  stop(): void;
}

const DEFAULT_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export function startLarkHealthMonitor(options: LarkHealthMonitorOptions): LarkHealthMonitor {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
  const failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD));
  const probe = options.probe ?? (() => defaultLarkHealthProbe(options.domain));
  let stopped = false;
  let running = false;
  let consecutiveFailures = 0;
  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const ok = await probe().catch(() => false);
      if (ok) {
        if (consecutiveFailures > 0) {
          await appendLarkHealthTimelineEvent(options, {
            outcome: "recovered",
            detail: "Lark health probe recovered",
            metadata: { consecutiveFailures },
          });
        }
        consecutiveFailures = 0;
        return;
      }

      consecutiveFailures += 1;
      await appendLarkHealthTimelineEvent(options, {
        outcome: "down",
        detail: "Lark health probe failed",
        metadata: { consecutiveFailures, failureThreshold },
      });
      if (consecutiveFailures < failureThreshold) {
        return;
      }

      try {
        await options.channel.disconnect().catch(() => undefined);
        await options.channel.connect();
        await appendLarkHealthTimelineEvent(options, {
          outcome: "reconnected",
          detail: "Lark channel reconnected after health failures",
          metadata: { consecutiveFailures, failureThreshold },
        });
        consecutiveFailures = 0;
      } catch (error) {
        await appendLarkHealthTimelineEvent(options, {
          outcome: "reconnect_failed",
          detail: redactLarkErrorDetail(error),
          metadata: { consecutiveFailures, failureThreshold },
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function defaultLarkHealthProbe(domain: unknown): Promise<boolean> {
  const url = resolveLarkHealthUrl(domain);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    return response.ok || response.status < 500;
  } finally {
    clearTimeout(timer);
  }
}

function resolveLarkHealthUrl(domain: unknown): string {
  if (domain === Domain.Lark || String(domain).toLowerCase().includes("lark")) {
    return "https://open.larksuite.com";
  }
  return "https://open.feishu.cn";
}

async function appendLarkHealthTimelineEvent(
  options: Pick<LarkHealthMonitorOptions, "stateDir" | "instanceName">,
  event: {
    outcome: string;
    detail: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const conversationKey = "lark:service";
  await appendTimelineEventBestEffort(options.stateDir, {
    type: "service.health",
    instanceName: options.instanceName,
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    conversationKey,
    outcome: event.outcome,
    detail: event.detail,
    metadata: {
      phase: "health",
      ...event.metadata,
    },
  }, "Lark health timeline event");
}
