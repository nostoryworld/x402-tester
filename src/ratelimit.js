/**
 * Rate-limit behavior probe: does the endpoint 429 gracefully?
 *
 * A paid endpoint under load should push back politely — HTTP 429
 * with a `Retry-After` header telling clients when to come back —
 * not melt down with 500s, hang, or silently drop requests. This
 * module fires a burst of N rapid unpaid probes at the endpoint
 * (the same request `check` sends, with no delay between probes)
 * and reports what happened:
 *
 *   - verdict "rate-limited": at least one 429 was observed. The
 *     probe is graceful only when every 429 carried a parseable
 *     Retry-After — without one, clients must guess when to retry.
 *   - verdict "not-rate-limited": every request was answered (no
 *     429 in the burst). That is a finding, not a failure: the
 *     endpoint may have a generous limit, a per-IP allowance the
 *     burst never hit, or no limit at all. The report says so
 *     plainly instead of inventing a limit.
 *
 * The probe deliberately does NOT retry: `fetchWithRetry` would
 * re-ask a 429 and hide the very behaviour being measured. Each
 * request gets its own timeout (a timed-out request is a transport
 * failure, not a verdict). Probes run sequentially — a burst of
 * rapid requests from one client is the realistic shape of a
 * client hammering an endpoint, and parallel fire would measure
 * the endpoint under self-inflicted concurrency instead.
 *
 * `ok` is true when the probe itself completed — every request got
 * an HTTP response. A 429 is a successful probe outcome, and a
 * missing rate limit is not a failure, so neither fails the run.
 * Transport errors fail it (the probe could not measure anything),
 * and warnings — 429s without Retry-After, 5xx responses under
 * load, unexpected statuses — fail the run under --ci, like any
 * other warning. `fetchImpl` is injectable for tests.
 */

import { DEFAULT_TIMEOUT_MS } from "./retry.js";

export const DEFAULT_BURST = 20;
export const MAX_BURST = 100;

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

