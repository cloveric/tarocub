import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./secret-redaction.js";

export const SERVICE_LIFECYCLE_LOG_FILE = "service.lifecycle.log.jsonl";

export interface ServiceLifecycleEvent {
  type:
    | "service.starting"
    | "service.started"
    | "service.stopped"
    | "service.startup_maintenance"
    | "service.shutdown_cleanup"
    | "service.fatal"
    | "process.signal"
    | "process.exit"
    | "process.uncaught_exception"
    | "process.unhandled_rejection";
  instanceName: string;
  outcome?: "success" | "error";
  detail?: string;
  metadata?: Record<string, unknown>;
}

// Defense-in-depth: a thrown error's message/stack can carry a bearer token or a
// `*_secret=...` assignment, and lifecycle events persist verbatim to disk. Scrub
// `detail` and every metadata value before writing. metadata is scrubbed via a
// serialize -> redact -> reparse round-trip so KEY-named secrets (e.g. metadata.token)
// are caught too; if the redacted form is ever not valid JSON (an unquoted value
// under a secret-named key), fall back to per-string-value scrubbing so the line
// always stays well-formed.
function redactLifecycleEvent(event: ServiceLifecycleEvent): ServiceLifecycleEvent {
  const redacted: ServiceLifecycleEvent = { ...event };
  if (typeof redacted.detail === "string") {
    redacted.detail = redactSecrets(redacted.detail);
  }
  if (redacted.metadata) {
    try {
      redacted.metadata = JSON.parse(redactSecrets(JSON.stringify(redacted.metadata))) as Record<string, unknown>;
    } catch {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(redacted.metadata)) {
        scrubbed[key] = typeof value === "string" ? redactSecrets(value) : value;
      }
      redacted.metadata = scrubbed;
    }
  }
  return redacted;
}

export function appendServiceLifecycleEventSync(stateDir: string, event: ServiceLifecycleEvent): void {
  try {
    // 0700/0600: the lifecycle log records instance names, pids and error detail.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      ...redactLifecycleEvent(event),
    };
    appendFileSync(
      path.join(stateDir, SERVICE_LIFECYCLE_LOG_FILE),
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Lifecycle logging must never take the bot down.
  }
}
