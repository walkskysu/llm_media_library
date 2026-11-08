import { formatStars, wrapText } from "./github";

export interface CoverInput {
  owner: string;
  name: string;
  headline: string;
  language?: string;
  stars?: number | null;
}

export const COVER_WIDTH = 1280;
export const COVER_HEIGHT = 720;

const FONT = `"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif`;

/** Deterministic hue from the repo name so each repo gets its own (stable) colour scheme. */
export function coverHue(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

/** Largest font size (from `sizes`) whose wrapped text fits in `maxLines`. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number, sizes: number[], weight: string, maxLines: number) {
  for (const size of sizes) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = wrapText(text, width, (s) => ctx.measureText(s).width);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  ctx.font = `${weight} ${size}px ${FONT}`;
  return { size, lines: wrapText(text, width, (s) => ctx.measureText(s).width, maxLines) };
}

/** Draw a 1280×720 cover with the repo name and a feature headline; returns PNG bytes. */
export async function renderGithubCover(input: CoverInput): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  const W = COVER_WIDTH;
  const H = COVER_HEIGHT;
  const pad = 88;
  const hue = coverHue(`${input.owner}/${input.name}`.toLowerCase());

  // Background: dark diagonal gradient + soft glow.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, `hsl(${hue} 45% 14%)`);
  bg.addColorStop(1, `hsl(${(hue + 50) % 360} 55% 24%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, H * 0.15, 0, W * 0.85, H * 0.15, W * 0.6);
  glow.addColorStop(0, `hsla(${(hue + 30) % 360} 80% 60% / 0.35)`);
  glow.addColorStop(1, "hsla(0 0% 0% / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Top label.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText(`GitHub  ·  ${input.owner}`, pad, pad + 20);

  // Repo name.
  const name = fit(ctx, input.name, W - pad * 2, [104, 92, 80, 68, 56], "800", 2);
  ctx.fillStyle = "#ffffff";
  let y = 250;
  for (const line of name.lines) {
    ctx.fillText(line, pad, y);
    y += name.size * 1.12;
  }

  // Accent bar.
  y += 6;
  ctx.fillStyle = `hsl(${(hue + 30) % 360} 85% 62%)`;
  ctx.fillRect(pad, y - 18, 96, 8);
  y += 42;

  // Headline.
  if (input.headline.trim()) {
    const head = fit(ctx, input.headline, W - pad * 2, [52, 46, 40, 34], "600", 3);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    for (const line of head.lines) {
      ctx.fillText(line, pad, y + head.size * 0.4);
      y += head.size * 1.35;
    }
  }

  // Footer: language + stars.
  const footer = [input.language, input.stars != null ? `★ ${formatStars(input.stars)}` : ""].filter(Boolean).join("   ·   ");
  if (footer) {
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(footer, pad, H - pad + 10);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("封面生成失败");
  return new Uint8Array(await blob.arrayBuffer());
}
