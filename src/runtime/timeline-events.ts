import type { EngineStreamEvent } from "../codex/adapter.js";
import { appendTimelineEvent } from "../state/timeline-log.js";

export function engineEventTimelineMetadata(event: EngineStreamEvent): {
  toolName: string | undefined;
  textChars: number | undefined;
  status: string | undefined;
  taskId: string | undefined;
  sessionId: string | undefined;
} {
  return {
    toolName: "toolName" in event ? event.toolName : undefined,
    textChars: "text" in event ? event.text.length : undefined,
    status: "status" in event ? event.status : undefined,
    taskId: "taskId" in event ? event.taskId : undefined,
    sessionId: "sessionId" in event ? event.sessionId : undefined,
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
