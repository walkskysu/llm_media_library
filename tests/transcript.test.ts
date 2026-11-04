import { describe, expect, it } from "vitest";
import { buildTranscriptPrompt, parseTranscript, TRANSCRIPT_PROMPT } from "../src/lib/transcript";

describe("transcript prompt", () => {
  it("appends the video url after the spec prompt", () => {
    const p = buildTranscriptPrompt("https://www.youtube.com/watch?v=abc");
    expect(p.startsWith(TRANSCRIPT_PROMPT)).toBe(true);
    expect(TRANSCRIPT_PROMPT).toContain("【結構化時間戳逐字稿】");
    expect(TRANSCRIPT_PROMPT.trimEnd().endsWith("【待整理的文本/影片連結】：")).toBe(true);
    expect(p.trimEnd().endsWith("https://www.youtube.com/watch?v=abc")).toBe(true);
  });
});

describe("parseTranscript", () => {
  it("parses headings, timestamps and sub items", () => {
    const lines = parseTranscript(
      [
        "```",
        "一、 影片開場與核心痛點",
        "",
        "- [00:16] 今天我們來講如何使用 AI 寫代碼……",
        "- **[01:02:03]** 我相信啊",
        "  - 子要點",
        "**二、 第一步：環境搭建**",
        "- [10:05] 首先",
        "結語文字",
        "```",
      ].join("\n"),
    );
    expect(lines).toEqual([
      { kind: "heading", text: "一、 影片開場與核心痛點" },
      { kind: "item", stamp: "00:16", seconds: 16, text: "今天我們來講如何使用 AI 寫代碼……", indent: 0 },
      { kind: "item", stamp: "01:02:03", seconds: 3723, text: "我相信啊", indent: 0 },
      { kind: "item", stamp: null, seconds: null, text: "子要點", indent: 1 },
      { kind: "heading", text: "二、 第一步：環境搭建" },
      { kind: "item", stamp: "10:05", seconds: 605, text: "首先", indent: 0 },
      { kind: "text", text: "結語文字" },
    ]);
  });
});
