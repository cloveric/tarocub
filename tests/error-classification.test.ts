import { describe, expect, it } from "vitest";

import { FileWorkflowPreparationError } from "../src/runtime/file-workflow.js";
import {
  classifyFailure,
  getBusErrorSemantics,
  isStaleSessionError,
} from "../src/runtime/error-classification.js";
import { renderLarkUserFacingError } from "../src/lark/errors.js";

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

  it("does not treat generic archive mentions as file-workflow failures", () => {
    expect(classifyFailure(new Error("archive the previous messages for me"))).toBe("unknown");
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
