import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { documentDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { backend } from "./lib/backend";
import { DEFAULT_MODEL, fetchOEmbed, GeminiClient } from "./lib/gemini";
import { createQueue, filterVideos, newVideo, recoverInterrupted, sortVideos, thumbnailCandidates } from "./lib/library";
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
    // Queue behind pending writes: the backend requires the row to exist.
    const path = await dbQueue(() => backend.cacheThumbnail(id, thumbnailCandidates(v)));
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

function card(v: Video) {
  const src = coverSrc(v);
  const img = src
    ? h("img", { src, alt: v.title, loading: "lazy" })
    : h("div", { class: "cover-placeholder" }, "封面下载中…");
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
      statusBadge(v),
    ),
    h(
      "div",
      { class: "card-body" },
      h("h3", { class: "title", title: v.title }, v.title || v.url),
      h(
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
  const list = filterVideos(sortVideos(state.videos), state.query);
  if (state.videos.length === 0) {
    grid.replaceChildren(h("div", { class: "empty" }, "还没有收藏的视频。在上方输入 YouTube 链接开始收藏吧！"));
  } else if (list.length === 0) {
    grid.replaceChildren(h("div", { class: "empty" }, "没有匹配的视频"));
  } else {
    grid.replaceChildren(...list.map(card));
  }
  const count = document.querySelector("#count");
  if (count) count.textContent = `${state.videos.length} 个视频`;
}

function renderMain() {
  const urlInput = h("input", {
    type: "text",
    id: "url-input",
    placeholder: "粘贴 YouTube 视频链接，例如 https://www.youtube.com/watch?v=…",
  });
  const submit = async (e: Event) => {
    e.preventDefault();
    if (await addVideo(urlInput.value)) urlInput.value = "";
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
      h("div", { class: "brand" }, "🎬 LLM Media Library"),
      h("form", { class: "add-form", onsubmit: submit }, urlInput, h("button", { class: "primary", type: "submit" }, "收藏")),
      h("button", { class: "ghost", id: "settings-btn", onclick: openSettings, title: "设置" }, "⚙ 设置"),
    ),
    !state.gemini.apiKey
      ? h(
          "div",
          { class: "warning" },
          "未找到 GEMINI_API_KEY。请在 数据目录/conf.json 中配置，或点击右上角 设置 填写。",
        )
      : "",
    h("div", { class: "toolbar" }, h("span", { id: "count" }), search),
    h("main", { id: "grid", class: "grid" }),
  );
  renderGrid();
  renderUpdateDot();
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

async function addVideo(input: string): Promise<boolean> {
  const id = extractVideoId(input);
  if (!id) {
    toast("无法识别的 YouTube 链接", "error");
    return false;
  }
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

// ---------- detail modal ----------

function openDetail(id: string) {
  state.openId = id;
  renderDetail(true);
}

function closeModal() {
  state.openId = null;
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

/** Re-render the detail modal. `fresh` = (re)create the player; otherwise keep the playing iframe. */
function renderDetail(fresh = false) {
  const v = state.videos.find((x) => x.id === state.openId);
  if (!v) return closeModal();

  let modalEl = document.querySelector<HTMLDivElement>(".modal.video-detail");
  if (fresh || !modalEl || modalEl.dataset.id !== v.id) {
    const iframe = h("iframe", {
      src: embedUrl(v.id),
      title: v.title,
      allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
      referrerpolicy: "strict-origin-when-cross-origin",
      allowfullscreen: true,
    });
    modalEl = h(
      "div",
      { class: "modal video-detail", "data-id": v.id },
      h("button", { class: "close", onclick: closeModal, title: "关闭" }, "✕"),
      h("div", { class: "player" }, iframe),
      h("div", { class: "detail" }),
    );
    modal(modalEl);
  }
  const player = modalEl.querySelector("iframe")!;
  const detail = modalEl.querySelector<HTMLDivElement>(".detail")!;
  const seek = (s: number) => {
    player.src = embedUrl(v.id, s, true);
  };

  const remove = async () => {
    if (!window.confirm(`确定删除「${v.title || v.id}」吗？`)) return;
    closeModal();
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
  state.openId = null;
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
  if (e.key === "Escape") closeModal();
});

void boot();
