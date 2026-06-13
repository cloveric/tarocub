import { describe, expect, it } from "vitest";

import { renderLarkArchiveSummaryCard } from "../src/lark/files.js";
import type { ArchiveSummaryData } from "../src/runtime/file-workflow.js";

function findElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
  return body?.elements ?? [];
}

const baseData: ArchiveSummaryData = {
  archiveName: "生益科技ticket-0418-0526.zip",
  fileCount: 6,
  keyFiles: [],
  topExtensions: [[".xlsx", 6]],
  treeLines: ["生益科技 ticket-0418.xlsx", "生益科技 ticket-0513.xlsx"],
};

describe("renderLarkArchiveSummaryCard", () => {
  it("renders one zh card with the summary, the archive name, and an inline continue button", () => {
    const card = renderLarkArchiveSummaryCard({
      data: baseData,
      uploadId: "u-1",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "group",
      replyInThread: true,
      locale: "zh",
    });
    const elements = findElements(card);
    const serialized = JSON.stringify(card);

    // Localized summary fields (not the English blob).
    expect(serialized).toContain("📦 压缩包摘要");
    expect(serialized).toContain("生益科技ticket-0418-0526.zip");
    expect(serialized).toContain("文件数：6");
    expect(serialized).toContain("关键文件：未检测到");
    expect(serialized).toContain("主要类型：.xlsx (6)");
    expect(serialized).toContain("生益科技 ticket-0418.xlsx");

    // The continue button is in the SAME card, with the unchanged callback.
    const button = elements.find((element) => element.tag === "button");
    expect(button).toBeDefined();
    expect((button!.text as { content: string }).content).toBe("继续分析");
    const value = (button!.behaviors as Array<{ value: Record<string, unknown> }>)[0].value;
    expect(value).toMatchObject({
      cctb_lark: "continue_archive",
      uploadId: "u-1",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "group",
      replyInThread: true,
    });
  });

  it("localizes to English and shows key files when present", () => {
    const card = renderLarkArchiveSummaryCard({
      data: { ...baseData, keyFiles: ["README.md", "package.json"] },
      uploadId: "u-2",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      locale: "en",
    });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("📦 Archive Summary");
    expect(serialized).toContain("Key files: README.md, package.json");
    expect(serialized).toContain("Continue Analysis");
    expect(serialized).not.toContain("压缩包摘要");
    expect(serialized).not.toContain("继续分析");
  });

  it("caps a huge file tree so the card stays under Feishu's element limit", () => {
    const treeLines = Array.from({ length: 200 }, (_unused, index) => `目录/超长中文文件名_${index}_${"占位".repeat(20)}.xlsx`);
    const card = renderLarkArchiveSummaryCard({
      data: { ...baseData, fileCount: 200, treeLines },
      uploadId: "u-3",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "group",
      locale: "zh",
    });
    const elements = findElements(card);
    const summaryElement = elements.find((element) => element.tag === "markdown") as { content: string };

    // Body is bounded by BOTH chars and bytes (Feishu's per-element limit), and
    // signals truncation rather than dropping silently.
    expect(summaryElement.content.length).toBeLessThanOrEqual(2002);
    expect(Buffer.byteLength(summaryElement.content, "utf8")).toBeLessThanOrEqual(7000);
    expect(summaryElement.content).toContain("…");
    // The continue button survives truncation (it is a separate element).
    expect(elements.some((element) => element.tag === "button")).toBe(true);
  });
});
