import { appendAuditEvent } from "../state/audit-log.js";

export async function appendAuditEventBestEffort(
  stateDir: string,
  event: Parameters<typeof appendAuditEvent>[1],
  label = "audit event",
): Promise<void> {
  try {
    await appendAuditEvent(stateDir, event);
  } catch (error) {
    console.error(`Failed to persist ${label}:`, error instanceof Error ? error.message : error);
  }
}
