import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  DeepSeekHarnessProtocolClient,
  DeepSeekHarnessRpcError,
  type DeepSeekHarnessServerRequest,
} from "../src/codex/deepseek-harness-protocol.js";

type RecordedRequest = {
  path: string;
  body: Record<string, unknown>;
};

class ProtocolServer {
  readonly requests: RecordedRequest[] = [];
  readonly websocketServer = new WebSocketServer({ noServer: true });
  readonly sockets = new Map<string, WebSocket>();
  readonly connectionCounts = new Map<string, number>();
  readonly server = createServer((request, response) => {
    void this.handleHttp(request, response);
  });
  responseFor: (path: string, body: Record<string, unknown>) => unknown = (_path, body) => ({
    type: "server-response",
    rpcId: body.rpcId,
    result: { ok: true, value: {} },
  });

  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/api/events.mux" && pathname !== "/api/events.host") {
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.sockets.set(pathname, websocket);
        this.connectionCounts.set(pathname, (this.connectionCounts.get(pathname) ?? 0) + 1);
        this.websocketServer.emit("connection", websocket, request);
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async waitForSockets(): Promise<void> {
    await vi.waitFor(() => {
      expect(this.sockets.has("/api/events.mux")).toBe(true);
      expect(this.sockets.has("/api/events.host")).toBe(true);
    });
  }

  async waitForConnectionCount(pathname: "/api/events.mux" | "/api/events.host", count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.connectionCounts.get(pathname)).toBe(count);
    });
  }

  send(pathname: "/api/events.mux" | "/api/events.host", payload: unknown): void {
    const socket = this.sockets.get(pathname);
    if (!socket) {
      throw new Error(`No socket connected for ${pathname}`);
    }
    socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.values()) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => this.websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const path = request.url ?? "/";
    this.requests.push({ path, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(this.responseFor(path, body)));
  }
}

