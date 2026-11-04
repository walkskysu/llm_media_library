import { parseClock } from "./format";

/** Prompt (from the issue spec) used to ask Gemini for a structured timestamped transcript. */
export const TRANSCRIPT_PROMPT = ` 請將以下內容整理為【結構化時間戳逐字稿】，嚴格遵守以下格式規範輸出：

【排版規範】

    章節標題：使用中文數字獨立成行（如：一、 標題名稱 或 二、 標題名稱），簡要概括該階段主題。 

    列表項目：每個時間點前統一使用連字符短橫線 

    作為列表項目符號（不要使用 * 或數字編號）。 

    時間戳格式：統一使用四位數中括號格式 [MM:SS]（若超過一小時請用 [HH:MM:SS]），時間戳加粗或不加粗需保持一致（範例：[00:16] 文字內容 

    ）。
    內容層級：主要語句同行輸出；若時間戳下有子要點，請縮進 2 個空格並用 2.
    或子列表整理。
    標點與語氣：保持口語化逐字稿的流暢度，保留精確的文字內容。 

【輸出範例參考】

一、 影片開場與核心痛點

    今天我們來講如何使用 AI 寫代碼……
    我相信啊，你給 AI 一個指令…… 

二、 第一步：環境搭建

    首先我們需要選擇一款適合自己的編程 Agent…… 

【待整理的文本/影片連結】：
`;

export function buildTranscriptPrompt(videoUrl: string): string {
  return `${TRANSCRIPT_PROMPT}${videoUrl}\n`;
}

export type TranscriptLine =
  | { kind: "heading"; text: string }
  | { kind: "item"; text: string; seconds: number | null; stamp: string | null; indent: number }
  | { kind: "text"; text: string };

const HEADING_RE = /^[一二三四五六七八九十百零〇]+、/;
const STAMP_RE = /^(?:\*\*)?\[(\d{1,3}:\d{2}(?::\d{2})?)\](?:\*\*)?\s*/;

/** Turn Gemini's transcript text into structured lines so timestamps can be made clickable. */
export function parseTranscript(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim() || /^```/.test(raw.trim())) continue;
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, "  ").length;
    let body = raw.trim();
    const headingCandidate = body.replace(/^#+\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1");
    if (HEADING_RE.test(headingCandidate)) {
      lines.push({ kind: "heading", text: headingCandidate });
      continue;
    }
    const isBullet = /^[-*•]\s+/.test(body);
    body = body.replace(/^[-*•]\s+/, "");
    const stamp = body.match(STAMP_RE);
    if (stamp) {
      lines.push({
        kind: "item",
        stamp: stamp[1],
        seconds: parseClock(stamp[1]),
        text: body.slice(stamp[0].length),
        indent: indent >= 2 ? 1 : 0,
      });
    } else if (isBullet) {
      lines.push({ kind: "item", stamp: null, seconds: null, text: body, indent: indent >= 2 ? 1 : 0 });
    } else {
      lines.push({ kind: "text", text: body });
    }
  }
  return lines;
}
