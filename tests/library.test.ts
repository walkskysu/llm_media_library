import { describe, expect, it } from "vitest";
import {
  countByKind,
  createQueue,
  filterByKind,
  filterVideos,
  kindOf,
  newGithubRepo,
  newVideo,
  newWebPage,
  recoverInterrupted,
  sortVideos,
  thumbnailCandidates,
} from "../src/lib/library";

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

describe("kinds", () => {
  const yt = newVideo("aaaaaaaaaaa", new Date("2024-01-01"));
  const legacy = { ...newVideo("ccccccccccc"), kind: undefined };
  const gh = { ...newGithubRepo({ owner: "tauri-apps", repo: "tauri" }), summary: "跨平台 desktop framework" };

  it("creates github entries", () => {
    expect(gh).toMatchObject({
      id: "github.tauri-apps.tauri",
      url: "https://github.com/tauri-apps/tauri",
      title: "tauri-apps/tauri",
      kind: "github",
      status: "processing",
    });
  });
  it("treats entries without a kind as YouTube", () => {
    expect(kindOf(legacy)).toBe("youtube");
    expect(kindOf(yt)).toBe("youtube");
  });
  it("filters and counts by kind", () => {
    const all = [yt, legacy, gh];
    expect(filterByKind(all, "all")).toHaveLength(3);
    expect(filterByKind(all, "youtube")).toEqual([yt, legacy]);
    expect(filterByKind(all, "github")).toEqual([gh]);
    expect(countByKind(all)).toEqual({ all: 3, youtube: 2, github: 1, web: 0, pdf: 0 });
  });
  it("searches the repo summary", () => expect(filterVideos([yt, gh], "desktop")).toEqual([gh]));
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

describe("web pages", () => {
  const a = newVideo("aaaaaaaaaaa");
  it("creates web page entries and filters by kind / pdf", () => {
    const w = newWebPage("https://www.example.com/post", new Date("2024-03-01"));
    expect(w.kind).toBe("web");
    expect(w.id).toMatch(/^web\./);
    expect(w.title).toBe("example.com");
    const withPdf = { ...newWebPage("https://example.com/b"), localPdf: "/data/pdfs/x.pdf" };
    const all = [a, w, withPdf];
    expect(filterByKind(all, "web")).toEqual([w, withPdf]);
    expect(filterByKind(all, "pdf")).toEqual([withPdf]);
    expect(countByKind(all)).toEqual({ all: 3, youtube: 1, github: 0, web: 2, pdf: 1 });
  });
});
