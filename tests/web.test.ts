import { describe, expect, it } from "vitest";
import {
  buildPageSummaryPrompt,
  decodeEntities,
  decodePage,
  detectCharset,
  extractText,
  hostOf,
  isGithubHost,
  normalizePageSummary,
  normalizeWebUrl,
  PAGE_PROMPT_LIMIT,
  parsePage,
  pdfTitle,
  webId,
} from "../src/lib/web";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("normalizeWebUrl", () => {
  it("accepts http(s) urls and bare domains", () => {
    expect(normalizeWebUrl("https://example.com/a?b=1#frag")).toBe("https://example.com/a?b=1");
    expect(normalizeWebUrl("  example.com/post  ")).toBe("https://example.com/post");
    expect(normalizeWebUrl("http://blog.example.co.uk")).toBe("http://blog.example.co.uk/");
    expect(normalizeWebUrl("localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(normalizeWebUrl("中文.com")).toBe("https://xn--fiq228c.com/"); // IDN hosts are punycoded
  });
  it("rejects non-web input", () => {
    for (const bad of ["", "hello", "hello world.com", "ftp://example.com", "javascript:alert(1)", "file:///c:/x", "mailto:a@b.com"]) {
      expect(normalizeWebUrl(bad), bad).toBeNull();
    }
  });
});

describe("ids & hosts", () => {
  it("derives stable, file-name safe ids", () => {
    const a = webId("https://example.com/a");
    expect(a).toMatch(/^web\.[0-9a-f]{16}$/);
    expect(webId("https://example.com/a")).toBe(a);
    expect(webId("https://example.com/b")).not.toBe(a);
  });
  it("detects github hosts", () => {
    expect(isGithubHost("https://github.com/owner/repo")).toBe(true);
    expect(isGithubHost("www.github.com/explore")).toBe(true);
    expect(isGithubHost("git@github.com:o/r.git")).toBe(true);
    expect(isGithubHost("https://gist.github.com/x")).toBe(false);
    expect(isGithubHost("https://example.com/github.com")).toBe(false);
  });
  it("extracts hosts and pdf titles", () => {
    expect(hostOf("https://www.example.com/x")).toBe("example.com");
    expect(hostOf("nope")).toBe("");
    expect(pdfTitle("https://example.com/papers/%E8%AE%BA%E6%96%87.pdf")).toBe("论文.pdf");
    expect(pdfTitle("https://example.com/")).toBe("example.com");
  });
});

describe("parsePage", () => {
  const html = `<!doctype html><html><head>
    <meta charset="utf-8">
    <title>Fallback &amp; Title</title>
    <meta property="og:title" content="OG &quot;Title&quot;">
    <meta name="description" content="A   short
      description">
    <meta property="og:site_name" content='Example Blog'>
    <meta property="og:image" content="/img/cover.png">
    <meta property="article:published_time" content="2024-05-06T10:00:00Z">
    <style>.x{}</style><script>var a = "<p>not text</p>";</script>
    </head><body>
    <nav>Home | About</nav>
    <article><h1>Heading</h1><p>First paragraph with enough words to count as real content.</p>
    <ul><li>one</li><li>two</li></ul>
    <p>${"More text. ".repeat(30)}</p></article>
    <footer>© footer</footer>
    </body></html>`;
  const info = parsePage(html, "https://www.example.com/post/1");

  it("reads meta tags", () => {
    expect(info.title).toBe('OG "Title"');
    expect(info.description).toBe("A short description");
    expect(info.siteName).toBe("Example Blog");
    expect(info.image).toBe("https://www.example.com/img/cover.png");
    expect(info.publishedAt).toBe("2024-05-06");
  });
  it("extracts readable article text", () => {
    expect(info.text).toContain("Heading");
    expect(info.text).toContain("- one");
    expect(info.text).not.toContain("not text");
    expect(info.text).not.toContain("Home | About");
    expect(info.text).not.toContain("footer");
  });
  it("falls back to <title>, h1 and host", () => {
    expect(parsePage("<title> Plain  title </title>", "https://a.com/").title).toBe("Plain title");
    expect(parsePage("<h1>Big <b>head</b></h1>", "https://a.com/").title).toBe("Big head");
    const bare = parsePage("<p>x</p>", "https://www.a.com/");
    expect(bare.title).toBe("a.com");
    expect(bare.siteName).toBe("a.com");
    expect(bare.image).toBe("");
    expect(bare.publishedAt).toBe("");
  });
  it("uses the whole body when there is no article", () => {
    expect(extractText("<body><div>Hello</div><div>World &lt;3</div></body>")).toBe("Hello\nWorld <3");
  });
  it("decodes entities", () => {
    expect(decodeEntities("&#20013;&#x6587; &nbsp;&hellip; &bogus;")).toBe("中文  … &bogus;");
  });
});

describe("decodePage", () => {
  it("detects charsets from header or meta", () => {
    const enc = new TextEncoder();
    expect(detectCharset("text/html; charset=GBK", new Uint8Array())).toBe("gbk");
    expect(detectCharset("text/html", enc.encode('<meta http-equiv="Content-Type" content="text/html; charset=big5">'))).toBe("big5");
    expect(detectCharset("", enc.encode("<meta charset='Shift_JIS'>"))).toBe("shift_jis");
    expect(detectCharset("", enc.encode("<html>"))).toBe("utf-8");
  });
  it("decodes utf-8 and gbk bodies", () => {
    const utf8 = new TextEncoder().encode("<title>你好</title>");
    expect(decodePage({ finalUrl: "https://a.com/", contentType: "text/html", contentTypeHeader: "text/html", body: b64(utf8) }).html).toBe(
      "<title>你好</title>",
    );
    // "你好" in GBK.
    const gbk = new Uint8Array([0x3c, 0x62, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x62, 0x3e]);
    const page = decodePage({ finalUrl: "https://a.com/x", contentType: "text/html", contentTypeHeader: "text/html; charset=gbk", body: b64(gbk) });
    expect(page.html).toBe("<b>你好</b>");
    expect(page.url).toBe("https://a.com/x");
    expect(page.isPdf).toBe(false);
  });
  it("survives unknown charsets and flags PDFs", () => {
    const body = b64(new TextEncoder().encode("ok"));
    expect(decodePage({ finalUrl: "u", contentType: "text/html", contentTypeHeader: "charset=x-nope", body }).html).toBe("ok");
    expect(decodePage({ finalUrl: "u", contentType: "application/pdf", contentTypeHeader: "", body: "" }).isPdf).toBe(true);
  });
});

describe("summary prompt", () => {
  const info = { url: "https://a.com/", title: "T", description: "D", siteName: "S", image: "", publishedAt: "", text: "x".repeat(PAGE_PROMPT_LIMIT + 10) };
  it("truncates long pages", () => {
    const p = buildPageSummaryPrompt(info);
    expect(p).toContain("正文已截断");
    expect(p).toContain("https://a.com/");
    expect(buildPageSummaryPrompt({ ...info, text: "" })).toContain("未能提取到正文");
  });
  it("normalises Gemini output", () => {
    expect(normalizePageSummary('```json\n{"headline":"H","summary":"S"}\n```', info)).toEqual({ headline: "H", summary: "S" });
    expect(normalizePageSummary('{"summary":"S"}', info)).toEqual({ headline: "D", summary: "S" });
    expect(normalizePageSummary("plain text", info)).toEqual({ headline: "D", summary: "plain text" });
    expect(() => normalizePageSummary("  ", info)).toThrow();
  });
});
