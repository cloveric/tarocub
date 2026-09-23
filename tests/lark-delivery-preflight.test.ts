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

  it("accepts Kimi captioned file entries while preserving strict path validation", () => {
    const result = normalizeLarkSendTool("send.batch", {
      files: [
        { path: "/workspace/report.md", caption: "Report MD" },
        { path: "/workspace/report.html", caption: "Report HTML" },
        { path: "/workspace/report.pdf", caption: "Report PDF" },
      ],
    });

    expect(result).toEqual({
      ok: true,
      artifacts: [
        { path: "/workspace/report.md", kind: "file", caption: "Report MD" },
        { path: "/workspace/report.html", kind: "file", caption: "Report HTML" },
        { path: "/workspace/report.pdf", kind: "file", caption: "Report PDF" },
      ],
      message: "",
    });
    expect(normalizeLarkSendTool("send.batch", { files: [123] })).toEqual({
      ok: false,
      reason: "file_entries",
      field: "files",
    });
  });

  it("repairs image paths accidentally placed in send.batch files while keeping send.file explicit", () => {
    expect(normalizeLarkSendTool("send.batch", {
      files: [
        { path: "/workspace/p1.png", caption: "P1 cover" },
        "/workspace/p2.JPEG",
        "/workspace/report.pdf",
      ],
    })).toEqual({
      ok: true,
      artifacts: [
        { path: "/workspace/p1.png", kind: "image", caption: "P1 cover" },
        { path: "/workspace/p2.JPEG", kind: "image" },
        { path: "/workspace/report.pdf", kind: "file" },
      ],
      message: "",
    });
    expect(normalizeLarkSendTool("send.file", { path: "/workspace/p1.png" })).toEqual({
      ok: true,
      artifacts: [{ path: "/workspace/p1.png", kind: "file" }],
      message: "",
    });
  });
});
