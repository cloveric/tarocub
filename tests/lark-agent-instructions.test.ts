import { describe, expect, it } from "vitest";

import {
  cloudAsrAgentInstruction,
  larkAgentInstructions,
  larkMediaTaskInstruction,
  localAsrAgentInstruction,
  mergeLarkTurnInstructions,
  resetCloudAsrConfiguredCacheForTests,
} from "../src/lark/agent-instructions.js";
import { larkDeliveryFollowupInstruction } from "../src/lark/delivery-followup.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("larkAgentInstructions", () => {
  it("keeps every engine-specific chat prompt within the compact budget", () => {
    for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
      const instructions = larkAgentInstructions({
        engine,
        claudeChrome: true,
        timezone: "Asia/Shanghai",
        context: "chat",
      });
      expect(instructions.length, engine).toBeLessThanOrEqual(1750);
      expect(instructions.split("\n").length, engine).toBeLessThanOrEqual(14);
    }
  });

  it("advertises only choice and browser capabilities the selected engine has", () => {
    const codex = larkAgentInstructions({ engine: "codex", context: "chat" });
    expect(codex).toContain("request_user_input");
    expect(codex).not.toContain("AskUserQuestion");

    const claude = larkAgentInstructions({ engine: "claude", claudeChrome: true, context: "chat" });
    expect(claude).toContain("AskUserQuestion becomes a Lark card");
    expect(claude).toContain("main Chrome");

    const kimi = larkAgentInstructions({ engine: "kimi", claudeChrome: true, context: "chat" });
    expect(kimi).toContain("AskUserQuestion becomes a Lark card");
    expect(kimi).not.toContain("main Chrome");

    const antigravity = larkAgentInstructions({ engine: "antigravity", context: "chat" });
    expect(antigravity).toContain("Short choices: lark.choice");
    expect(antigravity).not.toContain("AskUserQuestion");
    expect(antigravity).not.toContain("request_user_input");
  });

  it("limits detailed Sheets bootstrap guidance to engines that need it", () => {
    expect(larkAgentInstructions({ engine: "deepseek" })).toContain("sheets +workbook-info");
    expect(larkAgentInstructions({ engine: "antigravity" })).toContain("sheets +workbook-info");
    expect(larkAgentInstructions({ engine: "codex" })).not.toContain("sheets +workbook-info");
    expect(larkAgentInstructions({ engine: "claude" })).not.toContain("sheets +workbook-info");
  });

  it("removes unavailable actions from comment, meeting, and scheduled-run contexts", () => {
    const comment = larkAgentInstructions({ engine: "claude", context: "comment" });
    expect(comment).not.toContain("send.batch");
    expect(comment).not.toContain("cron.add");

    const meeting = larkAgentInstructions({ engine: "claude", context: "meeting" });
    expect(meeting).not.toContain("send.batch");
    expect(meeting).not.toContain("cron.add");

    const cron = larkAgentInstructions({ engine: "claude", context: "cron" });
    expect(cron).toContain("send.batch");
    expect(cron).toContain("must not create, remove, or modify schedules");
  });

  it("keeps executable delivery, sandbox, verification, math, reminder, and web rules", () => {
    const instructions = larkAgentInstructions({
      engine: "codex",
      timezone: "Asia/Shanghai",
      context: "chat",
    });
    expect(instructions).toContain("[send-file:/absolute/path]");
    expect(instructions).toContain("[send-image:/absolute/path]");
    expect(instructions).toContain("```tool-call");
    expect(instructions).toContain('"name":"send.batch"');
    expect(instructions).toContain('"images"');
    expect(instructions).toContain("Copy outside files into the workspace");
    expect(instructions).toContain("saved PATH");
    expect(instructions).toContain("each path once");
    expect(instructions).toContain("auto-split above 120 MiB");
    expect(instructions).toContain("Claim delivery only with an executable directive");
    expect(instructions).toContain("Lark cards do not render LaTeX");
    expect(instructions).toContain("÷, ×, ≈, ≤, ≥");
    expect(instructions).toContain("explicit request");
    expect(instructions).toContain("one of in/at/cron");
    expect(instructions).toContain("Asia/Shanghai");
    expect(instructions).toContain("9222/9223 only for a named skill");
    expect(instructions).toContain("cite links");
  });

  it("keeps background procedure only for engines that expose background workers", () => {
    expect(larkAgentInstructions({ engine: "claude" })).toContain("Background work");
    expect(larkAgentInstructions({ engine: "kimi" })).toContain("Background work");
    expect(larkAgentInstructions({ engine: "deepseek" })).toContain("Background work");
    expect(larkAgentInstructions({ engine: "codex" })).not.toContain("Background work");
    expect(larkAgentInstructions({ engine: "antigravity" })).not.toContain("Background work");
  });

  it("keeps delivery follow-up checks out of the stable prompt", () => {
    const stable = larkAgentInstructions();
    const followup = larkDeliveryFollowupInstruction("好了吗") ?? "";
    expect(stable).not.toContain("Delivery follow-up for THIS turn");
    expect(followup).toContain("verify platform delivery, not session memory");
    expect(larkDeliveryFollowupInstruction("解释交付机制")).toBeUndefined();
  });
});

