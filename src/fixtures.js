/**
 * Bundled example fixtures: recorded 402 handshake responses from
 * well-known public x402 endpoints (see examples/*.json).
 *
 * A fixture is the real 402 body an endpoint answered with, captured
 * once and checked in, so the handshake can be exercised offline:
 * `x402-tester check --fixture <name>` runs the exact same
 * normalize → validate → price → price-sanity path as a live check,
 * with no network request. Fixtures are for testing the tool and for
 * learning what a healthy handshake looks like — never for paying:
 * the recorded payTo addresses belong to the services, and a fixture
 * check signs nothing and sends nothing.
 *
 * Fixture file shape:
 *   { name, url, method, description, capturedAt, capturedFrom,
 *     response: { <raw 402 body> } }
 *
 * `capturedFrom` records provenance: "live 402 probe" means the body
 * was fetched from the endpoint itself; anything else says where the
 * copy came from (e.g. the CDP Bazaar catalog listing). A fixture
 * whose response no longer normalizes fails loudly at load time —
 * a stale fixture must never read as a passing check.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  normalizeResponse,
  validateRequirement,
} from "./requirements.js";
import { formatPrice } from "./price.js";
import { checkPriceSanity, formatPriceSanityLines } from "./price-sanity.js";
import { formatReport } from "./handshake.js";

export const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples"
);

// Fixture names are file stems under examples/ — lowercase letters,
// digits and dashes only, so a name can never escape the directory
// ("../.." is not a fixture name, it's a path traversal attempt).
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function fixturePath(name, fixturesDir = FIXTURES_DIR) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid fixture name '${name}' (expected lowercase letters, digits and dashes)`
    );
  }
  return path.join(fixturesDir, `${name}.json`);
}

/**
 * Validate a parsed fixture object and normalize its recorded 402
 * body. Returns the loaded fixture:
 *   { name, url, method, description, capturedAt, capturedFrom,
 *     response, version, requirements, price }
 * Throws when the fixture is malformed or its response has no usable
 * payment requirements.
 */
export function parseFixture(raw, name) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`fixture '${name}' is malformed: expected a JSON object`);
  }
  if (typeof raw.url !== "string" || !raw.url) {
    throw new Error(`fixture '${name}' is malformed: 'url' must be a non-empty string`);
  }
  if (!raw.response || typeof raw.response !== "object") {
    throw new Error(`fixture '${name}' is malformed: 'response' must be the recorded 402 body object`);
  }
  let parsed;
  try {
    parsed = normalizeResponse(raw.response);
  } catch (err) {
    throw new Error(`fixture '${name}' has no usable payment requirements: ${err.message}`);
  }
  return {
    name: raw.name || name,
    url: raw.url,
    method: typeof raw.method === "string" ? raw.method.toUpperCase() : "GET",
    description: typeof raw.description === "string" ? raw.description : "",
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : null,
    capturedFrom: typeof raw.capturedFrom === "string" ? raw.capturedFrom : null,
    response: raw.response,
    version: parsed.version,
    requirements: parsed.requirements,
    price: formatPrice(parsed.requirements[0]),
  };
}

/**
 * Load one fixture by name. Throws on an unknown name, unreadable
 * file, invalid JSON, or a response that no longer normalizes.
 */
export async function loadFixture(name, { fixturesDir = FIXTURES_DIR } = {}) {
  const file = fixturePath(name, fixturesDir);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `unknown fixture '${name}' — run 'x402-tester fixtures' to list the bundled ones`
      );
    }
    throw new Error(`cannot read fixture '${name}': ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`fixture '${name}' is not valid JSON: ${err.message}`);
  }
  return parseFixture(raw, name);
}

/**
 * List every bundled fixture's metadata, sorted by name. A
 * malformed fixture fails the listing — silently skipping a broken
 * example would hide the breakage until someone tried to use it.
 */
export async function listFixtures({ fixturesDir = FIXTURES_DIR } = {}) {
  let entries;
  try {
    entries = await readdir(fixturesDir);
  } catch (err) {
    throw new Error(`cannot list fixtures in '${fixturesDir}': ${err.message}`);
  }
  const names = entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
  const fixtures = [];
  for (const name of names) {
    const loaded = await loadFixture(name, { fixturesDir });
    fixtures.push({
      name: loaded.name,
      url: loaded.url,
      method: loaded.method,
      description: loaded.description,
      network: loaded.requirements[0]?.network ?? null,
      price: loaded.price,
      capturedAt: loaded.capturedAt,
      capturedFrom: loaded.capturedFrom,
    });
  }
  return fixtures;
}

/**
 * Run the handshake check against a loaded fixture's recorded 402
 * body — the same normalize → validate → price → price-sanity path
 * as a live check, but offline: no request is made, latency is 0,
 * and the report says so. Returns a handshake-shaped report with
 * `fixture` and `offline: true` set.
 */
export function checkFixture(loaded) {
  const first = loaded.requirements[0];
  const { ok, missing } = validateRequirement(first);

  const warnings = [];
  if (loaded.requirements.length > 1) {
    warnings.push(
      `${loaded.requirements.length} payment options offered; validated the first`
    );
  }
  if (loaded.response.error) {
    warnings.push(`server included an error field: ${loaded.response.error}`);
  }
  if (loaded.version === null) {
    warnings.push(
      "could not determine the x402 version from the response; treated generically"
    );
  }

  const priceSanity = checkPriceSanity(loaded.requirements);
  for (const line of formatPriceSanityLines(priceSanity)) {
    warnings.push(line);
  }

  return {
    url: loaded.url,
    fixture: loaded.name,
    offline: true,
    ok,
    status: 402,
    method: loaded.method,
    latencyMs: 0,
    attempts: 1,
    version: loaded.version,
    error: ok ? undefined : `first payment requirement is missing: ${missing.join(", ")}`,
    requirements: first,
    price: loaded.price,
    options: loaded.requirements.length,
    priceSanity,
    warnings,
    capturedAt: loaded.capturedAt,
    capturedFrom: loaded.capturedFrom,
  };
}

export function formatFixtureList(fixtures) {
  const lines = [`bundled example fixtures (${fixtures.length}):`, ``];
  for (const f of fixtures) {
    lines.push(`  ${f.name}`);
    lines.push(`    ${f.method} ${f.url}`);
    if (f.description) lines.push(`    ${f.description}`);
    lines.push(`    price: ${f.price}${f.network ? ` (${f.network})` : ""}`);
    if (f.capturedAt) {
      lines.push(
        `    recorded: ${f.capturedAt}${f.capturedFrom ? ` — ${f.capturedFrom}` : ""}`
      );
    }
  }
  lines.push(``, `Run one offline: x402-tester check --fixture <name>`);
  return lines.join("\n");
}

export function formatFixtureReport(r) {
  const lines = formatReport(r).split("\n");
  // formatReport's first line names the URL; the fixture line says
  // where the response came from and that nothing was fetched.
  lines.splice(
    1,
    0,
    `fixture: ${r.fixture} — offline check against the recorded 402 response` +
      (r.capturedAt ? ` (captured ${r.capturedAt})` : "") +
      (r.capturedFrom ? ` via ${r.capturedFrom}` : "")
  );
  return lines.join("\n");
}
