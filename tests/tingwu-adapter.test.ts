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

async function installImportStubs(root: string): Promise<string> {
  const fakeModules = path.join(root, "fake-modules");
  const aliyunRoot = path.join(fakeModules, "aliyunsdkcore");
  const authRoot = path.join(aliyunRoot, "auth");
  await mkdir(authRoot, { recursive: true });
  await writeFile(path.join(aliyunRoot, "__init__.py"), "", "utf8");
  await writeFile(path.join(authRoot, "__init__.py"), "", "utf8");
  await writeFile(path.join(authRoot, "credentials.py"), [
    "class AccessKeyCredential:",
    "    def __init__(self, access_key_id, access_key_secret): pass",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(aliyunRoot, "client.py"), [
    "class AcsClient:",
    "    def __init__(self, region_id, credential): pass",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(aliyunRoot, "request.py"), [
    "class CommonRequest:",
    "    pass",
    "",
  ].join("\n"), "utf8");
  return fakeModules;
}

async function renderTranscript(root: string, payload: unknown): Promise<string> {
  const fakeModules = await installImportStubs(root);
  const payloadPath = path.join(root, `payload-${crypto.randomUUID()}.json`);
  const runnerPath = path.join(root, "render_transcript.py");
  const adapterPath = path.resolve("integrations/tingwu-asr/tingwu_transcribe.py");
  await writeFile(payloadPath, JSON.stringify(payload), "utf8");
  await writeFile(runnerPath, [
    "import importlib.util",
    "import json",
    "import sys",
    "from pathlib import Path",
    "spec = importlib.util.spec_from_file_location('tingwu_adapter', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "payload = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))",
    "print(module.build_transcript_text(payload), end='')",
    "",
  ].join("\n"), "utf8");

  const result = spawnSync("python3", [runnerPath, adapterPath, payloadPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: fakeModules },
  });
  if (result.status !== 0) {
    throw new Error(`transcript renderer failed: ${result.stderr}`);
  }
  return result.stdout;
}

describe("official Tingwu adapter", () => {
  it.skipIf(!HAS_PYTHON3)("rebuilds paragraphs without deleting repeated words", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-tingwu-text-"));
    try {
      const rendered = await renderTranscript(root, {
        Transcription: {
          Paragraphs: [
            {
              SpeakerId: "1",
              Words: [
                { Text: "我" }, { Text: "爱" }, { Text: "我" },
                { Text: "的" }, { Text: "家" },
              ],
            },
            {
              SpeakerId: "2",
              Words: [
                { Text: "E" }, { Text: "F" }, { Text: "T" },
                { Text: "works" }, { Text: "well" }, { Text: "." },
              ],
            },
            {
              SpeakerId: "1",
              Words: [{ Text: "我" }, { Text: "再" }, { Text: "说" }, { Text: "我" }],
            },
          ],
        },
      });

      expect(rendered).toBe([
        "发言人1：我爱我的家",
        "发言人2：EFT works well.",
        "发言人1：我再说我",
      ].join("\n"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it.skipIf(!HAS_PYTHON3)("omits speaker labels for one speaker and preserves fallback repeats", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-tingwu-text-"));
    try {
      expect(await renderTranscript(root, {
        Transcription: {
          Paragraphs: [
            { SpeakerId: "1", Text: "第一段" },
            { SpeakerId: "1", Text: "第二段" },
          ],
        },
      })).toBe("第一段\n第二段");

      expect(await renderTranscript(root, {
        Results: [
          { Text: "重复" },
          { Text: "中间" },
          { Text: "重复" },
          { Text: "重复" },
        ],
      })).toBe("重复\n中间\n重复");
    } finally {
      await removeTempRoot(root);
    }
  });

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
