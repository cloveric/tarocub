import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";
import { z } from "zod";

const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
}).passthrough();

const serverResponseSchema = z.object({
  type: z.literal("server-response"),
  rpcId: z.string().min(1),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown().optional() }).passthrough(),
    z.object({ ok: z.literal(false), error: rpcErrorSchema }).passthrough(),
  ]),
}).passthrough();

const serverRequestSchema = z.object({
  type: z.literal("server-request"),
  rpcId: z.string().min(1),
  method: z.string().min(1),
  payload: z.object({ type: z.string().min(1) }).passthrough(),
}).passthrough().refine(
  (message) => message.method === message.payload.type,
  { message: "server-request method must match payload.type" },
);

const rpcReceiptSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true) }).passthrough(),
  z.object({
    accepted: z.literal(false),
    reason: z.enum(["not-pending", "bad-response"]),
  }).passthrough(),
]);

const remoteStreamServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("item"),
    streamId: z.string().min(1),
    value: z.unknown().optional(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    streamId: z.string().min(1),
    error: rpcErrorSchema.extend({ details: z.record(z.string(), z.unknown()) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("end"),
    streamId: z.string().min(1),
  }).strict(),
]);

const rpcMethodSegmentPattern = /^[A-Za-z0-9_$.-]+$/;

export interface DeepSeekHarnessServerRequest {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: { type: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface DeepSeekHarnessProtocolHandlers {
  onMuxFrame: (frame: DeepSeekHarnessServerRequest) => void | Promise<void>;
  onHostFrame: (frame: DeepSeekHarnessServerRequest) => void | Promise<void>;
  onDisconnect?: (error?: Error) => void | Promise<void>;
  onReconnect?: (info: DeepSeekHarnessReconnectInfo) => void | Promise<void>;
}

export interface DeepSeekHarnessReconnectInfo {
  reason: "transport" | "host-restart";
}

export interface DeepSeekHarnessProtocolOptions {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onMalformedFrame?: (error: unknown, raw: string) => void;
  onHandlerError?: (error: unknown) => void;
}

interface LegacyDownlinkGeneration {
  mode: "legacy";
  id: number;
  mux: WebSocket;
  host: WebSocket;
  open: Set<"mux" | "host">;
  settled: boolean;
  connectTimer?: ReturnType<typeof setTimeout>;
  cancelConnection?: (error: Error) => void;
}

interface RemoteFollowSnapshot {
  type: "snapshot";
  header: Record<string, unknown>;
  cursor: number;
  records: unknown[];
  hasMore: boolean;
  projections: {
    asOfSeq: number;
    values: Record<string, unknown>;
  };
}

interface RemoteFollowState {
  streamId: string;
  sessionId: string;
  promise: Promise<RemoteFollowSnapshot>;
  resolve: (snapshot: RemoteFollowSnapshot) => void;
  reject: (error: Error) => void;
  snapshot?: RemoteFollowSnapshot;
}

interface RemoteStreamRegistration {
  kind: "events" | "control" | "follow";
  sessionId?: string;
}

interface RemoteMuxGeneration {
  mode: "remote";
  id: number;
  mux: WebSocket;
  sessionCookie?: string;
  streams: Map<string, RemoteStreamRegistration>;
  follows: Map<string, RemoteFollowState>;
  settled: boolean;
  connectTimer?: ReturnType<typeof setTimeout>;
  cancelConnection?: (error: Error) => void;
  eventClientId?: string;
}

type DownlinkGeneration = LegacyDownlinkGeneration | RemoteMuxGeneration;

interface PendingRemoteWaterfall {
  clientId: string;
  eventId: string;
  event: "approval/request" | "user-questions/request";
}

export class DeepSeekHarnessRpcError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(input: { code: string; message: string; details?: unknown }) {
    super(input.message);
    this.name = "DeepSeekHarnessRpcError";
    this.code = input.code;
    this.details = input.details;
  }
}

export class DeepSeekHarnessProtocolClient {
  private readonly baseUrl: URL;
  private readonly launchUrl: URL | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly onMalformedFrame?: (error: unknown, raw: string) => void;
  private readonly onHandlerError?: (error: unknown) => void;
  private handlers: DeepSeekHarnessProtocolHandlers | undefined;
  private generation: DownlinkGeneration | undefined;
  private generationId = 0;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private authenticationPromise: Promise<void> | undefined;
  private sessionCookie: string | undefined;
  private readonly followedSessions = new Set<string>();
  private readonly remoteWaterfalls = new Map<string, PendingRemoteWaterfall>();
  private readonly remoteProjections = new Map<string, RemoteFollowSnapshot["projections"]>();
  private closing = false;

