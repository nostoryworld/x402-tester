import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listFixtures,
  loadFixture,
  checkFixture,
  parseFixture,
  formatFixtureList,
  formatFixtureReport,
} from "../src/fixtures.js";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "index.js"
);

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 20000,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", status: err.status };
  }
}

test("listFixtures: returns the four bundled fixtures, sorted by name", async () => {
  const fixtures = await listFixtures();
  assert.deepEqual(
    fixtures.map((f) => f.name),
    ["ax1-q-verdict", "onesource-block-number", "tbs-weather-current", "xpay-uuid"]
  );
  for (const f of fixtures) {
    assert.equal(typeof f.url, "string");
    assert.match(f.url, /^https:\/\//);
    assert.equal(typeof f.price, "string");
    assert.equal(typeof f.capturedAt, "string");
    assert.equal(typeof f.capturedFrom, "string");
  }
});

test("loadFixture: every bundled fixture normalizes and prices in real token units", async () => {
  const expected = {
    "ax1-q-verdict": { price: "0.02 USDC", method: "POST", options: 1 },
    "onesource-block-number": { price: "0.001 USDC", method: "GET", options: 2 },
    "tbs-weather-current": { price: "0.001 USDC", method: "GET", options: 1 },
    "xpay-uuid": { price: "0.005 USDC", method: "GET", options: 1 },
  };
  for (const [name, want] of Object.entries(expected)) {
    const loaded = await loadFixture(name);
    assert.equal(loaded.version, 2, `${name} should be x402 v2`);
    assert.equal(loaded.price, want.price, `${name} price`);
    assert.equal(loaded.method, want.method, `${name} method`);
    assert.equal(loaded.requirements.length, want.options, `${name} options`);
    assert.equal(loaded.requirements[0].scheme, "exact");
    // CAIP-2 network from the real response, kept verbatim.
    assert.equal(loaded.requirements[0].network, "eip155:8453");
  }
});

test("loadFixture: onesource offers exact + batch-settlement for the same price", async () => {
  const loaded = await loadFixture("onesource-block-number");
  assert.deepEqual(
    loaded.requirements.map((r) => r.scheme),
    ["exact", "batch-settlement"]
  );
  assert.equal(loaded.requirements[0].amount, loaded.requirements[1].amount);
});

test("checkFixture: offline report matches the live-check shape, with no network", async () => {
  const loaded = await loadFixture("tbs-weather-current");
  const r = await checkFixture(loaded);
  assert.equal(r.ok, true);
  assert.equal(r.offline, true);
  assert.equal(r.fixture, "tbs-weather-current");
  assert.equal(r.status, 402);
  assert.equal(r.latencyMs, 0);
  assert.equal(r.attempts, 1);
  assert.equal(r.price, "0.001 USDC");
  assert.equal(r.options, 1);
  assert.equal(r.priceSanity.flagged, false);
  // The recorded body carries an error field, which surfaces as a warning.
  assert.ok(r.warnings.some((w) => w.includes("error field")));
});

test("checkFixture: multi-option fixture warns that only the first was validated", async () => {
  const loaded = await loadFixture("onesource-block-number");
  const r = await checkFixture(loaded);
  assert.equal(r.ok, true);
  assert.equal(r.options, 2);
  assert.ok(r.warnings.some((w) => w.includes("2 payment options offered")));
});

test("loadFixture: unknown name tells the user how to list fixtures", async () => {
  await assert.rejects(() => loadFixture("no-such-fixture"), /unknown fixture 'no-such-fixture'/);
  await assert.rejects(() => loadFixture("no-such-fixture"), /x402-tester fixtures/);
});

test("loadFixture: a name that is not a plain stem is rejected, never read as a path", async () => {
  await assert.rejects(() => loadFixture("../package"), /invalid fixture name/);
  await assert.rejects(() => loadFixture("a/b"), /invalid fixture name/);
  await assert.rejects(() => loadFixture("UPPER"), /invalid fixture name/);
});

test("parseFixture: malformed fixtures fail with a reason, never a pass", () => {
  assert.throws(() => parseFixture(null, "x"), /malformed/);
  assert.throws(
    () => parseFixture({ url: "https://example.com", response: null }, "x"),
    /malformed.*response/
  );
  assert.throws(
    () =>
      parseFixture(
        { url: "https://example.com", response: { x402Version: 2, accepts: [] } },
        "x"
      ),
    /no usable payment requirements/
  );
  // A requirement entry missing required fields is not a parse error —
  // it loads, and the check itself fails with the missing fields named
  // (covered by the next test). normalizeResponse only rejects a body
  // with no requirements array at all.
  assert.throws(
    () => parseFixture({ url: "https://example.com", response: {} }, "x"),
    /no usable payment requirements/
  );
});

test("parseFixture: a fixture missing a required field loads but fails the check", () => {
  const loaded = parseFixture(
    {
      name: "incomplete",
      url: "https://example.com/paid",
      response: {
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "1000" }],
      },
    },
    "incomplete"
  );
  const r = checkFixture(loaded);
  assert.equal(r.ok, false);
  assert.match(r.error, /missing: payTo/);
});

