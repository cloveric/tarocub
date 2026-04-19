import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import { AuditEventSchema, formatAuditSchemaError } from "./audit-log-schema.js";
import { classifyFailure, type FailureCategory } from "../runtime/error-classification.js";

export interface AuditEvent {
  timestamp?: string;
  type: string;
  instanceName?: string;
  chatId?: number;
  userId?: number;
  updateId?: number;
  outcome?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEventFilter {
  tail?: number;
  type?: string;
  chatId?: number;
  outcome?: string;
}

export interface AuditSummary {
  totalEvents: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
}

export interface LatestFailureSummary {
  timestamp?: string;
  category: FailureCategory;
  detail?: string;
}

const failureCategories = new Set<FailureCategory>([
  "auth",
  "write-permission",
  "telegram-conflict",
  "telegram-delivery",
  "engine-cli",
  "file-workflow",
  "workflow-state",
  "session-state",
  "unknown",
]);

function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === "string" && failureCategories.has(value as FailureCategory);
}

export function resolveAuditLogPath(stateDir: string): string {
  return path.join(stateDir, "audit.log.jsonl");
}

export async function appendAuditEvent(stateDir: string, event: AuditEvent): Promise<void> {
  const filePath = resolveAuditLogPath(stateDir);
  const materialized = { timestamp: event.timestamp ?? new Date().toISOString(), ...event };
  const result = AuditEventSchema.safeParse(materialized);
  if (!result.success) {
    throw new Error(`invalid audit event: ${formatAuditSchemaError(result.error)}`);
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

function isAuditEvent(value: unknown): value is AuditEvent {
  return AuditEventSchema.safeParse(value).success;
}

export function parseAuditEvents(raw: string): AuditEvent[] {
  let droppedLines = 0;
  const events = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isAuditEvent(parsed)) {
          return [parsed];
        }
      } catch {
        // fall through
      }

      droppedLines += 1;
      return [];
    });

  if (droppedLines > 0) {
    console.warn(`Dropped ${droppedLines} invalid audit log line${droppedLines === 1 ? "" : "s"} while parsing audit history.`);
  }

  return events;
}

export function filterAuditEvents(events: AuditEvent[], filter: AuditEventFilter = {}): AuditEvent[] {
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

  if (filter.tail !== undefined) {
    filtered = filtered.slice(-filter.tail);
  }

  return filtered;
}

export function summarizeAuditEvents(events: AuditEvent[]): AuditSummary {
  const summary: AuditSummary = {
    totalEvents: events.length,
  };

  for (const event of events) {
    if (!event.timestamp) {
      continue;
    }

    if (event.outcome === "success") {
      summary.lastSuccessAt = event.timestamp;
    }

    if (event.outcome === "error") {
      summary.lastErrorAt = event.timestamp;
    }
  }

  return summary;
}

export function getLatestFailure(events: AuditEvent[]): LatestFailureSummary | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.outcome !== "error") {
      continue;
    }

    const metadataCategory = event.metadata ? event.metadata.failureCategory : undefined;
    const category = isFailureCategory(metadataCategory) ? metadataCategory : classifyFailure(event.detail ?? event.type);
    const summary: LatestFailureSummary = {
      category,
      detail: event.detail,
    };

    if (event.timestamp !== undefined) {
      summary.timestamp = event.timestamp;
    }

    return summary;
  }

  return undefined;
}
