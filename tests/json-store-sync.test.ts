import { afterEach, describe, expect, it, vi } from "vitest";

describe("JsonStore fsync behavior", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:fs/promises");
  });

  it("syncs the temp file and parent directory during atomic writes", async () => {
    const syncTargets: string[] = [];
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      open: vi.fn(async (filePath: string, flags: string) => {
        const handle = await actualFs.open(filePath, flags);
        return {
          ...handle,
          sync: async () => {
            syncTargets.push(filePath);
            return handle.sync();
          },
        };
      }),
    }));

    const os = await import("node:os");
    const path = await import("node:path");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { JsonStore } = await import("../src/state/json-store.js");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new JsonStore(filePath);

    try {
      await store.write({ chats: [] });

      expect(syncTargets).toHaveLength(2);
      expect(syncTargets[0]).toMatch(/session\.json\..+\.tmp$/);
      expect(syncTargets[1]).toBe(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("degrades when parent directory sync is unsupported", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      open: vi.fn(async (filePath: string, flags: string) => {
        if (!String(filePath).endsWith(".tmp")) {
          const error = new Error("directory sync unsupported") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }

        return actualFs.open(filePath, flags);
      }),
    }));

    const os = await import("node:os");
    const path = await import("node:path");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { JsonStore } = await import("../src/state/json-store.js");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new JsonStore(filePath);

    try {
      await expect(store.write({ chats: [] })).resolves.toBeUndefined();
      await expect(readFile(filePath, "utf8")).resolves.toContain('"chats": []');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
