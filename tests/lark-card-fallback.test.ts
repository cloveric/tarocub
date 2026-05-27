import { describe, expect, it, vi } from "vitest";

import { sendLarkCardWithFallback } from "../src/lark/card-delivery.js";

describe("Lark card delivery fallback", () => {
  it("falls back to text when card delivery fails", async () => {
    const channel = {
      send: vi.fn(async (_to: string, input: unknown) => {
        if (typeof input === "object" && input !== null && "card" in input) {
          throw new Error("card permission denied");
        }
        return { messageId: "text_1" };
      }),
    };

    const result = await sendLarkCardWithFallback({
      channel,
      chatId: "oc_chat",
      card: { schema: "2.0" },
      fallbackText: "请选择一个选项：A / B",
      options: { replyTo: "om_1", replyInThread: true },
      locale: "zh",
    });

    expect(result).toEqual({ messageId: "text_1", fallback: true });
    expect(channel.send).toHaveBeenNthCalledWith(1, "oc_chat", { card: { schema: "2.0" } }, { replyTo: "om_1", replyInThread: true });
    expect(channel.send).toHaveBeenNthCalledWith(2, "oc_chat", {
      text: expect.stringContaining("请选择一个选项：A / B"),
    }, { replyTo: "om_1", replyInThread: true });
    expect(JSON.stringify(channel.send.mock.calls[1])).toContain("lark doctor");
  });

  it("redacts sensitive values from card delivery error details", async () => {
    const channel = {
      send: vi.fn(async (_to: string, input: unknown) => {
        if (typeof input === "object" && input !== null && "card" in input) {
          throw new Error("failed with app_secret=sk-live and Authorization: Bearer tenant-token");
        }
        return { messageId: "text_1" };
      }),
    };

    await sendLarkCardWithFallback({
      channel,
      chatId: "oc_chat",
      card: { schema: "2.0" },
      fallbackText: "请选择一个选项：A / B",
      locale: "zh",
    });

    const fallbackPayload = channel.send.mock.calls[1]?.[1];
    expect(JSON.stringify(fallbackPayload)).not.toContain("sk-live");
    expect(JSON.stringify(fallbackPayload)).not.toContain("tenant-token");
    expect(JSON.stringify(fallbackPayload)).toContain("app_secret=[redacted]");
    expect(JSON.stringify(fallbackPayload)).toContain("Bearer [redacted]");
  });
});
