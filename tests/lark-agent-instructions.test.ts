import { describe, expect, it } from "vitest";

import {
  cloudAsrAgentInstruction,
  larkAgentInstructions,
  localAsrAgentInstruction,
  resetCloudAsrConfiguredCacheForTests,
} from "../src/lark/agent-instructions.js";

describe("larkAgentInstructions", () => {
  it("keeps the injected Lark system prompt compact enough for every-turn use", () => {
    const instructions = larkAgentInstructions();

    // Bound covers the two optional ASR lines, appended only where the machine
    // actually has a local ASR backend / a configured Tingwu dir (e.g. the dev
    // box running the suite); CI has neither, so both stay absent there.
    expect(instructions.length).toBeLessThan(3000);
    expect(instructions.split("\n").length).toBeLessThanOrEqual(10);
  });

  it("tells the agent to use the local ASR (not whisper) for its own transcription when one is configured", () => {
    const previous = process.env.ASR_HTTP_URL;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    try {
      const asr = localAsrAgentInstruction();
      expect(asr).toBeDefined();
      expect(asr).toContain("http://127.0.0.1:8412/transcribe");
      expect(asr).toContain("whisper");
      // It is wired into the injected Lark prompt when ASR is available.
      expect(larkAgentInstructions()).toContain("do NOT use whisper");
    } finally {
      if (previous === undefined) {
        delete process.env.ASR_HTTP_URL;
      } else {
        process.env.ASR_HTTP_URL = previous;
      }
    }
  });

  it("stops agents re-transcribing user media the bridge already routed", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    resetCloudAsrConfiguredCacheForTests();
    try {
      // A recording forwarded as a FILE reached the engine while the bridge had
      // already transcribed it; "use it FIRST" read as an order to transcribe
      // anyway, so a 24-minute recording got chunked through the local model
      // instead of the cloud route the bridge had picked.
      const asr = localAsrAgentInstruction() ?? "";
      expect(asr).toContain("[Bridge media transcription completed]");
      expect(asr).toContain("do NOT inspect/probe/split/re-transcribe");
      expect(asr).toContain("marked unavailable");
      expect(asr).toContain("Fetched media");
    } finally {
      if (previousUrl === undefined) delete process.env.ASR_HTTP_URL;
      else process.env.ASR_HTTP_URL = previousUrl;
      if (previousDir === undefined) delete process.env.TINGWU_ASR_DIR;
      else process.env.TINGWU_ASR_DIR = previousDir;
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("routes long media fetched by the agent through Tingwu before local ASR", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    const previousThreshold = process.env.ASR_CLOUD_THRESHOLD_SECONDS;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    delete process.env.ASR_CLOUD_THRESHOLD_SECONDS;
    resetCloudAsrConfiguredCacheForTests();
    try {
      const asr = localAsrAgentInstruction() ?? "";

      expect(asr).toContain("Fetched media: probe duration");
      expect(asr).toContain(">=15 min");
      expect(asr).toContain("Aliyun Tingwu first");
      expect(asr).toContain('$TINGWU_ASR_DIR/.venv/bin/python');
      expect(asr).toContain('$TINGWU_ASR_DIR/tingwu_transcribe.py');
      expect(asr).toContain('--file "<absolute media path>"');
      expect(asr).toContain("--source-language auto --wait");
      expect(asr).toContain('--out-dir "<workspace job dir>"');
      expect(asr).toContain("cloud fails");
      expect(asr).toContain("local Qwen");
      expect(asr).toContain("do NOT read/copy its credentials");
      expect(asr.indexOf("Aliyun Tingwu first")).toBeLessThan(asr.indexOf("local Qwen"));
    } finally {
      if (previousUrl === undefined) delete process.env.ASR_HTTP_URL;
      else process.env.ASR_HTTP_URL = previousUrl;
      if (previousDir === undefined) delete process.env.TINGWU_ASR_DIR;
      else process.env.TINGWU_ASR_DIR = previousDir;
      if (previousThreshold === undefined) delete process.env.ASR_CLOUD_THRESHOLD_SECONDS;
      else process.env.ASR_CLOUD_THRESHOLD_SECONDS = previousThreshold;
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("omits the pre-transcribed note when no cloud route is configured", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    delete process.env.TINGWU_ASR_DIR;
    resetCloudAsrConfiguredCacheForTests();
    try {
      expect(localAsrAgentInstruction() ?? "").not.toContain("[Bridge media transcription completed]");
    } finally {
      if (previousUrl === undefined) delete process.env.ASR_HTTP_URL;
      else process.env.ASR_HTTP_URL = previousUrl;
      if (previousDir !== undefined) process.env.TINGWU_ASR_DIR = previousDir;
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("gives the local ASR a length boundary AND the way out of it", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousMax = process.env.ASR_MAX_AUDIO_SECONDS;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    delete process.env.ASR_MAX_AUDIO_SECONDS;
    try {
      // An over-long request wedged the shared model in an uninterruptible MPS
      // wait and its global inference lock was never released, so EVERY
      // instance's transcription then timed out. Stating only "it failed" is not
      // enough: without the split remedy the agent reports failure and stops.
      const asr = localAsrAgentInstruction() ?? "";
      expect(asr).toContain("Max 300s per request");
      expect(asr).toContain("shared model");
      expect(asr).toContain("Never retry longer input as-is");
      expect(asr).toContain("-segment_time 270");
      expect(asr).not.toContain("-segment_time 300");
      expect(asr).toContain("-vn -ac 1 -ar 16000 -c:a pcm_s16le");

      // The quoted bound must follow the service's configured cap, not a
      // hard-coded number that silently drifts away from it.
      process.env.ASR_MAX_AUDIO_SECONDS = "120";
      const tightened = localAsrAgentInstruction() ?? "";
      expect(tightened).toContain("Max 120s per request");
      expect(tightened).toContain("-segment_time 108");
      expect(tightened).not.toContain("-segment_time 120");
      expect(tightened).not.toContain("300s");
    } finally {
      if (previousUrl === undefined) {
        delete process.env.ASR_HTTP_URL;
      } else {
        process.env.ASR_HTTP_URL = previousUrl;
      }
      if (previousMax === undefined) {
        delete process.env.ASR_MAX_AUDIO_SECONDS;
      } else {
        process.env.ASR_MAX_AUDIO_SECONDS = previousMax;
      }
    }
  });

  it("advertises cloud long-audio routing on TINGWU_ASR_DIR alone, with reachable force-keyword wording", () => {
    const previousHttp = process.env.ASR_HTTP_URL;
    const previousCli = process.env.ASR_CLI_PYTHON;
    const previousTingwu = process.env.TINGWU_ASR_DIR;
    const previousThreshold = process.env.ASR_CLOUD_THRESHOLD_SECONDS;
    // No local ASR at all: the cloud note must NOT be gated on it.
    delete process.env.ASR_HTTP_URL;
    process.env.ASR_CLI_PYTHON = "/nonexistent/python";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    delete process.env.ASR_CLOUD_THRESHOLD_SECONDS;
    try {
      expect(localAsrAgentInstruction()).toBeUndefined();
      const cloud = cloudAsrAgentInstruction();
      expect(cloud).toBeDefined();
      expect(cloud).toContain(">=15 min");
      expect(cloud).toContain("local Qwen ASR");
      expect(cloud).toContain("强制本地转写/强制云端转写");
      // The advertised trigger must match what the router can actually see: a
      // bare voice note has no caption, so the keyword has to travel with it.
      expect(cloud).toContain("same message or burst");
      expect(larkAgentInstructions()).toContain("Aliyun Tingwu");

      process.env.ASR_CLOUD_THRESHOLD_SECONDS = "120";
      const customThreshold = cloudAsrAgentInstruction() ?? "";
      expect(customThreshold).toContain(">=2 min");
      expect(customThreshold).not.toContain(">=15 min");

      delete process.env.TINGWU_ASR_DIR;
      expect(cloudAsrAgentInstruction()).toBeUndefined();
      expect(larkAgentInstructions()).not.toContain("Aliyun Tingwu");
    } finally {
      if (previousHttp === undefined) {
        delete process.env.ASR_HTTP_URL;
      } else {
        process.env.ASR_HTTP_URL = previousHttp;
      }
      if (previousCli === undefined) {
        delete process.env.ASR_CLI_PYTHON;
      } else {
        process.env.ASR_CLI_PYTHON = previousCli;
      }
      if (previousTingwu === undefined) {
        delete process.env.TINGWU_ASR_DIR;
      } else {
        process.env.TINGWU_ASR_DIR = previousTingwu;
      }
      if (previousThreshold === undefined) {
        delete process.env.ASR_CLOUD_THRESHOLD_SECONDS;
      } else {
        process.env.ASR_CLOUD_THRESHOLD_SECONDS = previousThreshold;
      }
    }
  });

  it("tells agents that file send is workspace-sandboxed (copy in before sending)", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("workspace-sandboxed");
    expect(instructions).toContain("copy it into your workspace first");
  });

  it("tells background jobs to validate output and emit delivery tags", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("Background jobs: verify output, not exit status");
    expect(instructions).toContain("final stdout must include exact delivery tags");
    expect(instructions).toContain("saved PATH");
    expect(instructions).toContain("empty/all-zero/corrupt results");
    expect(instructions).toContain("one user-facing conclusion");
  });

  it("requires current-turn tags when the user checks a prior delivery", () => {
    const instructions = larkAgentInstructions("好了吗");

    expect(instructions).toContain("Delivery follow-up for THIS turn");
    expect(instructions).toContain("verify platform delivery, not session memory");
    expect(instructions).toContain("never tell the user to scroll up");
    expect(instructions).toContain("repeats every intended artifact");
    expect(larkAgentInstructions("解释交付机制")).not.toContain("Delivery follow-up for THIS turn");
  });

  it("tells agents to give each image its own title via send.batch {path, caption} or [send-image:] title-above", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("give each image its own title");
    expect(instructions).toContain("images entry an object {path, caption}");
    expect(instructions).toContain("title on the line directly above");
    expect(instructions).toContain("packed into ONE card, each image under its own title");
  });

  it("tells agents to answer ordinary Lark requests directly instead of emitting placeholder cards", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("concise text reply");
    expect(instructions).toContain("no progress placeholder cards");
    expect(instructions).toContain("send.batch");
    expect(instructions).toContain("fenced `file:name.ext`");
  });

  it("does not instruct Lark agents to use Telegram-only side-channel send commands", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).not.toContain("cctb send");
    expect(instructions).not.toContain("CCTB_SEND_URL");
    expect(instructions).toContain("[send-file:/absolute/path]");
    expect(instructions).toContain("send.file/send.image/send.audio/send.video");
  });

  it("keeps Lark scheduling and web-routing guidance aligned with the mature Telegram transport rules", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("one of `in`/`at`/`cron`");
    expect(instructions).toContain("no `chatId`/`userId`");
    expect(instructions).toContain("let bridge confirm");
    expect(instructions).toContain("cron.list");
    expect(instructions).toContain("cron.remove");
    expect(instructions).toContain("cron.toggle");
    expect(instructions).toContain("list first");
    expect(instructions).toContain("only explicit reminder/schedule requests");
    expect(instructions).toContain("ISO timezone");

    // Web routing mirrors the Telegram transport rules, plus the Scrapling fallback.
    expect(instructions).toContain("read them directly with `web_extract`");
    expect(instructions).toContain("fall back to Scrapling");
    expect(instructions).toContain("`web_search` for discovery/current facts");
  });

  it("prefers bridge-managed choice cards and treats lark-cli as required for full Lark-native functionality", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("lark.choice");
    expect(instructions).toContain("or `request_user_input`");
    expect(instructions).toContain("AskUserQuestion");
    expect(instructions).not.toContain("Never use `AskUserQuestion`");
    expect(instructions).toContain("Do not call `lark-cli` just to send choice cards");
    expect(instructions).toContain("Use `lark-cli` for Lark-native work");
    expect(instructions).toContain("Docs/Calendar/Drive");
    // Guardrail: lark-cli is a separate app, so it must NOT be used for IM on this
    // bot's own chats (creating groups / inviting / sending) — that trips cross-app.
    expect(instructions).toContain("NOT IM on this bot's own chats");
    expect(instructions).toContain("open_id cross app");
    expect(instructions).toContain("Sheets: start `sheets +info`");
    expect(instructions).toContain("do not treat Sheets as Docs/Base");
    expect(instructions).toContain("structured Sheets values");
    expect(instructions).toContain("OAuth private only");
  });
});
