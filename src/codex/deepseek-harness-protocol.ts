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
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onMalformedFrame?: (error: unknown, raw: string) => void;
  onHandlerError?: (error: unknown) => void;
}

interface DownlinkGeneration {
  id: number;
  mux: WebSocket;
  host: WebSocket;
  open: Set<"mux" | "host">;
  settled: boolean;
  cancelConnection?: (error: Error) => void;
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
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly onMalformedFrame?: (error: unknown, raw: string) => void;
  private readonly onHandlerError?: (error: unknown) => void;
  private handlers: DeepSeekHarnessProtocolHandlers | undefined;
  private generation: DownlinkGeneration | undefined;
  private generationId = 0;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  constructor(baseUrl: string | URL, options: DeepSeekHarnessProtocolOptions = {}) {
    this.baseUrl = new URL(baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
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
    await Promise.all([
      closeSocket(generation.mux),
      closeSocket(generation.host),
    ]);
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Harness transport failure for ${path}: HTTP ${response.status}`);
    }
    return response;
  }

  private async openGeneration(isReconnect: boolean): Promise<void> {
    if (this.closing || !this.handlers) {
      return;
    }
    const id = ++this.generationId;
    const mux = new WebSocket(this.downlinkUrl("/api/events.mux"));
    const host = new WebSocket(this.downlinkUrl("/api/events.host"));
    const generation: DownlinkGeneration = {
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
      void closeSocket(previous.host);
    }

    await new Promise<void>((resolve, reject) => {
      generation.cancelConnection = (error) => {
        if (generation.settled) {
          return;
        }
        generation.settled = true;
        reject(error);
      };
      const opened = (kind: "mux" | "host") => {
        if (this.generation?.id !== id || generation.settled) {
          return;
        }
        generation.open.add(kind);
        if (generation.open.size === 2) {
          generation.settled = true;
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
      this.bindSocket(generation, "mux", opened, failed);
      this.bindSocket(generation, "host", opened, failed);
    });
  }

  private bindSocket(
    generation: DownlinkGeneration,
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
    this.generation = undefined;
    void closeSocket(generation.mux);
    void closeSocket(generation.host);
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

  private reportHandlerError(error: unknown): void {
    try {
      this.onHandlerError?.(error);
    } catch {
      // A diagnostic hook must never turn a contained consumer failure into a
      // second unhandled exception on the transport loop.
    }
  }
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
