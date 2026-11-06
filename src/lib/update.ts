// Pure helpers for "检查升级 / 安装更新" (no Tauri imports so they can be unit-tested).

export const REPO = "walkskysu/llm_media_library";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
/** Only installers from this repository's releases may be downloaded and run. */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface UpdateCheck {
  currentVersion: string;
  latest: ReleaseInfo | null;
  hasUpdate: boolean;
  /** Installer to download for this platform, if the release has one. */
  installer: ReleaseAsset | null;
}

interface SemVer {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(input: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence comparison. Returns <0, 0 or >0. Invalid versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return (va ? 1 : 0) - (vb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (va.core[i] !== vb.core[i]) return va.core[i] - vb.core[i];
  // A version without pre-release identifiers has higher precedence.
  if (!va.pre.length || !vb.pre.length) return vb.pre.length - va.pre.length;
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return va.pre.length - vb.pre.length;
}

/** Convert a GitHub REST API release object into a ReleaseInfo (null if unusable). */
export function parseRelease(raw: any): ReleaseInfo | null {
  if (!raw || typeof raw !== "object" || raw.draft) return null;
  const tag = typeof raw.tag_name === "string" ? raw.tag_name : "";
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const assets: ReleaseAsset[] = Array.isArray(raw.assets)
    ? raw.assets
        .filter((a: any) => a && typeof a.name === "string" && typeof a.browser_download_url === "string")
        .map((a: any) => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }))
    : [];
  return {
    version: tag.replace(/^v/, ""),
    tag,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : tag,
    notes: typeof raw.body === "string" ? raw.body : "",
    url: typeof raw.html_url === "string" ? raw.html_url : `${RELEASES_URL}/tag/${tag}`,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
    prerelease: Boolean(raw.prerelease),
    assets,
  };
}

/** Pick the Windows installer: NSIS `*-setup.exe` preferred, then `*.msi`. */
export function pickInstaller(assets: ReleaseAsset[]): ReleaseAsset | null {
  const ok = assets.filter((a) => a.url.startsWith(DOWNLOAD_PREFIX));
  const lower = (a: ReleaseAsset) => a.name.toLowerCase();
  return (
    ok.find((a) => lower(a).endsWith("-setup.exe")) ??
    ok.find((a) => lower(a).endsWith(".exe")) ??
    ok.find((a) => lower(a).endsWith(".msi")) ??
    null
  );
}

export function evaluateUpdate(currentVersion: string, rawLatest: unknown): UpdateCheck {
  const latest = parseRelease(rawLatest);
  const hasUpdate = !!latest && compareVersions(latest.version, currentVersion) > 0;
  return { currentVersion, latest, hasUpdate, installer: latest ? pickInstaller(latest.assets) : null };
}