  constructor(baseUrl: string | URL, options: DeepSeekHarnessProtocolOptions = {}) {
    const parsedUrl = new URL(baseUrl);
    const launchTokens = parsedUrl.searchParams.getAll("token");
    const hasUnexpectedQuery = [...parsedUrl.searchParams.keys()].some((key) => key !== "token");
    if (
      hasUnexpectedQuery
      || launchTokens.length > 1
      || (launchTokens.length === 1 && launchTokens[0] === "")
    ) {
      throw new Error("Invalid authenticated DeepSeek Harness startup URL");
    }
    this.launchUrl = launchTokens.length === 1 ? new URL(parsedUrl) : undefined;
    parsedUrl.pathname = "/";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    this.baseUrl = parsedUrl;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.connectTimeoutMs = Math.max(1, Math.trunc(options.connectTimeoutMs ?? 15_000));
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 250;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 5_000;
    this.reconnectDelayMs = this.reconnectInitialDelayMs;
    this.onMalformedFrame = options.onMalformedFrame;
    this.onHandlerError = options.onHandlerError;
  }

  async request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const segments = method.split("/");
    if (
      !method
      || segments.some((segment) => (
        !segment
        || segment === "."
        || segment === ".."
        || !rpcMethodSegmentPattern.test(segment)
      ))
    ) {
      throw new Error(`Invalid DeepSeek Harness RPC method: ${JSON.stringify(method)}`);
    }
    if (this.launchUrl) {
      return await this.requestRemote(method, payload, signal);
    }
    return await this.requestRaw(method, payload, signal);
  }

  private async requestRaw(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const rpcId = randomUUID();
    const envelope = { type: "client-request", rpcId, method, payload } as const;
    const response = await this.postJson(`/api/${method}`, envelope, signal);
    const parsed = serverResponseSchema.parse(await response.json());
    if (parsed.rpcId !== rpcId) {
      throw new Error(`DeepSeek Harness rpcId mismatch for ${method}: sent ${rpcId}, got ${parsed.rpcId}`);
    }
    if (!parsed.result.ok) {
      throw new DeepSeekHarnessRpcError(parsed.result.error);
    }
    return parsed.result.value;
  }

  async respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<z.infer<typeof rpcReceiptSchema>> {
    if (this.launchUrl) {
      return await this.respondRemote(rpcId, { kind: "result", value }, signal);
    }
    const envelope = {
      type: "client-response",
      rpcId,
      result: { ok: true, value },
    } as const;
    const response = await this.postJson("/api/respond", envelope, signal);
    return rpcReceiptSchema.parse(await response.json());
  }

