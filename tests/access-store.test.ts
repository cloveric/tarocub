import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childProcessTestEnv, removeTempRoot } from "./helpers/temp-files.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomInt: vi.fn(),
  };
});

import { AccessStore, findConflictingLockedChatId } from "../src/state/access-store.js";
import { JsonStore } from "../src/state/json-store.js";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
// Repo root derived from this test file, so the spawned-subprocess tests work from
// any checkout (any user, any folder name — not a hardcoded /Users/.../cc-telegram-bridge).
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcImportUrl = (rel: string): string => pathToFileURL(path.join(repoRoot, rel)).href;

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: childProcessTestEnv() }, (error) => {
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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

      expect(issued.code).toHaveLength(8);

      const pairedUser = await store.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"));

      expect(pairedUser?.telegramUserId).toBe(42);

      const state = await store.load();
      expect(state.pairedUsers).toHaveLength(1);
    } finally {
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
    }
  });

  it("reuses the active pending pairing code for the same user and chat", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      setRandomIntSequence([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
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

      expect(firstIssued.code).toBe("AAAAAAAA");
      expect(secondIssued.code).toBe("AAAAAAAA");
      expect(state.pendingPairs).toHaveLength(1);
      expect(state.pendingPairs[0]?.code).toBe("AAAAAAAA");
    } finally {
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
    }
  });

  it("does not quarantine a valid access file written while a corrupt-state read is recovering", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(dir, "access.json");
    let releaseFirstQuarantine!: () => void;
    let firstQuarantineStarted!: () => void;
    const quarantineStarted = new Promise<void>((resolve) => {
      firstQuarantineStarted = resolve;
    });
    const quarantineGate = new Promise<void>((resolve) => {
      releaseFirstQuarantine = resolve;
    });
    const originalQuarantine = JsonStore.prototype.quarantineCurrentFile;
    let quarantineCalls = 0;
    const quarantineSpy = vi.spyOn(JsonStore.prototype, "quarantineCurrentFile").mockImplementation(async function (
      this: JsonStore<unknown>,
      reason,
    ) {
      quarantineCalls += 1;
      if (quarantineCalls === 1) {
        firstQuarantineStarted();
        await quarantineGate;
      }
      return await originalQuarantine.call(this, reason);
    });

    try {
      await writeFile(filePath, "{broken", "utf8");
      const store = new AccessStore(filePath);
      const status = store.getStatus();
      await quarantineStarted;

      const allow = store.allowChat(123);
      await Promise.race([
        allow.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
      releaseFirstQuarantine();
      await Promise.all([status, allow]);

      await expect(store.load()).resolves.toEqual(expect.objectContaining({ allowlist: [123] }));
    } finally {
      releaseFirstQuarantine?.();
      quarantineSpy.mockRestore();
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
    }
  });

  it("preserves unknown access-state fields for forward compatibility", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(dir, "access.json");

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          multiChat: false,
          policy: "pairing",
          pairedUsers: [
            {
              telegramUserId: 42,
              telegramChatId: 84,
              pairedAt: "2026-04-08T00:00:00.000Z",
              profile: "legacy",
            },
          ],
          allowlist: [],
          pendingPairs: [
            {
              code: "AAAAAA",
              telegramUserId: 42,
              telegramChatId: 84,
              expiresAt: "2026-04-08T00:05:00.000Z",
              source: "legacy",
            },
          ],
          futureFlag: true,
        }, null, 2) + "\n",
        "utf8",
      );

      const store = new AccessStore(filePath);
      const state = await store.load() as unknown as {
        futureFlag?: boolean;
        pairedUsers: Array<{ profile?: string }>;
        pendingPairs: Array<{ source?: string }>;
      };

      expect(state.futureFlag).toBe(true);
      expect(state.pairedUsers[0]?.profile).toBe("legacy");
      expect(state.pendingPairs[0]?.source).toBe("legacy");
    } finally {
      await removeTempRoot(dir);
    }
  });

  it("lets multiple chats request codes but lets only the first redemption acquire the single-chat lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      setRandomIntSequence([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
      const store = new AccessStore(path.join(dir, "access.json"));

      const firstCode = await store.issuePairingCode({
        telegramUserId: 10,
        telegramChatId: 111,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      const secondCode = await store.issuePairingCode({
        telegramUserId: 20,
        telegramChatId: 222,
        now: new Date("2026-04-08T00:02:00Z"),
      });

      await expect(store.redeemPairingCode(firstCode.code, new Date("2026-04-08T00:03:00Z"))).resolves.toMatchObject({
        telegramChatId: 111,
      });
      await expect(store.redeemPairingCode(secondCode.code, new Date("2026-04-08T00:03:30Z")))
        .rejects.toThrow("instance is locked to another chat until multi-chat is enabled");

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        pairedUsers: [expect.objectContaining({ telegramChatId: 111, telegramUserId: 10 })],
        pendingPairs: [expect.objectContaining({ code: secondCode.code, telegramChatId: 222, telegramUserId: 20 })],
      }));
    } finally {
      await removeTempRoot(dir);
    }
  });

  it("allows disabling multi-chat while only unredeemed pairing codes exist", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));

      await store.setMultiChat(true);
      await store.allowChat(111);
      // An unredeemed code is not authorization and must not prevent returning
      // to single-chat mode while only one chat is actually authorized.
      await store.issuePairingCode({
        telegramUserId: 20,
        telegramChatId: 222,
        now: new Date(),
      });

      await expect(store.setMultiChat(false)).resolves.toBeUndefined();
    } finally {
      await removeTempRoot(dir);
    }
  });

  it("does not let an expired pending pair lock the instance against a new chat", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      setRandomIntSequence([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
      const store = new AccessStore(path.join(dir, "access.json"));

      await store.issuePairingCode({
        telegramUserId: 10,
        telegramChatId: 111,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      // 6 minutes later the 5-minute pair for chat 111 is expired; a different chat
      // must be able to start pairing (previously locked out forever).
      const issued = await store.issuePairingCode({
        telegramUserId: 20,
        telegramChatId: 222,
        now: new Date("2026-04-08T00:06:00Z"),
      });

      expect(issued.telegramChatId).toBe(222);
      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        pendingPairs: [
          expect.objectContaining({
            code: issued.code,
            telegramChatId: 222,
            telegramUserId: 20,
          }),
        ],
      }));
    } finally {
      await removeTempRoot(dir);
    }
  });

  it("never treats unredeemed pairing codes as a single-chat lock", async () => {
    const state = {
      multiChat: false,
      policy: "pairing" as const,
      pairedUsers: [],
      allowlist: [],
      pendingPairs: [
        {
          code: "AAAAAAAA",
          telegramUserId: 10,
          telegramChatId: 111,
          expiresAt: "2026-04-08T00:05:00.000Z",
        },
      ],
    };

    expect(findConflictingLockedChatId(state, 222, new Date("2026-04-08T00:06:00Z"))).toBeNull();
    expect(findConflictingLockedChatId(state, 222, new Date("2026-04-08T00:04:00Z"))).toBeNull();
  });

  it("prunes expired pending pairs from disk on unrelated mutations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(dir, "access.json");
    try {
      await writeFile(
        filePath,
        JSON.stringify({
          multiChat: true,
          policy: "pairing",
          pairedUsers: [],
          allowlist: [],
          pendingPairs: [
            {
              code: "AAAAAAAA",
              telegramUserId: 10,
              telegramChatId: 111,
              expiresAt: "2020-01-01T00:00:00.000Z",
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      const store = new AccessStore(filePath);
      await store.allowChat(333);

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        allowlist: [333],
        pendingPairs: [],
      }));
    } finally {
      await removeTempRoot(dir);
    }
  });

  it("allows disabling multi-chat once the other chat's pending pair has expired", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(dir, "access.json");
    try {
      await writeFile(
        filePath,
        JSON.stringify({
          multiChat: true,
          policy: "pairing",
          pairedUsers: [],
          allowlist: [111],
          pendingPairs: [
            {
              code: "AAAAAAAA",
              telegramUserId: 20,
              telegramChatId: 222,
              expiresAt: "2020-01-01T00:00:00.000Z",
            },
          ],
        }, null, 2) + "\n",
        "utf8",
      );

      const store = new AccessStore(filePath);
      await store.setMultiChat(false);

      await expect(store.load()).resolves.toEqual(expect.objectContaining({
        multiChat: false,
        allowlist: [111],
        pendingPairs: [],
      }));
    } finally {
      await removeTempRoot(dir);
    }
  });

  it("serializes concurrent access mutations across separate processes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const scriptPath = path.join(dir, "allow-chat.ts");
    const filePath = path.join(dir, "access.json");
    try {
      await writeFile(scriptPath, [
        `import { AccessStore } from '${srcImportUrl("src/state/access-store.ts")}';`,
        "(async () => {",
        "  const [file, chatId, multi] = process.argv.slice(2);",
        "  const store = new AccessStore(file);",
        "  if (multi === 'on') await store.setMultiChat(true);",
        "  await store.allowChat(Number(chatId));",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      await new AccessStore(filePath).setMultiChat(true);
      await Promise.all([
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, filePath, "111", "on"], repoRoot),
        execFileAsync(process.execPath, [tsxCliPath, scriptPath, filePath, "222", "on"], repoRoot),
      ]);

      await expect(new AccessStore(filePath).load()).resolves.toEqual(expect.objectContaining({
        allowlist: expect.arrayContaining([111, 222]),
      }));
    } finally {
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
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
      await removeTempRoot(dir);
    }
  });

  it("preserves unexpected extra fields from persisted access state", async () => {
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

      await expect(new AccessStore(filePath).load()).resolves.toEqual(expect.objectContaining({
        multiChat: false,
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
      }));
    } finally {
      await removeTempRoot(dir);
    }
  });
});
