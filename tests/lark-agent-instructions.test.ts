import { describe, expect, it } from "vitest";

import { larkAgentInstructions, localAsrAgentInstruction } from "../src/lark/agent-instructions.js";

describe("larkAgentInstructions", () => {
  it("keeps the injected Lark system prompt compact enough for every-turn use", () => {
    const instructions = larkAgentInstructions();

    // Bound covers the optional local-ASR line, which is appended on machines
    // where an ASR backend is actually installed (e.g. the dev box running the
    // suite); CI has neither the env nor the CLI files, so it stays absent there.
    expect(instructions.length).toBeLessThan(2200);
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
      expect(larkAgentInstructions()).toContain("do NOT default to whisper");
    } finally {
      if (previous === undefined) {
        delete process.env.ASR_HTTP_URL;
      } else {
        process.env.ASR_HTTP_URL = previous;
      }
    }
  });

  it("tells agents that file send is workspace-sandboxed (copy in before sending)", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("workspace-sandboxed");
    expect(instructions).toContain("copy it into your workspace first");
  });

  it("routes titled images through per-image [send-image:] (which becomes a captioned card), not send.batch", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("send each as its own [send-image:/path] tag");
    expect(instructions).toContain("do NOT use send.batch for titled images");
    expect(instructions).toContain("title on the line directly above");
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

  it("keeps Lark scheduling and web-current-facts guidance aligned with the mature Telegram transport rules", () => {
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
    expect(instructions).toContain("Exact URLs: read directly");
    expect(instructions).toContain("use `web_search` for discovery/current facts");
  });

  it("prefers bridge-managed choice cards and treats lark-cli as required for full Lark-native functionality", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("lark.choice");
    expect(instructions).toContain("or `request_user_input`");
    expect(instructions).toContain("AskUserQuestion");
    expect(instructions).not.toContain("Never use `AskUserQuestion`");
    expect(instructions).toContain("Do not call `lark-cli` just to send choice cards");
    expect(instructions).toContain("Use `lark-cli` for Lark-native work");
    expect(instructions).toContain("basic chat transport can still work without it");
    expect(instructions).toContain("Docs/IM/Calendar/Drive");
    expect(instructions).toContain("Sheets: start `sheets +info`");
    expect(instructions).toContain("do not treat Sheets as Docs/Base");
    expect(instructions).toContain("structured Sheets values");
    expect(instructions).toContain("OAuth private only");
  });
});
