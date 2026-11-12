import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

test("package version is 1.0.0", () => {
  assert.equal(pkg.version, "1.0.0", "v1.0.0 release prep bumps to 1.0.0");
});

test("package-lock version matches package.json", () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(lock.name, pkg.name);
});

test("CHANGELOG.md exists and records the 1.0.0 release", () => {
  const changelogPath = join(root, "CHANGELOG.md");
  assert.ok(existsSync(changelogPath), "CHANGELOG.md must exist");
  const changelog = readFileSync(changelogPath, "utf8");
  assert.match(changelog, /^## \[1\.0\.0\] - 2026-11-12$/m);
  assert.match(changelog, /Keep a Changelog/);
  assert.match(changelog, /Semantic Versioning/);
  assert.match(changelog, /Version bumped from 0\.1\.0 to 1\.0\.0/);
});

test("changelog covers the headline features shipped in v1.0.0", () => {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const release = changelog.split("## [1.0.0]")[1].split("## [")[0];
  for (const feature of [
    "`check` command",
    "Payment-requirement normalisation",
    "Facilitator reachability",
    "x402scan",
    "`pay` command",
    "mock facilitator",
    "Solana",
    "JSON report",
    "Markdown report",
    "Batch mode",
    "Config file",
    "Latency benchmark",
    "CDP Bazaar",
    "CI mode",
    "GitHub Action",
    "HTML report",
    "Compare mode",
    "replay protection",
    "Example fixtures",
    "troubleshooting guide",
    "how x402 payments work",
  ]) {
    assert.ok(
      release.includes(feature),
      `changelog 1.0.0 section must mention: ${feature}`,
    );
  }
});

test("changelog ships in the published package", () => {
  assert.ok(
    pkg.files.includes("CHANGELOG.md"),
    "CHANGELOG.md must be in the files allowlist",
  );
  assert.ok(existsSync(join(root, "CHANGELOG.md")));
});
