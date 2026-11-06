#!/usr/bin/env node
// Keep the app version in sync across package.json, package-lock.json,
// src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock.
//
// Usage:
//   node scripts/version.mjs get              Print the current version
//   node scripts/version.mjs check [vX.Y.Z]   Verify all files agree (and match the tag, if given)
//   node scripts/version.mjs set X.Y.Z        Write X.Y.Z into every file
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CRATE_NAME = "llm-media-library";

export function isValidVersion(version) {
  return SEMVER.test(version);
}

/** Strip a leading "v" / "refs/tags/v" from a git tag. */
export function versionFromTag(tag) {
  return tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the `version` of the `[package]` section in a Cargo.toml. */
export function readCargoTomlVersion(text) {
  const section = text.match(/^\[package\][^\[]*/m);
  const m = section && section[0].match(/^version\s*=\s*"([^"]*)"/m);
  if (!m) throw new Error("Cargo.toml: [package] version not found");
  return m[1];
}

export function writeCargoTomlVersion(text, version) {
  const section = text.match(/^\[package\][^\[]*/m);
  if (!section) throw new Error("Cargo.toml: [package] section not found");
  const updated = section[0].replace(
    /^version\s*=\s*"[^"]*"/m,
    `version = "${version}"`,
  );
  if (updated === section[0] && readCargoTomlVersion(text) !== version) {
    throw new Error("Cargo.toml: [package] version not found");
  }
  return text.replace(section[0], updated);
}

const lockEntry = (name) =>
  new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escapeRe(name)}"\\r?\\nversion = ")([^"]*)(")`);

export function readCargoLockVersion(text, name = CRATE_NAME) {
  const m = text.match(lockEntry(name));
  if (!m) throw new Error(`Cargo.lock: package "${name}" not found`);
  return m[2];
}

export function writeCargoLockVersion(text, version, name = CRATE_NAME) {
  readCargoLockVersion(text, name);
  return text.replace(lockEntry(name), `$1${version}$3`);
}

function rootDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function files(root) {
  const p = (...parts) => join(root, ...parts);
  const json = (rel) => ({
    rel,
    read: (t) => JSON.parse(t).version,
    write: (t, v) => {
      const data = JSON.parse(t);
      data.version = v;
      if (rel === "package-lock.json" && data.packages?.[""]) data.packages[""].version = v;
      return JSON.stringify(data, null, 2) + "\n";
    },
  });
  return [
    { ...json("package.json"), path: p("package.json") },
    { ...json("package-lock.json"), path: p("package-lock.json") },
    { ...json("src-tauri/tauri.conf.json"), path: p("src-tauri", "tauri.conf.json") },
    {
      rel: "src-tauri/Cargo.toml",
      path: p("src-tauri", "Cargo.toml"),
      read: readCargoTomlVersion,
      write: writeCargoTomlVersion,
    },
    {
      rel: "src-tauri/Cargo.lock",
      path: p("src-tauri", "Cargo.lock"),
      read: (t) => readCargoLockVersion(t),
      write: (t, v) => writeCargoLockVersion(t, v),
    },
  ];
}

export function readVersions(root = rootDir()) {
  return files(root).map((f) => ({
    file: f.rel,
    version: f.read(readFileSync(f.path, "utf8")),
  }));
}

/** Returns a list of human readable problems (empty when everything is consistent). */
export function checkVersions(versions, tag) {
  const problems = [];
  const expected = tag ? versionFromTag(tag) : versions[0]?.version;
  if (tag && !isValidVersion(expected)) {
    problems.push(`tag "${tag}" is not a valid vX.Y.Z version`);
  }
  for (const { file, version } of versions) {
    if (version !== expected) {
      problems.push(
        `${file} has version ${version}, expected ${expected}${tag ? ` (from tag ${tag})` : ""}`,
      );
    }
  }
  return problems;
}

export function setVersion(version, root = rootDir()) {
  if (!isValidVersion(version)) throw new Error(`invalid version "${version}"`);
  for (const f of files(root)) {
    const text = readFileSync(f.path, "utf8");
    writeFileSync(f.path, f.write(text, version));
  }
}

function main(argv) {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "get":
      console.log(readVersions()[0].version);
      return 0;
    case "check": {
      const problems = checkVersions(readVersions(), arg);
      if (problems.length) {
        for (const p of problems) console.error(`✗ ${p}`);
        return 1;
      }
      console.log(`✓ all files at version ${readVersions()[0].version}`);
      return 0;
    }
    case "set": {
      if (!arg) break;
      setVersion(versionFromTag(arg));
      console.log(`✓ version set to ${versionFromTag(arg)}`);
      return 0;
    }
  }
  console.error("usage: node scripts/version.mjs <get | check [vX.Y.Z] | set X.Y.Z>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
