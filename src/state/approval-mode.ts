export type ApprovalMode = "normal" | "full-auto" | "bypass";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "bypass";

export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === "normal" || value === "full-auto" || value === "bypass" ? value : undefined;
}

export function resolveApprovalMode(value: unknown): ApprovalMode {
  return normalizeApprovalMode(value) ?? DEFAULT_APPROVAL_MODE;
}

export function renderApprovalModeStatus(
  engine: string,
  value: unknown,
  locale: "en" | "zh",
): string {
  const mode = resolveApprovalMode(value);
  if (engine === "kimi") {
    if (mode === "full-auto") {
      return locale === "en"
        ? "Kimi YOLO (regular tools auto-approved; sensitive commands may still ask; no OS sandbox)"
        : "Kimi YOLO（普通工具自动批准；敏感命令仍可能询问；无 OS 沙箱）";
    }
    if (mode === "bypass") {
      return locale === "en"
        ? "Kimi Auto (unattended; dangerous-command guard remains on by default; no OS sandbox)"
        : "Kimi Auto（无人值守；默认保留高危命令保护；无 OS 沙箱）";
    }
  }
  if (mode === "bypass") {
    return "YOLO unsafe/bypass";
  }
  if (mode === "full-auto") {
    return "YOLO/full-auto";
  }
  return locale === "en" ? "normal approvals" : "普通审批";
}
