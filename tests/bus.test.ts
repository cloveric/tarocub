import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseBusConfig, isPeerAllowed, type BusConfig } from "../src/bus/bus-config.js";
import {
  registerInstance,
  deregisterInstance,
  lookupInstance,
  listRegisteredInstances,
  readRegistry,
} from "../src/bus/bus-registry.js";
import {
  createBusServer,
  startBusServer,
  stopBusServer,
  type BusTalkRequest,
  type BusTalkResponse,
} from "../src/bus/bus-server.js";

describe("parseBusConfig", () => {
  it("returns null for undefined/null/false", () => {
    expect(parseBusConfig(undefined)).toBeNull();
    expect(parseBusConfig(null)).toBeNull();
    expect(parseBusConfig(false)).toBeNull();
  });

  it("parses true as wildcard peers", () => {
    const result = parseBusConfig(true);
    expect(result).toEqual({ peers: "*", maxDepth: 3, port: 0, secret: expect.any(String), parallel: [], verifier: null });
  });

  it("parses peers wildcard", () => {
    const result = parseBusConfig({ peers: "*" });
    expect(result).toEqual({ peers: "*", maxDepth: 3, port: 0, secret: expect.any(String), parallel: [], verifier: null });
  });

  it("parses peers list", () => {
    const result = parseBusConfig({ peers: ["work", "reviewer"] });
    expect(result).toEqual({ peers: ["work", "reviewer"], maxDepth: 3, port: 0, secret: expect.any(String), parallel: [], verifier: null });
  });

  it("returns null for empty peers list", () => {
    expect(parseBusConfig({ peers: [] })).toBeNull();
  });

  it("respects custom maxDepth and port", () => {
    const result = parseBusConfig({ peers: "*", maxDepth: 5, port: 9200 });
    expect(result).toEqual({ peers: "*", maxDepth: 5, port: 9200, secret: expect.any(String), parallel: [], verifier: null });
  });

  it("parses secret", () => {
    const result = parseBusConfig({ peers: "*", secret: "my-token" });
    expect(result).toEqual({ peers: "*", maxDepth: 3, port: 0, secret: "my-token", parallel: [], verifier: null });
  });

  it("parses parallel and verifier", () => {
    const result = parseBusConfig({ peers: "*", parallel: ["sec-bot", "perf-bot"], verifier: "reviewer" });
    expect(result).toEqual({
      peers: "*", maxDepth: 3, port: 0, secret: expect.any(String),
      parallel: ["sec-bot", "perf-bot"], verifier: "reviewer",
    });
  });

  it("returns null for peers: false", () => {
    expect(parseBusConfig({ peers: false })).toBeNull();
  });
});

describe("isPeerAllowed", () => {
  it("allows all peers with wildcard", () => {
    const config: BusConfig = { peers: "*", maxDepth: 3, port: 0, secret: "", parallel: [], verifier: null };
    expect(isPeerAllowed(config, "anything")).toBe(true);
  });

  it("allows listed peers", () => {
    const config: BusConfig = { peers: ["work", "reviewer"], maxDepth: 3, port: 0, secret: "", parallel: [], verifier: null };
    expect(isPeerAllowed(config, "work")).toBe(true);
    expect(isPeerAllowed(config, "reviewer")).toBe(true);
    expect(isPeerAllowed(config, "unknown")).toBe(false);
  });

  it("denies all when peers is false", () => {
    const config: BusConfig = { peers: false, maxDepth: 3, port: 0, secret: "", parallel: [], verifier: null };
    expect(isPeerAllowed(config, "work")).toBe(false);
  });
});

describe("bus registry", () => {
  it("registers, looks up, and deregisters instances", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    try {
      await registerInstance(tempDir, "work", 9100, "secret-a");
      await registerInstance(tempDir, "reviewer", 9101, "secret-b");

      const work = await lookupInstance(tempDir, "work");
      expect(work).toEqual(expect.objectContaining({ port: 9100, pid: process.pid, secret: "secret-a" }));

      const all = await listRegisteredInstances(tempDir);
      expect(all).toHaveLength(2);

      await deregisterInstance(tempDir, "work");
      expect(await lookupInstance(tempDir, "work")).toBeNull();
      expect(await lookupInstance(tempDir, "reviewer")).not.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty registry when file does not exist", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    try {
      const registry = await readRegistry(tempDir);
      expect(registry.instances).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("bus server", () => {
  it("handles /api/talk with peer validation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-server-"));
    const stateDir = tempDir;

    try {
      await writeFile(
        path.join(stateDir, "config.json"),
        JSON.stringify({ bus: { peers: ["work"], secret: "test-secret" } }),
        "utf8",
      );

      const handler = async (req: BusTalkRequest): Promise<BusTalkResponse> => ({
        success: true,
        text: `Processed: ${req.prompt}`,
        fromInstance: "reviewer",
        durationMs: 10,
      });

      const server = createBusServer("reviewer", stateDir, handler);
      const port = await startBusServer(server, 0);

      try {
        // Allowed peer
        const res = await fetch(`http://127.0.0.1:${port}/api/talk`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer test-secret" },
          body: JSON.stringify({ fromInstance: "work", prompt: "hello", depth: 0 }),
        });
        const body = (await res.json()) as BusTalkResponse;
        expect(body.success).toBe(true);
        expect(body.text).toBe("Processed: hello");

        // Disallowed peer
        const res2 = await fetch(`http://127.0.0.1:${port}/api/talk`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer test-secret" },
          body: JSON.stringify({ fromInstance: "unknown", prompt: "hello", depth: 0 }),
        });
        expect(res2.status).toBe(403);

        // Health endpoint
        const res3 = await fetch(`http://127.0.0.1:${port}/api/health`);
        const health = (await res3.json()) as { instance: string; status: string };
        expect(health.instance).toBe("reviewer");
        expect(health.status).toBe("ok");
      } finally {
        await stopBusServer(server);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects requests exceeding max depth", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-server-"));

    try {
      await writeFile(
        path.join(tempDir, "config.json"),
        JSON.stringify({ bus: { peers: "*", maxDepth: 2, secret: "test-secret" } }),
        "utf8",
      );

      const handler = async (): Promise<BusTalkResponse> => ({
        success: true,
        text: "ok",
        fromInstance: "test",
      });

      const server = createBusServer("test", tempDir, handler);
      const port = await startBusServer(server, 0);

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/talk`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer test-secret" },
          body: JSON.stringify({ fromInstance: "work", prompt: "hello", depth: 2 }),
        });
        expect(res.status).toBe(429);
      } finally {
        await stopBusServer(server);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
