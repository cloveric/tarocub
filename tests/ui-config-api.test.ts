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
        const payload = await good.json() as { instances: Array<{ name: string }> };
        expect(payload.instances.map((i) => i.name)).toContain("ccfcc1");
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
