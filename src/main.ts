import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { documentDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { backend } from "./lib/backend";
import { DEFAULT_MODEL, fetchOEmbed, GeminiClient } from "./lib/gemini";
import {
  countByKind,
  createQueue,
  filterByKind,
  filterVideos,
  kindOf,
  type KindFilter,
  newGithubRepo,
  newVideo,
  newWebPage,
  recoverInterrupted,
  sortVideos,
  thumbnailCandidates,
} from "./lib/library";
import { renderGithubCover, renderWebCover } from "./lib/cover";
import {
  buildPageSummaryPrompt,
  decodePage,
  hostOf,
  isGithubHost,
  normalizePageSummary,
  normalizeWebUrl,
  parsePage,
  pdfTitle,
  webId,
} from "./lib/web";
import {
  buildRepoSummaryPrompt,
  formatStars,
  githubId,
  normalizeRepoInfo,
  normalizeRepoSummary,
  parseGithubUrl,
} from "./lib/github";
import { formatDuration } from "./lib/format";
import { parseTranscript } from "./lib/transcript";
import type { GeminiConfig, Video } from "./lib/types";
import { embedUrl, extractVideoId } from "./lib/youtube";
import { evaluateUpdate, RELEASES_URL, type UpdateCheck } from "./lib/update";

const state = {
  dataDir: null as string | null,
  gemini: { apiKey: null, model: null, source: null } as GeminiConfig,
  videos: [] as Video[],
  query: "",
  kind: "all" as KindFilter,
  openId: null as string | null,
  appVersion: "",
  update: {
    checking: false,
    installing: false,
    result: null as UpdateCheck | null,
    error: null as string | null,
    checkedAt: null as Date | null,
  },
};

const app = document.querySelector<HTMLDivElement>("#app")!;

// ---------- helpers ----------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

function toast(msg: string, kind: "info" | "error" = "info") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3000);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const dbQueue = createQueue();

/** Write the current in-memory state of one video to the SQLite database. */
async function persist(id: string) {
  try {
    await dbQueue(async () => {
      // Read state when the write actually runs, so a deleted video isn't resurrected.
      const v = state.videos.find((x) => x.id === id);
      if (v) await backend.saveVideo(v);
    });
  } catch (e) {
    toast(`保存失败: ${errMsg(e)}`, "error");
  }
}

async function removeVideo(id: string) {
  state.videos = state.videos.filter((x) => x.id !== id);
  try {
    await dbQueue(() => backend.deleteVideo(id));
  } catch (e) {
    toast(`删除失败: ${errMsg(e)}`, "error");
  }
}

const caching = new Set<string>();
const coverRetried = new Set<string>();
const coverStamp = new Map<string, number>();

/** Download the cover into 数据目录/thumbnails so it is always displayed from local storage. */
async function cacheThumbnail(id: string) {
  const v = state.videos.find((x) => x.id === id);
  if (!v || caching.has(id)) return;
  caching.add(id);
  try {
    // GitHub / web covers are drawn locally (name/title + headline); YouTube covers are downloaded.
    const kind = kindOf(v);
    const png = kind === "github" ? await githubCoverPng(v) : kind === "web" ? await webCoverPng(v) : null;
    // Queue behind pending writes: the backend requires the row to exist.
    const path = await dbQueue(() =>
      png ? backend.storeCover(id, png) : backend.cacheThumbnail(id, thumbnailCandidates(v)),
    );
    if (state.videos.some((x) => x.id === id)) {
      coverStamp.set(id, Date.now());
      state.videos = state.videos.map((x) => (x.id === id ? { ...x, localThumbnail: path } : x));
      refresh(id);
    }
  } catch (e) {
    console.warn(`cover cache failed for ${id}:`, e);
  } finally {
    caching.delete(id);
  }
}

function githubCoverPng(v: Video): Promise<Uint8Array> {
  const [owner, ...rest] = v.title.split("/");
  return renderGithubCover({
    owner: owner || v.author,
    name: rest.join("/") || v.title,
    headline: v.headline || v.description,
    language: v.language,
    stars: v.stars,
  });
}

function webCoverPng(v: Video): Promise<Uint8Array> {
  const host = hostOf(v.url);
  return renderWebCover({
    title: v.title || host,
    site: v.author,
    headline: v.headline || v.description || "",
    host,
    hasPdf: !!v.localPdf,
  });
}

/** Cover src: always the locally cached file (cache-busted so a re-download shows up). */
function coverSrc(v: Video): string | null {
  if (!v.localThumbnail) return null;
  const stamp = coverStamp.get(v.id);
  return convertFileSrc(v.localThumbnail) + (stamp ? `?v=${stamp}` : "");
}

function updateVideo(id: string, patch: Partial<Video>) {
  state.videos = state.videos.map((v) =>
    v.id === id ? { ...v, ...patch, updatedAt: new Date().toISOString() } : v,
  );
}

// ---------- setup: choose data directory ----------