describe("dynamic Lark media instructions", () => {
  it("does not make ordinary turns pay the ASR prompt cost", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    resetCloudAsrConfiguredCacheForTests();
    try {
      expect(larkAgentInstructions()).not.toContain("Aliyun Tingwu");
      expect(larkAgentInstructions()).not.toContain("local Qwen");
      expect(larkMediaTaskInstruction("帮我整理今天的待办")).toBeUndefined();
      expect(larkMediaTaskInstruction("下载这个视频并转写")).toContain("Aliyun Tingwu first");
    } finally {
      restoreEnv("ASR_HTTP_URL", previousUrl);
      restoreEnv("TINGWU_ASR_DIR", previousDir);
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("never asks the agent to re-transcribe bridge-completed media", () => {
    const text = "[Bridge media transcription completed]\nTranscript:\n已经完成";
    expect(larkMediaTaskInstruction(text)).toBeUndefined();
  });

  it("routes long fetched media through Tingwu and bounds local ASR requests", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    const previousMax = process.env.ASR_MAX_AUDIO_SECONDS;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    process.env.ASR_MAX_AUDIO_SECONDS = "120";
    resetCloudAsrConfiguredCacheForTests();
    try {
      const asr = localAsrAgentInstruction() ?? "";
      expect(asr).toContain("Aliyun Tingwu first");
      expect(asr).toContain("Max 120s per request");
      expect(asr).toContain("-segment_time 108");
      expect(asr).toContain("do NOT use whisper/mlx_whisper/parakeet");
      expect(asr).toContain("do NOT inspect/probe/split/re-transcribe");
    } finally {
      restoreEnv("ASR_HTTP_URL", previousUrl);
      restoreEnv("TINGWU_ASR_DIR", previousDir);
      restoreEnv("ASR_MAX_AUDIO_SECONDS", previousMax);
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("advertises cloud inbound routing when only Tingwu is configured", () => {
    const previousHttp = process.env.ASR_HTTP_URL;
    const previousCli = process.env.ASR_CLI_PYTHON;
    const previousTingwu = process.env.TINGWU_ASR_DIR;
    delete process.env.ASR_HTTP_URL;
    process.env.ASR_CLI_PYTHON = "/nonexistent/python";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    resetCloudAsrConfiguredCacheForTests();
    try {
      expect(localAsrAgentInstruction()).toBeUndefined();
      expect(cloudAsrAgentInstruction()).toContain("Aliyun Tingwu cloud");
      expect(larkMediaTaskInstruction("总结这个 podcast")).toContain("auto-transcribed");
    } finally {
      restoreEnv("ASR_HTTP_URL", previousHttp);
      restoreEnv("ASR_CLI_PYTHON", previousCli);
      restoreEnv("TINGWU_ASR_DIR", previousTingwu);
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("combines independent turn-only instructions without empty blocks", () => {
    expect(mergeLarkTurnInstructions(undefined, " one ", "two")).toBe("one\n\ntwo");
    expect(mergeLarkTurnInstructions(undefined, "  ")).toBeUndefined();
  });
});
