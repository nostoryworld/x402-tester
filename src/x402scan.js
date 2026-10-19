/**
 * x402scan discovery check.
 *
 * x402scan (x402scan.com) is the public explorer / marketplace for x402
 * paid APIs. Before announcing an endpoint, a seller wants to know whether
 * it actually shows up in the index — being payable but undiscoverable is
 * a silent launch failure.
 *
 * This module queries x402scan's public Discover search. The site's own
 * frontend calls the public tRPC procedure `public.discover.search`
 * (no auth, no cookies) via:
 *
 *   GET {scanBase}/api/trpc/public.discover.search?batch=1&input=<urlencoded {"0":{"json":{"query":"<term>"}}}>
 *
 * The SuperJSON response envelope is `[{result:{data:{json:[...]}}}]`,
 * where each listing carries the service's URL in `origin` plus an
 * `endpoint` object {method, path, summary, authMode, price}. Results are
 * capped at 20 per query (no pagination), so the search term is the
 * endpoint's hostname and the listing verdict comes from client-side
 * hostname matching — the search itself is catalog/semantic-backed, not
 * an exact lookup.
 *
 * Three outcomes: listed (exact hostname match), not listed, or unknown
 * (x402scan unreachable or its response shape changed).
 */

const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);

export const X402SCAN_BASE = "https://www.x402scan.com";

/**
 * Build the tRPC search URL x402scan's own frontend uses.
 * `input` is SuperJSON: {"0":{"json":{"query":"<term>"}}}.
 */
export function x402scanSearchUrl(query, scanBase = X402SCAN_BASE) {
  const base = String(scanBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("an x402scan base URL is required");
  const term = String(query || "").trim();
  if (!term) throw new Error("a search query is required");
  const input = JSON.stringify({ 0: { json: { query: term } } });
  return `${base}/api/trpc/public.discover.search?batch=1&input=${encodeURIComponent(input)}`;
}

/** Lowercased hostname of a URL string, or null when unparseable. */
export function hostnameOf(urlString) {
  try {
    return new URL(String(urlString)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Unwrap the tRPC batch + SuperJSON envelope into the listings array.
 * Returns { listings } or { error } when the shape is not what we expect.
 */
export function unwrapSearchResponse(body) {
  const batch = Array.isArray(body) ? body : null;
  const listings = batch?.[0]?.result?.data?.json;
  if (!Array.isArray(listings)) {
    return { error: "unexpected x402scan search response shape (envelope not recognized)" };
  }
  return { listings };
}

/**
 * Check whether an endpoint URL is listed on x402scan. Returns a report:
 *
 *   { url, hostname, searchUrl, listed, unknown, matches, searched,
 *     skipped, error?, latencyMs, diagnosis }
 *
 * `matches` holds one entry per exact-hostname hit:
 * { origin, title, method, path, price }.
 */
export async function checkX402scan(
  url,
  { scanBaseUrl = X402SCAN_BASE, timeoutMs = 15000, fetchImpl = fetch } = {}
) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const hostname = hostnameOf(url);
  if (!hostname) {
    return {
      url,
      hostname: null,
      searchUrl: null,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      skipped: 0,
      error: `not a valid URL: ${url}`,
      latencyMs: elapsed(),
      diagnosis: "could not parse the endpoint URL, so nothing was searched",
    };
  }

  let searchUrl;
  try {
    searchUrl = x402scanSearchUrl(hostname, scanBaseUrl);
  } catch (err) {
    return {
      url,
      hostname,
      searchUrl: null,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      skipped: 0,
      error: err.message,
      latencyMs: elapsed(),
      diagnosis: "could not build the x402scan search request",
    };
  }

  let res;
  try {
    res = await fetchImpl(searchUrl, {
      headers: { accept: "application/json", "user-agent": "x402-tester" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = TIMEOUT_NAMES.has(err.name)
      ? `request timed out after ${timeoutMs}ms`
      : err.cause?.message || err.message;
    return {
      url,
      hostname,
      searchUrl,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      skipped: 0,
      error: `x402scan unreachable: ${reason}`,
      latencyMs: elapsed(),
      diagnosis: "the x402scan search index could not be reached",
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      url,
      hostname,
      searchUrl,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      skipped: 0,
      error: `x402scan answered HTTP ${res.status} with a non-JSON body`,
      latencyMs: elapsed(),
      diagnosis: "the x402scan search response could not be parsed",
    };
  }

  const { listings, error } = unwrapSearchResponse(body);
  if (error) {
    return {
      url,
      hostname,
      searchUrl,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      skipped: 0,
      error: `HTTP ${res.status}: ${error}`,
      latencyMs: elapsed(),
      diagnosis:
        "x402scan answered, but the listing format changed — " +
        "treat the result as unknown, not as not-listed",
    };
  }

  const matches = [];
  let skipped = 0;
  for (const listing of listings) {
    const originHost = hostnameOf(listing?.origin);
    if (!originHost) {
      skipped += 1;
      continue;
    }
    // Origins may be http:// or https:// — compare hostnames only.
    if (originHost === hostname) {
      const ep = listing.endpoint || {};
      matches.push({
        origin: listing.origin,
        title: listing.title || "(untitled)",
        method: ep.method || null,
        path: ep.path || null,
        price: ep.price || null,
      });
    }
  }

  const listed = matches.length > 0;
  return {
    url,
    hostname,
    searchUrl,
    listed,
    unknown: false,
    matches,
    searched: listings.length,
    skipped,
    latencyMs: elapsed(),
    diagnosis: listed
      ? `listed on x402scan (${matches.length} matching service${matches.length === 1 ? "" : "s"} for host ${hostname})`
      : `not listed on x402scan (searched ${listings.length} result${listings.length === 1 ? "" : "s"} for host ${hostname}, none matched)`,
  };
}

export function formatX402scanReport(r) {
  const lines = [
    `x402 discovery check: ${r.url}`,
    `status: ${r.unknown ? "UNKNOWN" : r.listed ? "LISTED" : "NOT LISTED"} (${r.latencyMs}ms)`,
  ];
  if (r.hostname) lines.push(`host searched: ${r.hostname}`);
  if (r.error) lines.push(`error: ${r.error}`);
  for (const m of r.matches) {
    const route = [m.method, m.path].filter(Boolean).join(" ");
    const price = m.price ? ` — ${m.price}` : "";
    lines.push(`match: ${m.title} <${m.origin}>${route ? ` (${route})` : ""}${price}`);
  }
  if (r.diagnosis) lines.push(`diagnosis: ${r.diagnosis}`);
  return lines.join("\n");
}
