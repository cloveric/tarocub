import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempRoot } from "./helpers/temp-files.js";

import {
  formatAntigravityConversationList,
  scanRecentAntigravityConversations,
  tryDecodeWorkspacePath,
  scanRecentClaudeSessions,
} from "../src/runtime/session-scanner.js";

describe("tryDecodeWorkspacePath", () => {
  it("returns null for dirnames that don't start with dash", () => {
    expect(tryDecodeWorkspacePath("Users-foo")).toBeNull();
    expect(tryDecodeWorkspacePath("")).toBeNull();
  });

  it("resolves a simple path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-decode-"));
    const target = path.join(root, "aaa", "bbb");
    await mkdir(target, { recursive: true });
    try {
      // /root/aaa/bbb → encoded as -<root-encoded>-aaa-bbb
      const encoded = root.replace(/[/.]/g, "-") + "-aaa-bbb";
      expect(tryDecodeWorkspacePath(encoded)).toBe(target);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("resolves a Windows drive-letter path", () => {
    expect(tryDecodeWorkspacePath("E--claude", (candidate) => candidate === "E:/claude")).toBe("E:/claude");
  });

  it("does not turn ambiguous Windows double dashes into bogus empty segments", () => {
    expect(tryDecodeWorkspacePath("E--C--D", (candidate) => candidate === "E:/C/D")).toBe("E:/C/D");
  });

  it("still resolves real dot-prefixed Windows segments when they exist", () => {
    expect(tryDecodeWorkspacePath("E--C--D", (candidate) => candidate === "E:/C/.D")).toBe("E:/C/.D");
  });

  it("resolves a directory name containing dashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-decode-"));
    const target = path.join(root, "cc-telegram-bridge");
    await mkdir(target, { recursive: true });
    try {
      const encoded = root.replace(/[/.]/g, "-") + "-cc-telegram-bridge";
      expect(tryDecodeWorkspacePath(encoded)).toBe(target);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("prefers dash-joined name over split sub-path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-decode-"));
    // Create BOTH foo-bar (single dir) and foo/bar (nested)
    await mkdir(path.join(root, "foo-bar"), { recursive: true });
    await mkdir(path.join(root, "foo", "bar"), { recursive: true });
    try {
      const encoded = root.replace(/[/.]/g, "-") + "-foo-bar";
      // Should prefer foo-bar (longest match), not foo/bar
      expect(tryDecodeWorkspacePath(encoded)).toBe(path.join(root, "foo-bar"));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("resolves a dot-prefixed directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-decode-"));
    const target = path.join(root, ".hidden", "sub");
    await mkdir(target, { recursive: true });
    try {
      // .hidden → encoded as --hidden (dot becomes dash, preceding slash becomes dash)
      const encoded = root.replace(/[/.]/g, "-") + "--hidden-sub";
      expect(tryDecodeWorkspacePath(encoded)).toBe(target);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("resolves a dot-prefixed directory with dashes in its name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-decode-"));
    const target = path.join(root, ".foo-bar");
    await mkdir(target, { recursive: true });
    try {
      // .foo-bar → encoded as --foo-bar
      const encoded = root.replace(/[/.]/g, "-") + "--foo-bar";
      expect(tryDecodeWorkspacePath(encoded)).toBe(target);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("returns null when the decoded path does not exist", () => {
    expect(tryDecodeWorkspacePath("-nonexistent-path-that-does-not-exist")).toBeNull();
  });
});

