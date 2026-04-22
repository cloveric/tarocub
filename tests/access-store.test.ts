import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomInt: vi.fn(),
  };
});

import { AccessStore } from "../src/state/access-store.js";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const mockRandomInt = randomInt as unknown as {
  mockImplementation: (implementation: (...args: unknown[]) => number) => void;
  mockReturnValue: (value: number) => void;
  mockReset: () => void;
};

afterEach(() => {
  mockRandomInt.mockReset();
});

function setRandomIntSequence(sequence: number[]): void {
  let index = 0;
  mockRandomInt.mockImplementation(() => {
    const value = sequence[index++];
    if (value === undefined) {
      throw new Error("randomInt sequence exhausted");
    }

    return value;
  });
}

describe("AccessStore", () => {
  it("returns isolated default state objects for different stores", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const storeA = new AccessStore(path.join(dir, "access-a.json"));
      const storeB = new AccessStore(path.join(dir, "access-b.json"));

      const stateA = await storeA.load();
      stateA.allowlist.push(123);

      const stateB = await storeB.load();

      expect(stateB).toEqual({
        multiChat: false,
        policy: "pairing",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates policy, allowlist, and status summaries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const store = new AccessStore(path.join(dir, "access.json"));

      await store.setPolicy("allowlist");
      await store.setMultiChat(true);
      await store.allowChat(123);
      await store.allowChat(456);
      await store.allowChat(123);
      await store.revokeChat(456);

      const status = await store.getStatus();

      expect(status).toEqual({
        multiChat: true,
        policy: "allowlist",
        pairedUsers: 0,
        allowlist: [123],
        pendingPairs: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists pairing codes and paired users", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      expect(issued.code).toHaveLength(6);

      const pairedUser = await store.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"));

      expect(pairedUser?.telegramUserId).toBe(42);

      const state = await store.load();
      expect(state.pairedUsers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes pending pairing codes when revoking a chat", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      await store.revokeChat(84);

      await expect(store.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"))).resolves.toBeNull();
      expect((await store.load()).pendingPairs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes expired pairing codes when redeeming them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      const pairedUser = await store.redeemPairingCode(issued.code, new Date("2026-04-08T00:06:00Z"));

      expect(pairedUser).toBeNull();
      expect((await store.load()).pendingPairs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses the active pending pairing code for the same user and chat", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      setRandomIntSequence([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
      const store = new AccessStore(path.join(dir, "access.json"));

      const firstIssued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });
      const secondIssued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:01:00Z"),
      });

      const state = await store.load();

      expect(firstIssued.code).toBe("AAAAAA");
      expect(secondIssued.code).toBe("AAAAAA");
      expect(state.pendingPairs).toHaveLength(1);
      expect(state.pendingPairs[0]?.code).toBe("AAAAAA");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an invalid pairing code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      await expect(store.redeemPairingCode("ZZZZZZ", new Date("2026-04-08T00:01:00Z"))).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent access mutations without losing updates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const store = new AccessStore(path.join(dir, "access.json"));
      await store.setMultiChat(true);

      await Promise.all([
        store.allowChat(101),
        store.allowChat(202),
        store.allowChat(303),
      ]);

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        allowlist: [101, 202, 303],
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks authorizing a second chat until multi-chat is explicitly enabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      await store.allowChat(111);

      await expect(store.allowChat(222)).rejects.toThrow(
        "instance is locked to another chat until multi-chat is enabled",
      );

      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 111,
        now: new Date("2026-04-08T00:00:00Z"),
      });
      await expect(
        store.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z")),
      ).resolves.toEqual({
        telegramUserId: 42,
        telegramChatId: 111,
        pairedAt: "2026-04-08T00:01:00.000Z",
      });

      await store.setMultiChat(true);
      await store.allowChat(222);

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        multiChat: true,
        allowlist: [111, 222],
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a pending pairing code intact when redemption is blocked by single-chat mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(dir, "access.json");
    try {
      const store = new AccessStore(filePath);
      await writeFile(
        filePath,
        JSON.stringify({
          multiChat: false,
          policy: "pairing",
          pairedUsers: [],
          allowlist: [],
          pendingPairs: [
            {
              code: "AAAAAA",
              telegramUserId: 10,
              telegramChatId: 111,
              expiresAt: "2026-04-08T00:05:00.000Z",
            },
            {
              code: "BBBBBB",
              telegramUserId: 20,
              telegramChatId: 222,
              expiresAt: "2026-04-08T00:07:00.000Z",
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      await store.redeemPairingCode("AAAAAA", new Date("2026-04-08T00:01:00Z"));

      await expect(
        store.redeemPairingCode("BBBBBB", new Date("2026-04-08T00:03:00Z")),
      ).rejects.toThrow("instance is locked to another chat until multi-chat is enabled");

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        pendingPairs: [
          expect.objectContaining({
            code: "BBBBBB",
            telegramChatId: 222,
            telegramUserId: 20,
          }),
        ],
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks issuing a second pairing code while another chat already holds the single-chat lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      setRandomIntSequence([0, 0, 0, 0, 0, 0]);
      const store = new AccessStore(path.join(dir, "access.json"));

      const firstCode = await store.issuePairingCode({
        telegramUserId: 10,
        telegramChatId: 111,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      await expect(
        store.issuePairingCode({
          telegramUserId: 20,
          telegramChatId: 222,
          now: new Date("2026-04-08T00:02:00Z"),
        }),
      ).rejects.toThrow("instance is locked to another chat until multi-chat is enabled");

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        pendingPairs: [
          expect.objectContaining({
            code: firstCode.code,
            telegramChatId: 111,
            telegramUserId: 10,
          }),
        ],
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to disable multi-chat while another chat is still pending pairing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));

      await store.setMultiChat(true);
      await store.allowChat(111);
      await store.issuePairingCode({
        telegramUserId: 20,
        telegramChatId: 222,
        now: new Date("2026-04-08T00:02:00Z"),
      });

      await expect(store.setMultiChat(false)).rejects.toThrow(
        "cannot disable multi-chat while multiple chats are authorized or pending pairing",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent access mutations across separate processes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const scriptPath = path.join(dir, "allow-chat.ts");
    const filePath = path.join(dir, "access.json");
    try {
      await writeFile(scriptPath, [
        "import { AccessStore } from '/Users/cloveric/projects/cc-telegram-bridge/src/state/access-store.ts';",
        "(async () => {",
        "  const [file, chatId, multi] = process.argv.slice(2);",
        "  const store = new AccessStore(file);",
        "  if (multi === 'on') await store.setMultiChat(true);",
        "  await store.allowChat(Number(chatId));",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      await new AccessStore(filePath).setMultiChat(true);
      await Promise.all([
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, filePath, "111", "on"], "/Users/cloveric/projects/cc-telegram-bridge"),
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, filePath, "222", "on"], "/Users/cloveric/projects/cc-telegram-bridge"),
      ]);

      await expect(new AccessStore(filePath).load()).resolves.toEqual(expect.objectContaining({
        allowlist: expect.arrayContaining([111, 222]),
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify(
          {
            policy: "pairing",
            pairedUsers: [{}],
            allowlist: [],
            pendingPairs: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const store = new AccessStore(filePath);
      await expect(store.load()).rejects.toThrow("invalid access state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt pairedAt timestamp string in persisted access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify(
          {
            policy: "pairing",
            pairedUsers: [
              {
                telegramUserId: 42,
                telegramChatId: 84,
                pairedAt: "not-a-timestamp",
              },
            ],
            allowlist: [],
            pendingPairs: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const store = new AccessStore(filePath);
      await expect(store.load()).rejects.toThrow("invalid access state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt expiresAt timestamp string in persisted access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify(
          {
            policy: "pairing",
            pairedUsers: [],
            allowlist: [],
            pendingPairs: [
              {
                code: "ABC123",
                telegramUserId: 42,
                telegramChatId: 84,
                expiresAt: "also-not-a-timestamp",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const store = new AccessStore(filePath);
      await expect(store.load()).rejects.toThrow("invalid access state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-integer telegram identifiers in persisted access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify(
          {
            policy: "pairing",
            pairedUsers: [
              {
                telegramUserId: 42.5,
                telegramChatId: 84,
                pairedAt: "2026-04-08T00:00:00.000Z",
              },
            ],
            allowlist: [84.25],
            pendingPairs: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const store = new AccessStore(filePath);
      await expect(store.load()).rejects.toThrow("invalid access state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips unexpected extra fields from persisted access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify({
          policy: "pairing",
          pairedUsers: [
            {
              telegramUserId: 42,
              telegramChatId: 84,
              pairedAt: "2026-04-08T00:00:00.000Z",
              rogue: true,
            },
          ],
          allowlist: [],
          pendingPairs: [],
        }),
        "utf8",
      );

      await expect(new AccessStore(filePath).load()).resolves.toEqual({
        multiChat: false,
        policy: "pairing",
        pairedUsers: [
          {
            telegramUserId: 42,
            telegramChatId: 84,
            pairedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        allowlist: [],
        pendingPairs: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
