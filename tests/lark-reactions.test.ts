import { describe, expect, it, vi } from "vitest";

import {
  resolveLarkReactionSettings,
  withLarkMessageReactions,
} from "../src/lark/reactions.js";
import { classifyLarkTurnTermination } from "../src/lark/message-handler.js";

// Mirrors how message-handler wires the reaction failure gate.
const isLarkTurnFailure = (error: unknown): boolean =>
  classifyLarkTurnTermination(error, undefined).kind === "error";

describe("Lark message reactions", () => {
  it("defaults to a done/failure reaction only — no processing reaction (the run card already signals progress)", () => {
    expect(resolveLarkReactionSettings({})).toEqual({
      processingEmoji: null,
      doneEmoji: "DONE",
      failureEmoji: "ERROR",
    });
  });

  it("re-enables the processing reaction when CCTB_LARK_REACTION_EMOJI is set", () => {
    expect(resolveLarkReactionSettings({ CCTB_LARK_REACTION_EMOJI: "OnIt" }).processingEmoji).toBe("OnIt");
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

  it("does not add the failure reaction when the caller classifies the error as non-failure", async () => {
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
      isFailure: () => false,
      run: async () => {
        throw new Error("Task was stopped by user");
      },
    } as Parameters<typeof withLarkMessageReactions>[0] & { isFailure: () => boolean })).rejects.toThrow("Task was stopped by user");

    expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
    expect(channel.addReaction).toHaveBeenCalledTimes(1);
  });

  describe("classifyLarkTurnTermination (the real reaction failure gate) — regression #13", () => {
    it("classifies user-stop and idle-timeout terminations as non-failures", () => {
      expect(classifyLarkTurnTermination(new Error("Task was stopped by user"), undefined).kind).toBe("interrupted");
      expect(classifyLarkTurnTermination(new Error("aborted"), undefined).kind).toBe("interrupted");
      expect(classifyLarkTurnTermination(new Error("Session inactive after 30 minutes"), undefined).kind).toBe("idle_timeout");
      const aborted = new AbortController();
      aborted.abort();
      expect(classifyLarkTurnTermination(new Error("anything"), aborted.signal).kind).toBe("interrupted");
      // A genuine engine error still classifies as a failure.
      expect(classifyLarkTurnTermination(new Error("ECONNRESET"), undefined).kind).toBe("error");
    });

    it("does NOT stamp the failure reaction for a /stop or idle-timeout turn, but does for a real error", async () => {
      const make = () => ({
        addReaction: vi.fn(async () => "reaction_1"),
        removeReaction: vi.fn(async () => undefined),
      });
      const settings = { processingEmoji: "OnIt", doneEmoji: "DONE", failureEmoji: "ERROR" };

      for (const message of ["Task was stopped by user", "Session inactive after 30 minutes"]) {
        const channel = make();
        await expect(withLarkMessageReactions({
          channel,
          messageId: "om_1",
          settings,
          isFailure: isLarkTurnFailure,
          run: async () => { throw new Error(message); },
        } as Parameters<typeof withLarkMessageReactions>[0] & { isFailure: (e: unknown) => boolean }))
          .rejects.toThrow(message);
        // processing reaction removed, but no ERROR reaction added.
        expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
        expect(channel.addReaction).toHaveBeenCalledTimes(1);
        expect(channel.addReaction).not.toHaveBeenCalledWith("om_1", "ERROR");
      }

      // A real failure DOES get the failure reaction through the same gate.
      const channel = make();
      await expect(withLarkMessageReactions({
        channel,
        messageId: "om_1",
        settings,
        isFailure: isLarkTurnFailure,
        run: async () => { throw new Error("ECONNRESET"); },
      } as Parameters<typeof withLarkMessageReactions>[0] & { isFailure: (e: unknown) => boolean }))
        .rejects.toThrow("ECONNRESET");
      expect(channel.addReaction).toHaveBeenNthCalledWith(2, "om_1", "ERROR");
    });
  });
});
