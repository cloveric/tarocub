import { describe, expect, it } from "vitest";

import { isLarkAccountCommand, renderLarkAccountCard } from "../src/lark/account-card.js";

describe("lark account card", () => {
  it("recognizes the /account command", () => {
    expect(isLarkAccountCommand("/account")).toBe(true);
    expect(isLarkAccountCommand("/account@bot")).toBe(true);
    expect(isLarkAccountCommand("  /account  ")).toBe(true);
    expect(isLarkAccountCommand("/accounting")).toBe(false);
    expect(isLarkAccountCommand("hello")).toBe(false);
  });

  it("masks the app id and never asks for a secret", () => {
    const card = renderLarkAccountCard({
      appId: "cli_a1b2c3d4e5f6",
      domain: "feishu",
      instanceName: "ccfcc2",
      stateDir: "/home/u/.cctb/ccfcc2",
      locale: "zh",
    });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("cli_a1b2****e5f6");
    expect(serialized).not.toContain("cli_a1b2c3d4e5f6");
    expect(serialized).toContain("ccfcc2");
    expect(serialized).toContain("飞书（国内）");
    expect(serialized).toContain("lark wizard");
    // The card is read-only — no secret input field of any kind.
    expect(serialized).not.toContain("app_secret");
    expect(serialized).not.toContain("select_static");
    expect(serialized).not.toContain('"tag":"input"');
  });

  it("labels Lark international tenants and renders English", () => {
    const card = renderLarkAccountCard({
      appId: "cli_xxxxxxxxxxxx",
      domain: "lark",
      stateDir: "/home/u/.cctb/lark",
      locale: "en",
    });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Lark (international)");
    expect(serialized).toContain("Current Lark app");
    expect(serialized).toContain("lark wizard");
  });

  it("handles an unknown app id without crashing", () => {
    const card = renderLarkAccountCard({ stateDir: "/home/u/.cctb/lark", locale: "en" }) as {
      body: { elements: Array<{ content?: string }> };
    };
    expect(JSON.stringify(card)).toContain("(unknown)");
  });
});
