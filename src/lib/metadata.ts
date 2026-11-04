import { normalizeDate, parseDuration } from "./format";
import type { VideoMetadata } from "./types";
import { thumbnailUrl } from "./youtube";

/** Extract the first JSON object from a model response (tolerates ```json fences and chatter). */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const v = JSON.parse(c.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Normalise the model's metadata JSON into our VideoMetadata shape. */
export function normalizeMetadata(videoId: string, raw: Record<string, unknown> | null): VideoMetadata {
  const r = raw ?? {};
  const thumb = str(r.thumbnailUrl ?? r.thumbnail ?? r.cover);
  return {
    title: str(r.title),
    author: str(r.author ?? r.channel ?? r.channelName),
    publishedAt: normalizeDate(r.publishedAt ?? r.publishDate ?? r.uploadDate),
    durationSeconds: parseDuration(r.durationSeconds ?? r.duration),
    description: str(r.description),
    // The i.ytimg.com URL derived from the id is always correct; only trust the model's if it's a YouTube image.
    thumbnailUrl: /^https:\/\/i\d?\.ytimg\.com\//.test(thumb) && thumb.includes(videoId) ? thumb : thumbnailUrl(videoId),
  };
}

export const METADATA_PROMPT = (url: string) => `You are given a YouTube video: ${url}
Return ONLY a JSON object (no markdown, no commentary) with these fields describing the video:
{
  "title": string,            // exact video title
  "author": string,           // channel / uploader name
  "publishedAt": string,      // publish date as YYYY-MM-DD, empty string if unknown
  "durationSeconds": number,  // total length of the video in seconds
  "description": string,      // the video's description text (keep the original language)
  "thumbnailUrl": string      // cover image URL
}`;
