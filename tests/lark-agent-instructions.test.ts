import { describe, expect, it } from "vitest";

import { larkAgentInstructions } from "../src/lark/agent-instructions.js";

describe("larkAgentInstructions", () => {
  it("tells agents to answer ordinary Lark requests directly instead of emitting placeholder cards", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("For ordinary Lark requests, answer directly in text");
    expect(instructions).toContain("Do not emit progress, running, or placeholder cards");
    expect(instructions).toContain("send.batch");
    expect(instructions).toContain("Small text/code files may be delivered as a whole-response fenced `file:name.ext` block");
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

    expect(instructions).toContain("exactly one of `in`, `at`, or `cron`");
    expect(instructions).toContain("never include `chatId` or `userId`");
    expect(instructions).toContain("let the bridge confirm");
    expect(instructions).toContain("cron.list");
    expect(instructions).toContain("cron.remove");
    expect(instructions).toContain("cron.toggle");
    expect(instructions).toContain("list first");
    expect(instructions).toContain("Only emit reminder tool tags when the user explicitly asks");
    expect(instructions).toContain("ISO date-time with timezone");
    expect(instructions).toContain("if URL(s) are provided, read them directly");
    expect(instructions).toContain("use `web_search` for discovery/current facts");
  });

  it("prefers bridge-managed choice cards and treats lark-cli as required for full Lark-native functionality", () => {
    const instructions = larkAgentInstructions();

    expect(instructions).toContain("Prefer `lark.choice` for explicit user selections");
    expect(instructions).toContain("When planning mode or a tool asks the user to choose");
    expect(instructions).toContain("render the options as a `lark.choice` card");
    expect(instructions).toContain("or a `request_user_input` tool-call");
    expect(instructions).toContain("put long option text in `label`/`description`");
    expect(instructions).toContain("do not call `lark-cli` just to send a choice card");
    expect(instructions).toContain("`lark-cli` is required for full Lark-native functionality");
    expect(instructions).toContain("basic chat transport can still work without it");
    expect(instructions).toContain("For Feishu Docs/IM/Calendar/Drive operations, prefer local `lark-cli`");
    expect(instructions).toContain("For Lark OAuth, only start authorization in private chats");
    expect(instructions).toContain("use `lark auth start` first");
    expect(instructions).toContain("never run OAuth login in the background");
  });
});
