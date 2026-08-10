import { describe, expect, it, vi } from "vitest";

import {
  describeLockHolderApp,
  findThreadWriterLockHolder,
  renderThreadWriterLockDiagnosis,
  resolveCodexHome,
  resolveThreadWriterLockPath,
} from "../src/codex/thread-writer-lock.js";
import { classifyFailure } from "../src/runtime/error-classification.js";
import { renderLarkUserFacingError } from "../src/lark/errors.js";

const CHATGPT_APP = "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server";

describe("thread writer lock diagnosis", () => {
  it("names the ChatGPT desktop app as the holder", async () => {
    const execFileFn = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === "lsof") {
        expect(args[1]).toContain("thread-writer-locks/thread-1.lock");
        return { stdout: "77164\n", stderr: "" };
      }
      return { stdout: `${CHATGPT_APP}\n`, stderr: "" };
    });
    const holder = await findThreadWriterLockHolder({
      codexHome: "/home/u/.codex",
      threadId: "thread-1",
      ownPid: 999,
      execFileFn: execFileFn as never,
    });
    expect(holder).toMatchObject({ pid: 77164, isOwnChild: false, appLabel: "ChatGPT 桌面应用" });
    const text = renderThreadWriterLockDiagnosis(holder);
    expect(text).toContain("ChatGPT 桌面应用");
    expect(text).toContain("重启本 bot 无效");
  });

  it("prefers an external holder over our own child process", async () => {
    const execFileFn = vi.fn(async (file: string) => (file === "lsof"
      ? { stdout: "999\n77164\n", stderr: "" }
      : { stdout: `${CHATGPT_APP}\n`, stderr: "" }));
    const holder = await findThreadWriterLockHolder({
      codexHome: "/home/u/.codex",
      threadId: "thread-1",
      ownPid: 999,
      execFileFn: execFileFn as never,
    });
    expect(holder?.pid).toBe(77164);
    expect(holder?.isOwnChild).toBe(false);
  });

  it("reports our own engine child distinctly (not an external app)", async () => {
    const execFileFn = vi.fn(async (file: string) => (file === "lsof"
      ? { stdout: "999\n", stderr: "" }
      : { stdout: "node /opt/homebrew/bin/codex app-server\n", stderr: "" }));
    const holder = await findThreadWriterLockHolder({
      codexHome: "/home/u/.codex",
      threadId: "thread-1",
      ownPid: 999,
      execFileFn: execFileFn as never,
    });
    expect(holder?.isOwnChild).toBe(true);
    expect(renderThreadWriterLockDiagnosis(holder)).toContain("本 bot 自己的引擎进程");
  });

  it("degrades to an honest unknown when nothing holds the lock", async () => {
    const execFileFn = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const holder = await findThreadWriterLockHolder({
      codexHome: "/home/u/.codex",
      threadId: "thread-1",
      execFileFn: execFileFn as never,
    });
    expect(holder).toBeNull();
    expect(renderThreadWriterLockDiagnosis(null)).toContain("未能查到占用方");
  });

  it("degrades to null when the probe itself fails (lsof missing)", async () => {
    const execFileFn = vi.fn(async () => {
      throw new Error("spawn lsof ENOENT");
    });
    const holder = await findThreadWriterLockHolder({
      codexHome: "/home/u/.codex",
      threadId: "thread-1",
      execFileFn: execFileFn as never,
    });
    expect(holder).toBeNull();
  });

  it("resolves the lock path and codex home", () => {
    expect(resolveThreadWriterLockPath("/h/.codex", "t1")).toBe("/h/.codex/thread-writer-locks/t1.lock");
    expect(resolveCodexHome("/custom", {})).toBe("/custom");
    expect(resolveCodexHome(undefined, { CODEX_HOME: "/env" })).toBe("/env");
  });

  it("labels known holders", () => {
    expect(describeLockHolderApp(CHATGPT_APP)).toBe("ChatGPT 桌面应用");
    expect(describeLockHolderApp("node /opt/homebrew/bin/codex app-server")).toBe("另一个 Codex app-server");
    expect(describeLockHolderApp("/usr/bin/vim notes.txt")).toBeUndefined();
  });
});

describe("writer-conflict failures reach the user with their diagnosis", () => {
  it("classifies the conflict as its own category, not a generic engine failure", () => {
    const error = new Error("thread 019d86a0 already has an active writer");
    expect(classifyFailure(error)).toBe("engine-thread-locked");
  });

  it("surfaces the adapter's diagnosis instead of '本轮运行失败'", () => {
    const error = new Error(
      "thread 019d86a0 already has an active writer\n\n"
      + "该会话线程的写入权被ChatGPT 桌面应用占用（pid 77164），重启本 bot 无效。退出该应用即可恢复；或用 /reset 换一条新线程（会丢失该会话的 Codex 上下文）。",
    );
    const rendered = renderLarkUserFacingError(error, "engine", "zh");
    expect(rendered).toContain("ChatGPT 桌面应用");
    expect(rendered).toContain("退出该应用");
    expect(rendered).not.toContain("本轮运行失败");
  });
});
