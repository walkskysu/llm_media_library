import { invoke } from "@tauri-apps/api/core";
import type { GeminiConfig, Settings, Video } from "./types";
import type { RawPage } from "./web";

export interface BrowserInfo {
  id: string;
  name: string;
  path: string;
}

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
  /** If the URL serves a PDF itself, save it to 数据目录/pdfs/<id>.pdf; null = regular web page. */
  downloadWebPdf: (id: string, url: string) => invoke<string | null>("download_web_pdf", { id, url }),
  /** Installed browsers usable for saving pages as PDF (Chrome / Edge / Firefox). */
  listBrowsers: () => invoke<BrowserInfo[]>("list_browsers"),
  /** Open the page in a visible local browser window (so the user can log in); resolves to the browser name. */
  openPdfBrowser: (url: string, browser: string | null) => invoke<string>("open_pdf_browser", { url, browser }),
  /** Print the page shown in that browser to 数据目录/pdfs/<id>.pdf and close it; resolves to the file path. */
  captureBrowserPdf: (id: string) => invoke<string>("capture_browser_pdf", { id }),
  /** Close the browser opened by openPdfBrowser. */
  closePdfBrowser: () => invoke<void>("close_pdf_browser"),
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
