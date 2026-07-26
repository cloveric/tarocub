import { describe, expect, it } from "vitest";

import { renderBackgroundTaskHeader } from "../src/runtime/background-task-header.js";
import { renderLarkBackgroundTaskHeader } from "../src/lark/locale.js";

// A background task that was stopped or that failed used to be announced as
// "后台任务完成" regardless of its status. The body of such a notification says
// the opposite (the engine explains no completion record was found), and the
// card is delivered as a REPLY to whatever the user last asked — so a wrong
// header reads as a wrong answer to an unrelated question.
describe("background task notification header", () => {
  it("says stopped for a stopped task instead of claiming completion", () => {
    expect(renderBackgroundTaskHeader("zh", "stopped")).toBe("后台任务已停止");
    expect(renderBackgroundTaskHeader("en", "stopped")).toBe("Background task stopped");
    for (const status of ["cancelled", "canceled", "aborted", "Stopped", " STOPPED "]) {
      expect(renderBackgroundTaskHeader("zh", status)).toBe("后台任务已停止");
    }
  });

  it("says failed for a failed task", () => {
    expect(renderBackgroundTaskHeader("zh", "failed")).toBe("后台任务失败");
    expect(renderBackgroundTaskHeader("zh", "error")).toBe("后台任务失败");
    expect(renderBackgroundTaskHeader("en", "failed")).toBe("Background task failed");
  });

  it("keeps the completed wording for a completed task and for an absent status", () => {
    expect(renderBackgroundTaskHeader("zh", "completed")).toBe("后台任务完成");
    expect(renderBackgroundTaskHeader("zh", undefined)).toBe("后台任务完成");
    expect(renderBackgroundTaskHeader("zh", "")).toBe("后台任务完成");
    expect(renderBackgroundTaskHeader("en", undefined)).toBe("Background task completed");
  });

  it("renders the same wording on both channels so a status cannot mean two things", () => {
    for (const status of [undefined, "completed", "stopped", "failed", "error", "cancelled"]) {
      expect(renderLarkBackgroundTaskHeader("zh", status)).toBe(renderBackgroundTaskHeader("zh", status));
      expect(renderLarkBackgroundTaskHeader("en", status)).toBe(renderBackgroundTaskHeader("en", status));
    }
  });
});
