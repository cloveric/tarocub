import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stand-in for a real cc-telegram-bridge bus server — responds to
 * GET /api/health with the fingerprint isInstanceAlive looks for.
 */
async function listenOn(port: number, instance: string): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "cc-telegram-bridge", instance, status: "ok", pid: process.pid }));
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/**
 * A non-bus TCP listener that silently accepts and holds connections
 * without ever speaking HTTP. Proves random port occupants are rejected.
 *
 * We track live sockets explicitly so `.close()` can force them shut —
 * otherwise `server.close()` hangs waiting for fetch-spawned sockets to
 * drain after the probe aborts.
 */
async function listenOnNonBus(port: number): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () => new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

import { loadBusConfig, parseBusConfig, isPeerAllowed, type BusConfig } from "../src/bus/bus-config.js";
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
import { delegateToInstance } from "../src/bus/bus-client.js";
import { BUS_PROTOCOL_CAPABILITIES, BUS_PROTOCOL_VERSION, BusProtocolError } from "../src/bus/bus-protocol.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseBusConfig", () => {
  it("returns null for undefined/null/false", () => {
    expect(parseBusConfig(undefined)).toBeNull();
    expect(parseBusConfig(null)).toBeNull();
    expect(parseBusConfig(false)).toBeNull();
  });

  it("parses true as wildcard peers", () => {
    const result = parseBusConfig(true);
    expect(result).toEqual({
      peers: "*",
      maxDepth: 3,
      port: 0,
      secret: expect.any(String),
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
  });

  it("parses peers wildcard", () => {
    const result = parseBusConfig({ peers: "*" });
    expect(result).toEqual({
      peers: "*",
      maxDepth: 3,
      port: 0,
      secret: expect.any(String),
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
  });

  it("parses peers list", () => {
    const result = parseBusConfig({ peers: ["work", "reviewer"] });
    expect(result).toEqual({
      peers: ["work", "reviewer"],
      maxDepth: 3,
      port: 0,
      secret: expect.any(String),
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
  });

  it("returns null for empty peers list", () => {
    expect(parseBusConfig({ peers: [] })).toBeNull();
  });

  it("respects custom maxDepth and port", () => {
    const result = parseBusConfig({ peers: "*", maxDepth: 5, port: 9200 });
    expect(result).toEqual({
      peers: "*",
      maxDepth: 5,
      port: 9200,
      secret: expect.any(String),
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
  });

  it("parses secret", () => {
    const result = parseBusConfig({ peers: "*", secret: "my-token" });
    expect(result).toEqual({
      peers: "*",
      maxDepth: 3,
      port: 0,
      secret: "my-token",
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
  });

  it("parses parallel, chain, and verifier", () => {
    const result = parseBusConfig({ peers: "*", parallel: ["sec-bot", "perf-bot"], chain: ["reviewer", "writer"], verifier: "reviewer" });
    expect(result).toEqual({
      peers: "*", maxDepth: 3, port: 0, secret: expect.any(String),
      parallel: ["sec-bot", "perf-bot"], chain: ["reviewer", "writer"], verifier: "reviewer", crew: null,
    });
  });

  it("parses crew config", () => {
    const result = parseBusConfig({
      peers: "*",
      crew: {
        enabled: true,
        workflow: "research-report",
        coordinator: "coordinator",
        roles: {
          researcher: "researcher",
          analyst: "analyst",
          writer: "writer",
          reviewer: "reviewer",
        },
        maxResearchQuestions: 4,
        maxRevisionRounds: 1,
      },
    });

    expect(result).toEqual({
      peers: "*",
      maxDepth: 3,
      port: 0,
      secret: expect.any(String),
      parallel: [],
      chain: [],
      verifier: null,
      crew: {
        enabled: true,
        workflow: "research-report",
        coordinator: "coordinator",
        roles: {
          researcher: "researcher",
          analyst: "analyst",
          writer: "writer",
          reviewer: "reviewer",
        },
        maxResearchQuestions: 4,
        maxRevisionRounds: 1,
      },
    });
  });

  it("rejects crew config when coordinator and specialist roles are not distinct", () => {
    expect(parseBusConfig({
      peers: "*",
      crew: {
        enabled: true,
        workflow: "research-report",
        coordinator: "coordinator",
        roles: {
          researcher: "coordinator",
          analyst: "analyst",
          writer: "writer",
          reviewer: "reviewer",
        },
      },
    })).toEqual({
      peers: "*",
      maxDepth: 3,
      port: 0,
      secret: expect.any(String),
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    });
  });

  it("returns null for peers: false", () => {
    expect(parseBusConfig({ peers: false })).toBeNull();
  });

  it("loadBusConfig returns null for non-object config roots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-config-"));

    try {
      await writeFile(path.join(tempDir, "config.json"), "null\n", "utf8");
      await expect(loadBusConfig(tempDir)).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("isPeerAllowed", () => {
  it("allows all peers with wildcard", () => {
    const config: BusConfig = { peers: "*", maxDepth: 3, port: 0, secret: "", parallel: [], chain: [], verifier: null, crew: null };
    expect(isPeerAllowed(config, "anything")).toBe(true);
  });

  it("allows listed peers", () => {
    const config: BusConfig = { peers: ["work", "reviewer"], maxDepth: 3, port: 0, secret: "", parallel: [], chain: [], verifier: null, crew: null };
    expect(isPeerAllowed(config, "work")).toBe(true);
    expect(isPeerAllowed(config, "reviewer")).toBe(true);
    expect(isPeerAllowed(config, "unknown")).toBe(false);
  });

  it("denies all when peers is false", () => {
    const config: BusConfig = { peers: false, maxDepth: 3, port: 0, secret: "", parallel: [], chain: [], verifier: null, crew: null };
    expect(isPeerAllowed(config, "work")).toBe(false);
  });
});

describe("bus registry", () => {
  it("registers, looks up, and deregisters instances", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    // lookupInstance now probes the registered port via TCP — start real
    // listeners so registered entries read as alive.
    const workServer = await listenOn(9100, "work");
    const reviewerServer = await listenOn(9101, "reviewer");
    try {
      await registerInstance(tempDir, "work", 9100, "secret-a");
      await registerInstance(tempDir, "reviewer", 9101, "secret-b");

      const work = await lookupInstance(tempDir, "work");
      expect(work).toEqual(expect.objectContaining({ port: 9100, pid: process.pid, secret: "secret-a" }));

      // listRegisteredInstances returns the raw registry (no liveness filter)
      const all = await listRegisteredInstances(tempDir);
      expect(all).toHaveLength(2);

      await deregisterInstance(tempDir, "work");
      expect(await lookupInstance(tempDir, "work")).toBeNull();
      expect(await lookupInstance(tempDir, "reviewer")).not.toBeNull();
    } finally {
      await workServer.close();
      await reviewerServer.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lookupInstance returns null when the registered port is not listening", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    try {
      // Register against port 9102 without starting a listener — simulates
      // a crashed bot that didn't deregister, or a PID-recycled corpse.
      await registerInstance(tempDir, "ghost", 9102, "secret-ghost");
      expect(await lookupInstance(tempDir, "ghost")).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lookupInstance returns null when a non-bus listener occupies the port", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    const impostor = await listenOnNonBus(9103);
    try {
      // Register against port 9103 — but the port is held by a plain TCP
      // service (not our bus). Must not be treated as alive: the caller
      // would POST the bus secret to a stranger.
      await registerInstance(tempDir, "hijacked", 9103, "secret-victim");
      expect(await lookupInstance(tempDir, "hijacked")).toBeNull();
    } finally {
      await impostor.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lookupInstance returns null when the port serves a different instance name", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    // Port 9104 is held by a bus server identifying as "someone-else" —
    // but the registry claims it belongs to "alpha". Reject.
    const wrongNameServer = await listenOn(9104, "someone-else");
    try {
      await registerInstance(tempDir, "alpha", 9104, "secret-alpha");
      expect(await lookupInstance(tempDir, "alpha")).toBeNull();
    } finally {
      await wrongNameServer.close();
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

  it("filters invalid registry entries but keeps valid ones", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    try {
      await writeFile(
        path.join(tempDir, ".bus-registry.json"),
        JSON.stringify({
          instances: {
            valid: {
              port: 9100,
              pid: process.pid,
              secret: "secret-valid",
              updatedAt: "2026-04-17T00:00:00.000Z",
            },
            invalid: {
              port: 9100.5,
              pid: "oops",
              secret: "secret-invalid",
              updatedAt: "2026-04-17T00:00:00.000Z",
            },
          },
        }),
        "utf8",
      );

      const registry = await readRegistry(tempDir);
      expect(registry.instances).toEqual({
        valid: {
          port: 9100,
          pid: process.pid,
          secret: "secret-valid",
          updatedAt: "2026-04-17T00:00:00.000Z",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not lose registrations when multiple instances register concurrently", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-registry-"));
    try {
      await Promise.all([
        registerInstance(tempDir, "alpha", 9201, "secret-a"),
        registerInstance(tempDir, "beta", 9202, "secret-b"),
      ]);

      const registry = await readRegistry(tempDir);
      expect(registry.instances).toEqual(expect.objectContaining({
        alpha: expect.objectContaining({ port: 9201, secret: "secret-a" }),
        beta: expect.objectContaining({ port: 9202, secret: "secret-b" }),
      }));
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
        expect(body.protocolVersion).toBe(BUS_PROTOCOL_VERSION);
        expect(body.capabilities).toEqual(BUS_PROTOCOL_CAPABILITIES);

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

  it("rejects requests with negative delegation depth", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-server-"));

    try {
      await writeFile(
        path.join(tempDir, "config.json"),
        JSON.stringify({ bus: { peers: "*", secret: "test-secret" } }),
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
          body: JSON.stringify({ fromInstance: "work", prompt: "hello", depth: -1 }),
        });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          success: false,
          error: "Invalid request body",
          protocolVersion: BUS_PROTOCOL_VERSION,
          errorCode: "invalid_request",
          retryable: false,
        });
      } finally {
        await stopBusServer(server);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns 500 when the handler returns an invalid bus response", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bus-server-"));

    try {
      await writeFile(
        path.join(tempDir, "config.json"),
        JSON.stringify({ bus: { peers: "*", secret: "test-secret" } }),
        "utf8",
      );

      const handler = async () => ({
        text: "missing success flag",
        fromInstance: "test",
      });

      const server = createBusServer("test", tempDir, handler as never);
      const port = await startBusServer(server, 0);

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/talk`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer test-secret" },
          body: JSON.stringify({ fromInstance: "work", prompt: "hello", depth: 0 }),
        });
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toMatchObject({
          success: false,
          error: "Handler returned invalid bus response",
          protocolVersion: BUS_PROTOCOL_VERSION,
          errorCode: "invalid_handler_response",
          retryable: true,
        });
      } finally {
        await stopBusServer(server);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("delegateToInstance", () => {
  it("rejects malformed bus responses", async () => {
    const channelRoot = await mkdtemp(path.join(os.tmpdir(), "bus-client-"));
    const stateDir = path.join(channelRoot, "work");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ bus: { peers: ["reviewer"], secret: "test-secret" } }),
      "utf8",
    );

    const server = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "cc-telegram-bridge", instance: "reviewer", status: "ok", pid: process.pid }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/talk") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "oops", fromInstance: "reviewer" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    try {
      await registerInstance(channelRoot, "reviewer", port, "test-secret");

      await expect(delegateToInstance({
        fromInstance: "work",
        targetInstance: "reviewer",
        prompt: "hello",
        depth: 0,
        stateDir,
      })).rejects.toThrow(/Invalid bus response/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it("maps non-JSON bus responses to invalid_response", async () => {
    const channelRoot = await mkdtemp(path.join(os.tmpdir(), "bus-client-"));
    const stateDir = path.join(channelRoot, "work");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ bus: { peers: ["reviewer"], secret: "test-secret" } }),
      "utf8",
    );

    const server = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "cc-telegram-bridge", instance: "reviewer", status: "ok", pid: process.pid }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/talk") {
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end("<html><body>bad gateway</body></html>");
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    try {
      await registerInstance(channelRoot, "reviewer", port, "test-secret");

      await expect(delegateToInstance({
        fromInstance: "work",
        targetInstance: "reviewer",
        prompt: "hello",
        depth: 0,
        stateDir,
      })).rejects.toMatchObject({
        name: "BusProtocolError",
        code: "invalid_response",
        retryable: true,
        fromInstance: "reviewer",
      } satisfies Partial<BusProtocolError>);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it("surfaces structured remote bus errors with code and retryability", async () => {
    const channelRoot = await mkdtemp(path.join(os.tmpdir(), "bus-client-"));
    const stateDir = path.join(channelRoot, "work");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ bus: { peers: ["reviewer"], secret: "test-secret" } }),
      "utf8",
    );

    const server = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "cc-telegram-bridge", instance: "reviewer", status: "ok", pid: process.pid }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/talk") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          text: "",
          fromInstance: "reviewer",
          error: "Budget exhausted",
          errorCode: "budget_exhausted",
          retryable: false,
          protocolVersion: BUS_PROTOCOL_VERSION,
          capabilities: BUS_PROTOCOL_CAPABILITIES,
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    try {
      await registerInstance(channelRoot, "reviewer", port, "test-secret");

      await expect(delegateToInstance({
        fromInstance: "work",
        targetInstance: "reviewer",
        prompt: "hello",
        depth: 0,
        stateDir,
      })).rejects.toMatchObject({
        name: "BusProtocolError",
        message: "Budget exhausted",
        code: "budget_exhausted",
        retryable: false,
        fromInstance: "reviewer",
      } satisfies Partial<BusProtocolError>);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(channelRoot, { recursive: true, force: true });
    }
  });

  it("wraps transport-level fetch failures as retryable BusProtocolError instances", async () => {
    const channelRoot = await mkdtemp(path.join(os.tmpdir(), "bus-client-"));
    const stateDir = path.join(channelRoot, "work");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({ bus: { peers: ["reviewer"], secret: "test-secret" } }),
      "utf8",
    );
    await writeFile(
      path.join(channelRoot, ".bus-registry.json"),
      JSON.stringify({
        instances: {
          reviewer: {
            port: 9109,
            pid: process.pid,
            secret: "test-secret",
            updatedAt: "2026-04-19T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ kind: "cc-telegram-bridge", instance: "reviewer", status: "ok", pid: process.pid }),
      })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(delegateToInstance({
        fromInstance: "work",
        targetInstance: "reviewer",
        prompt: "hello",
        depth: 0,
        stateDir,
      })).rejects.toMatchObject({
        name: "BusProtocolError",
        code: "instance_unavailable",
        retryable: true,
        fromInstance: "reviewer",
      } satisfies Partial<BusProtocolError>);
    } finally {
      await rm(channelRoot, { recursive: true, force: true });
    }
  });
});
