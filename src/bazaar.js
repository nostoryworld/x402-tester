/**
 * CDP Bazaar discovery check.
 *
 * The x402 Bazaar is Coinbase's catalog of payment-gated services,
 * discovered by the CDP Facilitator: a resource enters it once a
 * payment for that resource settles through the facilitator, and a
 * resource with no settlement for about 30 days drops out again.
 * Being payable but undiscoverable is a silent launch failure, so
 * before announcing an endpoint a seller wants to know whether it
 * actually shows up in the index.
 *
 * This module queries the Bazaar's public list endpoint — the same
 * one the CDP docs describe for calling the catalog without an SDK:
 *
 *   GET {bazaarBase}/platform/v2/x402/discovery/resources
 *     ?type=http&limit=<n>&offset=<n>
 *
 * The response carries `resources` (each with a `url` and a `type`,
 * plus a `metadata` object with description and schemas), and
 * paging fields `total`, `limit`, `offset`. Pages are walked until
 * an exact URL match is found, the catalog is exhausted, or the
 * page cap is hit.
 *
 * Three outcomes: listed (exact URL match), not listed (catalog
 * exhausted with no match), or unknown (Bazaar unreachable, a
 * non-200 answer, a changed response shape, or the scan cap hit
 * before the catalog was exhausted). As with x402scan, an
 * unexpected shape is unknown, never not-listed: a changed format
 * must not read as "your endpoint is absent".
 *
 * No credentials are sent: the discovery catalog is public. If the
 * endpoint ever starts requiring auth, its 401/403 lands in the
 * unknown bucket with the status in the error, not as not-listed.
 */

import { fetchWithRetry, DEFAULT_TIMEOUT_MS } from "./retry.js";

const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);

export const BAZAAR_BASE = "https://api.cdp.coinbase.com";
export const BAZAAR_LIST_PATH = "/platform/v2/x402/discovery/resources";
export const DEFAULT_PAGE_LIMIT = 100;
export const DEFAULT_MAX_PAGES = 10;

/**
 * Build one page URL of the Bazaar list endpoint.
 * `type=http` restricts the catalog to HTTP resources (the only
 * kind this tool checks); limit/offset page through it.
 */
