import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  normalizeBurst,
  parseRetryAfter,
  probeRateLimit,
  formatRateLimitReport,
  DEFAULT_BURST,
  MAX_BURST,
} from "../src/ratelimit.js";

// Minimal fetch-shaped stub: status + a Headers-like get().
// `headers` maps lowercase names to values; absent names read null.
function stubResponse(status, headers = {}) {
  return {
    status,
    headers: {
      get: (name) => {
        const value = headers[name.toLowerCase()];
        return value === undefined ? null : value;
      },
    },
  };
}

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("normalizeBurst accepts the default and valid counts", () => {
  assert.equal(normalizeBurst(), DEFAULT_BURST);
  assert.equal(normalizeBurst(1), 1);
  assert.equal(normalizeBurst(MAX_BURST), MAX_BURST);
});

test("normalizeBurst rejects out-of-range counts", () => {
  for (const burst of [0, 101, 2.5, "20", null]) {
    assert.throws(() => normalizeBurst(burst), /burst/);
  }
});

test("parseRetryAfter accepts delay-seconds", () => {
  assert.equal(parseRetryAfter("120"), 120000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("  5  "), 5000);
});

test("parseRetryAfter accepts an HTTP date and clamps past dates to 0", () => {
  const now = Date.parse("2026-11-06T09:00:00Z");
  assert.equal(
    parseRetryAfter("Fri, 06 Nov 2026 09:00:30 GMT", now),
    30000
  );
  assert.equal(parseRetryAfter("Fri, 06 Nov 2026 08:59:00 GMT", now), 0);
});

test("parseRetryAfter returns null for missing or unparseable values", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("soon"), null);
  assert.equal(parseRetryAfter("1.5"), null);
  assert.equal(parseRetryAfter("-5"), null);
});

test("all-402 burst is not rate limited, ok, graceful n/a", async () => {
  let calls = 0;
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 5,
    fetchImpl: async () => {
      calls += 1;
      return stubResponse(402);
    },
  });
  assert.equal(calls, 5);
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "not-rate-limited");
  assert.equal(report.rateLimited, false);
  assert.equal(report.graceful, null);
  assert.equal(report.first429At, null);
  assert.equal(report.count429, 0);
  assert.deepEqual(report.statuses, { 402: 5 });
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.failures, []);
});

test("429s with Retry-After are rate limited and graceful", async () => {
  let calls = 0;
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 6,
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) return stubResponse(402);
      return stubResponse(429, { "retry-after": "2" });
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "rate-limited");
  assert.equal(report.rateLimited, true);
  assert.equal(report.graceful, true);
  assert.equal(report.first429At, 3);
  assert.equal(report.count429, 4);
  assert.deepEqual(report.retryAfterMs, [2000, 2000, 2000, 2000]);
  assert.equal(report.rateLimitHeadersSeen, true);
  assert.deepEqual(report.statuses, { 402: 2, 429: 4 });
  assert.deepEqual(report.warnings, []);
});

test("429s without Retry-After are ungraceful and warned about", async () => {
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 3,
    fetchImpl: async () => stubResponse(429),
  });
  assert.equal(report.ok, true);
  assert.equal(report.rateLimited, true);
  assert.equal(report.graceful, false);
  assert.equal(report.first429At, 1);
  assert.deepEqual(report.retryAfterMs, []);
  assert.match(report.warnings.join("\n"), /3 of 3 429 responses carried no Retry-After/);
  assert.match(report.warnings.join("\n"), /no RateLimit-\* headers/);
});

test("a 429 with an unparseable Retry-After is ungraceful, not missing", async () => {
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 2,
    fetchImpl: async () => stubResponse(429, { "retry-after": "soon" }),
  });
  assert.equal(report.graceful, false);
  assert.match(report.warnings.join("\n"), /could not be parsed/);
  assert.doesNotMatch(report.warnings.join("\n"), /carried no Retry-After/);
});

test("5xx responses under load warn and keep the verdict honest", async () => {
  let calls = 0;
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 4,
    fetchImpl: async () => {
      calls += 1;
      return stubResponse(calls === 3 ? 503 : 402);
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "not-rate-limited");
  assert.equal(report.count5xx, 1);
  assert.match(report.warnings.join("\n"), /5xx on 1 of 4/);
});

