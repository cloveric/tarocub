import { describe, expect, it } from "vitest";

import { FileWorkflowPreparationError } from "../src/runtime/file-workflow.js";
import {
  classifyFailure,
  getBusErrorSemantics,
  isStaleSessionError,
} from "../src/runtime/error-classification.js";
import { renderLarkUserFacingError } from "../src/lark/errors.js";
import { renderCategorizedErrorMessage } from "../src/telegram/message-renderer.js";

describe("classifyFailure auth detection", () => {
  it("classifies Claude 401 authentication errors as auth", () => {
    expect(
      classifyFailure(new Error("Failed to authenticate. API Error: 401")),
    ).toBe("auth");
    expect(
      classifyFailure(new Error("authentication_error: Invalid authentication credentials")),
    ).toBe("auth");
  });

  it("keeps existing auth patterns working", () => {
    expect(classifyFailure(new Error("not logged in"))).toBe("auth");
    expect(classifyFailure(new Error("unauthorized"))).toBe("auth");
    expect(classifyFailure(new Error("Please run /login"))).toBe("auth");
  });

  it("does not misclassify unrelated errors as auth", () => {
    expect(classifyFailure(new Error("file not found"))).not.toBe("auth");
    expect(classifyFailure(new Error("network timeout"))).not.toBe("auth");
  });

  it("matches 401 only as a standalone number, not inside larger numbers", () => {
    expect(classifyFailure(new Error("request failed with status 401"))).toBe("auth");
    expect(classifyFailure(new Error("turn used 84012 tokens"))).not.toBe("auth");
    expect(classifyFailure(new Error("context window is 140100 tokens"))).not.toBe("auth");
  });
});

describe("classifyFailure specificity", () => {
  it("does not treat generic app-server mentions as engine-cli failures", () => {
    expect(classifyFailure(new Error("status page mentions app-server maintenance"))).toBe("unknown");
  });

  it("does not treat engine names inside tool error paths as engine-cli failures", () => {
    expect(
      classifyFailure(new Error("lark-cli failed in /tmp/claude-code-sandbox/workspace/input with 500")),
    ).toBe("unknown");
  });

  it("classifies explicit engine runtime failures", () => {
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).toBe("engine-cli");
    expect(classifyFailure(new Error("claude cli failed"))).toBe("engine-cli");
    expect(classifyFailure(new Error("engine failed during continuation"))).toBe("engine-cli");
    expect(classifyFailure(new Error("claude exited with code 1"))).toBe("engine-cli");
  });

  it("classifies Codex backend reconnect-exhaustion as engine-backend, distinct from engine-cli", () => {
    expect(classifyFailure(new Error("Reconnecting... 5/5"))).toBe("engine-backend");
    expect(classifyFailure(new Error("codex stream error\nReconnecting... 4/5"))).toBe("engine-backend");
    expect(classifyFailure(new Error("API Error: 529 Overloaded"))).toBe("engine-backend");
    expect(classifyFailure(new Error("Claude reported an error (api_error_status=529)"))).toBe("engine-backend");
    // a process/startup failure is still engine-cli, not engine-backend
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).not.toBe("engine-backend");
    // a bare reconnect mention without an N/M attempt counter is NOT this category
    expect(classifyFailure(new Error("the websocket is reconnecting"))).toBe("unknown");
  });

  it("renders a clear retry message for engine-backend instead of the generic run-failed one", () => {
    const err = new Error("Reconnecting... 5/5");
    expect(renderLarkUserFacingError(err, "engine", "zh")).toContain("Codex 连接后端失败");
    expect(renderLarkUserFacingError(err, "engine", "zh")).toContain("请重试");
    expect(renderLarkUserFacingError(err, "engine", "zh")).not.toContain("本轮运行失败");
    expect(renderLarkUserFacingError(err, "engine", "en")).toContain("backend connection");
  });

  it("classifies the single-turn time-cap timeout as engine-timeout, distinct from engine-cli", () => {
    expect(classifyFailure(new Error("Codex app-server turn timed out after 60 minutes"))).toBe("engine-timeout");
    expect(classifyFailure(new Error("Antigravity process turn timed out after 60 minutes\n[state]"))).toBe("engine-timeout");
    expect(classifyFailure(new Error("Codex app-server turn became inactive after 30 minutes"))).toBe("engine-timeout");
    // a process/startup failure (no "turn timed out after N minutes") stays engine-cli
    expect(classifyFailure(new Error("Codex runtime process failed to start"))).toBe("engine-cli");
    // engine-timeout is NOT auto-retryable (rerunning the same long task times out again)
    expect(getBusErrorSemantics("engine-timeout")).toEqual({ code: "engine_timeout", retryable: false });
  });

  it("covers the Claude inactivity-watchdog wording with the engine-timeout category", () => {
    // Wording emitted by ClaudeStreamAdapter's inactivity watchdog; it must not
    // fall through to engine-cli ("restart the instance"), and the renderer picks
    // the minute count out of the detail.
    const err = new Error(
      "Claude turn became inactive after 30 minutes with no engine output; the wedged CLI was stopped. Send /timeout off before a genuinely long silent task.",
    );
    expect(classifyFailure(err)).toBe("engine-timeout");
    expect(renderCategorizedErrorMessage("engine-timeout", err.message, "en")).toContain("30-minute");
  });

  it("classifies a busy Claude session (live background tasks) as engine-busy, not engine-cli", () => {
    const err = new Error(
      "Claude session has 2 background tasks still running, so the new engine settings cannot be applied yet. Retry once they finish, or send /reset to start a fresh session.",
    );
    expect(classifyFailure(err)).toBe("engine-busy");
    // Transient: the same call works once the background work ends.
    expect(getBusErrorSemantics("engine-busy")).toEqual({ code: "engine_busy", retryable: true });
    // The old behavior told the operator to restart the instance for a healthy engine.
    expect(renderCategorizedErrorMessage("engine-busy", err.message, "en")).not.toContain("Restart the instance");
  });

  it("classifies a locally occupied Codex thread as retryable engine-busy", () => {
    const err = new Error("Codex thread thread-B already has an in-flight turn");
    expect(classifyFailure(err)).toBe("engine-busy");
    expect(getBusErrorSemantics("engine-busy")).toEqual({ code: "engine_busy", retryable: true });
  });

  it("renders an accurate time-cap message pointing at /timeout, not the misleading 'restart' one", () => {
    const err = new Error("Codex app-server turn timed out after 60 minutes");
    const zh = renderLarkUserFacingError(err, "engine", "zh");
    expect(zh).toContain("60 分钟");
    expect(zh).toContain("/timeout off");
    expect(zh).not.toContain("请重启实例后重试");      // the misleading advice is gone
    const en = renderLarkUserFacingError(err, "engine", "en");
    expect(en).toContain("/timeout off");
    expect(en).not.toContain("Restart the instance");
  });

  it("renders Telegram engine timeouts with /timeout guidance instead of blind retry advice", () => {
    const err = new Error("Codex process turn became inactive after 30 minutes");
    const zh = renderCategorizedErrorMessage("engine-timeout", err.message, "zh");
    expect(zh).toContain("/timeout");
    expect(zh).not.toContain("请重试");
    const en = renderCategorizedErrorMessage("engine-timeout", err.message, "en");
    expect(en).toContain("/timeout");
    expect(en).not.toContain("try again");
  });

  it("does not treat generic archive mentions as file-workflow failures", () => {
    expect(classifyFailure(new Error("archive the previous messages for me"))).toBe("unknown");
  });

  it("classifies a corrupt usage ledger as workflow state so budget checks fail visibly", () => {
    expect(classifyFailure(new Error("Usage state is corrupt and no valid last-good backup is available")))
      .toBe("workflow-state");
  });

  it("classifies file workflow preparation errors by type", () => {
    expect(
      classifyFailure(new FileWorkflowPreparationError("upload-1", new Error("temporary failure"))),
    ).toBe("file-workflow");
  });

  it("classifies Telegram input file download failures as file workflow errors", () => {
    expect(
      classifyFailure(new Error("Telegram API request failed for getFile: Bad Request: file is too big")),
    ).toBe("file-workflow");
    expect(
      classifyFailure(new Error("Telegram API request failed for downloadFile: 500 Internal Server Error")),
    ).toBe("file-workflow");
  });

  it("does not treat generic zip mentions as file-workflow failures", () => {
    expect(classifyFailure(new Error("Remote peer mentioned export.zip in an unrelated error"))).toBe("unknown");
  });
});

