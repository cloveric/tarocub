// Feature 1 web config UI — loopback HTTP transport. Reuses the same security
// posture as the Telegram side-channel: bind 127.0.0.1, ephemeral port, a
// per-process bearer token compared in constant time, and a Host/Origin
// loopback check to block DNS-rebinding. Unlike zara, the token gates the HTML
// shell too (not just /api/*), and it is never embedded in the served URL beyond
// the initial open — the SPA re-sends it as a header.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { handleUiApiRequest, type UiApiDeps, type UiApiEnv } from "./ui-api.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface UiServerHandle {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Host header must be loopback; a cross-origin Origin is rejected (DNS-rebind guard). */
function isLoopbackRequest(host: string | undefined, origin: string | undefined): boolean {
  const hostOk = !host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  if (!hostOk) {
    return false;
  }
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      if (!["127.0.0.1", "localhost", "::1"].includes(originHost)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

const PLACEHOLDER_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TaroCub</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;color:#1f2937}
code{background:#f3f4f6;padding:.1rem .3rem;border-radius:4px}h1{font-size:1.4rem}</style></head>
<body><h1>TaroCub configuration console</h1>
<p>The API is live. The interactive UI is being built; for now, query it directly (the token is in the URL you opened, re-send it as the <code>x-ui-token</code> header):</p>
<pre>GET  /api/instances
GET  /api/instances/&lt;name&gt;/config
POST /api/instances/&lt;name&gt;/config   { "model": "...", "effort": "..." }</pre></body></html>`;

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("body too large");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startUiServer(
  env: UiApiEnv,
  options: { port?: number; deps?: UiApiDeps } = {},
): Promise<UiServerHandle> {
  const token = randomBytes(24).toString("base64url");

  const server: Server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host;
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (!isLoopbackRequest(host, origin)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const provided = (req.headers["x-ui-token"] as string | undefined) ?? url.searchParams.get("token") ?? "";
      if (!constantTimeEquals(provided, token)) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const method = (req.method ?? "GET").toUpperCase();
      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
        res.end(PLACEHOLDER_HTML);
        return;
      }
      let body: unknown;
      try {
        body = method === "GET" ? undefined : await readBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid body" }));
        return;
      }
      const result = await handleUiApiRequest(method, url.pathname, body, env, options.deps ?? {});
      res.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(result.json));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
