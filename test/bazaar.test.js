import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  checkBazaar,
  formatBazaarReport,
  bazaarListUrl,
  normalizeResourceUrl,
  unwrapListResponse,
  BAZAAR_LIST_PATH,
  DEFAULT_PAGE_LIMIT,
} from "../src/bazaar.js";

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

const resource = (url, extra = {}) => ({
  url,
  type: "http",
  metadata: { description: "Example paid API", inputSchema: {}, outputSchema: {} },
  ...extra,
});

// Fixture server emulating the Bazaar list endpoint: slices one
// catalog by the limit/offset query params and reports total, like
// the real endpoint. Records every page URL requested.
function startBazaarServer(catalog, { status = 200, raw = null } = {}) {
  const seen = [];
  return startServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const limit = Number(u.searchParams.get("limit") || DEFAULT_PAGE_LIMIT);
    const offset = Number(u.searchParams.get("offset") || 0);
    const page = catalog.slice(offset, offset + limit);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      raw !== null
        ? raw
        : JSON.stringify({ resources: page, total: catalog.length, limit, offset })
    );
  }).then((srv) => ({ srv, seen: () => seen }));
}

test("bazaarListUrl builds the documented list endpoint URL", () => {
  const url = bazaarListUrl(
    { type: "http", limit: 100, offset: 200 },
    "https://api.cdp.coinbase.com"
  );
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, `https://api.cdp.coinbase.com${BAZAAR_LIST_PATH}`);
  assert.equal(u.searchParams.get("type"), "http");
  assert.equal(u.searchParams.get("limit"), "100");
  assert.equal(u.searchParams.get("offset"), "200");
});

test("bazaarListUrl rejects a bad limit or offset before any request", () => {
  assert.throws(() => bazaarListUrl({ limit: 0 }), /limit/);
  assert.throws(() => bazaarListUrl({ limit: 101 }), /limit/);
  assert.throws(() => bazaarListUrl({ offset: -1 }), /offset/);
  assert.throws(() => bazaarListUrl({}, ""), /base URL/);
});

test("an exact URL match on the first page reports LISTED and stops paging", async () => {
  const { srv, seen } = await startBazaarServer([
    resource("https://other.dev/api"),
    resource("https://api.example.com/paid"),
    resource("https://third.dev/x"),
  ]);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, true);
    assert.equal(r.unknown, false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].url, "https://api.example.com/paid");
    assert.equal(r.matches[0].type, "http");
    assert.equal(r.matches[0].description, "Example paid API");
    assert.equal(r.pages, 1);
    assert.equal(seen().length, 1);
    assert.equal(seen()[0].path, BAZAAR_LIST_PATH);
    assert.equal(seen()[0].query.type, "http");
    assert.match(r.diagnosis, /listed in the CDP Bazaar/);
    assert.match(formatBazaarReport(r), /LISTED/);
  } finally {
    srv.close();
  }
});

test("a match on a later page is found by paging", async () => {
  const catalog = Array.from({ length: 5 }, (_, i) => resource(`https://dev${i}.example/x`));
  catalog.push(resource("https://api.example.com/paid"));
  const { srv, seen } = await startBazaarServer(catalog);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
      limit: 2,
    });
    assert.equal(r.listed, true);
    assert.equal(r.pages, 3);
    assert.equal(r.searched, 6); // the whole matching page is scanned
    assert.equal(seen()[2].query.offset, "4");
  } finally {
    srv.close();
  }
});

test("a trailing slash on either side does not break the match", async () => {
  const { srv } = await startBazaarServer([resource("https://api.example.com/paid/")]);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, true);
    assert.equal(r.matches[0].url, "https://api.example.com/paid/");
  } finally {
    srv.close();
  }
});

