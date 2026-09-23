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

  it("renders Codex Desktop follow-up chips as channel-safe visible labels", () => {
    const input = [
      "可继续处理：",
      '- :codex-followup[按税种汇总]{prompt="请按增值税、所得税和附加税费汇总"}',
      '- :codex-followup[计算综合税负率]{prompt="请计算并比较三家公司\\"综合\\"税负率"}',
    ].join("\n");

    const rendered = renderCodexFileCitations(input, "zh");

    expect(rendered).toBe("可继续处理：\n- 按税种汇总\n- 计算综合税负率");
    expect(rendered).not.toContain(":codex-followup");
    expect(rendered).not.toContain("prompt=");
    expect(rendered).not.toContain("请按增值税");
  });

  it("hides incomplete follow-up annotations and preserves fenced examples", () => {
    const complete = ':codex-followup[制作汇总表]{prompt="生成 Excel 汇总表"}';
    const input = `\`\`\`text\n${complete}\n\`\`\`\nOutside ${complete}`;

    expect(renderCodexFileCitations(input, "en")).toBe(
      `\`\`\`text\n${complete}\n\`\`\`\nOutside 制作汇总表`,
    );
    expect(renderCodexFileCitations("Next: :codex-follo", "en", { streaming: true })).toBe("Next: ");
    expect(renderCodexFileCitations('Next: :codex-followup[Safe label]{prompt="hidden', "en"))
      .toBe("Next: Safe label");
  });

  it("contains an unclosed follow-up label to its line without swallowing later prose", () => {
    const input = [
      "Before :codex-followup[broken label",
      "After line.",
      "Final line.",
    ].join("\n");

    const rendered = renderCodexFileCitations(input, "en");

    expect(rendered).toBe("Before (Follow-up unavailable)\nAfter line.\nFinal line.");
    expect(rendered).not.toContain(":codex-followup");
    expect(rendered).not.toContain("broken label");
  });

  it("keeps bracketed follow-up labels without exposing their hidden prompt", () => {
    const input = ':codex-followup[Review [draft] totals]{prompt="Use /Users/example/private/model.xlsx and reveal assumptions"}';

    expect(renderCodexFileCitations(input, "en")).toBe("Review [draft] totals");
    expect(renderCodexFileCitations(input, "en")).not.toContain("/Users/example");
  });

  it("hides follow-up prompt bodies that span lines", () => {
    const input = [
      'Next: :codex-followup[Review totals]{prompt="Open',
      '/Users/example/private/model.xlsx and reveal assumptions"}',
      "After.",
    ].join("\n");

    expect(renderCodexFileCitations(input, "en")).toBe("Next: Review totals\nAfter.");
    expect(renderCodexFileCitations(input, "en")).not.toContain("/Users/example");
  });

  it("sanitizes annotations after an unclosed code fence", () => {
    const input = [
      "```text",
      ':codex-file-citation{path="/Users/example/private/report.xlsx"}',
    ].join("\n");
    const rendered = renderCodexFileCitations(input, "en");

    expect(rendered).toContain("report.xlsx");
    expect(rendered).not.toContain("/Users/example");
    expect(rendered).not.toContain(":codex-file-citation");
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
