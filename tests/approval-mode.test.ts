import { describe, expect, it } from "vitest";

import {
  renderApprovalModeStatus,
  resolveApprovalModeForEngine,
} from "../src/state/approval-mode.js";

describe("renderApprovalModeStatus", () => {
  it("describes Kimi ACP modes without claiming an OS sandbox", () => {
    expect(renderApprovalModeStatus("kimi", "full-auto", "en")).toBe(
      "Kimi YOLO (regular tools auto-approved; sensitive commands may still ask; no OS sandbox)",
    );
    expect(renderApprovalModeStatus("kimi", "bypass", "zh", true)).toBe(
      "Kimi Auto（完全无人值守；高危及无法分析的命令也会直接执行；无 OS 沙箱）",
    );
  });

  it("defaults and migrates Kimi to YOLO unless 0.41 Never Ask was explicitly acknowledged", () => {
    expect(resolveApprovalModeForEngine("kimi", undefined)).toBe("full-auto");
    expect(resolveApprovalModeForEngine("kimi", "bypass")).toBe("full-auto");
    expect(resolveApprovalModeForEngine("kimi", "bypass", true)).toBe("bypass");
    expect(resolveApprovalModeForEngine("codex", undefined)).toBe("bypass");
    expect(resolveApprovalModeForEngine("codex", "bypass")).toBe("bypass");
  });

  it("preserves the established labels for other engines", () => {
    expect(renderApprovalModeStatus("codex", "full-auto", "en")).toBe("YOLO/full-auto");
    expect(renderApprovalModeStatus("antigravity", "bypass", "zh")).toBe("YOLO unsafe/bypass");
    expect(renderApprovalModeStatus("claude", "normal", "zh")).toBe("普通审批");
  });
});
