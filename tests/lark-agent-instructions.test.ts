import { describe, expect, it } from "vitest";

import { larkAgentInstructions } from "../src/lark/agent-instructions.js";

describe("larkAgentInstructions", () => {
  it("keeps the injected Lark system prompt compact enough for every-turn use", () => {
    const instructions = larkAgentInstructions();

    expect(instructions.length).toBeLessThan(1500);
    expect(instructions.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("tells agents that file send is workspace-sandboxed (copy in before sending)", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("workspace-sandboxed");
    expect(instructions).toContain("copy it into your workspace first");
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
