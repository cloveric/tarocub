import { describe, expect, it, vi } from "vitest";

import { migrateLegacyConversationResume } from "../src/runtime/conversation-resume.js";

describe("conversation resume migration", () => {
  it("preserves the legacy workspace for every existing conversation", async () => {
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
      symlinkPath: "/tmp/owner-project-link",
    };

    await expect(migrateLegacyConversationResume({
      inspect: async () => ({ state: { chats: [owner, other] } }),
      upsert,
    }, legacy)).resolves.toBe(true);

    expect(upsert).toHaveBeenCalledWith({ ...owner, resume: legacy });
    expect(upsert).toHaveBeenCalledWith({
      ...other,
      resume: {
        sessionId: "session-other",
        dirName: "owner-project",
        workspacePath: "/tmp/owner-project",
      },
    });
  });

  it("migrates existing sessions when the legacy owner is no longer recorded", async () => {
    const upsert = vi.fn(async () => undefined);
    await expect(migrateLegacyConversationResume({
      inspect: async () => ({ state: { chats: [{ codexSessionId: "different" }] } }),
      upsert,
    }, {
      sessionId: "missing",
      dirName: "missing",
      workspacePath: "/tmp/missing",
    })).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith({
      codexSessionId: "different",
      resume: {
        sessionId: "different",
        dirName: "missing",
        workspacePath: "/tmp/missing",
      },
    });
  });

  it("keeps the legacy field until at least one existing session can own its workspace", async () => {
    const upsert = vi.fn(async () => undefined);
    await expect(migrateLegacyConversationResume({
      inspect: async () => ({ state: { chats: [] } }),
      upsert,
    }, {
      sessionId: "missing",
      dirName: "missing",
      workspacePath: "/tmp/missing",
    })).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
