/**
 * Compare mode: diff the handshakes of two endpoints.
 *
 * Useful when a staging and a production endpoint (or two versions of
 * the same service) should offer the same payment terms: run one
 * `check` against each URL and report every field where the payment
 * terms differ — price, network, asset, payee, scheme, version,
 * timeout, resource, description, MIME type, and how many payment
 * options each offers.
 *
 * Latency is reported side by side but never counts as a difference:
 * it varies run to run, so two identical handshakes would otherwise
 * never compare equal. A difference is a difference in the payment
 * terms only.
 *
 * `ok` is true when both handshakes are valid, even when they differ
 * — a difference is information, not a failure. `identical` is true
 * only when both handshakes are valid and no payment-term field
 * differs. Under `--ci` a difference behaves like a warning (see
 * ci.js): a deploy gate comparing staging against production fails
 * when the terms drift apart.
 *
 * `check` defaults to checkHandshake and is injectable for tests.
 */

import { checkHandshake } from "./handshake.js";
import { formatPrice } from "./price.js";
import { DEFAULT_TIMEOUT_MS } from "./retry.js";

// Payment-term fields compared between two valid handshakes, in the
// order they appear in the report. `price` is the human-formatted
// price (formatPrice); the raw amounts live in the embedded `a`/`b`
// handshake reports for anyone who needs them.
const COMPARED_FIELDS = [
  "version",
  "scheme",
  "network",
  "payTo",
  "asset",
  "price",
  "maxTimeoutSeconds",
  "resource",
  "description",
  "mimeType",
  "options",
];

/**
 * Read one compared field off a handshake report. Requirement fields
 * come from the normalized first requirement; `version`, `price` and
 * `options` live on the report itself.
 */
function fieldValue(report, field) {
  if (field === "version") return report.version ?? null;
  if (field === "price") return report.price ?? null;
  if (field === "options") return report.options ?? null;
  return report.requirements?.[field] ?? null;
}

function valuesEqual(a, b) {
  // Amounts and versions arrive as strings or numbers; compare the
  // string forms so "20000" and 20000 never read as a difference.
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

/**
 * Diff the payment terms of two valid handshake reports. Returns the
 * list of differences as { field, a, b } — empty when the terms match.
 */
export function diffHandshakes(a, b) {
  const differences = [];
  for (const field of COMPARED_FIELDS) {
    const valueA = fieldValue(a, field);
    const valueB = fieldValue(b, field);
    if (!valuesEqual(valueA, valueB)) {
      differences.push({ field, a: valueA, b: valueB });
    }
  }
  return differences;
}

/**
 * Run a handshake check against both URLs and diff the results.
 * The full handshake reports are embedded as `a` and `b`, so `--json`
 * consumers get everything `check` would have reported for each
 * endpoint, plus the diff.
 */
export async function compareEndpoints(
  urlA,
  urlB,
  {
    method = "GET",
    retries = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    check = checkHandshake,
  } = {}
) {
  const a = await check(urlA, { method, retries, timeoutMs });
  const b = await check(urlB, { method, retries, timeoutMs });

  let differences;
  if (!a.ok || !b.ok) {
    // A failed handshake has no payment terms to diff — the failure
    // itself is the difference.
    differences = [
      {
        field: "handshake",
        a: a.ok ? "ok" : (a.error ?? "failed"),
        b: b.ok ? "ok" : (b.error ?? "failed"),
      },
    ];
  } else {
    differences = diffHandshakes(a, b);
  }

  return {
    urlA,
    urlB,
    ok: a.ok && b.ok,
    identical: a.ok && b.ok && differences.length === 0,
    differences,
    a,
    b,
  };
}

function display(value) {
  if (value === null || value === undefined || value === "") return "(not set)";
  return String(value);
}

function summarizeSide(label, url, report) {
  if (!report.ok) return `${label}: ${url} — FAIL: ${report.error}`;
  const q = report.requirements;
  const lines = [
    `${label}: ${url}`,
    `  status: OK (${report.latencyMs}ms, ${report.method || "GET"})`,
  ];
  if (report.version) lines.push(`  x402 version: v${report.version}`);
  lines.push(`  scheme: ${q.scheme} | network: ${q.network}`);
  lines.push(`  payTo: ${q.payTo}`);
  lines.push(`  price: ${formatPrice(q)}`);
  if (q.description) lines.push(`  description: ${q.description}`);
  lines.push(`  payment options: ${report.options}`);
  return lines.join("\n");
}

export function formatCompareReport(report) {
  const lines = [
    `x402 handshake compare: ${report.urlA} vs ${report.urlB}`,
    `status: ${report.ok ? "OK (both handshakes valid)" : "FAIL (one or both handshakes failed)"}`,
    summarizeSide("A", report.urlA, report.a),
    summarizeSide("B", report.urlB, report.b),
  ];
  if (report.a.ok && report.b.ok) {
    lines.push(
      `latency: ${report.a.latencyMs}ms (A) vs ${report.b.latencyMs}ms (B)`
    );
  }
  if (report.identical) {
    lines.push("identical: yes — the handshakes offer the same payment terms");
  } else {
    lines.push(
      `identical: no — ${report.differences.length} difference${report.differences.length === 1 ? "" : "s"}:`
    );
    for (const d of report.differences) {
      lines.push(`  - ${d.field}: ${display(d.a)} vs ${display(d.b)}`);
    }
  }
  return lines.join("\n");
}
