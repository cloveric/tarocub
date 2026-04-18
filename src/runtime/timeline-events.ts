import { appendTimelineEvent } from "../state/timeline-log.js";

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
