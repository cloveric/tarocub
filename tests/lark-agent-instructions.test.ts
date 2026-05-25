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
    expect(instructions).toContain("if URL(s) are provided, read them directly");
    expect(instructions).toContain("use `web_search` for discovery/current facts");
  });
});