async function renderSetup(changing = false) {
  const suggested = await join(await documentDir(), "LLMMediaLibrary").catch(() => "");
  const input = h("input", {
    type: "text",
    class: "path-input",
    value: state.dataDir ?? suggested,
    placeholder: "例如 D:\\MyData\\LLMMediaLibrary",
  });
  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "选择数据目录" });
    if (typeof picked === "string") input.value = picked;
  };
  const confirm = async () => {
    try {
      const s = await backend.setDataDir(input.value);
      state.dataDir = s.dataDir;
      await boot();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  app.replaceChildren(
    h(
      "div",
      { class: "setup" },
      h("h1", {}, changing ? "更改数据目录" : "欢迎使用 LLM Media Library"),
      h(
        "p",
        {},
        "请选择用于存放收藏数据的目录（data 目录）。收藏列表保存在该目录下的 SQLite 数据库 library.db，视频封面保存在 thumbnails 子目录，",
        "Gemini 配置可放在该目录下的 conf.json 文件中（GEMINI_API_KEY / GEMINI_API_MODEL）。",
      ),
      h("div", { class: "row" }, input, h("button", { onclick: browse }, "浏览…")),
      h(
        "div",
        { class: "row end" },
        changing ? h("button", { class: "ghost", onclick: () => renderMain() }, "取消") : null,
        h("button", { class: "primary", onclick: confirm }, "确认使用此目录"),
      ),
    ),
  );
}

// ---------- main view ----------

function statusBadge(v: Video) {
  if (v.status === "processing") return h("span", { class: "badge processing" }, "处理中…");
  if (v.status === "error") return h("span", { class: "badge error", title: v.error ?? "" }, "失败");
  return null;
}

const KIND_LABEL = { youtube: "YouTube", github: "GitHub", web: "网页" } as const;

function card(v: Video) {
  const src = coverSrc(v);
  const img = src
    ? h("img", { src, alt: v.title, loading: "lazy" })
    : h("div", { class: "cover-placeholder" }, kindOf(v) === "youtube" ? "封面下载中…" : "封面生成中…");
  // Cached file vanished from disk: download it again.
  if (src)
    img.addEventListener("error", () => {
      if (coverRetried.has(v.id)) return;
      coverRetried.add(v.id);
      void cacheThumbnail(v.id);
    });
  return h(
    "article",
    { class: "card" },
    h(
      "button",
      { class: "cover", title: "查看详情", onclick: () => openDetail(v.id) },
      img,
      v.durationSeconds ? h("span", { class: "duration" }, formatDuration(v.durationSeconds)) : null,
      h(
        "span",
        { class: "chips" },
        h("span", { class: `kind-chip ${kindOf(v)}` }, KIND_LABEL[kindOf(v)]),
        v.localPdf ? h("span", { class: "kind-chip pdf" }, "PDF") : null,
      ),
      statusBadge(v),
    ),
    h(
      "div",
      { class: "card-body" },
      h("h3", { class: "title", title: v.title }, v.title || v.url),
      kindOf(v) === "web"
        ? h(
            "div",
            { class: "meta" },
            v.headline ? h("span", { class: "headline", title: v.headline }, v.headline) : null,
            h("span", {}, v.author || hostOf(v.url)),
            v.publishedAt ? h("span", {}, v.publishedAt) : null,
          )
        : kindOf(v) === "github"
        ? h(
            "div",
            { class: "meta" },
            v.headline ? h("span", { class: "headline", title: v.headline }, v.headline) : null,
            v.language ? h("span", {}, v.language) : null,
            v.stars != null ? h("span", {}, `★ ${formatStars(v.stars)}`) : null,
          )
        : h(
            "div",
            { class: "meta" },
            h("span", {}, v.author || "—"),
            v.publishedAt ? h("span", {}, v.publishedAt) : null,
          ),
    ),
  );
}

function renderGrid() {
  const grid = document.querySelector<HTMLDivElement>("#grid");
  if (!grid) return;
  const inTab = filterByKind(state.videos, state.kind);
  const list = filterVideos(sortVideos(inTab), state.query);
  if (inTab.length === 0) {
    const hint = {
      all: "还没有收藏任何内容。在上方粘贴 YouTube 视频链接、GitHub 仓库地址或任意网址开始收藏吧！",
      youtube: "还没有收藏的视频。在上方输入 YouTube 链接开始收藏吧！",
      github: "还没有收藏的 GitHub 仓库。在上方粘贴 GitHub 仓库地址开始收藏吧！",
      web: "还没有收藏的网页。在上方粘贴网址开始收藏吧！",
      pdf: "还没有保存为 PDF 的网页。收藏网页时勾选「保存为 PDF」，或在网页详情中点击「保存为 PDF」。",
    }[state.kind];
    grid.replaceChildren(h("div", { class: "empty" }, hint));
  } else if (list.length === 0) {
    grid.replaceChildren(h("div", { class: "empty" }, "没有匹配的内容"));
  } else {
    grid.replaceChildren(...list.map(card));
  }
  renderTabs();
}

const TABS: { kind: KindFilter; label: string }[] = [
  { kind: "all", label: "全部" },
  { kind: "youtube", label: "YouTube" },
  { kind: "github", label: "GitHub" },
  { kind: "web", label: "网址" },
  { kind: "pdf", label: "PDF 文件" },
];

/** 全部 / YouTube / GitHub / 网址 / PDF switcher with per-kind counts. */
function renderTabs() {
  const box = document.querySelector<HTMLDivElement>("#tabs");
  if (!box) return;
  const counts = countByKind(state.videos);
  box.replaceChildren(
    ...TABS.map((t) =>
      h(
        "button",
        {
          class: `tab${state.kind === t.kind ? " active" : ""}`,
          role: "tab",
          "aria-selected": String(state.kind === t.kind),
          onclick: () => {
            state.kind = t.kind;
            renderGrid();
          },
        },
        t.label,
        h("span", { class: "tab-count" }, String(counts[t.kind])),
      ),
    ),
  );
}

function renderMain() {
  const urlInput = h("input", {
    type: "text",
    id: "url-input",
    placeholder: "粘贴 YouTube 视频链接、GitHub 仓库地址或任意网址，例如 https://example.com/article",
  });
  const submit = async (e: Event) => {
    e.preventDefault();
    if (await addItem(urlInput.value)) urlInput.value = "";
  };
  const search = h("input", {
    type: "search",
    class: "search",
    placeholder: "搜索标题 / 作者 / 内容",
    value: state.query,
  });
  search.addEventListener("input", () => {
    state.query = search.value;
    renderGrid();
  });

  app.replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h("button", { class: "brand", onclick: goHome, title: "返回首页" }, "🎬 LLM Media Library"),
      h("form", { class: "add-form", onsubmit: submit }, urlInput, h("button", { class: "primary", type: "submit" }, "收藏")),
      h("button", { class: "ghost", id: "settings-btn", onclick: openSettings, title: "设置" }, "⚙ 设置"),
    ),
    h(
      "div",
      { id: "home" },
      !state.gemini.apiKey
        ? h(
            "div",
            { class: "warning" },
            "未找到 GEMINI_API_KEY。请在 数据目录/conf.json 中配置，或点击右上角 设置 填写。",
          )
        : "",
      h("div", { class: "toolbar" }, h("div", { id: "tabs", class: "tabs", role: "tablist" }), search),
      h("main", { id: "grid", class: "grid" }),
    ),
    h("section", { id: "detail-page", hidden: true }),
  );
  renderGrid();
  renderUpdateDot();
  if (state.openId) openDetail(state.openId);
}

