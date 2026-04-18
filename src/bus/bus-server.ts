import http from "node:http";

import { isPeerAllowed, loadBusConfig } from "./bus-config.js";
import {
  createBusErrorResponse,
  createBusTalkResponseEnvelope,
  parseBusTalkRequest,
  parseBusTalkResponse,
} from "./bus-protocol.js";

export interface BusTalkRequest {
  fromInstance: string;
  prompt: string;
  depth: number;
  protocolVersion?: number;
  capabilities?: string[];
}

export interface BusTalkResponse {
  success: boolean;
  text: string;
  fromInstance?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  durationMs?: number;
  protocolVersion?: number;
  capabilities?: string[];
}

export type BusTalkHandler = (req: BusTalkRequest) => Promise<BusTalkResponse>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

const MAX_BODY_BYTES = 256 * 1024;

export function createBusServer(
  instanceName: string,
  stateDir: string,
  handler: BusTalkHandler,
  startupSecret?: string,
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/talk") {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          aborted = true;
          sendJson(res, 413, createBusErrorResponse({
            fromInstance: instanceName,
            error: "Request body too large",
            errorCode: "request_too_large",
            retryable: false,
          }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", async () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString("utf8");
        const talkReq = parseBusTalkRequest(body);

        if (!talkReq) {
          sendJson(res, 400, createBusErrorResponse({
            fromInstance: instanceName,
            error: "Invalid request body",
            errorCode: "invalid_request",
            retryable: false,
          }));
          return;
        }

        const busConfig = await loadBusConfig(stateDir);
        if (!busConfig) {
          sendJson(res, 403, createBusErrorResponse({
            fromInstance: instanceName,
            error: "Bus is not enabled on this instance",
            errorCode: "bus_disabled",
            retryable: false,
          }));
          return;
        }

        const authHeader = req.headers.authorization;
        const expectedSecret = startupSecret ?? busConfig.secret;
        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          sendJson(res, 401, createBusErrorResponse({
            fromInstance: instanceName,
            error: "Invalid or missing bus secret",
            errorCode: "auth_failed",
            retryable: false,
          }));
          return;
        }

        if (!isPeerAllowed(busConfig, talkReq.fromInstance)) {
          sendJson(res, 403, createBusErrorResponse({
            fromInstance: instanceName,
            error: `Instance "${talkReq.fromInstance}" is not in the peer list`,
            errorCode: "peer_not_allowed",
            retryable: false,
          }));
          return;
        }

        if (talkReq.depth >= busConfig.maxDepth) {
          sendJson(res, 429, createBusErrorResponse({
            fromInstance: instanceName,
            error: `Max delegation depth (${busConfig.maxDepth}) exceeded`,
            errorCode: "max_depth_exceeded",
            retryable: false,
          }));
          return;
        }

        try {
          const result = parseBusTalkResponse(await handler(talkReq));
          if (!result) {
            sendJson(res, 500, createBusErrorResponse({
              fromInstance: instanceName,
              error: "Handler returned invalid bus response",
              errorCode: "invalid_handler_response",
              retryable: true,
            }));
            return;
          }
          sendJson(res, 200, createBusTalkResponseEnvelope(result));
        } catch (error) {
          sendJson(res, 500, createBusErrorResponse({
            fromInstance: instanceName,
            error: error instanceof Error ? error.message : String(error),
            errorCode: "internal_error",
            retryable: true,
          }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/health") {
      // "kind" fingerprint lets liveness probes confirm this is a
      // cc-telegram-bridge bus server, not an unrelated local service that
      // happens to be listening on the same port.
      sendJson(res, 200, { kind: "cc-telegram-bridge", instance: instanceName, status: "ok", pid: process.pid });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  return server;
}

export function startBusServer(
  server: http.Server,
  port: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve(boundPort);
    });
  });
}

export function stopBusServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
