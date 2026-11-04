import { describe, expect, it } from "vitest";
import { filterVideos, newVideo, recoverInterrupted, sortVideos } from "../src/lib/library";

describe("library", () => {
  const a = { ...newVideo("aaaaaaaaaaa", new Date("2024-01-01")), title: "Rust tips", status: "ready" as const };
  const b = { ...newVideo("bbbbbbbbbbb", new Date("2024-02-01")), author: "TypeScript Guy" };

  it("creates processing entries with derived urls", () => {
    expect(b.status).toBe("processing");
    expect(b.url).toBe("https://www.youtube.com/watch?v=bbbbbbbbbbb");
    expect(b.thumbnailUrl).toContain("bbbbbbbbbbb");
  });
  it("sorts newest first", () => expect(sortVideos([a, b]).map((v) => v.id)).toEqual([b.id, a.id]));
  it("filters case-insensitively", () => {
    expect(filterVideos([a, b], "rust")).toEqual([a]);
    expect(filterVideos([a, b], "typescript")).toEqual([b]);
    expect(filterVideos([a, b], " ")).toHaveLength(2);
  });
  it("marks interrupted entries as errors", () => {
    const [ra, rb] = recoverInterrupted([a, b]);
    expect(ra.status).toBe("ready");
    expect(rb.status).toBe("error");
  });
});
