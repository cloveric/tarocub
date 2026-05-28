export type ApprovalMode = "normal" | "full-auto" | "bypass";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "bypass";

export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === "normal" || value === "full-auto" || value === "bypass" ? value : undefined;
}

export function resolveApprovalMode(value: unknown): ApprovalMode {
  return normalizeApprovalMode(value) ?? DEFAULT_APPROVAL_MODE;
}
