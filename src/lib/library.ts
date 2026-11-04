import type { Video } from "./types";
import { thumbnailUrl, watchUrl } from "./youtube";

export function newVideo(id: string, now = new Date()): Video {
  const ts = now.toISOString();
  return {
    id,
    url: watchUrl(id),
    title: "",
    author: "",
    publishedAt: "",
    durationSeconds: null,
    description: "",
    thumbnailUrl: thumbnailUrl(id),
    transcript: "",
    status: "processing",
    addedAt: ts,
    updatedAt: ts,
  };
}

/** Newest first. */
export function sortVideos(videos: Video[]): Video[] {
  return [...videos].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export function filterVideos(videos: Video[], query: string): Video[] {
  const q = query.trim().toLowerCase();
  if (!q) return videos;
  return videos.filter((v) =>
    [v.title, v.author, v.description, v.transcript].some((f) => f.toLowerCase().includes(q)),
  );
}

/** Videos left in "processing" when the app closed can never finish; mark them as failed so they can be retried. */
export function recoverInterrupted(videos: Video[]): Video[] {
  return videos.map((v) =>
    v.status === "processing" ? { ...v, status: "error", error: "处理被中断，请点击重试" } : v,
  );
}
