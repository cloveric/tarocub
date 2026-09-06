import { describe, expect, it } from "vitest";

import { normalizeLarkSendTool } from "../src/lark/delivery-preflight.js";

describe("Lark delivery preflight", () => {
  it("accepts a send.batch payload with more than 20 artifacts", () => {
    const result = normalizeLarkSendTool("send.batch", {
      images: Array.from({ length: 21 }, (_, index) => `/workspace/p${index + 1}.png`),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifacts).toHaveLength(21);
    }
  });
});