export function bazaarListUrl(
  { type = "http", limit = DEFAULT_PAGE_LIMIT, offset = 0 } = {},
  bazaarBase = BAZAAR_BASE
) {
  const base = String(bazaarBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("a Bazaar base URL is required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("'limit' must be an integer between 1 and 100");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("'offset' must be a non-negative integer");
  }
  const params = new URLSearchParams({ type, limit: String(limit), offset: String(offset) });
  return `${base}${BAZAAR_LIST_PATH}?${params.toString()}`;
}

/**
 * Normalise a resource URL for comparison: lowercase scheme and
 * host, drop a trailing slash. Two spellings of the same endpoint
 * (https://api.example.com/paid vs https://api.example.com/paid/)
 * are one resource; anything else — a different path, query, or
 * subdomain — is not. Returns null when unparseable.
 */
export function normalizeResourceUrl(urlString) {
  try {
    const u = new URL(String(urlString));
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const host = u.hostname.toLowerCase();
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${host}${port}${path}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Unwrap one page of the Bazaar list response into
 * { resources, total } or { error } when the shape is not what we
 * expect. `total` is null when the page does not report one, which
 * means exhaustion is judged by an empty/short page instead.
 */
export function unwrapListResponse(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.resources)) {
    return { error: "unexpected Bazaar list response shape (resources array not recognized)" };
  }
  const total =
    Number.isInteger(body.total) && body.total >= 0 ? body.total : null;
  return { resources: body.resources, total };
}

/**
 * Check whether an endpoint URL is listed in the CDP Bazaar. Returns
 * a report:
 *
 *   { url, normalizedUrl, listUrl, listed, unknown, matches,
 *     searched, pages, total, skipped, error?, latencyMs, diagnosis }
 *
 * `matches` holds one entry per exact-URL hit:
 * { url, type, name, description }.
 */
export async function checkBazaar(
  url,
  {
    bazaarBaseUrl = BAZAAR_BASE,
    limit = DEFAULT_PAGE_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
    fetchImpl = fetch,
  } = {}
) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const normalizedUrl = normalizeResourceUrl(url);
  if (!normalizedUrl) {
    return {
      url,
      normalizedUrl: null,
      listUrl: null,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      pages: 0,
      total: null,
      skipped: 0,
      error: `not a valid URL: ${url}`,
      latencyMs: elapsed(),
      diagnosis: "could not parse the endpoint URL, so nothing was searched",
    };
  }

  let listUrl;
  try {
    listUrl = bazaarListUrl({ limit, offset: 0 }, bazaarBaseUrl);
  } catch (err) {
    return {
      url,
      normalizedUrl,
      listUrl: null,
      listed: false,
      unknown: true,
      matches: [],
      searched: 0,
      pages: 0,
      total: null,
      skipped: 0,
      error: err.message,
      latencyMs: elapsed(),
      diagnosis: "could not build the Bazaar list request",
    };
  }

  const matches = [];
  let searched = 0;
  let skipped = 0;
  let pages = 0;
  let total = null;
  let offset = 0;
  let exhausted = false;

  while (pages < maxPages) {
    const pageUrl = bazaarListUrl({ limit, offset }, bazaarBaseUrl);
    let res;
    try {
      ({ response: res } = await fetchWithRetry(
        pageUrl,
        {
          headers: { accept: "application/json", "user-agent": "x402-tester" },
        },
        { retries, timeoutMs, fetchImpl }
      ));
    } catch (err) {
      const reason = TIMEOUT_NAMES.has(err.name)
        ? `request timed out after ${timeoutMs}ms`
        : err.cause?.message || err.message;
      return {
        url,
        normalizedUrl,
        listUrl,
        listed: false,
        unknown: true,
        matches,
        searched,
        pages,
        total,
        skipped,
        error: `Bazaar unreachable: ${reason}`,
        latencyMs: elapsed(),
        diagnosis: "the Bazaar catalog could not be reached",
      };
    }

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        url,
        normalizedUrl,
        listUrl,
        listed: false,
        unknown: true,
        matches,
        searched,
        pages,
        total,
        skipped,
        error: `Bazaar answered HTTP ${res.status} with a non-JSON body`,
        latencyMs: elapsed(),
        diagnosis: "the Bazaar list response could not be parsed",
      };
    }

    if (res.status !== 200) {
      return {
        url,
        normalizedUrl,
        listUrl,
        listed: false,
        unknown: true,
        matches,
        searched,
        pages,
        total,
        skipped,
        error: `Bazaar answered HTTP ${res.status}`,
        latencyMs: elapsed(),
        diagnosis:
          "the Bazaar catalog refused the list request — treat the " +
          "result as unknown, not as not-listed",
      };
    }

    const { resources, total: pageTotal, error } = unwrapListResponse(body);
    if (error) {
      return {
        url,
        normalizedUrl,
        listUrl,
        listed: false,
        unknown: true,
        matches,
        searched,
        pages,
        total,
        skipped,
        error: `HTTP ${res.status}: ${error}`,
        latencyMs: elapsed(),
        diagnosis:
          "Bazaar answered, but the listing format changed — " +
          "treat the result as unknown, not as not-listed",
      };
    }

    pages += 1;
    if (pageTotal !== null) total = pageTotal;
    for (const resource of resources) {
      const candidate = normalizeResourceUrl(resource?.url);
      if (!candidate) {
        skipped += 1;
        continue;
      }
      searched += 1;
      if (candidate === normalizedUrl) {
        const metadata = resource.metadata || {};
        matches.push({
          url: resource.url,
          type: resource.type || null,
          name: resource.name || metadata.title || null,
          description: resource.description || metadata.description || null,
        });
      }
    }

    // An exact match settles it — no need to page further.
    if (matches.length > 0) break;

    offset += resources.length;
    // Catalog exhausted: the page said how many there are and we
    // have seen them all, or a page came back short/empty.
    if (total !== null ? offset >= total : resources.length < limit) {
      exhausted = true;
      break;
    }
  }

  if (matches.length > 0) {
    return {
      url,
      normalizedUrl,
      listUrl,
      listed: true,
      unknown: false,
      matches,
      searched,
      pages,
      total,
      skipped,
      latencyMs: elapsed(),
      diagnosis: `listed in the CDP Bazaar (${matches.length} matching resource${matches.length === 1 ? "" : "s"} for ${normalizedUrl})`,
    };
  }

  // No match, but the catalog was not exhausted: the scan cap ran
  // out first. Say so plainly instead of claiming absence.
  if (!exhausted) {
    return {
      url,
      normalizedUrl,
      listUrl,
      listed: false,
      unknown: true,
      matches,
      searched,
      pages,
      total,
      skipped,
      error: `scan cap reached after ${pages} page${pages === 1 ? "" : "s"} (${searched} resources scanned) without exhausting the catalog`,
      latencyMs: elapsed(),
      diagnosis:
        "the Bazaar catalog was not fully scanned, so listing status " +
        "is undetermined — raise the page cap, do not read this as not-listed",
    };
  }

  return {
    url,
    normalizedUrl,
    listUrl,
    listed: false,
    unknown: false,
    matches,
    searched,
    pages,
    total,
    skipped,
    latencyMs: elapsed(),
    diagnosis: `not listed in the CDP Bazaar (scanned ${searched} resource${searched === 1 ? "" : "s"}${total !== null ? ` of ${total}` : ""}, none matched ${normalizedUrl})`,
  };
}

export function formatBazaarReport(r) {
  const lines = [
    `CDP Bazaar discovery check: ${r.url}`,
    `status: ${r.unknown ? "UNKNOWN" : r.listed ? "LISTED" : "NOT LISTED"} (${r.latencyMs}ms)`,
  ];
  if (r.normalizedUrl) lines.push(`resource searched: ${r.normalizedUrl}`);
  if (r.error) lines.push(`error: ${r.error}`);
  for (const m of r.matches) {
    const name = m.name ? `${m.name} ` : "";
    lines.push(`match: ${name}<${m.url}>${m.type ? ` (${m.type})` : ""}`);
    if (m.description) lines.push(`  ${m.description}`);
  }
  if (r.diagnosis) lines.push(`diagnosis: ${r.diagnosis}`);
  return lines.join("\n");
}
