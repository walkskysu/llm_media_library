import { invoke } from "@tauri-apps/api/core";
import type { GeminiConfig, Settings, Video } from "./types";
import type { RawPage } from "./web";

export const backend = {
  getSettings: () => invoke<Settings>("get_settings"),
  setDataDir: (path: string) => invoke<Settings>("set_data_dir", { path }),
  loadLibrary: () => invoke<Video[]>("load_library"),
  saveVideo: (video: Video) => invoke<void>("save_video", { video }),
  deleteVideo: (id: string) => invoke<void>("delete_video", { id }),
  /** Download the cover into the data directory; resolves to the local file path. */
  cacheThumbnail: (id: string, urls: string[]) => invoke<string>("cache_thumbnail", { id, urls }),
  /** Store a frontend-generated cover (PNG bytes); resolves to the local file path. */
  storeCover: (id: string, bytes: Uint8Array) => invoke<string>("store_cover", { id, bytes: Array.from(bytes) }),
  /** Public GitHub repo API JSON + raw README text (empty if the repo has none). */
  fetchGithubRepo: (owner: string, repo: string) =>
    invoke<{ repo: unknown; readme: string }>("fetch_github_repo", { owner, repo }),
  /** Raw page bytes (base64) + final URL / content type; decode with `decodePage`. */
  fetchWebPage: (url: string) => invoke<RawPage>("fetch_web_page", { url }),
  /** Save the page as 数据目录/pdfs/<id>.pdf (headless Edge/Chrome); resolves to the local file path. */
  saveWebPdf: (id: string, url: string) => invoke<string>("save_web_pdf", { id, url }),
  /** Open the saved PDF with the system viewer. */
  openPdf: (id: string) => invoke<void>("open_pdf", { id }),
  loadGeminiConfig: () => invoke<GeminiConfig>("load_gemini_config"),
  saveGeminiConfig: (apiKey: string, model: string) =>
    invoke<GeminiConfig>("save_gemini_config", { apiKey, model }),
  /** Raw GitHub API JSON of the latest published release, or null if none. */
  fetchLatestRelease: () => invoke<unknown | null>("fetch_latest_release"),
  /** Download the installer, launch it and quit the app; resolves to the downloaded file path. */
  installUpdate: (url: string) => invoke<string>("install_update", { url }),
};
