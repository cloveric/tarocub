// Shared, channel-agnostic secret redaction. Used both by the Lark error path
// and by the audit/timeline log writers as a defense-in-depth scrub so a raw
// engine/API error message carrying a bearer token or `*_secret=...` assignment
// can't be persisted verbatim to disk. The patterns are deliberately general
// (HTTP auth headers + common secret key names), not Lark-specific.
const SECRET_KEY_PATTERN = String.raw`(?:lark_app_secret|app_secret|client_secret|secret|access_token|tenant_access_token|app_access_token|api_key|apikey|token)`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?:"${SECRET_KEY_PATTERN}"|${SECRET_KEY_PATTERN})\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,;}]+)`,
  "gi",
);

export function redactSecrets(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, rawValue: string) => {
      const quote = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : "";
      return `${prefix}${quote}[redacted]${quote}`;
    })
    .replace(/(Authorization:\s*)(?!Bearer\b)[^\s,;]+/gi, "$1[redacted]");
}

export function redactSecretsInErrorDetail(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
