import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseAuditEvents, type AuditEvent } from "./audit-log.js";
import { RuntimeStateStore } from "./runtime-state.js";

const AUDIT_LOG_FILE_RE = /^audit\.log\.jsonl(?:\.\d+)?$/;

function isHandledUpdateAuditEvent(event: AuditEvent): boolean {
  if (event.updateId === undefined || event.updateId < 0 || !Number.isInteger(event.updateId)) {
    return false;
  }

  if (event.type === "update.handle") {
    return ["success", "duplicate", "invalid", "empty"].includes(event.outcome ?? "");
  }

  if (event.type === "update.skip") {
    return ["duplicate", "invalid", "empty"].includes(event.outcome ?? "");
  }

  if (event.type === "update.membership") {
    return event.outcome === "observed";
  }

  return false;
}

export function findRecoveredLastHandledUpdateId(events: AuditEvent[]): number | null {
  let maxUpdateId: number | null = null;
  for (const event of events) {
    if (!isHandledUpdateAuditEvent(event)) {
      continue;
    }
    maxUpdateId = maxUpdateId === null ? event.updateId! : Math.max(maxUpdateId, event.updateId!);
  }
  return maxUpdateId;
}

async function readAuditEventsFromRotations(stateDir: string): Promise<AuditEvent[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const auditFiles = entries
    .filter((entry) => AUDIT_LOG_FILE_RE.test(entry))
    .map((entry) => path.join(stateDir, entry));

  const events: AuditEvent[] = [];
  for (const filePath of auditFiles) {
    try {
      events.push(...parseAuditEvents(await readFile(filePath, "utf8")));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return events;
}

export async function recoverLastHandledUpdateIdFromAudit(
  stateDir: string,
  store = new RuntimeStateStore(path.join(stateDir, "runtime-state.json")),
): Promise<number | null> {
  const recoveredUpdateId = findRecoveredLastHandledUpdateId(await readAuditEventsFromRotations(stateDir));
  if (recoveredUpdateId === null) {
    return null;
  }

  const state = await store.load();
  if (state.lastHandledUpdateId === null || recoveredUpdateId > state.lastHandledUpdateId) {
    await store.markHandledUpdateId(recoveredUpdateId);
  }

  return recoveredUpdateId;
}
