import { describe, expect, it } from "vitest";
import { extractJson, METADATA_PROMPT, normalizeMetadata } from "../src/lib/metadata";

describe("extractJson", () => {
  it("handles plain, fenced and chatty responses", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(extractJson("no json")).toBeNull();
    expect(extractJson("[1,2]")).toBeNull();
  });
});

describe("normalizeMetadata", () => {
  it("normalises fields and falls back to derived thumbnail", () => {
    const m = normalizeMetadata("dQw4w9WgXcQ", {
      title: " Title ",
      channel: "Chan",
      publishedAt: "2009/10/25",
      duration: "PT3M33S",
      description: "desc",
      thumbnailUrl: "https://example.com/x.jpg",
    });
    expect(m).toEqual({
      title: "Title",
      author: "Chan",
      publishedAt: "2009-10-25",
      durationSeconds: 213,
      description: "desc",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });
  it("keeps a valid ytimg thumbnail for the same video", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg";
    expect(normalizeMetadata("dQw4w9WgXcQ", { thumbnailUrl: url }).thumbnailUrl).toBe(url);
  });
  it("prompt contains url", () => {
    expect(METADATA_PROMPT("https://youtu.be/x")).toContain("https://youtu.be/x");
  });
});
