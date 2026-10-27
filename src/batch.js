/**
 * Batch mode: check many x402 endpoints listed in a file.
 *
 * File format — one endpoint per line:
 *   https://example.com/paid-api
 *   POST https://example.com/post-only-api
 *
 * Blank lines and lines starting with `#` are ignored. A line may carry
 * an explicit HTTP method (needed for POST-only endpoints, see
 * handshake.js); otherwise the batch default applies. Lines that are
 * not a valid http(s) URL — or carry an unknown method — are not
 * silently dropped: they become failed results so a typo in the file
 * shows up in the summary instead of vanishing.
 *
 * Results run sequentially (deterministic order, no hammering the
 * endpoints) and the summary is all-or-nothing: `ok` is true only
 * when every entry passed, so batch mode doubles as a CI gate.
 */

import { checkHandshake } from "./handshake.js";

const KNOWN_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Parse batch-file content into entries plus the lines that could not
 * be parsed. `defaultMethod` applies to lines without an explicit
 * method (the CLI's --method flag). Never throws on bad input — every
 * problem lands in `invalid` with its line number.
 */
export function parseBatchFile(content, { defaultMethod = "GET" } = {}) {
  const entries = [];
  const invalid = [];
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split(/\s+/);
    let method = String(defaultMethod || "GET").toUpperCase();
    let urlToken = parts[0];
    if (parts.length === 2) {
      method = parts[0].toUpperCase();
      urlToken = parts[1];
      if (!KNOWN_METHODS.has(method)) {
        invalid.push({
          line: i + 1,
          text: raw,
          reason: `unknown HTTP method '${parts[0]}'`,
        });
        continue;
      }
    } else if (parts.length > 2) {
      invalid.push({
        line: i + 1,
        text: raw,
        reason: "expected '<url>' or '<METHOD> <url>'",
      });
      continue;
    }
    let parsed = null;
    try {
      parsed = new URL(urlToken);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      invalid.push({
        line: i + 1,
        text: raw,
        reason: `'${urlToken}' is not an http(s) URL`,
      });
      continue;
    }
    entries.push({ url: urlToken, method });
  }
  return { entries, invalid };
}

/**
 * Check every parsed entry with `check` (defaults to checkHandshake;
 * injectable for tests). Returns a summary report: `ok` is true only
 * when every result passed, so callers can gate on it directly.
 */
export async function runBatch(
  parsed,
  { check = checkHandshake, retries = 0, timeoutMs = undefined } = {}
) {
  const results = [];
  for (const entry of parsed.entries) {
    results.push(
      await check(entry.url, {
        method: entry.method,
        retries,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    );
  }
  for (const bad of parsed.invalid) {
    results.push({
      url: bad.text,
      ok: false,
      error: `line ${bad.line}: ${bad.reason}`,
    });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    ok: results.length > 0 && passed === results.length,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

export function formatBatchReport(report) {
  const lines = ["x402 batch handshake check"];
  for (const r of report.results) {
    const meta = [
      r.method,
      r.latencyMs !== undefined ? `${r.latencyMs}ms` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`${r.ok ? "PASS" : "FAIL"} ${r.url}${meta ? ` (${meta})` : ""}`);
    if (r.error) lines.push(`  error: ${r.error}`);
    if (r.price) lines.push(`  price: ${r.price}`);
  }
  lines.push(
    "",
    `${report.total} checked, ${report.passed} passed, ${report.failed} failed`
  );
  return lines.join("\n");
}
