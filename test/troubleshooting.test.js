import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = join(root, "docs", "troubleshooting.md");
const guide = readFileSync(guidePath, "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cliSource = readFileSync(join(root, "src", "index.js"), "utf8");

// Every error string the tool can print for a failed handshake (and the
// failures just past it) must be covered by the guide, so a user can
// search this page for the exact line they saw. These substrings are
// copied from src/handshake.js, src/requirements.js, src/retry.js,
// src/price-sanity.js, src/facilitator.js, src/endtoend.js and
// src/replay.js — if the tool's wording changes, this test fails until
// the guide is updated to match.
const CANONICAL_ERRORS = [
  "expected HTTP 402 Payment Required, got",
  "402 response has an empty body",
  "retry with --method POST",
  "402 response body is not valid JSON",
  "402 response contains no payment requirements",
  "first payment requirement is missing:",
  "request failed:",
  "request timed out after",
  "could not determine the x402 version",
  "payment options offered; validated the first",
  "price sanity: option",
  "dust-level price, likely a decimals bug",
  "whale-level price, likely a decimals bug",
  "facilitator unreachable:",
  "cannot sign:",
  "facilitator rejected it:",
  "expected 402 with accepts, got HTTP",
  "expected HTTP 200 with the resource, got HTTP",
  "endpoint served the resource again for the same signed payment",
  "not a clean rejection, so protection cannot be confirmed",
];

test("troubleshooting guide exists and is structured", () => {
  assert.ok(existsSync(guidePath), "docs/troubleshooting.md must exist");
  assert.match(guide, /^# Troubleshooting/m);
  assert.match(guide, /## Quick reference/m);
  assert.match(guide, /## Handshake failures/m);
  assert.match(guide, /## What a healthy 402 looks like/m);
  const sections = guide.match(/^## /gm) ?? [];
  assert.ok(
    sections.length >= 4,
    `guide should have several top-level sections, found ${sections.length}`
  );
});

test("guide covers every canonical handshake error string", () => {
  for (const err of CANONICAL_ERRORS) {
    assert.ok(
      guide.includes(err),
      `guide must cover the tool's error text: "${err}"`
    );
  }
});

test("guide gives a fix for each failure it documents", () => {
  // Every "###" failure section must name a fix — a symptom without a
  // remedy is not troubleshooting.
  const headings = [...guide.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.ok(headings.length >= 10, `expected many failure sections, found ${headings.length}`);
  const bodies = guide.split(/^### /m).slice(1);
  for (let i = 0; i < bodies.length; i++) {
    assert.match(
      bodies[i],
      /\*\*Fix:\*\*/,
      `section "${headings[i]}" must include a Fix`
    );
  }
});

test("guide's healthy-402 examples match the shapes the tool validates", () => {
  // v2 example must use `accepts` + `amount`; v1 must use
  // `paymentRequirements` + `maxAmountRequired` (see requirements.js).
  assert.ok(guide.includes('"accepts"'));
  assert.ok(guide.includes('"paymentRequirements"'));
  assert.ok(guide.includes('"maxAmountRequired"'));
  // The decimals worked example must be arithmetically right: 0.02 USDC
  // at 6 decimals is 20000 raw units (same as the ax1 fixture).
  assert.ok(guide.includes('"20000"'));
  assert.ok(guide.includes("0.02 USDC"));
});

test("README links to the troubleshooting guide", () => {
  assert.ok(
    readme.includes("docs/troubleshooting.md"),
    "README must link to docs/troubleshooting.md"
  );
});

test("troubleshooting guide ships in the npm package", () => {
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("docs"),
    'package.json "files" must include "docs" so the guide ships with the package'
  );
});

test("every CLI flag recommended by the guide exists in the CLI", () => {
  // Keeps the guide's commands honest: a flag the guide tells users to
  // run must be one src/index.js actually parses.
  const flags = [...new Set(guide.match(/--[a-z][a-z-]*/g) ?? [])];
  assert.ok(flags.length >= 5, `guide should recommend CLI flags, found ${flags.length}`);
  for (const flag of flags) {
    assert.ok(
      cliSource.includes(`"${flag}"`),
      `guide recommends ${flag}, but the CLI does not parse it`
    );
  }
});