const servers: ProtocolServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("DeepSeekHarnessProtocolClient", () => {
  it("uses the official HTTP request envelope and validates the echoed rpc id", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.responseFor = (_path, body) => ({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [{ sessionId: "session-1" }] } },
    });
    const client = new DeepSeekHarnessProtocolClient(baseUrl);

    await expect(client.request("session.list", { cursor: "next" })).resolves.toEqual({
      items: [{ sessionId: "session-1" }],
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe("/api/session.list");
    expect(server.requests[0]?.body).toMatchObject({
      type: "client-request",
      method: "session.list",
      payload: { cursor: "next" },
    });
    expect(server.requests[0]?.body.rpcId).toEqual(expect.any(String));

    await client.close();
  });

  it("calls generated Remote endpoints through their slash-separated API path", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.responseFor = (_path, body) => ({
      type: "server-response",
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: {
          commandId: "command-1",
          result: { kind: "success", text: "Permission preset: full-auto" },
        },
      },
    });
    const client = new DeepSeekHarnessProtocolClient(baseUrl);

    await expect(client.request("commands/execute", {
      args: {
        agentId: "session-1",
        line: "/permission full-auto",
        images: [],
      },
    })).resolves.toMatchObject({
      commandId: "command-1",
      result: { kind: "success" },
    });
    expect(server.requests[0]).toMatchObject({
      path: "/api/commands/execute",
      body: {
        method: "commands/execute",
        payload: {
          args: {
            agentId: "session-1",
            line: "/permission full-auto",
            images: [],
          },
        },
      },
    });

    await client.close();
  });

  it("rejects unsafe RPC endpoint paths before issuing a request", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const client = new DeepSeekHarnessProtocolClient(baseUrl);

    await expect(client.request("commands/../session.list", {}))
      .rejects.toThrow("Invalid DeepSeek Harness RPC method");
    expect(server.requests).toHaveLength(0);

    await client.close();
  });

  it("surfaces business failures as typed rpc errors without losing their code", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.responseFor = (_path, body) => ({
      type: "server-response",
      rpcId: body.rpcId,
      result: {
        ok: false,
        error: { code: "agent-busy", message: "session is busy", details: { retryable: true } },
      },
    });
    const client = new DeepSeekHarnessProtocolClient(baseUrl);

    const request = client.request("session.cancel", { sessionId: "session-1" });
    await expect(request).rejects.toBeInstanceOf(DeepSeekHarnessRpcError);
    await expect(request).rejects.toMatchObject({
      code: "agent-busy",
      message: "session is busy",
      details: { retryable: true },
    });

    await client.close();
  });

  it("drops malformed downlink frames but continues delivering valid mux and host events", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const mux: DeepSeekHarnessServerRequest[] = [];
    const host: DeepSeekHarnessServerRequest[] = [];
    const malformed: unknown[] = [];
    const client = new DeepSeekHarnessProtocolClient(baseUrl, {
      onMalformedFrame: (error) => malformed.push(error),
    });

    await client.connect({
      onMuxFrame: (frame) => {
        mux.push(frame);
      },
      onHostFrame: (frame) => {
        host.push(frame);
      },
    });
    await server.waitForSockets();
    server.send("/api/events.mux", "not-json");
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "mux-1",
      method: "session/subscribed",
      payload: { type: "session/subscribed", sessionId: "session-1", lastSeq: 4 },
    });
    server.send("/api/events.host", {
      type: "server-request",
      rpcId: "host-1",
      method: "host/status",
      payload: { type: "host/status", status: "ready", futureField: true },
    });

    await vi.waitFor(() => {
      expect(malformed).toHaveLength(1);
      expect(mux).toHaveLength(1);
      expect(host).toHaveLength(1);
    });
    expect(mux[0]).toMatchObject({ rpcId: "mux-1", method: "session/subscribed" });
    expect(host[0]).toMatchObject({ rpcId: "host-1", payload: { futureField: true } });

    await client.close();
  });

  it("contains rejected downlink handlers and keeps the event stream usable", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const handlerErrors: unknown[] = [];
    const delivered: string[] = [];
    const client = new DeepSeekHarnessProtocolClient(baseUrl, {
      onHandlerError: (error) => handlerErrors.push(error),
    });

    await client.connect({
      onMuxFrame: async (frame) => {
        if (frame.rpcId === "mux-broken") {
          throw new Error("consumer failed");
        }
        delivered.push(frame.rpcId);
      },
      onHostFrame: () => {},
    });
    await server.waitForSockets();
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "mux-broken",
      method: "session/event",
      payload: { type: "session/event", sessionId: "session-1" },
    });
    server.send("/api/events.mux", {
      type: "server-request",
      rpcId: "mux-good",
      method: "session/event",
      payload: { type: "session/event", sessionId: "session-1" },
    });

    await vi.waitFor(() => {
      expect(handlerErrors).toHaveLength(1);
      expect(delivered).toEqual(["mux-good"]);
    });
    expect(handlerErrors[0]).toMatchObject({ message: "consumer failed" });

    await client.close();
  });

  it("answers approval and question server requests with a client-response receipt", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.responseFor = (path) => path === "/api/respond"
      ? { accepted: true }
      : { type: "server-response", rpcId: "unused", result: { ok: true, value: {} } };
    const client = new DeepSeekHarnessProtocolClient(baseUrl);

    await expect(client.respond("approval-rpc", {
      sessionId: "session-1",
      approvalId: "approval-1",
      outcome: "allowed-once",
    })).resolves.toEqual({ accepted: true });
    expect(server.requests[0]).toEqual({
      path: "/api/respond",
      body: {
        type: "client-response",
        rpcId: "approval-rpc",
        result: {
          ok: true,
          value: {
            sessionId: "session-1",
            approvalId: "approval-1",
            outcome: "allowed-once",
          },
        },
      },
    });

    await client.close();
  });

  it("reconnects both downlinks after a socket loss and reports a transport reconnect", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    const client = new DeepSeekHarnessProtocolClient(baseUrl, {
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    await client.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
      onDisconnect,
      onReconnect,
    });
    await server.waitForSockets();
    server.sockets.get("/api/events.mux")!.terminate();

    await server.waitForConnectionCount("/api/events.mux", 2);
    await server.waitForConnectionCount("/api/events.host", 2);
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledWith({ reason: "transport" });

    await client.close();
  });

  it("drops and retries a reconnected downlink when adapter recovery rejects", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn()
      .mockRejectedValueOnce(new Error("replay failed"))
      .mockResolvedValue(undefined);
    const client = new DeepSeekHarnessProtocolClient(baseUrl, {
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    await client.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
      onDisconnect,
      onReconnect,
    });
    await server.waitForSockets();
    server.sockets.get("/api/events.mux")!.terminate();

    await server.waitForConnectionCount("/api/events.mux", 3);
    await server.waitForConnectionCount("/api/events.host", 3);
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(2));
    expect(onDisconnect).toHaveBeenCalledTimes(2);

    await client.close();
  });
});