/** Mark the settings button when a newer release is available. */
function renderUpdateDot() {
  const btn = document.querySelector<HTMLButtonElement>("#settings-btn");
  if (!btn) return;
  const has = !!state.update.result?.hasUpdate;
  btn.title = has ? `有新版本可用：${state.update.result?.latest?.tag}` : "设置";
  btn.querySelector(".update-dot")?.remove();
  if (has) btn.append(h("span", { class: "update-dot" }));
}

// ---------- add & process ----------

function gemini(): GeminiClient {
  if (!state.gemini.apiKey) throw new Error("未配置 GEMINI_API_KEY");
  return new GeminiClient(state.gemini.apiKey, state.gemini.model);
}

/** Bookmark a YouTube video, a GitHub repository or a generic web page, depending on the URL. */
async function addItem(input: string): Promise<boolean> {
  if (!input.trim()) return false;
  if (extractVideoId(input)) return addVideo(input);
  if (isGithubHost(input)) {
    if (parseGithubUrl(input)) return addGithubRepo(input);
    toast("无法识别的 GitHub 地址：请输入仓库地址，例如 https://github.com/owner/repo", "error");
    return false;
  }
  if (normalizeWebUrl(input)) return addWebPage(input);
  toast("无法识别的链接：请输入 YouTube 视频链接、GitHub 仓库地址或网址", "error");
  return false;
}

async function addVideo(input: string): Promise<boolean> {
  const id = extractVideoId(input);
  if (!id) return false;
  if (state.videos.some((v) => v.id === id)) {
    toast("该视频已在收藏中");
    openDetail(id);
    return true;
  }
  if (!state.gemini.apiKey) {
    toast("请先配置 GEMINI_API_KEY", "error");
    openSettings();
    return false;
  }
  state.videos = [newVideo(id), ...state.videos];
  await persist(id);
  renderGrid();
  void cacheThumbnail(id);
  void processVideo(id);
  return true;
}

async function addGithubRepo(input: string): Promise<boolean> {
  const ref = parseGithubUrl(input);
  if (!ref) return false;
  const id = githubId(ref);
  if (state.videos.some((v) => v.id === id)) {
    toast("该仓库已在收藏中");
    openDetail(id);
    return true;
  }
  if (!state.gemini.apiKey) {
    toast("请先配置 GEMINI_API_KEY", "error");
    openSettings();
    return false;
  }
  state.videos = [newGithubRepo(ref), ...state.videos];
  await persist(id);
  renderGrid();
  void processGithub(id);
  return true;
}

/** Ask whether the page should also be saved as a PDF. Resolves to null when cancelled. */
function askWebOptions(url: string): Promise<{ pdf: boolean } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { pdf: boolean } | null) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      closeModal();
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    document.addEventListener("keydown", onKey, true);
    const pdf = h("input", { type: "checkbox", checked: true });
    const ok = h("button", { class: "primary", onclick: () => finish({ pdf: pdf.checked }) }, "收藏");
    modal(
      h(
        "div",
        { class: "modal settings web-options" },
        h("button", { class: "close", onclick: () => finish(null) }, "✕"),
        h("h2", {}, "收藏网页"),
        h("p", { class: "url-line" }, url),
        h(
          "label",
          { class: "check" },
          pdf,
          h("span", {}, "同时将网页内容保存为 PDF 文件", h("small", { class: "muted" }, "（在本机 Chrome / Edge / Firefox 中打开网页，可先登录再抓取文字和图片，保存在 数据目录/pdfs）")),
        ),
        h("div", { class: "row end" }, h("button", { class: "ghost", onclick: () => finish(null) }, "取消"), ok),
      ),
      () => finish(null),
    );
    ok.focus();
  });
}

async function addWebPage(input: string): Promise<boolean> {
  const url = normalizeWebUrl(input);
  if (!url) return false;
  const id = webId(url);
  if (state.videos.some((v) => v.id === id)) {
    toast("该网页已在收藏中");
    openDetail(id);
    return true;
  }
  if (!state.gemini.apiKey) {
    toast("请先配置 GEMINI_API_KEY", "error");
    openSettings();
    return false;
  }
  const opts = await askWebOptions(url);
  if (!opts) return false;
  if (state.videos.some((v) => v.id === id)) return true;
  state.videos = [newWebPage(url), ...state.videos];
  await persist(id);
  renderGrid();
  void cacheThumbnail(id);
  void processWeb(id);
  if (opts.pdf) void savePdf(id);
  return true;
}

