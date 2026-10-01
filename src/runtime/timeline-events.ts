import type { EngineStreamEvent } from "../codex/adapter.js";
import { appendTimelineEvent } from "../state/timeline-log.js";

/**
 * Persist semantic milestones, not token-level rendering noise. Live cards and
 * delivery handlers still receive every event; only the diagnostic timeline is
 * compacted so a single verbose turn cannot rotate away useful history.
 */
export function shouldPersistEngineTimelineEvent(event: EngineStreamEvent): boolean {
  if (event.type === "thinking" || event.type === "tool_progress") return false;
  if (event.type === "assistant_text" && event.delta === true) return false;
  return true;
}

export function engineEventTimelineMetadata(event: EngineStreamEvent): {
  toolName: string | undefined;
  textChars: number | undefined;
  status: string | undefined;
  taskId: string | undefined;
  requestId: string | undefined;
  sessionId: string | undefined;
  userDeliverySuppressed: boolean | undefined;
} {
  return {
    toolName: "toolName" in event ? event.toolName : undefined,
    textChars: "text" in event ? event.text.length : undefined,
    status: "status" in event ? event.status : undefined,
    taskId: "taskId" in event ? event.taskId : undefined,
    requestId: "requestId" in event ? event.requestId : undefined,
    sessionId: "sessionId" in event ? event.sessionId : undefined,
    userDeliverySuppressed: event.type === "task_notification"
      ? event.suppressUserDelivery
      : undefined,
  };
}

export async function appendTimelineEventBestEffort(
  stateDir: string,
  event: Parameters<typeof appendTimelineEvent>[1],
  label = "timeline event",
): Promise<void> {
  try {
    await appendTimelineEvent(stateDir, event);
  } catch (error) {
    console.error(`Failed to persist ${label}:`, error instanceof Error ? error.message : error);
  }
}
