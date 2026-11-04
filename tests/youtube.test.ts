import { describe, expect, it } from "vitest";
import { embedUrl, extractVideoId, thumbnailUrl, watchUrl } from "../src/lib/youtube";

describe("extractVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=x", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ?feature=share", "dQw4w9WgXcQ"],
    ["  dQw4w9WgXcQ  ", "dQw4w9WgXcQ"],
  ])("%s", (input, id) => expect(extractVideoId(input)).toBe(id));

  it.each(["", "hello world", "https://vimeo.com/123", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/@channel"])(
    "rejects %s",
    (input) => expect(extractVideoId(input)).toBeNull(),
  );
});

describe("urls", () => {
  it("builds urls", () => {
    expect(watchUrl("abc")).toBe("https://www.youtube.com/watch?v=abc");
    expect(thumbnailUrl("abc")).toBe("https://i.ytimg.com/vi/abc/hqdefault.jpg");
    expect(embedUrl("abc")).not.toContain("start=");
    expect(embedUrl("abc", 75.6, true)).toMatch(/start=75.*autoplay=1/);
  });
});
