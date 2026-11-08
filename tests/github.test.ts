import { describe, expect, it } from "vitest";
import {
  buildRepoSummaryPrompt,
  formatStars,
  githubId,
  normalizeRepoInfo,
  normalizeRepoSummary,
  parseGithubUrl,
  README_PROMPT_LIMIT,
  wrapText,
} from "../src/lib/github";
import { coverHue } from "../src/lib/cover";
import { extractVideoId } from "../src/lib/youtube";

describe("parseGithubUrl", () => {
  const ref = { owner: "tauri-apps", repo: "tauri" };
  it.each([
    "https://github.com/tauri-apps/tauri",
    "https://github.com/tauri-apps/tauri/",
    "http://www.github.com/tauri-apps/tauri",
    "github.com/tauri-apps/tauri",
    "https://github.com/tauri-apps/tauri.git",
    "git@github.com:tauri-apps/tauri.git",
    "https://github.com/tauri-apps/tauri/tree/dev/crates?x=1#readme",
    "  https://github.com/tauri-apps/tauri/blob/dev/README.md  ",
  ])("parses %s", (url) => expect(parseGithubUrl(url)).toEqual(ref));

  it("keeps dots and underscores in repo names", () => {
    expect(parseGithubUrl("https://github.com/socketio/socket.io")).toEqual({ owner: "socketio", repo: "socket.io" });
    expect(parseGithubUrl("https://github.com/walkskysu/llm_media_library")?.repo).toBe("llm_media_library");
  });

  it.each([
    "",
    "https://github.com/tauri-apps",
    "https://github.com/",
    "https://gitlab.com/a/b",
    "https://gist.github.com/a/b",
    "https://github.com/orgs/tauri-apps",
    "https://github.com/topics/rust",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "not a url",
  ])("rejects %s", (url) => expect(parseGithubUrl(url)).toBeNull());

  it("is not mistaken for a YouTube link (and vice versa)", () => {
    expect(extractVideoId("https://github.com/tauri-apps/tauri")).toBeNull();
    expect(parseGithubUrl("dQw4w9WgXcQ")).toBeNull();
  });

  it("builds case-insensitive ids that can't collide with YouTube ids", () => {
    expect(githubId({ owner: "Tauri-Apps", repo: "Tauri" })).toBe("github.tauri-apps.tauri");
    expect(githubId({ owner: "a", repo: "b" })).toContain(".");
  });
});

describe("normalizeRepoInfo", () => {
  const ref = { owner: "o", repo: "r" };
  it("maps the GitHub API JSON", () => {
    const info = normalizeRepoInfo(
      {
        full_name: "Owner/Repo",
        name: "Repo",
        owner: { login: "Owner" },
        description: " desc ",
        stargazers_count: 1234,
        language: "Rust",
        topics: ["a", 1, "b"],
        pushed_at: "2024-05-06T07:08:09Z",
        html_url: "https://github.com/Owner/Repo",
      },
      ref,
    );
    expect(info).toMatchObject({
      fullName: "Owner/Repo",
      owner: "Owner",
      name: "Repo",
      description: "desc",
      stars: 1234,
      language: "Rust",
      topics: ["a", "b"],
      pushedAt: "2024-05-06",
      htmlUrl: "https://github.com/Owner/Repo",
    });
  });
  it("falls back to the parsed reference", () => {
    const info = normalizeRepoInfo(null, ref);
    expect(info).toMatchObject({ fullName: "o/r", owner: "o", name: "r", stars: null, htmlUrl: "https://github.com/o/r" });
    expect(normalizeRepoInfo({ html_url: "javascript:alert(1)" }, ref).htmlUrl).toBe("https://github.com/o/r");
  });
});

describe("repo summary", () => {
  const info = normalizeRepoInfo({ description: "A desc", name: "r" }, { owner: "o", repo: "r" });
  it("includes the README and truncates long ones", () => {
    expect(buildRepoSummaryPrompt(info, "# Hello")).toContain("# Hello");
    expect(buildRepoSummaryPrompt(info, "")).toContain("没有 README");
    const long = buildRepoSummaryPrompt(info, "x".repeat(README_PROMPT_LIMIT + 500));
    expect(long).toContain("已截断");
    expect(long.length).toBeLessThan(README_PROMPT_LIMIT + 2000);
  });
  it("parses the model JSON", () => {
    expect(normalizeRepoSummary('```json\n{"headline":"跨平台桌面应用框架","summary":"- 功能"}\n```', info)).toEqual({
      headline: "跨平台桌面应用框架",
      summary: "- 功能",
    });
  });
  it("falls back to plain text and the description", () => {
    expect(normalizeRepoSummary("just text", info)).toEqual({ headline: "A desc", summary: "just text" });
    expect(normalizeRepoSummary('{"summary":"s"}', info).headline).toBe("A desc");
    expect(() => normalizeRepoSummary("  ", info)).toThrow();
  });
});

describe("formatStars", () => {
  it("compacts large numbers", () => {
    expect(formatStars(null)).toBe("");
    expect(formatStars(999)).toBe("999");
    expect(formatStars(1000)).toBe("1k");
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(98765)).toBe("99k");
    expect(formatStars(1_250_000)).toBe("1.3M");
  });
});

describe("wrapText", () => {
  const measure = (s: string) => [...s].length; // 1 unit per char
  it("wraps Latin text at spaces", () => {
    expect(wrapText("build smaller faster apps", 12, measure)).toEqual(["build", "smaller", "faster apps"]);
  });
  it("wraps CJK text anywhere", () => {
    expect(wrapText("构建更小更快更安全的桌面应用", 5, measure)).toEqual(["构建更小更", "快更安全的", "桌面应用"]);
  });
  it("hard-breaks words longer than a line", () => {
    expect(wrapText("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("mixes scripts and limits lines with an ellipsis", () => {
    expect(wrapText("用 Rust 构建桌面应用", 6, measure)).toEqual(["用 Rust", "构建桌面应用"]);
    expect(wrapText("一二三四五六七八九十", 4, measure, 2)).toEqual(["一二三四", "五六七…"]);
  });
});

describe("coverHue", () => {
  it("is stable and in range", () => {
    expect(coverHue("a/b")).toBe(coverHue("a/b"));
    expect(coverHue("tauri-apps/tauri")).toBeGreaterThanOrEqual(0);
    expect(coverHue("tauri-apps/tauri")).toBeLessThan(360);
  });
});
