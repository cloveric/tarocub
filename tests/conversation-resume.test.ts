import { describe, expect, it, vi } from "vitest";

import {
  migrateLegacyConversationResume,
  resolveConversationResume,
} from "../src/runtime/conversation-resume.js";

describe("conversation resume migration", () => {
  it("moves a legacy instance resume onto its owning conversation", async () => {
    const owner = {
      codexSessionId: "session-owner",
      conversationKey: "lark:oc_owner",
      status: "idle",
    };
    const other = {
      codexSessionId: "session-other",
      conversationKey: "lark:oc_other",
      status: "idle",
    };
    const upsert = vi.fn(async () => undefined);
    const legacy = {
      sessionId: "session-owner",
      dirName: "owner-project",
      workspacePath: "/tmp/owner-project",
    };

    await expect(migrateLegacyConversationResume({
      inspect: async () => ({ state: { chats: [owner, other] } }),
      upsert,
    }, legacy)).resolves.toBe(true);

    expect(upsert).toHaveBeenCalledWith({ ...owner, resume: legacy });
    expect(resolveConversationResume(other, legacy)).toBeUndefined();
  });

  it("keeps the legacy field when no owning session can be proven", async () => {
    const upsert = vi.fn(async () => undefined);
    await expect(migrateLegacyConversationResume({
      inspect: async () => ({ state: { chats: [{ codexSessionId: "different" }] } }),
      upsert,
    }, {
      sessionId: "missing",
      dirName: "missing",
      workspacePath: "/tmp/missing",
    })).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