test("a different path on the same host does not count as listed", async () => {
  const { srv } = await startBazaarServer([resource("https://api.example.com/other")]);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, false);
    assert.match(r.diagnosis, /not listed in the CDP Bazaar/);
    assert.match(formatBazaarReport(r), /NOT LISTED/);
  } finally {
    srv.close();
  }
});

test("an exhausted catalog with no match reports NOT LISTED", async () => {
  const { srv } = await startBazaarServer([
    resource("https://a.dev/x"),
    resource("https://b.dev/y"),
  ]);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, false);
    assert.equal(r.searched, 2);
    assert.equal(r.total, 2);
  } finally {
    srv.close();
  }
});

test("hitting the page cap before exhaustion reports UNKNOWN, not NOT LISTED", async () => {
  const catalog = Array.from({ length: 10 }, (_, i) => resource(`https://dev${i}.example/x`));
  const { srv, seen } = await startBazaarServer(catalog);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
      limit: 2,
      maxPages: 2,
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, true);
    assert.equal(r.pages, 2);
    assert.equal(seen().length, 2);
    assert.match(r.error, /scan cap reached/);
    assert.match(r.diagnosis, /not fully scanned/);
    assert.match(formatBazaarReport(r), /UNKNOWN/);
  } finally {
    srv.close();
  }
});

test("resources with unparseable URLs are skipped, not matched", async () => {
  const { srv } = await startBazaarServer([
    resource("not a url"),
    resource("https://api.example.com/paid"),
  ]);
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, true);
    assert.equal(r.skipped, 1);
    assert.equal(r.searched, 1);
  } finally {
    srv.close();
  }
});

test("an unexpected list shape reports UNKNOWN, not NOT LISTED", async () => {
  const { srv } = await startBazaarServer([], {
    raw: JSON.stringify({ unexpected: true }),
  });
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, true);
    assert.match(r.error, /unexpected Bazaar list response shape/);
    assert.match(r.diagnosis, /unknown, not as not-listed/);
  } finally {
    srv.close();
  }
});

test("a non-200 answer reports UNKNOWN, not NOT LISTED", async () => {
  const { srv } = await startBazaarServer([], { status: 403 });
  try {
    const r = await checkBazaar("https://api.example.com/paid", {
      bazaarBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, true);
    assert.match(r.error, /HTTP 403/);
  } finally {
    srv.close();
  }
});

test("an unreachable Bazaar reports UNKNOWN", async () => {
  const r = await checkBazaar("https://api.example.com/paid", {
    bazaarBaseUrl: "http://127.0.0.1:1",
  });
  assert.equal(r.listed, false);
  assert.equal(r.unknown, true);
  assert.match(r.error, /Bazaar unreachable/);
});

test("an invalid endpoint URL is reported as unknown without searching", async () => {
  let hits = 0;
  const srv = await startServer(() => {
    hits += 1;
  });
  try {
    const r = await checkBazaar("not a url", { bazaarBaseUrl: addr(srv) });
    assert.equal(r.unknown, true);
    assert.equal(hits, 0);
    assert.match(r.error, /not a valid URL/);
  } finally {
    srv.close();
  }
});

test("normalizeResourceUrl lowercases the host and strips a trailing slash", () => {
  assert.equal(
    normalizeResourceUrl("HTTPS://API.Example.COM/paid/"),
    "https://api.example.com/paid"
  );
  assert.equal(normalizeResourceUrl("https://api.example.com/"), "https://api.example.com/");
  assert.equal(normalizeResourceUrl("not a url"), null);
});

test("unwrapListResponse unwraps pages and tolerates a missing total", () => {
  const page = unwrapListResponse({ resources: [resource("https://a.dev/x")], total: 5 });
  assert.equal(page.resources.length, 1);
  assert.equal(page.total, 5);
  assert.equal(unwrapListResponse({ resources: [] }).total, null);
  assert.match(unwrapListResponse({}).error, /unexpected/);
  assert.match(unwrapListResponse({ resources: "nope" }).error, /unexpected/);
});
