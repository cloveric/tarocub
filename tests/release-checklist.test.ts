import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("release checklist", () => {
  it("defines the complete TaroCub release flow", async () => {
    const checklist = await readFile(path.join(process.cwd(), "docs/release-checklist.md"), "utf8");

    expect(checklist).toContain("GitHub Release");
    expect(checklist).toContain("Telegram and Lark");
    expect(checklist).toContain("node dist/src/index.js lark service restart --all");
    expect(checklist).toContain("Do not call a release complete");
    expect(checklist).toContain("external package-registry publishing");
  });

  it("keeps package metadata out of registry publishing", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      private?: boolean;
      bin?: Record<string, string>;
      files?: string[];
      publishConfig?: { access?: string };
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.files).toBeUndefined();
    expect(packageJson.publishConfig).toBeUndefined();
  });
});
