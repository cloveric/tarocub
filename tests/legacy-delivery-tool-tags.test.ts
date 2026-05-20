import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { processLegacyDeliveryTagsAsTools } from "../src/telegram/legacy-delivery-tool-tags.js";

async function withContext<T>(fn: (ctx: {
  root: string;
  inboxDir: string;
  workspaceDir: string;
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendVoice: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
  };
}) => Promise<T>): Promise<T> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), "cctb-legacy-tags-"));
  const root = await realpath(rawRoot);
  const inboxDir = path.join(root, "instance", "inbox");
  const workspaceDir = path.join(root, "instance", "workspace");
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendVoice: vi.fn().mockResolvedValue({ message_id: 3 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 4 }),
  };
  try {
    await mkdir(workspaceDir, { recursive: true });
    return await fn({ root, inboxDir, workspaceDir, api });
  } finally {
    await removeTempRoot(root);
  }
}

describe("processLegacyDeliveryTagsAsTools", () => {
  it("ignores legacy tags that were introduced by tool receipts instead of original model text", async () => {
    await withContext(async ({ inboxDir, workspaceDir, api }) => {
      const secretPath = path.join(workspaceDir, "secret.txt");
      await writeFile(secretPath, "secret", "utf8");
      const text = `✓ Scheduled task added\n📝 check [send-file:${secretPath}]`;

      const output = await processLegacyDeliveryTagsAsTools({
        text,
        allowedTags: [],
        context: {
          cronRuntime: null,
          stateDir: path.dirname(inboxDir),
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
            allowAnyAbsolutePath: true,
          },
        },
      });

      expect(output).toBe(text);
      expect(api.sendDocument).not.toHaveBeenCalled();
    });
  });
});
