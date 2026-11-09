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

/** Colour scheme of a cover: background gradient, corner glow and accent bar (CSS colours). */
export interface CoverPalette {
  bgFrom: string;
  bgTo: string;
  glow: string;
  accent: string;
}

/**
 * Base schemes as [hue, hue shift of the gradient end, glow/accent hue shift].
 * Spread over the whole wheel (and with both warm→cool and cool→warm pairs)
 * so covers don't all end up in one colour family.
 */
const PALETTE_BASES: Array<[number, number, number]> = [
  [0, 25, 35], // red → orange
  [20, -30, 40], // orange → magenta
  [38, 20, -30], // amber
  [55, -60, 150], // olive / gold with blue glow
  [95, 60, 120], // lime → teal
  [140, 40, -90], // green with orange glow
  [170, 30, 60], // teal → sky
  [195, 30, -170], // cyan with coral glow
  [215, 40, 30], // blue → indigo
  [235, -40, 160], // indigo → cyan, amber accent
  [260, 40, 60], // violet → purple
  [285, -50, 120], // purple → blue, lime accent
  [310, 40, 40], // magenta → rose
  [330, 30, -150], // pink with teal glow
  [350, -150, 45], // crimson → navy
];

const wrap = (h: number) => ((Math.round(h) % 360) + 360) % 360;

/**
 * A random cover colour scheme. Picks one of the base schemes, then jitters hue,
 * saturation and lightness so even the same base looks a bit different each time.
 * Every call (e.g. "重新生成封面") gives a new palette.
 */
export function randomCoverPalette(rand: () => number = Math.random): CoverPalette {
  const [base, shift, accentShift] = PALETTE_BASES[Math.floor(rand() * PALETTE_BASES.length) % PALETTE_BASES.length];
  const jitter = (range: number) => (rand() * 2 - 1) * range;
  const hue = wrap(base + jitter(12));
  const hue2 = wrap(hue + shift + jitter(10));
  const accentHue = wrap(hue + accentShift + jitter(10));
  const sat = Math.round(40 + rand() * 25);
  const light = Math.round(12 + rand() * 6);
  return {
    bgFrom: `hsl(${hue} ${sat}% ${light}%)`,
    bgTo: `hsl(${hue2} ${Math.min(80, sat + 10)}% ${light + 10}%)`,
    glow: `hsla(${accentHue} 80% 60% / 0.35)`,
    accent: `hsl(${accentHue} 85% 62%)`,
  };
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

/** Generic cover layout: small top label, big title, accent bar, headline, footer line. */
export interface CoverLayout {
  label: string;
  title: string;
  headline: string;
  footer: string;
  /** Colour scheme; a random one is picked when omitted. */
  palette?: CoverPalette;
  /** Font sizes to try for the title, largest first. */
  titleSizes: number[];
  titleLines: number;
}

/** Draw a 1280×720 cover with the repo name and a feature headline; returns PNG bytes. */
export function renderGithubCover(input: CoverInput): Promise<Uint8Array> {
  return renderCover({
    label: `GitHub  ·  ${input.owner}`,
    title: input.name,
    headline: input.headline,
    footer: [input.language, input.stars != null ? `★ ${formatStars(input.stars)}` : ""].filter(Boolean).join("   ·   "),
    titleSizes: [104, 92, 80, 68, 56],
    titleLines: 2,
  });
}

/** Cover for a bookmarked web page: the page title is the main content. */
export function renderWebCover(input: { title: string; site: string; headline: string; host: string; hasPdf?: boolean }) {
  return renderCover({
    label: `网页  ·  ${input.site || input.host}`,
    title: input.title,
    headline: input.headline,
    footer: [input.host, input.hasPdf ? "PDF" : ""].filter(Boolean).join("   ·   "),
    titleSizes: [84, 74, 64, 56, 48],
    titleLines: 3,
  });
}

export async function renderCover(input: CoverLayout): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  const W = COVER_WIDTH;
  const H = COVER_HEIGHT;
  const pad = 88;
  const palette = input.palette ?? randomCoverPalette();

  // Background: dark diagonal gradient + soft glow.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, palette.bgFrom);
  bg.addColorStop(1, palette.bgTo);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, H * 0.15, 0, W * 0.85, H * 0.15, W * 0.6);
  glow.addColorStop(0, palette.glow);
  glow.addColorStop(1, "hsla(0 0% 0% / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Top label.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText(input.label, pad, pad + 20);

  // Title.
  const name = fit(ctx, input.title, W - pad * 2, input.titleSizes, "800", input.titleLines);
  ctx.fillStyle = "#ffffff";
  let y = input.titleLines > 2 && name.lines.length > 2 ? 210 : 250;
  for (const line of name.lines) {
    ctx.fillText(line, pad, y);
    y += name.size * 1.12;
  }

  // Accent bar.
  y += 6;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(pad, y - 18, 96, 8);
  y += 42;

  // Headline.
  if (input.headline.trim()) {
    const room = Math.max(2, Math.min(3, Math.floor((H - pad - 40 - y) / 50)));
    const head = fit(ctx, input.headline, W - pad * 2, [52, 46, 40, 34], "600", room);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    for (const line of head.lines) {
      ctx.fillText(line, pad, y + head.size * 0.4);
      y += head.size * 1.35;
    }
  }

  // Footer.
  const footer = input.footer;
  if (footer) {
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(footer, pad, H - pad + 10);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("封面生成失败");
  return new Uint8Array(await blob.arrayBuffer());
}
