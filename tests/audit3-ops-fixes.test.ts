import { access, mkdir, mkdtemp, readdir, stat, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/commands/cli.js";
import {
  detectCloudAsrOverride,
  pruneCloudAsrJobDirs,
  readCloudAsrConfig,
  runCloudAsrProcess,
  transcribeViaTingwuCloud,
} from "../src/runtime/asr-cloud.js";
import { classifyFailure } from "../src/runtime/error-classification.js";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore } from "../src/state/cron-store.js";
import {
  ARCHIVE_EXCLUDED_DIRECTORY_NAMES,
  ARCHIVE_EXCLUSION_SUMMARY,
  createArchive,
} from "../src/state/archive.js";
import {
  assertLarkAttachmentDownloadable,
  downloadLarkAttachments,
  isLarkAttachmentTooLargeError,
  LARK_INBOUND_ATTACHMENT_LIMIT_BYTES,
} from "../src/lark/files.js";
import { renderLarkUserFacingError } from "../src/lark/errors.js";
import { readRotatedLogFile, readRotatedLogFileTail } from "../src/lark/service.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const CLOUD_TRANSCRIPT = "cloud transcript from tingwu";

/**
 * Fake Tingwu dir, same shape as tests/asr-cloud-routing.test.ts: a shell script
 * standing in for `.venv/bin/python`. `behavior: "hang"` never exits, which is
 * how the abort/wall-clock paths are exercised without waiting minutes.
 */
