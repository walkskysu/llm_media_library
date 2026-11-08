import { extractJson } from "./metadata";

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Normalised subset of the GitHub API repository JSON. */
export interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  description: string;
  stars: number | null;
  language: string;
  homepage: string;
  topics: string[];
  pushedAt: string; // YYYY-MM-DD
  htmlUrl: string;
}

export interface RepoSummary {
  headline: string;
  summary: string;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** github.com paths that are not "<owner>/<repo>". */
const RESERVED_OWNERS = new Set([
  "about", "apps", "collections", "contact", "customer-stories", "enterprise", "explore", "features",
  "login", "marketplace", "new", "notifications", "orgs", "organizations", "pricing", "pulls", "issues",
  "search", "settings", "site", "sponsors", "topics", "trending", "users",
]);

/** Parse a GitHub repository URL (https, `github.com/…`, `git@github.com:…`, deep links, `.git` suffix). */
export function parseGithubUrl(input: string): RepoRef | null {
  let raw = input.trim();
  if (!raw) return null;
  const ssh = raw.match(/^git@github\.com:(.+)$/i);
  if (ssh) raw = `https://github.com/${ssh[1]}`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") return null;
  const [owner, rawRepo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!NAME_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** Library id of a repository. YouTube ids never contain ".", so these can't collide. GitHub names are case-insensitive. */
export const githubId = ({ owner, repo }: RepoRef) => `github.${owner}.${repo}`.toLowerCase();

export const repoUrl = ({ owner, repo }: RepoRef) => `https://github.com/${owner}/${repo}`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function normalizeRepoInfo(raw: unknown, ref: RepoRef): RepoInfo {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const owner = (r.owner && typeof r.owner === "object" ? r.owner : {}) as Record<string, unknown>;
  const name = str(r.name) || ref.repo;
  const ownerLogin = str(owner.login) || ref.owner;
  const stars = r.stargazers_count;
  return {
    fullName: str(r.full_name) || `${ownerLogin}/${name}`,
    owner: ownerLogin,
    name,
    description: str(r.description),
    stars: typeof stars === "number" && Number.isFinite(stars) ? stars : null,
    language: str(r.language),
    homepage: str(r.homepage),
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === "string") : [],
    pushedAt: str(r.pushed_at).slice(0, 10),
    htmlUrl: /^https:\/\/github\.com\//.test(str(r.html_url)) ? str(r.html_url) : repoUrl(ref),
  };
}

/** README text sent to Gemini is capped to keep the request small. */
export const README_PROMPT_LIMIT = 30_000;

export function buildRepoSummaryPrompt(info: RepoInfo, readme: string): string {
  const body = readme.trim()
    ? readme.length > README_PROMPT_LIMIT
      ? `${readme.slice(0, README_PROMPT_LIMIT)}\n\n…(README 已截断)`
      : readme
    : "(该仓库没有 README)";
  return `你是一名资深软件工程师。下面是一个 GitHub 仓库的基本信息和 README，请用简体中文帮我理解这个仓库。

仓库：${info.fullName}
简介：${info.description || "—"}
主要语言：${info.language || "—"}
Topics：${info.topics.join(", ") || "—"}
主页：${info.homepage || "—"}

===== README 开始 =====
${body}
===== README 结束 =====

只返回一个 JSON 对象（不要 Markdown 代码块，也不要其他说明），格式如下：
{
  "headline": string, // 一句话说明这个仓库是做什么的，突出核心功能，不超过 24 个汉字，不要包含仓库名
  "summary": string   // 仓库的摘要说明，300~600 字。用若干小段落或以 "- " 开头的列表，依次介绍：它是什么/解决什么问题、主要功能与特点、技术栈、适用场景、如何开始使用（如 README 中有）
}`;
}

export function normalizeRepoSummary(text: string, info: RepoInfo): RepoSummary {
  const json = extractJson(text);
  if (json) {
    const headline = str(json.headline ?? json.title);
    const summary = str(json.summary ?? json.description);
    if (summary) return { headline: headline || info.description || info.name, summary };
  }
  const plain = text.replace(/```[a-z]*|```/gi, "").trim();
  if (!plain) throw new Error("Gemini 未返回仓库摘要");
  return { headline: info.description || info.name, summary: plain };
}

/** Compact number for the cover / meta line: 1234 → 1.2k. */
export function formatStars(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const CJK = "\\u2E80-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF00-\\uFFEF";

/**
 * Greedy line wrapping that works for both CJK (break anywhere) and Latin text (break at spaces; over-long words are hard-broken).
 * Lines beyond `maxLines` are dropped and the last kept line gets an ellipsis.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines = Infinity): string[] {
  // Tokens: single CJK characters (can break anywhere), whitespace runs, or Latin words.
  const tokens = text.trim().match(new RegExp(`[${CJK}]|\\s+|[^\\s${CJK}]+`, "g")) ?? [];
  const lines: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) lines.push(cur.trim());
    cur = "";
  };
  for (const tok of tokens) {
    if (measure(cur + tok) <= maxWidth) {
      cur += tok;
      continue;
    }
    if (/^\s+$/.test(tok)) {
      push();
      continue;
    }
    push();
    // A single token wider than the line: hard-break by character.
    if (measure(tok) > maxWidth) {
      for (const ch of tok) {
        if (cur && measure(cur + ch) > maxWidth) push();
        cur += ch;
      }
    } else {
      cur = tok;
    }
  }
  push();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && measure(`${last}…`) > maxWidth) last = [...last].slice(0, -1).join("");
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}
