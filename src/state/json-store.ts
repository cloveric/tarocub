import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { CURRENT_SCHEMA_VERSION, withSchemaVersion } from "./schema-version.js";

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly parser?: (value: unknown) => T,
  ) {}

  async read(defaultValue: T): Promise<T> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as unknown;

      // Schema compatibility check: reject newer versions (downgrade would corrupt).
      if (typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed) {
        const v = (parsed as { schemaVersion?: unknown }).schemaVersion;
        if (typeof v === "number" && v > CURRENT_SCHEMA_VERSION) {
          throw new Error(
            `State file ${path.basename(this.filePath)} has schema version ${v}, but this bridge supports up to ${CURRENT_SCHEMA_VERSION}. Upgrade the bridge.`,
          );
        }
      }

      return this.parser ? this.parser(parsed) : (parsed as T);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultValue;
      }

      throw error;
    }
  }

  async write(value: T): Promise<void> {
    const directoryPath = path.dirname(this.filePath);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });

    // Attach current schema version on write so future loads can detect
    // incompatibility without every caller remembering to add it.
    const versioned = typeof value === "object" && value !== null
      ? withSchemaVersion(value as object)
      : value;

    const tmpPath = path.join(directoryPath, `${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, JSON.stringify(versioned, null, 2), { encoding: "utf8", mode: 0o600 });
    const tmpHandle = await open(tmpPath, "r");
    try {
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close();
    }
    await rename(tmpPath, this.filePath);
    try {
      const dirHandle = await open(directoryPath, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (error) {
      if (!isSkippableDirectorySyncError(error)) {
        throw error;
      }
    }
  }

  async quarantineCurrentFile(reason = "unreadable"): Promise<string | null> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const quarantinePath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${reason}.${randomUUID()}.bak`,
    );

    try {
      await rename(this.filePath, quarantinePath);
      return quarantinePath;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }
}

function isSkippableDirectorySyncError(error: unknown): boolean {
  if (!(typeof error === "object" && error !== null && "code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR";
}
