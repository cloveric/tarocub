export type FailureCategory =
  | "auth"
  | "write-permission"
  | "telegram-conflict"
  | "telegram-delivery"
  | "engine-cli"
  | "file-workflow"
  | "workflow-state"
  | "session-state"
  | "unknown";

export interface BusErrorSemantics {
  code: string;
  retryable: boolean;
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message].filter(Boolean).join("\n");
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export function classifyFailure(error: unknown): FailureCategory {
  const text = normalizeErrorText(error).toLowerCase();

  if (
    text.includes("not logged in") ||
    text.includes("unauthorized") ||
    text.includes("unauthorised") ||
    text.includes("missing bearer") ||
    text.includes("please run /login") ||
    text.includes("login required") ||
    text.includes("failed to authenticate") ||
    text.includes("authentication_error") ||
    text.includes("invalid authentication credentials") ||
    text.includes("401")
  ) {
    return "auth";
  }

  if (
    text.includes("read-only") ||
    text.includes("write access denied") ||
    text.includes("permission denied") ||
    text.includes("write permission") ||
    text.includes("read only")
  ) {
    return "write-permission";
  }

  if (text.includes("409 conflict") || text.includes("telegram conflict") || text.includes("another process is polling")) {
    return "telegram-conflict";
  }

  if (
    text.includes("turn.failed") ||
    text.includes("engine cli") ||
    (/(codex|claude|engine)/.test(text) && /(runtime|process|spawn|adapter|binary|cli|app-server|failed|error|startup|start)/.test(text)) ||
    (/(runtime|process|spawn|adapter|binary|cli|app-server)/.test(text) && /(codex|claude|engine)/.test(text))
  ) {
    return "engine-cli";
  }

  if (
    text.includes("senddocument") ||
    text.includes("sendmessage") ||
    text.includes("editmessage") ||
    text.includes("message is too long") ||
    text.includes("telegram api") ||
    text.includes("telegram delivery") ||
    text.includes("message to edit not found") ||
    text.includes("bad request: chat not found")
  ) {
    return "telegram-delivery";
  }

  if (
    text.includes("invalid file workflow state") ||
    text.includes("file workflow state unreadable")
  ) {
    return "workflow-state";
  }

  if (
    text.includes("archive summary") ||
    text.includes("archive extraction") ||
    text.includes("failed to extract archive") ||
    text.includes("attachment download") ||
    text.includes("failed to download attachment") ||
    text.includes("extract") ||
    text.includes("extraction") ||
    text.includes("pdf text") ||
    text.includes("zip") ||
    text.includes("file workflow")
  ) {
    return "file-workflow";
  }

  if (
    text.includes("session binding") ||
    text.includes("session-bound") ||
    text.includes("session store") ||
    text.includes("session-state") ||
    text.includes("session state") ||
    text.includes("no conversation found") ||
    text.includes("session id not found") ||
    text.includes("no such session")
  ) {
    return "session-state";
  }

  return "unknown";
}

export function getBusErrorSemantics(failureCategory: FailureCategory): BusErrorSemantics {
  switch (failureCategory) {
    case "auth":
      return { code: "auth", retryable: false };
    case "write-permission":
      return { code: "write_permission", retryable: false };
    case "telegram-conflict":
      return { code: "telegram_conflict", retryable: true };
    case "telegram-delivery":
      return { code: "telegram_delivery", retryable: true };
    case "engine-cli":
      return { code: "engine_cli", retryable: true };
    case "file-workflow":
      return { code: "file_workflow", retryable: false };
    case "workflow-state":
      return { code: "workflow_state", retryable: false };
    case "session-state":
      return { code: "session_state", retryable: false };
    case "unknown":
      return { code: "unknown", retryable: true };
  }
}

/**
 * True when the engine failed because a bound session ID points at a file
 * the CLI can't find. This is recoverable by clearing the binding and
 * retrying as a fresh session.
 */
export function isStaleSessionError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name}\n${error.message}`.toLowerCase()
      : String(error).toLowerCase();
  return (
    text.includes("no conversation found") ||
    text.includes("session id not found") ||
    text.includes("no such session")
  );
}
