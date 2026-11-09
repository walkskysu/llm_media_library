export type VideoStatus = "processing" | "ready" | "error";

/** What a library entry bookmarks. Entries saved before GitHub support have no kind (= youtube). */
export type MediaKind = "youtube" | "github" | "web";

export interface Video {
  id: string; // YouTube video id
  url: string;
  title: string;
  author: string;
  publishedAt: string; // YYYY-MM-DD when known
  durationSeconds: number | null;
  description: string;
  thumbnailUrl: string;
  transcript: string;
  status: VideoStatus;
  error?: string;
  addedAt: string; // ISO timestamp
  updatedAt: string;
  /** Absolute path of the cover image cached in 数据目录/thumbnails (managed by the backend). */
  localThumbnail?: string;
  /** Absolute path of the saved PDF (数据目录/pdfs; web pages only, managed by the backend). */
  localPdf?: string;
  kind?: MediaKind;
  // --- GitHub repositories & web pages ---
  /** Gemini summary of the README / page (Markdown-ish plain text). */
  summary?: string;
  /** One-line feature headline / page gist, rendered on the generated cover. */
  headline?: string;
  stars?: number | null;
  language?: string;
}

export interface VideoMetadata {
  title: string;
  author: string;
  publishedAt: string;
  durationSeconds: number | null;
  description: string;
  thumbnailUrl: string;
}

export interface GeminiConfig {
  apiKey: string | null;
  model: string | null;
  source: string | null;
}

export interface Settings {
  dataDir: string | null;
}
