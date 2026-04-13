import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { tryDecodeWorkspacePath } from "../src/runtime/session-scanner.js";

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
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a directory name containing dashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-decode-"));
    const target = path.join(root, "cc-telegram-bridge");
    await mkdir(target, { recursive: true });
    try {
      const encoded = root.replace(/[/.]/g, "-") + "-cc-telegram-bridge";
      expect(tryDecodeWorkspacePath(encoded)).toBe(target);
    } finally {
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when the decoded path does not exist", () => {
    expect(tryDecodeWorkspacePath("-nonexistent-path-that-does-not-exist")).toBeNull();
  });
});