test("unexpected statuses warn instead of being folded into a verdict", async () => {
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 2,
    fetchImpl: async () => stubResponse(200),
  });
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "not-rate-limited");
  assert.match(report.warnings.join("\n"), /unexpected status.*200/);
});

test("a transport error mid-burst fails the probe and is recorded", async () => {
  let calls = 0;
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 3,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) throw new Error("socket hang up");
      return stubResponse(402);
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.verdict, "not-rate-limited");
  assert.deepEqual(report.failures, [{ probe: 2, error: "socket hang up" }]);
  assert.deepEqual(report.statuses, { 402: 2, error: 1 });
  assert.equal(report.responses[1].status, null);
});

test("probeRateLimit rejects an invalid burst before fetching", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      probeRateLimit("https://example.com/paid-api", {
        burst: 0,
        fetchImpl: async () => {
          calls += 1;
          return stubResponse(402);
        },
      }),
    /burst/
  );
  assert.equal(calls, 0);
});

test("POST probes send an empty JSON body like the handshake does", async () => {
  let seen = null;
  const report = await probeRateLimit("https://example.com/paid-api", {
    burst: 1,
    method: "POST",
    fetchImpl: async (_url, init) => {
      seen = init;
      return stubResponse(402);
    },
  });
  assert.equal(report.method, "POST");
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.body, "{}");
});

test("live server: 429s after a threshold are classified from real headers", async () => {
  let count = 0;
  const srv = await startServer((_req, res) => {
    count += 1;
    if (count <= 3) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ x402Version: 1, accepts: [] }));
    } else {
      res.writeHead(429, {
        "retry-after": "5",
        "ratelimit-limit": "3",
        "ratelimit-remaining": "0",
      });
      res.end(JSON.stringify({ error: "rate limited" }));
    }
  });
  try {
    const report = await probeRateLimit(addr(srv), { burst: 6 });
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "rate-limited");
    assert.equal(report.graceful, true);
    assert.equal(report.first429At, 4);
    assert.equal(report.count429, 3);
    assert.deepEqual(report.retryAfterMs, [5000, 5000, 5000]);
    assert.equal(report.rateLimitHeadersSeen, true);
    assert.deepEqual(report.warnings, []);
    assert.match(
      formatRateLimitReport(report),
      /verdict: RATE LIMITED — first 429 on probe 4 of 6/
    );
    assert.match(formatRateLimitReport(report), /graceful: yes/);
  } finally {
    srv.close();
  }
});

test("formatRateLimitReport describes a clean not-limited burst", () => {
  const text = formatRateLimitReport({
    url: "https://example.com/paid-api",
    burst: 20,
    method: "GET",
    rateLimited: false,
    graceful: null,
    first429At: null,
    count429: 0,
    count5xx: 0,
    statuses: { 402: 20 },
    retryAfterMs: [],
    rateLimitHeadersSeen: false,
    responses: [],
    failures: [],
    warnings: [],
  });
  assert.match(text, /verdict: NOT RATE LIMITED — no 429 in 20 rapid requests/);
  assert.match(text, /graceful: n\/a/);
  assert.match(text, /statuses: 402×20/);
});

test("formatRateLimitReport shows failures and warnings", () => {
  const text = formatRateLimitReport({
    url: "https://example.com/paid-api",
    burst: 3,
    method: "GET",
    rateLimited: true,
    graceful: false,
    first429At: 2,
    count429: 2,
    count5xx: 0,
    statuses: { 402: 1, 429: 2 },
    retryAfterMs: [],
    rateLimitHeadersSeen: false,
    responses: [],
    failures: [],
    warnings: ["2 of 2 429 responses carried no Retry-After header — clients must guess when to retry"],
  });
  assert.match(text, /verdict: RATE LIMITED — first 429 on probe 2 of 3/);
  assert.match(text, /graceful: no/);
  assert.match(text, /warning: 2 of 2 429 responses carried no Retry-After/);
});