describe("scanRecentClaudeSessions", () => {
  it("finds sessions under USERPROFILE when HOME is unset", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "cctb-userprofile-"));
    const projectDir = path.join(fakeHome, ".claude", "projects", "-fake-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), "{}\n", "utf8");

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    try {
      delete process.env.HOME;
      process.env.USERPROFILE = fakeHome;

      const sessions = await scanRecentClaudeSessions(1);
      const match = sessions.find((s) => s.sessionId === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(match).toBeDefined();
      expect(match!.dirName).toBe("-fake-project");
    } finally {
      process.env.HOME = origHome;
      if (origUserProfile !== undefined) {
        process.env.USERPROFILE = origUserProfile;
      } else {
        delete process.env.USERPROFILE;
      }
      await removeTempRoot(fakeHome);
    }
  });

  it("finds sessions under CLAUDE_CONFIG_DIR when it's set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-claude-config-dir-"));
    const customClaudeDir = path.join(root, "custom-claude");
    const fakeHome = path.join(root, "fake-home");
    const projectDir = path.join(customClaudeDir, "projects", "-fake-project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    await writeFile(path.join(projectDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), "{}\n", "utf8");

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.HOME = fakeHome;
      delete process.env.USERPROFILE;
      process.env.CLAUDE_CONFIG_DIR = customClaudeDir;

      const sessions = await scanRecentClaudeSessions(1);
      const match = sessions.find((s) => s.sessionId === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(match).toBeDefined();
      expect(match!.dirName).toBe("-fake-project");
    } finally {
      if (origHome !== undefined) {
        process.env.HOME = origHome;
      } else {
        delete process.env.HOME;
      }
      if (origUserProfile !== undefined) {
        process.env.USERPROFILE = origUserProfile;
      } else {
        delete process.env.USERPROFILE;
      }
      if (origClaudeConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
      } else {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
      await removeTempRoot(root);
    }
  });
});

describe("scanRecentAntigravityConversations", () => {
  it("finds recent Antigravity conversations from CLI logs", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "cctb-antigravity-home-"));
    const logDir = path.join(fakeHome, ".gemini", "antigravity-cli", "log");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, "cli-20260520_095913.log"),
      [
        "I0520 09:59:13 printmode.go:130] Print mode: conversation=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, sending message",
        "I0520 10:00:13 printmode.go:130] Print mode: conversation=ffffffff-1111-2222-3333-444444444444, sending message",
      ].join("\n"),
      "utf8",
    );

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = fakeHome;
      delete process.env.USERPROFILE;

      const sessions = await scanRecentAntigravityConversations(24);
      expect(sessions.map((session) => session.sessionId)).toEqual([
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "ffffffff-1111-2222-3333-444444444444",
      ]);
      expect(sessions[0]).toMatchObject({
        dirName: "antigravity",
        workspacePath: null,
        displayName: "conversation aaaaaaaa",
      });
    } finally {
      if (origHome !== undefined) {
        process.env.HOME = origHome;
      } else {
        delete process.env.HOME;
      }
      if (origUserProfile !== undefined) {
        process.env.USERPROFILE = origUserProfile;
      } else {
        delete process.env.USERPROFILE;
      }
      await removeTempRoot(fakeHome);
    }
  });

  it("formats Antigravity conversation picks separately from Claude sessions", () => {
    const now = Date.now();
    const message = formatAntigravityConversationList([
      {
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        dirName: "antigravity",
        workspacePath: null,
        modifiedAt: new Date(now - 60_000),
        displayName: "conversation aaaaaaaa",
      },
    ], "en");

    expect(message).toContain("Recent Antigravity conversations:");
    expect(message).toContain("Reply /resume <number> to attach that conversation.");
  });

  it("caps formatted Antigravity conversation picks to keep Telegram replies short", () => {
    const now = Date.now();
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      sessionId: `${String(index).padStart(8, "0")}-bbbb-cccc-dddd-eeeeeeeeeeee`,
      dirName: "antigravity",
      workspacePath: null,
      modifiedAt: new Date(now - index * 60_000),
      displayName: `conversation ${String(index).padStart(8, "0")}`,
    }));

    const message = formatAntigravityConversationList(sessions, "en");

    expect(message).toContain("…showing 20 of 25 most recent.");
    expect(message).toContain("20. [conversation 00000019]");
    expect(message).not.toContain("21. [conversation 00000020]");
  });
});