  async respondError(
    rpcId: string,
    error: { code: string; message: string; details?: unknown },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof rpcReceiptSchema>> {
    if (this.launchUrl) {
      return await this.respondRemote(rpcId, {
        kind: "rejected",
        error: {
          name: "Error",
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      }, signal);
    }
    const envelope = {
      type: "client-response",
      rpcId,
      result: { ok: false, error },
    } as const;
    const response = await this.postJson("/api/respond", envelope, signal);
    return rpcReceiptSchema.parse(await response.json());
  }

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
    this.closing = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.openGeneration(false);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.handlers = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const generation = this.generation;
    if (!generation) {
      return;
    }
    generation.cancelConnection?.(new Error("DeepSeek Harness protocol client closed"));
    this.generation = undefined;
    if (generation.mode === "remote") {
      this.rejectRemoteFollows(generation, new Error("DeepSeek Harness protocol client closed"));
      await closeSocket(generation.mux);
    } else {
      await Promise.all([
        closeSocket(generation.mux),
        closeSocket(generation.host),
      ]);
    }
  }

  private async requestRemote(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const input = recordValue(payload) ?? {};
    if (method === "session.models") {
      const sessionId = requiredString(input.sessionId, "session.models sessionId");
      await this.ensureRemoteFollow(sessionId, signal);
      const catalog = recordValue(await this.invokeRemote("session/modelCatalog", {}, signal)) ?? {};
      const projections = this.remoteProjections.get(sessionId)?.values ?? {};
      const modelProjection = recordValue(projections.modelSelection);
      const current = recordValue(modelProjection?.next)
        ?? recordValue(modelProjection?.lastUsed)
        ?? recordValue(catalog.default);
      if (!current) {
        throw new Error("DeepSeek Harness session/modelCatalog returned no default model");
      }
      const routableProviders = Array.isArray(catalog.routableProviders)
        ? catalog.routableProviders.filter((value): value is string => typeof value === "string")
        : [];
      return {
        current,
        routable: routableProviders.includes(requiredString(current.provider, "model provider")),
        groups: Array.isArray(catalog.groups) ? catalog.groups : [],
        failures: Array.isArray(catalog.failures) ? catalog.failures : [],
      };
    }
    if (method === "session.history") {
      return await this.readRemoteHistory(input, signal);
    }
    if (method === "host.describe") {
      const catalog = recordValue(await this.invokeRemote("session/modelCatalog", {}, signal));
      return recordValue(catalog?.default) ?? {};
    }

    let endpoint = method.replace(".", "/");
    let args: Record<string, unknown> = input;
    switch (method) {
      case "session.create":
      case "session.selectModel":
      case "session.cancel":
        args = { request: input };
        break;
      case "session.prompt": {
        const requestId = randomUUID();
        args = { request: { requestId, ...input } };
        break;
      }
      case "session.list":
        args = { _request: input };
        break;
      case "commands/execute":
        args = recordValue(input.args) ?? {};
        break;
      case "settings.describe":
        args = {};
        break;
      case "goal.create": {
        endpoint = "goals/create";
        const sessionId = requiredString(input.sessionId, "goal.create sessionId");
        args = {
          agentId: sessionId,
          request: {
            objective: input.objective,
            ...(input.maxGoalRounds !== undefined ? { maxGoalRounds: input.maxGoalRounds } : {}),
          },
        };
        break;
      }
      case "goal.clear":
      case "goal.pause":
      case "goal.resume": {
        const action = method.slice("goal.".length);
        endpoint = `goals/${action}`;
        args = {
          agentId: requiredString(input.sessionId, `${method} sessionId`),
          ref: input.ref,
        };
        break;
      }
      default:
        break;
    }

    const value = await this.invokeRemote(endpoint, args, signal);
    if (method === "session.create") {
      const sessionId = requiredString(recordValue(value)?.sessionId, "session.create response sessionId");
      await this.ensureRemoteFollow(sessionId, signal);
    }
    if (method === "goal.clear") {
      return { cleared: true, ref: value };
    }
    if (method === "goal.pause" || method === "goal.resume") {
      const result = recordValue(value) ?? {};
      const id = result.id;
      const revision = result.revision;
      return {
        ...result,
        ...(typeof id === "string" && typeof revision === "number"
          ? { ref: { id, revision } }
          : {}),
      };
    }
    return value;
  }

  private async invokeRemote(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.requestRaw(endpoint, { args }, signal);
  }

  private async respondRemote(
    rpcId: string,
    outcome: {
      kind: "result";
      value: unknown;
    } | {
      kind: "rejected";
      error: { name: string; message: string; code?: string; details?: unknown };
    },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof rpcReceiptSchema>> {
    const pending = this.remoteWaterfalls.get(rpcId);
    if (!pending) {
      return { accepted: false, reason: "not-pending" };
    }
    let projectedOutcome: Record<string, unknown>;
    if (outcome.kind === "rejected") {
      projectedOutcome = outcome;
    } else {
      const value = recordValue(outcome.value);
      projectedOutcome = {
        kind: "result",
        value: pending.event === "approval/request"
          ? value?.outcome
          : pending.event === "user-questions/request"
            ? value?.answer
            : outcome.value,
      };
    }
    await this.invokeRemote("$events/result", {
      clientId: pending.clientId,
      eventId: pending.eventId,
      outcome: projectedOutcome,
    }, signal);
    this.remoteWaterfalls.delete(rpcId);
    return { accepted: true };
  }

  private async readRemoteHistory(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sessionId = requiredString(input.sessionId, "session.history sessionId");
    const follow = await this.ensureRemoteFollow(sessionId, signal);
    const maxMessages = typeof input.maxMessages === "number" ? input.maxMessages : 50;
    const beforeSeq = typeof input.beforeSeq === "number" ? input.beforeSeq : undefined;
    if (beforeSeq === undefined) {
      return {
        events: follow.records,
        hasMore: follow.hasMore,
        projections: this.remoteProjections.get(sessionId) ?? follow.projections,
      };
    }
    const page = recordValue(await this.invokeRemote("session/page", {
      request: {
        address: { kind: "session", sessionId },
        throughSeq: follow.cursor,
        beforeSeq,
        maxMessages,
      },
    }, signal)) ?? {};
    return {
      events: Array.isArray(page.records) ? page.records : [],
      hasMore: page.hasMore === true,
      projections: this.remoteProjections.get(sessionId) ?? follow.projections,
    };
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const serializedBody = JSON.stringify(body);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureAuthenticated(signal);
      const cookie = this.sessionCookie;
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: serializedBody,
        signal: requestSignal,
      });
      if (response.status === 401 && this.launchUrl && attempt === 0) {
        await response.body?.cancel().catch(() => undefined);
        this.invalidateSessionCookie(cookie);
        continue;
      }
      if (!response.ok) {
        throw new Error(`DeepSeek Harness transport failure for ${path}: HTTP ${response.status}`);
      }
      return response;
    }
    throw new Error(`DeepSeek Harness transport failure for ${path}: authentication retry exhausted`);
  }

  private async openGeneration(isReconnect: boolean): Promise<void> {
    if (this.launchUrl) {
      await this.openRemoteGeneration(isReconnect);
      return;
    }
    await this.openLegacyGeneration(isReconnect);
  }

  private async openRemoteGeneration(isReconnect: boolean): Promise<void> {
    if (this.closing || !this.handlers) {
      return;
    }
    await this.ensureAuthenticated();
    if (this.closing || !this.handlers) {
      return;
    }
    const id = ++this.generationId;
    const sessionCookie = this.sessionCookie;
    const websocketOptions = sessionCookie
      ? { headers: { cookie: sessionCookie } }
      : undefined;
    const mux = new WebSocket(this.downlinkUrl("/api/remote.mux"), websocketOptions);
    const generation: RemoteMuxGeneration = {
      mode: "remote",
      id,
      mux,
      ...(sessionCookie ? { sessionCookie } : {}),
      streams: new Map(),
      follows: new Map(),
      settled: false,
    };
    const previous = this.generation;
    this.generation = generation;
    if (previous) {
      void closeSocket(previous.mux);
      if (previous.mode === "legacy") {
        void closeSocket(previous.host);
      } else {
        this.rejectRemoteFollows(previous, new Error("DeepSeek Harness downlink generation was superseded"));
      }
    }

    await new Promise<void>((resolve, reject) => {
      const clearConnectTimer = () => {
        if (generation.connectTimer) {
          clearTimeout(generation.connectTimer);
          generation.connectTimer = undefined;
        }
      };
      generation.cancelConnection = (error) => {
        if (generation.settled) {
          return;
        }
        generation.settled = true;
        clearConnectTimer();
        reject(error);
      };
      const ready = () => {
        if (this.generation?.id !== id || generation.settled) {
          return;
        }
        generation.settled = true;
        clearConnectTimer();
        this.reconnectDelayMs = this.reconnectInitialDelayMs;
        if (isReconnect) {
          void Promise.resolve()
            .then(() => this.handlers?.onReconnect?.({ reason: "transport" }))
            .catch((error) => {
              if (this.generation?.id === id) {
                this.handleGenerationLoss(
                  id,
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            });
        }
        resolve();
      };
      const failed = (error: Error) => {
        if (this.generation?.id !== id) {
          return;
        }
        generation.cancelConnection?.(error);
        this.handleGenerationLoss(id, error);
      };
      generation.connectTimer = setTimeout(() => {
        failed(new Error(
          `DeepSeek Harness remote event stream did not become ready within ${this.connectTimeoutMs}ms`,
        ));
      }, this.connectTimeoutMs);
      generation.connectTimer.unref?.();
      this.bindRemoteSocket(generation, ready, failed);
    });
  }

  private bindRemoteSocket(
    generation: RemoteMuxGeneration,
    ready: () => void,
    failed: (error: Error) => void,
  ): void {
    generation.mux.once("open", () => {
      if (this.closing || this.generation?.id !== generation.id) {
        return;
      }
      try {
        this.openRemoteStream(generation, "events", "$events", { args: {} });
        this.openRemoteStream(generation, "control", "session/control", { args: {} });
        for (const sessionId of this.followedSessions) {
          this.openRemoteFollow(generation, sessionId);
        }
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
      }
    });
    generation.mux.on("message", (data) => {
      if (this.closing || this.generation?.id !== generation.id) {
        return;
      }
      const raw = rawDataToString(data);
      try {
        const frame = remoteStreamServerMessageSchema.parse(JSON.parse(raw));
        this.handleRemoteStreamFrame(generation, frame, ready, failed);
      } catch (error) {
        this.onMalformedFrame?.(error, raw);
      }
    });
    generation.mux.once("error", (error) => failed(error));
    generation.mux.once("close", () => failed(new Error("DeepSeek Harness remote mux closed")));
    generation.mux.once("unexpected-response", (request, response) => {
      response.resume();
      failed(new DeepSeekHarnessTransportError("/api/remote.mux", response.statusCode ?? 0));
      request.destroy();
    });
  }

  private openRemoteStream(
    generation: RemoteMuxGeneration,
    kind: RemoteStreamRegistration["kind"],
    endpoint: string,
    payload: unknown,
    sessionId?: string,
  ): string {
    if (generation.mux.readyState !== WebSocket.OPEN) {
      throw new Error(`DeepSeek Harness remote mux is not open for ${endpoint}`);
    }
    const streamId = randomUUID();
    generation.streams.set(streamId, {
      kind,
      ...(sessionId ? { sessionId } : {}),
    });
    generation.mux.send(JSON.stringify({
      type: "open",
      streamId,
      endpoint,
      payload,
    }));
    return streamId;
  }

  private openRemoteFollow(generation: RemoteMuxGeneration, sessionId: string): RemoteFollowState {
    const existing = generation.follows.get(sessionId);
    if (existing) {
      return existing;
    }
    let resolve!: (snapshot: RemoteFollowSnapshot) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RemoteFollowSnapshot>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    const streamId = this.openRemoteStream(
      generation,
      "follow",
      "session/follow",
      {
        args: {
          request: {
            address: { kind: "session", sessionId },
            maxMessages: 50,
          },
        },
      },
      sessionId,
    );
    const state: RemoteFollowState = {
      streamId,
      sessionId,
      promise,
      resolve,
      reject,
    };
    generation.follows.set(sessionId, state);
    return state;
  }

  private async ensureRemoteFollow(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RemoteFollowSnapshot> {
    this.followedSessions.add(sessionId);
    const generation = this.generation;
    if (!generation || generation.mode !== "remote") {
      throw new Error("DeepSeek Harness remote event stream is not connected");
    }
    const state = generation.follows.get(sessionId) ?? this.openRemoteFollow(generation, sessionId);
    return await waitForPromiseOrAbort(state.promise, signal);
  }

  private handleRemoteStreamFrame(
    generation: RemoteMuxGeneration,
    frame: z.infer<typeof remoteStreamServerMessageSchema>,
    ready: () => void,
    failed: (error: Error) => void,
  ): void {
    const registration = generation.streams.get(frame.streamId);
    if (!registration) {
      throw new Error(`DeepSeek Harness returned an unknown remote stream id: ${frame.streamId}`);
    }
    if (frame.type === "error") {
      const error = new DeepSeekHarnessRpcError(frame.error);
      if (registration.kind === "follow" && registration.sessionId) {
        this.dropRemoteFollow(generation, registration.sessionId, error);
        this.deliverSyntheticFrame(generation, "host", randomUUID(), {
          type: "host/agent-error",
          sessionId: registration.sessionId,
          message: error.message,
        });
      } else {
        failed(error);
      }
      return;
    }
    if (frame.type === "end") {
      const error = new Error(`DeepSeek Harness ${registration.kind} stream ended`);
      if (registration.kind === "follow" && registration.sessionId) {
        this.dropRemoteFollow(generation, registration.sessionId, error);
        this.deliverSyntheticFrame(generation, "host", randomUUID(), {
          type: "host/agent-error",
          sessionId: registration.sessionId,
          message: error.message,
        });
      } else {
        failed(error);
      }
      return;
    }
    if (registration.kind === "events") {
      this.handleRemoteEventItem(generation, frame.value, ready);
      return;
    }
    if (registration.kind === "control") {
      this.handleRemoteControlItem(generation, frame.value);
      return;
    }
    if (!registration.sessionId) {
      throw new Error("DeepSeek Harness follow stream is missing its session id");
    }
    this.handleRemoteFollowItem(generation, registration.sessionId, frame.value);
  }

  private handleRemoteEventItem(
    generation: RemoteMuxGeneration,
    value: unknown,
    ready: () => void,
  ): void {
    const item = recordValue(value);
    const type = typeof item?.type === "string" ? item.type : undefined;
    if (type === "ready") {
      generation.eventClientId = requiredString(item?.clientId, "remote event clientId");
      ready();
      return;
    }
    if (type === "emit") {
      const event = requiredString(item?.event, "remote emitted event name");
      const args = Array.isArray(item?.args) ? item.args : [];
      if (event === "api-session/error") {
        const sessionId = requiredString(args[0], "api-session/error sessionId");
        const message = requiredString(args[1], "api-session/error message");
        this.deliverSyntheticFrame(generation, "host", randomUUID(), {
          type: "host/agent-error",
          sessionId,
          message,
        });
      } else if (event === "api-session/removed") {
        const sessionId = requiredString(args[0], "api-session/removed sessionId");
        this.followedSessions.delete(sessionId);
        this.remoteProjections.delete(sessionId);
        const follow = generation.follows.get(sessionId);
        if (follow) {
          generation.streams.delete(follow.streamId);
          generation.follows.delete(sessionId);
          follow.reject(new Error(`DeepSeek Harness session ${sessionId} was removed`));
        }
        this.deliverSyntheticFrame(generation, "host", randomUUID(), {
          type: "host/session-removed",
          sessionId,
        });
      }
      return;
    }
    if (type === "waterfall") {
      const event = requiredString(item?.event, "remote waterfall event name");
      if (event !== "approval/request" && event !== "user-questions/request") {
        return;
      }
      const eventId = requiredString(item?.eventId, "remote waterfall eventId");
      const agentId = requiredString(item?.agentId, "remote waterfall agentId");
      const request = recordValue(item?.request);
      if (!request) {
        throw new Error(`DeepSeek Harness ${event} request is not an object`);
      }
      const clientId = requiredString(generation.eventClientId, "remote event clientId");
      const pending: PendingRemoteWaterfall = { clientId, eventId, event };
      if (this.remoteWaterfalls.has(eventId)) {
        this.remoteWaterfalls.set(eventId, pending);
        return;
      }
      this.remoteWaterfalls.set(eventId, pending);
      if (event === "approval/request") {
        this.deliverSyntheticFrame(generation, "mux", eventId, {
          ...request,
          type: "approval/requested",
          sessionId: agentId,
          approvalId: eventId,
        });
      } else {
        this.deliverSyntheticFrame(generation, "mux", eventId, {
          ...request,
          type: "question/requested",
          sessionId: agentId,
        });
      }
      return;
    }
    if (type === "cancel") {
      const eventId = requiredString(item?.eventId, "remote waterfall cancellation eventId");
      this.remoteWaterfalls.delete(eventId);
      return;
    }
    throw new Error("DeepSeek Harness returned an invalid remote event item");
  }

  private handleRemoteControlItem(generation: RemoteMuxGeneration, value: unknown): void {
    const item = recordValue(value);
    const type = typeof item?.type === "string" ? item.type : undefined;
    if (type === "baseline") {
      const baseline = recordValue(item?.value);
      if (!baseline) {
        throw new Error("DeepSeek Harness control baseline is missing its value");
      }
      const jobs = recordValue(baseline.jobs) ?? {};
      for (const [sessionId, rows] of Object.entries(jobs)) {
        if (!Array.isArray(rows)) {
          throw new Error(`DeepSeek Harness jobs baseline for ${sessionId} is not an array`);
        }
        this.deliverSyntheticFrame(generation, "mux", randomUUID(), {
          type: "session/jobs",
          sessionId,
          jobs: rows,
        });
      }
      const projections = recordValue(baseline.projections) ?? {};
      for (const [sessionId, rawProjection] of Object.entries(projections)) {
        const projection = parseRemoteProjection(rawProjection, sessionId);
        this.mergeRemoteProjection(sessionId, projection);
        for (const [key, projectionValue] of Object.entries(projection.values)) {
          this.deliverSyntheticFrame(generation, "mux", randomUUID(), {
            type: "session/projection",
            sessionId,
            key,
            value: projectionValue,
            seq: projection.asOfSeq,
          });
        }
      }
      return;
    }
    if (type === "jobs") {
      const sessionId = requiredString(item?.sessionId, "control jobs sessionId");
      if (!Array.isArray(item?.jobs)) {
        throw new Error(`DeepSeek Harness jobs update for ${sessionId} is not an array`);
      }
      this.deliverSyntheticFrame(generation, "mux", randomUUID(), {
        type: "session/jobs",
        sessionId,
        jobs: item.jobs,
      });
      return;
    }
    if (type === "projection") {
      const sessionId = requiredString(item?.sessionId, "control projection sessionId");
      const key = requiredString(item?.key, "control projection key");
      const seq = finiteNumber(item?.seq, "control projection sequence");
      const prior = this.remoteProjections.get(sessionId);
      if (!prior || seq >= prior.asOfSeq) {
        this.remoteProjections.set(sessionId, {
          asOfSeq: seq,
          values: { ...(prior?.values ?? {}), [key]: item?.value },
        });
      }
      this.deliverSyntheticFrame(generation, "mux", randomUUID(), {
        type: "session/projection",
        sessionId,
        key,
        value: item?.value,
        seq,
      });
      return;
    }
    if (type === "queue") {
      return;
    }
    throw new Error("DeepSeek Harness returned an invalid session control item");
  }

  private handleRemoteFollowItem(
    generation: RemoteMuxGeneration,
    sessionId: string,
    value: unknown,
  ): void {
    const item = recordValue(value);
    const state = generation.follows.get(sessionId);
    if (!item || !state) {
      throw new Error(`DeepSeek Harness returned an invalid follow item for ${sessionId}`);
    }
    if (item.type === "snapshot") {
      const header = recordValue(item.header);
      const projections = parseRemoteProjection(item.projections, sessionId);
      if (!header || !Array.isArray(item.records) || typeof item.hasMore !== "boolean") {
        throw new Error(`DeepSeek Harness returned a malformed follow snapshot for ${sessionId}`);
      }
      const snapshot: RemoteFollowSnapshot = {
        type: "snapshot",
        header,
        cursor: finiteNumber(item.cursor, `follow snapshot cursor for ${sessionId}`),
        records: [...item.records],
        hasMore: item.hasMore,
        projections,
      };
      state.snapshot = snapshot;
      this.mergeRemoteProjection(sessionId, projections);
      state.resolve(snapshot);
      return;
    }
    if (item.type === "event") {
      const event = recordValue(item.event);
      if (!event) {
        throw new Error(`DeepSeek Harness returned a malformed live event for ${sessionId}`);
      }
      if (state.snapshot) {
        state.snapshot.records.push(item);
        if (state.snapshot.records.length > 5_000) {
          state.snapshot.records.splice(0, state.snapshot.records.length - 5_000);
          state.snapshot.hasMore = true;
        }
      }
      this.deliverSyntheticFrame(generation, "mux", randomUUID(), {
        type: "session/event",
        sessionId,
        event,
      });
      return;
    }
    throw new Error(`DeepSeek Harness returned an unknown follow item for ${sessionId}`);
  }

  private deliverSyntheticFrame(
    generation: RemoteMuxGeneration,
    target: "mux" | "host",
    rpcId: string,
    payload: { type: string; [key: string]: unknown },
  ): void {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId,
      method: payload.type,
      payload,
    };
    void Promise.resolve()
      .then(() => {
        if (this.closing || this.generation?.id !== generation.id) {
          return;
        }
        const handler = target === "mux" ? this.handlers?.onMuxFrame : this.handlers?.onHostFrame;
        return handler?.(frame);
      })
      .catch((error) => this.reportHandlerError(error));
  }

  private dropRemoteFollow(
    generation: RemoteMuxGeneration,
    sessionId: string,
    error: Error,
  ): void {
    const follow = generation.follows.get(sessionId);
    if (!follow) {
      return;
    }
    generation.follows.delete(sessionId);
    generation.streams.delete(follow.streamId);
    this.followedSessions.delete(sessionId);
    follow.reject(error);
  }

  private mergeRemoteProjection(
    sessionId: string,
    projection: RemoteFollowSnapshot["projections"],
  ): void {
    const prior = this.remoteProjections.get(sessionId);
    if (!prior || projection.asOfSeq >= prior.asOfSeq) {
      this.remoteProjections.set(sessionId, projection);
    }
  }

  private rejectRemoteFollows(generation: RemoteMuxGeneration, error: Error): void {
    for (const follow of generation.follows.values()) {
      follow.reject(error);
    }
    generation.follows.clear();
  }

  private async openLegacyGeneration(isReconnect: boolean): Promise<void> {
    if (this.closing || !this.handlers) {
      return;
    }
    await this.ensureAuthenticated();
    if (this.closing || !this.handlers) {
      return;
    }
    const id = ++this.generationId;
    const websocketOptions = this.sessionCookie
      ? { headers: { cookie: this.sessionCookie } }
      : undefined;
    const mux = new WebSocket(this.downlinkUrl("/api/events.mux"), websocketOptions);
    const host = new WebSocket(this.downlinkUrl("/api/events.host"), websocketOptions);
    const generation: LegacyDownlinkGeneration = {
      mode: "legacy",
      id,
      mux,
      host,
      open: new Set(),
      settled: false,
    };
    const previous = this.generation;
    this.generation = generation;
    if (previous) {
      void closeSocket(previous.mux);
      if (previous.mode === "legacy") {
        void closeSocket(previous.host);
      } else {
        this.rejectRemoteFollows(previous, new Error("DeepSeek Harness downlink generation was superseded"));
      }
    }

    await new Promise<void>((resolve, reject) => {
      const clearConnectTimer = () => {
        if (generation.connectTimer) {
          clearTimeout(generation.connectTimer);
          generation.connectTimer = undefined;
        }
      };
      generation.cancelConnection = (error) => {
        if (generation.settled) {
          return;
        }
        generation.settled = true;
        clearConnectTimer();
        reject(error);
      };
      const opened = (kind: "mux" | "host") => {
        if (this.generation?.id !== id || generation.settled) {
          return;
        }
        generation.open.add(kind);
        if (generation.open.size === 2) {
          generation.settled = true;
          clearConnectTimer();
          this.reconnectDelayMs = this.reconnectInitialDelayMs;
          if (isReconnect) {
            // Recovery is application work layered on top of the sockets. If it
            // fails, this generation is not actually usable: close it and retry
            // instead of leaking an unhandled rejection while leaving callers
            // blocked behind the adapter's recovery barrier.
            void Promise.resolve()
              .then(() => this.handlers?.onReconnect?.({ reason: "transport" }))
              .catch((error) => {
                if (this.generation?.id === id) {
                  this.handleGenerationLoss(
                    id,
                    error instanceof Error ? error : new Error(String(error)),
                  );
                }
              });
          }
          resolve();
        }
      };
      const failed = (error: Error) => {
        if (this.generation?.id !== id) {
          return;
        }
        generation.cancelConnection?.(error);
        this.handleGenerationLoss(id, error);
      };
      generation.connectTimer = setTimeout(() => {
        failed(new Error(
          `DeepSeek Harness downlinks did not both open within ${this.connectTimeoutMs}ms`,
        ));
      }, this.connectTimeoutMs);
      generation.connectTimer.unref?.();
      this.bindSocket(generation, "mux", opened, failed);
      this.bindSocket(generation, "host", opened, failed);
    });
  }

  private bindSocket(
    generation: LegacyDownlinkGeneration,
    kind: "mux" | "host",
    opened: (kind: "mux" | "host") => void,
    failed: (error: Error) => void,
  ): void {
    const socket = kind === "mux" ? generation.mux : generation.host;
    socket.once("open", () => opened(kind));
    socket.on("message", (data) => {
      if (this.closing || this.generation?.id !== generation.id) {
        return;
      }
      const raw = rawDataToString(data);
      try {
        const frame = serverRequestSchema.parse(JSON.parse(raw)) as DeepSeekHarnessServerRequest;
        const handler = kind === "mux" ? this.handlers?.onMuxFrame : this.handlers?.onHostFrame;
        void Promise.resolve()
          .then(() => handler?.(frame))
          .catch((handlerError) => this.reportHandlerError(handlerError));
      } catch (error) {
        this.onMalformedFrame?.(error, raw);
      }
    });
    socket.once("error", (error) => failed(error));
    socket.once("close", () => failed(new Error(`DeepSeek Harness ${kind} downlink closed`)));
  }

  private handleGenerationLoss(id: number, error: Error): void {
    if (this.closing || this.generation?.id !== id) {
      return;
    }
    const generation = this.generation;
    if (generation.mode === "remote" && isAuthenticationFailure(error)) {
      this.invalidateSessionCookie(generation.sessionCookie);
    }
    this.generation = undefined;
    if (generation.mode === "remote") {
      this.rejectRemoteFollows(generation, error);
    }
    void closeSocket(generation.mux);
    if (generation.mode === "legacy") {
      void closeSocket(generation.host);
    }
    void Promise.resolve()
      .then(() => this.handlers?.onDisconnect?.(error))
      .catch((handlerError) => this.reportHandlerError(handlerError));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer || !this.handlers) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openGeneration(true).catch((error) => {
        // Connection failures are normally handled by handleGenerationLoss,
        // which has already reported the failure and scheduled the next try.
        if (this.closing || this.reconnectTimer) {
          return;
        }
        void Promise.resolve()
          .then(() => this.handlers?.onDisconnect?.(error instanceof Error ? error : new Error(String(error))))
          .catch((handlerError) => this.reportHandlerError(handlerError));
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private downlinkUrl(path: string): URL {
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  private async ensureAuthenticated(signal?: AbortSignal): Promise<void> {
    if (!this.launchUrl || this.sessionCookie) {
      return;
    }
    if (!this.authenticationPromise) {
      const pending = this.exchangeLaunchToken(signal);
      this.authenticationPromise = pending;
      void pending.catch(() => {}).finally(() => {
        if (this.authenticationPromise === pending) {
          this.authenticationPromise = undefined;
        }
      });
    }
    await this.authenticationPromise;
  }

  private invalidateSessionCookie(cookie: string | undefined): void {
    if (cookie && this.sessionCookie === cookie) {
      this.sessionCookie = undefined;
    }
  }

  private async exchangeLaunchToken(signal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(this.launchUrl!, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html" },
      signal: requestSignal,
    });
    if (response.status !== 303) {
      throw new Error(`DeepSeek Harness browser authentication failed: HTTP ${response.status}`);
    }
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
    if (!cookie || !/^[^=;\s]+=[^;\s]+$/.test(cookie)) {
      throw new Error("DeepSeek Harness browser authentication returned no valid session cookie");
    }
    this.sessionCookie = cookie;
  }

  private reportHandlerError(error: unknown): void {
    try {
      this.onHandlerError?.(error);
    } catch {
      // A diagnostic hook must never turn a contained consumer failure into a
      // second unhandled exception on the transport loop.
    }
  }
}

class DeepSeekHarnessTransportError extends Error {
  constructor(
    public readonly path: string,
    public readonly statusCode: number,
  ) {
    super(`DeepSeek Harness transport failure for ${path}: HTTP ${statusCode}`);
    this.name = "DeepSeekHarnessTransportError";
  }
}

function isAuthenticationFailure(error: Error): boolean {
  return error instanceof DeepSeekHarnessTransportError && error.statusCode === 401;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data.toString("utf8");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`DeepSeek Harness ${label} is missing`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`DeepSeek Harness ${label} is missing`);
  }
  return value;
}

function parseRemoteProjection(value: unknown, sessionId: string): RemoteFollowSnapshot["projections"] {
  const projection = recordValue(value);
  const values = recordValue(projection?.values);
  if (!projection || !values) {
    throw new Error(`DeepSeek Harness projection baseline for ${sessionId} is malformed`);
  }
  return {
    asOfSeq: finiteNumber(projection.asOfSeq, `projection baseline sequence for ${sessionId}`),
    values,
  };
}

async function waitForPromiseOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await promise;
  }
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 500);
    timer.unref?.();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
      return;
    }
    socket.close();
  });
}
