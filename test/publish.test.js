import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("package metadata is publish-ready", () => {
  assert.equal(pkg.name, "x402-tester");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "version must be semver");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.description && pkg.description.length > 20);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 3);
  assert.ok(pkg.keywords.includes("x402"));
  assert.equal(pkg.author, "Odemakinde Ezekiel Temitayo");
  assert.match(pkg.repository.url, /github\.com\/nostoryworld\/x402-tester/);
  assert.match(pkg.homepage, /github\.com\/nostoryworld\/x402-tester/);
  assert.match(pkg.bugs.url, /github\.com\/nostoryworld\/x402-tester\/issues/);
  assert.match(pkg.engines.node, />=\d+/);
  assert.equal(pkg.publishConfig.access, "public");
  assert.match(pkg.scripts.prepublishOnly, /npm test/);
});

test("bin entry point exists and is executable", () => {
  const binPath = join(root, pkg.bin["x402-tester"]);
  assert.ok(existsSync(binPath), "bin target must exist");
  const head = readFileSync(binPath, "utf8").split("\n")[0];
  assert.equal(head, "#!/usr/bin/env node");
});

test("files allowlist covers src, examples and docs", () => {
  assert.ok(pkg.files.includes("src"), "src must ship");
  assert.ok(pkg.files.includes("examples"), "examples must ship");
  assert.ok(pkg.files.includes("docs"), "docs must ship");
  for (const entry of pkg.files) {
    assert.ok(existsSync(join(root, entry)), `${entry} must exist`);
  }
});

test("npm pack --dry-run ships only allowlisted files", () => {
  // `npm pack --dry-run` prints the tarball listing to stderr.
  const result = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "npm pack --dry-run must succeed");
  const out = `${result.stdout}\n${result.stderr}`;
  const files = [...out.matchAll(/^npm notice\s+[\d.]+[kM]?B\s+(.+)$/gm)].map(
    (m) => m[1].trim(),
  );
  assert.ok(files.length > 0, "pack output must list files");
  assert.ok(files.some((f) => f.startsWith("src/")), "src/ must ship");
  assert.ok(files.some((f) => f.startsWith("examples/")), "examples/ must ship");
  assert.ok(files.some((f) => f.startsWith("docs/")), "docs/ must ship");
  const forbidden = files.filter(
    (f) =>
      f.startsWith("test/") ||
      f === "action.yml" ||
      f === "ROADMAP.md" ||
      f === ".gitignore" ||
      f === "package-lock.json",
  );
  assert.deepEqual(
    forbidden,
    [],
    `tarball must not include dev-only files: ${forbidden.join(", ")}`,
  );
  const alwaysAllowed = new Set(["package.json", "README.md", "LICENSE"]);
  for (const f of files) {
    assert.ok(
      alwaysAllowed.has(f) ||
        f.startsWith("src/") ||
        f.startsWith("examples/") ||
        f.startsWith("docs/"),
      `unexpected file in tarball: ${f}`,
    );
  }
});
