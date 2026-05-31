import { describe, expect, it } from "vitest";

import { childProcessTestEnv, resolveShortTempDir } from "./helpers/temp-files.js";

describe("temp file test helpers", () => {
  it("keeps child-process temp paths short enough for tsx IPC sockets", () => {
    const longTempDir = `/tmp/${"claude-501/".repeat(30)}`;
    const env = childProcessTestEnv({
      ...process.env,
      TMPDIR: longTempDir,
      TMP: longTempDir,
      TEMP: longTempDir,
    });

    if (process.platform === "win32") {
      expect(env.TMPDIR).toBeDefined();
      return;
    }

    expect(env.TMPDIR).toBe("/tmp");
    expect(env.TMP).toBe("/tmp");
    expect(env.TEMP).toBe("/tmp");
  });

  it("allows explicit test temp-dir overrides", () => {
    expect(resolveShortTempDir({ ...process.env, CCTB_TEST_TMPDIR: "/custom-tmp" })).toBe("/custom-tmp");
  });
});
