import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appendSavedArtifactDeliveryTags } from "../src/codex/generated-files.js";

describe("appendSavedArtifactDeliveryTags", () => {
  it("turns explicit saved workspace artifacts into deduplicated delivery tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-saved-artifacts-"));
    const workspace = path.join(root, "workspace");
    const imagePath = path.join(workspace, "chart.png");
    const csvPath = path.join(workspace, "report data.csv");
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(imagePath, "png", "utf8");
      await writeFile(csvPath, "a,b\n1,2\n", "utf8");

      const result = await appendSavedArtifactDeliveryTags([
        `saved ${imagePath}`,
        `Saved image to ${imagePath}`,
        `wrote file "${csvPath}"`,
      ].join("\n"), workspace);

      expect(result.match(/\[send-image:/g)).toHaveLength(1);
      expect(result).toContain(`[send-image:${imagePath}]`);
      expect(result).toContain(`[send-file:${csvPath}]`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, hidden, unsupported, and workspace-escaping paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-saved-artifacts-safe-"));
    const workspace = path.join(root, "workspace");
    const hiddenDir = path.join(workspace, ".private");
    const outsideImage = path.join(root, "outside.png");
    const escapedLink = path.join(workspace, "escaped.png");
    const hiddenImage = path.join(hiddenDir, "secret.png");
    const unsupported = path.join(workspace, "state.json");
    try {
      await mkdir(hiddenDir, { recursive: true });
      await writeFile(outsideImage, "outside", "utf8");
      await writeFile(hiddenImage, "hidden", "utf8");
      await writeFile(unsupported, "{}", "utf8");
      await symlink(outsideImage, escapedLink);

      const result = await appendSavedArtifactDeliveryTags([
        `saved ${outsideImage}`,
        `saved ${escapedLink}`,
        `saved ${hiddenImage}`,
        `saved ${unsupported}`,
        `saved ${path.join(workspace, "missing.pdf")}`,
        `traceback referenced ${path.join(workspace, "ordinary.png")}`,
      ].join("\n"), workspace);

      expect(result).not.toContain("[send-image:");
      expect(result).not.toContain("[send-file:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
