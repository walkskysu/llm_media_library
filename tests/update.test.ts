import { describe, expect, it } from "vitest";
import { compareVersions, DOWNLOAD_PREFIX, evaluateUpdate, parseRelease, pickInstaller } from "../src/lib/update";

const asset = (name: string, url = `${DOWNLOAD_PREFIX}v0.2.0/${name}`) => ({
  name,
  browser_download_url: url,
  size: 1024,
});

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `LLM Media Library ${tag}`,
  body: "- new stuff",
  html_url: `https://github.com/walkskysu/llm_media_library/releases/tag/${tag}`,
  published_at: "2026-11-01T00:00:00Z",
  draft: false,
  prerelease: false,
  assets: [
    asset("SHA256SUMS.txt"),
    asset("LLM.Media.Library_0.2.0_x64_en-US.msi"),
    asset("LLM.Media.Library_0.2.0_x64-setup.exe"),
  ],
  ...extra,
});

describe("compareVersions", () => {
  it("orders by semver precedence", () => {
    expect(compareVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0);
  });
});

describe("parseRelease", () => {
  it("parses GitHub release JSON", () => {
    const r = parseRelease(release("v0.2.0"))!;
    expect(r.version).toBe("0.2.0");
    expect(r.tag).toBe("v0.2.0");
    expect(r.notes).toBe("- new stuff");
    expect(r.assets).toHaveLength(3);
  });

  it("rejects drafts, invalid tags and junk", () => {
    expect(parseRelease(release("v0.2.0", { draft: true }))).toBeNull();
    expect(parseRelease(release("nightly"))).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("x")).toBeNull();
  });
});

describe("pickInstaller", () => {
  it("prefers the NSIS setup exe, then msi, only from this repo", () => {
    const r = parseRelease(release("v0.2.0"))!;
    expect(pickInstaller(r.assets)?.name).toBe("LLM.Media.Library_0.2.0_x64-setup.exe");
    const msiOnly = r.assets.filter((a) => !a.name.endsWith(".exe"));
    expect(pickInstaller(msiOnly)?.name).toMatch(/\.msi$/);
    expect(pickInstaller([{ name: "x-setup.exe", url: "https://evil.example/x-setup.exe", size: 1 }])).toBeNull();
    expect(pickInstaller([])).toBeNull();
  });
});

describe("evaluateUpdate", () => {
  it("detects newer releases", () => {
    const u = evaluateUpdate("0.1.0", release("v0.2.0"));
    expect(u.hasUpdate).toBe(true);
    expect(u.installer?.name).toMatch(/setup\.exe$/);
  });

  it("reports up to date / no release", () => {
    expect(evaluateUpdate("0.2.0", release("v0.2.0")).hasUpdate).toBe(false);
    expect(evaluateUpdate("0.3.0", release("v0.2.0")).hasUpdate).toBe(false);
    const none = evaluateUpdate("0.1.0", null);
    expect(none.hasUpdate).toBe(false);
    expect(none.latest).toBeNull();
  });
});
