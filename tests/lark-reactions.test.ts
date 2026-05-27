import { describe, expect, it, vi } from "vitest";

import {
  resolveLarkReactionSettings,
  withLarkMessageReactions,
} from "../src/lark/reactions.js";

describe("Lark message reactions", () => {
  it("defaults to lightweight processing and done reactions", () => {
    expect(resolveLarkReactionSettings({})).toEqual({
      processingEmoji: "OnIt",
      doneEmoji: "DONE",
      failureEmoji: "ERROR",
    });
  });

  it("lets env override or disable reaction emoji", () => {
    expect(resolveLarkReactionSettings({
      CCTB_LARK_REACTION_EMOJI: "Typing",
      CCTB_LARK_DONE_EMOJI: "OK",
      CCTB_LARK_FAILURE_EMOJI: "Crying",
    })).toEqual({
      processingEmoji: "Typing",
      doneEmoji: "OK",
      failureEmoji: "Crying",
    });
    expect(resolveLarkReactionSettings({
      CCTB_LARK_REACTION_EMOJI: "off",
    })).toEqual({
      processingEmoji: null,
      doneEmoji: "DONE",
      failureEmoji: "ERROR",
    });
  });

  it("removes the processing reaction and adds the done reaction after success", async () => {
    const channel = {
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
    };

    const result = await withLarkMessageReactions({
      channel,
      messageId: "om_1",
      settings: {
        processingEmoji: "OnIt",
        doneEmoji: "DONE",
        failureEmoji: "ERROR",
      },
      run: async () => "ok",
    });

    expect(result).toBe("ok");
    expect(channel.addReaction).toHaveBeenNthCalledWith(1, "om_1", "OnIt");
    expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
    expect(channel.addReaction).toHaveBeenNthCalledWith(2, "om_1", "DONE");
  });

  it("keeps engine errors intact while best-effort adding failure reaction", async () => {
    const channel = {
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
    };

    await expect(withLarkMessageReactions({
      channel,
      messageId: "om_1",
      settings: {
        processingEmoji: "OnIt",
        doneEmoji: "DONE",
        failureEmoji: "ERROR",
      },
      run: async () => {
        throw new Error("boom");
      },
    })).rejects.toThrow("boom");

    expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
    expect(channel.addReaction).toHaveBeenNthCalledWith(2, "om_1", "ERROR");
  });
});
