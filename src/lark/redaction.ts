const LARK_SECRET_KEY_PATTERN = String.raw`(?:lark_app_secret|app_secret|client_secret|secret|access_token|tenant_access_token|app_access_token)`;
const LARK_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?:"${LARK_SECRET_KEY_PATTERN}"|${LARK_SECRET_KEY_PATTERN})\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,;}]+)`,
  "gi",
);

export function redactLarkSensitiveText(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(LARK_SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, rawValue: string) => {
      const quote = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : "";
      return `${prefix}${quote}[redacted]${quote}`;
    })
    .replace(/(Authorization:\s*)(?!Bearer\b)[^\s,;]+/gi, "$1[redacted]");
}

export function redactLarkErrorDetail(error: unknown): string {
  return redactLarkSensitiveText(error instanceof Error ? error.message : String(error));
}