/** Fetch the page, extract title / description / text, summarise it with Gemini and draw the cover. */
async function processWeb(id: string) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  updateVideo(id, { status: "processing", error: undefined });
  refresh(id);
  try {
    const page = decodePage(await backend.fetchWebPage(v.url));
    let info;
    if (page.isPdf) {
      // The link is a PDF file itself: use the file name, and make sure it gets saved.
      info = { url: v.url, title: pdfTitle(page.url || v.url), description: "", siteName: hostOf(v.url), image: "", publishedAt: "", text: "" };
      if (!state.videos.find((x) => x.id === id)?.localPdf) void savePdf(id);
    } else {
      info = parsePage(page.html, page.url || v.url);
      info.url = v.url;
    }
    updateVideo(id, {
      title: info.title,
      author: info.siteName,
      description: info.description,
      thumbnailUrl: info.image,
      publishedAt: info.publishedAt,
    });
    refresh(id);
    await persist(id);
    void cacheThumbnail(id);
    if (page.isPdf) {
      updateVideo(id, { status: "ready", summary: info.description, headline: "PDF 文档" });
    } else {
      const text = await gemini().generateText(buildPageSummaryPrompt(info));
      const { headline, summary } = normalizePageSummary(text, info);
      updateVideo(id, { headline, summary, status: "ready" });
    }
  } catch (e) {
    console.error(e);
    updateVideo(id, { status: "error", error: errMsg(e) });
    toast(`处理失败: ${errMsg(e)}`, "error");
  }
  await persist(id);
  refresh(id);
  void cacheThumbnail(id);
}

const pdfBusy = new Set<string>();

/** Save (or regenerate) the page as 数据目录/pdfs/<id>.pdf. */
async function savePdf(id: string) {
  const v = state.videos.find((x) => x.id === id);
  if (!v || pdfBusy.has(id)) return;
  pdfBusy.add(id);
  refresh(id);
  try {
    // Queue behind pending writes: the backend requires the row to exist.
    await dbQueue(async () => undefined);
    // Links that serve a PDF file are simply downloaded; web pages are captured
    // in the user's own browser (articles often need a login).
    const path = (await backend.downloadWebPdf(id, v.url)) ?? (await capturePdfInBrowser(id));
    if (path && state.videos.some((x) => x.id === id)) {
      state.videos = state.videos.map((x) => (x.id === id ? { ...x, localPdf: path } : x));
      pdfStamp.set(id, Date.now());
      toast(`已保存 PDF：${v.title || v.url}`);
      void cacheThumbnail(id); // cover shows a "PDF" marker
    }
  } catch (e) {
    console.error(e);
    toast(`PDF 保存失败: ${errMsg(e)}`, "error");
  } finally {
    pdfBusy.delete(id);
    refresh(id);
  }
}

const BROWSER_PREF_KEY = "pdfBrowser";

/**
 * Open the page in a local browser (Chrome / Edge / Firefox), let the user log in
 * and wait for the article, then capture it as PDF. Resolves to the saved file
 * path, or null when cancelled. Re-opens the detail view it was started from.
 */
function capturePdfInBrowser(id: string): Promise<string | null> {
  const v = state.videos.find((x) => x.id === id)!;
  const reopen = state.openId === id;
  return new Promise((resolve) => {
    let done = false;
    let opened = false;
    let working = false;
    const finish = (path: string | null) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      if (!path) void backend.closePdfBrowser().catch(() => undefined);
      closeModal();
      if (reopen && state.openId === id && state.videos.some((x) => x.id === id)) renderDetail();
      resolve(path);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working) finish(null);
    };
    document.addEventListener("keydown", onKey, true);

    const select = h("select", { disabled: true }, h("option", { value: "" }, "正在查找浏览器…"));
    const status = h("p", { class: "muted capture-status" }, "");
    const openBtn = h("button", { disabled: true }, "打开浏览器");
    const captureBtn = h("button", { class: "primary", disabled: true }, "抓取并保存 PDF");
    const setStatus = (text: string, error = false) => {
      status.textContent = text;
      status.classList.toggle("update-error", error);
    };
    const sync = () => {
      openBtn.disabled = working || select.options.length === 0 || !select.value;
      openBtn.textContent = opened ? "重新打开" : "打开浏览器";
      captureBtn.disabled = working || !opened;
      select.disabled = working || select.options.length === 0 || !select.value;
    };

    const open = async () => {
      working = true;
      sync();
      setStatus("正在启动浏览器…");
      try {
        localStorage.setItem(BROWSER_PREF_KEY, select.value);
        const name = await backend.openPdfBrowser(v.url, select.value || null);
        opened = true;
        setStatus(`已在 ${name} 中打开网页。如需登录请在该窗口中登录，等文章完整显示后点击「抓取并保存 PDF」。`);
      } catch (e) {
        setStatus(`无法打开浏览器：${errMsg(e)}`, true);
      } finally {
        working = false;
        sync();
      }
    };
    const capture = async () => {
      working = true;
      sync();
      setStatus("正在滚动页面加载图片并生成 PDF，请勿关闭浏览器…");
      try {
        finish(await backend.captureBrowserPdf(id));
      } catch (e) {
        setStatus(`抓取失败：${errMsg(e)}。可在浏览器中调整后重试。`, true);
        working = false;
        sync();
      }
    };
    openBtn.onclick = () => void open();
    captureBtn.onclick = () => void capture();

    modal(
      h(
        "div",
        { class: "modal settings pdf-capture" },
        h("button", { class: "close", onclick: () => !working && finish(null) }, "✕"),
        h("h2", {}, "保存网页为 PDF"),
        h("p", { class: "url-line" }, v.url),
        h(
          "p",
          { class: "muted" },
          "将在本机浏览器中打开该网页。若文章需要登录，请直接在打开的窗口中登录（该窗口使用本应用专用的浏览器配置，登录状态会保留，下次无需重复登录）。文章完整显示后回到这里点击「抓取并保存 PDF」，文字和图片会按浏览器中显示的样子保存。",
        ),
        h("label", {}, "浏览器", h("div", { class: "row" }, select, openBtn)),
        status,
        h(
          "div",
          { class: "row end" },
          h("button", { class: "ghost", onclick: () => !working && finish(null) }, "取消"),
          captureBtn,
        ),
      ),
      () => !working && finish(null),
    );

    void backend
      .listBrowsers()
      .then((list) => {
        if (done) return;
        select.replaceChildren(...list.map((b) => h("option", { value: b.id }, b.name)));
        if (!list.length) {
          select.append(h("option", { value: "" }, "未找到浏览器"));
          setStatus("未找到 Google Chrome / Microsoft Edge / Mozilla Firefox，请先安装其中之一。", true);
          sync();
          return;
        }
        const pref = localStorage.getItem(BROWSER_PREF_KEY);
        if (pref && list.some((b) => b.id === pref)) select.value = pref;
        sync();
        void open();
      })
      .catch((e) => setStatus(errMsg(e), true));
  });
}

