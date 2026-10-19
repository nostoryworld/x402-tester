import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  checkX402scan,
  formatX402scanReport,
  hostnameOf,
  unwrapSearchResponse,
  x402scanSearchUrl,
} from "../src/x402scan.js";

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

// The tRPC batch envelope x402scan's Discover search returns.
const envelope = (listings) => [{ result: { data: { json: listings } } }];

const listing = (origin, extra = {}) => ({
  origin,
  title: "Example Paid API",
  description: "",
  favicon: `${origin}/favicon.ico`,
  protocols: ["x402"],
  endpoint: {
    method: "POST",
    path: "/paid",
    summary: "Example endpoint",
    authMode: "paid",
    price: "0.01 USD",
  },
  ...extra,
});

// Fixture server emulating x402scan's /api/trpc/public.discover.search.
// Records the decoded `input` param so tests can assert the real contract.
function startScanServer(listings, { status = 200, raw = null } = {}) {
  let seen = null;
  return startServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    seen = {
      path: u.pathname,
      batch: u.searchParams.get("batch"),
      input: u.searchParams.get("input"),
    };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(raw !== null ? raw : JSON.stringify(envelope(listings)));
  }).then((srv) => ({
    srv,
    seen: () => seen,
  }));
}

test("x402scanSearchUrl builds the tRPC batch URL x402scan's frontend uses", () => {
  const url = x402scanSearchUrl("blockrun.ai", "https://www.x402scan.com");
  const u = new URL(url);
  assert.equal(
    u.origin + u.pathname,
    "https://www.x402scan.com/api/trpc/public.discover.search"
  );
  assert.equal(u.searchParams.get("batch"), "1");
  assert.deepEqual(JSON.parse(u.searchParams.get("input")), {
    0: { json: { query: "blockrun.ai" } },
  });
});

test("an exact hostname match reports LISTED with match details", async () => {
  const { srv, seen } = await startScanServer([
    listing("https://api.example.com"),
    listing("http://blockrun.ai"),
  ]);
  try {
    const r = await checkX402scan("https://api.example.com/paid", {
      scanBaseUrl: addr(srv),
    });
    assert.equal(r.listed, true);
    assert.equal(r.unknown, false);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].origin, "https://api.example.com");
    assert.equal(r.matches[0].title, "Example Paid API");
    assert.equal(r.matches[0].method, "POST");
    assert.equal(r.matches[0].path, "/paid");
    assert.equal(r.matches[0].price, "0.01 USD");
    // the search term sent is the endpoint's hostname
    assert.deepEqual(JSON.parse(seen().input), {
      0: { json: { query: "api.example.com" } },
    });
    assert.equal(seen().batch, "1");
    assert.match(r.diagnosis, /listed on x402scan/);
  } finally {
    srv.close();
  }
});

test("http:// origins match https:// endpoints (hostname comparison)", async () => {
  const { srv } = await startScanServer([listing("http://api.example.com")]);
  try {
    const r = await checkX402scan("https://api.example.com/paid", {
      scanBaseUrl: addr(srv),
    });
    assert.equal(r.listed, true);
    assert.equal(r.matches.length, 1);
  } finally {
    srv.close();
  }
});

test("no hostname match reports NOT LISTED, not unknown", async () => {
  const { srv } = await startScanServer([listing("https://other.dev")]);
  try {
    const r = await checkX402scan("https://api.example.com/paid", {
      scanBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, false);
    assert.equal(r.matches.length, 0);
    assert.equal(r.searched, 1);
    assert.match(r.diagnosis, /not listed on x402scan/);
    const text = formatX402scanReport(r);
    assert.match(text, /NOT LISTED/);
  } finally {
    srv.close();
  }
});

test("a subdomain of a listed origin does not count as listed", async () => {
  const { srv } = await startScanServer([listing("https://example.com")]);
  try {
    const r = await checkX402scan("https://api.example.com/paid", {
      scanBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, false);
  } finally {
    srv.close();
  }
});

test("listings with unparseable origins are skipped, not matched", async () => {
  const { srv } = await startScanServer([
    listing("not a url"),
    listing("https://api.example.com"),
  ]);
  try {
    const r = await checkX402scan("https://api.example.com/paid", {
      scanBaseUrl: addr(srv),
    });
    assert.equal(r.listed, true);
    assert.equal(r.matches.length, 1);
    assert.equal(r.skipped, 1);
  } finally {
    srv.close();
  }
});

test("an unexpected envelope shape reports UNKNOWN, not NOT LISTED", async () => {
  const { srv } = await startScanServer([], {
    raw: JSON.stringify({ unexpected: true }),
  });
  try {
    const r = await checkX402scan("https://api.example.com/paid", {
      scanBaseUrl: addr(srv),
    });
    assert.equal(r.listed, false);
    assert.equal(r.unknown, true);
    assert.match(r.error, /unexpected x402scan search response shape/);
    assert.match(r.diagnosis, /unknown, not as not-listed/);
    const text = formatX402scanReport(r);
    assert.match(text, /UNKNOWN/);
  } finally {
    srv.close();
  }
});

test("an unreachable x402scan reports UNKNOWN", async () => {
  // port 1 on loopback is effectively always closed
  const r = await checkX402scan("https://api.example.com/paid", {
    scanBaseUrl: "http://127.0.0.1:1",
  });
  assert.equal(r.listed, false);
  assert.equal(r.unknown, true);
  assert.match(r.error, /x402scan unreachable/);
});

test("an invalid endpoint URL is reported as unknown without searching", async () => {
  let hits = 0;
  const srv = await startServer(() => {
    hits += 1;
  });
  try {
    const r = await checkX402scan("not a url", { scanBaseUrl: addr(srv) });
    assert.equal(r.unknown, true);
    assert.equal(hits, 0);
    assert.match(r.error, /not a valid URL/);
  } finally {
    srv.close();
  }
});

test("hostnameOf lowercases and returns null for garbage", () => {
  assert.equal(hostnameOf("HTTPS://API.Example.COM/paid"), "api.example.com");
  assert.equal(hostnameOf("not a url"), null);
});

test("unwrapSearchResponse unwraps the batch envelope", () => {
  const ls = [listing("https://a.dev")];
  assert.deepEqual(unwrapSearchResponse(envelope(ls)).listings, ls);
  assert.match(unwrapSearchResponse({}).error, /unexpected/);
  assert.match(unwrapSearchResponse([]).error, /unexpected/);
});

test("formatX402scanReport renders matches and status", () => {
  const text = formatX402scanReport({
    url: "https://api.example.com/paid",
    hostname: "api.example.com",
    searchUrl: "https://www.x402scan.com/api/trpc/...",
    listed: true,
    unknown: false,
    matches: [
      {
        origin: "https://api.example.com",
        title: "Example Paid API",
        method: "POST",
        path: "/paid",
        price: "0.01 USD",
      },
    ],
    searched: 1,
    skipped: 0,
    latencyMs: 42,
    diagnosis: "listed on x402scan (1 matching service for host api.example.com)",
  });
  assert.match(text, /LISTED/);
  assert.match(text, /Example Paid API/);
  assert.match(text, /POST \/paid/);
  assert.match(text, /0\.01 USD/);
});
