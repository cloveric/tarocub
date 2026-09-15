import { describe, expect, it } from "vitest";

import { renderCodexFileCitations } from "../src/runtime/codex-file-citations.js";

describe("renderCodexFileCitations", () => {
  it("renders a readable workbook source while hiding its absolute path", () => {
    const input = [
      "估值依据如下。",
      ':codex-file-citation{path="/Users/example/.cctb/bot/workspace/outputs/估值模型.xlsx" purpose="source" artifact_kind="workbook" sheet="PE_Comps" range="A4:F25"}',
    ].join("\n");

    const rendered = renderCodexFileCitations(input, "zh");

    expect(rendered).toContain("（来源：`估值模型.xlsx` · `PE_Comps!A4:F25`）");
    expect(rendered).not.toContain(":codex-file-citation");
    expect(rendered).not.toContain("/Users/example");
  });

  it("renders every citation and supports English output", () => {
    const citation = (range: string) =>
      `:codex-file-citation{path="/private/report.xlsx" purpose="source" sheet="DCF" range="${range}"}`;
    const rendered = renderCodexFileCitations(`${citation("A1:B2")} and ${citation("C3:D4")}`, "en");

    expect(rendered).toBe(
      "(Source: `report.xlsx` · `DCF!A1:B2`) and (Source: `report.xlsx` · `DCF!C3:D4`)",
    );
  });

  it("handles Windows paths and closing braces inside quoted attributes", () => {
    const input = String.raw`:codex-file-citation{path="C:\\Users\\example\\book.xlsx" purpose="source" sheet="Sheet } One" range="A1:B2"}`;

    expect(renderCodexFileCitations(input, "en")).toBe(
      "(Source: `book.xlsx` · `Sheet } One!A1:B2`)",
    );
  });

  it("hides an unfinished streaming token until its closing brace arrives", () => {
    const input = 'Answer\n:codex-file-citation{path="/Users/example/private/report.xlsx"';

    expect(renderCodexFileCitations(input, "en")).toBe("Answer\n");
    expect(renderCodexFileCitations("Answer :codex-file-", "en", { streaming: true })).toBe("Answer ");
    expect(renderCodexFileCitations("Answer :codex-file-", "en")).toBe("Answer :codex-file-");
  });

  it("leaves citation examples inside fenced code unchanged", () => {
    const citation = ':codex-file-citation{path="/Users/example/private/report.xlsx"}';
    const input = `\`\`\`text\n${citation}\n\`\`\`\nOutside ${citation}`;

    expect(renderCodexFileCitations(input, "en")).toBe(
      `\`\`\`text\n${citation}\n\`\`\`\nOutside (Source: \`report.xlsx\`)`,
    );
  });

  it("fails closed for malformed tokens instead of exposing their body", () => {
    const input = ":codex-file-citation{path=/Users/example/private/report.xlsx}";

    expect(renderCodexFileCitations(input, "zh")).toBe("（文件引用不可用）");
    expect(renderCodexFileCitations(input, "zh")).not.toContain("/Users/example");
  });

  it("leaves ordinary text unchanged", () => {
    expect(renderCodexFileCitations("No citation here.", "en")).toBe("No citation here.");
  });
});