const pdfStamp = new Map<string, number>();

function pdfSrc(v: Video): string | null {
  if (!v.localPdf) return null;
  const stamp = pdfStamp.get(v.id);
  return convertFileSrc(v.localPdf) + (stamp ? `?v=${stamp}` : "");
}

/** Fetch repo info + README, summarise it with Gemini and draw the cover. */
async function processGithub(id: string) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  const ref = parseGithubUrl(v.url);
  if (!ref) return;
  updateVideo(id, { status: "processing", error: undefined });
  refresh(id);
  try {
    const { repo, readme } = await backend.fetchGithubRepo(ref.owner, ref.repo);
    const info = normalizeRepoInfo(repo, ref);
    updateVideo(id, {
      title: info.fullName,
      author: info.owner,
      url: info.htmlUrl,
      description: info.description,
      language: info.language,
      stars: info.stars,
      publishedAt: info.pushedAt,
    });
    refresh(id);
    await persist(id);
    const text = await gemini().generateText(buildRepoSummaryPrompt(info, readme));
    const { headline, summary } = normalizeRepoSummary(text, info);
    updateVideo(id, { headline, summary, status: "ready" });
  } catch (e) {
    console.error(e);
    updateVideo(id, { status: "error", error: errMsg(e) });
    toast(`处理失败: ${errMsg(e)}`, "error");
  }
  await persist(id);
  refresh(id);
  // (Re)draw the cover with whatever we know now (headline falls back to the repo description).
  void cacheThumbnail(id);
}

async function processVideo(id: string, opts: { metadata?: boolean; transcript?: boolean } = {}) {
  const doMeta = opts.metadata ?? true;
  const doTranscript = opts.transcript ?? true;
  updateVideo(id, { status: "processing", error: undefined });
  refresh(id);
  try {
    const client = gemini();
    const tasks: Promise<void>[] = [];
    if (doMeta) {
      tasks.push(
        (async () => {
          const [meta, oembed] = await Promise.all([client.fetchMetadata(id), fetchOEmbed(id)]);
          updateVideo(id, {
            ...meta,
            title: oembed?.title || meta.title,
            author: oembed?.author || meta.author,
          });
          refresh(id);
          await persist(id);
          const cur = state.videos.find((x) => x.id === id);
          if (cur && !cur.localThumbnail) void cacheThumbnail(id);
        })(),
      );
    }
    if (doTranscript) {
      tasks.push(
        (async () => {
          const transcript = await client.fetchTranscript(id);
          updateVideo(id, { transcript });
          refresh(id);
          await persist(id);
        })(),
      );
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) throw failed[0].reason;
    updateVideo(id, { status: "ready" });
  } catch (e) {
    console.error(e);
    updateVideo(id, { status: "error", error: errMsg(e) });
    toast(`处理失败: ${errMsg(e)}`, "error");
  }
  await persist(id);
  refresh(id);
}

function refresh(id: string) {
  renderGrid();
  if (state.openId === id) renderDetail();
}

// ---------- detail page ----------

/** Show the full-page detail view for one item (replaces the home grid). */
function openDetail(id: string) {
  const home = document.querySelector<HTMLElement>("#home");
  const page = document.querySelector<HTMLElement>("#detail-page");
  if (!home || !page) return;
  state.openId = id;
  home.hidden = true;
  page.hidden = false;
  page.replaceChildren();
  window.scrollTo({ top: 0 });
  renderDetail(true);
}

/** Leave the detail page and return to the library grid. */
function goHome() {
  closeModal();
  const home = document.querySelector<HTMLElement>("#home");
  const page = document.querySelector<HTMLElement>("#detail-page");
  const wasOpen = state.openId !== null;
  state.openId = null;
  if (!home || !page) return;
  page.replaceChildren();
  page.hidden = true;
  home.hidden = false;
  if (wasOpen) window.scrollTo({ top: 0 });
}

/** Mount `el` as the content of the detail page. */
function mountPage(el: HTMLElement) {
  document.querySelector("#detail-page")?.replaceChildren(el);
}

/** The detail page element currently mounted for `kind`, if any. */
function currentPage(kind: string) {
  return document.querySelector<HTMLDivElement>(`#detail-page > .page.${kind}`);
}

function backButton() {
  return h("button", { class: "ghost back", onclick: goHome, title: "返回首页" }, "← 返回");
}

function closeModal() {
  document.querySelector(".modal-backdrop")?.remove();
}

