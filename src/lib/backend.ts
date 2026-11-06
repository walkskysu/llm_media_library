import { invoke } from "@tauri-apps/api/core";
import type { GeminiConfig, Settings, Video } from "./types";

export const backend = {
  getSettings: () => invoke<Settings>("get_settings"),
  setDataDir: (path: string) => invoke<Settings>("set_data_dir", { path }),
  loadLibrary: () => invoke<Video[]>("load_library"),
  saveVideo: (video: Video) => invoke<void>("save_video", { video }),
  deleteVideo: (id: string) => invoke<void>("delete_video", { id }),
  /** Download the cover into the data directory; resolves to the local file path. */
  cacheThumbnail: (id: string, urls: string[]) => invoke<string>("cache_thumbnail", { id, urls }),
  loadGeminiConfig: () => invoke<GeminiConfig>("load_gemini_config"),
  saveGeminiConfig: (apiKey: string, model: string) =>
    invoke<GeminiConfig>("save_gemini_config", { apiKey, model }),
  /** Raw GitHub API JSON of the latest published release, or null if none. */
  fetchLatestRelease: () => invoke<unknown | null>("fetch_latest_release"),
  /** Download the installer, launch it and quit the app; resolves to the downloaded file path. */
  installUpdate: (url: string) => invoke<string>("install_update", { url }),
};
