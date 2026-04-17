import http from "node:http";

import { isPeerAllowed, loadBusConfig } from "./bus-config.js";

export interface BusTalkRequest {
  fromInstance: string;
  prompt: string;
  depth: number;
}

export interface BusTalkResponse {
  success: boolean;
  text: string;
  fromInstance: string;
  error?: string;
  durationMs?: number;
}

export type BusTalkHandler = (req: BusTalkRequest) => Promise<BusTalkResponse>;

function parseTalkBody(body: string): BusTalkRequest | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (
      typeof parsed.fromInstance !== "string" ||
      typeof parsed.prompt !== "string" ||
      typeof parsed.depth !== "number"
    ) {
      return null;
    }
    return {
      fromInstance: parsed.fromInstance,
      prompt: parsed.prompt,
      depth: parsed.depth,
    };
  } catch {
    return null;
  }
}

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
          sendJson(res, 413, { success: false, error: "Request body too large" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", async () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString("utf8");
        const talkReq = parseTalkBody(body);

        if (!talkReq) {
          sendJson(res, 400, { success: false, error: "Invalid request body" });
          return;
        }

        const busConfig = await loadBusConfig(stateDir);
        if (!busConfig) {
          sendJson(res, 403, { success: false, error: "Bus is not enabled on this instance" });
          return;
        }

        const authHeader = req.headers.authorization;
        const expectedSecret = startupSecret ?? busConfig.secret;
        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          sendJson(res, 401, { success: false, error: "Invalid or missing bus secret" });
          return;
        }

        if (!isPeerAllowed(busConfig, talkReq.fromInstance)) {
          sendJson(res, 403, {
            success: false,
            error: `Instance "${talkReq.fromInstance}" is not in the peer list`,
          });
          return;
        }

        if (talkReq.depth >= busConfig.maxDepth) {
          sendJson(res, 429, {
            success: false,
            error: `Max delegation depth (${busConfig.maxDepth}) exceeded`,
          });
          return;
        }

        try {
          const result = await handler(talkReq);
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 500, {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
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
