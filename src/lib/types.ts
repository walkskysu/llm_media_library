export type VideoStatus = "processing" | "ready" | "error";

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
