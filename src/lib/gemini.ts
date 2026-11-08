import { GoogleGenAI, MediaResolution, type GenerateContentParameters } from "@google/genai";
import { extractJson, METADATA_PROMPT, normalizeMetadata } from "./metadata";
import { buildTranscriptPrompt } from "./transcript";
import type { VideoMetadata } from "./types";
import { watchUrl } from "./youtube";

export const DEFAULT_MODEL = "gemini-2.5-flash";

export class GeminiClient {
  private ai: GoogleGenAI;
  readonly model: string;

  constructor(apiKey: string, model?: string | null) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model?.trim() || DEFAULT_MODEL;
  }

  private request(videoId: string, prompt: string, withSearch: boolean): GenerateContentParameters {
    return {
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: watchUrl(videoId), mimeType: "video/*" } },
            { text: prompt },
          ],
        },
      ],
      config: {
        // Low resolution keeps long videos within the context window; audio is unaffected.
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        ...(withSearch ? { tools: [{ googleSearch: {} }] } : {}),
      },
    };
  }

  /** Cover, title, author, publish date, duration, description. */
  async fetchMetadata(videoId: string): Promise<VideoMetadata> {
    const prompt = METADATA_PROMPT(watchUrl(videoId));
    let text: string | undefined;
    try {
      // Google Search grounding helps with facts not visible in the video (publish date, description).
      text = (await this.ai.models.generateContent(this.request(videoId, prompt, true))).text;
    } catch (e) {
      console.warn("metadata request with search failed, retrying without search", e);
      text = (await this.ai.models.generateContent(this.request(videoId, prompt, false))).text;
    }
    const json = extractJson(text ?? "");
    if (!json) throw new Error("Gemini 未返回有效的 JSON 元数据");
    return normalizeMetadata(videoId, json);
  }

  /** Text-only prompt (no video), e.g. summarising a GitHub README. */
  async generateText(prompt: string): Promise<string> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const text = res.text?.trim();
    if (!text) throw new Error("Gemini 未返回内容");
    return text;
  }

  /** Structured timestamped transcript using the prompt from the spec. */
  async fetchTranscript(videoId: string): Promise<string> {
    const res = await this.ai.models.generateContent(
      this.request(videoId, buildTranscriptPrompt(watchUrl(videoId)), false),
    );
    const text = res.text?.trim();
    if (!text) throw new Error("Gemini 未返回逐字稿内容");
    return text;
  }
}

/** Public oEmbed endpoint: authoritative title/author without an API key. Best effort. */
export async function fetchOEmbed(videoId: string): Promise<{ title: string; author: string } | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(videoId))}`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; author_name?: string };
    return { title: j.title ?? "", author: j.author_name ?? "" };
  } catch {
    return null;
  }
}
