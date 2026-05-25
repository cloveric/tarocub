import { describe, expect, it } from "vitest";

import { redactLarkSensitiveText } from "../src/lark/redaction.js";

describe("redactLarkSensitiveText", () => {
  it("redacts Lark secrets from env-style and JSON-style error details", () => {
    const redacted = redactLarkSensitiveText(
      'failed with LARK_APP_SECRET=env-secret "client_secret":"json-secret" access_token: token-secret Authorization: Bearer bearer-secret',
    );

    expect(redacted).not.toContain("env-secret");
    expect(redacted).not.toContain("json-secret");
    expect(redacted).not.toContain("token-secret");
    expect(redacted).not.toContain("bearer-secret");
    expect(redacted).toContain("LARK_APP_SECRET=[redacted]");
    expect(redacted).toContain('"client_secret":"[redacted]"');
    expect(redacted).toContain("access_token: [redacted]");
    expect(redacted).toContain("Authorization: Bearer [redacted]");
  });
});
