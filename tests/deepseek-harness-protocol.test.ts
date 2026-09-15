import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

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
  cookie?: string;
};

type RemoteOpenMessage = {
  type: "open";
  streamId: string;
  endpoint: string;
  payload: unknown;
};

class ProtocolServer {
  readonly requests: RecordedRequest[] = [];
  readonly authenticationRequests: string[] = [];
  readonly websocketServer = new WebSocketServer({ noServer: true });
  readonly sockets = new Map<string, WebSocket>();
  readonly heldUpgradeSockets = new Set<Duplex>();
  readonly heldUpgradePaths = new Set<string>();
  readonly connectionCounts = new Map<string, number>();
  readonly remoteMessages: Record<string, unknown>[] = [];
  readonly remoteStreams = new Map<string, string>();
  readonly server = createServer((request, response) => {
    void this.handleHttp(request, response);
  });
  responseFor: (path: string, body: Record<string, unknown>) => unknown = (_path, body) => ({
    type: "server-response",
    rpcId: body.rpcId,
    result: { ok: true, value: {} },
  });
  controlBaseline: Record<string, unknown> = { queues: {}, jobs: {}, projections: {} };
  autoFollowSnapshots = true;
  followSnapshotFor: (sessionId: string) => Record<string, unknown> = (sessionId) => ({
    type: "snapshot",
    header: { version: 0, id: sessionId, createdAt: 1, cwd: "/tmp/workspace" },
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
  });
  private authentication: { launchToken: string; cookie: string } | undefined;

  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      if (this.authentication && request.headers.cookie !== this.authentication.cookie) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const allowedPaths = this.authentication
        ? ["/api/remote.mux"]
        : ["/api/events.mux", "/api/events.host"];
      if (!allowedPaths.includes(pathname)) {
        socket.destroy();
        return;
      }
      if (this.heldUpgradePaths.has(pathname)) {
        this.heldUpgradeSockets.add(socket);
        socket.once("close", () => this.heldUpgradeSockets.delete(socket));
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.sockets.set(pathname, websocket);
        this.connectionCounts.set(pathname, (this.connectionCounts.get(pathname) ?? 0) + 1);
        if (pathname === "/api/remote.mux") {
          websocket.on("message", (data) => this.handleRemoteMessage(websocket, data.toString("utf8")));
        }
        this.websocketServer.emit("connection", websocket, request);
      });
    });
  }

  requireAuthentication(launchToken: string, cookie: string): void {
    this.authentication = { launchToken, cookie };
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async waitForSockets(): Promise<void> {
    await vi.waitFor(() => {
      if (this.authentication) {
        expect(this.sockets.has("/api/remote.mux")).toBe(true);
      } else {
        expect(this.sockets.has("/api/events.mux")).toBe(true);
        expect(this.sockets.has("/api/events.host")).toBe(true);
      }
    });
  }

  async waitForConnectionCount(pathname: string, count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.connectionCounts.get(pathname)).toBe(count);
    });
  }

  send(pathname: string, payload: unknown): void {
    const socket = this.sockets.get(pathname);
    if (!socket) {
      throw new Error(`No socket connected for ${pathname}`);
    }
    socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  async waitForRemoteStream(endpoint: string): Promise<string> {
    await vi.waitFor(() => expect(this.remoteStreams.has(endpoint)).toBe(true));
    return this.remoteStreams.get(endpoint)!;
  }

  sendRemote(endpoint: string, value: unknown): void {
    const streamId = this.remoteStreams.get(endpoint);
    if (!streamId) {
      throw new Error(`No remote stream connected for ${endpoint}`);
    }
    this.send("/api/remote.mux", { type: "item", streamId, value });
  }

  async close(): Promise<void> {
    for (const socket of this.heldUpgradeSockets) {
      socket.destroy();
    }
    for (const socket of this.sockets.values()) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => this.websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (this.authentication && request.method === "GET" && requestUrl.pathname === "/") {
      this.authenticationRequests.push(request.url ?? "/");
      if (requestUrl.searchParams.getAll("token").length === 1
        && requestUrl.searchParams.get("token") === this.authentication.launchToken) {
        response.writeHead(303, {
          location: "/",
          "set-cookie": `${this.authentication.cookie}; Path=/; HttpOnly; SameSite=Strict`,
        });
        response.end();
        return;
      }
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    if (this.authentication && request.headers.cookie !== this.authentication.cookie) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const path = request.url ?? "/";
    this.requests.push({ path, body, cookie: request.headers.cookie });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(this.responseFor(path, body)));
  }

  private handleRemoteMessage(websocket: WebSocket, raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.remoteMessages.push(message);
    if (message.type !== "open") {
      return;
    }
    const open = message as RemoteOpenMessage;
    this.remoteStreams.set(open.endpoint, open.streamId);
    if (open.endpoint === "$events") {
      websocket.send(JSON.stringify({
        type: "item",
        streamId: open.streamId,
        value: { type: "ready", clientId: "client-1", host: { home: "/Users/example" } },
      }));
    } else if (open.endpoint === "session/control") {
      websocket.send(JSON.stringify({
        type: "item",
        streamId: open.streamId,
        value: {
          type: "baseline",
          value: this.controlBaseline,
        },
      }));
    } else if (open.endpoint === "session/follow" && this.autoFollowSnapshots) {
      const payload = open.payload as {
        args?: { request?: { address?: { sessionId?: string } } };
      };
      const sessionId = payload.args?.request?.address?.sessionId ?? "session-1";
      websocket.send(JSON.stringify({
        type: "item",
        streamId: open.streamId,
        value: this.followSnapshotFor(sessionId),
      }));
    }
  }
}

