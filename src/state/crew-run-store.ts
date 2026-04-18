import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { JsonStore } from "./json-store.js";
import { CrewRunRecordSchema, type CrewRunRecord } from "./crew-run-schema.js";

export const CREW_RUN_STATE_UNREADABLE_WARNING = "crew run state unreadable";

export function resolveCrewRunsDir(stateDir: string): string {
  return path.join(stateDir, "crew-runs");
}

export function resolveCrewRunPath(stateDir: string, runId: string): string {
  return path.join(resolveCrewRunsDir(stateDir), `${runId}.json`);
}

function parseCrewRunRecord(value: unknown): CrewRunRecord {
  const result = CrewRunRecordSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new Error("invalid crew run state");
}

async function readCrewRunRecord(filePath: string): Promise<CrewRunRecord> {
  const raw = await readFile(filePath, "utf8");
  return parseCrewRunRecord(JSON.parse(raw) as unknown);
}

export class CrewRunStore {
  constructor(private readonly stateDir: string) {}

  private createStore(runId: string): JsonStore<CrewRunRecord> {
    return new JsonStore<CrewRunRecord>(resolveCrewRunPath(this.stateDir, runId), parseCrewRunRecord);
  }

  async create(record: CrewRunRecord): Promise<void> {
    await this.createStore(record.runId).write(record);
  }

  async load(runId: string): Promise<CrewRunRecord | null> {
    try {
      return await readCrewRunRecord(resolveCrewRunPath(this.stateDir, runId));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }

      throw error;
    }
  }

  async update(runId: string, mutate: (record: CrewRunRecord) => void): Promise<CrewRunRecord | null> {
    const record = await this.load(runId);
    if (!record) {
      return null;
    }

    mutate(record);
    record.updatedAt = new Date().toISOString();
    await this.createStore(runId).write(record);
    return record;
  }

  async inspectLatest(): Promise<{ run: CrewRunRecord | null; warning?: string }> {
    const dir = resolveCrewRunsDir(this.stateDir);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const entries = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort();

      let latest: CrewRunRecord | null = null;
      let sawUnreadable = false;

      for (const entry of entries) {
        try {
          const record = await readCrewRunRecord(path.join(dir, entry));
          if (latest === null || record.updatedAt.localeCompare(latest.updatedAt) > 0) {
            latest = record;
          }
        } catch {
          sawUnreadable = true;
        }
      }

      return sawUnreadable
        ? { run: latest, warning: CREW_RUN_STATE_UNREADABLE_WARNING }
        : { run: latest };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { run: null };
      }

      return { run: null, warning: CREW_RUN_STATE_UNREADABLE_WARNING };
    }
  }
}

