import { describe, expect, it } from "vitest";

import { engineEventTimelineMetadata } from "../src/runtime/timeline-events.js";

describe("engine event timeline metadata", () => {
  it("keeps session identity for background lifecycle events", () => {
    expect(engineEventTimelineMetadata({
      type: "task_notification",
      text: "Background build completed.",
      status: "completed",
      taskId: "bash-build1",
      sessionId: "kimi-session-1",
    })).toEqual({
      toolName: undefined,
      textChars: 27,
      status: "completed",
      taskId: "bash-build1",
      sessionId: "kimi-session-1",
    });
  });
});