function modal(content: HTMLElement, onClose = closeModal) {
  document.querySelector(".modal-backdrop")?.remove();
  const backdrop = h("div", { class: "modal-backdrop" }, content);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) onClose();
  });
  document.body.append(backdrop);
}

function renderTranscript(text: string, onSeek: (s: number) => void) {
  const box = h("div", { class: "transcript" });
  for (const line of parseTranscript(text)) {
    if (line.kind === "heading") box.append(h("h4", {}, line.text));
    else if (line.kind === "text") box.append(h("p", {}, line.text));
    else {
      const seconds = line.seconds;
      box.append(
        h(
          "div",
          { class: `t-item indent-${line.indent}` },
          line.stamp && seconds != null
            ? h("button", { class: "stamp", onclick: () => onSeek(seconds), title: "跳转到此处播放" }, `[${line.stamp}]`)
            : line.stamp
              ? h("span", { class: "stamp" }, `[${line.stamp}]`)
              : null,
          h("span", {}, line.text),
        ),
      );
    }
  }
  return box;
}

/** Re-render the detail page. `fresh` = (re)create the player; otherwise keep the playing iframe. */
function renderDetail(fresh = false) {
  const v = state.videos.find((x) => x.id === state.openId);
  if (!v) return goHome();
  if (kindOf(v) === "github") return renderGithubDetail(v);
  if (kindOf(v) === "web") return renderWebDetail(v);

  let pageEl = currentPage("video-detail");
  if (fresh || !pageEl || pageEl.dataset.id !== v.id) {
    const iframe = h("iframe", {
      src: embedUrl(v.id),
      title: v.title,
      allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
      referrerpolicy: "strict-origin-when-cross-origin",
      allowfullscreen: true,
    });
    pageEl = h(
      "div",
      { class: "page video-detail", "data-id": v.id },
      h("div", { class: "page-nav" }, backButton()),
      h("div", { class: "player" }, iframe),
      h("div", { class: "detail" }),
    );
    mountPage(pageEl);
  }
  const player = pageEl.querySelector("iframe")!;
  const detail = pageEl.querySelector<HTMLDivElement>(".detail")!;
  // Clicking a transcript timestamp scrolls back up to the player and plays from that moment.
  const seek = (s: number) => {
    player.src = embedUrl(v.id, s, true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async () => {
    if (!window.confirm(`确定删除「${v.title || v.id}」吗？`)) return;
    goHome();
    await removeVideo(v.id);
    renderGrid();
  };
  const busy = v.status === "processing";

  const transcriptSection = v.transcript
    ? renderTranscript(v.transcript, seek)
    : h("p", { class: "muted" }, busy ? "正在使用 Gemini 生成时间戳逐字稿…" : "暂无逐字稿");

  const copy = async () => {
    await navigator.clipboard.writeText(v.transcript);
    toast("已复制逐字稿");
  };

  detail.replaceChildren(
      h("h2", {}, v.title || v.url),
      h(
        "div",
        { class: "meta" },
        h("span", {}, `👤 ${v.author || "—"}`),
        h("span", {}, `📅 ${v.publishedAt || "—"}`),
        h("span", {}, `⏱ ${formatDuration(v.durationSeconds) || "—"}`),
        statusBadge(v),
      ),
      v.status === "error" && v.error ? h("div", { class: "warning" }, v.error) : "",
      h(
        "div",
        { class: "actions" },
        h("button", { onclick: () => openUrl(v.url) }, "在 YouTube 打开"),
        h("button", { onclick: () => processVideo(v.id, { transcript: false }), disabled: busy }, "刷新信息"),
        h("button", { onclick: () => processVideo(v.id, { metadata: false }), disabled: busy }, "重新生成逐字稿"),
        v.transcript ? h("button", { onclick: copy }, "复制逐字稿") : null,
        h("button", { class: "danger", onclick: remove }, "删除"),
      ),
      h("details", { class: "description", open: !v.transcript }, h("summary", {}, "视频介绍"), h("pre", {}, v.description || "—")),
      h("h3", {}, "时间戳逐字稿"),
      transcriptSection,
  );
}

function renderGithubDetail(v: Video) {
  let pageEl = currentPage("github-detail");
  if (!pageEl || pageEl.dataset.id !== v.id) {
    pageEl = h(
      "div",
      { class: "page github-detail", "data-id": v.id },
      h("div", { class: "page-nav" }, backButton()),
      h("div", { class: "repo-cover" }),
      h("div", { class: "detail" }),
    );
    mountPage(pageEl);
  }
  const src = coverSrc(v);
  pageEl
    .querySelector(".repo-cover")!
    .replaceChildren(
      src ? h("img", { src, alt: v.title }) : h("div", { class: "cover-placeholder" }, "封面生成中…"),
    );
  const busy = v.status === "processing";
  const remove = async () => {
    if (!window.confirm(`确定删除「${v.title || v.id}」吗？`)) return;
    goHome();
    await removeVideo(v.id);
    renderGrid();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(v.summary ?? "");
    toast("已复制摘要");
  };
  pageEl.querySelector(".detail")!.replaceChildren(
    h("h2", {}, v.title || v.url),
    v.headline ? h("p", { class: "repo-headline" }, v.headline) : "",
    h(
      "div",
      { class: "meta" },
      h("span", {}, `👤 ${v.author || "—"}`),
      v.language ? h("span", {}, `💻 ${v.language}`) : null,
      v.stars != null ? h("span", {}, `★ ${formatStars(v.stars)}`) : null,
      v.publishedAt ? h("span", { title: "最近推送" }, `📅 ${v.publishedAt}`) : null,
      statusBadge(v),
    ),
    v.status === "error" && v.error ? h("div", { class: "warning" }, v.error) : "",
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => openUrl(v.url) }, "在 GitHub 打开"),
      h("button", { onclick: () => processGithub(v.id), disabled: busy }, "重新生成摘要"),
      h("button", { onclick: () => cacheThumbnail(v.id), disabled: busy }, "重新生成封面"),
      v.summary ? h("button", { onclick: copy }, "复制摘要") : null,
      h("button", { class: "danger", onclick: remove }, "删除"),
    ),
    v.description ? h("details", { class: "description", open: true }, h("summary", {}, "仓库简介"), h("pre", {}, v.description)) : "",
    h("h3", {}, "README 摘要"),
    v.summary
      ? h("div", { class: "repo-summary" }, v.summary)
      : h("p", { class: "muted" }, busy ? "正在读取 README 并使用 Gemini 生成摘要…" : "暂无摘要"),
  );
}

