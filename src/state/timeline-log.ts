import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import { TimelineEventSchema, formatTimelineSchemaError } from "./timeline-log-schema.js";

export interface TimelineEvent {
  timestamp?: string;
  type:
    | "input.received"
    | "command.handled"
    | "turn.started"
    | "turn.completed"
    | "turn.retried"
    | "crew.run.started"
    | "crew.stage.started"
    | "crew.stage.completed"
    | "crew.run.completed"
    | "crew.run.failed"
    | "workflow.prepared"
    | "workflow.failed"
    | "workflow.completed"
    | "file.accepted"
    | "file.rejected"
    | "budget.blocked"
    | "budget.threshold_reached";
  instanceName?: string;
  channel?: "telegram" | "bus";
  chatId?: number;
  userId?: number;
  updateId?: number;
  outcome?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface TimelineSummary {
  totalEvents: number;
  lastTurnCompletionAt?: string;
  lastRetryAt?: string;
  lastBudgetBlockedAt?: string;
  lastCrewRunAt?: string;
  retryCount: number;
  budgetBlockedCount: number;
  fileRejectedCount: number;
  workflowFailedCount: number;
  crewRunsStartedCount: number;
  crewRunsCompletedCount: number;
  crewRunsFailedCount: number;
}

export interface TimelineEventFilter {
  tail?: number;
  type?: TimelineEvent["type"];
  chatId?: number;
  outcome?: string;
  channel?: TimelineEvent["channel"];
}

export function resolveTimelineLogPath(stateDir: string): string {
  return path.join(stateDir, "timeline.log.jsonl");
}

export async function appendTimelineEvent(stateDir: string, event: TimelineEvent): Promise<void> {
  const filePath = resolveTimelineLogPath(stateDir);
  const materialized = { timestamp: event.timestamp ?? new Date().toISOString(), ...event };
  const result = TimelineEventSchema.safeParse(materialized);
  if (!result.success) {
    throw new Error(`invalid timeline event: ${formatTimelineSchemaError(result.error)}`);
  }

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(result.data)}\n`;
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.write(line, undefined, "utf8");
  } finally {
    await handle.close();
  }
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  return TimelineEventSchema.safeParse(value).success;
}

export function parseTimelineEvents(raw: string): TimelineEvent[] {
  let droppedLines = 0;
  const events = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isTimelineEvent(parsed)) {
          return [parsed];
        }
      } catch {
        // fall through
      }

      droppedLines += 1;
      return [];
    });

  if (droppedLines > 0) {
    console.warn(`Dropped ${droppedLines} invalid timeline log line${droppedLines === 1 ? "" : "s"} while parsing timeline history.`);
  }

  return events;
}

export function summarizeTimelineEvents(events: TimelineEvent[]): TimelineSummary {
  const summary: TimelineSummary = {
    totalEvents: events.length,
    retryCount: 0,
    budgetBlockedCount: 0,
    fileRejectedCount: 0,
    workflowFailedCount: 0,
    crewRunsStartedCount: 0,
    crewRunsCompletedCount: 0,
    crewRunsFailedCount: 0,
  };

  for (const event of events) {
    if (event.type === "turn.retried") {
      summary.retryCount += 1;
    }

    if (event.type === "budget.blocked") {
      summary.budgetBlockedCount += 1;
    }

    if (event.type === "file.rejected") {
      summary.fileRejectedCount += 1;
    }

    if (event.type === "workflow.failed") {
      summary.workflowFailedCount += 1;
    }

    if (event.type === "crew.run.started") {
      summary.crewRunsStartedCount += 1;
    }

    if (event.type === "crew.run.completed") {
      summary.crewRunsCompletedCount += 1;
    }

    if (event.type === "crew.run.failed") {
      summary.crewRunsFailedCount += 1;
    }

    if (!event.timestamp) {
      continue;
    }

    if (event.type === "turn.completed") {
      summary.lastTurnCompletionAt = event.timestamp;
    }

    if (event.type === "turn.retried") {
      summary.lastRetryAt = event.timestamp;
    }

    if (event.type === "budget.blocked") {
      summary.lastBudgetBlockedAt = event.timestamp;
    }

    if (event.type === "crew.run.started" || event.type === "crew.run.completed" || event.type === "crew.run.failed") {
      summary.lastCrewRunAt = event.timestamp;
    }
  }

  return summary;
}

export function filterTimelineEvents(events: TimelineEvent[], filter: TimelineEventFilter = {}): TimelineEvent[] {
  let filtered = events;

  if (filter.type) {
    filtered = filtered.filter((event) => event.type === filter.type);
  }

  if (filter.chatId !== undefined) {
    filtered = filtered.filter((event) => event.chatId === filter.chatId);
  }

  if (filter.outcome) {
    filtered = filtered.filter((event) => event.outcome === filter.outcome);
  }

  if (filter.channel) {
    filtered = filtered.filter((event) => event.channel === filter.channel);
  }

  if (filter.tail !== undefined) {
    filtered = filtered.slice(-filter.tail);
  }

  return filtered;
}