describe("isStaleSessionError", () => {
  it("matches Claude's 'No conversation found' message", () => {
    expect(
      isStaleSessionError(new Error("No conversation found with session ID: abc-123")),
    ).toBe(true);
  });

  it("classifies the same errors as session-state", () => {
    expect(classifyFailure(new Error("No conversation found with session ID: abc-123"))).toBe("session-state");
  });

  it("does not match unrelated errors", () => {
    expect(isStaleSessionError(new Error("file not found"))).toBe(false);
    expect(isStaleSessionError(new Error("auth expired"))).toBe(false);
  });
});

describe("getBusErrorSemantics", () => {
  it("maps failure categories to shared bus error semantics", () => {
    expect(getBusErrorSemantics("auth")).toEqual({ code: "auth", retryable: false });
    expect(getBusErrorSemantics("telegram-conflict")).toEqual({ code: "telegram_conflict", retryable: true });
    expect(getBusErrorSemantics("workflow-state")).toEqual({ code: "workflow_state", retryable: false });
    expect(getBusErrorSemantics("engine-backend")).toEqual({ code: "engine_backend", retryable: true });
    expect(getBusErrorSemantics("unknown")).toEqual({ code: "unknown", retryable: true });
  });
});

describe("MCP startup warnings do not steer classification", () => {
  it("classifies by the underlying error, not the appended warning text", () => {
    const error = new Error(
      "turn became inactive after 30 minutes\n\n⚠️ MCP startup warning:\n- server github: 401 Unauthorized",
    );
    expect(classifyFailure(error)).toBe("engine-timeout");
  });

  it("still classifies a genuine auth failure that carries a warning", () => {
    const error = new Error(
      "not logged in — please run /login\n\n⚠️ MCP startup warnings:\n- server tavily: timeout",
    );
    expect(classifyFailure(error)).toBe("auth");
  });
});
