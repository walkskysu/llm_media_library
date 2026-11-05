import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import * as v from "../scripts/version.mjs";

const toml = `[package]
name = "llm-media-library"
version = "0.1.0"

[dependencies]
serde = { version = "1" }
`;

const lock = `[[package]]
name = "libc"
version = "0.2.0"

[[package]]
name = "llm-media-library"
version = "0.1.0"
dependencies = [
`;

describe("version script", () => {
  it("parses tags", () => {
    expect(v.versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(v.versionFromTag("refs/tags/v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(v.isValidVersion("1.2.3-beta.1")).toBe(true);
    expect(v.isValidVersion("1.2")).toBe(false);
    expect(v.isValidVersion("01.2.3")).toBe(false);
  });

  it("reads and writes only the [package] version in Cargo.toml", () => {
    expect(v.readCargoTomlVersion(toml)).toBe("0.1.0");
    const out = v.writeCargoTomlVersion(toml, "0.2.0");
    expect(v.readCargoTomlVersion(out)).toBe("0.2.0");
    expect(out).toContain('serde = { version = "1" }');
  });

  it("updates only the app crate in Cargo.lock", () => {
    expect(v.readCargoLockVersion(lock)).toBe("0.1.0");
    const out = v.writeCargoLockVersion(lock, "1.0.0");
    expect(v.readCargoLockVersion(out)).toBe("1.0.0");
    expect(v.readCargoLockVersion(out, "libc")).toBe("0.2.0");
  });

  it("reports mismatches against each other and the tag", () => {
    const same = [
      { file: "a", version: "0.1.0" },
      { file: "b", version: "0.1.0" },
    ];
    expect(v.checkVersions(same)).toEqual([]);
    expect(v.checkVersions(same, "v0.1.0")).toEqual([]);
    expect(v.checkVersions(same, "v0.2.0")).toHaveLength(2);
    expect(v.checkVersions([...same, { file: "c", version: "0.3.0" }])).toHaveLength(1);
    expect(v.checkVersions(same, "release-1")).not.toEqual([]);
  });

  it("repository files are in sync", () => {
    expect(v.checkVersions(v.readVersions())).toEqual([]);
  });
});
