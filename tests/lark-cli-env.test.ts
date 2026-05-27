import { describe, expect, it } from "vitest";

import { buildLarkCliChannelEnv } from "../src/lark/cli-env.js";

describe("buildLarkCliChannelEnv", () => {
  it("enables lark-channel without leaking the app secret to lark-cli children", () => {
    const env = buildLarkCliChannelEnv({
      PATH: "/usr/bin",
      LARK_APP_ID: "cli_app",
      LARK_APP_SECRET: "secret-personal",
      CCTB_LARK_STATE_DIR: "/tmp/lark-state",
    });

    expect(env.LARK_CHANNEL).toBe("1");
    expect(env.CCTB_LARK_STATE_DIR).toBe("/tmp/lark-state");
    expect(env.LARK_APP_ID).toBe("cli_app");
    expect(env.PATH).toBe("/usr/bin");
    expect(env).not.toHaveProperty("LARK_APP_SECRET");
    expect(JSON.stringify(env)).not.toContain("secret-personal");
  });
});
