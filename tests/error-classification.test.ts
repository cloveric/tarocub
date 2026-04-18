import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  getBusErrorSemantics,
  isStaleSessionError,
} from "../src/runtime/error-classification.js";

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
    expect(getBusErrorSemantics("unknown")).toEqual({ code: "unknown", retryable: true });
  });
});
