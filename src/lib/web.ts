import { extractJson } from "./metadata";

/** What the backend's `fetch_web_page` returns. */
export interface RawPage {
  finalUrl: string;
  /** Lower-cased MIME type without parameters, e.g. "text/html" or "application/pdf". */
  contentType: string;
  /** Full Content-Type header (may carry `charset=`). */
  contentTypeHeader: string;
  /** Base64 of the raw body (empty for PDFs). */
  body: string;
}

/** Character set from the Content-Type header, else from `<meta charset>` / `http-equiv` in the first bytes, else UTF-8. */
export function detectCharset(contentTypeHeader: string, head: Uint8Array): string {
  const fromHeader = contentTypeHeader.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf-8";
  const ascii = String.fromCharCode(...head.subarray(0, 4096));
  const fromMeta = ascii.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  return (fromMeta ?? "utf-8").toLowerCase();
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode the page body honouring its charset (GBK / Big5 / Shift_JIS pages are common). */
export function decodePage(raw: RawPage): { url: string; isPdf: boolean; html: string } {
  const isPdf = raw.contentType === "application/pdf";
  const bytes = fromBase64(raw.body);
  const charset = detectCharset(raw.contentTypeHeader ?? "", bytes);
  let html: string;
  try {
    html = new TextDecoder(charset).decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes);
  }
  return { url: raw.finalUrl, isPdf, html };
}

/** Normalised information extracted from a web page's HTML. */
export interface PageInfo {
  url: string;
  title: string;
  description: string;
  siteName: string;
  image: string;
  publishedAt: string; // YYYY-MM-DD when known
  /** Readable body text (scripts, styles, navigation removed). */
  text: string;
}

export interface PageSummary {
  headline: string;
  summary: string;
}

/**
 * Normalise user input into an http(s) URL for bookmarking a generic web page.
 * Bare domains get `https://`; the `#fragment` is dropped. Returns null for anything that isn't a web address.
 */
export function normalizeWebUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d+(\/|$)/.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  if (!isIp && host !== "localhost" && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i.test(host.replace(/\.$/, ""))) {
    return null;
  }
  url.hash = "";
  return url.toString();
}

/** True when the URL points at github.com — those are handled by the GitHub bookmarking rules. */
export function isGithubHost(input: string): boolean {
  const raw = input.trim();
  if (/^git@github\.com:/i.test(raw)) return true;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") === "github.com";
  } catch {
    return false;
  }
}

/** 64-bit-ish FNV-1a style hash (two 32-bit lanes), hex encoded. Stable across runs. */
function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Library id of a web page: `web.<hash of the normalised URL>` (safe as a file name, can't collide with other kinds). */
export const webId = (url: string) => `web.${hash(url)}`;

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** Attributes of every `<meta>` tag, keyed by lower-cased property / name / itemprop. First occurrence wins. */
function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of m[1].matchAll(/([a-z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? a[5] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content != null && !out.has(key)) out.set(key, clean(content));
  }
  return out;
}

function resolveUrl(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

const strip = (html: string) => clean(html.replace(/<[^>]+>/g, " "));

/** Remove non-content markup and return the readable text of the page (prefers `<article>` / `<main>`). */
export function extractText(html: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const pick = (tag: string) => {
    const parts = [...body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))].map((m) => m[1]);
    const joined = parts.join("\n");
    return strip(joined).length > 200 ? joined : null;
  };
  body = pick("article") ?? pick("main") ?? body.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? body;
  // Keep some structure: block elements become line breaks.
  const text = body
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/blockquote|\/pre)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Parse title / description / site name / cover image / publish date / text from raw HTML. */
export function parsePage(html: string, url: string): PageInfo {
  const meta = metaTags(html);
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const host = hostOf(url);
  const title =
    meta.get("og:title") || meta.get("twitter:title") || (titleTag && clean(titleTag)) || (h1 && strip(h1)) || host || url;
  const description = meta.get("og:description") || meta.get("description") || meta.get("twitter:description") || "";
  const siteName = meta.get("og:site_name") || meta.get("application-name") || host;
  const imageRaw = meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image") || "";
  const published =
    meta.get("article:published_time") || meta.get("datepublished") || meta.get("date") || meta.get("pubdate") ||
    html.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  return {
    url,
    title,
    description,
    siteName,
    image: imageRaw ? resolveUrl(decodeEntities(imageRaw), url) : "",
    publishedAt: /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : "",
    text: extractText(html),
  };
}

/** Title for a link that serves a PDF directly: the file name. */
export function pdfTitle(url: string): string {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return name || u.hostname;
  } catch {
    return url;
  }
}

/** Page text sent to Gemini is capped to keep the request small. */
export const PAGE_PROMPT_LIMIT = 30_000;

export function buildPageSummaryPrompt(info: PageInfo): string {
  const text = info.text.trim()
    ? info.text.length > PAGE_PROMPT_LIMIT
      ? `${info.text.slice(0, PAGE_PROMPT_LIMIT)}\n\n…(正文已截断)`
      : info.text
    : "(未能提取到正文)";
  return `你是一名专业的内容编辑。下面是一个网页的基本信息和正文，请用简体中文帮我概括这个网页。

网址：${info.url}
标题：${info.title}
网站：${info.siteName || "—"}
简介：${info.description || "—"}

===== 正文开始 =====
${text}
===== 正文结束 =====

只返回一个 JSON 对象（不要 Markdown 代码块，也不要其他说明），格式如下：
{
  "headline": string, // 一句话概括这个网页的核心内容，不超过 30 个汉字，不要重复标题
  "summary": string   // 网页的大致介绍，200~500 字。用若干小段落或以 "- " 开头的列表，依次说明：主题/背景、主要内容与要点、结论或适用对象
}`;
}

export function normalizePageSummary(text: string, info: Pick<PageInfo, "title" | "description">): PageSummary {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const json = extractJson(text);
  if (json) {
    const headline = str(json.headline ?? json.title);
    const summary = str(json.summary ?? json.description);
    if (summary) return { headline: headline || info.description, summary };
  }
  const plain = text.replace(/```[a-z]*|```/gi, "").trim();
  if (!plain) throw new Error("Gemini 未返回网页摘要");
  return { headline: info.description, summary: plain };
}