function renderWebDetail(v: Video) {
  let pageEl = currentPage("web-detail");
  if (!pageEl || pageEl.dataset.id !== v.id) {
    pageEl = h(
      "div",
      { class: "page web-detail", "data-id": v.id },
      h("div", { class: "page-nav" }, backButton()),
      h("div", { class: "repo-cover" }),
      h("div", { class: "detail" }),
      h("div", { class: "pdf-section" }),
    );
    mountPage(pageEl);
  }
  const src = coverSrc(v);
  pageEl
    .querySelector(".repo-cover")!
    .replaceChildren(src ? h("img", { src, alt: v.title }) : h("div", { class: "cover-placeholder" }, "封面生成中…"));
  const busy = v.status === "processing";
  const pdfWorking = pdfBusy.has(v.id);
  const remove = async () => {
    if (!window.confirm(`确定删除「${v.title || v.id}」吗？${v.localPdf ? "\n已保存的 PDF 文件也会一并删除。" : ""}`)) return;
    goHome();
    await removeVideo(v.id);
    renderGrid();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(v.summary ?? "");
    toast("已复制摘要");
  };
  const openPdf = () => backend.openPdf(v.id).catch((e) => toast(errMsg(e), "error"));
  pageEl.querySelector(".detail")!.replaceChildren(
    h("h2", {}, v.title || v.url),
    v.headline ? h("p", { class: "repo-headline" }, v.headline) : "",
    h(
      "div",
      { class: "meta" },
      h("span", {}, `🌐 ${v.author || hostOf(v.url)}`),
      v.publishedAt ? h("span", {}, `📅 ${v.publishedAt}`) : null,
      h("span", { class: "url-line", title: v.url }, v.url),
      statusBadge(v),
    ),
    v.status === "error" && v.error ? h("div", { class: "warning" }, v.error) : "",
    h(
      "div",
      { class: "actions" },
      h("button", { onclick: () => openUrl(v.url) }, "在浏览器打开"),
      h("button", { onclick: () => processWeb(v.id), disabled: busy }, "重新生成摘要"),
      h("button", { onclick: () => cacheThumbnail(v.id), disabled: busy }, "重新生成封面"),
      h(
        "button",
        { onclick: () => savePdf(v.id), disabled: pdfWorking },
        pdfWorking ? "正在生成 PDF…" : v.localPdf ? "重新生成 PDF" : "保存为 PDF",
      ),
      v.localPdf ? h("button", { onclick: openPdf }, "打开 PDF") : null,
      v.summary ? h("button", { onclick: copy }, "复制摘要") : null,
      h("button", { class: "danger", onclick: remove }, "删除"),
    ),
    v.description ? h("details", { class: "description", open: true }, h("summary", {}, "网页简介"), h("pre", {}, v.description)) : "",
    h("h3", {}, "网页介绍"),
    v.summary
      ? h("div", { class: "repo-summary" }, v.summary)
      : h("p", { class: "muted" }, busy ? "正在读取网页并使用 Gemini 生成介绍…" : "暂无介绍"),
  );
  // Keep the embedded PDF viewer alive across re-renders unless the file changed.
  const section = pageEl.querySelector<HTMLDivElement>(".pdf-section")!;
  const pdf = pdfSrc(v);
  if (section.dataset.src === (pdf ?? "") && section.dataset.busy === String(pdfWorking)) return;
  section.dataset.src = pdf ?? "";
  section.dataset.busy = String(pdfWorking);
  section.replaceChildren(
    h("h3", {}, "PDF 文件"),
    pdf
      ? h("iframe", { class: "pdf-frame", src: pdf, title: `${v.title} (PDF)` })
      : h("p", { class: "muted" }, pdfWorking ? "正在通过本机浏览器将网页保存为 PDF…" : "尚未保存 PDF。点击上方「保存为 PDF」即可将网页内容保存为 PDF 文件。"),
  );
}

// ---------- updates ----------

async function checkForUpdate(opts: { silent?: boolean } = {}) {
  if (state.update.checking) return;
  state.update.checking = true;
  state.update.error = null;
  renderUpdateSection();
  try {
    if (!state.appVersion) state.appVersion = await getVersion();
    const raw = await backend.fetchLatestRelease();
    state.update.result = evaluateUpdate(state.appVersion, raw);
    state.update.checkedAt = new Date();
    if (!opts.silent && !state.update.result.hasUpdate) toast("当前已是最新版本");
  } catch (e) {
    state.update.error = errMsg(e);
    if (!opts.silent) toast(state.update.error, "error");
  } finally {
    state.update.checking = false;
    renderUpdateSection();
    renderUpdateDot();
  }
}

async function installUpdate() {
  const r = state.update.result;
  if (!r?.hasUpdate || !r.latest || state.update.installing) return;
  if (!r.installer) {
    void openUrl(r.latest.url).catch(() => {});
    return;
  }
  if (!window.confirm(`下载并安装 ${r.latest.tag}？\n安装程序启动后应用将自动退出。`)) return;
  state.update.installing = true;
  renderUpdateSection();
  try {
    await backend.installUpdate(r.installer.url);
    toast("安装程序已启动，应用即将退出…");
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    state.update.installing = false;
    renderUpdateSection();
  }
}

