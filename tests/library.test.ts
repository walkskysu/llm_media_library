import { describe, expect, it } from "vitest";
import { createQueue, filterVideos, newVideo, recoverInterrupted, sortVideos, thumbnailCandidates } from "../src/lib/library";

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

describe("thumbnailCandidates", () => {
  it("prefers the stored url and dedupes fallbacks", () => {
    const v = newVideo("aaaaaaaaaaa");
    expect(thumbnailCandidates(v)).toEqual([
      "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      "https://i.ytimg.com/vi/aaaaaaaaaaa/maxresdefault.jpg",
    ]);
    expect(thumbnailCandidates({ ...v, thumbnailUrl: "" })[0]).toContain("maxresdefault");
  });
});

describe("createQueue", () => {
  it("runs tasks sequentially even if one fails", async () => {
    const enqueue = createQueue();
    const log: string[] = [];
    const slow = enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      log.push("a");
      throw new Error("x");
    });
    const fast = enqueue(async () => log.push("b"));
    await expect(slow).rejects.toThrow("x");
    await fast;
    expect(log).toEqual(["a", "b"]);
  });
});
