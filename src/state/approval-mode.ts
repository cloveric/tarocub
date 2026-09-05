export type ApprovalMode = "normal" | "full-auto" | "bypass";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "bypass";

export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === "normal" || value === "full-auto" || value === "bypass" ? value : undefined;
}

export function resolveApprovalMode(value: unknown): ApprovalMode {
  return normalizeApprovalMode(value) ?? DEFAULT_APPROVAL_MODE;
}

export function resolveApprovalModeForEngine(
  engine: string,
  value: unknown,
  kimiAutoNeverAskAcknowledged: unknown = false,
): ApprovalMode {
  const mode = normalizeApprovalMode(value);
  if (engine === "kimi") {
    if (mode === "bypass" && kimiAutoNeverAskAcknowledged !== true) {
      return "full-auto";
    }
    return mode ?? "full-auto";
  }
  return mode ?? DEFAULT_APPROVAL_MODE;
}

export function renderApprovalModeStatus(
  engine: string,
  value: unknown,
  locale: "en" | "zh",
  kimiAutoNeverAskAcknowledged: unknown = false,
): string {
  const mode = resolveApprovalModeForEngine(engine, value, kimiAutoNeverAskAcknowledged);
  if (engine === "kimi") {
    if (mode === "full-auto") {
      return locale === "en"
        ? "Kimi YOLO (regular tools auto-approved; sensitive commands may still ask; no OS sandbox)"
        : "Kimi YOLO（普通工具自动批准；敏感命令仍可能询问；无 OS 沙箱）";
    }
    if (mode === "bypass") {
      return locale === "en"
        ? "Kimi Auto (fully unattended; dangerous and unanalyzable commands execute without interruption; no OS sandbox)"
        : "Kimi Auto（完全无人值守；高危及无法分析的命令也会直接执行；无 OS 沙箱）";
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
