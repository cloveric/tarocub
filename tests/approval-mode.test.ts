import { describe, expect, it } from "vitest";

import { renderApprovalModeStatus } from "../src/state/approval-mode.js";

describe("renderApprovalModeStatus", () => {
  it("describes Kimi ACP modes without claiming an OS sandbox", () => {
    expect(renderApprovalModeStatus("kimi", "full-auto", "en")).toBe(
      "Kimi YOLO (regular tools auto-approved; sensitive commands may still ask; no OS sandbox)",
    );
    expect(renderApprovalModeStatus("kimi", "bypass", "zh")).toBe(
      "Kimi Auto（无人值守；默认保留高危命令保护；无 OS 沙箱）",
    );
  });

  it("preserves the established labels for other engines", () => {
    expect(renderApprovalModeStatus("codex", "full-auto", "en")).toBe("YOLO/full-auto");
    expect(renderApprovalModeStatus("antigravity", "bypass", "zh")).toBe("YOLO unsafe/bypass");
    expect(renderApprovalModeStatus("claude", "normal", "zh")).toBe("普通审批");
  });
});
