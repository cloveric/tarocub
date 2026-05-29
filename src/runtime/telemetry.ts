import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type TelemetryTagValue = string | number | boolean | undefined;
export type TelemetryTags = Record<string, TelemetryTagValue>;

export interface TelemetryEvent {
  type: string;
  value?: unknown;
  tags?: TelemetryTags;
  timestamp?: string;
}

export interface TelemetryAdapter {
  emit?(event: TelemetryEvent): void | Promise<void>;
  recordMetric?(name: string, value: number, tags?: TelemetryTags): void | Promise<void>;
  recordError?(error: Error, tags?: TelemetryTags): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ActiveTelemetryAdapter extends TelemetryAdapter {
  emit(event: TelemetryEvent): Promise<void>;
  recordMetric(name: string, value: number, tags?: TelemetryTags): Promise<void>;
  recordError(error: Error, tags?: TelemetryTags): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface TelemetryEnv {
  TAROCUB_TELEMETRY_MODULE?: string;
  LARK_CHANNEL_TELEMETRY_MODULE?: string;
  TAROCUB_INSTANCE?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
}

export interface TelemetryAdapterMeta {
  instanceName: string;
  hostname: string;
}

export class NoopTelemetryAdapter implements ActiveTelemetryAdapter {
  async emit(_event: TelemetryEvent): Promise<void> {
    return undefined;
  }

  async recordMetric(_name: string, _value: number, _tags?: TelemetryTags): Promise<void> {
    return undefined;
  }

  async recordError(_error: Error, _tags?: TelemetryTags): Promise<void> {
    return undefined;
  }

  async flush(): Promise<void> {
    return undefined;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

export async function loadTelemetryAdapterFromEnv(env: TelemetryEnv): Promise<ActiveTelemetryAdapter> {
  const moduleSpecifier = (env.TAROCUB_TELEMETRY_MODULE ?? env.LARK_CHANNEL_TELEMETRY_MODULE)?.trim();
  if (!moduleSpecifier) {
    return new NoopTelemetryAdapter();
  }

  try {
    const mod = await import(resolveTelemetryModuleSpecifier(moduleSpecifier));
    const adapter = await materializeTelemetryAdapter(mod, {
      instanceName: env.TAROCUB_INSTANCE ?? env.CODEX_TELEGRAM_INSTANCE ?? "default",
      hostname: os.hostname(),
    });
    return wrapSafeTelemetryAdapter(adapter);
  } catch (error) {
    console.warn(
      "Failed to load telemetry adapter:",
      error instanceof Error ? error.message : String(error),
    );
    return new NoopTelemetryAdapter();
  }
}

export function wrapSafeTelemetryAdapter(adapter: TelemetryAdapter): ActiveTelemetryAdapter {
  return {
    emit: async (event) => {
      await swallowTelemetryError(() => adapter.emit?.(event));
    },
    recordMetric: async (name, value, tags) => {
      await swallowTelemetryError(() => adapter.recordMetric?.(name, value, tags));
    },
    recordError: async (error, tags) => {
      await swallowTelemetryError(() => adapter.recordError?.(error, tags));
    },
    flush: async () => {
      await swallowTelemetryError(() => adapter.flush?.());
    },
    close: async () => {
      await swallowTelemetryError(() => adapter.close?.());
    },
  };
}

function resolveTelemetryModuleSpecifier(specifier: string): string {
  if (specifier.startsWith("file:")) {
    return specifier;
  }
  if (path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
}

async function materializeTelemetryAdapter(mod: unknown, meta: TelemetryAdapterMeta): Promise<TelemetryAdapter> {
  const record = isRecord(mod) ? mod : {};
  const candidate =
    record.default ??
    record.adapter ??
    record.createAdapter;

  if (typeof candidate === "function") {
    return assertTelemetryAdapter(await candidate(meta));
  }

  if (candidate !== undefined) {
    return assertTelemetryAdapter(candidate);
  }

  if (typeof record.createTelemetryAdapter === "function") {
    return assertTelemetryAdapter(await record.createTelemetryAdapter(meta));
  }

  return assertTelemetryAdapter(record);
}

function assertTelemetryAdapter(value: unknown): TelemetryAdapter {
  if (!isRecord(value)) {
    throw new Error("telemetry module did not export an adapter object");
  }

  return value as TelemetryAdapter;
}

async function swallowTelemetryError(task: () => void | Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    // Telemetry is observability only; it must never break a user turn.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
