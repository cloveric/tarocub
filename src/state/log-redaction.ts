import { redactSecrets } from "../runtime/secret-redaction.js";

const SECRET_METADATA_KEY_PATTERN = /(?:authorization|secret|access[_-]?token|tenant[_-]?access[_-]?token|app[_-]?access[_-]?token|api[_-]?key|apikey|token)/i;
const MAX_METADATA_REDACTION_DEPTH = 20;

export function redactLogMetadata<T>(value: T, depth = 0): T {
  if (depth > MAX_METADATA_REDACTION_DEPTH) {
    return "[redacted]" as T;
  }

  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactLogMetadata(entry, depth + 1)) as T;
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_METADATA_KEY_PATTERN.test(key)
        ? "[redacted]"
        : redactLogMetadata(entry, depth + 1);
    }
    return redacted as T;
  }

  return value;
}
