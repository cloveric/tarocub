import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const SERVICE_LIFECYCLE_LOG_FILE = "service.lifecycle.log.jsonl";

export interface ServiceLifecycleEvent {
  type:
    | "service.starting"
    | "service.started"
    | "service.stopped"
    | "service.fatal"
    | "process.signal"
    | "process.exit"
    | "process.uncaught_exception";
  instanceName: string;
  outcome?: "success" | "error";
  detail?: string;
  metadata?: Record<string, unknown>;
}

export function appendServiceLifecycleEventSync(stateDir: string, event: ServiceLifecycleEvent): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      ...event,
    };
    appendFileSync(
      path.join(stateDir, SERVICE_LIFECYCLE_LOG_FILE),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  } catch {
    // Lifecycle logging must never take the bot down.
  }
}
