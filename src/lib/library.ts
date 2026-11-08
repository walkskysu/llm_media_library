import { githubId, repoUrl, type RepoRef } from "./github";
import type { MediaKind, Video } from "./types";
import { thumbnailUrl, watchUrl } from "./youtube";

export const kindOf = (v: Pick<Video, "kind">): MediaKind => v.kind ?? "youtube";

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
    kind: "youtube",
  };
}

export function newGithubRepo(ref: RepoRef, now = new Date()): Video {
  const ts = now.toISOString();
  return {
    id: githubId(ref),
    url: repoUrl(ref),
    title: `${ref.owner}/${ref.repo}`,
    author: ref.owner,
    publishedAt: "",
    durationSeconds: null,
    description: "",
    thumbnailUrl: "",
    transcript: "",
    status: "processing",
    addedAt: ts,
    updatedAt: ts,
    kind: "github",
    summary: "",
    headline: "",
    stars: null,
    language: "",
  };
}

/** Home page tab: everything, or one kind. */
export type KindFilter = "all" | MediaKind;

export function filterByKind(videos: Video[], kind: KindFilter): Video[] {
  return kind === "all" ? videos : videos.filter((v) => kindOf(v) === kind);
}

export function countByKind(videos: Video[]): Record<KindFilter, number> {
  const counts = { all: videos.length, youtube: 0, github: 0 };
  for (const v of videos) counts[kindOf(v)]++;
  return counts;
}

/** Newest first. */
export function sortVideos(videos: Video[]): Video[] {
  return [...videos].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export function filterVideos(videos: Video[], query: string): Video[] {
  const q = query.trim().toLowerCase();
  if (!q) return videos;
  return videos.filter((v) =>
    [v.title, v.author, v.description, v.transcript, v.summary, v.headline, v.language].some((f) =>
      f?.toLowerCase().includes(q),
    ),
  );
}

/** Videos left in "processing" when the app closed can never finish; mark them as failed so they can be retried. */
export function recoverInterrupted(videos: Video[]): Video[] {
  return videos.map((v) =>
    v.status === "processing" ? { ...v, status: "error", error: "处理被中断，请点击重试" } : v,
  );
}

/** Cover URLs to try (in order) when caching a video's cover image locally. */
export function thumbnailCandidates(v: Pick<Video, "id" | "thumbnailUrl">): string[] {
  const urls = [v.thumbnailUrl, thumbnailUrl(v.id, "maxres"), thumbnailUrl(v.id, "hq")];
  return [...new Set(urls.filter((u) => u.startsWith("https://")))];
}

/** Serialises async tasks so writes reach the database in the order they were issued. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
