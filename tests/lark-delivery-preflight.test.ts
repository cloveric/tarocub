import { describe, expect, it } from "vitest";

import { normalizeLarkSendTool } from "../src/lark/delivery-preflight.js";

describe("Lark delivery preflight", () => {
  it("rejects a send.batch payload with more than 20 artifacts", () => {
    const result = normalizeLarkSendTool("send.batch", {
      images: Array.from({ length: 21 }, (_, index) => `/workspace/p${index + 1}.png`),
    });

    expect(result).toEqual({
      ok: false,
      reason: "too_many_artifacts",
      field: "artifacts",
    });
  });
});
