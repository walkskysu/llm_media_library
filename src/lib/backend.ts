import { invoke } from "@tauri-apps/api/core";
import type { GeminiConfig, Settings, Video } from "./types";

export const backend = {
  getSettings: () => invoke<Settings>("get_settings"),
  setDataDir: (path: string) => invoke<Settings>("set_data_dir", { path }),
  loadLibrary: () => invoke<Video[]>("load_library"),
  saveLibrary: (videos: Video[]) => invoke<void>("save_library", { videos }),
  loadGeminiConfig: () => invoke<GeminiConfig>("load_gemini_config"),
  saveGeminiConfig: (apiKey: string, model: string) =>
    invoke<GeminiConfig>("save_gemini_config", { apiKey, model }),
};
