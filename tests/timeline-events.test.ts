import { describe, expect, it } from "vitest";

import {
  engineEventTimelineMetadata,
  shouldPersistEngineTimelineEvent,
} from "../src/runtime/timeline-events.js";

describe("engine event timeline metadata", () => {
  it("keeps session identity and delivery suppression for background lifecycle events", () => {
    expect(engineEventTimelineMetadata({
      type: "task_notification",
      text: "Background build completed.",
      status: "completed",
      taskId: "bash-build1",
      sessionId: "kimi-session-1",
      suppressUserDelivery: true,
    })).toEqual({
      toolName: undefined,
      textChars: 27,
      status: "completed",
      taskId: "bash-build1",
      sessionId: "kimi-session-1",
      userDeliverySuppressed: true,
    });
  });

  it("drops high-frequency rendering fragments but keeps semantic milestones", () => {
    expect(shouldPersistEngineTimelineEvent({ type: "assistant_text", text: "tok", delta: true })).toBe(false);
    expect(shouldPersistEngineTimelineEvent({ type: "thinking", text: "reasoning" })).toBe(false);
    expect(shouldPersistEngineTimelineEvent({
      type: "tool_progress",
      toolUseId: "tool-1",
      text: "still running",
    })).toBe(false);

    expect(shouldPersistEngineTimelineEvent({ type: "assistant_text", text: "complete message" })).toBe(true);
    expect(shouldPersistEngineTimelineEvent({ type: "tool_use", toolName: "Read" })).toBe(true);
    expect(shouldPersistEngineTimelineEvent({ type: "result", text: "done" })).toBe(true);
  });
});
