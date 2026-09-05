import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** Raw HTTP GET so a custom Host header actually reaches the server (fetch forbids it). */
function rawGet(port: number, pathName: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: pathName, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

import { handleUiApiRequest } from "../src/ui/ui-api.js";
import { listCctbInstances, resolveInstanceStateDir } from "../src/ui/instance-discovery.js";
import { startUiServer } from "../src/ui/ui-server.js";

async function makeInstance(root: string, name: string, config: Record<string, unknown>, lark = true): Promise<void> {
  const dir = path.join(root, ".cctb", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  if (lark) {
    await writeFile(path.join(dir, "lark.env"), "LARK_APP_ID=cli_x\n", "utf8");
  }
}

describe("UI config API", () => {
  it("lists configured instances with engine and running state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "ccfcc1", { engine: "claude", model: "claude-opus-5" });
      await makeInstance(home, "ccfkk1", { engine: "kimi" });
      await mkdir(path.join(home, ".cctb", ".bus-junk"), { recursive: true }); // dotdir ignored
      const instances = await listCctbInstances({ HOME: home }, () => false);
      expect(instances.map((i) => i.name)).toEqual(["ccfcc1", "ccfkk1"]);
      expect(instances[0]).toMatchObject({ engine: "claude", model: "claude-opus-5", running: false });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reads and writes only the editable config fields", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "ccfcc1", { engine: "codex", model: "old" });
      const get = await handleUiApiRequest("GET", "/api/instances/ccfcc1/config", undefined, { HOME: home });
      expect(get.status).toBe(200);
      expect((get.json as { config: { engine: string } }).config.engine).toBe("codex");

      // A patch with one valid field + one junk field: junk ignored, valid applied.
      const post = await handleUiApiRequest("POST", "/api/instances/ccfcc1/config", {
        model: "kimi-code/k3",
        approvalMode: "hacked", // NOT in EDITABLE_FIELDS → ignored
      }, { HOME: home });
      expect(post.status).toBe(200);
      expect((post.json as { appliesOn: string }).appliesOn).toBe("next-restart");

      const saved = JSON.parse(await readFile(path.join(home, ".cctb", "ccfcc1", "config.json"), "utf8"));
      expect(saved.model).toBe("kimi-code/k3");
      expect(saved.approvalMode).toBeUndefined(); // junk field never written
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("accepts DeepSeek Harness as a UI engine", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "ccfdd1", { engine: "codex", model: "old" });
      const post = await handleUiApiRequest("POST", "/api/instances/ccfdd1/config", {
        engine: "deepseek",
      }, { HOME: home });

      expect(post.status).toBe(200);
      const saved = JSON.parse(await readFile(path.join(home, ".cctb", "ccfdd1", "config.json"), "utf8"));
      expect(saved.engine).toBe("deepseek");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("applies Antigravity engine defaults when switching from the UI", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "agy-bot", {
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        approvalMode: "normal",
      });
      const post = await handleUiApiRequest("POST", "/api/instances/agy-bot/config", {
        engine: "antigravity",
      }, { HOME: home });

      expect(post.status).toBe(200);
      const saved = JSON.parse(await readFile(path.join(home, ".cctb", "agy-bot", "config.json"), "utf8"));
      expect(saved).toMatchObject({ engine: "antigravity", approvalMode: "full-auto" });
      expect(saved.model).toBeUndefined();
      expect(saved.effort).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("clears persisted session bindings before switching engines from the UI", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "agy-bot", { engine: "codex" });
      const stateDir = path.join(home, ".cctb", "agy-bot");
      await writeFile(path.join(stateDir, "session.json"), JSON.stringify({
        chats: [{
          telegramChatId: 123,
          codexSessionId: "thread-from-codex",
          status: "idle",
          updatedAt: new Date(0).toISOString(),
        }],
      }), "utf8");

      const post = await handleUiApiRequest("POST", "/api/instances/agy-bot/config", {
        engine: "antigravity",
      }, { HOME: home });

      expect(post.status).toBe(200);
      const session = JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"));
      expect(session.chats).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("restores session bindings when an engine config write fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "agy-bot", { engine: "codex", effort: "high" });
      const stateDir = path.join(home, ".cctb", "agy-bot");
      const originalSession = {
        chats: [{
          telegramChatId: 123,
          codexSessionId: "thread-from-codex",
          status: "idle",
          updatedAt: new Date(0).toISOString(),
        }],
      };
      await writeFile(path.join(stateDir, "session.json"), JSON.stringify(originalSession), "utf8");

      const request = handleUiApiRequest("POST", "/api/instances/agy-bot/config", {
        engine: "antigravity",
      }, { HOME: home }, {
        updateInstanceConfig: async () => {
          throw new Error("simulated config write failure");
        },
      });

      await expect(request).rejects.toThrow("simulated config write failure");
      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"));
      const session = JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"));
      expect(config).toMatchObject({ engine: "codex", effort: "high" });
      expect(session).toMatchObject(originalSession);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not switch engines when persisted session bindings cannot be cleared", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "agy-bot", { engine: "codex", effort: "high" });
      const stateDir = path.join(home, ".cctb", "agy-bot");
      await writeFile(path.join(stateDir, "session.json"), "{broken", "utf8");

      const post = await handleUiApiRequest("POST", "/api/instances/agy-bot/config", {
        engine: "antigravity",
      }, { HOME: home });

      expect(post.status).toBe(409);
      const saved = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"));
      expect(saved).toMatchObject({ engine: "codex", effort: "high" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an effort that the selected Antigravity CLI cannot accept", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "agy-bot", { engine: "antigravity", effort: "low" });
      const post = await handleUiApiRequest("POST", "/api/instances/agy-bot/config", {
        effort: "max",
      }, { HOME: home });

      expect(post.status).toBe(400);
      expect(post.json).toEqual({ error: "Antigravity effort supports only low, medium, or high" });
      const saved = JSON.parse(await readFile(path.join(home, ".cctb", "agy-bot", "config.json"), "utf8"));
      expect(saved.effort).toBe("low");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("validates effort against the target engine before writing either field", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "kimi-bot", { engine: "codex", effort: "high" });
      const post = await handleUiApiRequest("POST", "/api/instances/kimi-bot/config", {
        engine: "kimi",
        effort: "medium",
      }, { HOME: home });

      expect(post.status).toBe(400);
      expect(post.json).toEqual({ error: "Kimi effort supports only low, high, or max" });
      const saved = JSON.parse(await readFile(path.join(home, ".cctb", "kimi-bot", "config.json"), "utf8"));
      expect(saved).toMatchObject({ engine: "codex", effort: "high" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a path-traversal instance name", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      expect(resolveInstanceStateDir({ HOME: home }, "../../etc")).toBeUndefined();
      expect(resolveInstanceStateDir({ HOME: home }, ".hidden")).toBeUndefined();
      const res = await handleUiApiRequest("GET", "/api/instances/..%2f..%2fetc/config", undefined, { HOME: home });
      expect(res.status).toBe(400);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("serves over loopback with a token gate on both the shell and the API", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-"));
    try {
      await makeInstance(home, "ccfcc1", { engine: "claude" });
      const server = await startUiServer({ HOME: home }, { deps: { isProcessAlive: () => false } });
      try {
        // No token → 401, even for the HTML shell.
        const noToken = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(noToken.status).toBe(401);
        // Bad token → 401.
        const badToken = await fetch(`http://127.0.0.1:${server.port}/api/instances`, {
          headers: { "x-ui-token": "wrong" },
        });
        expect(badToken.status).toBe(401);
        // Correct token → data.
        const good = await fetch(`http://127.0.0.1:${server.port}/api/instances`, {
          headers: { "x-ui-token": server.token },
        });
        expect(good.status).toBe(200);
        expect(good.headers.get("cache-control")).toBe("no-store");
        expect(good.headers.get("referrer-policy")).toBe("no-referrer");
        const payload = await good.json() as { instances: Array<{ name: string }> };
        expect(payload.instances.map((i) => i.name)).toContain("ccfcc1");

        const shell = await fetch(`http://127.0.0.1:${server.port}/?token=${server.token}`);
        expect(shell.status).toBe(200);
        expect(shell.headers.get("cache-control")).toBe("no-store");
        expect(shell.headers.get("referrer-policy")).toBe("no-referrer");
        expect(shell.headers.get("x-frame-options")).toBe("DENY");
        const authCookie = shell.headers.get("set-cookie");
        expect(authCookie).toMatch(/tarocub_ui=.+; Path=\/; HttpOnly; SameSite=Strict/);
        const refreshedShell = await fetch(`http://127.0.0.1:${server.port}/`, {
          headers: { cookie: authCookie!.split(";", 1)[0]! },
        });
        expect(refreshedShell.status).toBe(200);
        // A different loopback port is still a different origin. Cookie auth
        // must not turn another local web app into a CSRF entry point.
        const crossPortOrigin = await rawGet(server.port, "/api/instances", {
          cookie: authCookie!.split(";", 1)[0]!,
          host: `127.0.0.1:${server.port}`,
          origin: "http://127.0.0.1:9",
        });
        expect(crossPortOrigin).toBe(403);
        // Non-loopback Host header → 403 (DNS-rebind guard), via raw http so the
        // Host header is actually sent.
        const rebind = await rawGet(server.port, "/api/instances", {
          "x-ui-token": server.token,
          host: "evil.example.com",
        });
        expect(rebind).toBe(403);
      } finally {
        await server.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ui console command", () => {
  it("starts the server, logs the URL, and shuts down cleanly", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cctb-ui-cmd-"));
    const { runUiConsoleCommand } = await import("../src/commands/ui-command.js");
    const logs: string[] = [];
    let openedUrl = "";
    try {
      await mkdir(path.join(home, ".cctb", "ccfcc1"), { recursive: true });
      await writeFile(path.join(home, ".cctb", "ccfcc1", "config.json"), JSON.stringify({ engine: "claude" }), "utf8");
      const handled = await runUiConsoleCommand({ HOME: home }, { log: (m) => logs.push(m) }, {
        openBrowser: (url) => { openedUrl = url; },
        keepAlive: () => Promise.resolve(), // don't block the test
      });
      expect(handled).toBe(true);
      expect(logs.some((l) => /127\.0\.0\.1:\d+\/\?token=/.test(l))).toBe(true);
      expect(openedUrl).toMatch(/127\.0\.0\.1:\d+\/\?token=/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
