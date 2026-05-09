import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it } from "vitest";

import { MiniBusStore } from "../src/state/mini-bus-store.js";

describe("MiniBusStore", () => {
  it("serializes concurrent peer writes across separate store instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-mini-bus-store-"));

    try {
      await Promise.all([
        new MiniBusStore(root).upsertPeer({
          name: "planner",
          chatId: -100123,
          messageThreadId: 11,
          conversationKey: "chat:-100123:topic:11",
        }),
        new MiniBusStore(root).upsertPeer({
          name: "writer",
          chatId: -100123,
          messageThreadId: 12,
          conversationKey: "chat:-100123:topic:12",
        }),
      ]);

      await expect(new MiniBusStore(root).listPeers(-100123)).resolves.toEqual([
        expect.objectContaining({ name: "planner" }),
        expect.objectContaining({ name: "writer" }),
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });
});
