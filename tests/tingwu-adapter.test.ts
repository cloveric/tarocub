import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { removeTempRoot } from "./helpers/temp-files.js";

const HAS_PYTHON3 = process.platform !== "win32"
  && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

describe("official Tingwu adapter", () => {
  it.skipIf(!HAS_PYTHON3)("deletes its temporary OSS object when SIGTERM interrupts polling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-tingwu-signal-"));
    const fakeModules = path.join(root, "fake-modules");
    const aliyunRoot = path.join(fakeModules, "aliyunsdkcore");
    const authRoot = path.join(aliyunRoot, "auth");
    const uploadMarker = path.join(root, "uploaded.txt");
    const waitMarker = path.join(root, "waiting.txt");
    const deleteMarker = path.join(root, "deleted.txt");
    const audioPath = path.join(root, "meeting.m4a");
    const outDir = path.join(root, "output");
    const adapterPath = path.resolve("integrations/tingwu-asr/tingwu_transcribe.py");

    try {
      await mkdir(authRoot, { recursive: true });
      await writeFile(path.join(aliyunRoot, "__init__.py"), "", "utf8");
      await writeFile(path.join(authRoot, "__init__.py"), "", "utf8");
      await writeFile(path.join(authRoot, "credentials.py"), [
        "class AccessKeyCredential:",
        "    def __init__(self, access_key_id, access_key_secret):",
        "        self.access_key_id = access_key_id",
        "        self.access_key_secret = access_key_secret",
        "",
      ].join("\n"), "utf8");
      await writeFile(path.join(aliyunRoot, "request.py"), [
        "class CommonRequest:",
        "    def __init__(self):",
        "        self.uri = ''",
        "    def set_uri_pattern(self, value):",
        "        self.uri = value",
        "    def set_accept_format(self, value): pass",
        "    def set_domain(self, value): pass",
        "    def set_version(self, value): pass",
        "    def set_protocol_type(self, value): pass",
        "    def set_method(self, value): pass",
        "    def add_header(self, key, value): pass",
        "    def add_query_param(self, key, value): pass",
        "    def set_content(self, value): pass",
        "",
      ].join("\n"), "utf8");
      await writeFile(path.join(aliyunRoot, "client.py"), [
        "import json",
        "import os",
        "import time",
        "from pathlib import Path",
        "class AcsClient:",
        "    def __init__(self, region_id, credential): pass",
        "    def do_action_with_exception(self, request):",
        "        if request.uri == '/openapi/tingwu/v2/tasks':",
        "            return json.dumps({'Data': {'TaskId': 'task-1'}}).encode()",
        "        Path(os.environ['FAKE_TINGWU_WAIT_MARKER']).write_text('waiting')",
        "        time.sleep(120)",
        "        return json.dumps({'Data': {'TaskStatus': 'RUNNING'}}).encode()",
        "",
      ].join("\n"), "utf8");
      await writeFile(path.join(fakeModules, "oss2.py"), [
        "import os",
        "from pathlib import Path",
        "class Auth:",
        "    def __init__(self, access_key_id, access_key_secret): pass",
        "class Bucket:",
        "    def __init__(self, auth, endpoint, bucket): pass",
        "    def put_object_from_file(self, key, source):",
        "        Path(os.environ['FAKE_OSS_UPLOAD_MARKER']).write_text(key)",
        "    def sign_url(self, method, key, expires):",
        "        return 'https://example.test/' + key",
        "    def delete_object(self, key):",
        "        Path(os.environ['FAKE_OSS_DELETE_MARKER']).write_text(key)",
        "",
      ].join("\n"), "utf8");
      await writeFile(audioPath, "fake media", "utf8");

      const child = spawn("python3", [
        adapterPath,
        "--file", audioPath,
        "--source-language", "auto",
        "--wait",
        "--poll-interval", "60",
        "--timeout", "120",
        "--out-dir", outDir,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: fakeModules,
          ALIBABA_CLOUD_ACCESS_KEY_ID: "test-id",
          ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-secret",
          TINGWU_APP_KEY: "test-app",
          OSS_BUCKET: "test-bucket",
          OSS_ENDPOINT: "oss.example.test",
          FAKE_OSS_UPLOAD_MARKER: uploadMarker,
          FAKE_OSS_DELETE_MARKER: deleteMarker,
          FAKE_TINGWU_WAIT_MARKER: waitMarker,
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });

      await waitForFile(waitMarker);
      expect(child.kill("SIGTERM")).toBe(true);
      const outcome = await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Tingwu adapter did not exit after SIGTERM")),
            5_000,
          );
          timer.unref();
        }),
      ]);

      expect(outcome).toEqual({ code: 143, signal: null });
      await waitForFile(deleteMarker);
      expect(await readFile(deleteMarker, "utf8")).toBe(await readFile(uploadMarker, "utf8"));
      expect(stderr).toContain("termination requested by signal");
      expect(stderr).toContain("deleted upload:");
    } finally {
      await removeTempRoot(root);
    }
  }, 15_000);
});
