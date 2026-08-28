import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

const HOME_DIR = process.platform === "win32" ? "C:\\Users\\hangw" : "/home/hangw";
const ALT_HOME = process.platform === "win32" ? "C:\\msys64\\home\\hangw" : "/alt/home/hangw";

describe("resolveConfig", () => {
  it("uses the default state directory under the user profile", () => {
    const env = process.platform === "win32"
      ? { USERPROFILE: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123" }
      : { HOME: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123" };
    const config = resolveConfig(env);

    expect(config.instanceName).toBe("default");
    expect(config.stateDir).toBe(path.join(HOME_DIR, ".cctb", "default"));
    expect(config.inboxDir).toBe(path.join(HOME_DIR, ".cctb", "default", "inbox"));
    expect(config.telegramBotToken).toBe("abc123");
  });

  it("prefers the primary home variable over the fallback", () => {
    const env = process.platform === "win32"
      ? { HOME: ALT_HOME, USERPROFILE: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123" }
      : { HOME: HOME_DIR, USERPROFILE: ALT_HOME, TELEGRAM_BOT_TOKEN: "abc123" };
    const config = resolveConfig(env);

    expect(config.stateDir).toBe(path.join(HOME_DIR, ".cctb", "default"));
  });

  it("throws when home directory is missing", () => {
    expect(() =>
      resolveConfig({
        TELEGRAM_BOT_TOKEN: "abc123",
      }),
    ).toThrow("is required");
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    expect(() =>
      resolveConfig({
        USERPROFILE: "C:\\Users\\hangw",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is required");
  });

  it("respects the state directory and executable overrides", () => {
    const config = resolveConfig({
      TELEGRAM_BOT_TOKEN: "abc123",
      CODEX_TELEGRAM_STATE_DIR: "C:/custom/state",
      CODEX_EXECUTABLE: "codex.exe",
      DSH_EXECUTABLE: '"C:\\Tools\\dsh.exe"',
      DSH_HOME: "C:\\Users\\hangw\\.dsh-custom",
      KIMI_EXECUTABLE: '"C:\\Tools\\kimi.exe"',
      ANTIGRAVITY_EXECUTABLE: '"C:\\Tools\\agy.exe"',
    });

    expect(config.instanceName).toBe("default");
    expect(config.stateDir).toBe("C:/custom/state");
    expect(path.posix.normalize(config.inboxDir.replace(/\\/g, "/"))).toBe("C:/custom/state/inbox");
    expect(path.posix.normalize(config.accessStatePath.replace(/\\/g, "/"))).toBe("C:/custom/state/access.json");
    expect(path.posix.normalize(config.sessionStatePath.replace(/\\/g, "/"))).toBe("C:/custom/state/session.json");
    expect(path.posix.normalize(config.runtimeLogPath.replace(/\\/g, "/"))).toBe("C:/custom/state/runtime.log");
    expect(config.codexExecutable).toBe("codex.exe");
    expect(config.deepseekExecutable).toBe("C:\\Tools\\dsh.exe");
    expect(config.deepseekHome).toBe("C:\\Users\\hangw\\.dsh-custom");
    expect(config.kimiExecutable).toBe("C:\\Tools\\kimi.exe");
    expect(config.antigravityExecutable).toBe("C:\\Tools\\agy.exe");
  });

  it("strips wrapping quotes from executable overrides", () => {
    const config = resolveConfig({
      TELEGRAM_BOT_TOKEN: "abc123",
      CODEX_TELEGRAM_STATE_DIR: "C:/custom/state",
      CODEX_EXECUTABLE: '"C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.cmd"',
    });

    expect(config.codexExecutable).toBe("C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("uses the named instance directory when CODEX_TELEGRAM_INSTANCE is set", () => {
    const env = process.platform === "win32"
      ? { USERPROFILE: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123", CODEX_TELEGRAM_INSTANCE: "alpha" }
      : { HOME: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123", CODEX_TELEGRAM_INSTANCE: "alpha" };
    const config = resolveConfig(env);

    expect(config.instanceName).toBe("alpha");
    expect(config.stateDir).toBe(path.join(HOME_DIR, ".cctb", "alpha"));
    expect(config.accessStatePath).toBe(path.join(HOME_DIR, ".cctb", "alpha", "access.json"));
  });

  it("prefers the neutral TaroCub instance name over the legacy Telegram name", () => {
    const env = process.platform === "win32"
      ? { USERPROFILE: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123", TAROCUB_INSTANCE: "lark-alpha", CODEX_TELEGRAM_INSTANCE: "legacy" }
      : { HOME: HOME_DIR, TELEGRAM_BOT_TOKEN: "abc123", TAROCUB_INSTANCE: "lark-alpha", CODEX_TELEGRAM_INSTANCE: "legacy" };
    const config = resolveConfig(env);

    expect(config.instanceName).toBe("lark-alpha");
    expect(config.stateDir).toBe(path.join(HOME_DIR, ".cctb", "lark-alpha"));
  });

  it("rejects unsafe instance names", () => {
    expect(() =>
      resolveConfig({
        USERPROFILE: "C:\\Users\\hangw",
        TELEGRAM_BOT_TOKEN: "abc123",
        CODEX_TELEGRAM_INSTANCE: "..\\..\\x",
      }),
    ).toThrow("Invalid instance name");
  });

  it("defaults the codex executable to codex", () => {
    const env = process.platform === "win32"
      ? { USERPROFILE: "C:\\Users\\missing-user", TELEGRAM_BOT_TOKEN: "abc123" }
      : { HOME: "/nonexistent", TELEGRAM_BOT_TOKEN: "abc123" };
    const config = resolveConfig(env);

    expect(config.codexExecutable).toBe("codex");
    expect(config.deepseekExecutable).toBe("dsh");
    expect(config.deepseekHome).toBe(path.join(process.platform === "win32" ? "C:\\Users\\missing-user" : "/nonexistent", ".dsh"));
    expect(config.kimiExecutable).toBe("kimi");
  });

  it.skipIf(process.platform !== "win32")("prefers the installed Windows codex shim when available", () => {
    const config = resolveConfig({
      USERPROFILE: "C:\\Users\\hangw",
      APPDATA: "C:\\Users\\hangw\\AppData\\Roaming",
      TELEGRAM_BOT_TOKEN: "abc123",
    });

    expect(config.codexExecutable).toBe("C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.cmd");
  });
});
