import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const retroPath = join(root, "docs", "retrospective.md");
const retro = readFileSync(retroPath, "utf8");
const v2Path = join(root, "docs", "v2-roadmap.md");
const v2 = readFileSync(v2Path, "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const roadmap = readFileSync(join(root, "ROADMAP.md"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cliSource = readFileSync(join(root, "src", "index.js"), "utf8");

// The retrospective's headline numbers are computed from the repo itself,
// so a later change that grows the codebase fails this test until the
// retrospective is updated to match. Counts are taken the same way a
// reader would count them: source modules, test files, checked days.
const srcModules = readdirSync(join(root, "src")).filter((f) =>
  f.endsWith(".js")
).length;
const testFiles = readdirSync(join(root, "test")).filter((f) =>
  f.endsWith(".test.js")
).length;
const checkedDays = (roadmap.match(/^- \[x\] \*\*Day \d+\*\*/gm) ?? []).length;
const uncheckedDays = (roadmap.match(/^- \[ \] \*\*Day \d+\*\*/gm) ?? []).length;

test("retrospective and v2 roadmap exist and are structured", () => {
  assert.ok(existsSync(retroPath), "docs/retrospective.md must exist");
  assert.ok(existsSync(v2Path), "docs/v2-roadmap.md must exist");
  assert.match(retro, /^# Retrospective/m);
  assert.match(retro, /## What shipped/m);
  assert.match(retro, /## What worked/m);
  assert.match(retro, /## What did not work/m);
  assert.match(retro, /## Lessons for the next project/m);
  assert.match(retro, /## The numbers/m);
  assert.match(v2, /^# v2 roadmap/m);
  const sections = v2.match(/^## /gm) ?? [];
  assert.ok(
    sections.length >= 5,
    `v2 roadmap should list several items, found ${sections.length}`
  );
});

test("retrospective numbers match the repo", () => {
  assert.ok(
    retro.includes(`**${srcModules} source modules**`),
    `retrospective must state the real source-module count (${srcModules})`
  );
  assert.ok(
    retro.includes(`**${testFiles} test files**`),
    `retrospective must state the real test-file count (${testFiles})`
  );
  assert.ok(
    retro.includes("30 days, 30 commits"),
    "retrospective must state the 30-day, 30-commit series"
  );
  assert.ok(
    retro.includes("402 tests in 58 suites"),
    "retrospective must state the passing test count"
  );
  // The series is complete: every roadmap day is checked.
  assert.equal(checkedDays, 30, `all 30 roadmap days must be checked, found ${checkedDays}`);
  assert.equal(uncheckedDays, 0, "no roadmap day may remain unchecked");
  assert.ok(
    retro.includes("1.0.0"),
    "retrospective must name the released version"
  );
});

test("retrospective's numbers table matches the repo", () => {
  const table = retro.split("## The numbers")[1] ?? "";
  assert.ok(table.includes(`| Source modules | ${srcModules} |`));
  assert.ok(table.includes(`| Test files | ${testFiles} |`));
  assert.ok(table.includes("| Days / commits | 30 |"));
  assert.ok(table.includes("| Tests (passing) | 402 in 58 suites |"));
});

test("v2 roadmap items each name a gap and a definition of done", () => {
  const headings = [...v2.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[2]);
  assert.ok(headings.length >= 5, `expected several v2 items, found ${headings.length}`);
  const bodies = v2.split(/^## \d+\. /m).slice(1);
  for (let i = 0; i < bodies.length; i++) {
    assert.match(
      bodies[i],
      /\*\*Why:\*\*/,
      `v2 item "${headings[i]}" must name the gap it closes`
    );
    assert.match(
      bodies[i],
      /\*\*Done when:\*\*/,
      `v2 item "${headings[i]}" must define what done looks like`
    );
  }
});

test("v2 roadmap's first item is the npm publish the retrospective admits is missing", () => {
  assert.match(retro, /not yet published to npm/);
  assert.match(v2, /## 1\. Publish 1\.0\.0 to npm/);
  assert.ok(v2.includes("npm install -g x402-tester"));
});

test("retrospective and v2 roadmap link to each other", () => {
  assert.ok(
    retro.includes("v2-roadmap.md"),
    "retrospective must link to the v2 roadmap"
  );
  assert.ok(
    v2.includes("retrospective.md"),
    "v2 roadmap must link back to the retrospective"
  );
});

test("README links to both new docs", () => {
  assert.ok(
    readme.includes("docs/retrospective.md"),
    "README must link to docs/retrospective.md"
  );
  assert.ok(
    readme.includes("docs/v2-roadmap.md"),
    "README must link to docs/v2-roadmap.md"
  );
});

test("changelog records Day 30", () => {
  assert.ok(
    changelog.includes("Day 30"),
    "CHANGELOG must record the Day 30 retrospective"
  );
});

test("new docs ship in the npm package", () => {
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("docs"),
    'package.json "files" must include "docs" so the new docs ship with the package'
  );
});

test("every CLI flag mentioned in the retrospective exists in the CLI", () => {
  // Keeps the retrospective's commands honest: a flag it tells users to
  // run must be one src/index.js actually parses. Flags in the v2 roadmap
  // are proposals, not current commands, so they are not checked here.
  const flags = [...new Set([...retro.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))];
  assert.ok(flags.length >= 1, "retrospective should mention CLI flags");
  for (const flag of flags) {
    assert.ok(
      cliSource.includes(`"${flag}"`),
      `retrospective mentions ${flag}, but the CLI does not parse it`
    );
  }
});