function formatSize(bytes: number) {
  return bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "";
}

/** (Re)render the 版本与更新 block inside the settings modal, if it is open. */
function renderUpdateSection() {
  const box = document.querySelector<HTMLDivElement>("#update-section");
  if (!box) return;
  const u = state.update;
  const r = u.result;
  let status: Node;
  if (u.checking) status = h("p", { class: "muted" }, "正在检查更新…");
  else if (u.error) status = h("p", { class: "update-error" }, `检查更新失败：${u.error}`);
  else if (!r) status = h("p", { class: "muted" }, "尚未检查更新");
  else if (!r.latest) status = h("p", { class: "muted" }, "GitHub 上暂无已发布的版本");
  else if (!r.hasUpdate) status = h("p", { class: "muted" }, `当前已是最新版本（最新发布：${r.latest.tag}）`);
  else {
    const l = r.latest;
    status = h(
      "div",
      { class: "update-info" },
      h("p", {}, h("strong", {}, `发现新版本 ${l.tag}`), l.name !== l.tag ? `（${l.name}）` : "",
        l.publishedAt ? h("span", { class: "muted" }, ` · 发布于 ${new Date(l.publishedAt).toLocaleDateString()}`) : ""),
      l.notes.trim() ? h("details", {}, h("summary", {}, "更新说明"), h("pre", {}, l.notes.trim())) : null,
      r.installer
        ? h("p", { class: "muted" }, `安装包：${r.installer.name} ${formatSize(r.installer.size)}`)
        : h("p", { class: "muted" }, "该版本未提供 Windows 安装包，可前往发布页面手动下载。"),
    );
  }
  const actions = h(
    "div",
    { class: "row end" },
    h("button", { class: "ghost", onclick: () => openUrl(r?.latest?.url ?? RELEASES_URL).catch(() => {}) }, "发布页面"),
    h("button", { onclick: () => void checkForUpdate(), disabled: u.checking || u.installing }, u.checking ? "检查中…" : "检查升级"),
    r?.hasUpdate
      ? h(
          "button",
          { class: "primary", onclick: () => void installUpdate(), disabled: u.installing },
          u.installing ? "正在下载…" : r.installer ? "安装更新" : "前往下载",
        )
      : null,
  );
  box.replaceChildren(
    h("p", {}, `当前版本：v${state.appVersion || "?"}`,
      u.checkedAt ? h("span", { class: "muted" }, ` · 上次检查：${u.checkedAt.toLocaleTimeString()}`) : ""),
    status,
    actions,
  );
}

// ---------- settings ----------

function openSettings() {
  const key = h("input", { type: "password", value: state.gemini.apiKey ?? "", placeholder: "GEMINI_API_KEY" });
  const model = h("input", { type: "text", value: state.gemini.model ?? "", placeholder: DEFAULT_MODEL });
  const save = async () => {
    try {
      state.gemini = await backend.saveGeminiConfig(key.value, model.value);
      toast("已保存到 数据目录/conf.json");
      closeModal();
      renderMain();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  modal(
    h(
      "div",
      { class: "modal settings" },
      h("button", { class: "close", onclick: closeModal }, "✕"),
      h("h2", {}, "设置"),
      h("h3", {}, "数据目录"),
      h("div", { class: "row" }, h("code", {}, state.dataDir ?? ""), h("button", { onclick: () => { closeModal(); void renderSetup(true); } }, "更改…"),
        h("button", { onclick: () => state.dataDir && openUrl(state.dataDir).catch(() => {}) }, "打开")),
      h("h3", {}, "Gemini"),
      h("p", { class: "muted" }, `当前配置来源：${state.gemini.source ?? "未找到"}`),
      h("label", {}, "GEMINI_API_KEY", key),
      h("label", {}, "GEMINI_API_MODEL", model),
      h("div", { class: "row end" }, h("button", { class: "ghost", onclick: closeModal }, "取消"), h("button", { class: "primary", onclick: save }, "保存到数据目录 conf.json")),
      h("h3", {}, "版本与更新"),
      h("div", { id: "update-section" }),
    ),
  );
  renderUpdateSection();
  // Check automatically when opening settings (unless checked in the last 10 minutes).
  const stale = !state.update.checkedAt || Date.now() - state.update.checkedAt.getTime() > 10 * 60 * 1000;
  if (stale) void checkForUpdate({ silent: true });
}

// ---------- boot ----------

async function boot() {
  try {
    const settings = await backend.getSettings();
    state.dataDir = settings.dataDir;
    if (!state.dataDir) return renderSetup();
    state.gemini = await backend.loadGeminiConfig();
    const raw = await backend.loadLibrary();
    state.videos = recoverInterrupted(raw);
    renderMain();
    // Persist recovered entries, and download covers that aren't stored locally yet (e.g. migrated library.json data).
    raw.filter((v) => v.status === "processing").forEach((v) => void persist(v.id));
    state.videos.filter((v) => !v.localThumbnail).forEach((v) => void cacheThumbnail(v.id));
    // Quietly look for a new release in the background.
    if (!state.update.checkedAt) void checkForUpdate({ silent: true });
  } catch (e) {
    app.replaceChildren(
      h("div", { class: "setup" }, h("h1", {}, "启动失败"), h("p", {}, errMsg(e)), h("button", { onclick: () => renderSetup(true) }, "重新选择数据目录")),
    );
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".modal-backdrop")) closeModal();
  else if (state.openId) goHome();
});

void boot();
