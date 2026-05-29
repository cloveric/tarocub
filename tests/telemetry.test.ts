import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadTelemetryAdapterFromEnv, NoopTelemetryAdapter } from "../src/runtime/telemetry.js";

describe("telemetry adapter", () => {
  it("defaults to a no-op adapter", async () => {
    const adapter = await loadTelemetryAdapterFromEnv({});

    expect(adapter).toBeInstanceOf(NoopTelemetryAdapter);
    await expect(adapter.recordMetric("run_e2e_ms", 123)).resolves.toBeUndefined();
  });

  it("loads a telemetry adapter module from env", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-telemetry-"));
    const modulePath = path.join(tempDir, "adapter.mjs");
    await writeFile(modulePath, [
      "export default function createAdapter(meta) {",
      "  return {",
      "    recordMetric(name, value, tags) { globalThis.__cctbTelemetryCalls.push(['metric', name, value, tags, meta.instanceName]); },",
      "    recordError(error, tags) { globalThis.__cctbTelemetryCalls.push(['error', error.message, tags]); },",
      "  };",
      "}",
    ].join("\n"), "utf8");
    const globalWithTelemetry = globalThis as typeof globalThis & { __cctbTelemetryCalls?: unknown[] };
    globalWithTelemetry.__cctbTelemetryCalls = [];

    try {
      const adapter = await loadTelemetryAdapterFromEnv({
        TAROCUB_TELEMETRY_MODULE: modulePath,
        TAROCUB_INSTANCE: "alpha",
      });

      await adapter.recordMetric("pool_active", 2, { channel: "lark" });
      await adapter.recordError(new Error("boom"), { phase: "test" });

      expect(globalWithTelemetry.__cctbTelemetryCalls).toEqual([
        ["metric", "pool_active", 2, { channel: "lark" }, "alpha"],
        ["error", "boom", { phase: "test" }],
      ]);
    } finally {
      delete globalWithTelemetry.__cctbTelemetryCalls;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("swallows adapter failures so telemetry never breaks turns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = await loadTelemetryAdapterFromEnv({
      TAROCUB_TELEMETRY_MODULE: "file:///does/not/exist.mjs",
    });

    try {
      await expect(adapter.recordMetric("run_e2e_ms", 1)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to load telemetry adapter:"), expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });
});
