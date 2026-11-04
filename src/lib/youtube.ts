const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract the 11-char YouTube video id from any common URL form (or a bare id). */
export function extractVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "").toLowerCase();
  let candidate: string | null = null;

  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      candidate = url.searchParams.get("v");
    } else {
      const m = url.pathname.match(/^\/(embed|shorts|live|v|e)\/([^/?#]+)/);
      if (m) candidate = m[2];
    }
  }
  return candidate && ID_RE.test(candidate) ? candidate : null;
}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export const thumbnailUrl = (id: string, quality: "hq" | "maxres" | "mq" = "hq") =>
  `https://i.ytimg.com/vi/${id}/${quality}default.jpg`;

export function embedUrl(id: string, startSeconds = 0, autoplay = false): string {
  const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  if (startSeconds > 0) params.set("start", String(Math.floor(startSeconds)));
  if (autoplay) params.set("autoplay", "1");
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}
