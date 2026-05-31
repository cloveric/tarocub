import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("release checklist", () => {
  it("defines the complete TaroCub release flow", async () => {
    const checklist = await readFile(path.join(process.cwd(), "docs/release-checklist.md"), "utf8");

    expect(checklist).toContain("GitHub Release");
    expect(checklist).toContain("npm publish");
    expect(checklist).toContain("Telegram and Lark");
    expect(checklist).toContain("node dist/src/index.js lark service restart --all");
    expect(checklist).toContain("Do not call a release complete");
  });

  it("keeps package metadata aligned with npm publish releases", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      private?: boolean;
      bin?: Record<string, string>;
      files?: string[];
      publishConfig?: { access?: string };
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.bin?.tarocub).toBe("dist/src/index.js");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist/src", "README.md", "LICENSE"]));
    expect(packageJson.publishConfig?.access).toBe("public");
  });
});