// Headers that tell a client how the limit works. `retry-after`
// is the one that matters for grace; the `ratelimit-*` family
// (RFC 983 / the `x-` prefixed variants) describes the quota.
const RATE_LIMIT_HEADERS = [
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

/**
 * Validate a burst size. Returns it unchanged. Throws on anything
 * out of range so a typo cannot turn one probe into a
 * hundred-request hammering run.
 */
export function normalizeBurst(burst = DEFAULT_BURST) {
  if (!Number.isInteger(burst) || burst < 1 || burst > MAX_BURST) {
    throw new Error(`'burst' must be an integer between 1 and ${MAX_BURST}`);
  }
  return burst;
}

/**
 * Parse a Retry-After header value into milliseconds to wait.
 * Accepts delay-seconds ("120") and HTTP-date forms (RFC 9110);
 * a date in the past means "retry now" (0). Returns null when the
 * value cannot be parsed — a 429 with an unparseable Retry-After
 * is barely better than none, so callers must not treat it as a
 * real instruction. `nowMs` is injectable so tests can pin the
 * clock instead of racing it.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  // Delay-seconds: an integer number of seconds.
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP-date: IMF-fixdate only (e.g. "Fri, 06 Nov 2026 09:00:30 GMT").
  // The shape check matters: Date.parse is lenient and accepts bare
  // numbers like "-5" as a year, which is not a Retry-After date.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    return null;
  }
  const dateMs = Date.parse(text);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Fire `burst` rapid probes at `url` and classify the endpoint's
 * rate-limit behaviour. Returns a structured report (see the module
 * header for what `ok`, `verdict` and `graceful` mean).
 */
export async function probeRateLimit(
  url,
  {
    burst = DEFAULT_BURST,
    method = "GET",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = {}
) {
  const count = normalizeBurst(burst);
  const httpMethod = String(method || "GET").toUpperCase();
  const init = { method: httpMethod };
  if (METHODS_WITH_BODY.has(httpMethod)) {
    init.headers = { "content-type": "application/json" };
    init.body = "{}";
  }

  const responses = [];
  const failures = [];
  const statuses = {};
  let count429 = 0;
  let first429At = null;
  const retryAfterMs = [];
  let retryAfterMissing = 0;
  let retryAfterUnparseable = 0;
  let count5xx = 0;
  const unexpectedStatuses = new Set();
  let rateLimitHeadersSeen = false;

  for (let i = 0; i < count; i++) {
    const startedAt = Date.now();
    let res;
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      failures.push({
        probe: i + 1,
        error: err.cause?.message || err.message,
      });
      responses.push({ probe: i + 1, status: null, latencyMs, error: err.cause?.message || err.message });
      statuses.error = (statuses.error || 0) + 1;
      continue;
    }
    const latencyMs = Date.now() - startedAt;
    const status = res.status;
    statuses[status] = (statuses[status] || 0) + 1;

    let retryAfter = null;
    let sawRateLimitHeader = false;
    const headers = res.headers;
    if (headers && typeof headers.get === "function") {
      for (const name of RATE_LIMIT_HEADERS) {
        const value = headers.get(name);
        if (value !== null && value !== undefined) {
          sawRateLimitHeader = true;
          if (name === "retry-after") {
            retryAfter = parseRetryAfter(value);
            if (retryAfter === null) retryAfterUnparseable += 1;
          }
        }
      }
    }
    if (sawRateLimitHeader) rateLimitHeadersSeen = true;

    if (status === 429) {
      count429 += 1;
      if (first429At === null) first429At = i + 1;
      // Distinguish "no header at all" from "header present but
      // unparseable": both are ungraceful, but the fix differs.
      const rawRetryAfter = headers?.get?.("retry-after");
      if (rawRetryAfter === null || rawRetryAfter === undefined) {
        retryAfterMissing += 1;
      } else if (retryAfter === null) {
        retryAfterUnparseable += 1;
      } else {
        retryAfterMs.push(retryAfter);
      }
    } else if (status >= 500 && status < 600) {
      count5xx += 1;
    }
    if (status !== 402 && status !== 429) unexpectedStatuses.add(status);

    responses.push({ probe: i + 1, status, latencyMs, retryAfterMs: retryAfter });
  }

  const rateLimited = count429 > 0;
  // Graceful means every 429 told the client when to come back.
  // No 429s at all means there was nothing to be graceful about.
  const graceful = rateLimited
    ? retryAfterMissing === 0 && retryAfterUnparseable === 0
    : null;

  const warnings = [];
  if (rateLimited) {
    if (retryAfterMissing > 0) {
      warnings.push(
        `${retryAfterMissing} of ${count429} 429 response${count429 === 1 ? "" : "s"} ` +
          `carried no Retry-After header — clients must guess when to retry`
      );
    }
    if (retryAfterUnparseable > 0) {
      warnings.push(
        `${retryAfterUnparseable} 429 response${retryAfterUnparseable === 1 ? "" : "s"} ` +
          `carried a Retry-After header that could not be parsed as seconds or an HTTP date`
      );
    }
    if (!rateLimitHeadersSeen) {
      warnings.push(
        "429 responses carried no RateLimit-* headers (limit/remaining/reset)"
      );
    }
  }
  if (count5xx > 0) {
    warnings.push(
      `endpoint returned 5xx on ${count5xx} of ${count} burst request${count === 1 ? "" : "s"} — it errors under load instead of throttling`
    );
  }
  if (unexpectedStatuses.size > 0) {
    warnings.push(
      `unexpected status${unexpectedStatuses.size === 1 ? "" : "es"} during the burst: ` +
        `${[...unexpectedStatuses].sort((a, b) => a - b).join(", ")} ` +
        `(expected 402 from a paid endpoint, 429 when throttled)`
    );
  }

  return {
    url,
    ok: failures.length === 0,
    method: httpMethod,
    burst: count,
    verdict: rateLimited ? "rate-limited" : "not-rate-limited",
    rateLimited,
    graceful,
    first429At,
    count429,
    count5xx,
    statuses,
    retryAfterMs,
    rateLimitHeadersSeen,
    responses,
    failures,
    warnings,
  };
}

function formatMs(value) {
  if (value === null || value === undefined) return "n/a";
  return `${value}ms`;
}

export function formatRateLimitReport(report) {
  const lines = [
    `x402 rate-limit probe: ${report.url}`,
    `burst: ${report.burst} rapid ${report.method || "GET"} request${report.burst === 1 ? "" : "s"} (no delay between probes)`,
  ];
  const statusSummary = Object.entries(report.statuses || {})
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([status, n]) => `${status}×${n}`)
    .join(", ");
  if (report.rateLimited) {
    lines.push(
      `verdict: RATE LIMITED — first 429 on probe ${report.first429At} of ${report.burst} ` +
        `(${report.count429} of ${report.burst} requests throttled)`
    );
    if (report.graceful) {
      const waits = report.retryAfterMs || [];
      const min = waits.length > 0 ? Math.min(...waits) : null;
      const max = waits.length > 0 ? Math.max(...waits) : null;
      lines.push(
        `graceful: yes — every 429 carried a parseable Retry-After` +
          (waits.length > 0 ? ` (${formatMs(min)}–${formatMs(max)} wait)` : "")
      );
    } else {
      lines.push(
        `graceful: no — some 429s gave no usable Retry-After (see warnings)`
      );
    }
  } else {
    lines.push(
      `verdict: NOT RATE LIMITED — no 429 in ${report.burst} rapid requests` +
        (report.count5xx > 0 ? " (but the endpoint errored under load — see warnings)" : "")
    );
    lines.push(
      `graceful: n/a — nothing was throttled, so there was nothing to be graceful about`
    );
  }
  if (statusSummary) lines.push(`statuses: ${statusSummary}`);
  if (report.rateLimitHeadersSeen) {
    lines.push(`rate-limit headers: present (RateLimit-* / Retry-After seen)`);
  }
  for (const failure of report.failures || []) {
    lines.push(`probe ${failure.probe} failed: ${failure.error}`);
  }
  for (const w of report.warnings || []) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