const servers: ProtocolServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("DeepSeekHarnessProtocolClient", () => {
  it("exchanges a launch token for one cookie shared by HTTP and WebSocket transports", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const launchToken = "temporary-launch-token-123";
    const cookie = "dsh_browser_session=test-session-cookie";
    server.requireAuthentication(launchToken, cookie);
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=${launchToken}`);

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    await server.waitForSockets();
    await expect(client.request("session.list", {})).resolves.toEqual({});

    expect(server.authenticationRequests).toEqual([`/?token=${launchToken}`]);
    expect(server.requests).toEqual([
      expect.objectContaining({
        path: "/api/session/list",
        cookie,
        body: expect.objectContaining({
          method: "session/list",
          payload: { args: { _request: {} } },
        }),
      }),
    ]);
    expect(server.connectionCounts.get("/api/remote.mux")).toBe(1);
    expect(server.remoteMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "open", endpoint: "$events", payload: { args: {} } }),
      expect.objectContaining({ type: "open", endpoint: "session/control", payload: { args: {} } }),
    ]));

    await client.close();
  });

  it("exchanges the launch token again and retries one HTTP request after a cookie 401", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const launchToken = "rotating-launch-token";
    const firstCookie = "dsh_browser_session=first-cookie";
    const secondCookie = "dsh_browser_session=second-cookie";
    server.requireAuthentication(launchToken, firstCookie);
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=${launchToken}`);

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    server.requireAuthentication(launchToken, secondCookie);

    await expect(client.request("session.list", {})).resolves.toEqual({});
    expect(server.authenticationRequests).toEqual([
      `/?token=${launchToken}`,
      `/?token=${launchToken}`,
    ]);
    expect(server.requests).toEqual([
      expect.objectContaining({ path: "/api/session/list", cookie: secondCookie }),
    ]);

    await client.close();
  });

  it("projects the modern model catalog and per-session selection into the legacy adapter contract", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.requireAuthentication("launch-token", "dsh_browser_session=model-test");
    server.followSnapshotFor = (sessionId) => ({
      type: "snapshot",
      header: { version: 0, id: sessionId, createdAt: 1 },
      cursor: 4,
      records: [],
      hasMore: false,
      projections: {
        asOfSeq: 4,
        values: {
          modelSelection: {
            lastUsed: { provider: "deepseek-official", model: "deepseek-v4-flash" },
            next: {
              provider: "deepseek-official",
              model: "deepseek-v4.1-flash-expires-on-0910",
              reasoningEffort: "high",
            },
          },
        },
      },
    });
    server.responseFor = (path, body) => ({
      type: "server-response",
      rpcId: body.rpcId,
      result: {
        ok: true,
        value: path === "/api/session/modelCatalog"
          ? {
              default: { provider: "deepseek-official", model: "deepseek-v4-flash" },
              routableProviders: ["deepseek-official"],
              groups: [{ id: "deepseek-official", name: "DeepSeek", models: [] }],
              failures: [],
            }
          : {},
      },
    });
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=launch-token`);

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    await expect(client.request("session.models", { sessionId: "session-1" })).resolves.toMatchObject({
      current: {
        provider: "deepseek-official",
        model: "deepseek-v4.1-flash-expires-on-0910",
        reasoningEffort: "high",
      },
      routable: true,
      groups: [{ id: "deepseek-official" }],
      failures: [],
    });
    expect(server.requests.at(-1)).toMatchObject({
      path: "/api/session/modelCatalog",
      body: { method: "session/modelCatalog", payload: { args: {} } },
    });

    await client.close();
  });

  it("translates modern prompt and model-selection requests and mints a prompt request id", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.requireAuthentication("launch-token", "dsh_browser_session=request-test");
    server.responseFor = (_path, body) => ({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: true, value: { accepted: true } },
    });
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=launch-token`);

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    await client.request("session.selectModel", {
      sessionId: "session-1",
      provider: "deepseek-official",
      model: "deepseek-v4.1-flash-expires-on-0910",
      reasoningEffort: "high",
    });
    await client.request("session.prompt", {
      sessionId: "session-1",
      content: [{ type: "text", text: "ping" }],
    });

    expect(server.requests[0]).toMatchObject({
      path: "/api/session/selectModel",
      body: {
        method: "session/selectModel",
        payload: {
          args: {
            request: {
              sessionId: "session-1",
              provider: "deepseek-official",
              model: "deepseek-v4.1-flash-expires-on-0910",
              reasoningEffort: "high",
            },
          },
        },
      },
    });
    expect(server.requests[1]).toMatchObject({
      path: "/api/session/prompt",
      body: {
        method: "session/prompt",
        payload: {
          args: {
            request: {
              requestId: expect.any(String),
              sessionId: "session-1",
              content: [{ type: "text", text: "ping" }],
            },
          },
        },
      },
    });

    await client.close();
  });

  it("maps modern follow and control streams into legacy history and live frames", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.requireAuthentication("launch-token", "dsh_browser_session=stream-test");
    server.controlBaseline = {
      queues: {},
      jobs: {
        "session-1": [{
          id: "job-1",
          kind: "task",
          label: "Indexing",
          status: "running",
          startedAt: 1,
        }],
      },
      projections: {
        "session-1": { asOfSeq: 3, values: { goal: { phase: "active" } } },
      },
    };
    const firstEvent = {
      type: "event",
      event: { type: "turn/start", seq: 4, time: 4, data: { turn: 1 } },
    };
    server.followSnapshotFor = (sessionId) => ({
      type: "snapshot",
      header: { version: 0, id: sessionId, createdAt: 1 },
      cursor: 4,
      records: [firstEvent],
      hasMore: true,
      projections: { asOfSeq: 3, values: { goal: { phase: "active" } } },
    });
    const frames: DeepSeekHarnessServerRequest[] = [];
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=launch-token`);

    await client.connect({
      onMuxFrame: (frame) => {
        frames.push(frame);
      },
      onHostFrame: (frame) => {
        frames.push(frame);
      },
    });
    await expect(client.request("session.history", {
      sessionId: "session-1",
      maxMessages: 50,
    })).resolves.toEqual({
      events: [firstEvent],
      hasMore: true,
      projections: { asOfSeq: 3, values: { goal: { phase: "active" } } },
    });
    server.sendRemote("session/follow", {
      type: "event",
      event: { type: "assistant/message", seq: 5, time: 5, data: { turn: 1 } },
    });
    server.sendRemote("session/control", {
      type: "jobs",
      sessionId: "session-1",
      jobs: [],
    });
    server.sendRemote("session/control", {
      type: "projection",
      sessionId: "session-1",
      key: "goal",
      value: { phase: "complete" },
      seq: 6,
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.payload.type === "session/event")).toBe(true);
      expect(frames.some((frame) => (
        frame.payload.type === "session/jobs" && Array.isArray(frame.payload.jobs) && frame.payload.jobs.length === 0
      ))).toBe(true);
      expect(frames.some((frame) => (
        frame.payload.type === "session/projection" && frame.payload.seq === 6
      ))).toBe(true);
    });
    expect(frames.find((frame) => frame.payload.type === "session/event")?.payload).toMatchObject({
      sessionId: "session-1",
      event: { type: "assistant/message", seq: 5 },
    });

    await client.close();
  });

  it("does not let a late follow snapshot roll projections back behind control updates", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.requireAuthentication("launch-token", "dsh_browser_session=projection-race-test");
    server.autoFollowSnapshots = false;
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=launch-token`);

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    const history = client.request("session.history", { sessionId: "session-1" });
    await server.waitForRemoteStream("session/follow");
    server.sendRemote("session/control", {
      type: "projection",
      sessionId: "session-1",
      key: "modelSelection",
      value: {
        lastUsed: null,
        next: { provider: "deepseek-official", model: "new-model" },
      },
      seq: 8,
    });
    server.sendRemote("session/follow", {
      type: "snapshot",
      header: { version: 0, id: "session-1", createdAt: 1 },
      cursor: 7,
      records: [],
      hasMore: false,
      projections: {
        asOfSeq: 7,
        values: {
          modelSelection: {
            lastUsed: null,
            next: { provider: "deepseek-official", model: "old-model" },
          },
        },
      },
    });

    await expect(history).resolves.toMatchObject({
      projections: {
        asOfSeq: 8,
        values: {
          modelSelection: {
            next: { provider: "deepseek-official", model: "new-model" },
          },
        },
      },
    });

    await client.close();
  });

  it("maps modern approval and question waterfalls back through the event-result endpoint", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.requireAuthentication("launch-token", "dsh_browser_session=waterfall-test");
    const frames: DeepSeekHarnessServerRequest[] = [];
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=launch-token`);

    await client.connect({
      onMuxFrame: (frame) => {
        frames.push(frame);
      },
      onHostFrame: () => {},
    });
    server.sendRemote("$events", {
      type: "waterfall",
      event: "approval/request",
      eventId: "approval-event",
      agentId: "session-1",
      request: { toolName: "exec", callId: "call-1", reason: "run a command" },
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({
      rpcId: "approval-event",
      method: "approval/requested",
      payload: {
        type: "approval/requested",
        sessionId: "session-1",
        approvalId: "approval-event",
        toolName: "exec",
      },
    });
    await expect(client.respond("approval-event", {
      sessionId: "session-1",
      approvalId: "approval-event",
      outcome: "allowed-once",
    })).resolves.toEqual({ accepted: true });
    expect(server.requests.at(-1)).toMatchObject({
      path: "/api/$events/result",
      body: {
        method: "$events/result",
        payload: {
          args: {
            clientId: "client-1",
            eventId: "approval-event",
            outcome: { kind: "result", value: "allowed-once" },
          },
        },
      },
    });

    server.sendRemote("$events", {
      type: "waterfall",
      event: "user-questions/request",
      eventId: "question-event",
      agentId: "session-1",
      request: {
        questions: [{ id: "choice", question: "Choose", options: [{ label: "A" }] }],
      },
    });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]?.payload).toMatchObject({
      type: "question/requested",
      sessionId: "session-1",
      questions: [{ id: "choice" }],
    });
    const answer = { answers: [{ id: "choice", selected: ["A"] }] };
    await expect(client.respond("question-event", { sessionId: "session-1", answer }))
      .resolves.toEqual({ accepted: true });
    expect(server.requests.at(-1)).toMatchObject({
      path: "/api/$events/result",
      body: {
        payload: {
          args: {
            clientId: "client-1",
            eventId: "question-event",
            outcome: { kind: "result", value: answer },
          },
        },
      },
    });

    await client.close();
  });

  it("reopens modern event, control, and followed-session streams after transport loss", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    server.requireAuthentication("launch-token", "dsh_browser_session=reconnect-test");
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=launch-token`, {
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {}, onDisconnect, onReconnect });
    await client.request("session.history", { sessionId: "session-1" });
    server.sockets.get("/api/remote.mux")!.terminate();

    await server.waitForConnectionCount("/api/remote.mux", 2);
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(server.remoteMessages.filter((message) => message.endpoint === "$events")).toHaveLength(2);
    expect(server.remoteMessages.filter((message) => message.endpoint === "session/control")).toHaveLength(2);
    expect(server.remoteMessages.filter((message) => message.endpoint === "session/follow")).toHaveLength(2);

    await client.close();
  });

  it("re-authenticates a modern mux after its session cookie is rejected", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const launchToken = "reconnect-launch-token";
    server.requireAuthentication(launchToken, "dsh_browser_session=expired-cookie");
    const onReconnect = vi.fn();
    const client = new DeepSeekHarnessProtocolClient(`${baseUrl}/?token=${launchToken}`, {
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    await client.connect({ onMuxFrame: () => {}, onHostFrame: () => {}, onReconnect });
    await server.waitForSockets();
    server.requireAuthentication(launchToken, "dsh_browser_session=fresh-cookie");
    server.sockets.get("/api/remote.mux")!.terminate();

    await server.waitForConnectionCount("/api/remote.mux", 2);
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(server.authenticationRequests).toEqual([
      `/?token=${launchToken}`,
      `/?token=${launchToken}`,
    ]);

    await client.close();
  });

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
        submittedAttachments: [],
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
            submittedAttachments: [],
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

  it("ignores frames emitted by a superseded downlink generation", async () => {
    const server = new ProtocolServer();
    servers.push(server);
    const baseUrl = await server.listen();
    const delivered: string[] = [];
    const client = new DeepSeekHarnessProtocolClient(baseUrl, {
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    await client.connect({
      onMuxFrame: (frame) => {
        delivered.push(frame.rpcId);
      },
      onHostFrame: () => {},
    });
    await server.waitForSockets();
    const firstMux = (client as unknown as {
      generation?: { mux: WebSocket };
    }).generation!.mux;
    server.sockets.get("/api/events.host")!.terminate();
    await server.waitForConnectionCount("/api/events.mux", 2);
    await server.waitForConnectionCount("/api/events.host", 2);

    firstMux.emit("message", Buffer.from(JSON.stringify({
      type: "server-request",
      rpcId: "stale-mux-frame",
      method: "session/event",
      payload: { type: "session/event", sessionId: "session-1" },
    }), "utf8"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(delivered).toEqual([]);
    await client.close();
  });

  it("rejects an in-flight connection when closed before both downlinks open", async () => {
    const server = new ProtocolServer();
    server.heldUpgradePaths.add("/api/events.host");
    servers.push(server);
    const baseUrl = await server.listen();
    const client = new DeepSeekHarnessProtocolClient(baseUrl);

    const connecting = client.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
    });
    const connectionOutcome = connecting.then(() => "resolved", () => "rejected");
    await vi.waitFor(() => expect(server.sockets.has("/api/events.mux")).toBe(true));

    await client.close();
    const outcome = await Promise.race([
      connectionOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(outcome).toBe("rejected");
  });

  it("times out when one downlink never completes its websocket upgrade", async () => {
    const server = new ProtocolServer();
    server.heldUpgradePaths.add("/api/events.host");
    servers.push(server);
    const baseUrl = await server.listen();
    const client = new DeepSeekHarnessProtocolClient(baseUrl, {
      connectTimeoutMs: 25,
    });

    const connecting = client.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
    });

    await expect(connecting).rejects.toThrow(/downlinks.*25ms/i);
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
