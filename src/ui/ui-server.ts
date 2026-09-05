// Feature 1 web config UI — loopback HTTP transport. Reuses the same security
// posture as the Telegram side-channel: bind 127.0.0.1, ephemeral port, a
// per-process bearer token compared in constant time, and a Host/Origin
// loopback check to block DNS-rebinding. Unlike zara, the token gates the HTML
// shell too (not just /api/*), and it is never embedded in the served URL beyond
// the initial open — the SPA re-sends it as a header.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { CONSOLE_HTML } from "./console-html.js";
import { handleUiApiRequest, type UiApiDeps, type UiApiEnv } from "./ui-api.js";

const MAX_BODY_BYTES = 256 * 1024;
const UI_AUTH_COOKIE = "tarocub_ui";
const BASE_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;
const SHELL_SECURITY_HEADERS = {
  ...BASE_SECURITY_HEADERS,
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "),
} as const;

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

function readCookie(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) {
    return "";
  }
  for (const field of cookieHeader.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0 || field.slice(0, separator).trim() !== name) {
      continue;
    }
    return field.slice(separator + 1).trim();
  }
  return "";
}

/** Host must be loopback and a browser Origin must exactly match it. */
function isLoopbackRequest(host: string | undefined, origin: string | undefined): boolean {
  const hostOk = !host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  if (!hostOk) {
    return false;
  }
  if (origin) {
    if (!host) {
      return false;
    }
    try {
      const parsedOrigin = new URL(origin);
      const expectedOrigin = new URL(`http://${host}`);
      if (
        parsedOrigin.protocol !== "http:"
        || parsedOrigin.host.toLowerCase() !== expectedOrigin.host.toLowerCase()
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

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
        res.writeHead(403, BASE_SECURITY_HEADERS).end("forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const headerToken = (req.headers["x-ui-token"] as string | undefined) ?? "";
      const queryToken = url.searchParams.get("token") ?? "";
      const cookieToken = readCookie(req.headers.cookie, UI_AUTH_COOKIE);
      const provided = headerToken || queryToken || cookieToken;
      if (!constantTimeEquals(provided, token)) {
        res.writeHead(401, BASE_SECURITY_HEADERS).end("unauthorized");
        return;
      }
      const authHeaders = queryToken
        ? { "set-cookie": `${UI_AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` }
        : {};
      const method = (req.method ?? "GET").toUpperCase();
      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(200, {
          ...SHELL_SECURITY_HEADERS,
          ...authHeaders,
          "content-type": "text/html; charset=utf-8",
        });
        res.end(CONSOLE_HTML);
        return;
      }
      let body: unknown;
      try {
        body = method === "GET" ? undefined : await readBody(req);
      } catch {
        res.writeHead(400, { ...BASE_SECURITY_HEADERS, ...authHeaders, "content-type": "application/json" })
          .end(JSON.stringify({ error: "invalid body" }));
        return;
      }
      const result = await handleUiApiRequest(method, url.pathname, body, env, options.deps ?? {});
      res.writeHead(result.status, { ...BASE_SECURITY_HEADERS, ...authHeaders, "content-type": "application/json" });
      res.end(JSON.stringify(result.json));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { ...BASE_SECURITY_HEADERS, "content-type": "application/json" })
          .end(JSON.stringify({ error: "internal error" }));
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
