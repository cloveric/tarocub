import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { SessionManager, SessionStateError } from "../src/runtime/session-manager.js";
import { JsonStore } from "../src/state/json-store.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CodexAdapter } from "../src/codex/adapter.js";

describe("SessionManager", () => {
  it("returns a logical placeholder before a real thread is bound", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);

    try {
      await expect(manager.getOrCreateSession(84)).resolves.toEqual({
        sessionId: "telegram-84",
      });
      expect(adapter.createSession).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("returns a bound thread id after the chat is persisted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);

    try {
      await manager.bindSession(84, "thread-123");

      await expect(manager.getOrCreateSession(84)).resolves.toEqual({
        sessionId: "thread-123",
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("throws a repairable session-state error for malformed session state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);

    try {
      vi.spyOn((sessionStore as unknown as { store: JsonStore<unknown> }).store, "read").mockRejectedValueOnce(
        new SyntaxError("Unexpected token"),
      );

      const sessionPromise = manager.getOrCreateSession(84);
      await expect(sessionPromise).rejects.toMatchObject({
        name: "SessionStateError",
        repairable: true,
        message: "Session state is unreadable right now. The operator needs to repair session state and retry.",
      });
      await expect(sessionPromise).rejects.toBeInstanceOf(SessionStateError);
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("throws a non-repairable session-state error for permission-denied session state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn((sessionStore as unknown as { store: JsonStore<unknown> }).store, "read");

    readSpy.mockRejectedValue(permissionError);

    try {
      const sessionPromise = manager.getOrCreateSession(84);
      await expect(sessionPromise).rejects.toMatchObject({
        name: "SessionStateError",
        repairable: false,
        message: "Session state is unavailable right now. The operator needs to restore read access and retry.",
      });
      await expect(sessionPromise).rejects.toBeInstanceOf(SessionStateError);
    } finally {
      readSpy.mockRestore();
      await removeTempRoot(tempDir);
    }
  });
});