async function setupFakeTingwuDir(root: string, behavior: "success" | "hang"): Promise<{
  dir: string;
  invocationsPath: string;
}> {
  const dir = path.join(root, "tingwu");
  await mkdir(path.join(dir, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(dir, "tingwu_transcribe.py"), "# fake tingwu script\n");
  const invocationsPath = path.join(dir, "invocations.log");

  const lines = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" >> '${invocationsPath}'`,
  ];
  if (behavior === "hang") {
    lines.push("sleep 120", "exit 0");
  } else {
    lines.push(
      'out=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--out-dir" ]; then out="$a"; fi',
      '  prev="$a"',
      "done",
      'mkdir -p "$out"',
      `printf '${CLOUD_TRANSCRIPT}' > "$out/transcription.txt"`,
      "exit 0",
    );
  }
  await writeFile(path.join(dir, ".venv", "bin", "python"), `${lines.join("\n")}\n`, { mode: 0o755 });
  return { dir, invocationsPath };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fix 1 — cloud ASR must be interruptible and bounded
// ---------------------------------------------------------------------------

describe("cloud ASR wall-clock bound and cancellation", () => {
  it("bounds the child at 15 minutes by default even though the script gets --timeout 7200", () => {
    const config = readCloudAsrConfig({ TINGWU_ASR_DIR: "/opt/tingwu" });

    expect(config?.taskTimeoutSeconds).toBe(7200);
    // The old kill backstop was taskTimeout + 60s = 7260s: one stuck job held a
    // chat's queue slot for over two hours.
    expect(config?.processWallClockSeconds).toBe(900);
  });

  it("moves both bounds together when ASR_CLOUD_TASK_TIMEOUT_SECONDS is set explicitly", () => {
    const config = readCloudAsrConfig({
      TINGWU_ASR_DIR: "/opt/tingwu",
      ASR_CLOUD_TASK_TIMEOUT_SECONDS: "1800",
    });

    expect(config?.taskTimeoutSeconds).toBe(1800);
    expect(config?.processWallClockSeconds).toBe(1800);
  });

  it("rejects promptly and kills the child when the caller's signal aborts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-asr-abort-"));
    try {
      const { dir } = await setupFakeTingwuDir(root, "hang");
      const config = readCloudAsrConfig({ TINGWU_ASR_DIR: dir })!;
      const controller = new AbortController();
      const started = Date.now();

      const pending = transcribeViaTingwuCloud("/tmp/long-meeting.m4a", {
        config,
        jobRootDir: path.join(root, "asr-jobs"),
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 150);

      await expect(pending).rejects.toThrow(/cancelled/i);
      // Without the signal this would have waited out the wall-clock bound.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("never spawns the script when the signal is already aborted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-asr-abort-"));
    try {
      const { dir, invocationsPath } = await setupFakeTingwuDir(root, "hang");
      const config = readCloudAsrConfig({ TINGWU_ASR_DIR: dir })!;

      await expect(transcribeViaTingwuCloud("/tmp/long-meeting.m4a", {
        config,
        jobRootDir: path.join(root, "asr-jobs"),
        abortSignal: AbortSignal.abort(),
      })).rejects.toThrow(/cancelled/i);

      expect(await fileExists(invocationsPath)).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — job dirs must be unique and pruned
// ---------------------------------------------------------------------------

describe("cloud ASR job dirs", () => {
  it("gives two same-named media files their own job dirs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-asr-jobs-"));
    try {
      const { dir } = await setupFakeTingwuDir(root, "success");
      const config = readCloudAsrConfig({ TINGWU_ASR_DIR: dir })!;
      const jobRootDir = path.join(root, "asr-jobs");

      // Every Feishu voice message downloads as the SAME basename, so two chats
      // used to be able to collide on `<millis>-audio-1.ogg` and cross-deliver.
      await Promise.all([
        transcribeViaTingwuCloud("/tmp/audio-1.ogg", { config, jobRootDir }),
        transcribeViaTingwuCloud("/tmp/audio-1.ogg", { config, jobRootDir }),
      ]);

      const jobDirs = await readdir(jobRootDir);
      expect(jobDirs).toHaveLength(2);
      expect(new Set(jobDirs).size).toBe(2);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("prunes job dirs older than the retention window on each new job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-asr-prune-"));
    try {
      const { dir } = await setupFakeTingwuDir(root, "success");
      const config = readCloudAsrConfig({ TINGWU_ASR_DIR: dir })!;
      const jobRootDir = path.join(root, "asr-jobs");

      const staleDir = path.join(jobRootDir, "1700000000000-old-job");
      const freshDir = path.join(jobRootDir, "1700000000001-fresh-job");
      await mkdir(staleDir, { recursive: true });
      await mkdir(freshDir, { recursive: true });
      await writeFile(path.join(staleDir, "transcription.txt"), "old", "utf8");
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      await utimes(staleDir, longAgo, longAgo);

      await transcribeViaTingwuCloud("/tmp/audio-1.ogg", { config, jobRootDir });

      expect(await fileExists(staleDir)).toBe(false);
      expect(await fileExists(freshDir)).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("never throws when the job root cannot be pruned", async () => {
    await expect(pruneCloudAsrJobDirs(path.join(os.tmpdir(), "audit3-missing-root"), 7)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — a log-capture stream error must not crash the service
// ---------------------------------------------------------------------------

describe("cloud ASR log capture failures", () => {
  it("rejects (so the caller falls back to local ASR) instead of throwing an uncaught stream error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-asr-logs-"));
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const { dir } = await setupFakeTingwuDir(root, "hang");
      const jobDir = path.join(root, "job");
      // stdout.log is a DIRECTORY: createWriteStream emits EISDIR, which used to
      // have no 'error' listener and took the whole Lark service down.
      await mkdir(path.join(jobDir, "stdout.log"), { recursive: true });

      await expect(runCloudAsrProcess({
        pythonPath: path.join(dir, ".venv", "bin", "python"),
        args: [path.join(dir, "tingwu_transcribe.py")],
        jobDir,
        killAfterMs: 60_000,
        wallClockSeconds: 60,
      })).rejects.toThrow(/could not write its job logs/i);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await removeTempRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — force keywords match the user's own text, not the composed envelope
// ---------------------------------------------------------------------------

describe("cloud ASR force keywords", () => {
  it("ignores the keyword when it only appears in bridge-composed envelope parts", () => {
    const envelopeOnly = [
      "<lark_context>",
      "chat_id: oc_1",
      "sender_name: 强制云端转写",
      "</lark_context>",
      "",
      "[audio:file_v3_key 强制云端转写.m4a]",
    ].join("\n");

    expect(detectCloudAsrOverride(envelopeOnly)).toBeNull();
  });

  it("ignores a keyword quoted inside a forwarded bundle", () => {
    const forwarded = [
      "<lark_context>",
      "chat_id: oc_1",
      "</lark_context>",
      "",
      "<forwarded_lark_messages>",
      "老王: 下次记得发 强制云端转写",
      "</forwarded_lark_messages>",
    ].join("\n");

    expect(detectCloudAsrOverride(forwarded)).toBeNull();
  });

  it("still honors the keyword when the user sends it with the audio", () => {
    const withCaption = [
      "<lark_context>",
      "chat_id: oc_1",
      "</lark_context>",
      "",
      "帮我转一下 强制云端转写",
      "",
      "[audio:file_v3_key audio-1.ogg]",
    ].join("\n");

    expect(detectCloudAsrOverride(withCaption)).toBe("cloud");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — oversize inbound Feishu attachments
// ---------------------------------------------------------------------------

describe("Lark inbound attachment size limit", () => {
  it("refuses an oversize attachment with the numbers in the error", () => {
    let thrown: unknown;
    try {
      assertLarkAttachmentDownloadable(
        { kind: "audio", fileKey: "file_v3", fileName: "meeting.m4a" },
        127 * 1024 * 1024,
      );
    } catch (error) {
      thrown = error;
    }

    expect(isLarkAttachmentTooLargeError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("Lark attachment is too large to download");
    expect((thrown as Error).message).toContain("127 MB");
    expect(LARK_INBOUND_ATTACHMENT_LIMIT_BYTES).toBe(100 * 1024 * 1024);
  });

  it("allows an attachment at or under the limit", () => {
    expect(() => assertLarkAttachmentDownloadable(
      { kind: "file", fileKey: "file_v3" },
      LARK_INBOUND_ATTACHMENT_LIMIT_BYTES,
    )).not.toThrow();
    expect(() => assertLarkAttachmentDownloadable({ kind: "file", fileKey: "file_v3" }, undefined)).not.toThrow();
  });

  it("classifies the rejection as file-workflow and renders an actionable localized message", () => {
    let thrown: unknown;
    try {
      assertLarkAttachmentDownloadable({ kind: "audio", fileKey: "file_v3" }, 127 * 1024 * 1024);
    } catch (error) {
      thrown = error;
    }

    expect(classifyFailure(thrown)).toBe("file-workflow");

    const zh = renderLarkUserFacingError(thrown, "prepare", "zh");
    expect(zh).toContain("音频");
    expect(zh).toContain("127 MB");
    expect(zh).toContain("超过飞书机器人可下载的上限");
    expect(zh).not.toContain("准备飞书消息时失败");

    const en = renderLarkUserFacingError(thrown, "prepare", "en");
    expect(en).toContain("127 MB");
    expect(en).toContain("compress or split");
  });

  it("refuses an oversize body that Feishu never advertised a size for", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-lark-files-"));
    try {
      const channel = {
        downloadResource: vi.fn(async () => Buffer.alloc(LARK_INBOUND_ATTACHMENT_LIMIT_BYTES + 1024)),
      };

      await expect(downloadLarkAttachments({
        channel: channel as never,
        stateDir: root,
        messageId: "om_1",
        attachments: [{ kind: "audio", fileKey: "file_v3", fileName: "huge.m4a" }],
      })).rejects.toThrow(/too large to download/i);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("skips the download entirely when the advertised size is over the limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-lark-files-"));
    try {
      const downloadResource = vi.fn(async () => Buffer.from("never reached"));

      await expect(downloadLarkAttachments({
        channel: { downloadResource } as never,
        stateDir: root,
        messageId: "om_1",
        // fileSize is read structurally: the moment the normalizer plumbs
        // Feishu's file_size through, the pre-check fires before the download.
        attachments: [{ kind: "audio", fileKey: "file_v3", fileSize: 200 * 1024 * 1024 } as never],
      })).rejects.toThrow(/too large to download/i);

      expect(downloadResource).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("names a failed download so it classifies as file-workflow instead of a generic prepare error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-lark-files-"));
    try {
      const channel = {
        downloadResource: vi.fn(async () => {
          throw new Error("request failed with status code 400");
        }),
      };

      let thrown: unknown;
      try {
        await downloadLarkAttachments({
          channel: channel as never,
          stateDir: root,
          messageId: "om_1",
          attachments: [{ kind: "file", fileKey: "file_v3", fileName: "big.zip" }],
        });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as Error).message).toContain("Lark attachment download failed");
      expect(classifyFailure(thrown)).toBe("file-workflow");
      expect(renderLarkUserFacingError(thrown, "prepare", "zh")).not.toContain("准备飞书消息时失败");
    } finally {
      await removeTempRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 6 — backup excludes the heavy regenerable subtrees and reports skips
// ---------------------------------------------------------------------------

async function buildFatStateDir(root: string): Promise<string> {
  const stateDir = path.join(root, "state");
  await mkdir(path.join(stateDir, "workspace", "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(stateDir, "workspace", "pkg", "node_modules"), { recursive: true });
  await mkdir(path.join(stateDir, "workspace", ".venv", "lib"), { recursive: true });
  await mkdir(path.join(stateDir, "workspace", ".git", "objects"), { recursive: true });
  await mkdir(path.join(stateDir, "workspace", ".lark-out", "req-1"), { recursive: true });
  await mkdir(path.join(stateDir, "workspace", ".lark-files", "om_1"), { recursive: true });
  await mkdir(path.join(stateDir, "asr-jobs", "1700000000000-audio"), { recursive: true });

  await writeFile(path.join(stateDir, "config.json"), '{"engine":"claude"}', "utf8");
  await writeFile(path.join(stateDir, "session.json"), "{}", "utf8");
  await writeFile(path.join(stateDir, "timeline.log.jsonl"), "{}\n", "utf8");
  await writeFile(path.join(stateDir, "timeline.log.jsonl.1"), "{}\n", "utf8");
  await writeFile(path.join(stateDir, "service.log"), "boot\n", "utf8");
  await writeFile(path.join(stateDir, "workspace", "notes.md"), "keep me", "utf8");
  await writeFile(path.join(stateDir, "workspace", "node_modules", "left-pad", "index.js"), "//", "utf8");
  await writeFile(path.join(stateDir, "workspace", "pkg", "node_modules", "dep.js"), "//", "utf8");
  await writeFile(path.join(stateDir, "workspace", ".venv", "lib", "site.py"), "#", "utf8");
  await writeFile(path.join(stateDir, "workspace", ".git", "objects", "abc"), "x", "utf8");
  await writeFile(path.join(stateDir, "workspace", ".lark-out", "req-1", "out.png"), "x", "utf8");
  await writeFile(path.join(stateDir, "workspace", ".lark-files", "om_1", "in.ogg"), "x", "utf8");
  await writeFile(path.join(stateDir, "asr-jobs", "1700000000000-audio", "stdout.log"), "x", "utf8");
  return stateDir;
}

describe("instance backup exclusions", () => {
  it("excludes regenerable subtrees and log files, and reports them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-archive-"));
    try {
      const stateDir = await buildFatStateDir(root);
      const archivePath = path.join(root, "backup.cctb.gz");

      const result = await createArchive(stateDir, archivePath);

      const archivedPaths = result.excludedDirectories;
      expect(archivedPaths).toContain("workspace/node_modules");
      expect(archivedPaths).toContain("workspace/pkg/node_modules");
      expect(archivedPaths).toContain("workspace/.venv");
      expect(archivedPaths).toContain("workspace/.git");
      expect(archivedPaths).toContain("workspace/.lark-out");
      expect(archivedPaths).toContain("workspace/.lark-files");
      expect(archivedPaths).toContain("asr-jobs");
      // service.log + timeline.log.jsonl + timeline.log.jsonl.1
      expect(result.excludedLogFileCount).toBe(3);
      // Only the files worth restoring survive.
      expect(result.fileCount).toBe(3);
      expect(await fileExists(archivePath)).toBe(true);

      for (const name of ARCHIVE_EXCLUDED_DIRECTORY_NAMES) {
        expect(ARCHIVE_EXCLUSION_SUMMARY).toContain(name);
      }
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reports an oversize file instead of silently dropping it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-archive-"));
    try {
      const stateDir = path.join(root, "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), "{}", "utf8");
      const hugePath = path.join(stateDir, "huge.bin");
      await writeFile(hugePath, "", "utf8");
      // Sparse: 101 MB of apparent size without writing 101 MB.
      await truncate(hugePath, 101 * 1024 * 1024);
      expect((await stat(hugePath)).size).toBe(101 * 1024 * 1024);

      const result = await createArchive(stateDir, path.join(root, "backup.cctb.gz"));

      expect(result.skippedOversizeFiles).toEqual([
        { path: "huge.bin", size: 101 * 1024 * 1024 },
      ]);
      expect(result.fileCount).toBe(1);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("tells the operator what `telegram backup` left out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-archive-cli-"));
    const messages: string[] = [];
    try {
      const stateDir = path.join(root, ".cctb", "default");
      await mkdir(path.join(stateDir, "workspace", "node_modules"), { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), "{}", "utf8");
      await writeFile(path.join(stateDir, "workspace", "node_modules", "dep.js"), "//", "utf8");
      const hugePath = path.join(stateDir, "huge.bin");
      await writeFile(hugePath, "", "utf8");
      await truncate(hugePath, 101 * 1024 * 1024);

      const handled = await runCli(["telegram", "backup", "--out", path.join(root, "out.cctb.gz")], {
        env: { USERPROFILE: root },
        logger: { log: (message) => messages.push(message) },
      });

      expect(handled).toBe(true);
      const output = messages.join("\n");
      expect(output).toContain("Backed up instance");
      expect(output).toContain("Excluded by default");
      expect(output).toContain("workspace/node_modules");
      expect(output).toContain("WARNING: skipped oversize file");
      expect(output).toContain("huge.bin");
    } finally {
      await removeTempRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 7 — a missed one-shot reminder must tell the user
// ---------------------------------------------------------------------------

describe("missed one-shot reminders", () => {
  it("notifies the user through the job-failure path instead of silently disabling", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "audit3-cron-"));
    const onJobFailure = vi.fn().mockResolvedValue(undefined);
    const store = new CronStore(stateDir);
    const executor = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CronScheduler({
      store,
      executor,
      stateDir,
      instanceName: "test",
      logger: { error: vi.fn(), warn: vi.fn() },
      onJobFailure,
    });

    try {
      const job = await store.add({
        chatId: 1,
        userId: 2,
        cronExpr: "* * * * *",
        prompt: "取快递",
        runOnce: true,
        targetAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      });

      await scheduler.start();

      await vi.waitFor(async () => {
        expect((await store.get(job.id))?.enabled).toBe(false);
      });
      await vi.waitFor(() => {
        expect(onJobFailure).toHaveBeenCalledTimes(1);
      });

      const [notifiedJob, detail] = onJobFailure.mock.calls[0] as [{ id: string }, string];
      expect(notifiedJob.id).toBe(job.id);
      expect(detail).toContain("missed scheduled run");
      expect(detail).toMatch(/\d+ minutes late/);
      expect(executor).not.toHaveBeenCalled();
    } finally {
      await scheduler.stop();
      await removeTempRoot(stateDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 8 — operator surfaces must see rotated logs, bounded
// ---------------------------------------------------------------------------

describe("rotated log readers", () => {
  it("reads a rotated log oldest-first even when the current file is gone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-rotations-"));
    try {
      const logPath = path.join(root, "timeline.log.jsonl");
      await writeFile(`${logPath}.2`, "oldest\n", "utf8");
      await writeFile(`${logPath}.1`, "older\n", "utf8");

      const raw = await readRotatedLogFile(logPath);
      expect(raw).not.toBeNull();
      expect(raw?.indexOf("oldest")).toBeLessThan(raw?.indexOf("older") ?? -1);
      expect(await readRotatedLogFile(path.join(root, "missing.jsonl"))).toBeNull();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("stops early once the tail covers the requested window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-rotations-"));
    try {
      const logPath = path.join(root, "timeline.log.jsonl");
      const event = (iso: string): string => `${JSON.stringify({ timestamp: iso, type: "turn.started" })}\n`;
      // .5 → .1 are ancient; the current file and .1 already reach past the cutoff.
      for (let index = 5; index >= 1; index--) {
        await writeFile(`${logPath}.${index}`, event(`2020-01-0${index}T00:00:00.000Z`), "utf8");
      }
      await writeFile(logPath, event(new Date().toISOString()), "utf8");

      const tail = await readRotatedLogFileTail(logPath, { sinceMs: Date.now() - 6 * 60 * 60_000 });

      expect(tail).not.toBeNull();
      // current + .1 only: the ancient .2–.5 are never read or parsed.
      expect(tail).toContain("2020-01-01T00:00:00.000Z");
      expect(tail).not.toContain("2020-01-02T00:00:00.000Z");
      // Oldest-first ordering is preserved for the pairing pass.
      expect(tail?.indexOf("2020-01-01")).toBeLessThan(tail?.indexOf("turn.started", 40) ?? -1);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("always reads at least the current file plus one rotation so cross-rotation turns still pair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-rotations-"));
    try {
      const logPath = path.join(root, "timeline.log.jsonl");
      await writeFile(`${logPath}.1`, `${JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", type: "input.received" })}\n`, "utf8");
      await writeFile(logPath, `${JSON.stringify({ timestamp: "2020-01-01T00:00:05.000Z", type: "turn.completed" })}\n`, "utf8");

      const tail = await readRotatedLogFileTail(logPath, { sinceMs: Date.now() });

      expect(tail).toContain("input.received");
      expect(tail).toContain("turn.completed");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("shows timeline and audit events that have already rotated out of the current file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-cli-rotations-"));
    const timelineMessages: string[] = [];
    const auditMessages: string[] = [];
    try {
      const stateDir = path.join(root, ".cctb", "default");
      await mkdir(stateDir, { recursive: true });
      // Freshly rotated: the current files do not exist yet.
      await writeFile(
        path.join(stateDir, "timeline.log.jsonl.1"),
        '{"timestamp":"2026-04-08T00:00:00.000Z","type":"turn.completed","channel":"telegram","outcome":"success"}\n',
        "utf8",
      );
      await writeFile(
        path.join(stateDir, "audit.log.jsonl.1"),
        '{"timestamp":"2026-04-08T00:00:00.000Z","type":"update.handle","chatId":7,"outcome":"success"}\n',
        "utf8",
      );

      await runCli(["telegram", "timeline", "5"], {
        env: { USERPROFILE: root },
        logger: { log: (message) => timelineMessages.push(message) },
      });
      await runCli(["telegram", "audit", "5"], {
        env: { USERPROFILE: root },
        logger: { log: (message) => auditMessages.push(message) },
      });

      expect(timelineMessages.join("\n")).toContain("turn.completed");
      expect(timelineMessages.join("\n")).not.toBe("(empty)");
      expect(auditMessages.join("\n")).toContain("update.handle");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("still prints (empty) when no log file exists at all", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-cli-rotations-"));
    const messages: string[] = [];
    try {
      await runCli(["telegram", "timeline"], {
        env: { USERPROFILE: root },
        logger: { log: (message) => messages.push(message) },
      });
      expect(messages).toEqual(["(empty)"]);
    } finally {
      await removeTempRoot(root);
    }
  });
});
