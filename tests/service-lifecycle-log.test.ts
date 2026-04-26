import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendServiceLifecycleEventSync,
  SERVICE_LIFECYCLE_LOG_FILE,
} from "../src/runtime/service-lifecycle-log.js";

describe("service lifecycle log", () => {
  it("appends JSONL lifecycle events without truncating previous entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-lifecycle-"));

    appendServiceLifecycleEventSync(root, {
      type: "service.starting",
      instanceName: "bot6",
      detail: "first",
    });
    appendServiceLifecycleEventSync(root, {
      type: "process.signal",
      instanceName: "bot6",
      detail: "SIGTERM",
      metadata: { pid: 123 },
    });

    const raw = await readFile(path.join(root, SERVICE_LIFECYCLE_LOG_FILE), "utf8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "service.starting",
      instanceName: "bot6",
      detail: "first",
    });
    expect(lines[0]?.timestamp).toEqual(expect.any(String));
    expect(lines[0]?.pid).toEqual(process.pid);
    expect(lines[1]).toMatchObject({
      type: "process.signal",
      instanceName: "bot6",
      detail: "SIGTERM",
      metadata: { pid: 123 },
    });
  });

  it("does not throw when the state path cannot be used", () => {
    expect(() => {
      appendServiceLifecycleEventSync("/dev/null/not-a-directory", {
        type: "service.starting",
        instanceName: "bot6",
      });
    }).not.toThrow();
  });
});
