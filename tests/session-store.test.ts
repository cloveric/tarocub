import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import { JsonStore } from "../src/state/json-store.js";
import { SESSION_STATE_UNREADABLE_WARNING, SessionStore } from "../src/state/session-store.js";
import type { SessionRecord, SessionState } from "../src/types.js";

describe("JsonStore", () => {
  it("writes and reads SessionState atomically from a temp directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new JsonStore<SessionState>(filePath, (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "chats" in value &&
        Array.isArray((value as SessionState).chats)
      ) {
        return value as SessionState;
      }

      throw new Error("invalid session state");
    });
    const value: SessionState = {
      chats: [
        {
          telegramChatId: 123,
          codexSessionId: "session-1",
          status: "running",
          updatedAt: "2026-04-08T03:00:00.000Z",
        },
      ],
    };

    try {
      await writeFile(`${filePath}.tmp`, "stale-temp-file", "utf8");
      await store.write(value);

      const onDisk = JSON.parse(await readFile(filePath, "utf8")) as typeof value & { schemaVersion?: number };
      expect(onDisk.chats).toEqual(value.chats);
      expect(onDisk.schemaVersion).toBe(1);
      expect(await readFile(`${filePath}.tmp`, "utf8")).toBe("stale-temp-file");

      const readBack = await store.read({ chats: [] });
      expect(readBack.chats).toEqual(value.chats);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rewrites legacy schemaVersion to the current version on write", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new JsonStore<SessionState>(filePath, (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "chats" in value &&
        Array.isArray((value as SessionState).chats)
      ) {
        return value as SessionState;
      }

      throw new Error("invalid session state");
    });

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: 0,
          chats: [
            {
              telegramChatId: 123,
              codexSessionId: "session-1",
              status: "running",
              updatedAt: "2026-04-08T03:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      const readBack = await store.read({ chats: [] });
      await store.write(readBack);

      const onDisk = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion?: number };
      expect(onDisk.schemaVersion).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

});

describe("SessionStore", () => {
  function createRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      telegramChatId: 123,
      codexSessionId: "session-1",
      status: "running",
      updatedAt: "2026-04-08T03:00:00.000Z",
      ...overrides,
    };
  }

  it("upsert then findByChatId", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      const record = createRecord();
      await store.upsert(record);

      await expect(store.findByChatId(123)).resolves.toEqual(record);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("upsert replaces existing record for the same chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await store.upsert(createRecord({ codexSessionId: "session-1", status: "running" }));
      await store.upsert(createRecord({ codexSessionId: "session-2", status: "queued" }));

      await expect(store.findByChatId(123)).resolves.toEqual(createRecord({ codexSessionId: "session-2", status: "queued" }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("upsert keeps concurrent writes from losing records", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      const writes = [
        store.upsert(createRecord({ telegramChatId: 101, codexSessionId: "session-101" })),
        store.upsert(createRecord({ telegramChatId: 102, codexSessionId: "session-102" })),
        store.upsert(createRecord({ telegramChatId: 103, codexSessionId: "session-103" })),
      ];

      await Promise.all(writes);

      await expect(store.findByChatId(101)).resolves.toEqual(
        createRecord({ telegramChatId: 101, codexSessionId: "session-101" }),
      );
      await expect(store.findByChatId(102)).resolves.toEqual(
        createRecord({ telegramChatId: 102, codexSessionId: "session-102" }),
      );
      await expect(store.findByChatId(103)).resolves.toEqual(
        createRecord({ telegramChatId: 103, codexSessionId: "session-103" }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes a single chat session without touching other bindings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await store.upsert({
        telegramChatId: 100,
        codexSessionId: "thread-a",
        status: "idle",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.upsert({
        telegramChatId: 200,
        codexSessionId: "thread-b",
        status: "idle",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });

      await store.removeByChatId(100);
      const state = await store.load();

      expect(state.chats).toEqual([
        expect.objectContaining({ telegramChatId: 200, codexSessionId: "thread-b" }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removeByChatId returns true for an existing chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await store.upsert(createRecord({ telegramChatId: 100 }));

      await expect(store.removeByChatId(100)).resolves.toBe(true);
      await expect(store.findByChatId(100)).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removeByChatId returns false for a missing chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await expect(store.removeByChatId(999)).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns fresh default state when the file is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      const first = await store.load();
      first.chats.push(createRecord());

      const second = await store.load();
      expect(second.chats).toEqual([]);
      expect(second).not.toBe(first);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt persisted state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          chats: [
            {
              telegramChatId: 123,
              codexSessionId: "session-1",
              status: "not-a-real-status",
              updatedAt: "2026-04-08T03:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid session state");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("strips unexpected extra fields from persisted session records", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          chats: [
            {
              telegramChatId: 123,
              codexSessionId: "session-1",
              status: "running",
              updatedAt: "2026-04-08T03:00:00.000Z",
              rogue: true,
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).resolves.toEqual({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "session-1",
            status: "running",
            updatedAt: "2026-04-08T03:00:00.000Z",
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects non-integer chat identifiers in persisted session state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          chats: [
            {
              telegramChatId: 123.5,
              codexSessionId: "session-1",
              status: "running",
              updatedAt: "2026-04-08T03:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid session state");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats permission-denied reads as unreadable session state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn((store as unknown as { store: JsonStore<SessionState> }).store, "read");

    readSpy.mockRejectedValue(permissionError);

    try {
      await expect(store.inspect()).resolves.toEqual({
        state: { chats: [] },
        warning: SESSION_STATE_UNREADABLE_WARNING,
        repairable: false,
      });
    } finally {
      readSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats malformed reads as repairable unreadable session state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await writeFile(filePath, "{not valid json", "utf8");

      await expect(store.inspect()).resolves.toEqual({
        state: { chats: [] },
        warning: SESSION_STATE_UNREADABLE_WARNING,
        repairable: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("quarantines unreadable session state before resetting during targeted recovery", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);
    const unreadableContents = "{not valid json";

    try {
      await writeFile(filePath, unreadableContents, "utf8");

      await expect(store.removeByChatIdRecovering(123)).resolves.toEqual({
        removed: false,
        repaired: true,
      });

      const after = JSON.parse(await readFile(filePath, "utf8")) as { chats: unknown[] };
      expect(after.chats).toEqual([]);
      const backups = (await readdir(tempDir)).filter((entry) => entry.startsWith("session.json.") && !entry.endsWith(".tmp"));
      expect(backups).toHaveLength(1);
      await expect(readFile(path.join(tempDir, backups[0]!), "utf8")).resolves.toBe(unreadableContents);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat permission-denied targeted recovery as self-healing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn((store as unknown as { store: JsonStore<SessionState> }).store, "read");

    readSpy.mockRejectedValue(permissionError);

    try {
      await expect(store.removeByChatIdRecovering(123)).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      readSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