test("listFixtures: a broken fixture file fails the listing instead of being skipped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "x402-fixtures-"));
  await writeFile(
    path.join(dir, "broken.json"),
    JSON.stringify({ url: "https://example.com", response: { accepts: [] } })
  );
  await assert.rejects(() => listFixtures({ fixturesDir: dir }), /no usable payment requirements/);
});

test("formatFixtureList: names, prices and the offline-run hint", async () => {
  const fixtures = await listFixtures();
  const text = formatFixtureList(fixtures);
  assert.match(text, /tbs-weather-current/);
  assert.match(text, /0\.001 USDC/);
  assert.match(text, /x402-tester check --fixture <name>/);
});

test("formatFixtureReport: says offline and where the recording came from", async () => {
  const loaded = await loadFixture("xpay-uuid");
  const text = formatFixtureReport(checkFixture(loaded));
  assert.match(text, /fixture: xpay-uuid — offline check/);
  assert.match(text, /captured 2026-11-08/);
  assert.match(text, /live 402 probe/);
  assert.match(text, /price: 0\.005 USDC/);
});

test("CLI: fixtures lists the bundled examples and exits 0", () => {
  const { stdout, status } = runCli(["fixtures"]);
  assert.equal(status, 0);
  assert.match(stdout, /ax1-q-verdict/);
  assert.match(stdout, /tbs-weather-current/);
  assert.match(stdout, /0\.02 USDC/);
});

test("CLI: fixtures --json prints a parseable object", () => {
  const { stdout, status } = runCli(["fixtures", "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.count, 4);
  assert.equal(parsed.fixtures.length, 4);
  assert.equal(parsed.fixtures[0].name, "ax1-q-verdict");
});

test("CLI: check --fixture runs offline, prints the price, exits 0", () => {
  const { stdout, status } = runCli(["check", "--fixture", "tbs-weather-current"]);
  assert.equal(status, 0);
  assert.match(stdout, /fixture: tbs-weather-current — offline check/);
  assert.match(stdout, /price: 0\.001 USDC/);
  assert.match(stdout, /status: OK/);
});

test("CLI: check --fixture --json is parseable and marked offline", () => {
  const { stdout, status } = runCli(["check", "--fixture", "xpay-uuid", "--json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offline, true);
  assert.equal(parsed.fixture, "xpay-uuid");
  assert.equal(parsed.price, "0.005 USDC");
});

test("CLI: check --fixture with an unknown name fails with a helpful error", () => {
  const { stderr, status } = runCli(["check", "--fixture", "nope"]);
  assert.equal(status, 1);
  assert.match(stderr, /unknown fixture 'nope'/);
});

test("CLI: check refuses a URL combined with --fixture", () => {
  const { stderr, status } = runCli([
    "check",
    "https://example.com/paid",
    "--fixture",
    "xpay-uuid",
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /--fixture cannot be combined with a URL/);
});
