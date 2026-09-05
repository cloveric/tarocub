import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractArchive } from "../src/state/archive.js";
import { removeTempRoot } from "./helpers/temp-files.js";

function buildArchive(input: {
  rootName: string;
  filePath?: string;
  content?: string;
  size?: number;
  contentOffset?: number;
}): Buffer {
  const content = Buffer.from(input.content ?? "owned", "utf8");
  const header = Buffer.from(JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    rootName: input.rootName,
    files: [{
      path: input.filePath ?? "owned.txt",
      size: input.size ?? content.length,
      contentOffset: input.contentOffset ?? 0,
    }],
  }), "utf8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);
  return gzipSync(Buffer.concat([Buffer.from("CCTB", "utf8"), headerLength, header, content]));
}

describe("state archive extraction", () => {
  it("stops decompression when an archive expands beyond 128 MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-archive-test-"));
    const destination = path.join(root, "restore-root");
    const archivePath = path.join(root, "gzip-bomb.cctb.gz");

    try {
      await mkdir(destination, { recursive: true });
      await writeFile(archivePath, gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1)));

      await expect(extractArchive(archivePath, destination)).rejects.toThrow(/uncompressed size limit/i);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects an archive manifest with more than 10000 files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-archive-test-"));
    const destination = path.join(root, "restore-root");
    const archivePath = path.join(root, "too-many-files.cctb.gz");
    const files = Array.from({ length: 10_001 }, (_, index) => ({
      path: index === 0 ? "../escape" : `files/${index}.txt`,
      size: 0,
      contentOffset: 0,
    }));
    const header = Buffer.from(JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      rootName: "alpha",
      files,
    }), "utf8");
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length, 0);

    try {
      await mkdir(destination, { recursive: true });
      await writeFile(archivePath, gzipSync(Buffer.concat([
        Buffer.from("CCTB", "utf8"),
        headerLength,
        header,
      ])));

      await expect(extractArchive(archivePath, destination)).rejects.toThrow(/too many files/i);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects an archive rootName that escapes the destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-archive-test-"));
    const destination = path.join(root, "restore-root");
    const archivePath = path.join(root, "malicious.cctb.gz");
    const escapedPath = path.join(root, "escaped", "owned.txt");

    try {
      await mkdir(destination, { recursive: true });
      await writeFile(archivePath, buildArchive({ rootName: "../escaped" }));

      await expect(extractArchive(archivePath, destination)).rejects.toThrow(/unsafe archive root/i);
      await expect(access(escapedPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects file ranges that point outside the archive body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-archive-test-"));
    const destination = path.join(root, "restore-root");
    const archivePath = path.join(root, "truncated.cctb.gz");

    try {
      await mkdir(destination, { recursive: true });
      await writeFile(archivePath, buildArchive({ rootName: "alpha", size: 999 }));

      await expect(extractArchive(archivePath, destination)).rejects.toThrow(/invalid file range/i);
    } finally {
      await removeTempRoot(root);
    }
  });
});
