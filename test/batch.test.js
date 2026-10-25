import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  parseBatchFile,
  runBatch,
  formatBatchReport,
} from "../src/batch.js";

const VALID_402 = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "base",
      payTo: "0xB3f534765B75Fa388e2d4EE5D6aD0210742eAde9",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amount: "20000",
      maxTimeoutSeconds: 60,
    },
  ],
};

function startServer(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  );
}

const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

test("parses plain URLs, per-line methods, and skips blanks and comments", () => {
  const parsed = parseBatchFile(`
# my endpoints
https://example.com/a

POST https://example.com/b
  # indented comment
https://example.com/c
`);
  assert.deepEqual(parsed.invalid, []);
  assert.deepEqual(parsed.entries, [
    { url: "https://example.com/a", method: "GET" },
    { url: "https://example.com/b", method: "POST" },
    { url: "https://example.com/c", method: "GET" },
  ]);
});

test("applies the default method to bare URLs", () => {
  const parsed = parseBatchFile("https://example.com/a", {
    defaultMethod: "post",
  });
  assert.equal(parsed.entries[0].method, "POST");
});

test("collects bad lines instead of throwing", () => {
  const parsed = parseBatchFile(
    [
      "not-a-url",
      "FETCH https://example.com/a",
      "https://example.com/a https://example.com/b",
      "ftp://example.com/a",
      "https://example.com/ok",
    ].join("\n")
  );
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].url, "https://example.com/ok");
  assert.equal(parsed.invalid.length, 4);
  assert.deepEqual(
    parsed.invalid.map((b) => b.line),
    [1, 2, 3, 4]
  );
  assert.match(parsed.invalid[0].reason, /not an http\(s\) URL/);
  assert.match(parsed.invalid[1].reason, /unknown HTTP method/);
});

test("runBatch counts passes and failures and gates on all-pass", async () => {
  const seen = [];
  const stub = async (url, { method }) => {
    seen.push({ url, method });
    return url.endsWith("/ok")
      ? { url, ok: true, method, latencyMs: 3, price: "0.02 USDC" }
      : { url, ok: false, method, error: "expected HTTP 402" };
  };
  const parsed = parseBatchFile(
    "https://example.com/ok\nPOST https://example.com/bad\njunk-line"
  );
  const report = await runBatch(parsed, { check: stub });
  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.ok, false);
  // per-line method reaches the checker; the junk line becomes a failure
  assert.deepEqual(seen, [
    { url: "https://example.com/ok", method: "GET" },
    { url: "https://example.com/bad", method: "POST" },
  ]);
  assert.match(report.results[2].error, /line 3/);
});

test("runBatch is all-pass when every entry passes", async () => {
  const stub = async (url, { method }) => ({ url, ok: true, method });
  const report = await runBatch(
    parseBatchFile("https://example.com/a\nhttps://example.com/b"),
    { check: stub }
  );
  assert.equal(report.ok, true);
  assert.equal(report.failed, 0);
});

test("formatBatchReport lists each result and the summary", () => {
  const text = formatBatchReport({
    total: 2,
    passed: 1,
    failed: 1,
    results: [
      { url: "https://example.com/a", ok: true, method: "GET", latencyMs: 12, price: "0.02 USDC" },
      { url: "https://example.com/b", ok: false, method: "POST", error: "expected HTTP 402" },
    ],
  });
  assert.match(text, /PASS https:\/\/example\.com\/a \(GET, 12ms\)/);
  assert.match(text, /price: 0\.02 USDC/);
  assert.match(text, /FAIL https:\/\/example\.com\/b \(POST\)/);
  assert.match(text, /error: expected HTTP 402/);
  assert.match(text, /2 checked, 1 passed, 1 failed/);
});

test("end to end against local servers via the real handshake checker", async () => {
  const good = await startServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify(VALID_402));
  });
  const bad = await startServer((req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const parsed = parseBatchFile(`${addr(good)}/\n${addr(bad)}/`);
    const report = await runBatch(parsed);
    assert.equal(report.total, 2);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.ok, false);
    assert.equal(report.results[0].price, "0.02 USDC");
  } finally {
    good.close();
    bad.close();
  }
});
